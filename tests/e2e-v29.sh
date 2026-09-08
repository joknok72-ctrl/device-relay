#!/usr/bin/env bash
# v2.9 test: /builder page, color_tap template, shooter head/evade/playAgain, builderUrl. Requires relay + fake-phone.
set -u
U="${1:-http://localhost:3000}"; T="${2:-dev-secret-token-123}"; D="${3:-test-phone}"
A=(-H "Authorization: Bearer $T" -H "Content-Type: application/json")
pass=0; fail=0
check() { if [[ "$3" == *"$2"* ]]; then echo "  ✔ $1"; pass=$((pass+1)); else echo "  ✘ $1  (expected '$2')"; echo "     got: ${3:0:300}"; fail=$((fail+1)); fi; }
call() { curl -s "${A[@]}" -d "$1" $U/api/devices/$D/tools/call; }
memdel() { curl -s -X DELETE "${A[@]}" "$U/api/admin/devices/$D/memory?$1"; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
call '{"name":"open_recents"}' >/dev/null; memdel 'kind=all' >/dev/null; call '{"name":"get_current_app"}' >/dev/null

echo "== version + builder page"
check version '"version":"3.1.0"' "$(curl -s $U/api/health)"
check me-builderUrl "/builder/$T" "$(curl -s "${A[@]}" $U/api/me)"
check builder-page 'صانع البوتات' "$(curl -s $U/builder/$T)"
check builder-js 'color_tap' "$(curl -s $U/builder.js)"
check builder-unauth 'unauthorized' "$(curl -s $U/builder/not-a-token)"
RO=$(curl -s "${A[@]}" -d '{"deviceId":"test-phone","label":"ro29","readOnly":true}' $U/api/admin/tokens | j 'd["token"]')
check builder-readonly-denied 'unauthorized' "$(curl -s $U/builder/$RO)"
check setup-builder-card 'builder-link' "$(curl -s $U/setup/$T)"
check boot-builder '/builder/<token>' "$(curl -s $U/agent/$T)"
check builder-selftest-hook 'selftest' "$(curl -s $U/builder.js)"

echo "== color_tap template"
check templates-9 '9' "$(call '{"name":"game_bot","arguments":{"action":"templates"}}' | j 'len(d["templates"])')"
check templates-first-color-tap 'color_tap' "$(call '{"name":"game_bot","arguments":{"action":"templates"}}' | j 'd["templates"][0]["id"]')"
call '{"name":"game_profile","arguments":{"set":{"controls":{"fire":{"x":900,"y":1700},"look":{"x":800,"y":1200},"stick":{"x":250,"y":1900},"crouch":{"x":950,"y":2000},"again":{"x":540,"y":2100}},"colors":{"red":{"hex":"#ff0000"},"head":{"hex":"#00ff00"}},"regions":{"field":{"x":0,"y":300,"w":1080,"h":1500}}}}}' >/dev/null
R=$(call '{"name":"game_bot","arguments":{"action":"template","template":"color_tap","params":{"color":"@red"}}}')
check ct-ok '"ok":true' "$R"
check ct-rules '"ruleNames":["game-over","hit-colour"]' "$R"
check ct-tick '"tickMs":80' "$R"
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"color_tap-bot"}}')
check ct-tapall '"type":"tap_all_found","max":1' "$(echo "$G" | j 'json.dumps([a for r in d["bot"]["rules"] for a in r["then"] if a["type"]=="tap_all_found"][0],separators=(",",":"))')"
check ct-cooldown '"cooldownMs":120' "$G"
R=$(call '{"name":"game_bot","arguments":{"action":"template","template":"color_tap","name":"red-fire","params":{"color":"@red","button":"@fire","region":"@field","repeat":3,"gameOverText":false}}}')
check ct-button-ok '"ruleNames":["hit-colour"]' "$R"
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"red-fire"}}')
check ct-button-repeat '"x":900,"y":1700,"type":"repeat_tap","count":3' "$G"
check ct-region '"region":{"x":0,"y":300,"w":1080,"h":1500}' "$G"

echo "== shooter extras"
R=$(call '{"name":"game_bot","arguments":{"action":"template","template":"shooter","params":{"mode":"full","enemy":"@red","fire":"@fire","look":"@look","stick":"@stick","head":"@head","evade":"@crouch","playAgain":"@again"}}}')
check sh-ok '"ok":true' "$R"
check sh-rules '"ruleNames":["game-over","headshot","evade","play-again","aim-and-fire","sweep-and-advance"]' "$R"
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"shooter-bot"}}')
check sh-head-color '"color":"#00ff00"' "$G"
check sh-head-maxsize '"maxSize":90' "$G"
check sh-head-deadzone '"deadzone":8' "$G"
check sh-head-priority '"priority":11' "$G"
check sh-evade-nonexcl '"exclusive":false' "$G"
check sh-playagain-text '"text":"PLAY AGAIN"' "$G"
check sh-playagain-tap '"x":540,"y":2100' "$G"

memdel 'kind=all' >/dev/null; call '{"name":"open_recents"}' >/dev/null
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
