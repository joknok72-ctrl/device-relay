#!/usr/bin/env bash
# v2.3 test: game_profile + @name resolution + play sessions + QUICK START bootstrap + setup page. Requires relay + fake-phone.
set -u
U="${1:-http://localhost:3000}"; T="${2:-dev-secret-token-123}"; D="${3:-test-phone}"
A=(-H "Authorization: Bearer $T" -H "Content-Type: application/json")
pass=0; fail=0
check() { if [[ "$3" == *"$2"* ]]; then echo "  ✔ $1"; pass=$((pass+1)); else echo "  ✘ $1  (expected '$2')"; echo "     got: ${3:0:300}"; fail=$((fail+1)); fi; }
call() { curl -s "${A[@]}" -d "$1" $U/api/devices/$D/tools/call; }
mem() { curl -s "${A[@]}" "$U/api/admin/devices/$D/memory$1"; }
memdel() { curl -s -X DELETE "${A[@]}" "$U/api/admin/devices/$D/memory?$1"; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
export RELAY_URL=$U RELAY_TOKEN=$T RELAY_DEVICE=$D
P=/home/user/webapp/agent/phone.sh
call '{"name":"open_recents"}' >/dev/null
memdel 'kind=all' >/dev/null
call '{"name":"get_current_app"}' >/dev/null   # registers current app + opens a session

echo "== version"
check version '"version":"2.5.0"' "$(curl -s $U/api/health)"
check tools-78 '78' "$(curl -s "$U/api/tools/schema?format=raw" | j 'len(d)')"
check tap-at-param '"at":{"type":"string"' "$(curl -s "$U/api/tools/schema?format=raw" | j 'json.dumps([t for t in d if t["name"]=="tap"][0]["parameters"]["properties"]).replace(" ","")')"

echo "== no profile yet"
check ref-noprofile 'no game_profile exists' "$(call '{"name":"tap","arguments":{"at":"@jump"}}')"
R=$(call '{"name":"game_profile"}')
check get-empty '"exists":false' "$R"
check get-hint 'no profile yet' "$R"
check get-app '"app":"com.example.spacerunner"' "$R"

echo "== set profile"
R=$(call '{"name":"game_profile","arguments":{"label":"Space Runner","set":{"controls":{"Jump":{"x":950,"y":2100,"reactMs":120},"fire":{"x":200,"y":2100}},"colors":{"enemy":{"hex":"FF0000","tolerance":30},"gameover":{"hex":"#00ff00"}},"regions":{"score":{"x":0,"y":0,"w":500,"h":200},"hitline":{"x":0,"y":1400,"w":1080,"h":300}},"settings":{"lanes":4,"mode":"hard"}}}}')
check set-ok '"ok":true' "$R"
check set-name-normalised '"jump":{"x":950,"y":2100,"reactMs":120}' "$R"
check set-hex-normalised '"enemy":{"hex":"#ff0000","tolerance":30}' "$R"
check set-label '"label":"Space Runner"' "$R"
check set-bad-control 'needs numeric x,y' "$(call '{"name":"game_profile","arguments":{"set":{"controls":{"bad":{"x":"a"}}}}}')"
check set-bad-color 'needs hex' "$(call '{"name":"game_profile","arguments":{"set":{"colors":{"bad":{"hex":"red"}}}}}')"
check set-bad-region 'needs numeric x,y,w,h' "$(call '{"name":"game_profile","arguments":{"set":{"regions":{"bad":{"x":1}}}}}')"

echo "== @name resolution"
R=$(call '{"name":"tap","arguments":{"at":"@jump"}}')
check at-ok '"ok":true' "$R"
check at-resolved '"resolved":["@jump"]' "$R"
check at-offset '"resolved":["@jump"]' "$(call '{"name":"tap","arguments":{"at":"@jump+20,-10"}}')"
check at-offset-coords '"x":970,"y":2090' "$(call '{"name":"recent_actions","arguments":{"limit":1}}')"
check xy-refs '"resolved":["@fire","@fire"]' "$(call '{"name":"tap","arguments":{"x":"@fire","y":"@fire"}}')"
check color-ref '"count":3' "$(call '{"name":"find_objects","arguments":{"color":"@enemy"}}')"
check color-ref-resolved '"resolved":["@enemy"]' "$(call '{"name":"find_objects","arguments":{"color":"@enemy"}}')"
check region-ref '"value":1250' "$(call '{"name":"read_number","arguments":{"region":"@score"}}')"
check colors-array-ref '"color":"#ff0000","found":true' "$(call '{"name":"find_colors","arguments":{"colors":["@enemy","@gameover"]}}')"
R=$(call '{"name":"auto_react","arguments":{"color":"@enemy","region":"@hitline","tapX":"@fire","tapY":"@fire","stopColor":"@gameover","maxTriggers":1}}')
check react-refs '"stoppedBy":"stopColor"' "$R"
check react-resolved '"@hitline"' "$R"
check nested-ref '"x":950,"y":2100' "$(call '{"name":"tap_sequence","arguments":{"points":[{"at":"@jump"},{"at":"@fire","delayMs":50}]}}' >/dev/null; call '{"name":"recent_actions","arguments":{"limit":1}}' | j 'json.dumps(d["actions"][0])' | head -c 0; curl -s "${A[@]}" $U/api/devices/$D/logs | j 'json.dumps([l["action"]["points"][0] for l in d if l["action"]["type"]=="tap_sequence"][0]).replace(" ","")')"
check unknown-ref 'unknown control @nope' "$(call '{"name":"tap","arguments":{"at":"@nope"}}')"
check unknown-ref-lists '"controls":["jump","fire"]' "$(call '{"name":"tap","arguments":{"at":"@nope"}}')"
check unknown-color 'unknown color @nope' "$(call '{"name":"find_color","arguments":{"color":"@nope"}}')"
check bad-ref-syntax 'bad reference' "$(call '{"name":"tap","arguments":{"at":"@bad name!"}}')"
check setting-ref 'True' "$(call '{"name":"remember","arguments":{"text":"x"}}' >/dev/null; call '{"name":"game_profile"}' | j 'd["profile"]["settings"]["lanes"]==4')"
check smart-tap-fallback-ref '"via":"fallback"' "$(call '{"name":"smart_tap","arguments":{"text":"NOPE","fallback":{"at":"@jump"},"verify":false}}')"
check smart-tap-fallback-pos '"tapped":{"x":950,"y":2100}' "$(call '{"name":"smart_tap","arguments":{"text":"NOPE","fallback":{"at":"@jump"},"verify":false}}')"

echo "== unset / delete / history"
check unset '"fire"' "$(call '{"name":"game_profile","arguments":{"unset":{"controls":["jump"]}}}' | j 'json.dumps(list(d["profile"]["controls"]))')"
check unset-gone 'False' "$(call '{"name":"game_profile"}' | j '"jump" in d["profile"]["controls"]')"
R=$(call '{"name":"game_profile","arguments":{"history":true}}')
check history '"history":[{"when":"' "$R"
check history-cmds 'True' "$(echo "$R" | j 'd["history"][0]["commands"] > 5')"
check delete '"removed":1' "$(call '{"name":"game_profile","arguments":{"delete":true}}')"
check delete-gone '"exists":false' "$(call '{"name":"game_profile"}')"
check explicit-app '"app":"com.other.game"' "$(call '{"name":"game_profile","arguments":{"app":"com.other.game","set":{"controls":{"a":{"x":1,"y":2}}}}}')"
check ref-explicit-app '"resolved":["@a"]' "$(call '{"name":"tap","arguments":{"at":"@a","app":"com.other.game"}}')"

echo "== sessions + memory integration"
M=$(mem '')
check mem-sessions '"sessions":' "$M"
check mem-current '"currentApp":"com.example.spacerunner"' "$M"
check mem-totals-profiles '"profiles":1' "$M"
check mem-group-profile 'True' "$(echo "$M" | j 'any(g["app"]=="com.other.game" and g.get("profile") for g in d["groups"])')"
check mem-group-sessions 'True' "$(echo "$M" | j 'any(g["app"]=="com.example.spacerunner" and g["sessions"]>=1 and g["playedMs"]>=0 for g in d["groups"])')"
check sessions-endpoint '"sessions":[{"app":"com.example.spacerunner"' "$(curl -s "${A[@]}" "$U/api/devices/$D/memory" | j 'json.dumps({"sessions":d["sessions"][:1]}).replace(" ","")')"
check del-profiles '"profiles": 1' "$(memdel 'kind=profiles&app=com.other.game' | j 'json.dumps(d["removed"])')"
check del-sessions 'True' "$(memdel 'kind=sessions' | j 'd["removed"]["sessions"] >= 1')"
EXP=$(call '{"name":"game_profile","arguments":{"set":{"controls":{"z":{"x":5,"y":6}}}}}' >/dev/null; mem '?format=export')
memdel 'kind=all' >/dev/null
check import-profiles '"profiles":1' "$(curl -s "${A[@]}" -d "$EXP" $U/api/admin/devices/$D/memory/import)"
check import-profile-restored '"z":{"x":5,"y":6}' "$(call '{"name":"game_profile"}')"

echo "== bootstrap QUICK START"
call '{"name":"game_profile","arguments":{"label":"Space Runner","set":{"controls":{"jump":{"x":950,"y":2100}},"colors":{"enemy":{"hex":"#ff0000"}}}}}' >/dev/null
B=$(curl -s $U/agent/$T)
check bs-quickstart '## 0. QUICK START — the phone is currently in: Space Runner' "$B"
check bs-known 'You already know this game' "$B"
check bs-controls '@jump=(950,2100)' "$B"
check bs-colors '@enemy=#ff0000' "$B"
check bs-5f '## 5f. GAME PROFILES' "$B"
check bs-5g '## 5g. Play history' "$B"
check bs-rule0 'use its @names immediately' "$B"
check bs-suggest 'Suggested first call:  ./phone.sh look' "$B"
memdel 'kind=profiles' >/dev/null
check bs-noprofile 'No profile for this app yet' "$(curl -s $U/agent/$T)"

echo "== read-only scope"
RO=$(curl -s "${A[@]}" -d '{"deviceId":"test-phone","label":"ro23","readOnly":true}' $U/api/admin/tokens | j 'd["token"]')
check ro-get '"exists"' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"game_profile"}' $U/api/devices/$D/tools/call)"
check ro-set-denied 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"game_profile","arguments":{"set":{"settings":{"a":1}}}}' $U/api/devices/$D/tools/call)"

