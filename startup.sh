cd /eq2emu/eq2emu-content/
git pull
cp -rf ItemScripts Quests RegionScripts SpawnScripts Spells ZoneScripts /eq2emu/eq2emu/server/
sudo chown eq2emu:eq2emu /eq2emu/certs/
sudo chmod 644 /eq2emu/certs/*
sudo chmod +x compile_source_web.sh
login_status=$(pidof -x "login")
world_status=$(pidof -x "eq2world")
if [ "$login_status" == '' && "$world_status" == '' ]; then
	screen -d -m bash -x compile_source_web.sh
	sleep 5
fi

cd /eq2emu/eq2emu_dawnserver/