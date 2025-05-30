sudo chown eq2emu:eq2emu /eq2emu/certs/
sudo chmod 644 /eq2emu/certs/*

cd /eq2emu/eq2emu_dawnserver/

npm update
npm install archiver

sudo chmod +x compile_source_web.sh
sudo chmod +x update_content_fromweb.sh
login_status=$(pidof -x "login")
world_status=$(pidof -x "eq2world")

if [ "$login_status" == '' && "$world_status" == '' ]; then
	screen -d -m bash -x compile_source_web.sh
	sleep 5
elif [ -f "/eq2emu/eq2emu_dawnserver/recompile" ]; then
	screen -d -m bash -x compile_source_web.sh 1
	rm /eq2emu/eq2emu_dawnserver/recompile
	sleep 5
fi

cd /eq2emu/eq2emu_dawnserver/