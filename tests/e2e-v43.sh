#!/usr/bin/env bash
# v4.3 test: play_loop autopilot, threats/velocity/eta, autoMenu, session memory on tick 1. Requires relay + fake-phone.
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

echo "== version / schema"
check version '"version":"4.5.0"' "$(curl -s $U/api/health)"
check tools-83 '83' "$(curl -s "$U/api/tools/schema?format=raw" | j 'len(d)')"
check schema-loop 'play_loop' "$(curl -s "$U/api/tools/schema?format=raw" | j '[t["name"] for t in d if t["name"]=="play_loop"][0]')"
check schema-loop-req 'strategy' "$(curl -s "$U/api/tools/schema?format=raw" | j '"strategy" if "strategy" in [t for t in d if t["name"]=="play_loop"][0]["parameters"]["properties"] else "no"')"

echo "== threats / velocity (hook quality 13)"
call '{"name":"game_profile","arguments":{"set":{"colors":{"enemy":{"hex":"#ff0000"}},"regions":{"hp":{"x":0,"y":2200,"w":300,"h":100}}}}}' >/dev/null
call '{"name":"play","arguments":{"maxWidth":0,"quality":13,"reset":true}}' >/dev/null
R=$(call '{"name":"play","arguments":{"maxWidth":0,"quality":13}}')
check th-delta-dy '"dy":200' "$R"
check th-vy '"vy":' "$R"
check th-growth '"growth":' "$R"
check th-eta '"etaMs":' "$R"
check th-list '"threats":[{"name":"enemy"' "$R"
check th-approach '"approach":2' "$R"
check th-event '⚠ @enemy approaching' "$R"
check th-summary 'THREAT @enemy' "$R"
check th-hp-event '⚠ hp dropping' "$R"
check th-hp-delta '"hp":-5' "$R"

echo "== play_loop: policy fires on threat, @found substitution, stopOn valueBelow"
R=$(call '{"name":"play_loop","arguments":{"ticks":6,"quality":13,"reset":true,"waitMs":0,"policy":[{"name":"dodge","if":{"threat":true},"do":[{"op":"tap","x":"@found.x","y":"@found.y-40"}]},{"name":"idle","if":{"everyTicks":1},"do":[{"op":"wait","ms":10}]}],"stopOn":{"valueBelow":{"name":"hp","value":80}}}}')
check pl-ok '"ok":true' "$R"
check pl-fires-dodge '"dodge":' "$R"
check pl-fires-idle '"idle":' "$R"
check pl-at '"at":{"cx":540,"cy":' "$R"
check pl-stopped-hp '"stoppedBy":"hp<80"' "$R"
check pl-log '"log":[{"tick":1' "$R"
check pl-last '"last":{"summary":' "$R"
check pl-hint 'tune the policy' "$R"

echo "== play_loop: present/absent/cooldown/ticks/valueAbove/stop event"
R=$(call '{"name":"play_loop","arguments":{"ticks":4,"reset":true,"waitMs":0,"policy":[{"name":"collect","if":{"present":"@enemy"},"do":[{"op":"tap","x":"@found.x","y":"@found.y"}],"cooldownTicks":1},{"name":"roam","if":{"absent":"@nothing"},"do":[{"op":"wait","ms":5}]}]}}')
check pl2-ticks '"ticks":5' "$R"
check pl2-stopped '"stoppedBy":"ticks"' "$R"
check pl2-collect '"collect":2' "$R"
check pl2-roam '"roam":2' "$R"
check pl2-final '"final":true' "$R"
R=$(call '{"name":"play_loop","arguments":{"ticks":5,"quality":12,"reset":true,"waitMs":0,"objects":[{"name":"enemy","color":"#ff0000"}],"ocr":[{"name":"score","region":{"x":0,"y":0,"w":400,"h":150},"number":true}],"policy":[{"if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}],"stopOn":{"valueAbove":{"name":"score","value":1265}}}}')
check pl3-stop-above '"stoppedBy":"score>1265"' "$R"
R=$(call '{"name":"play_loop","arguments":{"ticks":5,"quality":12,"reset":true,"waitMs":0,"objects":[{"name":"enemy","color":"#ff0000"}],"ocr":[{"name":"score","region":{"x":0,"y":0,"w":400,"h":150},"number":true}],"policy":[{"if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}],"stopOn":{"event":"score +"}}}')
check pl4-stop-event '"stoppedBy":"event:score +"' "$R"
check pl-tool-rule '"rule0":' "$(call '{"name":"play_loop","arguments":{"ticks":2,"reset":true,"waitMs":0,"policy":[{"if":{"present":"@enemy"},"tool":{"name":"tap","arguments":{"x":"@found.x","y":"@found.y"}}}]}}')"
check pl-nopolicy 'play_loop requires policy' "$(call '{"name":"play_loop","arguments":{}}')"
check pl-nested "tool 'play_loop' not allowed inside play" "$(call '{"name":"play","arguments":{"tool":{"name":"play_loop"}}}')"

