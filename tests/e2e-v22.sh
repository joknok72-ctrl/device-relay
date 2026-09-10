#!/usr/bin/env bash
# v2.2 test: per-app AI memory — grouped view, granular delete, export/import, recall forget=app, apps-seen, setup page. Requires relay + fake-phone.
set -u
U="${1:-http://localhost:3000}"; T="${2:-dev-secret-token-123}"; D="${3:-test-phone}"
A=(-H "Authorization: Bearer $T" -H "Content-Type: application/json")
pass=0; fail=0
check() { if [[ "$3" == *"$2"* ]]; then echo "  ✔ $1"; pass=$((pass+1)); else echo "  ✘ $1  (expected '$2')"; echo "     got: ${3:0:300}"; fail=$((fail+1)); fi; }
call() { curl -s "${A[@]}" -d "$1" $U/api/devices/$D/tools/call; }
mem() { curl -s "${A[@]}" "$U/api/admin/devices/$D/memory$1"; }
memdel() { curl -s -X DELETE "${A[@]}" "$U/api/admin/devices/$D/memory?$1"; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
export RELAY_URL=$U RELAY_TOKEN=$T RELAY_DEVICE=$D
P=/home/user/webapp/agent/phone.sh
call '{"name":"open_recents"}' >/dev/null

echo "== version"
check version '"version":"4.7.4"' "$(curl -s $U/api/health)"
check tools-83 '84' "$(curl -s "$U/api/tools/schema?format=raw" | j 'len(d)')"
check bootstrap-5e '## 5e. Memory hygiene' "$(curl -s $U/agent/$T)"
check bootstrap-forget-app 'recall forget="app"' "$(curl -s $U/agent/$T)"

echo "== seed memory for two games"
memdel 'kind=all' >/dev/null
check wipe-empty '"totals":{"notes":0,"macros":0,"screens":0,"profiles":0}' "$(memdel 'kind=all')"
call '{"name":"remember","arguments":{"text":"jump=(950,2100)"}}' >/dev/null
call '{"name":"remember","arguments":{"text":"fire=(200,2100)"}}' >/dev/null
call '{"name":"remember","arguments":{"text":"other game note","app":"com.other.game"}}' >/dev/null
curl -s "${A[@]}" -d '{"text":"general note"}' $U/api/devices/$D/notes >/dev/null   # untagged note via REST
R=$(call '{"name":"save_macro","arguments":{"name":"open-lvl","steps":[{"name":"press_back"}],"description":"t"}}')
check macro-tagged '"app":"com.example.spacerunner"' "$R"
call '{"name":"save_macro","arguments":{"name":"other-macro","steps":[{"name":"press_back"}],"app":"com.other.game"}}' >/dev/null
call '{"name":"label_screen","arguments":{"name":"menu"}}' >/dev/null

echo "== grouped view"
M=$(mem '')
check mem-totals '"totals":{"notes":4,"macros":2,"screens":1,"apps":1,"profiles":0,"sessions":' "$M"
check mem-group-spacerunner '"app":"com.example.spacerunner","label":"Space Runner"' "$M"
check mem-group-notes 'True' "$(echo "$M" | j 'any(g["app"]=="com.example.spacerunner" and len(g["notes"])==2 and len(g["macros"])==1 and len(g["screens"])==1 for g in d["groups"])')"
check mem-group-other 'True' "$(echo "$M" | j 'any(g["app"]=="com.other.game" and len(g["notes"])==1 and len(g["macros"])==1 for g in d["groups"])')"
check mem-group-general 'True' "$(echo "$M" | j 'any(g["app"]=="" and len(g["notes"])==1 for g in d["groups"])')"
check mem-note-index 'True' "$(echo "$M" | j 'all("index" in n for g in d["groups"] for n in g["notes"])')"
check mem-apps-seen '"com.example.spacerunner": {' "$(echo "$M" | j 'json.dumps(d["apps"])')"
check mem-device-token-read '"groups"' "$(curl -s "${A[@]}" $U/api/devices/$D/memory)"
check mem-invalid-device 'invalid deviceId' "$(curl -s "${A[@]}" "$U/api/admin/devices/bad%20id/memory")"

echo "== granular delete"
check del-note-index '"removed":{"notes":1,' "$(memdel 'kind=notes&index=0')"
check del-macro-name '"removed":{"notes":0,"macros":1,' "$(memdel 'kind=macros&name=other-macro')"
check del-screen-name '"screens": 1' "$(memdel 'kind=screens&name=menu' | j 'json.dumps(d["removed"])')"
check del-app-only-other '"removed":{"notes":1,"macros":0,"screens":0,"apps":0,"profiles":0,"sessions":0}' "$(memdel 'kind=all&app=com.other.game')"
check del-app-keeps-others 'True' "$(mem '' | j 'd["totals"]["notes"]==2 and any(g["app"]=="com.example.spacerunner" for g in d["groups"])')"
check del-general '"notes": 1' "$(memdel 'kind=notes&app=' | j 'json.dumps(d["removed"])')"
check del-apps-list '"apps": 1' "$(memdel 'kind=apps&app=com.example.spacerunner' | j 'json.dumps(d["removed"])')"

echo "== recall forget=app (AI-side)"
call '{"name":"remember","arguments":{"text":"stale layout"}}' >/dev/null
check forget-app '"app":"com.example.spacerunner"' "$(call '{"name":"recall","arguments":{"forget":"app"}}')"
check forget-app-count '"count":0' "$(call '{"name":"recall","arguments":{"app":"current"}}')"
call '{"name":"remember","arguments":{"text":"x","app":"com.z"}}' >/dev/null
check forget-app-explicit '"removed":{"notes":1' "$(call '{"name":"recall","arguments":{"forget":"app","app":"com.z"}}')"
check forget-index-still-works '"count":0' "$(call '{"name":"remember","arguments":{"text":"tmp"}}' >/dev/null; call '{"name":"recall","arguments":{"forget":"0"}}')"

echo "== export / import"
call '{"name":"remember","arguments":{"text":"exported note"}}' >/dev/null
call '{"name":"save_macro","arguments":{"name":"exp-macro","steps":[{"name":"press_back"}]}}' >/dev/null
call '{"name":"label_screen","arguments":{"name":"exp-screen"}}' >/dev/null
EXP=$(mem '?format=export')
check export-header 'attachment; filename="device-relay-memory-test-phone-' "$(curl -s -D - -o /dev/null "${A[@]}" "$U/api/admin/devices/$D/memory?format=export")"
check export-body '"exportedAt"' "$EXP"
check export-version '"version": "4.7.4"' "$EXP"
memdel 'kind=all' >/dev/null
check import '"imported":{"notes":1,"macros":2,"screens":1,"profiles":0,"playbooks":0}' "$(curl -s "${A[@]}" -d "$EXP" $U/api/admin/devices/$D/memory/import)"
check import-restored '"notes": 1, "macros": 2, "screens": 1' "$(mem '' | j 'json.dumps(d["totals"])')"
check import-badjson 'invalid JSON' "$(curl -s "${A[@]}" -d 'nope' $U/api/admin/devices/$D/memory/import)"

echo "== recording shows in memory"
call '{"name":"record_macro","arguments":{"start":true,"name":"r"}}' >/dev/null
check mem-recording '"recording": true' "$(mem '' | j 'json.dumps(d["totals"])')"
check del-recording '"recording": false' "$(memdel 'kind=recording' >/dev/null; mem '' | j 'json.dumps(d["totals"])')"

echo "== non-admin denied"
RO=$(curl -s "${A[@]}" -d '{"deviceId":"test-phone","label":"ro22"}' $U/api/admin/tokens | j 'd["token"]')
check ro-memory-read '"groups"' "$(curl -s -H "Authorization: Bearer $RO" $U/api/devices/$D/memory)"
check ro-memory-admin-denied 'admin token required' "$(curl -s -H "Authorization: Bearer $RO" $U/api/admin/devices/$D/memory)"
check ro-memory-delete-denied 'admin token required' "$(curl -s -X DELETE -H "Authorization: Bearer $RO" "$U/api/admin/devices/$D/memory?kind=all")"

echo "== setup page"
S=$(curl -s $U/setup/$T)
check setup-section 'id="memory-section"' "$S"
check setup-wipe 'id="mem-wipe"' "$S"
check setup-export 'id="mem-export"' "$S"
check setup-import 'id="mem-import"' "$S"
check setup-per-app 'data-mem="app"' "$S"

echo "== phone.sh memory"
cd /tmp
check sh-memory '== com.example.spacerunner' "$(bash $P memory 2>&1)"
check sh-memory-note 'note[0] exported note' "$(bash $P memory 2>&1)"
check sh-memory-wipe '"removed"' "$(bash $P memory wipe com.example.spacerunner 2>&1)"
check sh-memory-export '"exportedAt"' "$(bash $P memory export 2>&1)"
check sh-memory-badsub 'memory: show' "$(bash $P memory nope 2>&1)"
cd - >/dev/null

memdel 'kind=all' >/dev/null
call '{"name":"open_recents"}' >/dev/null
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
