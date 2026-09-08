#!/usr/bin/env bash
# v2.7 test: object_present/absent, colors[], forMs, tap_all_found, aim_to_found, aim.alternate, maxFires, templates, ruleHits. Requires relay + fake-phone.
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
check version '"version":"3.0.0"' "$(curl -s $U/api/health)"
check tools-79 '79' "$(curl -s "$U/api/tools/schema?format=raw" | j 'len(d)')"
check tool-doc-aimbot 'aim_to_found' "$(curl -s "$U/api/tools/schema?format=raw" | grep -o 'aim_to_found' | head -1)"

echo "== new conditions / actions validation"
BAD='{"name":"game_bot","arguments":{"action":"create","name":"x","rules":'
check obj-needs-color 'needs color' "$(call "$BAD"'[{"when":[{"type":"object_present"}],"then":[{"type":"back"}]}]}}')"
check colors-array-bad 'needs color' "$(call "$BAD"'[{"when":[{"type":"color_present","colors":["#ff0000","nope"]}],"then":[{"type":"back"}]}]}}')"
check colors-max8 'max 8 colors' "$(call "$BAD"'[{"when":[{"type":"color_present","colors":["#000001","#000002","#000003","#000004","#000005","#000006","#000007","#000008","#000009"]}],"then":[{"type":"back"}]}]}}')"
check pick-bad 'pick must be' "$(call "$BAD"'[{"when":[{"type":"object_present","color":"#ff0000","pick":"random"}],"then":[{"type":"back"}]}]}}')"
check forMs-bad 'forMs must be' "$(call "$BAD"'[{"when":[{"type":"always","forMs":-5}],"then":[{"type":"back"}]}]}}')"
check tap-all-needs-object 'uses tap_all_found but has no object_present' "$(call "$BAD"'[{"when":[{"type":"color_present","color":"#ff0000"}],"then":[{"type":"tap_all_found"}]}]}}')"
check aim-to-needs-present 'uses aim_to_found but has no' "$(call "$BAD"'[{"when":[{"type":"always"}],"then":[{"type":"aim_to_found","x":800,"y":1200}]}]}}')"
check aim-to-needs-xy 'aim_to_found needs x,y' "$(call "$BAD"'[{"when":[{"type":"object_present","color":"#ff0000"}],"then":[{"type":"aim_to_found"}]}]}}')"
check tap-found-text-ok '"ok":true' "$(call "$BAD"'[{"when":[{"type":"text_present","text":"PLAY"}],"then":[{"type":"tap_found"}]}]}}')"
check tap-found-pixel-ok '"ok":true' "$(call '{"name":"game_bot","arguments":{"action":"create","name":"x2","rules":[{"when":[{"type":"pixel_is","x":5,"y":5,"color":"#ff0000"}],"then":[{"type":"tap_found"}]}]}}')"

echo "== create with v2.7 features (normalisation)"
R=$(call '{"name":"game_bot","arguments":{"action":"create","name":"v27","tickMs":70,"rules":[
 {"name":"aim-fire","priority":10,"cooldownMs":40,"when":[{"type":"object_present","colors":["#FF0000","#00ff00"],"pick":"nearest","tolerance":36}],"then":[{"type":"aim_to_found","x":800,"y":1200,"sensitivity":0.8},{"type":"fire_burst","x":900,"y":1700,"count":6,"intervalMs":70}]},
 {"name":"sweep","priority":1,"when":[{"type":"object_absent","color":"#ff0000","forMs":600}],"then":[{"type":"aim","x":800,"y":1200,"dx":260,"alternate":true},{"type":"aim","x":800,"y":1200,"dx":10,"alternate":false}]},
 {"name":"once","maxFires":1,"when":[{"type":"text_present","text":"PLAY","forMs":200}],"then":[{"type":"tap_found"}]},
 {"name":"pop","when":[{"type":"object_present","color":"#ffcc00","minSize":20,"maxSize":120}],"then":[{"type":"tap_all_found"}]},
 {"name":"over","when":[{"type":"text_present","text":"GAME OVER"}],"then":[{"type":"stop_bot"}]}]}}')
