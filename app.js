const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const mysql = require('mysql2');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const fetchStatus = require('./polling'); // Import the polling function
const { exec } = require('child_process');

const app = express();

// Define the path to the config file
const configPath = path.join(__dirname, 'dawn_config.json');

async function checkFileNotExist(filePath) {
	try {
        await fsp.access(filePath);
        return 0;
    } catch (err) {
        return 1;
    }
}

// Load the configuration file
const config = JSON.parse(fs.readFileSync(configPath));

const port = config.http.port;

let serverLoginStatus = 'Unknown';
let serverWorldStatus = 'Unknown';

let loginStatus = {};
let worldStatus = {};

let loginClients = {};
let worldClients = {};

let loginPID = -1;
let worldPID = -1;

function executeScript(scriptName) {
  exec(scriptName, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error executing script: ${error.message}`);
      return 0;
    }
    if (stderr) {
      console.error(`Script stderr: ${stderr}`);
      return 0;
    }
    console.log(`Script stdout: ${stdout}`);
    return 1;
  });
};

function executeResult(scriptName) {
  return new Promise((resolve, reject) => {
    exec(scriptName, (error, stdout, stderr) => {
      if (error) {
        reject(`Error: ${error.message}`);
        return;
      }
      if (stderr) {
        reject(`stderr: ${stderr}`);
        return;
      }
      resolve(stdout);
    });
  });
}

// Database connection
const db = mysql.createConnection({
  host: config.mysql.host,
  user: config.mysql.user,
  password: config.mysql.password,
  database: config.mysql.database
});

db.connect((err) => {
  if (err) throw err;
  console.log('Connected to database');
});

// Function to keep MySQL connection alive
const keepAlive = () => {
  db.ping((err) => {
    if (err) {
      console.error('Error pinging database:', err);
    }
  });
};

// Ping the database every 5 minutes (300000 milliseconds)
setInterval(keepAlive, 300000);

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(__dirname + '/public'));
app.use(cookieParser());
app.use(session({
  secret: 'secret',
  resave: true,
  saveUninitialized: true
}));
app.set('view engine', 'ejs');

// Polling function
const startLoginPolling = (url, username, password) => {
  setInterval(async () => {
    var response = await fetchStatus(url, username, password);
	if(response != null) {
		serverLoginStatus = response.login_status;
		loginStatus = response;
	}
	else {
		serverLoginStatus = "offline";
		if(config.http.auto_restart === "1" && checkFileNotExist("/eq2emu/server_loading")) {
			executeScript("./start_login_fromweb.sh");
		}
	}
  executeResult("pidof -x 'login'").then(output => {
		loginPID = output;
  })
  .catch(err => {
	  loginPID = -1;
	  if(config.http.auto_restart === "1" && checkFileNotExist("/eq2emu/server_loading")) {
		executeScript("./start_login_fromweb.sh");
	  }
  });

  }, 5000); // 5000 ms = 5 seconds
};

const startWorldPolling = (url, username, password) => {
  setInterval(async () => {
    var response = await fetchStatus(url, username, password);
	if(response != null) {
		serverWorldStatus = response.world_status;
		worldStatus = response;
	}
	else {
		serverWorldStatus = "offline";
		if(config.http.auto_restart === "1" && checkFileNotExist("/eq2emu/server_loading")) {
			executeScript("./start_world_fromweb.sh");
		}
	}
	
  executeResult("pidof -x 'eq2world'").then(output => {
		worldPID = output;
  })
  .catch(err => {
	  worldPID = -1;
	  if(config.http.auto_restart === "1" && checkFileNotExist("/eq2emu/server_loading")) {
		executeScript("./start_world_fromweb.sh");
	  }
  });
  }, 5000); // 5000 ms = 5 seconds
};

const startWorldClientPolling = (url, username, password) => {
  setInterval(async () => {
    var response = await fetchStatus(url, username, password);
	if(response != null) {
		worldClients = response;
	}
  }, 10000); // 5000 ms = 5 seconds
};

// Role-checking middleware
function checkRole(role) {
  return function (req, res, next) {
    if (req.session.role === role) {
      next();
    } else {
      res.status(403).send('Access Denied');
    }
  };
}

// Routes
app.get('/', (req, res) => {
  res.render('login');
});

const hashPassword = (password, salt) => {
  const hash = crypto.createHmac('sha512', salt);
  hash.update(password);
  return hash.digest('hex');
};

// Route to render registration form
app.get('/register', checkRole('admin'), (req, res) => {
  res.render('register');
});

app.post('/register', checkRole('admin'), (req, res) => {
  const { username, password, role } = req.body;
  
  if(username.length < 1 || password.length < 1) {
	  return res.status(500).send('Error, invalid registration');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hashedPassword = hashPassword(password, salt);

  db.query('INSERT INTO users (username, password, salt, role) VALUES (?, ?, ?, ?)', [username, hashedPassword, salt, role], (err, result) => {
    if (err) {
      console.error('Error registering user:', err);
      return res.status(500).send('Error registering user');
    }
    res.send('User registered successfully');
  });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (username && password) {
    db.query('SELECT * FROM users WHERE username = ?', [username], (err, results) => {
      if (err) throw err;

      if (results.length > 0) {
        const user = results[0];
        const hashedPassword = hashPassword(password, user.salt);

        if (hashedPassword === user.password) {
          req.session.loggedin = true;
          req.session.username = username;
          req.session.role = user.role; // Store user role in session
          res.redirect(`/dashboard`); // Pass the URL as a query parameter
        } else {
          res.send('Incorrect Username and/or Password!');
        }
      } else {
        res.send('Incorrect Username and/or Password!');
      }
      res.end();
    });
  } else {
    res.send('Please enter Username and Password!');
    res.end();
  }
});

app.get('/dashboard', (req, res) => {
  if (req.session.loggedin) {
	var loginUptime = "";
	var worldUptime = "";
	var wl_connected = "disconnected";
	var server_is_loaded = await checkFileNotExist("/eq2emu/server_loading");
	if(loginStatus.hasOwnProperty("login_uptime_string")) {
		loginUptime = loginStatus.login_uptime_string;
	}
	if(worldStatus.hasOwnProperty("world_uptime_string")) {
		worldUptime = worldStatus.world_uptime_string;
	}
	if(worldStatus.hasOwnProperty("login_connected")) {
		wl_connected = worldStatus.login_connected;
	}
    res.render('dashboard', {
      username: req.session.username,
      role: req.session.role,
      uptime: process.uptime(),
      login_status: serverLoginStatus, // Use the polled server status
      world_status: serverWorldStatus, // Use the polled server status,
      login_uptime: loginUptime, // Use the polled server status
      world_uptime: worldUptime, // Use the polled server status
	  worldlogin_connected: wl_connected,
	  login_pid: loginPID,
	  world_pid: worldPID,
	  server_loaded: server_is_loaded
    });
  } else {
    res.send('Please login to view this page!');
  }
  res.end();
});

app.get('/start_world', checkRole('admin'), (req, res) => {
	if(checkFileNotExist("/eq2emu/server_loading")) {
	  executeScript("./start_world_fromweb.sh");
	  res.send('Sent request to start world server');
	}
	else {
	  res.send('Server is loading and cannot handle the request at this time.');
	}
});

app.get('/stop_world', checkRole('admin'), (req, res) => {
  executeResult("pkill -9 eq2world");
  res.send('Sent request to stop world server');
});

app.get('/view_world_log', checkRole('admin'), (req, res) => {
    fs.readFile("/eq2emu/eq2emu/server/logs/eq2world.log", 'utf8', (err, data) => {
    if (err) {
      return res.status(500).send('Error reading log file');
    }

    res.render('logviewer', { logContent: data });
  });
});

app.get('/start_login', checkRole('admin'), (req, res) => {
	if(checkFileNotExist("/eq2emu/server_loading")) {
	  executeScript("./start_login_fromweb.sh");
	  res.send('Sent request to start login server');
	}
	else {
	  res.send('Server is loading and cannot handle the request at this time.');
	}
});

app.get('/stop_login', checkRole('admin'), (req, res) => {
  executeResult("pkill -9 login");
  res.send('Sent request to stop login server');
});

app.get('/view_login_log', checkRole('admin'), (req, res) => {
    fs.readFile("/eq2emu/eq2emu/server/logs/eq2login.log", 'utf8', (err, data) => {
    if (err) {
      return res.status(500).send('Error reading log file');
    }

    res.render('logviewer', { logContent: data });
  });
});

app.get('/world_clients', checkRole('admin'), (req, res) => {
  res.render('world_clients', { clients : worldClients });
});

const remoteLoginServerUrl = "https://127.0.0.1:9101/status";
const login_username = config.polling.login_admin; // Replace with actual username
const login_password = config.polling.login_password; // Replace with actual password

const remoteWorldServerUrl = "https://127.0.0.1:9002";
const world_username = config.polling.world_admin; // Replace with actual username
const world_password = config.polling.world_password; // Replace with actual password

// Start polling if URL is provided
if (remoteLoginServerUrl) {
  startLoginPolling(remoteLoginServerUrl, login_username, login_password);
}

// Start polling if URL is provided
if (remoteWorldServerUrl) {
  startWorldPolling(remoteWorldServerUrl + "/status", world_username, world_password);
  startWorldClientPolling(remoteWorldServerUrl + "/clients", world_username, world_password);
}
	
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
