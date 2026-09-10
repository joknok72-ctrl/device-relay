#!/usr/bin/env bash
# v4.7 test: every-genre support — turnBased pacing, if.ui / if.text rules + @text, default policies per genre family, genre detection, playbooks.
set -u
U="${1:-http://localhost:3000}"; T="${2:-dev-secret-token-123}"; D="${3:-test-phone}"
A=(-H "Authorization: Bearer $T" -H "Content-Type: application/json")
pass=0; fail=0
check() { if [[ "$3" == *"$2"* ]]; then echo "  ✔ $1"; pass=$((pass+1)); else echo "  ✘ $1  (expected '$2')"; echo "     got: ${3:0:300}"; fail=$((fail+1)); fi; }
call() { curl -s "${A[@]}" -d "$1" $U/api/devices/$D/tools/call; }
memdel() { curl -s -X DELETE "${A[@]}" "$U/api/admin/devices/$D/memory?$1"; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
names() { call '{"name":"game_profile"}' | j '",".join(r["name"] for r in d["profile"]["strategies"][0]["policy"])'; }
reset_profile() { call '{"name":"game_profile","arguments":{"delete":true}}' >/dev/null; }
call '{"name":"open_recents"}' >/dev/null
memdel 'kind=all' >/dev/null
call '{"name":"get_current_app"}' >/dev/null
reset_profile
call '{"name":"finger","arguments":{"op":"up","finger":-1}}' >/dev/null

echo "== version"
check version '"version":"4.7.1"' "$(curl -s $U/api/health)"
check schema-turn 'turnBased' "$(curl -s "$U/api/tools/schema?format=raw" | j '"turnBased" if "turnBased" in [t for t in d if t["name"]=="play_loop"][0]["parameters"]["properties"] else "no"')"

echo "== if.ui rule (UI button PLAY) + @text token via tap_text"
call '{"name":"game_profile","arguments":{"genre":"card","set":{"colors":{"enemy":{"hex":"#ff0000"}}}}}' >/dev/null
R=$(call '{"name":"play_loop","arguments":{"learn":false,"report":false,"ticks":2,"reset":true,"policy":[{"name":"deal","if":{"ui":"play"},"do":[{"op":"tap","x":"@found.x","y":"@found.y"}]}]}}')
check ui-ok '"ok":true' "$R"
check ui-fired '"deal":' "$R"
check ui-at '"at":{"cx":540,"cy":990}' "$R"
check ui-text '"text":"play"' "$R"
check ui-turnbased '"turnBased":true' "$R"
R=$(call '{"name":"play_loop","arguments":{"learn":false,"report":false,"ticks":2,"reset":true,"policy":[{"name":"cont","if":{"text":["your turn","continue"]},"tool":{"name":"tap_text","arguments":{"text":"@text"}}}]}}')
check text-fired '"cont":' "$R"
check text-matched '"text":"Continue"' "$R"
check text-nomatch 'nofire' "$(call '{"name":"play_loop","arguments":{"learn":false,"report":false,"ticks":2,"reset":true,"policy":[{"name":"x","if":{"text":"nonexistent-zzz"},"do":[{"op":"wait","ms":5}]}]}}' | j '"nofire" if "x" not in d["fires"] else "FIRED"')"
check ui-nomatch 'nofire' "$(call '{"name":"play_loop","arguments":{"learn":false,"report":false,"ticks":2,"reset":true,"policy":[{"name":"x","if":{"ui":"nonexistent"},"do":[{"op":"wait","ms":5}]}]}}' | j '"nofire" if "x" not in d["fires"] else "FIRED"')"

echo "== turnBased auto by genre / override"
check tb-shooter-off 'notb' "$(reset_profile; call '{"name":"game_profile","arguments":{"genre":"shooter","set":{"colors":{"enemy":{"hex":"#ff0000"}}}}}' >/dev/null; call '{"name":"play_loop","arguments":{"learn":false,"report":false,"ticks":2,"reset":true,"policy":[{"if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}]}}' | j '"notb" if "turnBased" not in d else "TB"')"
check tb-force-on '"turnBased":true' "$(call '{"name":"play_loop","arguments":{"learn":false,"report":false,"ticks":2,"reset":true,"turnBased":true,"policy":[{"if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}]}}')"
check tb-board-on '"turnBased":true' "$(reset_profile; call '{"name":"game_profile","arguments":{"genre":"board","set":{"colors":{"piece":{"hex":"#ff0000"}}}}}' >/dev/null; call '{"name":"play_loop","arguments":{"learn":false,"report":false,"ticks":2,"reset":true,"policy":[{"if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}]}}')"
check tb-force-off 'notb' "$(call '{"name":"play_loop","arguments":{"learn":false,"report":false,"ticks":2,"reset":true,"turnBased":false,"policy":[{"if":{"everyTicks":1},"do":[{"op":"wait","ms":5}]}]}}' | j '"notb" if "turnBased" not in d else "TB"')"

