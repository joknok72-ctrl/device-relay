#!/usr/bin/env bash
# v3.3 test: aim_engine tool (set/get/start/status/stop/clear), @name resolution, validation, DO storage + aim_status, docs. Requires relay + fake-phone.
set -u
U="${1:-http://localhost:3000}"; T="${2:-dev-secret-token-123}"; D="${3:-test-phone}"
A=(-H "Authorization: Bearer $T" -H "Content-Type: application/json")
pass=0; fail=0
check() { if [[ "$3" == *"$2"* ]]; then echo "  ✔ $1"; pass=$((pass+1)); else echo "  ✘ $1  (expected '$2')"; echo "     got: ${3:0:300}"; fail=$((fail+1)); fi; }
call() { curl -s "${A[@]}" -d "$1" $U/api/devices/$D/tools/call; }
memdel() { curl -s -X DELETE "${A[@]}" "$U/api/admin/devices/$D/memory?$1"; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
call '{"name":"open_recents"}' >/dev/null; memdel 'kind=all' >/dev/null; call '{"name":"get_current_app"}' >/dev/null
call '{"name":"aim_engine","arguments":{"action":"clear"}}' >/dev/null

echo "== version + docs"
check version '"version":"3.4.0"' "$(curl -s $U/api/health)"
check tool-listed 'aim_engine' "$(curl -s "$U/api/tools/schema?format=raw" | j '[t["name"] for t in d if t["name"]=="aim_engine"]')"
check tool-doc 'ONE real finger that stays pressed' "$(curl -s "$U/api/tools/schema?format=raw" | j '[t for t in d if t["name"]=="aim_engine"][0]["description"]')"
check boot-section '7b. SHOOTERS → use aim_engine' "$(curl -s $U/agent/$T)"
check phone-sh 'aim status|get|start|stop|clear' "$(curl -s $U/phone.sh)"

echo "== empty state"
G=$(call '{"name":"aim_engine","arguments":{"action":"get"}}')
check get-empty '"aim":null' "$G"
check start-needs-config 'no aim config' "$(call '{"name":"aim_engine","arguments":{"action":"start"}}')"

echo "== validation"
check bad-trigger 'trigger must be reticle|target|both' "$(call '{"name":"aim_engine","arguments":{"action":"set","aim":{"trigger":"laser"}}}')"
check bad-color 'reticleColor must be #rrggbb' "$(call '{"name":"aim_engine","arguments":{"action":"set","aim":{"reticleColor":"red"}}}')"
check bad-box 'reticleBox must be {x,y,w,h}' "$(call '{"name":"aim_engine","arguments":{"action":"set","aim":{"reticleBox":{"x":1}}}}')"
check bad-field 'unknown aim field' "$(call '{"name":"aim_engine","arguments":{"action":"set","aim":{"lol":1}}}')"
check bad-num 'fps must be a number' "$(call '{"name":"aim_engine","arguments":{"action":"set","aim":{"fps":"fast"}}}')"

echo "== set with @names"
call '{"name":"game_profile","arguments":{"label":"Space Runner","set":{"controls":{"fire":{"x":1235,"y":485},"crosshair":{"x":800,"y":360},"look":{"x":1050,"y":300}},"colors":{"ring":{"hex":"#f83830"}},"regions":{"ringbox":{"x":770,"y":330,"w":60,"h":62}}}}}' >/dev/null
R=$(call '{"name":"aim_engine","arguments":{"action":"set","aim":{"fireX":"@fire","fireY":"@fire","crosshairX":"@crosshair","crosshairY":"@crosshair","lookX":"@look","lookY":"@look","reticleColor":"@ring","reticleBox":"@ringbox","trigger":"reticle","fps":30,"aimGain":1.5}}}')
check set-ok '"ok":true' "$R"
check set-fire '"fireX":1235' "$R"
check set-firey '"fireY":485' "$R"
check set-color '"reticleColor":"#f83830"' "$R"
check set-box '"reticleBox":{"x":770,"y":330,"w":60,"h":62}' "$R"
check set-name '"name":"Space Runner Aim"' "$R"
check set-phone-synced '"phone":"synced"' "$R"
check set-app '"app":"com.example.spacerunner"' "$R"
check set-gain '"aimGain":1.5' "$R"
echo "== merge on second set"
R=$(call '{"name":"aim_engine","arguments":{"action":"set","aim":{"aimEnabled":true,"releaseFrames":4}}}')
check merge-keeps-fire '"fireX":1235' "$R"
check merge-new '"aimEnabled":true' "$R"
check merge-clamp '"releaseFrames":4' "$R"
R=$(call '{"name":"aim_engine","arguments":{"action":"set","aim":{"fps":999,"aimGain":99}}}')
check clamp-fps '"fps":60' "$R"
check clamp-gain '"aimGain":5' "$R"
echo "== unknown @name"
check bad-ref 'unknown' "$(call '{"name":"aim_engine","arguments":{"action":"set","aim":{"reticleColor":"@nope"}}}')"

echo "== get / start / status / stop"
G=$(call '{"name":"aim_engine","arguments":{"action":"get"}}')
check get-has '"fireX":1235' "$G"
check get-updated 'updatedAt' "$G"
R=$(call '{"name":"aim_engine","arguments":{"action":"start"}}')
check start-ok '"ok":true' "$R"
check start-running '"running":true' "$R"
check start-hint 'aim engine running' "$R"
sleep 1
S=$(call '{"name":"aim_engine","arguments":{"action":"status"}}')
check status-running '"running":true' "$S"
check status-configured '"configured":true' "$S"
check status-hold '"holdCount":4' "$S"
check status-engine '"engine":"aim"' "$S"
R=$(call '{"name":"aim_engine","arguments":{"action":"stop"}}')
check stop-ok '"ok":true' "$R"
check stop-hint 'aim engine stopped' "$R"
sleep 1
echo "== DO stored last aim_status (from phone push)"
check do-status '"stoppedBy": "relay"' "$(call '{"name":"aim_engine","arguments":{"action":"get"}}' | j 'json.dumps(d.get("lastStatus"))')"
check do-status-held '"heldMs": 3200' "$(call '{"name":"aim_engine","arguments":{"action":"get"}}' | j 'json.dumps(d.get("lastStatus"))')"

echo "== read-only token"
RO=$(curl -s "${A[@]}" -d '{"deviceId":"'$D'","readOnly":true,"label":"ro-aim"}' $U/api/admin/tokens | j 'd["token"]')
check ro-status-ok '"ok":true' "$(curl -s -H "Authorization: Bearer $RO" -H "Content-Type: application/json" -d '{"name":"aim_engine","arguments":{"action":"status"}}' $U/api/devices/$D/tools/call)"
check ro-start-denied 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H "Content-Type: application/json" -d '{"name":"aim_engine","arguments":{"action":"start"}}' $U/api/devices/$D/tools/call)"