echo "== setup page + phone.sh"
S=$(curl -s $U/setup/$T)
check setup-profile-btn 'data-mem="profile"' "$S"
check setup-sessions-btn 'data-mem="sessions"' "$S"
cd /tmp
call '{"name":"game_profile","arguments":{"set":{"controls":{"jump":{"x":950,"y":2100}},"colors":{"enemy":{"hex":"#ff0000"}}}}}' >/dev/null
check sh-profile '@jump           control (950,2100)' "$(bash $P profile 2>&1)"
check sh-tap-at '"resolved": [' "$(bash $P tap @jump 2>&1)"
check sh-tap-offset '"@jump"' "$(bash $P tap @jump+5,5 2>&1)"
check sh-long-at '"ok": true' "$(bash $P long @jump 300 2>&1)"
check sh-rep-at '"ok": true' "$(bash $P rep @jump 2 50 2>&1)"
check sh-objects-at '(3 objects' "$(bash $P objects @enemy 2>&1)"
check sh-profile-set '"ok": true' "$(bash $P profile set '{"settings":{"k":1}}' 2>&1)"
check sh-profile-unset '"ok": true' "$(bash $P profile unset '{"settings":["k"]}' 2>&1)"
check sh-sessions 'current app:' "$(bash $P sessions 3 2>&1)"
check sh-profile-delete '"removed": 1' "$(bash $P profile delete 2>&1)"
cd - >/dev/null

memdel 'kind=all' >/dev/null
call '{"name":"open_recents"}' >/dev/null
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
