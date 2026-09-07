#!/usr/bin/env bash
# v1.5 game/precision tools test. Requires running relay + fake-phone (see e2e.sh header).
set -u
U="${1:-http://localhost:3000}"; T="${2:-dev-secret-token-123}"; D="${3:-test-phone}"
A=(-H "Authorization: Bearer $T" -H "Content-Type: application/json")
pass=0; fail=0
check() { if [[ "$3" == *"$2"* ]]; then echo "  ✔ $1"; pass=$((pass+1)); else echo "  ✘ $1  (expected '$2')"; echo "     got: ${3:0:300}"; fail=$((fail+1)); fi; }
call() { curl -s "${A[@]}" -d "$1" $U/api/devices/$D/tools/call; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

echo "== version / catalogue"
check version '"version":"1.9.0"' "$(curl -s $U/api/health)"
check tools-65 '65' "$(curl -s "$U/api/tools/schema?format=raw" | j 'len(d)')"

echo "== precision input"
check tap_sequence '"taps":2' "$(call '{"name":"tap_sequence","arguments":{"points":[{"x":100,"y":100,"delayMs":50},{"x":200,"y":200,"durationMs":80}]}}')"
check tap_sequence-invalid 'requires points' "$(call '{"name":"tap_sequence","arguments":{"points":[]}}')"
check repeat_tap '"taps":10' "$(call '{"name":"repeat_tap","arguments":{"x":540,"y":900,"count":10,"intervalMs":50}}')"
check repeat_tap-too-long '<= 50s' "$(call '{"name":"repeat_tap","arguments":{"x":1,"y":1,"count":100,"intervalMs":5000}}')"
check swipe_path '"points":3' "$(call '{"name":"swipe_path","arguments":{"points":[{"x":1,"y":1},{"x":2,"y":2},{"x":3,"y":3}],"duration":300}}')"
check swipe_path-1pt 'points[2..50]' "$(call '{"name":"swipe_path","arguments":{"points":[{"x":1,"y":1}]}}')"
check multi_tap '"fingers":2' "$(call '{"name":"multi_tap","arguments":{"points":[{"x":1,"y":1},{"x":900,"y":1}]}}')"

echo "== vision"
check get_pixels '#ff0000' "$(call '{"name":"get_pixels","arguments":{"points":[{"x":10,"y":10},{"x":10,"y":1500}]}}')"
check find_color '"cx":540' "$(call '{"name":"find_color","arguments":{"color":"#FF0000","tolerance":30}}')"
check find_color-miss '"found":false' "$(call '{"name":"find_color","arguments":{"color":"#00ff00"}}')"
check find_color-invalid '#RRGGBB' "$(call '{"name":"find_color","arguments":{"color":"red"}}')"
check shot-grid-region '"grid": 100' "$(call '{"name":"capture_screen","arguments":{"grid":100,"region":{"x":0,"y":0,"w":500,"h":500}}}' | j 'json.dumps(d["data"])')"
check shot-png-query '200 image/png' "$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "${A[@]}" "$U/api/devices/$D/screenshot.png?grid=100&region=0,0,500,500&maxWidth=1080")"

echo "== act_and_see"
R=$(call '{"name":"act_and_see","arguments":{"action":{"name":"tap","arguments":{"x":540,"y":1500}},"waitMs":100,"grid":100}}')
check aas-ok '"ok":true' "$R"
check aas-action '"name":"tap"' "$R"
check aas-image '"mime":"image/png"' "$R"
check aas-nested-blocked 'not allowed inside' "$(call '{"name":"act_and_see","arguments":{"action":{"name":"batch","arguments":{}}}}')"
check aas-failed-action '"skipped' "$(call '{"name":"act_and_see","arguments":{"action":{"name":"tap_element","arguments":{"text":"NOPE"}}}}')"

echo "== wait_for_screen (fake hash flips after 2 polls)"
pm2 restart fake-phone >/dev/null 2>&1; sleep 2
check wfs-change '"changed":true' "$(call '{"name":"wait_for_screen","arguments":{"mode":"change","timeoutMs":4000,"intervalMs":100}}')"
check wfs-stable '"stable":true' "$(call '{"name":"wait_for_screen","arguments":{"mode":"stable","timeoutMs":4000,"intervalMs":100,"stableFor":300}}')"

echo "== memory (remember / recall / bootstrap)"
call '{"name":"recall","arguments":{"forget":-1}}' >/dev/null
check remember '"count":1' "$(call '{"name":"remember","arguments":{"text":"SpaceRunner: PLAY at (540,990)"}}')"
call '{"name":"remember","arguments":{"text":"Gear icon top-right (1000,120)"}}' >/dev/null
check recall 'SpaceRunner' "$(call '{"name":"recall"}')"
check recall-count '2' "$(call '{"name":"recall"}' | j 'd["count"]')"
check bootstrap-memory 'SpaceRunner: PLAY' "$(curl -s $U/agent/$T)"
check bootstrap-playbook 'GAME PLAYBOOK' "$(curl -s $U/agent/$T)"
check bootstrap-see 'phone.sh see' "$(curl -s $U/agent/$T)"
check forget-one '"count":1' "$(call '{"name":"recall","arguments":{"forget":0}}')"
check notes-rest 'Gear icon' "$(curl -s "${A[@]}" $U/api/devices/$D/notes)"
check remember-empty 'requires text' "$(call '{"name":"remember","arguments":{"text":"  "}}')"
RO=$(curl -s "${A[@]}" -d "{\"deviceId\":\"$D\",\"readOnly\":true}" $U/api/admin/tokens | j 'd["token"]')
check readonly-recall-ok '"ok":true' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"recall"}' $U/api/devices/$D/tools/call)"
check readonly-remember-blocked 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"remember","arguments":{"text":"x"}}' $U/api/devices/$D/tools/call)"
check readonly-pixels-ok '"ok":true' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"get_pixels","arguments":{"points":[{"x":1,"y":1}]}}' $U/api/devices/$D/tools/call)"
check readonly-repeat-blocked 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"repeat_tap","arguments":{"x":1,"y":1}}' $U/api/devices/$D/tools/call)"

echo "== phone.sh"
export RELAY_URL=$U RELAY_TOKEN=$T RELAY_DEVICE=$D
check sh-see 'see.png' "$(cd /tmp && bash /home/user/webapp/agent/phone.sh see tap 540 990 2>&1)"
check sh-rep '"taps": 3' "$(bash agent/phone.sh rep 540 900 3 50 2>&1)"
check sh-color '"cx": 540' "$(bash agent/phone.sh color '#ff0000' 2>&1)"
check sh-recall 'Gear icon' "$(bash agent/phone.sh recall 2>&1)"
check sh-shot-grid 'saved' "$(cd /tmp && bash /home/user/webapp/agent/phone.sh shot g.png 1080 jpeg 100 0,0,500,500 2>&1)"
rm -f /tmp/see.png /tmp/g.png

echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
