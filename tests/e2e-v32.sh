#!/usr/bin/env bash
# v3.2 test: relay auto-applies learned aim sensitivity into rules (autoApplyLearned default, false freezes, tuned counter,
# bot_sync pushed), builder auto-suggest colour + object outlines, docs. Requires relay + fake-phone.
set -u
U="${1:-http://localhost:3000}"; T="${2:-dev-secret-token-123}"; D="${3:-test-phone}"
A=(-H "Authorization: Bearer $T" -H "Content-Type: application/json")
pass=0; fail=0
check() { if [[ "$3" == *"$2"* ]]; then echo "  ✔ $1"; pass=$((pass+1)); else echo "  ✘ $1  (expected '$2')"; echo "     got: ${3:0:300}"; fail=$((fail+1)); fi; }
call() { curl -s "${A[@]}" -d "$1" $U/api/devices/$D/tools/call; }
memdel() { curl -s -X DELETE "${A[@]}" "$U/api/admin/devices/$D/memory?$1"; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
call '{"name":"open_recents"}' >/dev/null; memdel 'kind=all' >/dev/null; call '{"name":"get_current_app"}' >/dev/null

echo "== version + docs"
check version '"version":"3.4.0"' "$(curl -s $U/api/health)"
check tool-doc-autoapply 'autoApplyLearned:false to freeze' "$(curl -s "$U/api/tools/schema?format=raw" | j '[t for t in d if t["name"]=="game_bot"][0]["description"]')"
check tool-param-autoapply 'write the self-learned aim sensitivity back' "$(curl -s "$U/api/tools/schema?format=raw" | j '[t for t in d if t["name"]=="game_bot"][0]["parameters"]["properties"]["autoApplyLearned"]["description"]')"
check boot-bake 'bakes it into the rule automatically' "$(curl -s $U/agent/$T)"

echo "== auto-apply learned (default on)"
RULES='[{"name":"aim","when":[{"type":"object_present","color":"#ff00ff","match":"hue","tolerance":22}],"then":[{"type":"aim_to_found","x":800,"y":1200,"sensitivity":1}]}]'
check create-ok '"ok":true' "$(call '{"name":"game_bot","arguments":{"action":"create","name":"learn","rules":'"$RULES"'}}')"
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"learn"}}')
check no-autoapply-field-when-default 'False' "$(echo "$G" | j '"autoApplyLearned" in json.dumps(d)')"
check sens-1-before '"sensitivity":1' "$G"
call '{"name":"game_bot","arguments":{"action":"run","name":"learn"}}' >/dev/null; sleep 1
call '{"name":"game_bot","arguments":{"action":"stop"}}' >/dev/null; sleep 1
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"learn"}}')
check sens-baked '"sensitivity":0.73' "$G"
check tuned-1 '"tuned":1' "$G"
check learned-kept '"aim/0/sensitivity":0.73' "$G"
# second run with same learned value → no change, tuned stays 1
call '{"name":"game_bot","arguments":{"action":"run","name":"learn"}}' >/dev/null; sleep 1
call '{"name":"game_bot","arguments":{"action":"stop"}}' >/dev/null; sleep 1
check tuned-stable '"tuned":1' "$(call '{"name":"game_bot","arguments":{"action":"get","name":"learn"}}')"
# bot_sync pushed the baked rule to the phone → phone status reports store count
check synced-to-phone '"bots":' "$(call '{"name":"game_bot","arguments":{"action":"status"}}')"
check list-shows '"tuned":1' "$(call '{"name":"game_bot","arguments":{"action":"list"}}')"

echo "== update keeps tuned, explicit sensitivity respected"
call '{"name":"game_bot","arguments":{"action":"update","name":"learn","tickMs":150}}' >/dev/null
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"learn"}}')
check upd-tuned-kept '"tuned":1' "$G"
check upd-sens-kept '"sensitivity":0.73' "$G"

echo "== autoApplyLearned:false freezes"
check create-frozen '"ok":true' "$(call '{"name":"game_bot","arguments":{"action":"create","name":"frozen","autoApplyLearned":false,"rules":'"$RULES"'}}')"
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"frozen"}}')
check frozen-flag '"autoApplyLearned":false' "$G"
call '{"name":"game_bot","arguments":{"action":"run","name":"frozen"}}' >/dev/null; sleep 1
call '{"name":"game_bot","arguments":{"action":"stop"}}' >/dev/null; sleep 1
G=$(call '{"name":"game_bot","arguments":{"action":"get","name":"frozen"}}')
check frozen-sens '"sensitivity":1' "$G"
check frozen-no-tuned 'False' "$(echo "$G" | j '"tuned" in json.dumps(d)')"
check frozen-learned-stored '"aim/0/sensitivity":0.73' "$G"
# unfreeze via update → next run bakes
call '{"name":"game_bot","arguments":{"action":"update","name":"frozen","autoApplyLearned":true}}' >/dev/null
check unfrozen 'False' "$(call '{"name":"game_bot","arguments":{"action":"get","name":"frozen"}}' | j '"autoApplyLearned" in json.dumps(d)')"
call '{"name":"game_bot","arguments":{"action":"run","name":"frozen"}}' >/dev/null; sleep 1
call '{"name":"game_bot","arguments":{"action":"stop"}}' >/dev/null; sleep 1
check unfrozen-baked '"sensitivity":0.73' "$(call '{"name":"game_bot","arguments":{"action":"get","name":"frozen"}}')"

echo "== bots without aim_to_found untouched"
call '{"name":"game_bot","arguments":{"action":"create","name":"plain","rules":[{"name":"r","when":[{"type":"always"}],"then":[{"type":"back"}]}]}}' >/dev/null
call '{"name":"game_bot","arguments":{"action":"run","name":"plain"}}' >/dev/null; sleep 1
call '{"name":"game_bot","arguments":{"action":"stop"}}' >/dev/null; sleep 1
check plain-no-tuned 'False' "$(call '{"name":"game_bot","arguments":{"action":"get","name":"plain"}}' | j '"tuned" in json.dumps(d)')"

echo "== builder v3.2"
BH=$(curl -s $U/builder/$T); BJ=$(curl -s $U/builder.js)
check builder-suggest-btn 'id="suggest-btn"' "$BH"
check builder-suggest-logic 'suggest-btn' "$BJ"
check builder-suggest-sample 'sample_colors' "$BJ"
check builder-outlines 'objects' "$BJ"
check builder-route-ok 'suggest-btn' "$(curl -s $U/builder/$T)"

echo "== setup/bootstrap mention"
check boot-tuned 'bot.tuned counts it' "$(curl -s $U/agent/$T)"

memdel 'kind=all' >/dev/null; call '{"name":"open_recents"}' >/dev/null
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
