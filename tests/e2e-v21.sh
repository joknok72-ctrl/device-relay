#!/usr/bin/env bash
# v2.1 test: sample_colors / track_object / read_number / watch_value / calibrate. Requires relay + fake-phone.
set -u
U="${1:-http://localhost:3000}"; T="${2:-dev-secret-token-123}"; D="${3:-test-phone}"
A=(-H "Authorization: Bearer $T" -H "Content-Type: application/json")
pass=0; fail=0
check() { if [[ "$3" == *"$2"* ]]; then echo "  ✔ $1"; pass=$((pass+1)); else echo "  ✘ $1  (expected '$2')"; echo "     got: ${3:0:300}"; fail=$((fail+1)); fi; }
call() { curl -s "${A[@]}" -d "$1" $U/api/devices/$D/tools/call; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
export RELAY_URL=$U RELAY_TOKEN=$T RELAY_DEVICE=$D
P=/home/user/webapp/agent/phone.sh
call '{"name":"open_recents"}' >/dev/null

echo "== version / catalogue"
check version '"version":"4.7.5"' "$(curl -s $U/api/health)"
check tools-83 '84' "$(curl -s "$U/api/tools/schema?format=raw" | j 'len(d)')"
check bootstrap-v21 'sample_colors [region]' "$(curl -s $U/agent/$T)"
check bootstrap-guide 'New game → sample_colors' "$(curl -s $U/agent/$T)"

echo "== sample_colors"
R=$(call '{"name":"sample_colors"}')
check palette-ok '"ok":true' "$R"
check palette-first '"colors":[{"hex":"#ff0000","share":41.2' "$R"
check palette-max '2' "$(call '{"name":"sample_colors","arguments":{"maxColors":2}}' | j 'len(d["data"]["colors"])')"
check palette-region '"region":{"x":0,"y":0,"w":100,"h":100}' "$(call '{"name":"sample_colors","arguments":{"region":{"x":0,"y":0,"w":100,"h":100}}}')"
check palette-clamp-max '24' "$(curl -s "${A[@]}" -d '{"action":{"type":"sample_colors","maxColors":99}}' $U/api/devices/$D/command >/dev/null; curl -s "${A[@]}" $U/api/devices/$D/logs | j '[l["action"]["maxColors"] for l in d if l["action"]["type"]=="sample_colors"][0]')"
check sh-palette '#ff0000   41.2%  at ( 540,1500)' "$(bash $P palette 2>&1)"

echo "== track_object"
R=$(call '{"name":"track_object","arguments":{"color":"#ff0000","samples":5,"intervalMs":100,"predictMs":500}}')
check track-found '"found":true' "$R"
check track-vx '"vx":240' "$R"
check track-dir '"direction":"right"' "$R"
check track-predict '"predicted":{"x":756,"y":1500,"inMs":500}' "$R"
check track-samples '5' "$(echo "$R" | j 'len(d["data"]["samples"])')"
check track-miss '"found":false' "$(call '{"name":"track_object","arguments":{"color":"#0000ff"}}')"
check track-badcolor 'requires color' "$(call '{"name":"track_object","arguments":{"color":"blue"}}')"
check track-in-loop '"cx":756' "$(call '{"name":"game_loop","arguments":{"when":{"name":"track_object","arguments":{"color":"#ff0000","intervalMs":100,"predictMs":500}},"then":{"name":"tap","arguments":{"x":"$cx","y":"$cy"}},"iterations":1}}')"
check sh-track '"direction": "right"' "$(bash $P track '#ff0000' 2>&1)"

echo "== read_number"
R=$(call '{"name":"read_number"}')
check num-first '"value":1250' "$R"
check num-raw '"raw":"SCORE 1250"' "$R"
check num-line '"line":{"cx":190,"cy":90}' "$R"
check num-label '"value":1250' "$(call '{"name":"read_number","arguments":{"label":"score"}}')"
check num-label-miss 'not found on screen' "$(call '{"name":"read_number","arguments":{"label":"coins"}}')"
check num-candidates '"candidates":1' "$R"
check num-index-clamp '"value":1250' "$(call '{"name":"read_number","arguments":{"index":9}}')"
check sh-num '"value": 1250' "$(bash $P num 2>&1)"
check sh-num-label '"value": 1250' "$(bash $P num '' score 2>&1)"

echo "== watch_value"
R=$(call '{"name":"watch_value","arguments":{"condition":"above","value":1000}}')
check watch-already '"alreadyTrue":true' "$R"
check watch-from '"from":1250' "$R"
check watch-below-timeout 'did not satisfy' "$(call '{"name":"watch_value","arguments":{"condition":"below","value":10,"timeoutMs":900,"intervalMs":300}}')"
check watch-change-timeout '"matched":false' "$(call '{"name":"watch_value","arguments":{"condition":"change","timeoutMs":900,"intervalMs":300}}')"
check watch-equals '"matched":true' "$(call '{"name":"watch_value","arguments":{"condition":"equals","value":1250}}')"
check watch-badcond 'condition must be' "$(call '{"name":"watch_value","arguments":{"condition":"weird"}}')"
check watch-needs-value 'requires value' "$(call '{"name":"watch_value","arguments":{"condition":"above"}}')"
check watch-as-until '"matched":true' "$(call '{"name":"do_until","arguments":{"action":{"name":"press_back"},"until":{"name":"watch_value","arguments":{"condition":"above","value":5}},"maxTries":1}}')"
check sh-watchnum '"alreadyTrue": true' "$(bash $P watchnum above 5 2>&1)"

echo "== calibrate"
R=$(call '{"name":"calibrate","arguments":{"x":540,"y":990,"timeoutMs":1500}}')
check calib-ok '"ok":true' "$R"
check calib-changed '"changed":' "$R"
check calib-tapped '"tapped":{"x":540,"y":990}' "$R"
check calib-hint '"hint":' "$R"
check calib-missing 'requires x, y' "$(call '{"name":"calibrate","arguments":{"x":1}}')"
check sh-calib '"tapped"' "$(bash $P calib 540 990 2>&1)"

echo "== read-only scope"
RO=$(curl -s "${A[@]}" -d '{"deviceId":"test-phone","label":"ro21","readOnly":true}' $U/api/admin/tokens | j 'd["token"]')
check ro-palette '"colors"' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"sample_colors"}' $U/api/devices/$D/tools/call)"
check ro-num '"value":1250' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"read_number"}' $U/api/devices/$D/tools/call)"
check ro-track '"found"' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"track_object","arguments":{"color":"#ff0000"}}' $U/api/devices/$D/tools/call)"
check ro-calib-denied 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"calibrate","arguments":{"x":1,"y":1}}' $U/api/devices/$D/tools/call)"

