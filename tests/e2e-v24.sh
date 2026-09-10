#!/usr/bin/env bash
# v2.4 test: session_report + bestScore, profile-aware observe, game_profile verify, bootstrap progress. Requires relay + fake-phone.
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
call '{"name":"get_current_app"}' >/dev/null

echo "== version"
check version '"version":"4.7.0"' "$(curl -s $U/api/health)"
check tools-83 '83' "$(curl -s "$U/api/tools/schema?format=raw" | j 'len(d)')"

echo "== observe without profile"
check observe-nogame 'False' "$(call '{"name":"observe","arguments":{"image":false,"diff":false}}' | j '"game" in d')"

echo "== profile-aware observe"
call '{"name":"game_profile","arguments":{"label":"Space Runner","set":{"controls":{"jump":{"x":950,"y":2100}},"colors":{"enemy":{"hex":"#ff0000"},"ghost":{"hex":"#123456"}},"regions":{"score":{"x":0,"y":0,"w":500,"h":200},"art":{"x":0,"y":0,"w":10,"h":10}}}}}' >/dev/null
R=$(call '{"name":"observe","arguments":{"image":false,"diff":false}}')
check obs-game-app '"game":{"app":"com.example.spacerunner"' "$R"
check obs-objects-enemy '"@enemy":{"count":3,"objects":[{"cx":540,"cy":1500,"area":8000}' "$R"
check obs-objects-ghost '"@ghost":{"count":0' "$R"
check obs-values '"values":{"@score":1250}' "$R"
check obs-values-skips-nonnumeric 'False' "$(echo "$R" | j '"@art" in d["game"].get("values",{})')"
check obs-profile-off 'False' "$(call '{"name":"observe","arguments":{"image":false,"diff":false,"profile":false}}' | j '"game" in d')"

echo "== session_report"
check report-needs-summary 'requires summary' "$(call '{"name":"session_report","arguments":{"summary":" "}}')"
R=$(call '{"name":"session_report","arguments":{"summary":"Reached level 3","outcome":"progress","score":1250,"level":"3","learned":["ads after 2 runs"],"nextTime":"use auto_react on @enemy","blockers":["login wall"]}}')
check report-ok '"ok":true' "$R"
check report-app '"app":"com.example.spacerunner"' "$R"
check report-best '"bestScore":1250' "$R"
check report-newbest '"newBest":true' "$R"
check report-hint 'NEW BEST SCORE' "$R"
check report-fields '"learned":["ads after 2 runs"]' "$R"
R=$(call '{"name":"session_report","arguments":{"summary":"worse run","outcome":"loss","score":900}}')
check report-not-best '"newBest":false' "$R"
check report-best-kept '"bestScore":1250' "$R"
check report-count '"reports":2' "$R"
check report-bad-outcome 'False' "$(call '{"name":"session_report","arguments":{"summary":"x","outcome":"weird"}}' | j '"outcome" in d["report"]')"
check report-explicit-app '"app":"com.other.game"' "$(call '{"name":"session_report","arguments":{"summary":"other","app":"com.other.game","score":5}}')"

echo "== profile carries progress"
R=$(call '{"name":"game_profile","arguments":{"history":true}}')
check prof-best '"bestScore":1250' "$R"
check prof-lastreport '"lastReport":{"ts":' "$R"
check prof-reports 'True' "$(echo "$R" | j 'd["profile"]["reports"] >= 3')"
check prof-history-report 'True' "$(echo "$R" | j 'd["history"][0].get("summary")=="x"')"   # latest report on the open session wins
check prof-history-summary '"summary":"' "$R"

