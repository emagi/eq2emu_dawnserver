touch /eq2emu/eq2emu_dawnserver/updating_content
cd /eq2emu/eq2emu-content
git reset --hard
content_update=$(git pull)
cp -rf ItemScripts Quests RegionScripts SpawnScripts Spells ZoneScripts /eq2emu/eq2emu/server/
sudo chmod -R 777 ItemScripts Quests RegionScripts SpawnScripts Spells ZoneScripts # allows eq2emu-editor container to write files
rm /eq2emu/eq2emu_dawnserver/updating_content