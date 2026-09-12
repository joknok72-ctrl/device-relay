#!/usr/bin/env bash
# v4.8 Domino All-Fives bot: tool schema, validation, start/status/stop/analyze round-trip, setup page card
U=${U:-http://localhost:3000}; T=${T:-dev-secret-token-123}; D=${D:-test-phone}
pass=0; fail=0
check() { if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $1: expected [$3] got [$2]"; fi; }
j() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
call() { curl -s -A dr-agent -X POST "$U/api/devices/$D/tools/domino_bot" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d "$1"; }

check version '4.8.0' "$(curl -s "$U/api/health" | j 'd["version"]')"
check tool-listed 'True' "$(curl -s "$U/api/tools/schema?format=raw" | j 'any(t["name"]=="domino_bot" for t in d)')"
check tools-85 '85' "$(curl -s "$U/api/tools/schema?format=raw" | j 'len(d)')"
check bad-op 'False' "$(call '{"op":"dance"}' | j 'd["ok"]')"
r=$(call '{"op":"start","startDelayMs":4000}')
check start-ok 'True' "$(echo "$r" | j 'd["ok"]')"
check start-flag 'True' "$(echo "$r" | j 'd["data"]["started"]')"
check start-delay '4000' "$(echo "$r" | j 'd["data"]["startDelayMs"]')"
r=$(call '{}')
check status-running 'True' "$(echo "$r" | j 'd["data"]["running"]')"
check status-moves '1' "$(echo "$r" | j 'd["data"]["moves"]')"
r=$(call '{"op":"analyze"}')
check analyze-hand '1|4' "$(echo "$r" | j 'd["data"]["hand"][0]["tile"]')"
check analyze-end 'S' "$(echo "$r" | j 'd["data"]["ends"][0]["id"]')"
r=$(call '{"op":"stop"}')
check stop 'True' "$(echo "$r" | j 'd["data"]["stopped"]')"
check status-stopped 'False' "$(call '{"op":"status"}' | j 'd["data"]["running"]')"
check delay-clamp '30000' "$(call '{"op":"start","startDelayMs":99999}' | j 'd["data"]["startDelayMs"]')"
call '{"op":"stop"}' >/dev/null
RO=$(curl -s -X POST "$U/api/admin/tokens" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d "{\"deviceId\":\"$D\",\"readOnly\":true,\"label\":\"ro-dom\"}" | j 'd["token"]')
check readonly-refused 'False' "$(curl -s -A dr-agent -X POST "$U/api/devices/$D/tools/domino_bot" -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"op":"start"}' | j 'd.get("ok", False)')"
page=$(curl -s "$U/setup/$T")
check setup-card 'yes' "$(grep -q 'id="dom-start"' <<<"$page" && echo yes)"
check setup-delay-options 'yes' "$(grep -q 'value="3500" selected' <<<"$page" && echo yes)"
check setup-analyze 'yes' "$(grep -q 'id="dom-analyze"' <<<"$page" && echo yes)"
check bootstrap-mentions 'yes' "$(curl -s -A dr-agent "$U/agent/$T" | grep -q 'domino_bot' && echo yes)"
echo "e2e-v48: $pass passed, $fail failed"; [[ $fail == 0 ]]
