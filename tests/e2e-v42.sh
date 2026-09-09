#!/usr/bin/env bash
# v4.2 test: game_setup auto-profile, play deltas/events/stuck detection, play-state reset. Requires relay + fake-phone.
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

echo "== version / schema"
check version '"version":"4.2.0"' "$(curl -s $U/api/health)"
check tools-82 '82' "$(curl -s "$U/api/tools/schema?format=raw" | j 'len(d)')"
check schema-setup 'game_setup' "$(curl -s "$U/api/tools/schema?format=raw" | j '[t["name"] for t in d if t["name"]=="game_setup"][0]')"
check schema-play-reset 'reset' "$(curl -s "$U/api/tools/schema?format=raw" | j '"reset" if "reset" in [t for t in d if t["name"]=="play"][0]["parameters"]["properties"] else "no"')"

echo "== game_setup (unknown game → profile)"
R=$(call '{"name":"game_setup","arguments":{"image":false}}')
check gs-ok '"ok":true' "$R"
check gs-app '"app":"com.example.spacerunner"' "$R"
check gs-created '"created":true' "$R"
check gs-colors-red '"red":{"hex":"#ff0000"' "$R"
check gs-colors-green '"green":{"hex":"#00ff00"' "$R"
check gs-region-score '"score":{"x":' "$R"
check gs-controls-play '"play":{"x":540,"y":990' "$R"
check gs-controls-settings '"settings":{"x":540,"y":1270' "$R"
check gs-genre '"genre":"' "$R"
check gs-found '"found":{"colors":' "$R"
check gs-next 'play {} now auto-tracks' "$R"
check gs-existing '"existing":true' "$(call '{"name":"game_setup","arguments":{"image":false}}')"
check gs-force '"created":false' "$(call '{"name":"game_setup","arguments":{"image":false,"force":true,"genre":"runner","label":"Space Runner"}}')"
check gs-genre-override '"genre":"runner"' "$(call '{"name":"game_profile"}')"
check gs-profile-red '"red"' "$(call '{"name":"game_profile"}')"

echo "== play after game_setup (profile-aware, auto objects/regions)"
R=$(call '{"name":"play","arguments":{"maxWidth":0}}')
check pa-red '"red":{"count":3' "$R"
check pa-score '"score":{"value":' "$R"
check pa-tick '"tick":1' "$R"
check pa-nohint 'nohint' "$(echo "$R" | j '"nohint" if "hint" not in d else "HAS_HINT"')"
call '{"name":"game_profile","arguments":{"delete":true}}' >/dev/null

echo "== deltas / events (moving world hook: quality 12)"
call '{"name":"game_profile","arguments":{"set":{"colors":{"enemy":{"hex":"#ff0000"},"coin":{"hex":"#3366ff"}},"regions":{"score":{"x":0,"y":0,"w":400,"h":150},"hp":{"x":0,"y":2200,"w":300,"h":100}}}}}' >/dev/null
R=$(call '{"name":"play","arguments":{"maxWidth":0,"quality":12,"reset":true}}')
check d1-tick '"tick":1' "$R"
check d1-nodeltas 'nodeltas' "$(echo "$R" | j '"nodeltas" if "deltas" not in d else "HAS"')"
R=$(call '{"name":"play","arguments":{"maxWidth":0,"quality":12}}')
check d2-tick '"tick":2' "$R"
check d2-delta-enemy '"@enemy":{"dx":30,"dy":0,"dir":"right"}' "$R"
check d2-delta-score '"score":10' "$R"
check d2-event-score 'score +10' "$R"
check d2-event-hp 'hp +10' "$R"
check d2-summary-dir '→right' "$R"
check d2-summary-score '(+10)' "$R"
check d2-reset '"tick":1' "$(call '{"name":"play","arguments":{"maxWidth":0,"quality":12,"reset":true}}')"

echo "== appear / vanish events"
call '{"name":"play","arguments":{"maxWidth":0,"reset":true,"objects":[{"name":"enemy","color":"#ff0000"}]}}' >/dev/null
R=$(call '{"name":"play","arguments":{"maxWidth":0,"objects":[{"name":"enemy","color":"#123456"}]}}')
check ev-vanish '@enemy vanished' "$R"
R=$(call '{"name":"play","arguments":{"maxWidth":0,"objects":[{"name":"enemy","color":"#ff0000"}]}}')
check ev-appear '@enemy appeared' "$R"

echo "== stuck detection (frozen screen hook: quality 11)"
call '{"name":"play","arguments":{"maxWidth":0,"quality":11,"reset":true}}' >/dev/null
call '{"name":"play","arguments":{"maxWidth":0,"quality":11}}' >/dev/null
R=$(call '{"name":"play","arguments":{"maxWidth":0,"quality":11}}')
check st-static '"staticTicks":3' "$R"
check st-kind '"kind":"menu"' "$R"
check st-text '"text":"PLAY"' "$R"
check st-advice 'tap the obvious button' "$R"
check st-event 'screen static ×3 (menu)' "$R"
check st-summary 'STATIC×3 menu' "$R"
R=$(call '{"name":"play","arguments":{"maxWidth":0,"quality":11}}')
check st-4 '"staticTicks":4' "$R"
check st-noauto 'nostuck' "$(call '{"name":"play","arguments":{"maxWidth":0,"quality":11,"autoRead":false}}' | j '"nostuck" if "stuck" not in d else "HAS"')"
check st-unstick 'unstuck' "$(call '{"name":"play","arguments":{"maxWidth":0}}' | j '"unstuck" if "stuck" not in d else "HAS"')"

echo "== read-only scope"
RO=$(curl -s "${A[@]}" -d '{"deviceId":"test-phone","label":"ro42","readOnly":true}' $U/api/admin/tokens | j 'd["token"]')
check ro-setup-denied 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"game_setup"}' $U/api/devices/$D/tools/call)"

echo "== bootstrap"
BS=$(curl -s $U/agent/$T)
check bs-setup 'game_setup' "$BS"
check bs-deltas 'deltas' "$BS"
check bs-heur 'Decision heuristics that work in ANY game' "$BS"

call '{"name":"game_profile","arguments":{"delete":true}}' >/dev/null
memdel 'kind=all' >/dev/null
call '{"name":"open_recents"}' >/dev/null
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
