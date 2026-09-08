#!/usr/bin/env bash
# v2.6 test: game_bot (create/validate/@names/list/get/run/stop/status/update/delete), bot_sync push, bot_status,
# admin bot routes, memory bots, bootstrap BOT BUILDER, phone.sh bot cmds. Requires relay + fake-phone.
set -u
U="${1:-http://localhost:3000}"; T="${2:-dev-secret-token-123}"; D="${3:-test-phone}"
A=(-H "Authorization: Bearer $T" -H "Content-Type: application/json")
pass=0; fail=0
check() { if [[ "$3" == *"$2"* ]]; then echo "  ✔ $1"; pass=$((pass+1)); else echo "  ✘ $1  (expected '$2')"; echo "     got: ${3:0:300}"; fail=$((fail+1)); fi; }
call() { curl -s "${A[@]}" -d "$1" $U/api/devices/$D/tools/call; }
memdel() { curl -s -X DELETE "${A[@]}" "$U/api/admin/devices/$D/memory?$1"; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
export RELAY_URL=$U RELAY_TOKEN=$T RELAY_DEVICE=$D
P=/home/user/webapp/agent/phone.sh
call '{"name":"open_recents"}' >/dev/null
memdel 'kind=all' >/dev/null
call '{"name":"get_current_app"}' >/dev/null
call '{"name":"game_bot","arguments":{"action":"stop"}}' >/dev/null

echo "== version"
check version '"version":"2.6.0"' "$(curl -s $U/api/health)"
check tools-79 '79' "$(curl -s "$U/api/tools/schema?format=raw" | j 'len(d)')"
check schema-has-game_bot 'game_bot' "$(curl -s "$U/api/tools/schema?format=raw" | j '[t[\"name\"] for t in d if t[\"name\"]==\"game_bot\"]')"

echo "== validation"
check need-rules 'rules required' "$(call '{"name":"game_bot","arguments":{"action":"create","name":"x"}}')"
check need-name 'name required' "$(call '{"name":"game_bot","arguments":{"action":"create","rules":[{"when":[{"type":"always"}],"then":[{"type":"back"}]}]}}')"
check bad-cond 'type must be one of' "$(call '{"name":"game_bot","arguments":{"action":"create","name":"x","rules":[{"when":[{"type":"nope"}],"then":[{"type":"back"}]}]}}')"
check bad-action 'type must be one of' "$(call '{"name":"game_bot","arguments":{"action":"create","name":"x","rules":[{"when":[{"type":"always"}],"then":[{"type":"explode"}]}]}}')"
check color-needed 'needs color' "$(call '{"name":"game_bot","arguments":{"action":"create","name":"x","rules":[{"when":[{"type":"color_present"}],"then":[{"type":"back"}]}]}}')"
check tap-found-no-color 'uses tap_found but has no color_present' "$(call '{"name":"game_bot","arguments":{"action":"create","name":"x","rules":[{"when":[{"type":"always"}],"then":[{"type":"tap_found"}]}]}}')"
check tap-needs-xy 'needs x,y' "$(call '{"name":"game_bot","arguments":{"action":"create","name":"x","rules":[{"when":[{"type":"always"}],"then":[{"type":"tap"}]}]}}')"
check every-ms-min 'every_ms needs ms >= 50' "$(call '{"name":"game_bot","arguments":{"action":"create","name":"x","rules":[{"when":[{"type":"every_ms","ms":5}],"then":[{"type":"back"}]}]}}')"
check bad-action-word 'action must be create|update' "$(call '{"name":"game_bot","arguments":{"action":"fly"}}')"
check at-name-no-profile 'no game_profile exists' "$(call '{"name":"game_bot","arguments":{"action":"create","name":"x","rules":[{"when":[{"type":"color_present","color":"@enemy"}],"then":[{"type":"tap_found"}]}]}}')"

echo "== create"
R=$(call '{"name":"game_bot","arguments":{"action":"create","name":"Auto Shooter","description":"hit red things","rules":[{"name":"shoot","when":[{"type":"color_present","color":"#FF0000","minCount":50}],"then":[{"type":"tap_found"}],"cooldownMs":150},{"name":"dead","when":[{"type":"text_present","text":"GAME OVER"}],"then":[{"type":"stop_bot"}]}],"tickMs":100}}')
check create-ok '"ok":true' "$R"
check create-name '"name":"auto-shooter"' "$R"
check create-app '"app":"com.example.spacerunner"' "$R"
check create-rules '"rules":2' "$R"
check create-tick '"tickMs":100' "$R"
check create-no-warn '"warnings":[]' "$R"
check create-hint 'saved and pushed to the phone' "$R"
BOT_ID=$(echo "$R" | j 'd["bot"]["id"]')
check create-id 'bot_' "$BOT_ID"
R=$(call '{"name":"game_bot","arguments":{"action":"create","name":"nostop","rules":[{"when":[{"type":"every_ms","ms":500}],"then":[{"type":"tap","x":540,"y":990}]}]}}')
check create-warn-stop 'no stop_bot rule' "$R"
check create-tick-default '"tickMs":120' "$R"
check create-maxrun-default '"maxRunMs":1800000' "$R"

echo "== list / get"
R=$(call '{"name":"game_bot","arguments":{"action":"list"}}')
check list-count '"count":2' "$R"
check list-names 'auto-shooter' "$R"
check list-others '"others":0' "$R"
check list-runs '"runs":0' "$R"
R=$(call '{"name":"game_bot","arguments":{"action":"get","name":"auto shooter"}}')
check get-ok '"ok":true' "$R"
check get-rule-name '"name":"shoot"' "$R"
check get-cooldown '"cooldownMs":150' "$R"
check get-priority '"priority":0' "$R"
check get-exclusive '"exclusive":true' "$R"
check get-color-norm '"color":"#ff0000"' "$R"
check get-stopOnApp '"stopOnAppChange":true' "$R"
check get-missing 'bot not found' "$(call '{"name":"game_bot","arguments":{"action":"get","name":"ghost"}}')"
check get-available '"available":[' "$(call '{"name":"game_bot","arguments":{"action":"get","name":"ghost"}}')"

echo "== run / status / stop (fake phone)"
R=$(call '{"name":"game_bot","arguments":{"action":"run","name":"auto-shooter"}}')
check run-ok '"ok":true' "$R"
check run-started '"started":true' "$R"
check run-rules '"rules":2' "$R"
check run-hint 'stop it from the notification' "$R"
sleep 0.5
R=$(call '{"name":"game_bot","arguments":{"action":"status"}}')
check status-running '"running":true' "$R"
check status-name '"name":"auto-shooter"' "$R"
check status-online '"online":true' "$R"
R=$(call '{"name":"game_bot","arguments":{"action":"list"}}')
check list-runs-1 '"runs":1' "$R"
check list-live '"running":true' "$R"
R=$(curl -s "${A[@]}" "$U/api/admin/devices/$D/memory")
check mem-botstatus-running '"botStatus":{' "$R"
check mem-total-bots '"bots":2' "$R"
check mem-group-bots 'auto-shooter' "$R"
R=$(call '{"name":"game_bot","arguments":{"action":"stop"}}')
check stop-ok '"ok":true' "$R"
check stop-stopped '"stopped":true' "$R"
check stop-hint 'bot stopped' "$R"
sleep 0.5
R=$(call '{"name":"game_bot","arguments":{"action":"status"}}')
check status-idle '"running":false' "$R"
R=$(call '{"name":"game_bot","arguments":{"action":"list"}}')
check list-lastrun-end '"end":' "$R"
check list-lastrun-fired '"fired":3' "$R"
check list-stoppedBy '"stoppedBy":"user"' "$R"
check run-missing 'bot not found' "$(call '{"name":"game_bot","arguments":{"action":"run","name":"ghost"}}')"

echo "== bots are not recorded in logs"
R=$(curl -s "${A[@]}" "$U/api/devices/$D/logs?limit=10")
check no-game_bot-log-noise 'False' "$(echo "$R" | j '\"game_bot\" in json.dumps(d)[:100000] and any(\"game_bot\" in json.dumps(l) for l in (d.get(\"logs\") or d))')"

echo "== update"
R=$(call '{"name":"game_bot","arguments":{"action":"update","name":"auto-shooter","tickMs":80,"description":"faster"}}')
check update-ok '"ok":true' "$R"
check update-tick '"tickMs":80' "$R"
check update-same-id "\"id\":\"$BOT_ID\"" "$R"
check update-rules-kept '"rules":2' "$R"
R=$(call '{"name":"game_bot","arguments":{"action":"get","name":"auto-shooter"}}')
check update-desc '"description":"faster"' "$R"
check update-runs-kept '"runs":1' "$R"
check update-missing 'bot not found for update' "$(call '{"name":"game_bot","arguments":{"action":"update","name":"ghost","tickMs":80}}')"

echo "== @names in rules"
call '{"name":"game_profile","arguments":{"set":{"controls":{"fire":{"x":900,"y":1700},"stick":{"x":250,"y":1900}},"colors":{"enemy":{"hex":"#ff0000","tolerance":40}},"regions":{"hp":{"x":0,"y":0,"w":300,"h":80}}}}}' >/dev/null
R=$(call '{"name":"game_bot","arguments":{"action":"create","name":"named","rules":[{"name":"shoot","when":[{"type":"color_present","color":"@enemy"}],"then":[{"type":"fire_burst","at":"@fire","count":3}]},{"name":"low-hp","when":[{"type":"number_below","region":"@hp","value":20}],"then":[{"type":"joystick","at":"@stick","direction":"down","duration":600}]}]}}')
check named-ok '"ok":true' "$R"
R=$(call '{"name":"game_bot","arguments":{"action":"get","name":"named"}}')
check named-color '"color":"#ff0000"' "$R"
check named-tol '"tolerance":40' "$R"
check named-fire '"x":900,"y":1700' "$R"
check named-region '"region":{"x":0,"y":0,"w":300,"h":80}' "$R"
check named-stick '"x":250,"y":1900' "$R"
check named-unknown 'unknown @name' "$(call '{"name":"game_bot","arguments":{"action":"create","name":"bad","rules":[{"when":[{"type":"always"}],"then":[{"type":"tap","at":"@nowhere"}]}]}}')"

echo "== read-only guard"
RO=$(curl -s "${A[@]}" -d '{"label":"ro","readOnly":true}' $U/api/admin/tokens | j 'd["token"]')
RA=(-H "Authorization: Bearer $RO" -H "Content-Type: application/json")
check ro-list-ok '"ok":true' "$(curl -s "${RA[@]}" -d '{"name":"game_bot","arguments":{"action":"list"}}' $U/api/devices/$D/tools/call)"
check ro-run-denied 'read-only' "$(curl -s "${RA[@]}" -d '{"name":"game_bot","arguments":{"action":"run","name":"named"}}' $U/api/devices/$D/tools/call)"
check ro-create-denied 'read-only' "$(curl -s "${RA[@]}" -d '{"name":"game_bot","arguments":{"action":"create","name":"z","rules":[]}}' $U/api/devices/$D/tools/call)"

echo "== bootstrap"
B=$(curl -s $U/agent/$T)
check boot-section8 '## 8. BOT BUILDER' "$B"
check boot-5h '## 5h. Bots' "$B"
check boot-lists-bot 'auto-shooter' "$B"
check boot-named 'named' "$B"
check boot-cookbook 'tap_found' "$B"
check boot-quickstart-bots 'bot' "$(echo "$B" | sed -n '1,60p')"
check boot-rule0-bot 'بوت' "$B"

echo "== admin bot routes"
R=$(curl -s "${A[@]}" "$U/api/admin/devices/$D/bots")
check admin-list '"bots":[' "$R"
check admin-list-3 '3' "$(echo "$R" | j 'len(d[\"bots\"])')"
R=$(curl -s -X POST "${A[@]}" "$U/api/admin/devices/$D/bots/$BOT_ID/run")
check admin-run '"started":true' "$R"
sleep 0.3
R=$(curl -s -X POST "${A[@]}" "$U/api/admin/devices/$D/bots/stop")
check admin-stop '"stopped":true' "$R"
R=$(curl -s -X POST "${A[@]}" "$U/api/admin/devices/$D/bots/bot_nope/run")
check admin-run-missing 'bot not found' "$R"
R=$(curl -s -X DELETE "${A[@]}" "$U/api/admin/devices/$D/bots/$BOT_ID")
check admin-delete '"ok":true' "$R"
check admin-deleted-gone '"count":2' "$(call '{"name":"game_bot","arguments":{"action":"list"}}')"

echo "== delete"
R=$(call '{"name":"game_bot","arguments":{"action":"delete","name":"nostop"}}')
check delete-ok '"ok":true' "$R"
check delete-name '"deleted":"nostop"' "$R"
check delete-missing 'bot not found' "$(call '{"name":"game_bot","arguments":{"action":"delete","name":"nostop"}}')"
check list-after-delete '"count":1' "$(call '{"name":"game_bot","arguments":{"action":"list"}}')"

echo "== memory wipe kind=bots"
call '{"name":"game_bot","arguments":{"action":"create","name":"tmp","app":"com.other.game","rules":[{"when":[{"type":"always"}],"then":[{"type":"back"}]}]}}' >/dev/null
check list-others-1 '"others":1' "$(call '{"name":"game_bot","arguments":{"action":"list"}}')"
memdel 'kind=bots&app=com.example.spacerunner' >/dev/null
R=$(call '{"name":"game_bot","arguments":{"action":"list"}}')
check wipe-app '"count":0' "$R"
check wipe-keeps-other '"others":1' "$R"
memdel 'kind=bots' >/dev/null
check wipe-all '"others":0' "$(call '{"name":"game_bot","arguments":{"action":"list"}}')"

echo "== export/import keeps bots"
call '{"name":"game_bot","arguments":{"action":"create","name":"exp","rules":[{"when":[{"type":"always"}],"then":[{"type":"back"}]}]}}' >/dev/null
EX=$(curl -s "${A[@]}" "$U/api/admin/devices/$D/memory?format=export")
check export-has-bots '"exp"' "$EX"
memdel 'kind=all' >/dev/null
check export-wiped '"count":0' "$(call '{"name":"game_bot","arguments":{"action":"list"}}')"
curl -s "${A[@]}" -d "$EX" "$U/api/admin/devices/$D/memory/import" >/dev/null
check import-restored '"count":1' "$(call '{"name":"game_bot","arguments":{"action":"list"}}')"

echo "== phone.sh"
cd /tmp
check sh-bot-list 'bots: 1' "$(bash $P bot list 2>&1)"
check sh-bot-list-name 'exp' "$(bash $P bot 2>&1)"
check sh-bot-get '"name": "exp"' "$(bash $P bot get exp 2>&1)"
check sh-bot-create '"name": "sh-bot"' "$(bash $P bot create '{"name":"sh bot","rules":[{"when":[{"type":"color_present","color":"#ff0000"}],"then":[{"type":"tap_found"}]}]}' 2>&1)"
check sh-bot-run '"started": true' "$(bash $P bot run sh-bot 2>&1)"
check sh-bot-status '"running": true' "$(bash $P bot status 2>&1)"
check sh-bot-list-live 'RUNNING sh-bot' "$(bash $P bot list 2>&1)"
check sh-bot-stop '"stopped": true' "$(bash $P bot stop 2>&1)"
check sh-bot-delete '"deleted": "sh-bot"' "$(bash $P bot delete sh-bot 2>&1)"
check sh-bot-help 'bot: list' "$(bash $P bot wat 2>&1)"
check sh-help-mentions-bot 'bot run <name>' "$(bash $P help 2>&1)"
cd - >/dev/null

echo "== setup/monitor assets"
check setup-bots-ui 'bot-run' "$(curl -s $U/setup.html)"
check monitor-bot-badge 'bot-badge' "$(curl -s $U/monitor.html)"

memdel 'kind=all' >/dev/null
call '{"name":"open_recents"}' >/dev/null
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
