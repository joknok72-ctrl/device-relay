#!/usr/bin/env bash
# v4.1 test: AI-direct play primitives — play (act+wait+see), play_frame, react_script (on-device reflex rules). Requires relay + fake-phone.
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
call '{"name":"game_profile","arguments":{"delete":true}}' >/dev/null
call '{"name":"finger","arguments":{"op":"up","finger":-1}}' >/dev/null

echo "== version / schema"
check version '"version":"4.3.0"' "$(curl -s $U/api/health)"
check tools-83 '83' "$(curl -s "$U/api/tools/schema?format=raw" | j 'len(d)')"
SCHEMA=$(curl -s "$U/api/tools/schema?format=raw")
check schema-play 'play' "$(echo "$SCHEMA" | j '[t["name"] for t in d if t["name"]=="play"][0]')"
check schema-react 'react_script' "$(echo "$SCHEMA" | j '[t["name"] for t in d if t["name"]=="react_script"][0]')"
check schema-frame 'play_frame' "$(echo "$SCHEMA" | j '[t["name"] for t in d if t["name"]=="play_frame"][0]')"
check schema-react-required 'rules' "$(echo "$SCHEMA" | j '[t for t in d if t["name"]=="react_script"][0]["parameters"]["required"][0]')"
check schema-no-internal '0' "$(echo "$SCHEMA" | j 'len([t for t in d if t["name"].startswith("_")])')"

echo "== play (no profile)"
R=$(call '{"name":"play","arguments":{"objects":[{"name":"enemy","color":"#ff0000","minSize":6}],"ocr":[{"name":"score","region":{"x":0,"y":0,"w":400,"h":150},"number":true}],"pixels":[{"x":10,"y":1500}]}}')
check play-ok '"ok":true' "$R"
check play-app '"app":"com.example.spacerunner"' "$R"
check play-objects '"enemy":{"count":3' "$R"
check play-nearest '"cx":540,"cy":1500' "$R"
check play-ocr '"score":{"value":1250' "$R"
check play-pixel '"hex":"#ff0000"' "$R"
check play-changed '"changedPct":7.5' "$R"
check play-summary 'enemy×3 nearest(540,1500) · score=1250 · changed 7.5%' "$R"
check play-image '"mime":"image/jpeg"' "$R"
check play-hint 'no game_profile for this app yet' "$R"
check play-noimage '"image"' "$(call '{"name":"play","arguments":{"maxWidth":0}}' | python3 -c "import json,sys; d=json.load(sys.stdin); print('\"image\"' if 'image' not in d else 'HAS_IMAGE')")"

echo "== play act / tool"
R=$(call '{"name":"play","arguments":{"act":[{"op":"joystick","x":250,"y":1900,"direction":"up","duration":100,"release":false},{"op":"aim","x":800,"y":1200,"dx":40}],"waitMs":10,"maxWidth":0,"objects":[{"name":"enemy","color":"#ff0000"}]}}')
check act-ok '"ok":true' "$R"
check act-steps '"action":{"ok":true,"data":{"steps":2' "$R"
check act-fingers '"fingersDown":1' "$R"
check act-frame '"enemy":{"count":3' "$R"
call '{"name":"finger","arguments":{"op":"up","finger":-1}}' >/dev/null
R=$(call '{"name":"play","arguments":{"tool":{"name":"press_back"},"waitMs":10,"maxWidth":0}}')
check tool-ok '"action":{"ok":true}' "$R"
check tool-summary '"summary":"changed 7.5%"' "$R"
check nested-play "tool 'play' not allowed inside play" "$(call '{"name":"play","arguments":{"tool":{"name":"play"}}}')"
check nested-react "tool 'react_script' not allowed inside play" "$(call '{"name":"play","arguments":{"tool":{"name":"react_script"}}}')"
check nested-batch "tool 'batch' not allowed inside play" "$(call '{"name":"play","arguments":{"tool":{"name":"batch"}}}')"
check act-badstep '"ok":false' "$(call '{"name":"play","arguments":{"act":[{"op":"nope"}]}}')"

echo "== play_frame"
R=$(call '{"name":"play_frame","arguments":{"maxWidth":0,"pixels":[{"x":10,"y":100}],"diff":false}}')
check frame-ok '"ok":true' "$R"
check frame-pixel '"hex":"#000000"' "$R"
check frame-nodiff 'nodiff' "$(echo "$R" | j '"nodiff" if d["frame"].get("changedPct") is None else "HAS_DIFF"')"
check frame-nodiff-summary '"summary":"nothing of interest detected"' "$R"
check frame-noaction 'frame' "$(echo "$R" | j '"frame" if "action" not in d else "HAS_ACTION"')"
check frame-badcolor 'frame.objects[0].color must be #rrggbb' "$(call '{"name":"play_frame","arguments":{"objects":[{"color":"red"}]}}')"