echo "== verify"
R=$(call '{"name":"game_profile","arguments":{"verify":true}}')
check verify-present '"@enemy":{"present":true,"count":1200}' "$R"
check verify-absent '"@ghost":{"present":false' "$R"
check verify-region '"@score":{"ok":true,"lines":3' "$R"
check verify-stale '"stale":["@ghost (#123456) not on screen right now"]' "$R"
check verify-verdict 'look stale' "$R"
call '{"name":"game_profile","arguments":{"unset":{"colors":["ghost"]},"set":{"controls":{"off":{"x":5000,"y":5000}}}}}' >/dev/null
R=$(call '{"name":"game_profile","arguments":{"verify":true}}')
check verify-offscreen '"controlsOffScreen":["@off"]' "$R"
call '{"name":"game_profile","arguments":{"unset":{"controls":["off"]}}}' >/dev/null
check verify-clean 'profile consistent' "$(call '{"name":"game_profile","arguments":{"verify":true}}')"

echo "== memory / sessions carry reports"
M=$(mem '')
check mem-session-report 'True' "$(echo "$M" | j 'any(s.get("report") for s in d["sessions"])')"
check mem-group-best 'True' "$(echo "$M" | j 'any(g.get("profile",{}) and g["profile"].get("bestScore")==1250 for g in d["groups"])')"
check mem-other-session 'True' "$(echo "$M" | j 'any(s["app"]=="com.other.game" and s.get("report",{}).get("score")==5 for s in d["sessions"])')"

echo "== bootstrap"
call '{"name":"session_report","arguments":{"summary":"final run of the day","outcome":"progress","score":1100,"nextTime":"start with auto_react"}}' >/dev/null
B=$(curl -s $U/agent/$T)
check bs-progress 'progress: best score 1250' "$B"
check bs-lastsession 'last session (' "$B"
check bs-nexttime 'NEXT TIME:' "$B"
check bs-finish 'When you finish (or get stuck):  session_report' "$B"
check bs-rule0 'END of every session: session_report' "$B"
check bs-5g-report '→ ' "$B"
check bs-profile-aware 'observe is PROFILE-AWARE' "$B"

echo "== viewer gets report event"
node -e '
const WebSocket = require("ws");
const ws = new WebSocket(process.argv[1].replace("http","ws") + "/api/ws/viewer/" + process.argv[3] + "?token=" + process.argv[2]);
let got = null;
ws.on("message", (b) => { const m = JSON.parse(b); if (m.kind === "report") got = m });
ws.on("open", async () => {
  await new Promise(r => setTimeout(r, 300));
  await fetch(process.argv[1] + "/api/devices/" + process.argv[3] + "/tools/call", { method: "POST", headers: { Authorization: "Bearer " + process.argv[2], "Content-Type": "application/json" }, body: JSON.stringify({ name: "session_report", arguments: { summary: "viewer test", score: 99999 } }) });
  await new Promise(r => setTimeout(r, 500));
  console.log(JSON.stringify(got)); ws.close(); process.exit(0);
});
setTimeout(() => { console.log("null"); process.exit(1) }, 15000);
' "$U" "$T" "$D" > /tmp/v24-viewer.json 2>/dev/null || echo 'null' > /tmp/v24-viewer.json
check viewer-report '"kind":"report"' "$(cat /tmp/v24-viewer.json)"
check viewer-newbest '"newBest":true' "$(cat /tmp/v24-viewer.json)"

echo "== read-only + setup + phone.sh"
RO=$(curl -s "${A[@]}" -d '{"deviceId":"test-phone","label":"ro24","readOnly":true}' $U/api/admin/tokens | j 'd["token"]')
check ro-report-denied 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"session_report","arguments":{"summary":"x"}}' $U/api/devices/$D/tools/call)"
check ro-observe-game '"game":{' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"observe","arguments":{"image":false}}' $U/api/devices/$D/tools/call)"
check setup-best 'أفضل نتيجة' "$(curl -s $U/setup/$T)"
cd /tmp
check sh-report '"newBest": false' "$(bash $P report "sh run" progress 10 "try harder" 2>&1)"
check sh-verify 'profile consistent' "$(bash $P verify 2>&1)"
check sh-verify-lines '@enemy         present n=1200' "$(bash $P verify 2>&1)"
check sh-sessions 'Space Runner' "$(bash $P sessions 3 2>&1)"
cd - >/dev/null

memdel 'kind=all' >/dev/null
call '{"name":"open_recents"}' >/dev/null
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
