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
check version '"version":"4.7.3"' "$(curl -s -A dr-agent $U/api/health)"
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
check rename-ok '"ok":true' "$R"; check rename-profile-moved '"profiles":1' "$R"; check rename-tokens-moved '"tokensMoved":1' "$R"; check rename-phone-told 'switched' "$R"
# new id has the memory
M=$(curl -s "${A[@]}" $U/api/admin/devices/$N/memory)
check new-has-profile 'com.test.game' "$M"; check new-has-note 'rename-test note' "$M"; check new-has-macro 'rename-macro' "$M"
check new-label 'My Phone' "$(curl -s "${A[@]}" $U/api/devices | python3 -c "import json,sys; print([d for d in json.load(sys.stdin)['devices'] if d['deviceId']=='$N'])")"
# moved token now scopes to the new id
check token-scoped-new "\"deviceId\":\"$N\"" "$(curl -s -A dr-agent -H "Authorization: Bearer $TOK" $U/api/me)"
check token-denied-old 'forbidden\|403\|not allowed' "$(curl -s -o /dev/null -w '%{http_code}' -A dr-agent -H "Authorization: Bearer $TOK" $U/api/devices/$D | sed 's/403/403 forbidden/')"
# cleanup
curl -s -X DELETE "${A[@]}" $U/api/devices/$N >/dev/null
echo "v473 PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
