#!/usr/bin/env bash
# v2.5 test: multi-touch engine (joystick/aim/fire_burst/finger/combo), genre profiles, genre playbooks. Requires relay + fake-phone.
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
call '{"name":"open_recents"}' >/dev/null
memdel 'kind=all' >/dev/null
call '{"name":"get_current_app"}' >/dev/null
call '{"name":"finger","arguments":{"op":"up","finger":-1}}' >/dev/null

echo "== version"
check version '"version":"2.7.0"' "$(curl -s $U/api/health)"
check tools-79 '79' "$(curl -s "$U/api/tools/schema?format=raw" | j 'len(d)')"

echo "== joystick"
R=$(call '{"name":"joystick","arguments":{"x":250,"y":1900,"direction":"up","duration":800,"distance":200}}')
check joy-ok '"ok":true' "$R"
check joy-angle '"angle":270' "$R"
check joy-tip '"tipX":250,"tipY":1700' "$R"
check joy-released '"released":true' "$R"
check joy-angle-num '"angle":45' "$(call '{"name":"joystick","arguments":{"x":250,"y":1900,"angle":45}}')"
check joy-angle-wrap '"angle":270' "$(call '{"name":"joystick","arguments":{"x":250,"y":1900,"angle":-90}}')"
check joy-hold '"released":false' "$(call '{"name":"joystick","arguments":{"x":250,"y":1900,"direction":"left","release":false}}')"
check joy-needs-dir 'requires angle' "$(call '{"name":"joystick","arguments":{"x":1,"y":1}}')"
check joy-needs-xy 'requires x, y' "$(call '{"name":"joystick","arguments":{"direction":"up"}}')"
check joy-clamp-dist '"distance":800' "$(call '{"name":"joystick","arguments":{"x":1,"y":1,"direction":"up","distance":9999}}')"
call '{"name":"finger","arguments":{"op":"up","finger":-1}}' >/dev/null

echo "== aim"
R=$(call '{"name":"aim","arguments":{"x":800,"y":1200,"dx":60,"dy":-10}}')
check aim-ok '"ok":true' "$R"
check aim-finger1 '"finger":1' "$R"
check aim-dx '"dx":60,"dy":-10' "$R"
check aim-needs-delta 'requires dx and/or dy' "$(call '{"name":"aim","arguments":{"x":1,"y":1}}')"
check aim-needs-xy 'requires x, y' "$(call '{"name":"aim","arguments":{"dx":5}}')"

echo "== fire_burst"
check fire-burst '"shots":6' "$(call '{"name":"fire_burst","arguments":{"x":950,"y":1700,"count":6,"intervalMs":80}}')"
check fire-hold '"held":1500' "$(call '{"name":"fire_burst","arguments":{"x":950,"y":1700,"holdMs":1500}}')"
check fire-needs-xy 'requires x, y' "$(call '{"name":"fire_burst","arguments":{"count":3}}')"
check fire-clamp '"count":200' "$(call '{"name":"fire_burst","arguments":{"x":1,"y":1,"count":999}}' >/dev/null; curl -s "${A[@]}" $U/api/devices/$D/logs | j '[l["action"] for l in d if l["action"]["type"]=="fire_burst"][0]["count"]' | sed 's/^/"count":/')"

echo "== finger (persistent)"
check f-down '"down":1' "$(call '{"name":"finger","arguments":{"op":"down","finger":2,"x":100,"y":200}}')"
check f-down-dup 'already down' "$(call '{"name":"finger","arguments":{"op":"down","finger":2,"x":100,"y":200}}')"
check f-move '"x":300,"y":400' "$(call '{"name":"finger","arguments":{"op":"move","finger":2,"x":300,"y":400}}')"
check f-move-path '"x":500,"y":600' "$(call '{"name":"finger","arguments":{"op":"move","finger":2,"points":[{"x":400,"y":500},{"x":500,"y":600}]}}')"
check f-move-notdown 'is not down' "$(call '{"name":"finger","arguments":{"op":"move","finger":3,"x":1,"y":1}}')"
check f-up '"lifted":1,"down":0' "$(call '{"name":"finger","arguments":{"op":"up","finger":2}}')"
check f-up-all '"lifted":2' "$(call '{"name":"finger","arguments":{"op":"down","finger":0,"x":1,"y":1}}' >/dev/null; call '{"name":"finger","arguments":{"op":"down","finger":1,"x":2,"y":2}}' >/dev/null; call '{"name":"finger","arguments":{"op":"up","finger":-1}}')"
check f-bad-op 'op must be' "$(call '{"name":"finger","arguments":{"op":"wiggle"}}')"
check f-move-needs 'requires x,y or points' "$(call '{"name":"finger","arguments":{"op":"move"}}')"