echo "== viewer overlays for v2.1"
node -e '
const WebSocket = require("ws");
const ws = new WebSocket(process.argv[1].replace("http","ws") + "/api/ws/viewer/" + process.argv[3] + "?token=" + process.argv[2]);
const got = [];
ws.on("message", (b) => { const m = JSON.parse(b); if (m.kind === "overlay") got.push(m.type + (m.color ? ":" + m.color : "")) });
ws.on("open", async () => {
  const call = (body) => fetch(process.argv[1] + "/api/devices/" + process.argv[3] + "/tools/call", { method: "POST", headers: { Authorization: "Bearer " + process.argv[2], "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await new Promise(r => setTimeout(r, 300));
  await call({ name: "track_object", arguments: { color: "#ff0000" } });
  await call({ name: "sample_colors" });
  await new Promise(r => setTimeout(r, 500));
  console.log(JSON.stringify(got.sort())); ws.close(); process.exit(0);
});
setTimeout(() => { console.log("timeout"); process.exit(1) }, 15000);
' "$U" "$T" "$D" > /tmp/v21-viewer.json 2>/dev/null || echo '[]' > /tmp/v21-viewer.json
check viewer-track-path '"path:#ff0000"' "$(cat /tmp/v21-viewer.json)"
check viewer-palette-detect '"detect"' "$(cat /tmp/v21-viewer.json)"

call '{"name":"open_recents"}' >/dev/null
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
