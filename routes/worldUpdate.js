// routes/worldUpdate.js
// Admin UI + APIs for EQ2Emu World DB updater
// - Uses cached catalog from /catalog/start; never re-downloads in /start
// - Honors selectedTables exactly; no select-all unless selectAll:true
// - Robust body parsing; works even if app.js forgot parsers
// - SSE progress + rich error payloads

const express = require('express');
const { EventEmitter } = require('events');
const updater = require('../worldUpdater'); // adjust path if needed

// In-memory stores (single-process)
const catalogJobs  = new Map(); // jobId -> { ... }
const updateJobs   = new Map(); // jobId -> { ... }
const catalogByJob = new Map(); // 'job:<jobId>' -> FULL catalog (with SQL)
const catalogByRef = new Map(); // 'ref:<ref>'   -> FULL catalog (with SQL)

// ---- helpers ----
function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return ['1','true','yes','on'].includes(v.toLowerCase());
  return false;
}

// Safely normalize req.body (handles undefined and stringified JSON)
function normalizeBody(req) {
  let b = req && req.body;
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch { b = {}; }
  }
  if (!b || typeof b !== 'object') b = {};
  return b;
}

// Accept arrays, JSON strings, CSV strings, repeated/bracketed keys, numeric-keyed objects
function coerceArrayFromBody(body, baseName) {
  if (!body || typeof body !== 'object') return [];
  const out = [];

  const tryPush = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) return v.forEach(tryPush);
    if (typeof v === 'object') {
      const keys = Object.keys(v).filter(k => /^\d+$/.test(k)).sort((a,b)=>a-b);
      if (keys.length) return keys.forEach(k => tryPush(v[k]));
      return;
    }
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) return;
      if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('"') && s.endsWith('"'))) {
        try { return tryPush(JSON.parse(s)); } catch {}
      }
      if (s.includes(',')) return s.split(',').map(x=>x.trim()).filter(Boolean).forEach(tryPush);
      return out.push(s);
    }
    return out.push(String(v));
  };

  tryPush(body[baseName]);
  tryPush(body[`${baseName}[]`]);

  // handle bracketed indices like selectedTables[0]=...
  for (const [k, v] of Object.entries(body)) {
    const m = k.match(new RegExp(`^${baseName}\\[(\\d+)\\]$`));
    if (m) tryPush(v);
  }

  return [...new Set(out.map(s => String(s).trim()).filter(Boolean))];
}

// Convenience: look up several aliases
function pickTablesFromBody(body) {
  const names = ['selectedTables', 'selectTables', 'tables'];
  for (const n of names) {
    const arr = coerceArrayFromBody(body, n);
    if (arr.length) return arr;
  }
  return [];
}

function serializeError(err, where) {
  try {
    return {
      where,
      message: (err && (err.message || err.sqlMessage)) || 'Unknown error',
      code: err?.code,
      errno: err?.errno,
      sqlState: err?.sqlState,
      meta: err?.meta
    };
  } catch {
    return { where, message: String(err || 'Unknown error') };
  }
}

function logI(...a){ console.log('[world-update:router]', ...a); }