echo "== combo"
R=$(call '{"name":"combo","arguments":{"steps":[{"op":"joystick","x":250,"y":1900,"direction":"up-right","duration":400,"release":false},{"op":"aim","x":800,"y":1200,"dx":60},{"op":"fire","x":950,"y":1700,"count":5},{"op":"up","finger":-1}]}}')
check combo-ok '"ok":true' "$R"
check combo-steps '"steps":4' "$R"
check combo-fingers-clean '"fingersDown":0' "$R"
check combo-direction-map "'angle':315" "$(curl -s "${A[@]}" $U/api/devices/$D/logs | j '[l["action"] for l in d if l["action"]["type"]=="combo"][0]["combo"][0]' | sed 's/ //g')"
check combo-empty 'requires steps' "$(call '{"name":"combo","arguments":{"steps":[]}}')"
check combo-bad-op 'op must be one of' "$(call '{"name":"combo","arguments":{"steps":[{"op":"dance"}]}}')"
check combo-needs-xy 'requires x, y' "$(call '{"name":"combo","arguments":{"steps":[{"op":"tap"}]}}')"
check combo-move-fail 'not down' "$(call '{"name":"combo","arguments":{"steps":[{"op":"move","finger":3,"x":1,"y":1}]}}')"
check combo-wait-ok '"steps":2' "$(call '{"name":"combo","arguments":{"steps":[{"op":"wait","duration":10},{"op":"tap","x":1,"y":1,"delayMs":5}]}}')"
check combo-toomany 'steps[1..40]' "$(python3 -c 'import json; print(json.dumps({"name":"combo","arguments":{"steps":[{"op":"wait"}]*41}}))' | curl -s "${A[@]}" -d @- $U/api/devices/$D/tools/call)"

echo "== @names inside shooter tools"
call '{"name":"game_profile","arguments":{"genre":"Shooter","label":"Space Runner","set":{"controls":{"stick":{"x":250,"y":1900},"look":{"x":800,"y":1200},"fire":{"x":950,"y":1700},"skill":{"x":700,"y":1800}}}}}' >/dev/null
check genre-saved '"genre":"shooter"' "$(call '{"name":"game_profile"}')"
check joy-at '"resolved":["@stick"]' "$(call '{"name":"joystick","arguments":{"at":"@stick","direction":"up"}}')"
check aim-at '"resolved":["@look"]' "$(call '{"name":"aim","arguments":{"at":"@look","dx":40}}')"
check fire-at '"resolved":["@fire"]' "$(call '{"name":"fire_burst","arguments":{"at":"@fire","count":2}}')"
R=$(call '{"name":"combo","arguments":{"steps":[{"op":"down","finger":2,"at":"@skill"},{"op":"joystick","at":"@stick","direction":"up","duration":100},{"op":"up","finger":2}]}}')
check combo-at '"resolved":["@skill","@stick"]' "$R"
check combo-at-ok '"ok":true' "$R"
check finger-at '"x":700,"y":1800' "$(call '{"name":"finger","arguments":{"op":"down","finger":3,"at":"@skill"}}')"
call '{"name":"finger","arguments":{"op":"up","finger":-1}}' >/dev/null

echo "== bootstrap genre playbooks"
B=$(curl -s $U/agent/$T)
check bs-many-games 'You will play MANY different games' "$B"
check bs-quick-genre '(genre: shooter → follow playbook 7.shooter)' "$B"
check bs-profile-genre 'genre=shooter → see playbook 7.shooter' "$B"
check bs-shooter '### 7.shooter — Free Fire, PUBG' "$B"
check bs-runner '### 7.runner' "$B"
check bs-puzzle '### 7.puzzle' "$B"
check bs-rhythm '### 7.rhythm' "$B"
check bs-strategy '### 7.strategy / rpg' "$B"
check bs-racing '### 7.racing' "$B"
check bs-fighting '### 7.fighting' "$B"
check bs-casual '### 7.casual' "$B"
check bs-safety 'ALWAYS finish with finger op=up finger=-1' "$B"
check bs-decision 'Shooter/3D → joystick + aim + fire_burst' "$B"
call '{"name":"game_profile","arguments":{"delete":true}}' >/dev/null
check bs-genre-unknown 'genre unknown — set it' "$(call '{"name":"game_profile","arguments":{"set":{"controls":{"a":{"x":1,"y":1}}}}}' >/dev/null; curl -s $U/agent/$T)"