echo "== react_script"
R=$(call '{"name":"react_script","arguments":{"timeoutMs":3000,"rules":[{"name":"track","when":[{"type":"color_present","color":"#ff0000","minSize":8,"maxSize":120}],"then":[{"op":"aim_found","x":540,"y":960,"lookX":800,"lookY":1200,"sensitivity":1.4,"maxStep":180,"dy":-10}],"cooldownMs":60},{"name":"fire","priority":1,"when":[{"type":"color_present","color":"#00ff00","region":{"x":400,"y":800,"w":280,"h":280}}],"then":[{"op":"fire","x":950,"y":1700,"holdMs":300}],"cooldownMs":80,"maxFires":1}],"stopRules":[{"type":"text_present","text":"GAME OVER"}]}}')
check react-ok '"ok":true' "$R"
check react-triggers '"triggers":4' "$R"
check react-fires '"fires":{"track":3,"fire":1}' "$R"
check react-timeout '"stoppedBy":"timeout"' "$R"
check react-log '"rule":"fire"' "$R"
check react-stoprule '"stoppedBy":"stopRule"' "$(call '{"name":"react_script","arguments":{"rules":[{"when":[{"type":"always"}],"then":[{"op":"tap","x":1,"y":1}]}],"stopRules":[{"type":"color_present","color":"#ff0000"}]}}')"
check react-maxtrig '"stoppedBy":"maxTriggers"' "$(call '{"name":"react_script","arguments":{"maxTriggers":2,"rules":[{"when":[{"type":"always"}],"then":[{"op":"tap","x":1,"y":1}]}]}}')"
check react-tapfound '"triggers":3' "$(call '{"name":"react_script","arguments":{"rules":[{"when":[{"type":"color_present","color":"#ff0000","minSize":10}],"then":[{"op":"tap_found","dy":-5}]}]}}')"
check react-textwhen '"triggers":3' "$(call '{"name":"react_script","arguments":{"rules":[{"when":[{"type":"text_present","text":"PLAY"}],"then":[{"op":"tap","x":540,"y":990}]}]}}')"
check react-pixelwhen '"triggers":0' "$(call '{"name":"react_script","arguments":{"rules":[{"when":[{"type":"pixel_is","x":10,"y":10,"color":"#ff0000"}],"then":[{"op":"tap","x":1,"y":1}]}]}}')"
check react-absent '"triggers":3' "$(call '{"name":"react_script","arguments":{"rules":[{"when":[{"type":"color_absent","color":"#123456"}],"then":[{"op":"tap","x":1,"y":1}]}]}}')"
check react-fingers-clear '"down":0' "$(call '{"name":"finger","arguments":{"op":"up","finger":-1}}')"

echo "== react_script validation"
check v-norules 'react_script requires rules[1..12]' "$(call '{"name":"react_script","arguments":{"rules":[]}}')"
check v-badtype 'type must be one of color_present|color_absent|pixel_is|pixel_not|text_present|text_absent|always' "$(call '{"name":"react_script","arguments":{"rules":[{"when":[{"type":"bogus"}],"then":[{"op":"tap","x":1,"y":1}]}]}}')"
check v-aimfound-xy 'aim_found) requires x, y' "$(call '{"name":"react_script","arguments":{"rules":[{"when":[{"type":"color_present","color":"#ff0000"}],"then":[{"op":"aim_found"}]}]}}')"
check v-pixel-xy 'requires x,y' "$(call '{"name":"react_script","arguments":{"rules":[{"when":[{"type":"pixel_is","color":"#ff0000"}],"then":[{"op":"tap","x":1,"y":1}]}]}}')"
check v-color-hex 'color must be #rrggbb' "$(call '{"name":"react_script","arguments":{"rules":[{"when":[{"type":"color_present","color":"red"}],"then":[{"op":"tap","x":1,"y":1}]}]}}')"
check v-text-req 'text required' "$(call '{"name":"react_script","arguments":{"rules":[{"when":[{"type":"text_present"}],"then":[{"op":"tap","x":1,"y":1}]}]}}')"
check v-then-req 'requires when[] and then[1..]' "$(call '{"name":"react_script","arguments":{"rules":[{"when":[{"type":"always"}],"then":[]}]}}')"
check v-badstep 'rules[0].then:' "$(call '{"name":"react_script","arguments":{"rules":[{"when":[{"type":"always"}],"then":[{"op":"nope"}]}]}}')"