check v27-ok '"ok":true' "$R"
check v27-rules '"rules":5' "$R"
check v27-ruleNames '"ruleNames":["aim-fire","sweep","once","pop","over"]' "$R"
check v27-no-warn '"warnings":[]' "$R"
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"v27"}}')
check colors-norm '"colors":["#ff0000","#00ff00"]' "$G"
check color-first '"color":"#ff0000"' "$G"
check obj-defaults '"minSize":12,"maxSize":0' "$G"
check aimto-defaults '"sensitivity":0.8,"maxStep":300,"deadzone":12,"duration":60,"finger":1' "$G"
check alternate-kept '"alternate":true' "$G"
check alternate-false-dropped 'False' "$(echo "$G" | j '"alternate\":false" in json.dumps(d,separators=(",",":"))')"
check maxfires '"maxFires":1' "$G"
check forMs-kept '"forMs":600' "$G"
check tapall-defaults '"max":5,"intervalMs":40' "$G"
check single-color-no-array 'False' "$(echo "$G" | j 'any("colors" in c for r in d["bot"]["rules"] for c in r["when"] if c.get("color")=="#ffcc00")')"

echo "== run/status with ruleHits"
call '{"name":"game_bot","arguments":{"action":"run","name":"v27"}}' >/dev/null; sleep 0.4
S=$(call '{"name":"game_bot","arguments":{"action":"status"}}')
check status-ruleHits '"ruleHits":{"aim-fire":3}' "$S"
check status-avgTick '"avgTickMs":41' "$S"
call '{"name":"game_bot","arguments":{"action":"stop"}}' >/dev/null; sleep 0.4
L=$(call '{"name":"game_bot","arguments":{"action":"list"}}')
check list-lastrun-ruleHits '"ruleHits":{"aim-fire":3}' "$L"

echo "== @names inside colors[] / crosshair / nearX"
call '{"name":"game_profile","arguments":{"set":{"controls":{"fire":{"x":900,"y":1700},"look":{"x":800,"y":1200},"stick":{"x":250,"y":1900},"cross":{"x":540,"y":1170},"heal":{"x":100,"y":1500}},"colors":{"enemy":{"hex":"#ff0000"},"enemy2":{"hex":"#00ff00"},"note":{"hex":"#3366ff"}},"regions":{"hp":{"x":0,"y":0,"w":300,"h":80},"lane1":{"x":0,"y":1500,"w":270,"h":200},"lane2":{"x":270,"y":1500,"w":270,"h":200}}}}}' >/dev/null
R=$(call '{"name":"game_bot","arguments":{"action":"create","name":"named","rules":[{"name":"a","when":[{"type":"object_present","colors":["@enemy","@enemy2"],"pick":"nearest","nearX":"@cross","nearY":"@cross"}],"then":[{"type":"aim_to_found","at":"@look","crosshairX":"@cross","crosshairY":"@cross"}]}]}}')
check named-ok '"ok":true' "$R"
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"named"}}')
check named-colors '"colors":["#ff0000","#00ff00"]' "$G"
check named-near '"nearX":540,"nearY":1170' "$G"
check named-cross '"crosshairX":540,"crosshairY":1170' "$G"
check named-look '"x":800,"y":1200' "$G"

echo "== templates"
TL=$(call '{"name":"game_bot","arguments":{"action":"templates"}}')
check templates-ok '"ok":true' "$TL"
check templates-9 '9' "$(echo "$TL" | j 'len(d["templates"])')"
check templates-ids 'color_tap,shooter,runner,rhythm,idle_tapper,clicker,puzzle_match,fishing,racing' "$(echo "$TL" | j '",".join(t["id"] for t in d["templates"])')"
check templates-params 'enemy*:color' "$TL"
check template-unknown 'unknown template' "$(call '{"name":"game_bot","arguments":{"action":"template","template":"chess"}}')"
check template-missing 'needs params: enemy' "$(call '{"name":"game_bot","arguments":{"action":"template","template":"shooter","params":{"fire":"@fire"}}}')"

