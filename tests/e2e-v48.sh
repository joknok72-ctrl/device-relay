#!/usr/bin/env bash
# v4.8 auto-live monitor: a viewer socket opened with ?live=1 makes the relay start the phone stream by itself,
# and the relay stops it when the last live viewer leaves. Needs the fake phone + relay on :3000.
set -u
U="${RELAY_URL:-http://localhost:3000}"; T="${RELAY_TOKEN:-dev-secret-token-123}"; D="${1:-test-phone}"
pass=0; fail=0
check() { if [[ "$3" == *"$2"* ]]; then echo "  ✔ $1"; pass=$((pass+1)); else echo "  ✘ $1  (expected '$2')"; echo "     got: ${3:0:240}"; fail=$((fail+1)); fi; }
probe() { # live(0|1) seconds -> prints frames=N ... plus streaming state after close
  node - "$U" "$T" "$D" "$1" "$2" <<'EOF'
const WebSocket = require("ws");
const [url, token, dev, live, secs] = process.argv.slice(2);
const ws = new WebSocket(url.replace(/^http/, "ws") + `/api/ws/viewer/${dev}?token=${encodeURIComponent(token)}${live === "1" ? "&live=1&fps=2&maxWidth=300" : ""}`, { headers: { "User-Agent": "dr-agent" } });
let frames = 0, autoLive = null;
ws.on("message", m => { const j = JSON.parse(m); if (j.kind === "frame") frames++; if (j.kind === "snapshot") autoLive = j.autoLive; });
ws.on("error", e => { console.log("ERR", e.message); process.exit(1); });
setTimeout(() => { ws.close(); setTimeout(() => { console.log(`frames=${frames} autoLive=${autoLive}`); process.exit(0); }, 300); }, Number(secs) * 1000);
EOF
}
echo "== v4.8 auto-live"
R=$(probe 1 3); check "live viewer receives frames without live_preview" "autoLive=true" "$R"
N=$(echo "$R" | sed -n 's/.*frames=\([0-9]*\).*/\1/p'); [[ "${N:-0}" -ge 2 ]] && { echo "  ✔ got $N frames in 3s"; pass=$((pass+1)); } || { echo "  ✘ expected >=2 frames, got $N"; fail=$((fail+1)); }
sleep 1
# after the live viewer closed, the phone must have been told to stop → a passive viewer sees no frames
R=$(probe 0 2); check "passive viewer gets autoLive=false" "autoLive=false" "$R"
N=$(echo "$R" | sed -n 's/.*frames=\([0-9]*\).*/\1/p'); [[ "${N:-0}" -eq 0 ]] && { echo "  ✔ stream stopped after last live viewer left (0 frames)"; pass=$((pass+1)); } || { echo "  ✘ stream still running: $N frames"; fail=$((fail+1)); }
# manual live_preview API still works (AI-driven)
R=$(curl -s -A dr-agent -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"enabled":false}' $U/api/devices/$D/tools/live_preview); check "live_preview off still ok" '"streaming":false' "$R"
# monitor page carries the v4.8 UI
R=$(curl -s -A dr-agent $U/monitor/$T); check "monitor has watch mode" 'watch-btn' "$R"; check "monitor connects with live=1" 'live=1&fps=' "$R"
echo "v48 PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
