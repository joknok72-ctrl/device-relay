#!/usr/bin/env bash
# v4.4 test: learned strategies — play_loop scores runs, stores per-game top-5, strategy:"best" replay, bootstrap shows them.
set -u
U="${1:-http://localhost:3000}"; T="${2:-dev-secret-token-123}"; D="${3:-test-phone}"
A=(-H "Authorization: Bearer $T" -H "Content-Type: application/json")
pass=0; fail=0
check() { if [[ "$3" == *"$2"* ]]; then echo "  ✔ $1"; pass=$((pass+1)); else echo "  ✘ $1  (expected '$2')"; echo "     got: ${3:0:300}"; fail=$((fail+1)); fi; }
call() { curl -s "${A[@]}" -d "$1" $U/api/devices/$D/tools/call; }
memdel() { curl -s -X DELETE "${A[@]}" "$U/api/admin/devices/$D/memory?$1"; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
call '{"name":"open_recents"}' >/dev/null
memdel 'kind=all' >/dev/null
call '{"name":"get_current_app"}' >/dev/null
call '{"name":"game_profile","arguments":{"delete":true}}' >/dev/null

echo "== version"
check version '"version":"4.8.0"' "$(curl -s $U/api/health)"
check tools-83 '85' "$(curl -s "$U/api/tools/schema?format=raw" | j 'len(d)')"
check schema-strategy 'strategy' "$(curl -s "$U/api/tools/schema?format=raw" | j '"strategy" if "strategy" in [t for t in d if t["name"]=="play_loop"][0]["parameters"]["properties"] else "no"')"

echo "== no strategies yet"
check none-yet 'no learned strategies for this game yet' "$(call '{"name":"play_loop","arguments":{"strategy":"best"}}')"

echo "== run A (scoring: moving world hook 12 → score +10/tick)"
call '{"name":"game_profile","arguments":{"set":{"colors":{"enemy":{"hex":"#ff0000"}},"regions":{"score":{"x":0,"y":0,"w":400,"h":150}}}}}' >/dev/null
R=$(call '{"name":"play_loop","arguments":{"name":"A","ticks":4,"quality":12,"reset":true,"waitMs":0,"policy":[{"name":"idle","if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}]}}')
check a-ok '"ok":true' "$R"
check a-learned '"learned":{"name":"A"' "$R"
check a-gained '"gained":30' "$R"
check a-runs '"runs":1' "$R"
check a-rank '"rank":1,"of":1' "$R"
check a-fitness '"fitness":' "$R"
check a-died-false '"died":false' "$R"

echo "== run B (worse: static hook 11 → no gain) ranks below A"
R=$(call '{"name":"play_loop","arguments":{"name":"B","ticks":3,"quality":11,"reset":true,"waitMs":0,"autoMenu":false,"policy":[{"name":"tapmid","if":{"everyTicks":1},"do":[{"op":"tap","x":540,"y":1200}]}]}}')
check b-learned '"learned":{"name":"B"' "$R"
check b-rank '"rank":2,"of":2' "$R"
check b-hint 'ranks #2/2' "$R"

echo "== run A again → runs 2, same strategy (dedupe by policy)"
R=$(call '{"name":"play_loop","arguments":{"ticks":3,"quality":12,"reset":true,"waitMs":0,"policy":[{"name":"idle","if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}]}}')
check a2-runs '"runs":2' "$R"
check a2-name '"name":"A"' "$R"

echo "== profile shows strategies"
P=$(call '{"name":"game_profile"}')
check prof-strats '"strategies":[{"name":"A"' "$P"
check prof-two '2' "$(echo "$P" | j 'len(d["profile"]["strategies"])')"
check prof-order 'A,B' "$(echo "$P" | j '",".join(s["name"] for s in d["profile"]["strategies"])')"

echo "== replay strategy best / by name / unknown"
R=$(call '{"name":"play_loop","arguments":{"strategy":"best","ticks":2,"quality":12,"waitMs":0}}')
check best-ok '"ok":true' "$R"
check best-fires '"idle":' "$R"
check best-runs '"runs":3' "$R"
R=$(call '{"name":"play_loop","arguments":{"strategy":"B","ticks":2,"quality":11,"waitMs":0,"autoMenu":false}}')
check byname-fires '"tapmid":' "$R"
check unknown-strat "no strategy 'Z' (known: A f=" "$(call '{"name":"play_loop","arguments":{"strategy":"Z"}}')"

echo "== learn:false does not record; death counted on game_over stop"
R=$(call '{"name":"play_loop","arguments":{"learn":false,"name":"C","ticks":2,"waitMs":0,"policy":[{"if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}]}}')
check nolearn 'nolearn' "$(echo "$R" | j '"nolearn" if "learned" not in d else "HAS"')"
check still-two '2' "$(call '{"name":"game_profile"}' | j 'len(d["profile"]["strategies"])')"
R=$(call '{"name":"play_loop","arguments":{"name":"D","ticks":4,"quality":13,"reset":true,"waitMs":0,"ocr":[{"name":"hp","region":{"x":0,"y":2200,"w":300,"h":100},"number":true}],"policy":[{"if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}],"stopOn":{"valueBelow":{"name":"hp","value":95}}}}')
check d-died '"died":true' "$R"
check d-stopped '"stoppedBy":"hp<95"' "$R"

echo "== bootstrap / quick start"
BS=$(curl -s $U/agent/$T)
check bs-strats 'strategies (learned autopilot policies, best first)' "$BS"
check bs-best 'play_loop {strategy:"best"}' "$BS"
check bs-learning 'v4.4 LEARNING' "$BS"

call '{"name":"game_profile","arguments":{"delete":true}}' >/dev/null
memdel 'kind=all' >/dev/null
call '{"name":"open_recents"}' >/dev/null
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
