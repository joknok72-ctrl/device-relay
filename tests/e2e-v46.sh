#!/usr/bin/env bash
# v4.6 test: play_loop self-critique (rules good/bad, advice, judge), explore rotation, hybrid reflex rules, auto session_report.
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
call '{"name":"finger","arguments":{"op":"up","finger":-1}}' >/dev/null

echo "== version"
check version '"version":"4.7.0"' "$(curl -s $U/api/health)"
check schema-explore 'explore' "$(curl -s "$U/api/tools/schema?format=raw" | j '"explore" if "explore" in [t for t in d if t["name"]=="play_loop"][0]["parameters"]["properties"] else "no"')"

echo "== self-critique: good rule (score rises each tick, hook 12)"
call '{"name":"game_profile","arguments":{"set":{"colors":{"enemy":{"hex":"#ff0000"}},"regions":{"score":{"x":0,"y":0,"w":400,"h":150}}}}}' >/dev/null
R=$(call '{"name":"play_loop","arguments":{"name":"good","ticks":5,"quality":12,"reset":true,"waitMs":0,"policy":[{"name":"farm","if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}]}}')
check g-rules '"rules":{"farm":{"fires":' "$R"
check g-good 'True' "$(echo "$R" | j 'd["rules"]["farm"]["good"] >= 3')"
check g-bad0 '0' "$(echo "$R" | j 'd["rules"]["farm"]["bad"]')"
check g-score-pos 'True' "$(echo "$R" | j 'd["rules"]["farm"]["score"] > 0')"
check g-judge '"judge":"farm: +10"' "$R"
check g-advice-keep "'farm' works" "$R"

echo "== self-critique: bad rule (hp drops each tick, hook 13) → blamed, advice, auto-skip"
call '{"name":"game_profile","arguments":{"set":{"regions":{"hp":{"x":0,"y":2200,"w":300,"h":100}}}}}' >/dev/null
R=$(call '{"name":"play_loop","arguments":{"name":"bad","ticks":6,"quality":13,"reset":true,"waitMs":0,"policy":[{"name":"charge","if":{"everyTicks":1},"do":[{"op":"tap","x":540,"y":600}]},{"name":"hide","if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}]}}')
check b-blamed 'True' "$(echo "$R" | j 'd["rules"]["charge"]["bad"] >= 2')"
check b-judge-hp 'hp lost' "$R"
check b-advice "'charge' hurt more than it helped" "$R"
check b-skipped-to-hide '"hide":' "$R"
check b-death-advice 'run ended in death' "$(call '{"name":"play_loop","arguments":{"learn":false,"ticks":4,"quality":13,"reset":true,"waitMs":0,"policy":[{"if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}],"stopOn":{"valueBelow":{"name":"hp","value":95}}}}')"

echo "== never-fired advice"
R=$(call '{"name":"play_loop","arguments":{"learn":false,"ticks":4,"reset":true,"waitMs":0,"policy":[{"name":"ghost","if":{"present":"@nothing"},"do":[{"op":"wait","ms":5}]},{"name":"idle","if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}]}}')
check nf-advice 'never fired: ghost' "$R"
check nf-nogain 'no score-like value changed' "$R"

echo "== explore rotation"
R=$(call '{"name":"play_loop","arguments":{"learn":false,"ticks":8,"reset":true,"waitMs":0,"explore":true,"exploreAfter":2,"policy":[{"name":"a","if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]},{"name":"b","if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}]}}')
check ex-b-fired '"b":' "$R"
check ex-flag '"explore":true' "$R"
R=$(call '{"name":"play_loop","arguments":{"learn":false,"ticks":6,"reset":true,"waitMs":0,"policy":[{"name":"a","if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]},{"name":"b","if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}]}}')
check noex-only-a 'onlyA' "$(echo "$R" | j '"onlyA" if "b" not in d["fires"] else "B_FIRED"')"

echo "== hybrid reflex rule → react_script on device"
R=$(call '{"name":"play_loop","arguments":{"learn":false,"ticks":3,"reset":true,"waitMs":0,"policy":[{"name":"fight","if":{"present":"@enemy"},"reflex":{"timeoutMs":1000,"rules":[{"name":"track","when":[{"type":"color_present","color":"@enemy","minSize":8}],"then":[{"op":"tap_found"}]}]},"cooldownTicks":5},{"name":"idle","if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}]}}')
check rf-ok '"ok":true' "$R"
check rf-runs '"reflexRuns":1' "$R"
check rf-log '"reflex":{"ok":true,"triggers":' "$R"
check rf-fight '"fight":1' "$R"

echo "== auto session_report"
call '{"name":"play_loop","arguments":{"name":"rep","ticks":4,"quality":12,"reset":true,"waitMs":0,"policy":[{"name":"farm","if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}]}}' >/dev/null
sleep 1
P=$(call '{"name":"game_profile"}')
check rep-saved 'autopilot rep: ' "$P"
check rep-outcome '"outcome":"progress"' "$P"
check rep-off 'noreport' "$(call '{"name":"game_profile","arguments":{"delete":true}}' >/dev/null; call '{"name":"game_profile","arguments":{"set":{"colors":{"enemy":{"hex":"#ff0000"}}}}}' >/dev/null; call '{"name":"play_loop","arguments":{"report":false,"learn":false,"ticks":4,"reset":true,"waitMs":0,"policy":[{"if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}]}}' >/dev/null; sleep 1; call '{"name":"game_profile"}' | j '"noreport" if "lastReport" not in d["profile"] else "HAS"')"

echo "== bootstrap"
check bs 'v4.6 SELF-CRITIQUE' "$(curl -s $U/agent/$T)"

call '{"name":"finger","arguments":{"op":"up","finger":-1}}' >/dev/null
call '{"name":"game_profile","arguments":{"delete":true}}' >/dev/null
memdel 'kind=all' >/dev/null
call '{"name":"open_recents"}' >/dev/null
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