// -----------------------------
// router factory
// -----------------------------
module.exports = function buildWorldUpdateRouter(p1) {
  // Flexible signature:
  //   buildWorldUpdateRouter(world_db, checkRole)
  //   buildWorldUpdateRouter({ world_db, checkRole })
  //   buildWorldUpdateRouter()  // will try to auto-bind from app.locals
  let world_db = null;
  let checkRole = null;

  if (p1 && typeof p1.query === 'function') {
    world_db = p1;
  } else if (p1 && typeof p1 === 'object' && p1.world_db) {
    world_db = p1.world_db || null;
  }
  const router = express.Router();

  // Ensure JSON/urlencoded bodies are parsed even if app.js forgot
  router.use(express.json());
  router.use(express.urlencoded({ extended: true }));

  // Try to auto-bind DB from app.locals if not provided explicitly
  router.use((req, _res, next) => {
    if (!world_db || typeof world_db.query !== 'function') {
      const candidates = [
        req.app?.locals?.world_db,
        req.app?.locals?.db,
        req.app?.get?.('world_db'),
        req.app?.get?.('db'),
      ].filter(Boolean);
      for (const c of candidates) {
        if (c && typeof c.query === 'function') {
          world_db = c;
          logI('Auto-bound world_db from app.locals/app.get');
          break;
        }
      }
    }
    next();
  });

  // Small helper to fail fast if DB is missing
  function ensureDb(res) {
    if (!world_db || typeof world_db.query !== 'function') {
      res.status(500).json({
        ok: false,
        error: 'World DB connection is not available. Pass it to the router or set app.locals.world_db.'
      });
      return false;
    }
    return true;
  }

  // Render EJS UI
  router.get('/', (req, res) => {
    res.render('world-update', {
      title: 'World DB Updater',
      defaultRef: 'main'
    });
  });

  // ------------------------------------------------------------------
  // Quick, non-streaming catalog (handy for tests / small repos)
  // NOTE: Caches by ref so later /start can reuse without re-download.
  // ------------------------------------------------------------------
  router.get('/catalog', async (req, res) => {
    try {
      const ref = (req.query.ref || 'main').trim();
      const catalog = await updater.fetchWorldTableCatalog({ ref });
      const groups = updater.groupCatalog(catalog);
      catalogByRef.set(`ref:${ref}`, catalog);
      res.json({
        ok: true,
        ref,
        groups,
        catalog: catalog.map(c => ({ table: c.table, group: c.group, fileName: c.fileName }))
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ------------------------------------------------------------------
  // Catalog with progress (start + SSE)
  // On completion, caches FULL catalog by jobId and by ref.
  // ------------------------------------------------------------------
  router.post('/catalog/start', async (req, res) => {
    try {
      const ref = (req.body?.ref || 'main').trim();

      const id = `cat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
      const emitter = new EventEmitter();
      emitter.on('error', () => {}); // guard against accidental 'error' emits

      const job = {
        id, ref,
        status: 'running',
        startedAt: new Date().toISOString(),
        logs: [],
        result: null,
        error: null,
        errorPayload: null,
        emitter
      };
      catalogJobs.set(id, job);

      (async () => {
        const onProgress = (msg) => {
          const line = typeof msg === 'string' ? msg : JSON.stringify(msg);
          job.logs.push(line);
          emitter.emit('progress', line);
        };

        try {
          const fn = typeof updater.fetchWorldTableCatalogWithProgress === 'function'
            ? updater.fetchWorldTableCatalogWithProgress
            : async ({ ref, onProgress }) => {
                onProgress?.(`Progress API missing; using fallback for ref "${ref}"…`);
                const c = await updater.fetchWorldTableCatalog({ ref });
                onProgress?.({ type: 'done', tables: c.length });
                return c;
              };

          const catalog = await fn({ ref, onProgress });
          const groups = updater.groupCatalog(catalog);

          // Cache FULL catalog for later /start
          catalogByRef.set(`ref:${ref}`, catalog);
          catalogByJob.set(`job:${id}`, catalog);

          job.status = 'finished';
          job.finishedAt = new Date().toISOString();
          job.result = {
            jobId: id,
            ref,
            catalog: catalog.map(c => ({ table: c.table, group: c.group, fileName: c.fileName })),
            groups
          };
          emitter.emit('done', job.result);
        } catch (err) {
          job.status = 'error';
          job.error = err.message;
          job.errorPayload = serializeError(err, 'catalog/start');
          job.finishedAt = new Date().toISOString();
          emitter.emit('fail', job.errorPayload);
        }
      })();

      res.json({ ok: true, jobId: id });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/catalog/stream/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = catalogJobs.get(jobId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    };

    if (!job) {
      send('fail', { message: 'Unknown catalog job' });
      return res.end();
    }

    // backlog
    job.logs.forEach(line => send('progress', line));
    if (job.status === 'finished') {
      send('done', job.result);
      return res.end();
    }
    if (job.status === 'error') {
      send('fail', job.errorPayload || { where: 'catalog/stream', message: job.error || 'Unknown error' });
      return res.end();
    }

    const onProgress = (line) => send('progress', line);
    const onDone = (payload) => { send('done', payload); cleanup(); };
    const onFail = (payload) => { send('fail', payload); cleanup(); };

    const cleanup = () => {
      job.emitter.off('progress', onProgress);
      job.emitter.off('done', onDone);
      job.emitter.off('fail', onFail);
      try { res.end(); } catch {}
    };

    const ping = setInterval(() => { res.write(': ping\n\n'); }, 20000);
    req.on('close', () => { clearInterval(ping); cleanup(); });

    job.emitter.on('progress', onProgress);
    job.emitter.on('done', onDone);
    job.emitter.on('fail', onFail);
  });

  // ------------------------------------------------------------------
  // UPDATE execution (start + SSE)
  // Uses cached catalog only; will NOT re-download.
  // Honors selectedTables exactly; no select-all unless explicit.
  // ------------------------------------------------------------------
  router.post('/start', async (req, res) => {
    try {
      if (!ensureDb(res)) return; // <-- fail fast if DB missing

      const body             = normalizeBody(req);
      const ref              = (body.ref || 'main').trim();
      const includeChars     = toBool(body.includeChars);
      const mode             = String(body.mode || 'apply');
      const truncate         = toBool(body.truncate);
      const explicitSelectAll= toBool(body.selectAll); // only if client sets it
      const catalogJobId     = (body.catalogJobId || '').trim();

      const selectedGroups      = coerceArrayFromBody(body, 'selectedGroups');
      const selectedTablesInput = pickTablesFromBody(body);

      logI('START payload seen by server:', {
        contentType: req.headers['content-type'],
        ref,
        selectAll: explicitSelectAll,
        selectedTablesType: Array.isArray(body.selectedTables) ? 'array' : typeof body.selectedTables,
        selectedTablesInputSample: selectedTablesInput.slice(0, 8),
        selectedGroupsSample: selectedGroups.slice(0, 8)
      });

      // ---- Use cached catalog ONLY ----
      let catalog = null;
      if (catalogJobId) {
        catalog = catalogByJob.get(`job:${catalogJobId}`) || null;
        if (catalog) logI('Using cached catalog by job:', catalogJobId, `(tables=${catalog.length})`);
      }
      if (!catalog) {
        catalog = catalogByRef.get(`ref:${ref}`) || null;
        if (catalog) logI('Using cached catalog by ref:', ref, `(tables=${catalog.length})`);
      }
      if (!catalog || !Array.isArray(catalog) || catalog.length === 0) {
        return res.status(400).json({
          ok: false,
          error: 'No cached catalog available. Please "Load Catalog" first, then start the update.'
        });
      }

      // ---- Build a resolver: accept either SQL table name OR inner file basename ----
      const nameIndex = new Map(); // lower -> actual SQL table name
      for (const row of catalog) {
        const actual = row.table;
        nameIndex.set(actual.toLowerCase(), actual);
        const inner = (row.fileName.split('::')[1] || row.fileName).trim();
        const base  = inner.split('/').pop().replace(/\.sql$/i, '');
        if (base) nameIndex.set(base.toLowerCase(), actual);
      }

      // ---- Honor EXACT client intent ----
      let effectiveTables = [];
      let unmatched = [];

      if (explicitSelectAll) {
        effectiveTables = catalog.map(c => c.table);
        logI('SelectAll=true → using all tables:', effectiveTables.length);
      } else {
        for (const t of selectedTablesInput) {
          const key = String(t).trim().toLowerCase();
          const resolved = nameIndex.get(key);
          if (resolved) effectiveTables.push(resolved);
          else unmatched.push(t);
        }
        effectiveTables = [...new Set(effectiveTables)];
      }

      if (!explicitSelectAll && effectiveTables.length === 0 && selectedGroups.length === 0) {
        return res.status(400).json({
          ok: false,
          error: 'No tables selected (or none matched catalog).',
          unmatched
        });
      }

      // ---- Build plan ----
      const plan = updater.buildUpdatePlan({
        catalog,
        selectedGroups,
        selectedTables: effectiveTables,
        includeChars,
        mode,
        truncate
      });

      if (!plan.steps.length) {
        const dangerousCount = effectiveTables.filter(t => updater.DANGEROUS_TABLES.has(t)).length;
        const msg = dangerousCount
          ? `Nothing left after filters. ${dangerousCount} selected tables are marked dangerous; set "includeChars" to include them.`
          : 'Nothing left after filters (names may not match final catalog tables).';
        return res.status(400).json({ ok: false, error: msg, unmatched });
      }

      // ---- Kick off job ----
      const id = `upd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
      const emitter = new EventEmitter();
      emitter.on('error', () => {}); // guard

      const job = {
        id,
        status: 'running',
        startedAt: new Date().toISOString(),
        plan,
        logs: [],
        error: null,
        errorPayload: null,
        finishedAt: null,
        emitter
      };
      updateJobs.set(id, job);

      (async () => {
        const send = (msg) => {
          const line = typeof msg === 'string' ? msg : JSON.stringify(msg);
          job.logs.push(line);
          emitter.emit('log', line);
        };
        try {
          send(`Using cached catalog (tables=${catalog.length}) for ref: ${ref}`);
          send(`Steps: ${plan.steps.length} — ${plan.steps.map(s => s.table).join(', ')}`);
          await updater.applyPlan(world_db, plan, (m) => send(m));
          job.status = 'finished';
          job.finishedAt = new Date().toISOString();
          emitter.emit('done', { ok: true, updated: plan.steps.map(s => s.table) });
        } catch (e) {
          job.status = 'error';
          job.error = e.message;
          job.errorPayload = serializeError(e, 'update/start');
          job.finishedAt = new Date().toISOString();
          emitter.emit('fail', job.errorPayload);
        }
      })();

      res.json({
        ok: true,
        jobId: id,
        preview: plan.steps.map(s => ({ table: s.table, file: s.fileName, group: s.group }))
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/stream/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = updateJobs.get(jobId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    };

    if (!job) {
      send('fail', { message: 'Unknown update job' });
      return res.end();
    }

    // backlog
    job.logs.forEach(line => send('log', line));
    if (job.status === 'finished') {
      send('done', { ok: true, updated: job.plan.steps.map(s => s.table) });
      return res.end();
    }
    if (job.status === 'error') {
      send('fail', job.errorPayload || { where: 'update/stream', message: job.error || 'Unknown error' });
      return res.end();
    }

    const onLog  = (line) => send('log', line);
    const onDone = (payload) => { send('done', payload); cleanup(); };
    const onFail = (payload) => { send('fail', payload); cleanup(); };

    const cleanup = () => {
      job.emitter.off('log', onLog);
      job.emitter.off('done', onDone);
      job.emitter.off('fail', onFail);
      try { res.end(); } catch {}
    };

    const ping = setInterval(() => { res.write(': ping\n\n'); }, 20000);
    req.on('close', () => { clearInterval(ping); cleanup(); });

    job.emitter.on('log', onLog);
    job.emitter.on('done', onDone);
    job.emitter.on('fail', onFail);
  });

  return router;
};