R=$(call '{"name":"game_bot","arguments":{"action":"template","template":"shooter","params":{"enemy":"@enemy","fire":"@fire","look":"@look","stick":"@stick","hp":"@hp","heal":"@heal","crosshair":"@cross","sensitivity":0.8}}}')
check shooter-ok '"ok":true' "$R"
check shooter-name '"name":"shooter-bot"' "$R"
check shooter-template '"template":"shooter"' "$R"
check shooter-tick '"tickMs":70' "$R"
check shooter-rules '"ruleNames":["game-over","aim-and-fire","low-hp","sweep-and-advance"]' "$R"
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"shooter-bot"}}')
check shooter-aimbot '"type":"aim_to_found"' "$G"
check shooter-nearest '"pick":"nearest"' "$G"
check shooter-cross '"crosshairX":540,"crosshairY":1170' "$G"
check shooter-sens '"sensitivity":0.8' "$G"
check shooter-fire '"type":"fire_burst","x":900,"y":1700' "$(echo "$G" | j 'json.dumps([a for r in d["bot"]["rules"] for a in r["then"] if a["type"]=="fire_burst"][0],separators=(",",":"),sort_keys=True)')"
check shooter-alternate '"alternate":true' "$G"
check shooter-forMs '"forMs":600' "$G"
check shooter-heal '"x":100,"y":1500' "$G"
check shooter-hp-region '"region":{"x":0,"y":0,"w":300,"h":80}' "$G"
check shooter-stop '"type":"stop_bot"' "$G"
check shooter-stored-template '"template":"shooter"' "$G"
# re-run the template with the same name = overwrite, keeps id
ID1=$(echo "$G" | j 'd["bot"]["id"]')
R=$(call '{"name":"game_bot","arguments":{"action":"template","template":"shooter","params":{"enemy":["@enemy","@enemy2"],"fire":"@fire","look":"@look","gameOverText":false}}}')
check shooter-overwrite-id "\"id\":\"$ID1\"" "$R"
check shooter-no-gameover-rule '"ruleNames":["aim-and-fire","sweep-and-advance"]' "$R"
check shooter-multi-colour '"colors":["#ff0000","#00ff00"]' "$(call '{"name":"game_bot","arguments":{"action":"get","name":"shooter-bot"}}')"
check shooter-warn-no-stop 'no stop_bot rule' "$R"

R=$(call '{"name":"game_bot","arguments":{"action":"template","template":"rhythm","params":{"note":"@note","lanes":["@lane1","@lane2"]},"name":"piano"}}')
check rhythm-ok '"ok":true' "$R"
check rhythm-name '"name":"piano"' "$R"
check rhythm-lanes '"ruleNames":["game-over","lane-1","lane-2"]' "$R"
check rhythm-tick '"tickMs":50' "$R"
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"piano"}}')
check rhythm-region '"region":{"x":270,"y":1500,"w":270,"h":200}' "$G"
check rhythm-nonexclusive '"exclusive":false' "$G"

R=$(call '{"name":"game_bot","arguments":{"action":"template","template":"runner","params":{"obstacle":"@enemy","lane":"@lane1","swipeFrom":"@stick","reaction":"up","playButton":true}}}')
check runner-ok '"ok":true' "$R"
check runner-rules '"ruleNames":["game-over","press-play","dodge"]' "$R"
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"runner-bot"}}')
check runner-swipe '"x1":250,"y1":1900,"x2":250,"y2":1400' "$(echo "$G" | j 'json.dumps([a for r in d["bot"]["rules"] for a in r["then"] if a["type"]=="swipe"][0],separators=(",",":"))')"

