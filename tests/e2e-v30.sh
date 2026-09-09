#!/usr/bin/env bash
# v3.0 test: shooter assist/trigger/full modes, predictMs, maxRange, assist flag, headOffsetY, head-only params. Requires relay + fake-phone.
set -u
U="${1:-http://localhost:3000}"; T="${2:-dev-secret-token-123}"; D="${3:-test-phone}"
A=(-H "Authorization: Bearer $T" -H "Content-Type: application/json")
pass=0; fail=0
check() { if [[ "$3" == *"$2"* ]]; then echo "  ✔ $1"; pass=$((pass+1)); else echo "  ✘ $1  (expected '$2')"; echo "     got: ${3:0:300}"; fail=$((fail+1)); fi; }
call() { curl -s "${A[@]}" -d "$1" $U/api/devices/$D/tools/call; }
memdel() { curl -s -X DELETE "${A[@]}" "$U/api/admin/devices/$D/memory?$1"; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
call '{"name":"open_recents"}' >/dev/null; memdel 'kind=all' >/dev/null; call '{"name":"get_current_app"}' >/dev/null

echo "== version"
check version '"version":"3.3.0"' "$(curl -s $U/api/health)"
check tool-doc-modes 'SHOOTER MODES' "$(curl -s "$U/api/tools/schema?format=raw" | grep -o 'SHOOTER MODES' | head -1)"

echo "== validation"
BAD='{"name":"game_bot","arguments":{"action":"create","name":"x","rules":'
check fire-maxrange-needs-present 'fire_burst.maxRange needs' "$(call "$BAD"'[{"when":[{"type":"always"}],"then":[{"type":"fire_burst","x":1,"y":1,"maxRange":200}]}]}}')"
R=$(call "$BAD"'[{"when":[{"type":"object_present","color":"#ff0000"}],"then":[{"type":"aim_to_found","x":800,"y":1200,"predictMs":900,"maxRange":250},{"type":"fire_burst","x":900,"y":1700,"maxRange":250}]}]}}')
check aim-predict-clamped '"predictMs":600' "$(call '{"name":"game_bot","arguments":{"action":"get","name":"x"}}')"
check aim-maxrange '"maxRange":250' "$(call '{"name":"game_bot","arguments":{"action":"get","name":"x"}}')"
check predict-zero-dropped 'False' "$(call '{"name":"game_bot","arguments":{"action":"create","name":"x0","rules":[{"when":[{"type":"object_present","color":"#ff0000"}],"then":[{"type":"aim_to_found","x":800,"y":1200,"predictMs":0}]}]}}' >/dev/null; call '{"name":"game_bot","arguments":{"action":"get","name":"x0"}}' | j '"predictMs" in json.dumps(d)')"

echo "== shooter assist (head only)"
call '{"name":"game_profile","arguments":{"set":{"controls":{"fire":{"x":900,"y":1700},"look":{"x":800,"y":1200},"stick":{"x":250,"y":1900},"cross":{"x":540,"y":1170},"heal":{"x":100,"y":1500}},"colors":{"head":{"hex":"#ff00ff"},"body":{"hex":"#ff0000"}},"regions":{"hp":{"x":0,"y":0,"w":300,"h":80}}}}}' >/dev/null
check shooter-needs-color 'shooter needs enemy (or head)' "$(call '{"name":"game_bot","arguments":{"action":"template","template":"shooter","params":{"fire":"@fire","look":"@look"}}}')"
R=$(call '{"name":"game_bot","arguments":{"action":"template","template":"shooter","name":"ff-assist","params":{"head":"@head","fire":"@fire","look":"@look","crosshair":"@cross","hp":"@hp","heal":"@heal"}}}')
check assist-ok '"ok":true' "$R"
check assist-rules '"ruleNames":["game-over","assist-headshot","auto-heal"]' "$R"
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"ff-assist"}}')
check assist-flag '"assist":true' "$G"
check assist-head-color '"color":"#ff00ff"' "$G"
check assist-maxsize '"maxSize":90' "$G"
check assist-range-aim '"maxRange":320' "$G"
check assist-predict '"predictMs":80' "$G"
check assist-deadzone '"deadzone":6' "$G"
check assist-maxstep '"maxStep":180' "$G"
check assist-fire-range 'True' "$(echo "$G" | j 'any(a.get("type")=="fire_burst" and a.get("maxRange")==320 for r in d["bot"]["rules"] for a in r["then"])')"
check assist-no-sweep 'False' "$(echo "$G" | j '"sweep" in json.dumps(d)')"
check assist-cross '"crosshairX":540,"crosshairY":1170' "$G"
check assist-nearest '"nearX":540,"nearY":1170' "$G"

echo "== trigger mode"
R=$(call '{"name":"game_bot","arguments":{"action":"template","template":"shooter","name":"ff-trigger","params":{"mode":"trigger","head":"@head","fire":"@fire","look":"@look","gameOverText":false}}}')
check trigger-rules '"ruleNames":["trigger-fire"]' "$R"
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"ff-trigger"}}')
check trigger-no-aim 'False' "$(echo "$G" | j '"aim_to_found" in json.dumps(d)')"
check trigger-assist-flag '"assist":true' "$G"
check trigger-fire-range '"maxRange":320' "$G"

echo "== full mode with headOffsetY"
R=$(call '{"name":"game_bot","arguments":{"action":"template","template":"shooter","name":"ff-full","params":{"mode":"full","enemy":"@body","fire":"@fire","look":"@look","stick":"@stick","headOffsetY":-25,"predictMs":0}}}')
check full-rules '"ruleNames":["game-over","aim-and-fire","sweep-and-advance"]' "$R"
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"ff-full"}}')
check full-not-assist 'False' "$(echo "$G" | j '"assist" in d["bot"]')"
check full-offset '"offsetY":-25' "$G"
check full-no-predict 'False' "$(echo "$G" | j '"predictMs" in json.dumps(d)')"
check full-no-range 'False' "$(echo "$G" | j '"maxRange" in json.dumps(d)')"

echo "== assist via create/update"
call '{"name":"game_bot","arguments":{"action":"update","name":"ff-full","assist":true}}' >/dev/null
check update-assist '"assist":true' "$(call '{"name":"game_bot","arguments":{"action":"get","name":"ff-full"}}')"

echo "== bootstrap + pages"
B=$(curl -s $U/agent/$T)
check boot-modes 'SHOOTER — THREE MODES' "$B"
check boot-assist-flag '[assist: user plays, bot helps]' "$B"
check builder-modes 'مساعد — أنا ألعب' "$(curl -s $U/builder.js)"
check builder-head-primary 'لون رأس العدو' "$(curl -s $U/builder.js)"
check setup-assist-badge 'مساعد' "$(curl -s $U/setup/$T)"

memdel 'kind=all' >/dev/null; call '{"name":"open_recents"}' >/dev/null
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
