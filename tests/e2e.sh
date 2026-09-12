#!/usr/bin/env bash
# End-to-end test against a running relay + fake phone.
#   Terminal 1: npx wrangler dev --port 3000        (with .dev.vars RELAY_TOKEN=dev-secret-token-123)
#   Terminal 2: TTL_MS=600000 node tests/fake-phone.mjs ws://localhost:3000 dev-secret-token-123 test-phone
#   Terminal 3: tests/e2e.sh [URL] [ADMIN_TOKEN] [DEVICE]
set -u
U="${1:-http://localhost:3000}"; T="${2:-dev-secret-token-123}"; D="${3:-test-phone}"
A=(-H "Authorization: Bearer $T" -H "Content-Type: application/json")
pass=0; fail=0
check() { # name expected_substring actual
  if [[ "$3" == *"$2"* ]]; then echo "  ✔ $1"; pass=$((pass+1)); else echo "  ✘ $1  (expected '$2')"; echo "     got: ${3:0:300}"; fail=$((fail+1)); fi
}
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

echo "== health / me"
check health '"version":"4.8.0"' "$(curl -s $U/api/health)"
check me-admin '"role":"admin"' "$(curl -s "${A[@]}" $U/api/me)"
check unauth '401' "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer nope' $U/api/devices)"

echo "== basic tools"
check tap '"ok":true' "$(curl -s "${A[@]}" -d '{"name":"tap","arguments":{"x":540,"y":990}}' $U/api/devices/$D/tools/call)"
check ui 'btn_play' "$(curl -s "${A[@]}" -d '{"name":"get_ui_elements","arguments":{}}' $U/api/devices/$D/tools/call)"
check shot-png '"mime": "image/png"' "$(curl -s "${A[@]}" -d '{"name":"capture_screen","arguments":{}}' $U/api/devices/$D/tools/call | j 'json.dumps({"mime":d["image"]["mime"],"scale":d["image"]["scale"]})')"
curl -s "${A[@]}" -d '{"name":"capture_screen","arguments":{"maxWidth":1080,"format":"jpeg","quality":70}}' $U/api/devices/$D/tools/call >/dev/null
check shot-jpeg-opts '"maxWidth": 1080' "$(curl -s "${A[@]}" $U/api/devices/$D/logs | j 'json.dumps(d[0]["action"])')"
check shot-endpoint 'image/png' "$(curl -s -o /dev/null -w '%{content_type}' "${A[@]}" $U/api/devices/$D/screenshot.png)"
check last-shot '"data":"' "$(curl -s "${A[@]}" $U/api/devices/$D/last-screenshot | head -c 200)"

echo "== new tools"
check notifs 'OTP is 482913' "$(curl -s "${A[@]}" -d '{"name":"get_notifications","arguments":{"limit":5}}' $U/api/devices/$D/tools/call)"
check devinfo '"wifiSsid":"HomeNet"' "$(curl -s "${A[@]}" -d '{"name":"get_device_info"}' $U/api/devices/$D/tools/call)"
check clipboard '"pasted":true' "$(curl -s "${A[@]}" -d '{"name":"set_clipboard","arguments":{"text":"hello","paste":true}}' $U/api/devices/$D/tools/call)"
check drag '"ok":true' "$(curl -s "${A[@]}" -d '{"name":"drag","arguments":{"x1":100,"y1":100,"x2":500,"y2":500}}' $U/api/devices/$D/tools/call)"
check pinch '"ok":true' "$(curl -s "${A[@]}" -d '{"name":"pinch","arguments":{"x":540,"y":1200,"scale":2}}' $U/api/devices/$D/tools/call)"
check pinch-invalid 'requires numeric' "$(curl -s "${A[@]}" -d '{"name":"pinch","arguments":{"x":540}}' $U/api/devices/$D/tools/call)"
check scroll_el '"scrolled":true' "$(curl -s "${A[@]}" -d '{"name":"scroll_element","arguments":{"elementId":"list","direction":"forward"}}' $U/api/devices/$D/tools/call)"

echo "== batch"
B='{"name":"batch","arguments":{"steps":[{"name":"open_app","arguments":{"text":"Chrome"}},{"name":"wait_for_element","arguments":{"text":"PLAY","timeoutMs":2000}},{"name":"tap_element","arguments":{"text":"PLAY"}},{"name":"capture_screen"}]}}'
R=$(curl -s "${A[@]}" -d "$B" $U/api/devices/$D/tools/call)
check batch-ok '"ok":true' "$R"
check batch-4steps '"steps":4' "$R"
check batch-image '"mime":"image/png"' "$R"
R=$(curl -s "${A[@]}" -d '{"name":"batch","arguments":{"steps":[{"name":"tap_element","arguments":{"text":"NOPE"}},{"name":"press_home"}]}}' $U/api/devices/$D/tools/call)
check batch-stops '"steps":1' "$R"
R=$(curl -s "${A[@]}" -d '{"name":"batch","arguments":{"continueOnError":true,"steps":[{"name":"tap_element","arguments":{"text":"NOPE"}},{"name":"press_home"}]}}' $U/api/devices/$D/tools/call)
check batch-continue '"steps":2' "$R"
check batch-nested 'nested batch' "$(curl -s "${A[@]}" -d '{"name":"batch","arguments":{"steps":[{"name":"batch","arguments":{"steps":[]}}]}}' $U/api/devices/$D/tools/call)"

