#!/usr/bin/env bash
# v1.6 reflexes / game_loop / macros test. Requires running relay + fake-phone.
set -u
U="${1:-http://localhost:3000}"; T="${2:-dev-secret-token-123}"; D="${3:-test-phone}"
A=(-H "Authorization: Bearer $T" -H "Content-Type: application/json")
pass=0; fail=0
check() { if [[ "$3" == *"$2"* ]]; then echo "  ✔ $1"; pass=$((pass+1)); else echo "  ✘ $1  (expected '$2')"; echo "     got: ${3:0:300}"; fail=$((fail+1)); fi; }
call() { curl -s "${A[@]}" -d "$1" $U/api/devices/$D/tools/call; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

echo "== version / catalogue"
check version '"version":"4.1.0"' "$(curl -s $U/api/health)"
check tools-81 '81' "$(curl -s "$U/api/tools/schema?format=raw" | j 'len(d)')"

echo "== reflexes"
check watch-appear '"matched":true' "$(call '{"name":"watch_color","arguments":{"color":"#ff0000","timeoutMs":1000}}')"
check watch-vanish-timeout 'did not' "$(call '{"name":"watch_color","arguments":{"color":"#ff0000","appear":false,"timeoutMs":500}}')"
check watch-invalid '#RRGGBB' "$(call '{"name":"watch_color","arguments":{"color":"blue"}}')"
check waitpx '"hex":"#ff0000"' "$(call '{"name":"wait_pixel","arguments":{"x":10,"y":1500,"color":"#ff0000"}}')"
check waitpx-invalid 'requires numeric' "$(call '{"name":"wait_pixel","arguments":{"color":"#ff0000"}}')"
check tap_color '"tapped":{"x":550,"y":1500}' "$(call '{"name":"tap_color","arguments":{"color":"#ff0000","offsetX":10}}')"
check tap_color-miss 'not found' "$(call '{"name":"tap_color","arguments":{"color":"#00ff00"}}')"
pm2 restart fake-phone >/dev/null 2>&1; sleep 2
check diff-baseline '"baseline":true' "$(call '{"name":"screen_diff"}')"
check diff-regions '"changedPct":7.5' "$(call '{"name":"screen_diff"}')"
check findimg '"score":0.93' "$(call '{"name":"find_image","arguments":{"image":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="}}')"
check findimg-short 'requires image' "$(call '{"name":"find_image","arguments":{"image":"x"}}')"

echo "== game_loop"
R=$(call '{"name":"game_loop","arguments":{"when":{"name":"find_color","arguments":{"color":"#ff0000"}},"then":{"name":"tap","arguments":{"x":"$cx","y":"$cy+20"}},"iterations":3,"intervalMs":0}}')
check loop-ok '"ok":true' "$R"
check loop-rounds '"rounds":3' "$R"
check loop-acted '"acted":3' "$R"
check loop-inject '"cx":540' "$R"
R=$(call '{"name":"game_loop","arguments":{"when":{"name":"find_color","arguments":{"color":"#00ff00"}},"then":{"name":"press_home"},"else":{"name":"wait","arguments":{"ms":10}},"iterations":2,"intervalMs":0}}')
check loop-else '"else":{"name":"wait","ok":true}' "$R"
check loop-acted0 '"acted":0' "$R"
R=$(call '{"name":"game_loop","arguments":{"when":{"name":"find_color","arguments":{"color":"#ff0000"}},"then":{"name":"press_back"},"stopWhen":{"name":"find_color","arguments":{"color":"#ff0000"}},"iterations":5}}')
check loop-stopwhen '"stoppedBy":"stopWhen"' "$R"
check loop-bad-when 'must be an observation' "$(call '{"name":"game_loop","arguments":{"when":{"name":"tap"},"then":{"name":"tap"}}}')"
check loop-bad-then 'cannot be batch' "$(call '{"name":"game_loop","arguments":{"when":{"name":"find_color","arguments":{"color":"#ff0000"}},"then":{"name":"batch"}}}')"
check loop-then-fail 'then failed' "$(call '{"name":"game_loop","arguments":{"when":{"name":"find_color","arguments":{"color":"#ff0000"}},"then":{"name":"tap_element","arguments":{"text":"NOPE"}},"iterations":2}}')"

echo "== macros"
call '{"name":"list_macros","arguments":{"delete":"open-game"}}' >/dev/null
check save '"saved":"open-game"' "$(call '{"name":"save_macro","arguments":{"name":"Open Game","description":"launch + skip","steps":[{"name":"open_app","arguments":{"text":"Chrome"}},{"name":"wait","arguments":{"ms":10}},{"name":"press_back"}]}}')"
check save-bad-step 'invalid step' "$(call '{"name":"save_macro","arguments":{"name":"x","steps":[{"name":"nope"}]}}')"
check save-recursive 'invalid step' "$(call '{"name":"save_macro","arguments":{"name":"x","steps":[{"name":"run_macro","arguments":{"name":"open-game"}}]}}')"
check list 'open-game' "$(call '{"name":"list_macros"}')"
R=$(call '{"name":"run_macro","arguments":{"name":"open-game"}}')
check run-ok '"ok":true' "$R"
check run-steps '"steps":3' "$R"
check run-name '"macro":"open-game"' "$R"
check runs-counted '"runs":1' "$(call '{"name":"list_macros"}')"
check run-missing 'not found' "$(call '{"name":"run_macro","arguments":{"name":"nope"}}')"
check bootstrap-macros 'run_macro "open-game"' "$(curl -s $U/agent/$T)"
check bootstrap-reflexes 'watch_color' "$(curl -s $U/agent/$T)"
check delete '"removed":1' "$(call '{"name":"list_macros","arguments":{"delete":"open-game"}}')"

echo "== read-only scope"
RO=$(curl -s "${A[@]}" -d "{\"deviceId\":\"$D\",\"readOnly\":true}" $U/api/admin/tokens | j 'd["token"]')
check ro-watch-ok '"ok":true' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"watch_color","arguments":{"color":"#ff0000"}}' $U/api/devices/$D/tools/call)"
check ro-tapcolor-blocked 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"tap_color","arguments":{"color":"#ff0000"}}' $U/api/devices/$D/tools/call)"
check ro-loop-blocked 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"game_loop","arguments":{"when":{"name":"find_color","arguments":{"color":"#ff0000"}},"then":{"name":"tap","arguments":{"x":1,"y":1}}}}' $U/api/devices/$D/tools/call)"

echo "== phone.sh"
export RELAY_URL=$U RELAY_TOKEN=$T RELAY_DEVICE=$D
check sh-watch '"matched": true' "$(bash agent/phone.sh watch '#ff0000' appear 1000 2>&1)"
check sh-tapcolor '"found": true' "$(bash agent/phone.sh tapcolor '#ff0000' 2>&1)"
check sh-diff '"changedPct"' "$(bash agent/phone.sh diff 2>&1)"
check sh-savemacro '"saved": "t1"' "$(bash agent/phone.sh savemacro t1 '[{"name":"press_home"}]' 'test' 2>&1)"
check sh-macros 't1' "$(bash agent/phone.sh macros 2>&1)"
check sh-macro '"macro": "t1"' "$(bash agent/phone.sh macro t1 2>&1)"
call '{"name":"list_macros","arguments":{"delete":"t1"}}' >/dev/null

echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
