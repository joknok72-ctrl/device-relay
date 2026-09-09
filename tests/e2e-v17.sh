#!/usr/bin/env bash
# v1.7 OCR / find_colors / stats / live preview test. Requires running relay + fake-phone.
set -u
U="${1:-http://localhost:3000}"; T="${2:-dev-secret-token-123}"; D="${3:-test-phone}"
A=(-H "Authorization: Bearer $T" -H "Content-Type: application/json")
pass=0; fail=0
check() { if [[ "$3" == *"$2"* ]]; then echo "  ✔ $1"; pass=$((pass+1)); else echo "  ✘ $1  (expected '$2')"; echo "     got: ${3:0:300}"; fail=$((fail+1)); fi; }
call() { curl -s "${A[@]}" -d "$1" $U/api/devices/$D/tools/call; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

echo "== version / catalogue"
check version '"version":"4.4.0"' "$(curl -s $U/api/health)"
check tools-83 '83' "$(curl -s "$U/api/tools/schema?format=raw" | j 'len(d)')"

call '{"name":"open_recents"}' >/dev/null  # fake phone: back to menu screen
echo "== OCR"
check read_text 'SCORE 1250' "$(call '{"name":"read_text"}')"
check read_text-region '"region"' "$(call '{"name":"read_text","arguments":{"region":{"x":0,"y":0,"w":500,"h":200}}}' | j 'json.dumps(list(d["data"].keys()))' )"
check tap_text '"tapped":{"x":540,"y":990}' "$(call '{"name":"tap_text","arguments":{"text":"play"}}')"
check tap_text-partial '"text":"Continue"' "$(call '{"name":"tap_text","arguments":{"text":"cont"}}')"
check tap_text-miss 'not found' "$(call '{"name":"tap_text","arguments":{"text":"NOPE"}}')"
check tap_text-seen '"seen":["SCORE 1250"' "$(call '{"name":"tap_text","arguments":{"text":"NOPE"}}')"
check tap_text-empty 'requires text' "$(call '{"name":"tap_text","arguments":{"text":" "}}')"
check wait_text '"found":true' "$(call '{"name":"wait_for_text","arguments":{"text":"score","timeoutMs":2000}}')"
check wait_text-vanish-timeout 'did not disappear' "$(call '{"name":"wait_for_text","arguments":{"text":"score","appear":false,"timeoutMs":800,"intervalMs":300}}')"

echo "== find_colors"
R=$(call '{"name":"find_colors","arguments":{"colors":["#ff0000","#00ff00"]}}')
check colors-2 '"results":[{"color":"#ff0000","found":true' "$R"
check colors-miss '"color":"#00ff00","found":false' "$R"
check colors-toomany 'colors[1..8]' "$(call '{"name":"find_colors","arguments":{"colors":["#1","#2","#3","#4","#5","#6","#7","#8","#9"]}}')"
check colors-bad 'bad color' "$(call '{"name":"find_colors","arguments":{"colors":["nope"]}}')"

echo "== game_loop with OCR / find_colors observations"
R=$(call '{"name":"game_loop","arguments":{"when":{"name":"find_colors","arguments":{"colors":["#00ff00","#ff0000"]}},"then":{"name":"tap","arguments":{"x":"$cx","y":"$cy"}},"iterations":2,"intervalMs":0}}')
check loop-colors '"acted":2' "$R"
R=$(call '{"name":"game_loop","arguments":{"when":{"name":"read_text","arguments":{}},"then":{"name":"press_home"},"iterations":1}}')
check loop-ocr '"acted":1' "$R"

echo "== session_stats"
call '{"name":"tap_element","arguments":{"text":"DOES-NOT-EXIST"}}' >/dev/null  # provoke one failure
R=$(call '{"name":"session_stats"}')
check stats-rate '"successRate":' "$R"
check stats-latency '"p50":' "$R"
check stats-byaction '"tap":{' "$R"
check stats-failures '"action":"tap_element"' "$R"

echo "== live preview"
# viewer connects FIRST (frames are only relayed while someone watches), then stream is enabled
FRAMES=$(node -e '
const ws = new WebSocket(process.argv[1]); let n=0
ws.onmessage = e => { try { if (JSON.parse(e.data).kind==="frame") n++ } catch{} }
ws.onopen = () => fetch(process.argv[2]+"/api/devices/"+process.argv[3]+"/tools/call",{method:"POST",headers:{Authorization:"Bearer "+process.argv[4],"Content-Type":"application/json"},body:JSON.stringify({name:"live_preview",arguments:{enabled:true,fps:2}})}).then(r=>r.json()).then(j=>{ if(!j.ok) console.error("live_preview failed", j) })
setTimeout(()=>{ console.log(n); process.exit(0) }, 2200)' "ws://localhost:3000/api/ws/viewer/$D?token=$T" "$U" "$D" "$T")
check live-on-with-viewer 'yes' "$([[ ${FRAMES:-0} -ge 1 ]] && echo yes || echo "no ($FRAMES frames)")"
check live-frames-to-viewer 'yes' "$([[ ${FRAMES:-0} -ge 2 ]] && echo yes || echo "no ($FRAMES frames)")"
check live-off '"streaming":false' "$(call '{"name":"live_preview","arguments":{"enabled":false}}')"
check live-invalid-fps 'yes' "$(call '{"name":"live_preview","arguments":{"enabled":false,"fps":99}}' | j '"yes" if d["ok"] else "no"')"

echo "== read-only scope"
RO=$(curl -s "${A[@]}" -d "{\"deviceId\":\"$D\",\"readOnly\":true}" $U/api/admin/tokens | j 'd["token"]')
check ro-ocr-ok 'SCORE' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"read_text"}' $U/api/devices/$D/tools/call)"
check ro-taptext-blocked 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"tap_text","arguments":{"text":"PLAY"}}' $U/api/devices/$D/tools/call)"
check ro-stats-ok '"successRate"' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"session_stats"}' $U/api/devices/$D/tools/call)"

echo "== bootstrap + phone.sh"
check bootstrap-ocr 'tap_text "PLAY"' "$(curl -s $U/agent/$T)"
export RELAY_URL=$U RELAY_TOKEN=$T RELAY_DEVICE=$D
check sh-ocr 'SCORE 1250' "$(bash agent/phone.sh ocr 2>&1)"
check sh-ocr-region '(3 lines)' "$(bash agent/phone.sh ocr 0,0,1080,2400 2>&1)"
check sh-taptext '"found": true' "$(bash agent/phone.sh taptext PLAY 2>&1)"
check sh-waittext '"found": true' "$(bash agent/phone.sh waittext SCORE appear 2000 2>&1)"
check sh-colors '"found": true' "$(bash agent/phone.sh colors '#ff0000,#00ff00' 2>&1)"
check sh-stats '"successRate"' "$(bash agent/phone.sh stats 2>&1)"
check sh-live '"streaming": false' "$(bash agent/phone.sh live off 2>&1)"

echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