echo "== profile-aware play + @names"
call '{"name":"game_profile","arguments":{"genre":"Shooter","set":{"controls":{"stick":{"x":250,"y":1900},"look":{"x":800,"y":1200},"fire":{"x":950,"y":1700},"crosshair":{"x":540,"y":960}},"colors":{"enemy":{"hex":"#ff0000","tolerance":30},"ring":{"hex":"#00ff00"}},"regions":{"score":{"x":0,"y":0,"w":400,"h":150},"hp":{"x":0,"y":2200,"w":300,"h":100},"minimap":{"x":800,"y":0,"w":280,"h":280}}}}}' >/dev/null
R=$(call '{"name":"play","arguments":{"maxWidth":0}}')
check prof-ok '"ok":true' "$R"
check prof-enemy '"enemy":{"count":3' "$R"
check prof-ring '"ring":{"count":1' "$R"
check prof-score '"score":{"value":1250' "$R"
check prof-hp '"hp":{"value":1250' "$R"
check prof-no-minimap 'minimap' "$(echo "$R" | j '"minimap" if "minimap" not in d["frame"]["ocr"] else "HAS_MINIMAP"')"
check prof-nohint 'nohint' "$(echo "$R" | j '"nohint" if "hint" not in d else "HAS_HINT"')"
check prof-summary '@enemy×3 nearest(540,1500) · @ring×1 nearest(300,700) · score=1250 · hp=1250' "$R"
R=$(call '{"name":"react_script","arguments":{"timeoutMs":2000,"rules":[{"name":"track","when":[{"type":"color_present","color":"@enemy","minSize":8}],"then":[{"op":"aim_found","at":"@crosshair","lookX":"@look","lookY":"@look","sensitivity":1.2,"dy":-10}]}]}}')
check at-react-ok '"ok":true' "$R"
check at-react-resolved '"resolved":["@enemy","@crosshair","@look","@look"]' "$R"
check at-react-fires '"fires":{"track":3}' "$R"
R=$(call '{"name":"play","arguments":{"act":[{"op":"fire","at":"@fire","count":2}],"waitMs":10,"maxWidth":0}}')
check at-play-ok '"action":{"ok":true' "$R"
check at-play-unknown 'unknown control @nope' "$(call '{"name":"play","arguments":{"act":[{"op":"tap","at":"@nope"}],"maxWidth":0}}')"
call '{"name":"game_profile","arguments":{"delete":true}}' >/dev/null

echo "== read-only scope"
RO=$(curl -s "${A[@]}" -d '{"deviceId":"test-phone","label":"ro41","readOnly":true}' $U/api/admin/tokens | j 'd["token"]')
check ro-frame '"changedPct"' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"play_frame","arguments":{"maxWidth":0}}' $U/api/devices/$D/tools/call)"
check ro-play-denied 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"play","arguments":{"maxWidth":0}}' $U/api/devices/$D/tools/call)"
check ro-react-denied 'read-only' "$(curl -s -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"name":"react_script","arguments":{"rules":[{"when":[{"type":"always"}],"then":[{"op":"tap","x":1,"y":1}]}]}}' $U/api/devices/$D/tools/call)"

echo "== bootstrap mentions"
BS=$(curl -s $U/agent/$T)
check bs-7a 'HOW TO PLAY LIVE' "$BS"
check bs-play 'play {' "$BS"
check bs-react 'react_script' "$BS"
check bs-aimfound 'aim_found' "$BS"

echo "== phone.sh helpers"
cd /home/user/webapp
check sh-play '"summary"' "$(bash $P play 2>&1)"
check sh-play-act '"steps": 1' "$(bash $P play '[{"op":"tap","x":5,"y":5}]' 2>&1)"
check sh-frame '"changedPct"' "$(bash $P frame 2>&1)"
check sh-rules '"triggers"' "$(bash $P rules '[{"when":[{"type":"always"}],"then":[{"op":"tap","x":1,"y":1}]}]' 2000 2>&1)"
check sh-help-play 'phone.sh play [' "$(bash $P help 2>&1)"
check sh-help-rules 'phone.sh rules ' "$(bash $P help 2>&1)"
check sh-play-img 'saved play.jpg' "$(bash $P play 2>&1)"
rm -f play.jpg
cd - >/dev/null

call '{"name":"finger","arguments":{"op":"up","finger":-1}}' >/dev/null
memdel 'kind=all' >/dev/null
call '{"name":"open_recents"}' >/dev/null
echo; echo "PASSED $pass  FAILED $fail"; [[ $fail -eq 0 ]]