echo "== default policies per genre family"
reset_profile; call '{"name":"game_profile","arguments":{"genre":"card","set":{"colors":{"hint":{"hex":"#ff0000"}},"controls":{"play":{"x":540,"y":990},"next":{"x":540,"y":1270}}}}}' >/dev/null
R=$(call '{"name":"play_loop","arguments":{"strategy":"default","ticks":2,"reset":true,"report":false}}')
check card-ok '"ok":true' "$R"
check card-policy 'next,play,button-text,tap-highlight,menu' "$(names)"
check card-play-fired '"play":' "$R"
check card-play-at '"at":{"cx":540,"cy":990}' "$R"
reset_profile; call '{"name":"game_profile","arguments":{"genre":"board","set":{"colors":{"enemy":{"hex":"#ff0000"},"glow":{"hex":"#00ff00"}}}}}' >/dev/null
call '{"name":"play_loop","arguments":{"strategy":"default","ticks":2,"reset":true,"report":false}}' >/dev/null
check board-policy 'button-text,avoid,tap-highlight,menu' "$(names)"
reset_profile; call '{"name":"game_profile","arguments":{"genre":"simulation","set":{"colors":{"coin":{"hex":"#ff0000"}},"controls":{"collect":{"x":100,"y":100},"upgrade":{"x":200,"y":200}}}}}' >/dev/null
call '{"name":"play_loop","arguments":{"strategy":"default","ticks":2,"reset":true,"report":false}}' >/dev/null
check sim-policy 'collect,button-text,tap-highlight,menu' "$(names)"
reset_profile; call '{"name":"game_profile","arguments":{"genre":"fighting","set":{"colors":{"enemy":{"hex":"#ff0000"}},"controls":{"punch":{"x":900,"y":1900},"block":{"x":700,"y":1900},"stick":{"x":250,"y":1900}}}}}' >/dev/null
R=$(call '{"name":"play_loop","arguments":{"strategy":"default","ticks":2,"reset":true,"report":false}}')
check fight-policy 'strike,block,close-in,menu' "$(names)"
check fight-strike '"strike":' "$R"
reset_profile; call '{"name":"game_profile","arguments":{"genre":"sports","set":{"colors":{"ball":{"hex":"#ff0000"}},"controls":{"shoot":{"x":900,"y":1900}}}}}' >/dev/null
call '{"name":"play_loop","arguments":{"strategy":"default","ticks":2,"reset":true,"report":false}}' >/dev/null
check sports-policy 'shoot,button-text,tap,menu' "$(names)"
reset_profile; call '{"name":"game_profile","arguments":{"genre":"rpg","set":{"colors":{"enemy":{"hex":"#ff0000"}},"controls":{"attack":{"x":900,"y":1900}},"regions":{"hp":{"x":0,"y":0,"w":200,"h":40}}}}}' >/dev/null
call '{"name":"play_loop","arguments":{"strategy":"default","ticks":2,"reset":true,"report":false}}' >/dev/null
check rpg-policy 'retreat,strike' "$(names)"
reset_profile; call '{"name":"game_profile","arguments":{"genre":"puzzle","set":{"colors":{"tile":{"hex":"#ff0000"}}}}}' >/dev/null
R=$(call '{"name":"play_loop","arguments":{"strategy":"default","ticks":2,"reset":true,"report":false}}')
check puzzle-policy 'button-text,tap,menu' "$(names)"
check puzzle-turnbased '"turnBased":true' "$R"
call '{"name":"finger","arguments":{"op":"up","finger":-1}}' >/dev/null

echo "== genre detection (game_setup: fake OCR 'SCORE 1250 / PLAY / Continue' → casual) + override list"
reset_profile
check gs-genre '"genre":"casual"' "$(call '{"name":"game_setup","arguments":{"image":false}}')"
check gs-override '"genre":"board"' "$(call '{"name":"game_setup","arguments":{"image":false,"force":true,"genre":"board"}}')"

echo "== bootstrap playbooks for every genre"
BS=$(curl -s $U/agent/$T)
for g in card board sports simulation adventure ANY fighting racing rhythm puzzle runner shooter casual; do check "bs-7.$g" "### 7.$g" "$BS"; done
check bs-genres-list 'action, shooter, racing, fighting, rhythm, runner, puzzle, card, board, sports, strategy, rpg, simulation, adventure, casual' "$BS"
check bs-v47 'v4.7 EVERY GENRE' "$BS"

reset_profile
memdel 'kind=all' >/dev/null
call '{"name":"open_recents"}' >/dev/null
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
