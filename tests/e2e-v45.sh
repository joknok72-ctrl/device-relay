#!/usr/bin/env bash
# v4.5 test: multi-object tracks, bar gauges, default policy synthesis, @threat/@away/@center tokens.
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

echo "== multi-object tracks (hook 12: nearest red drifts right, two others still)"
call '{"name":"game_profile","arguments":{"set":{"colors":{"enemy":{"hex":"#ff0000"}}}}}' >/dev/null
call '{"name":"play","arguments":{"maxWidth":0,"quality":12,"reset":true}}' >/dev/null
R=$(call '{"name":"play","arguments":{"maxWidth":0,"quality":12}}')
check tr-present '"tracks":{"@enemy":[' "$R"
check tr-count '3' "$(echo "$R" | j 'len(d["tracks"]["@enemy"])')"
check tr-first-right 'right' "$(echo "$R" | j 'd["tracks"]["@enemy"][0]["dir"]')"
check tr-first-vx 'True' "$(echo "$R" | j 'd["tracks"]["@enemy"][0]["vx"] > 0')"
check tr-others-still 'still,still' "$(echo "$R" | j '",".join(t["dir"] for t in d["tracks"]["@enemy"][1:])')"

echo "== per-object threats (hook 13: nearest red falls & grows)"
call '{"name":"play","arguments":{"maxWidth":0,"quality":13,"reset":true}}' >/dev/null
R=$(call '{"name":"play","arguments":{"maxWidth":0,"quality":13}}')
check th-one '1' "$(echo "$R" | j 'len(d["threats"])')"
check th-vy 'True' "$(echo "$R" | j 'd["threats"][0]["vy"] > 0')"
check th-track-eta 'True' "$(echo "$R" | j '"etaMs" in d["tracks"]["@enemy"][0]')"

echo "== bars (region hp + colour hp → fill %)"
call '{"name":"game_profile","arguments":{"set":{"colors":{"hp":{"hex":"#e0342a"}},"regions":{"hp":{"x":100,"y":2200,"w":500,"h":40}}}}}' >/dev/null
R=$(call '{"name":"play","arguments":{"maxWidth":0,"reset":true}}')
check bar-present '"bars":{"hp":60}' "$R"
check bar-summary 'hp=60%' "$R"
check bar-value '60' "$(call '{"name":"play","arguments":{"maxWidth":0}}' | j 'd["bars"]["hp"]')"
check bar-off 'nobars' "$(call '{"name":"play","arguments":{"maxWidth":0,"bars":false}}' | j '"nobars" if "bars" not in d else "HAS"')"
R=$(call '{"name":"play_loop","arguments":{"ticks":3,"reset":true,"waitMs":0,"learn":false,"policy":[{"if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}],"stopOn":{"valueBelow":{"name":"hp","value":70}}}}')
check bar-stop '"stoppedBy":"hp<70"' "$R"

echo "== default policy synthesis"
call '{"name":"game_profile","arguments":{"delete":true}}' >/dev/null
check def-noprofile 'cannot build a default policy' "$(call '{"name":"play_loop","arguments":{"strategy":"default"}}' | head -c 300)"
call '{"name":"game_profile","arguments":{"genre":"runner","set":{"colors":{"obstacle":{"hex":"#ff0000"},"coin":{"hex":"#3366ff"}},"controls":{"jump":{"x":900,"y":2000}}}}}' >/dev/null
R=$(call '{"name":"play_loop","arguments":{"strategy":"default","ticks":3,"quality":13,"reset":true,"waitMs":0}}')
check def-ok '"ok":true' "$R"
check def-dodge '"dodge":' "$R"
check def-learned-name '"name":"default"' "$R"
check def-menu-rule 'menu' "$(call '{"name":"game_profile"}' | j '",".join(r["name"] for r in d["profile"]["strategies"][0]["policy"])')"
call '{"name":"game_profile","arguments":{"delete":true}}' >/dev/null
call '{"name":"game_profile","arguments":{"genre":"shooter","set":{"colors":{"enemy":{"hex":"#ff0000"}},"controls":{"stick":{"x":250,"y":1900},"look":{"x":800,"y":1200},"fire":{"x":950,"y":1700}}}}}' >/dev/null
R=$(call '{"name":"play_loop","arguments":{"strategy":"best","ticks":3,"reset":true,"waitMs":0}}')
check def-best-fallback '"engage":' "$R"
check def-shooter-roam 'engage,roam,menu' "$(call '{"name":"game_profile"}' | j '",".join(r["name"] for r in d["profile"]["strategies"][0]["policy"])')"
call '{"name":"finger","arguments":{"op":"up","finger":-1}}' >/dev/null

echo "== game_setup returns suggestedPolicy"
call '{"name":"game_profile","arguments":{"delete":true}}' >/dev/null
R=$(call '{"name":"game_setup","arguments":{"image":false}}')
check gs-suggest '"suggestedPolicy":[' "$R"
check gs-next-default 'strategy:\"default\"} starts playing' "$R"

echo "== tokens @threat / @away / @center"
call '{"name":"game_profile","arguments":{"delete":true}}' >/dev/null
call '{"name":"game_profile","arguments":{"set":{"colors":{"enemy":{"hex":"#ff0000"}}}}}' >/dev/null
R=$(call '{"name":"play_loop","arguments":{"ticks":3,"quality":13,"reset":true,"waitMs":0,"learn":false,"policy":[{"name":"dodge","if":{"threat":true},"do":[{"op":"tap","x":"@away.x","y":"@threat.y"}]},{"name":"idle","if":{"everyTicks":1},"do":[{"op":"tap","x":"@center.x","y":"@center.y"}]}]}}')
check tok-ok '"ok":true' "$R"
check tok-dodge '"dodge":' "$R"
check tok-idle '"idle":' "$R"

echo "== bootstrap"
BS=$(curl -s $U/agent/$T)
check bs-zero 'ZERO-TO-PLAYING in two calls' "$BS"
check bs-tracks 'tracks' "$BS"
check bs-bars 'bars' "$BS"

call '{"name":"finger","arguments":{"op":"up","finger":-1}}' >/dev/null
call '{"name":"game_profile","arguments":{"delete":true}}' >/dev/null
memdel 'kind=all' >/dev/null
call '{"name":"open_recents"}' >/dev/null
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