echo "== stuck + autoMenu (hook quality 11) & stopOn stuck"
call '{"name":"play","arguments":{"maxWidth":0,"quality":11,"reset":true}}' >/dev/null
call '{"name":"play","arguments":{"maxWidth":0,"quality":11}}' >/dev/null
R=$(call '{"name":"play","arguments":{"maxWidth":0,"quality":11,"autoMenu":true}}')
check am-tapped '"autoTapped":{"text":"PLAY","x":540,"y":990,"ok":true}' "$R"
check am-event 'auto-tapped' "$R"
R=$(call '{"name":"play_loop","arguments":{"ticks":6,"quality":11,"reset":true,"waitMs":0,"autoMenu":false,"policy":[{"if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}],"stopOn":{"stuck":"any"}}}')
check pl-stop-stuck '"stoppedBy":"stuck:menu"' "$R"
check pl-stuck-ticks '"ticks":3' "$R"
R=$(call '{"name":"play_loop","arguments":{"ticks":4,"quality":11,"reset":true,"waitMs":0,"autoMenu":false,"policy":[{"name":"menu","if":{"stuck":"menu"},"tool":{"name":"tap_text","arguments":{"text":"PLAY"}}},{"if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}]}}')
check pl-menu-rule '"menu":' "$R"
check pl-menu-rule1 '"rule1":2' "$R"

echo "== session memory on tick 1"
call '{"name":"session_report","arguments":{"summary":"died at wave 3","outcome":"loss","score":420,"nextTime":"keep distance from red","learned":["red = enemy"]}}' >/dev/null
R=$(call '{"name":"play","arguments":{"maxWidth":0,"reset":true}}')
check mem-present '"memory":{' "$R"
check mem-outcome '"lastOutcome":"loss"' "$R"
check mem-next '"nextTime":"keep distance from red"' "$R"
check mem-learned '"learned":["red = enemy"]' "$R"
check mem-tick2 'nomem' "$(call '{"name":"play","arguments":{"maxWidth":0}}' | j '"nomem" if "memory" not in d else "HAS"')"

echo "== read-only"
RO=$(curl -s "${A[@]}" -d '{"deviceId":"test-phone","label":"ro43","readOnly":true}' $U/api/admin/tokens | j 'd["token"]')
check ro-loop-denied 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"play_loop","arguments":{"policy":[{"if":{},"do":[]}]}}' $U/api/devices/$D/tools/call)"

echo "== bootstrap"
BS=$(curl -s $U/agent/$T)
check bs-loop 'play_loop' "$BS"
check bs-threats 'threats' "$BS"
check bs-v43 'v4.3' "$BS"

call '{"name":"finger","arguments":{"op":"up","finger":-1}}' >/dev/null
call '{"name":"game_profile","arguments":{"delete":true}}' >/dev/null
memdel 'kind=all' >/dev/null
call '{"name":"open_recents"}' >/dev/null
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