echo "== v3.4 headlock"
R=$(call '{"name":"aim_engine","arguments":{"action":"set","aim":{"mode":"headlock","headColor":"#e6a68a","bodyColor":"","headDeadzone":1,"headGain":1.45,"headLead":0.6,"fireRadius":70,"headBox":{"x":330,"y":60,"w":1000,"h":440}}}}')
check hl-set-ok '"ok":true' "$R"
check hl-mode '"mode":"headlock"' "$R"
check hl-gain '"headGain":1.45' "$R"
check hl-lead '"headLead":0.6' "$R"
check hl-body-empty '"bodyColor":""' "$R"
check hl-bad-mode 'mode must be' "$(call '{"name":"aim_engine","arguments":{"action":"set","aim":{"mode":"laser"}}}')"
check hl-bad-color 'headColor must be' "$(call '{"name":"aim_engine","arguments":{"action":"set","aim":{"headColor":"pink"}}}')"
check hl-clamp-dead '"headDeadzone":100' "$(call '{"name":"aim_engine","arguments":{"action":"set","aim":{"headDeadzone":900}}}')"
R=$(call '{"name":"aim_engine","arguments":{"action":"start"}}')
check hl-start-ok '"ok":true' "$R"
check hl-start-hint 'HeadLock running' "$R"
R=$(call '{"name":"aim_engine","arguments":{"action":"status"}}')
check hl-status-firing '"firing":true' "$R"
check hl-status-locked '"locked":true' "$R"
check hl-status-err '"lockErrPx":1' "$R"
check hl-status-shizuku '"shizuku":"ready"' "$R"
call '{"name":"aim_engine","arguments":{"action":"stop"}}' >/dev/null
check hl-schema-mode 'mode(auto|headlock)' "$(curl -s "$U/api/tools/schema?format=raw" | j '[t for t in d if t["name"]=="aim_engine"][0]["parameters"]["properties"]["aim"]["description"]')"

echo "== clear"
R=$(call '{"name":"aim_engine","arguments":{"action":"clear"}}')
check clear-ok '"cleared":true' "$R"
check clear-empty '"aim":null' "$(call '{"name":"aim_engine","arguments":{"action":"get"}}')"

memdel 'kind=all' >/dev/null; call '{"name":"open_recents"}' >/dev/null
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
