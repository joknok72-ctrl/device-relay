#!/usr/bin/env bash
# quick manual smoke of v4.1 tools (not part of run-all)
U=${1:-http://localhost:3000}; T=${2:-dev-secret-token-123}; D=${3:-test-phone}
call() { curl -s -H "Authorization: Bearer $T" -H "Content-Type: application/json" -d "$1" $U/api/devices/$D/tools/call; }
strip() { python3 -c "import json,sys; d=json.load(sys.stdin); d.get('image',{}).pop('base64',None); print(json.dumps(d)[:${1:-900}])"; }
call '{"name":"game_profile","arguments":{"delete":true}}' >/dev/null
echo "--- play {} no profile"; call '{"name":"play","arguments":{"objects":[{"name":"enemy","color":"#ff0000","minSize":6}],"ocr":[{"name":"score","region":{"x":0,"y":0,"w":400,"h":150},"number":true}]}}' | strip
echo; echo "--- play act"; call '{"name":"play","arguments":{"act":[{"op":"joystick","x":250,"y":1900,"direction":"up","duration":100,"release":false},{"op":"aim","x":800,"y":1200,"dx":40}],"waitMs":10,"objects":[{"name":"enemy","color":"#ff0000"}]}}' | strip 700
echo; echo "--- play tool"; call '{"name":"play","arguments":{"tool":{"name":"press_back"},"waitMs":10,"maxWidth":0}}' | strip 500
echo; echo "--- play nested"; call '{"name":"play","arguments":{"tool":{"name":"play"}}}'
echo; echo "--- react_script"; call '{"name":"react_script","arguments":{"timeoutMs":3000,"rules":[{"name":"track","when":[{"type":"color_present","color":"#ff0000","minSize":8,"maxSize":120}],"then":[{"op":"aim_found","x":540,"y":960,"lookX":800,"lookY":1200,"sensitivity":1.4,"dy":-10}],"cooldownMs":60},{"name":"fire","priority":1,"when":[{"type":"color_present","color":"#00ff00","region":{"x":400,"y":800,"w":280,"h":280}}],"then":[{"op":"fire","x":950,"y":1700,"holdMs":300}],"cooldownMs":80,"maxFires":1}],"stopRules":[{"type":"text_present","text":"GAME OVER"}]}}'
echo; echo "--- react stop"; call '{"name":"react_script","arguments":{"rules":[{"when":[{"type":"always"}],"then":[{"op":"tap","x":1,"y":1}]}],"stopRules":[{"type":"color_present","color":"#ff0000"}]}}'
echo; echo "--- react bad"; call '{"name":"react_script","arguments":{"rules":[]}}'; echo; call '{"name":"react_script","arguments":{"rules":[{"when":[{"type":"bogus"}],"then":[{"op":"tap","x":1,"y":1}]}]}}'; echo; call '{"name":"react_script","arguments":{"rules":[{"when":[{"type":"color_present","color":"#ff0000"}],"then":[{"op":"aim_found"}]}]}}'; echo; call '{"name":"react_script","arguments":{"rules":[{"when":[{"type":"pixel_is","color":"#ff0000"}],"then":[{"op":"tap","x":1,"y":1}]}]}}'
echo; echo "--- play_frame"; call '{"name":"play_frame","arguments":{"maxWidth":0,"pixels":[{"x":10,"y":1500}],"diff":false}}' | head -c 600
echo; echo "--- profile-aware play"
call '{"name":"game_profile","arguments":{"genre":"Shooter","set":{"controls":{"stick":{"x":250,"y":1900},"look":{"x":800,"y":1200},"fire":{"x":950,"y":1700},"crosshair":{"x":540,"y":960}},"colors":{"enemy":{"hex":"#ff0000","tolerance":30},"ring":{"hex":"#00ff00"}},"regions":{"score":{"x":0,"y":0,"w":400,"h":150},"hp":{"x":0,"y":2200,"w":300,"h":100},"minimap":{"x":800,"y":0,"w":280,"h":280}}}}}' >/dev/null
call '{"name":"play","arguments":{"maxWidth":0}}' | strip 900
echo; echo "--- react with @names"; call '{"name":"react_script","arguments":{"timeoutMs":2000,"rules":[{"name":"track","when":[{"type":"color_present","color":"@enemy","minSize":8}],"then":[{"op":"aim_found","at":"@crosshair","lookX":"@look","lookY":"@look","sensitivity":1.2,"dy":-10}]}]}}'
echo; echo "--- play act with @"; call '{"name":"play","arguments":{"act":[{"op":"fire","at":"@fire","count":2}],"waitMs":10,"maxWidth":0}}' | strip 500
call '{"name":"game_profile","arguments":{"delete":true}}' >/dev/null