echo "== read-only / recording / viewer"
RO=$(curl -s "${A[@]}" -d '{"deviceId":"test-phone","label":"ro25","readOnly":true}' $U/api/admin/tokens | j 'd["token"]')
check ro-joy-denied 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"joystick","arguments":{"x":1,"y":1,"direction":"up"}}' $U/api/devices/$D/tools/call)"
check ro-combo-denied 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"combo","arguments":{"steps":[{"op":"wait"}]}}' $U/api/devices/$D/tools/call)"
call '{"name":"record_macro","arguments":{"start":true,"name":"peek"}}' >/dev/null
call '{"name":"joystick","arguments":{"x":250,"y":1900,"direction":"up","duration":100}}' >/dev/null
call '{"name":"fire_burst","arguments":{"x":950,"y":1700,"count":2}}' >/dev/null
check rec-shooter 'joystick,fire_burst' "$(call '{"name":"record_macro","arguments":{"status":true}}' | j '",".join(s["name"] for s in d["draft"]["steps"] if s["name"]!="wait")')"
call '{"name":"record_macro","arguments":{"cancel":true}}' >/dev/null
node -e '
const WebSocket = require("ws");
const ws = new WebSocket(process.argv[1].replace("http","ws") + "/api/ws/viewer/" + process.argv[3] + "?token=" + process.argv[2]);
const got = [];
ws.on("message", (b) => { const m = JSON.parse(b); if (m.kind === "overlay") got.push(m.type + (m.repeat ? ":" + m.repeat : "")) });
ws.on("open", async () => {
  const call = (body) => fetch(process.argv[1] + "/api/devices/" + process.argv[3] + "/tools/call", { method: "POST", headers: { Authorization: "Bearer " + process.argv[2], "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await new Promise(r => setTimeout(r, 300));
  await call({ name: "joystick", arguments: { x: 250, y: 1900, direction: "up", duration: 60 } });
  await call({ name: "aim", arguments: { x: 800, y: 1200, dx: 50 } });
  await call({ name: "fire_burst", arguments: { x: 950, y: 1700, count: 3 } });
  await new Promise(r => setTimeout(r, 500));
  console.log(JSON.stringify(got.sort())); ws.close(); process.exit(0);
});
setTimeout(() => { console.log("[]"); process.exit(1) }, 15000);
' "$U" "$T" "$D" > /tmp/v25-viewer.json 2>/dev/null || echo '[]' > /tmp/v25-viewer.json
check viewer-swipes '"swipe","swipe"' "$(cat /tmp/v25-viewer.json)"
check viewer-fire '"tap:3"' "$(cat /tmp/v25-viewer.json)"

echo "== phone.sh"
cd /tmp
call '{"name":"game_profile","arguments":{"set":{"controls":{"stick":{"x":250,"y":1900},"look":{"x":800,"y":1200},"fire":{"x":950,"y":1700}}}}}' >/dev/null
check sh-stick '"angle": 270' "$(bash $P stick @stick up 300 2>&1)"
check sh-stick-xy '"angle": 90' "$(bash $P stick 250 1900 down 2>&1)"
check sh-stick-hold '"released": false' "$(bash $P stick @stick left 300 150 hold 2>&1)"
check sh-stick-angle '"angle": 33' "$(bash $P stick @stick 33 2>&1)"
check sh-aim '"dx": 60' "$(bash $P aim @look 60 -10 2>&1)"
check sh-fire '"shots": 4' "$(bash $P fire @fire 4 2>&1)"
check sh-fireh '"held": 700' "$(bash $P fireh @fire 700 2>&1)"
check sh-fingers '"down": 0' "$(bash $P fingers 2>&1)"
check sh-fdown '"down": 1' "$(bash $P fdown 1 10 10 2>&1)"
check sh-fmove '"x": 20' "$(bash $P fmove 1 20 20 2>&1)"
check sh-fup '"lifted": 1' "$(bash $P fup 1 2>&1)"
check sh-combo '"steps": 2' "$(bash $P combo '[{"op":"fire","at":"@fire","count":1},{"op":"up","finger":-1}]' 2>&1)"
cd - >/dev/null

call '{"name":"finger","arguments":{"op":"up","finger":-1}}' >/dev/null
memdel 'kind=all' >/dev/null
call '{"name":"open_recents"}' >/dev/null
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
