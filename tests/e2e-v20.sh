#!/usr/bin/env bash
# v2.0 test: auto_react lanes/swipe/stopColor, record_macro, overlay + recording events to viewers. Requires relay + fake-phone.
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
check version '"version":"2.3.0"' "$(curl -s $U/api/health)"
check tools-72 '72' "$(curl -s "$U/api/tools/schema?format=raw" | j 'len(d)')"
check bootstrap-rec 'record_macro start=true' "$(curl -s $U/agent/$T)"
check bootstrap-lanes 'auto_react lanes=' "$(curl -s $U/agent/$T)"

echo "== auto_react v2 (lanes / swipe / stopColor)"
R=$(call '{"name":"auto_react","arguments":{"color":"#ff0000","maxTriggers":4,"lanes":[{"name":"L","color":"#00ff00","tapX":100,"tapY":2000},{"color":"#0000ff"}]}}')
check lanes-triggers '"triggers":4' "$R"
check lanes-lane1 '"lane":1,"name":"L"' "$R"
check lanes-lane1-pos '"x":100,"y":2000' "$R"
check lanes-count '"lanes":3' "$R"
check lanes-swipe '"swipe":true' "$(call '{"name":"auto_react","arguments":{"color":"#0000ff","maxTriggers":1,"lanes":[{"color":"#ff0000","swipe":{"dx":0,"dy":-600}}]}}')"
check lanes-swipe-target '"x2":540,"y2":900' "$(call '{"name":"auto_react","arguments":{"color":"#0000ff","maxTriggers":1,"lanes":[{"color":"#ff0000","swipe":{"dx":0,"dy":-600}}]}}')"
check stopcolor '"stoppedBy":"stopColor"' "$(call '{"name":"auto_react","arguments":{"color":"#ff0000","stopColor":"#00ff00"}}')"
check stopcolor-nomatch '"stoppedBy":"maxTriggers"' "$(call '{"name":"auto_react","arguments":{"color":"#ff0000","maxTriggers":2,"stopColor":"#123456"}}')"
check lanes-toomany 'at most 6 lanes' "$(call '{"name":"auto_react","arguments":{"color":"#ff0000","lanes":[{"color":"#1"},{"color":"#2"},{"color":"#3"},{"color":"#4"},{"color":"#5"},{"color":"#6"},{"color":"#7"}]}}')"
check lanes-badcolor 'lanes[0].color must be' "$(call '{"name":"auto_react","arguments":{"color":"#ff0000","lanes":[{"color":"red"}]}}')"
check lanes-badswipe 'swipe needs dx, dy' "$(call '{"name":"auto_react","arguments":{"color":"#ff0000","lanes":[{"color":"#00ff00","swipe":{"dx":1}}]}}')"
check stopcolor-bad 'stopColor must be' "$(call '{"name":"auto_react","arguments":{"color":"#ff0000","stopColor":"x"}}')"
check sh-react2 '"triggers": 2' "$(bash $P react2 '{"color":"#ff0000","maxTriggers":2}' 2>&1)"

echo "== record_macro"
call '{"name":"record_macro","arguments":{"cancel":true}}' >/dev/null
call '{"name":"list_macros","arguments":{"delete":"login"}}' >/dev/null
check rec-nothing 'not recording' "$(call '{"name":"record_macro","arguments":{"start":false}}')"
check rec-status-idle '"recording":false' "$(call '{"name":"record_macro","arguments":{"status":true}}')"
check rec-badargs 'needs start=true' "$(call '{"name":"record_macro"}')"
check rec-start '"recording":true' "$(call '{"name":"record_macro","arguments":{"start":true,"name":"login","description":"log in"}}')"
check rec-double 'already recording' "$(call '{"name":"record_macro","arguments":{"start":true,"name":"x"}}')"
call '{"name":"tap","arguments":{"x":540,"y":990}}' >/dev/null
sleep 0.5
call '{"name":"smart_tap","arguments":{"text":"PLAY","verify":false}}' >/dev/null
call '{"name":"type_text","arguments":{"text":"hi"}}' >/dev/null
call '{"name":"capture_screen"}' >/dev/null
call '{"name":"dismiss_popups"}' >/dev/null
call '{"name":"observe","arguments":{"image":false}}' >/dev/null
call '{"name":"press_back"}' >/dev/null
R=$(call '{"name":"record_macro","arguments":{"status":true}}')
check rec-status-active '"recording":true' "$R"
check rec-steps 'tap,wait,smart_tap,type_text,press_back' "$(echo "$R" | j '",".join(s["name"] for s in d["draft"]["steps"] if s["name"] != "wait" or d["draft"]["steps"].index(s) == 1)')"
check rec-wait-ms 'True' "$(echo "$R" | j '300 <= d["draft"]["steps"][1]["arguments"]["ms"] <= 5000')"
check rec-args '"x":540,"y":990' "$R"
R=$(call '{"name":"record_macro","arguments":{"start":false}}')
check rec-saved '"saved":"login"' "$R"
check rec-saved-steps 'True' "$(echo "$R" | j '5 <= d["steps"] <= 9')"
check rec-listed '"name":"login"' "$(call '{"name":"list_macros"}')"
check rec-replay '"macro":"login"' "$(call '{"name":"run_macro","arguments":{"name":"login"}}')"
check rec-replay-ok '"ok":true' "$(call '{"name":"run_macro","arguments":{"name":"login"}}')"
check rec-idle-after '"recording":false' "$(call '{"name":"record_macro","arguments":{"status":true}}')"
check rec-noname 'name required' "$(call '{"name":"record_macro","arguments":{"start":true}}' >/dev/null; call '{"name":"tap","arguments":{"x":1,"y":1}}' >/dev/null; call '{"name":"record_macro","arguments":{"start":false}}')"
check rec-cancel '"cancelled":true' "$(call '{"name":"record_macro","arguments":{"cancel":true}}')"
check rec-empty-discard 'nothing was recorded' "$(call '{"name":"record_macro","arguments":{"start":true,"name":"e"}}' >/dev/null; call '{"name":"record_macro","arguments":{"start":false}}')"
check rec-nested-not-recorded 'tap' "$(call '{"name":"record_macro","arguments":{"start":true,"name":"n"}}' >/dev/null; call '{"name":"tap_color","arguments":{"color":"#ff0000"}}' >/dev/null; call '{"name":"tap","arguments":{"x":5,"y":5}}' >/dev/null; call '{"name":"record_macro","arguments":{"status":true}}' | j '",".join(s["name"] for s in d["draft"]["steps"])')"
call '{"name":"record_macro","arguments":{"cancel":true}}' >/dev/null
call '{"name":"list_macros","arguments":{"delete":"login"}}' >/dev/null

