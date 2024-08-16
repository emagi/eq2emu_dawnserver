cd /eq2emu/eq2emu-content/
git pull
cp -rf ItemScripts Quests RegionScripts SpawnScripts Spells ZoneScripts /eq2emu/eq2emu/server/
sudo chown eq2emu:eq2emu /eq2emu/certs/
sudo chmod 644 /eq2emu/certs/*