R=$(call '{"name":"game_bot","arguments":{"action":"template","template":"clicker","params":{"target":"@enemy","minSize":20}}}')
check clicker-ok '"ok":true' "$R"
check clicker-tapall '"type":"tap_all_found","max":6' "$(call '{"name":"game_bot","arguments":{"action":"get","name":"clicker-bot"}}' | j 'json.dumps([a for r in d["bot"]["rules"] for a in r["then"] if a["type"]=="tap_all_found"][0],separators=(",",":"))')"

R=$(call '{"name":"game_bot","arguments":{"action":"template","template":"racing","params":{"left":"@stick","right":"@fire","edge":"@enemy","aheadLeft":"@lane1","aheadRight":"@lane2","nitro":"@heal","gas":"@look"}}}')
check racing-ok '"ok":true' "$R"
check racing-rules '"ruleNames":["game-over","steer-left","steer-right","nitro","gas"]' "$R"
R=$(call '{"name":"game_bot","arguments":{"action":"template","template":"fishing","params":{"indicator":"@enemy","zone":"@lane1","button":"@fire"}}}')
check fishing-ok '"ruleNames":["game-over","hit","cast"]' "$R"
R=$(call '{"name":"game_bot","arguments":{"action":"template","template":"idle_tapper","params":{"tap":"@fire","bonus":"@enemy"}}}')
check idle-ok '"ruleNames":["game-over","bonus","tap"]' "$R"
R=$(call '{"name":"game_bot","arguments":{"action":"template","template":"puzzle_match","params":{"hint":"@enemy","hintButton":"@heal","swipe":"left"}}}')
check puzzle-ok '"ruleNames":["game-over","take-hint","ask-hint"]' "$R"
check puzzle-neighbour '"offsetX":-110' "$(call '{"name":"game_bot","arguments":{"action":"get","name":"puzzle_match-bot"}}')"

echo "== read-only can list templates"
RO=$(curl -s "${A[@]}" -d '{"deviceId":"test-phone","label":"ro27","readOnly":true}' $U/api/admin/tokens | j 'd["token"]')
RA=(-H "Authorization: Bearer $RO" -H "Content-Type: application/json")
check ro-templates '"ok":true' "$(curl -s "${RA[@]}" -d '{"name":"game_bot","arguments":{"action":"templates"}}' $U/api/devices/$D/tools/call)"
check ro-template-denied 'read-only' "$(curl -s "${RA[@]}" -d '{"name":"game_bot","arguments":{"action":"template","template":"clicker","params":{"target":"#ff0000"}}}' $U/api/devices/$D/tools/call)"

echo "== bootstrap"
B=$(curl -s $U/agent/$T)
check boot-templates 'action=template template=shooter' "$B"
check boot-colour-strategy 'COLOUR STRATEGY' "$B"
check boot-anatomy 'SHOOTER BOT ANATOMY' "$B"
check boot-highlight-tip 'enemy highlight' "$B"
check boot-aimbot 'aim_to_found' "$B"
check boot-sweep 'alternate:true' "$B"
check boot-ua-rule 'error code: 1010' "$B"
check phone-sh-ua 'User-Agent: device-relay-phone.sh' "$(curl -s $U/phone.sh)"

echo "== memory shows template"
check mem-template '"template":"shooter"' "$(curl -s "${A[@]}" "$U/api/admin/devices/$D/memory")"

echo "== phone.sh"
cd /tmp
check sh-templates 'shooter       [shooter]' "$(bash $P bot templates 2>&1)"
check sh-template '"template": "fishing"' "$(bash $P bot template fishing '{"indicator":"@enemy","zone":"@lane1","button":"@fire"}' rod 2>&1)"
check sh-template-name '"name": "rod"' "$(bash $P bot get rod 2>&1)"
check sh-bot-help 'templates | template' "$(bash $P bot wat 2>&1)"
check sh-help 'bot templates' "$(bash $P help 2>&1)"
cd - >/dev/null

echo "== setup page"
check setup-template-badge 'x.template' "$(curl -s $U/setup/$T)"

memdel 'kind=all' >/dev/null
call '{"name":"open_recents"}' >/dev/null
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