echo "== queue: 3 concurrent taps must serialize (fake tap = 300ms)"
t0=$(date +%s%N)
for i in 1 2 3; do curl -s "${A[@]}" -d "{\"name\":\"tap\",\"arguments\":{\"x\":$i,\"y\":$i}}" $U/api/devices/$D/tools/call > /tmp/q$i.json & done; wait
dt=$(( ($(date +%s%N) - t0) / 1000000 ))
queued=$(cat /tmp/q1.json /tmp/q2.json /tmp/q3.json | grep -o queuedMs | wc -l)
echo "  total ${dt}ms, responses with queuedMs: $queued"
check queue-serialized 'yes' "$([[ $dt -ge 850 && $queued -ge 2 ]] && echo yes || echo no)"
echo "== reads bypass queue: ui while tap in flight"
curl -s "${A[@]}" -d '{"name":"tap","arguments":{"x":1,"y":1}}' $U/api/devices/$D/tools/call > /dev/null &
sleep 0.05; t0=$(date +%s%N); curl -s "${A[@]}" -d '{"name":"get_ui_elements"}' $U/api/devices/$D/tools/call > /dev/null; dt=$(( ($(date +%s%N) - t0) / 1000000 )); wait
echo "  ui took ${dt}ms while tap in flight"
check read-bypass 'yes' "$([[ $dt -lt 250 ]] && echo yes || echo no)"

echo "== per-device tokens"
R=$(curl -s "${A[@]}" -d "{\"deviceId\":\"$D\",\"label\":\"tester\"}" $U/api/admin/tokens)
check token-create '"token":"dr_' "$R"
DT=$(echo "$R" | j 'd["token"]'); TID=$(echo "$R" | j 'd["id"]')
check token-agent-url "/agent/$DT" "$R"
RO=$(curl -s "${A[@]}" -d "{\"deviceId\":\"$D\",\"readOnly\":true}" $U/api/admin/tokens | j 'd["token"]')
OT=$(curl -s "${A[@]}" -d '{"deviceId":"other-phone"}' $U/api/admin/tokens | j 'd["token"]')
DA=(-H "Authorization: Bearer $DT" -H "Content-Type: application/json")
check dev-token-me "\"deviceId\":\"$D\"" "$(curl -s "${DA[@]}" $U/api/me)"
check dev-token-tap '"ok":true' "$(curl -s "${DA[@]}" -d '{"name":"tap","arguments":{"x":5,"y":5}}' $U/api/devices/$D/tools/call)"
check dev-token-scoped-list '1' "$(curl -s "${DA[@]}" $U/api/devices | j 'len(d["devices"])')"
check dev-token-no-admin '403' "$(curl -s -o /dev/null -w '%{http_code}' "${DA[@]}" $U/api/admin/tokens)"
check other-token-forbidden '403' "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $OT" -H 'Content-Type: application/json' -d '{"name":"tap","arguments":{"x":5,"y":5}}' $U/api/devices/$D/tools/call)"
check readonly-ui-ok '"ok":true' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"get_ui_elements"}' $U/api/devices/$D/tools/call)"
check readonly-tap-blocked 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"tap","arguments":{"x":5,"y":5}}' $U/api/devices/$D/tools/call)"
check readonly-batch-blocked 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"batch","arguments":{"steps":[{"name":"press_home"}]}}' $U/api/devices/$D/tools/call)"
check agent-bootstrap-devtoken 'scoped to ONE device' "$(curl -s $U/agent/$DT | head -c 4000)"
check agent-bootstrap-admin 'ADMIN token' "$(curl -s $U/agent/$T | head -c 4000)"
check monitor-page 'Live Monitor' "$(curl -s $U/monitor/$DT | head -c 600)"
check monitor-unauth '401' "$(curl -s -o /dev/null -w '%{http_code}' $U/monitor/bad)"
check mcp-devtoken 'tools' "$(curl -s -X POST $U/mcp/$DT -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 100)"
check mcp-call '\"ok\":true' "$(curl -s -X POST $U/mcp/$DT -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"press_home","arguments":{}}}')"
check token-list "\"id\":\"$TID\"" "$(curl -s "${A[@]}" $U/api/admin/tokens)"
check token-revoke '"ok":true' "$(curl -s -X DELETE "${A[@]}" $U/api/admin/tokens/$TID)"
check token-revoked '401' "$(curl -s -o /dev/null -w '%{http_code}' "${DA[@]}" $U/api/me)"
check label '"ok":true' "$(curl -s "${A[@]}" -d '{"label":"Office Pixel"}' $U/api/admin/devices/$D/label)"
check label-shows 'Office Pixel' "$(curl -s "${A[@]}" $U/api/devices/$D)"

echo "== macro continueOnError"
check macro-cont '"action":"home","id":"' "$(curl -s "${A[@]}" -d '{"continueOnError":true,"steps":[{"type":"tap_element","text":"NOPE"},{"type":"home"}]}' $U/api/devices/$D/macro)"

echo "== schema"
check schema-count '84' "$(curl -s "$U/api/tools/schema?format=raw" | j 'len(d)')"
check openapi-logs 'yes' "$(curl -s "$U/api/tools/schema?format=openapi" | j '"yes" if "/api/devices/{deviceId}/logs" in d["paths"] else "no"')"

echo "== rate limit (130 fast requests on the read-only token)"
codes=$(for i in $(seq 1 130); do curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $RO" $U/api/me & done; wait)
check rate-limited '429' "$(echo "$codes" | sort | uniq -c | tr '\n' ' ')"

echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
