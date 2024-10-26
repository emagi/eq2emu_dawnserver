touch /eq2emu/eq2emu_dawnserver/updating_content
cd /eq2emu/eq2emu-content
git reset --hard
content_update=$(git pull)
cp -rf ItemScripts Quests RegionScripts SpawnScripts Spells ZoneScripts /eq2emu/eq2emu/server/
sudo chmod -R 777 /eq2emu/eq2emu/server/ItemScripts /eq2emu/eq2emu/server/Quests /eq2emu/eq2emu/server/RegionScripts /eq2emu/eq2emu/server/SpawnScripts /eq2emu/eq2emu/server/Spells /eq2emu/eq2emu/server/ZoneScripts # allows eq2emu-editor container to write files
rm /eq2emu/eq2emu_dawnserver/updating_content