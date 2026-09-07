#!/usr/bin/env bash
# v1.8 composite intelligence test: observe / smart_tap / do_until / dismiss_popups / recent_actions / app-tagged notes.
# Requires running relay + fake-phone.
set -u
U="${1:-http://localhost:3000}"; T="${2:-dev-secret-token-123}"; D="${3:-test-phone}"
A=(-H "Authorization: Bearer $T" -H "Content-Type: application/json")
pass=0; fail=0
check() { if [[ "$3" == *"$2"* ]]; then echo "  ✔ $1"; pass=$((pass+1)); else echo "  ✘ $1  (expected '$2')"; echo "     got: ${3:0:300}"; fail=$((fail+1)); fi; }
call() { curl -s "${A[@]}" -d "$1" $U/api/devices/$D/tools/call; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
export RELAY_URL=$U RELAY_TOKEN=$T RELAY_DEVICE=$D

echo "== version / catalogue"
check version '"version":"1.8.0"' "$(curl -s $U/api/health)"
check tools-61 '61' "$(curl -s "$U/api/tools/schema?format=raw" | j 'len(d)')"
check mcp-lists-observe 'smart_tap' "$(curl -s -X POST -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' $U/mcp/$T)"
check bootstrap-v18 'observe [grid]' "$(curl -s $U/agent/$T)"
check bootstrap-rule0 'START of every session' "$(curl -s $U/agent/$T)"

echo "== observe"
R=$(call '{"name":"observe","arguments":{"colors":["#ff0000","#00ff00"],"grid":100}}')
check observe-ok '"ok":true' "$R"
check observe-app '"package":"com.example.spacerunner"' "$R"
check observe-image '"image":{"mime"' "$R"
check observe-text '"text":{"count":3' "$R"
check observe-colors '"color":"#ff0000","found":true' "$R"
check observe-changed '"changed":{"pct"' "$R"
R=$(call '{"name":"observe","arguments":{"image":false,"diff":false}}')
check observe-noimage-ok '"ok":true' "$R"
check observe-noimage 'False' "$(echo "$R" | j '"image" in d')"
check observe-nodiff 'False' "$(echo "$R" | j '"changed" in d')"
check observe-screen '"screen":{"w":1080' "$(call '{"name":"observe"}')"

echo "== smart_tap"
R=$(call '{"name":"smart_tap","arguments":{"text":"PLAY"}}')
check smart-ui '"via":"ui"' "$R"
check smart-ui-tapped '"tapped":{"x":540,"y":990}' "$R"
check smart-verify '"changed":' "$R"
R=$(call '{"name":"smart_tap","arguments":{"text":"Continue"}}')
check smart-ocr '"via":"ocr"' "$R"
check smart-ocr-tapped '"tapped":{"x":540,"y":1635}' "$R"
check smart-id '"via":"ui"' "$(call '{"name":"smart_tap","arguments":{"text":"","elementId":"btn_shop"}}')"
check smart-fallback '"via":"fallback"' "$(call '{"name":"smart_tap","arguments":{"text":"NOPE","fallback":{"x":10,"y":20},"verify":false}}')"
check smart-miss 'not found via ui or ocr' "$(call '{"name":"smart_tap","arguments":{"text":"NOPE"}}')"
check smart-tried '"tried":["ui:5","ocr:3"]' "$(call '{"name":"smart_tap","arguments":{"text":"NOPE"}}')"
check smart-empty 'requires text' "$(call '{"name":"smart_tap","arguments":{"text":""}}')"

echo "== do_until"
R=$(call '{"name":"do_until","arguments":{"action":{"name":"press_back"},"until":{"name":"wait_for_text","arguments":{"text":"PLAY","timeoutMs":500}}}}')
check until-already '"matched":true' "$R"
check until-zero-tries '"tries":0' "$R"
R=$(call '{"name":"do_until","arguments":{"action":{"name":"press_back"},"until":{"name":"find_color","arguments":{"color":"#00ff00"}},"maxTries":2,"intervalMs":0}}')
check until-fail 'condition not met after 2 tries' "$R"
check until-trace '"trace":[{"i":0,"ok":true}' "$R"
check until-bad-obs 'until must be an observation tool' "$(call '{"name":"do_until","arguments":{"action":{"name":"tap","arguments":{"x":1,"y":1}},"until":{"name":"tap"}}}')"
check until-bad-action 'action cannot be game_loop' "$(call '{"name":"do_until","arguments":{"action":{"name":"game_loop"},"until":{"name":"find_color"}}}')"
check until-smart-inner '"via":"ui"' "$(call '{"name":"do_until","arguments":{"action":{"name":"smart_tap","arguments":{"text":"PLAY","verify":false}},"until":{"name":"find_color","arguments":{"color":"#00ff00"}},"maxTries":1,"intervalMs":0}}')"

echo "== dismiss_popups"
R=$(call '{"name":"dismiss_popups"}')
check popups-found '"dismissed":2' "$R"
check popups-label '"label":"Continue"' "$R"
check popups-1round '"dismissed":1' "$(call '{"name":"dismiss_popups","arguments":{"rounds":1}}')"
check popups-extra-ui '"label":"settings","via":"ui"' "$(call '{"name":"dismiss_popups","arguments":{"extra":["SETTINGS"],"rounds":1}}')"
check popups-noocr '"dismissed":0' "$(call '{"name":"dismiss_popups","arguments":{"ocr":false}}')"

echo "== recent_actions + app-tagged notes"
R=$(call '{"name":"recent_actions","arguments":{"limit":3}}')
check history-count '"count":3' "$R"
check history-fields '"ago":"' "$R"
check history-limit '"count":1' "$(call '{"name":"recent_actions","arguments":{"limit":1}}')"
call '{"name":"recall","arguments":{"forget":-1}}' >/dev/null
check remember-autotag '"app":"com.example.spacerunner"' "$(call '{"name":"remember","arguments":{"text":"jump=(950,2100)"}}')"
check remember-override '"app":"com.other.game"' "$(call '{"name":"remember","arguments":{"text":"other","app":"com.other.game"}}')"
check recall-all '"total":2' "$(call '{"name":"recall"}')"
check recall-current '"count":1,"total":2,"app":"com.example.spacerunner"' "$(call '{"name":"recall","arguments":{"app":"current"}}')"
check recall-filter '"text":"other"' "$(call '{"name":"recall","arguments":{"app":"com.other.game"}}')"
check bootstrap-grouped '— com.example.spacerunner —' "$(curl -s $U/agent/$T)"

echo "== read-only scope"
RO=$(curl -s "${A[@]}" -d '{"deviceId":"test-phone","label":"ro18","readOnly":true}' $U/api/admin/tokens | j 'd["token"]')
check ro-observe '"ok":true' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"observe","arguments":{"image":false}}' $U/api/devices/$D/tools/call)"
check ro-history '"count"' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"recent_actions"}' $U/api/devices/$D/tools/call)"
check ro-smart-denied 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"smart_tap","arguments":{"text":"PLAY"}}' $U/api/devices/$D/tools/call)"
check ro-popups-denied 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"dismiss_popups"}' $U/api/devices/$D/tools/call)"

echo "== phone.sh"
cd /tmp
check sh-look 'saved look.png' "$(bash /home/user/webapp/agent/phone.sh look 100 '#ff0000' 2>&1)"
check sh-look-lines '( 540, 990) PLAY' "$(bash /home/user/webapp/agent/phone.sh look 2>&1)"
check sh-press '"via": "ui"' "$(bash /home/user/webapp/agent/phone.sh press PLAY 2>&1)"
check sh-press-fallback '"via": "fallback"' "$(bash /home/user/webapp/agent/phone.sh press NOPE 5 6 2>&1)"
check sh-popups '"dismissed": ' "$(bash /home/user/webapp/agent/phone.sh popups 2>&1)"
check sh-until '"matched": true' "$(bash /home/user/webapp/agent/phone.sh until '{"name":"press_back"}' '{"name":"wait_for_text","arguments":{"text":"PLAY","timeoutMs":500}}' 2 2>&1)"
check sh-history 'ago' "$(bash /home/user/webapp/agent/phone.sh history 3 2>&1)"
check sh-recall-tag '(com.other.game) other' "$(bash /home/user/webapp/agent/phone.sh recall 2>&1)"
cd - >/dev/null

echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
