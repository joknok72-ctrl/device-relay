#!/usr/bin/env bash
# v4.7.3 rename device: memory (profiles/strategies/sessions/notes/macros/screens/apps) + label + tokens move to the new id.
set -u
U="${1:-http://localhost:3000}"; T="${2:-dev-secret-token-123}"; D="${3:-test-phone}"
A=(-H "Authorization: Bearer $T" -H "Content-Type: application/json" -A dr-agent)
pass=0; fail=0
check() { if [[ "$3" == *"$2"* ]]; then echo "  ✔ $1"; pass=$((pass+1)); else echo "  ✘ $1  (expected '$2')"; echo "     got: ${3:0:300}"; fail=$((fail+1)); fi; }
call() { curl -s "${A[@]}" -d "$1" $U/api/devices/$D/tools/call; }
N="renamed-$RANDOM"
echo "== v4.7.3 rename $D -> $N"
check version '"version":"4.7.4"' "$(curl -s -A dr-agent $U/api/health)"
# seed memory on the source
call '{"name":"game_profile","arguments":{"app":"com.test.game","set":{"colors":{"enemy":{"hex":"#ff0000","tolerance":30}},"controls":{"jump":{"x":900,"y":1500}}},"label":"Test Game"}}' >/dev/null
call '{"name":"remember","arguments":{"text":"rename-test note","app":"com.test.game"}}' >/dev/null
call '{"name":"save_macro","arguments":{"name":"rename-macro","steps":[{"name":"tap","arguments":{"x":1,"y":1}}]}}' >/dev/null
curl -s "${A[@]}" -d '{"label":"My Phone"}' $U/api/admin/devices/$D/label >/dev/null
TOK=$(curl -s "${A[@]}" -d "{\"deviceId\":\"$D\",\"label\":\"rename-tok\"}" $U/api/admin/tokens | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
check "device token created" "" "$TOK"
# bad ids
check rename-invalid 'invalid newId' "$(curl -s "${A[@]}" -d '{"newId":"bad id!"}' $U/api/admin/devices/$D/rename)"
check rename-same 'equals current' "$(curl -s "${A[@]}" -d "{\"newId\":\"$D\"}" $U/api/admin/devices/$D/rename)"
# rename (keepOld so the fake phone keeps working under the old id for the other suites)
R=$(curl -s "${A[@]}" -d "{\"newId\":\"$N\",\"keepOld\":true}" $U/api/admin/devices/$D/rename)
check rename-ok '"ok":true' "$R"; check rename-profile-moved '"profiles":1' "$R"; TM=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tokensMoved',0))"); [[ "${TM:-0}" -ge 1 ]] && { echo "  ✔ rename-tokens-moved ($TM)"; pass=$((pass+1)); } || { echo "  ✘ rename-tokens-moved"; fail=$((fail+1)); }; check rename-phone-told 'switched' "$R"
# new id has the memory
M=$(curl -s "${A[@]}" $U/api/admin/devices/$N/memory)
check new-has-profile 'com.test.game' "$M"; check new-has-note 'rename-test note' "$M"; check new-has-macro 'rename-macro' "$M"
check new-label 'My Phone' "$(curl -s "${A[@]}" $U/api/devices | python3 -c "import json,sys; print([d for d in json.load(sys.stdin)['devices'] if d['deviceId']=='$N'])")"
# moved token now scopes to the new id
check token-scoped-new "\"deviceId\":\"$N\"" "$(curl -s -A dr-agent -H "Authorization: Bearer $TOK" $U/api/me)"
check token-denied-old '403' "$(curl -s -o /dev/null -w '%{http_code}' -A dr-agent -H "Authorization: Bearer $TOK" $U/api/devices/$D)"
# ---- playbooks (v4.7.3 expertise transfer) ----
echo "== playbooks"
check pb-empty '"playbook":null' "$(call '{"name":"playbook","arguments":{"app":"com.test.game"}}')"
R=$(call '{"name":"playbook","arguments":{"app":"com.test.game","merge":{"overview":"Block puzzle: drag tray pieces onto a 9x9 board; full rows/cols clear.","strategy":["Keep one column free for long pieces","Clear rows before placing big shapes"],"procedure":["play_frame to see tray","choose target cell","finger down/move/up"],"tricks":["drag with steps>=20 lands reliably"],"mistakes":["never use drag holdMs>0 (gets cancelled)"],"facts":["cell=74px"],"skill":3}}}')
check pb-merge-ok '"ok":true' "$R"; check pb-skill '"skill":3' "$R"; check pb-updates1 '"updates":1' "$R"
R=$(call '{"name":"playbook","arguments":{"app":"com.test.game","merge":{"tricks":["drag with steps>=20 lands reliably","OCR score after each move"],"procedure":["look","decide","act"],"strategy":["Keep one column free for long pieces"]}}}')
check pb-dedupe-tricks '"tricks":["drag with steps>=20 lands reliably","OCR score after each move"]' "$R"
check pb-procedure-replaced '"procedure":["look","decide","act"]' "$R"
check pb-strategy-deduped '"strategy":["Keep one column free for long pieces","Clear rows before placing big shapes"]' "$R"
check pb-updates2 '"updates":2' "$R"
R=$(call '{"name":"playbook","arguments":{"app":"com.test.game","remove":{"tricks":["OCR score"]}}}'); check pb-remove '"tricks":["drag with steps>=20 lands reliably"]' "$R"
R=$(call '{"name":"playbook","arguments":{"app":"com.test.game","merge":{"algorithm":{"lang":"python","description":"score placements","code":"def best(board, pieces):\n    return max(cands(board,pieces), key=score)"},"calibration":{"screenW":720,"screenH":1600,"dragYComp":95}}}}')
check pb-algorithm-saved '"lang":"python"' "$R"; check pb-calibration-saved '"dragYComp":95' "$R"
B0=$(curl -s -A dr-agent $U/agent/$T); echo "$B0" | grep -q "ALGORITHM START" && echo "$B0" | grep -q "def best(board, pieces)" && { echo "  ✔ boot-injects-algorithm-code"; pass=$((pass+1)); } || { echo "  ✘ boot-injects-algorithm-code"; fail=$((fail+1)); }
echo "$B0" | grep -q "dragYComp=95" && { echo "  ✔ boot-injects-calibration"; pass=$((pass+1)); } || { echo "  ✘ boot-injects-calibration"; fail=$((fail+1)); }
echo "$B0" | grep -q "REPRODUCIBLE SKILL" && { echo "  ✔ boot-rule-13"; pass=$((pass+1)); } || { echo "  ✘ boot-rule-13"; fail=$((fail+1)); }
R=$(call '{"name":"playbook","arguments":{"app":"com.test.game","remove":{"algorithm":true}}}'); echo "$R" | grep -q '"algorithm"' && { echo "  ✘ pb-remove-algorithm"; fail=$((fail+1)); } || { echo "  ✔ pb-remove-algorithm"; pass=$((pass+1)); }
check pb-general '"ok":true' "$(call '{"name":"playbook","arguments":{"app":"*","merge":{"strategy":["wait_for_screen stable before deciding"],"skill":2}}}')"
check pb-read-has-general 'wait_for_screen stable' "$(call '{"name":"playbook","arguments":{"app":"com.test.game"}}')"
B=$(curl -s -A dr-agent $U/agent/$T)
check boot-has-playbook-section 'Playbooks for other games you already know' "$B"
echo "$B" | grep -q "Keep one column free for long pieces" && { echo "  ✔ boot-injects-strategy"; pass=$((pass+1)); } || { echo "  ✘ boot-injects-strategy"; fail=$((fail+1)); }
echo "$B" | grep -q "never use drag holdMs>0" && { echo "  ✔ boot-injects-mistakes"; pass=$((pass+1)); } || { echo "  ✘ boot-injects-mistakes"; fail=$((fail+1)); }
echo "$B" | grep -q "GENERAL PLAYBOOK" && { echo "  ✔ boot-injects-general"; pass=$((pass+1)); } || { echo "  ✘ boot-injects-general"; fail=$((fail+1)); }
echo "$B" | grep -q "EXPERTISE TRANSFER" && { echo "  ✔ boot-rule-12"; pass=$((pass+1)); } || { echo "  ✘ boot-rule-12"; fail=$((fail+1)); }
check mem-lists-playbook '"playbooks":2' "$(curl -s "${A[@]}" $U/api/admin/devices/$D/memory)"
check mem-group-has-playbook 'cell=74px' "$(curl -s "${A[@]}" $U/api/admin/devices/$D/memory)"
EXP=$(curl -s "${A[@]}" "$U/api/admin/devices/$D/memory?format=export"); check export-has-playbook 'cell=74px' "$EXP"; check export-has-general '"generalPlaybook"' "$EXP"
# rename carries playbooks
N2="renamed2-$RANDOM"
R=$(curl -s "${A[@]}" -d "{\"newId\":\"$N2\",\"keepOld\":true}" $U/api/admin/devices/$D/rename); check rename2-playbooks '"playbooks":2' "$R"
check renamed-has-playbook 'cell=74px' "$(curl -s "${A[@]}" $U/api/admin/devices/$N2/memory)"
curl -s -X DELETE "${A[@]}" $U/api/devices/$N2 >/dev/null
# import restores playbook after delete
check pb-delete '"removed":true' "$(call '{"name":"playbook","arguments":{"app":"com.test.game","delete":true}}')"
check pb-gone '"playbook":null' "$(call '{"name":"playbook","arguments":{"app":"com.test.game"}}')"
check import-playbooks '"playbooks":2' "$(curl -s "${A[@]}" -d "$EXP" $U/api/admin/devices/$D/memory/import)"
check pb-restored 'cell=74px' "$(call '{"name":"playbook","arguments":{"app":"com.test.game"}}')"
check readonly-blocked 'read-only' "$(curl -s -A dr-agent -H "Authorization: Bearer $(curl -s "${A[@]}" -d "{\"deviceId\":\"$D\",\"readOnly\":true,\"label\":\"ro\"}" $U/api/admin/tokens | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')" -H 'Content-Type: application/json' -d '{"name":"playbook","arguments":{"merge":{"facts":["x"]}}}' $U/api/devices/$D/tools/call)"
call '{"name":"playbook","arguments":{"app":"com.test.game","delete":true}}' >/dev/null; call '{"name":"playbook","arguments":{"app":"*","delete":true}}' >/dev/null
# cleanup
curl -s -X DELETE "${A[@]}" $U/api/devices/$N >/dev/null
echo "v473 PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
