#!/usr/bin/env bash
# v2.8 test: autoStart, learned (aim auto-tune) persisted from bot_status, autoTune flag, hands-free docs. Requires relay + fake-phone.
set -u
U="${1:-http://localhost:3000}"; T="${2:-dev-secret-token-123}"; D="${3:-test-phone}"
A=(-H "Authorization: Bearer $T" -H "Content-Type: application/json")
pass=0; fail=0
check() { if [[ "$3" == *"$2"* ]]; then echo "  ✔ $1"; pass=$((pass+1)); else echo "  ✘ $1  (expected '$2')"; echo "     got: ${3:0:300}"; fail=$((fail+1)); fi; }
call() { curl -s "${A[@]}" -d "$1" $U/api/devices/$D/tools/call; }
memdel() { curl -s -X DELETE "${A[@]}" "$U/api/admin/devices/$D/memory?$1"; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
export RELAY_URL=$U RELAY_TOKEN=$T RELAY_DEVICE=$D
P=/home/user/webapp/agent/phone.sh
call '{"name":"open_recents"}' >/dev/null; memdel 'kind=all' >/dev/null; call '{"name":"get_current_app"}' >/dev/null; call '{"name":"game_bot","arguments":{"action":"stop"}}' >/dev/null

echo "== version"
check version '"version":"2.8.0"' "$(curl -s $U/api/health)"
check tools-79 '79' "$(curl -s "$U/api/tools/schema?format=raw" | j 'len(d)')"
check tool-doc-handsfree 'HANDS-FREE' "$(curl -s "$U/api/tools/schema?format=raw" | grep -o 'HANDS-FREE' | head -1)"
check tool-param-autostart 'autoStart' "$(curl -s "$U/api/tools/schema?format=raw" | j '[t for t in d if t["name"]=="game_bot"][0]["parameters"]["properties"]["autoStart"]["description"]')"

echo "== autoStart"
R=$(call '{"name":"game_bot","arguments":{"action":"create","name":"auto","autoStart":true,"rules":[{"name":"aim","when":[{"type":"object_present","color":"#ff0000"}],"then":[{"type":"aim_to_found","x":800,"y":1200,"sensitivity":1.2,"autoTune":true},{"type":"fire_burst","x":900,"y":1700}]},{"name":"over","when":[{"type":"text_present","text":"GAME OVER"}],"then":[{"type":"stop_bot"}]}]}}')
check create-ok '"ok":true' "$R"
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"auto"}}')
check autostart-stored '"autoStart":true' "$G"
check autotune-default-dropped 'False' "$(echo "$G" | j '"autoTune" in json.dumps(d)')"
check no-learned-yet 'False' "$(echo "$G" | j '"learned" in d["bot"]')"
R=$(call '{"name":"game_bot","arguments":{"action":"create","name":"manual","rules":[{"name":"x","when":[{"type":"object_present","color":"#ff0000"}],"then":[{"type":"aim_to_found","x":800,"y":1200,"autoTune":false}]}]}}')
check autotune-false-kept '"autoTune":false' "$(call '{"name":"game_bot","arguments":{"action":"get","name":"manual"}}')"
check autostart-absent-default 'False' "$(call '{"name":"game_bot","arguments":{"action":"get","name":"manual"}}' | j '"autoStart" in d["bot"]')"
# update toggles
call '{"name":"game_bot","arguments":{"action":"update","name":"auto","autoStart":false}}' >/dev/null
check autostart-off 'False' "$(call '{"name":"game_bot","arguments":{"action":"get","name":"auto"}}' | j '"autoStart" in d["bot"]')"
call '{"name":"game_bot","arguments":{"action":"update","name":"auto","autoStart":true}}' >/dev/null
check autostart-on '"autoStart":true' "$(call '{"name":"game_bot","arguments":{"action":"get","name":"auto"}}')"
# pushed to the phone in bot_sync (fake phone stores raw)
check phone-synced-autostart '"autoStart":true' "$(call '{"name":"game_bot","arguments":{"action":"get","name":"auto"}}')"

echo "== learned from bot_status"
call '{"name":"game_bot","arguments":{"action":"run","name":"auto"}}' >/dev/null; sleep 0.3
call '{"name":"game_bot","arguments":{"action":"stop"}}' >/dev/null; sleep 0.5
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"auto"}}')
check learned-persisted '"learned":{"aim/0/sensitivity":0.73}' "$G"
check startedBy-status '"startedBy":"relay"' "$(call '{"name":"game_bot","arguments":{"action":"list"}}')"
# update keeps learned
call '{"name":"game_bot","arguments":{"action":"update","name":"auto","tickMs":90}}' >/dev/null
check learned-kept-on-update '"learned":{"aim/0/sensitivity":0.73}' "$(call '{"name":"game_bot","arguments":{"action":"get","name":"auto"}}')"
check mem-learned '"learned":{"aim/0/sensitivity":0.73}' "$(curl -s "${A[@]}" "$U/api/admin/devices/$D/memory")"

echo "== bootstrap"
B=$(curl -s $U/agent/$T)
check boot-handsfree 'HANDS-FREE controls' "$B"
check boot-autostart-flag '[autoStart]' "$B"
check boot-learned 'learned: aim/0/sensitivity=0.73' "$B"
check boot-volume 'Volume-Up = start' "$B"
check boot-learned-advice 'copy it into the rule with action=update' "$B"

echo "== phone.sh"
cd /tmp
check sh-auto-off '"autoStart"' "$(bash $P bot auto auto off 2>&1; bash $P bot get manual 2>&1 | head -c 0; call '{"name":"game_bot","arguments":{"action":"get","name":"auto"}}' | j '"present" if "autoStart" in d["bot"] else "\"autoStart\" gone"')"
check sh-auto-on '"autoStart": true' "$(bash $P bot auto auto 2>&1; bash $P bot get auto 2>&1)"
check sh-help-auto 'bot auto <name>' "$(bash $P help 2>&1)"
cd - >/dev/null

echo "== setup page"
S=$(curl -s $U/setup/$T)
check setup-auto-badge '⚡ auto' "$S"
check setup-learned '🎯' "$S"
check setup-bubble-text 'الفقاعة فوق اللعبة' "$S"

memdel 'kind=all' >/dev/null; call '{"name":"open_recents"}' >/dev/null
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