echo "== phone.sh rec"
cd /tmp
check sh-rec-start '"recording": true' "$(bash $P rec start shrec 2>&1)"
bash $P tap 10 10 >/dev/null 2>&1
check sh-rec-status '"name": "tap"' "$(bash $P rec status 2>&1)"
check sh-rec-stop '"saved": "shrec"' "$(bash $P rec stop 2>&1)"
check sh-rec-cancel-idle '"cancelled": false' "$(bash $P rec cancel 2>&1)"
cd - >/dev/null
call '{"name":"list_macros","arguments":{"delete":"shrec"}}' >/dev/null

echo "== viewer receives overlay + recording events"
node -e '
const WebSocket = require("ws");
const ws = new WebSocket(process.argv[1].replace("http","ws") + "/api/ws/viewer/" + process.argv[3] + "?token=" + process.argv[2]);
const got = new Set(); let snapshotRec = null;
ws.on("message", (b) => { const m = JSON.parse(b); if (m.kind === "overlay") got.add(m.type); if (m.kind === "recording") got.add("recording:" + m.active); if (m.kind === "snapshot") snapshotRec = m.recording });
ws.on("open", async () => {
  const call = (body) => fetch(process.argv[1] + "/api/devices/" + process.argv[3] + "/tools/call", { method: "POST", headers: { Authorization: "Bearer " + process.argv[2], "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await new Promise(r => setTimeout(r, 300));
  await call({ name: "tap", arguments: { x: 1, y: 2 } });
  await call({ name: "swipe", arguments: { x1: 1, y1: 2, x2: 3, y2: 4 } });
  await call({ name: "find_objects", arguments: { color: "#ff0000" } });
  await call({ name: "read_text" });
  await call({ name: "identify_screen" });
  await call({ name: "record_macro", arguments: { start: true, name: "v" } });
  await call({ name: "record_macro", arguments: { cancel: true } });
  await new Promise(r => setTimeout(r, 500));
  console.log(JSON.stringify({ overlays: [...got].sort(), snapshotRec }));
  ws.close(); process.exit(0);
});
setTimeout(() => { console.log("timeout"); process.exit(1) }, 15000);
' "$U" "$T" "$D" > /tmp/v20-viewer.json 2>/dev/null || echo '{"overlays":[]}' > /tmp/v20-viewer.json
V=$(cat /tmp/v20-viewer.json)
check viewer-tap '"tap"' "$V"
check viewer-swipe '"swipe"' "$V"
check viewer-detect '"detect"' "$V"
check viewer-ocr '"ocr"' "$V"
check viewer-screen '"screen"' "$V"
check viewer-rec-on '"recording:true"' "$V"
check viewer-rec-off '"recording:false"' "$V"
check viewer-snapshot-rec '"snapshotRec":{"active":false}' "$V"

echo "== monitor page"
check monitor-canvas 'overlay-canvas' "$(curl -s $U/monitor/$T)"
check monitor-rec-badge 'rec-badge' "$(curl -s $U/monitor/$T)"

call '{"name":"open_recents"}' >/dev/null  # restore fake phone to menu screen
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
