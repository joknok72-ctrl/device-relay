#!/usr/bin/env bash
# v3.1 test: match:hue (conditions + find_objects), lockRadius, gateErr, shooter template defaults, builder preset. Requires relay + fake-phone.
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
check version '"version":"3.1.0"' "$(curl -s $U/api/health)"
check find-objects-match-doc 'hue' "$(curl -s "$U/api/tools/schema?format=raw" | j '[t for t in d if t["name"]=="find_objects"][0]["parameters"]["properties"]["match"]["description"]')"

echo "== validation"
BAD='{"name":"game_bot","arguments":{"action":"create","name":"x","rules":'
check match-bad 'match must be rgb|hue' "$(call "$BAD"'[{"when":[{"type":"color_present","color":"#ff0000","match":"lab"}],"then":[{"type":"back"}]}]}}')"
check lock-bad 'lockRadius must be' "$(call "$BAD"'[{"when":[{"type":"object_present","color":"#ff0000","lockRadius":-1}],"then":[{"type":"back"}]}]}}')"
call "$BAD"'[{"when":[{"type":"object_present","color":"#ff0000","match":"hue","tolerance":20,"lockRadius":150},{"type":"color_present","color":"#00ff00","match":"rgb"}],"then":[{"type":"aim_to_found","x":800,"y":1200},{"type":"fire_burst","x":900,"y":1700,"gateErr":40}]}]}}' >/dev/null
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"x"}}')
check match-hue-kept '"match":"hue"' "$G"
check match-rgb-dropped '1' "$(echo "$G" | j 'json.dumps(d).count("\"match\"")')"
check lock-kept '"lockRadius":150' "$G"
check gate-kept '"gateErr":40' "$G"
check gate-zero-dropped 'False' "$(call '{"name":"game_bot","arguments":{"action":"create","name":"x2","rules":[{"when":[{"type":"always"}],"then":[{"type":"fire_burst","x":1,"y":1,"gateErr":0}]}]}}' >/dev/null; call '{"name":"game_bot","arguments":{"action":"get","name":"x2"}}' | j '"gateErr" in json.dumps(d)')"

echo "== find_objects match passthrough"
R=$(curl -s "${A[@]}" -d '{"action":{"type":"find_objects","color":"#ff0000","match":"hue","tolerance":20}}' $U/api/devices/$D/command)
check fo-ok '"ok":true' "$R"
check fo-match-logged '"match":"hue"' "$(curl -s "${A[@]}" "$U/api/devices/$D/logs?limit=3")"
check fo-match-rgb-dropped 'False' "$(curl -s "${A[@]}" -d '{"action":{"type":"find_objects","color":"#ff0000","match":"rgb"}}' $U/api/devices/$D/command >/dev/null; curl -s "${A[@]}" "$U/api/devices/$D/logs?limit=1" | j '"match" in json.dumps(d)')"
check fo-tool-match '"ok":true' "$(call '{"name":"find_objects","arguments":{"color":"#ff0000","match":"hue","tolerance":25}}')"

echo "== shooter template v3.1 defaults"
call '{"name":"game_profile","arguments":{"set":{"controls":{"fire":{"x":900,"y":1700},"look":{"x":800,"y":1200}},"colors":{"head":{"hex":"#ff00ff"}}}}}' >/dev/null
R=$(call '{"name":"game_bot","arguments":{"action":"template","template":"shooter","name":"ff","params":{"head":"@head","fire":"@fire","look":"@look"}}}')
check sh-ok '"ok":true' "$R"
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"ff"}}')
check sh-hue '"match":"hue"' "$G"
check sh-hue-tol '"tolerance":22' "$G"
check sh-lock '"lockRadius":220' "$G"
check sh-gate '"gateErr":60' "$G"
R=$(call '{"name":"game_bot","arguments":{"action":"template","template":"shooter","name":"ff-rgb","params":{"head":"@head","fire":"@fire","look":"@look","match":"rgb","tolerance":36,"lockRadius":0,"gateErr":0}}}')
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"ff-rgb"}}')
check sh-rgb-no-match 'False' "$(echo "$G" | j '"match" in json.dumps(d)')"
check sh-rgb-tol '"tolerance":36' "$G"
check sh-lock0 '"lockRadius":0' "$G"
check sh-gate0-dropped 'False' "$(echo "$G" | j '"gateErr" in json.dumps(d)')"
R=$(call '{"name":"game_bot","arguments":{"action":"template","template":"color_tap","name":"ct-hue","params":{"color":"@head","match":"hue","tolerance":20}}}')
check ct-hue '"match":"hue"' "$(call '{"name":"game_bot","arguments":{"action":"get","name":"ct-hue"}}')"

echo "== bootstrap + builder"
check boot-hue 'match:"hue" (v3.1)' "$(curl -s $U/agent/$T)"
BJ=$(curl -s $U/builder.js)
check builder-preset 'Free Fire — هيدشوت مساعد' "$BJ"
check builder-preset-vals "name: 'freefire-headshot'" "$BJ"
check builder-match-select 'درجة اللون (Hue)' "$BJ"
check builder-verify-hue "match: mode" "$BJ"

memdel 'kind=all' >/dev/null; call '{"name":"open_recents"}' >/dev/null
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
