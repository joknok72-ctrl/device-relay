#!/usr/bin/env bash
# v1.9 test: find_objects / auto_react / label_screen / identify_screen / observe.screenName. Requires relay + fake-phone.
set -u
U="${1:-http://localhost:3000}"; T="${2:-dev-secret-token-123}"; D="${3:-test-phone}"
A=(-H "Authorization: Bearer $T" -H "Content-Type: application/json")
pass=0; fail=0
check() { if [[ "$3" == *"$2"* ]]; then echo "  ✔ $1"; pass=$((pass+1)); else echo "  ✘ $1  (expected '$2')"; echo "     got: ${3:0:300}"; fail=$((fail+1)); fi; }
call() { curl -s "${A[@]}" -d "$1" $U/api/devices/$D/tools/call; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
export RELAY_URL=$U RELAY_TOKEN=$T RELAY_DEVICE=$D
P=/home/user/webapp/agent/phone.sh

echo "== version / catalogue"
check version '"version":"4.6.0"' "$(curl -s $U/api/health)"
check tools-83 '83' "$(curl -s "$U/api/tools/schema?format=raw" | j 'len(d)')"
check bootstrap-5d '## 5d. Labelled screens' "$(curl -s $U/agent/$T)"
check bootstrap-react 'auto_react "#rrggbb" region' "$(curl -s $U/agent/$T)"

echo "== find_objects"
R=$(call '{"name":"find_objects","arguments":{"color":"#ff0000"}}')
check objects-3 '"count":3' "$R"
check objects-sorted '"objects":[{"i":0,"cx":540,"cy":1500,"area":8000' "$R"
check objects-minsize '"count":1' "$(call '{"name":"find_objects","arguments":{"color":"#ff0000","minSize":60}}')"
check objects-max '"count":2' "$(call '{"name":"find_objects","arguments":{"color":"#ff0000","maxResults":2}}')"
check objects-miss '"found":false' "$(call '{"name":"find_objects","arguments":{"color":"#00ff00"}}')"
check objects-badcolor 'requires color' "$(call '{"name":"find_objects","arguments":{"color":"red"}}')"
check objects-in-loop '"acted":1' "$(call '{"name":"game_loop","arguments":{"when":{"name":"find_objects","arguments":{"color":"#ff0000"}},"then":{"name":"tap","arguments":{"x":"$cx","y":"$cy"}},"iterations":1}}')"
check objects-inject-xy '"cx":540,"cy":1500' "$(call '{"name":"game_loop","arguments":{"when":{"name":"find_objects","arguments":{"color":"#ff0000"}},"then":{"name":"tap","arguments":{"x":"$cx","y":"$cy"}},"iterations":1}}')"

echo "== auto_react"
R=$(call '{"name":"auto_react","arguments":{"color":"#ff0000","maxTriggers":3,"timeoutMs":3000,"region":{"x":0,"y":1400,"w":1080,"h":300}}}')
check react-ok '"ok":true' "$R"
check react-triggers '"triggers":3' "$R"
check react-stop '"stoppedBy":"maxTriggers"' "$R"
check react-tap-pos '"x":540,"y":1500' "$R"
check react-offset '"x":560,"y":1450' "$(call '{"name":"auto_react","arguments":{"color":"#ff0000","maxTriggers":1,"tapOffsetX":20,"tapOffsetY":-50}}')"
check react-fixed '"x":100,"y":200' "$(call '{"name":"auto_react","arguments":{"color":"#ff0000","maxTriggers":1,"tapX":100,"tapY":200}}')"
check react-none '"triggers":0' "$(call '{"name":"auto_react","arguments":{"color":"#0000ff","timeoutMs":600}}')"
check react-badcolor 'requires color' "$(call '{"name":"auto_react","arguments":{"color":"zzz"}}')"
check react-clamp-timeout 'ok' "$(curl -s "${A[@]}" -d '{"action":{"type":"auto_react","color":"#ff0000","timeoutMs":99999,"maxTriggers":1}}' $U/api/devices/$D/command | j '"ok" if d.get("ok") else d')"

echo "== label_screen / identify_screen"
call '{"name":"identify_screen","arguments":{"delete":"*"}}' >/dev/null
call '{"name":"open_recents"}' >/dev/null
check identify-empty '"screenName":null' "$(call '{"name":"identify_screen"}')"
check identify-empty-hint 'no labels yet' "$(call '{"name":"identify_screen"}')"
R=$(call '{"name":"label_screen","arguments":{"name":"Main Menu"}}')
check label-saved '"saved":"main-menu"' "$R"
check label-words '"words":["score","play","continue"]' "$R"
check label-app '"app":"com.example.spacerunner"' "$R"
check label-empty 'requires name' "$(call '{"name":"label_screen","arguments":{"name":""}}')"
check identify-menu '"screenName":"main-menu"' "$(call '{"name":"identify_screen"}')"
check identify-conf 'True' "$(call '{"name":"identify_screen"}' | j 'd["confidence"] > 0.9')"
call '{"name":"press_home"}' >/dev/null
check identify-home-unknown '"screenName":null' "$(call '{"name":"identify_screen","arguments":{"minConfidence":0.6}}')"
check identify-home-hint 'new screen' "$(call '{"name":"identify_screen","arguments":{"minConfidence":0.6}}')"
check label-home '"saved":"home"' "$(call '{"name":"label_screen","arguments":{"name":"home"}}')"
check identify-home '"screenName":"home"' "$(call '{"name":"identify_screen"}')"
call '{"name":"open_recents"}' >/dev/null
R=$(call '{"name":"identify_screen"}')
check identify-back-menu '"screenName":"main-menu"' "$R"
check identify-runnerup '"runnerUp":{"name":"home"' "$R"
check identify-count '"count":2' "$R"
check identify-list '"labels":[{"name":"main-menu"' "$(call '{"name":"identify_screen","arguments":{"list":true}}')"
check identify-minconf-param '"screenName":"main-menu"' "$(call '{"name":"identify_screen","arguments":{"minConfidence":0.95}}')"
check identify-as-condition '"matched":true' "$(call '{"name":"do_until","arguments":{"action":{"name":"press_back"},"until":{"name":"identify_screen"},"maxTries":1}}')"
check bootstrap-lists-screen 'main-menu  (com.example.spacerunner)' "$(curl -s $U/agent/$T)"
check observe-screenname '"screenName":"main-menu"' "$(call '{"name":"observe","arguments":{"image":false}}')"
check observe-noidentify 'False' "$(call '{"name":"observe","arguments":{"image":false,"identify":false}}' | j '"screenName" in d')"
check delete-one '"removed":1' "$(call '{"name":"identify_screen","arguments":{"delete":"home"}}')"
check delete-all '"removed":1' "$(call '{"name":"identify_screen","arguments":{"delete":"*"}}')"

echo "== read-only scope"
RO=$(curl -s "${A[@]}" -d '{"deviceId":"test-phone","label":"ro19","readOnly":true}' $U/api/admin/tokens | j 'd["token"]')
check ro-objects '"count":3' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"find_objects","arguments":{"color":"#ff0000"}}' $U/api/devices/$D/tools/call)"
check ro-identify '"screenName"' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"identify_screen"}' $U/api/devices/$D/tools/call)"
check ro-react-denied 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"auto_react","arguments":{"color":"#ff0000"}}' $U/api/devices/$D/tools/call)"
check ro-label-denied 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"label_screen","arguments":{"name":"x"}}' $U/api/devices/$D/tools/call)"

echo "== phone.sh"
cd /tmp
check sh-objects '(3 objects, 3 total blobs)' "$(bash $P objects '#ff0000' 2>&1)"
check sh-objects-region '#0 ( 540,1500)' "$(bash $P objects '#ff0000' 24 0,1400,1080,300 2>&1)"
check sh-react '"triggers": 2' "$(bash $P react '#ff0000' 0,1400,1080,300 2 2000 2>&1)"
check sh-label '"saved": "menu"' "$(bash $P label menu 2>&1)"
check sh-which '"screenName": "menu"' "$(bash $P which 2>&1)"
check sh-screens '(1 labelled screens)' "$(bash $P screens 2>&1)"
check sh-unlabel '"removed": 1' "$(bash $P unlabel menu 2>&1)"
cd - >/dev/null

call '{"name":"open_recents"}' >/dev/null  # restore fake phone to menu screen
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
