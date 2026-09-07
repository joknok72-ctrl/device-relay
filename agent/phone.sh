#!/usr/bin/env bash
# phone.sh — one-liner phone control for AI agents / terminals. Needs: curl, python3 (for pretty output).
#
#   export RELAY_URL=https://device-relay.xxx.workers.dev RELAY_TOKEN=... [RELAY_DEVICE=my-phone]
#   ./phone.sh devices                 # list phones
#   ./phone.sh ui                      # visible elements with coordinates
#   ./phone.sh shot [out.png] [maxWidth] [png|jpeg] [grid] [x,y,w,h]   # screenshot -> file; grid=100 draws labelled coordinate grid; region crops
#   ./phone.sh see <tap X Y | swipe X1 Y1 X2 Y2 [ms] | back | home | ...> # GAMES: action + wait + screenshot (see.png) in ONE call
#   ./phone.sh seq '[{"x":..,"y":..,"delayMs":..},..]' | path '[{"x":..,"y":..},..]' [ms] | rep X Y COUNT [ms] | mtap '[{..},{..}]'
#   ./phone.sh px '[{"x":..,"y":..}]' | color '#rrggbb' [tol] | waitscreen [change|stable] [ms]
#   ./phone.sh remember "note" | recall | forget [index|-1]
#   ./phone.sh watch '#rrggbb' [appear|vanish] [ms] | waitpx X Y '#rrggbb' [appear|vanish] [ms] | tapcolor '#rrggbb' [tol]
#   ./phone.sh diff | findimg <file.png> [threshold] | loop '<json game_loop args>'
#   ./phone.sh macros | macro <name> | savemacro <name> '<json steps>' ["description"]
#   ./phone.sh ocr [x,y,w,h] | taptext "PLAY" | waittext "LEVEL" [appear|vanish] [ms] | colors '#a,#b' | stats | live on|off
#   ./phone.sh look [grid] ['#a,#b'] [x,y,w,h]   # v1.8 observe: look.png + OCR lines + app + colours + diff in ONE call
#   ./phone.sh press "Skip" [fallbackX fallbackY] # v1.8 smart_tap: ui -> OCR -> fallback; verifies screen changed
#   ./phone.sh popups ["extra label",...] | until '<action json>' '<observation json>' [maxTries] | history [n]
#   ./phone.sh tap 540 990
#   ./phone.sh tapel "Sign in"         # tap element by text
#   ./phone.sh type "hello" [submit]
#   ./phone.sh open Chrome
#   ./phone.sh url https://example.com
#   ./phone.sh swipe 540 1800 540 600 [ms]
#   ./phone.sh scroll down|up|left|right
#   ./phone.sh back | home | recents | notif | qs | lock | wake | app | apps | status
#   ./phone.sh waitfor "Inbox" [timeoutMs]  # wait until element text appears
#   ./phone.sh find "Privacy" [down|up]     # scroll until text visible, then tap it
#   ./phone.sh drag X1 Y1 X2 Y2 [holdMs] | pinch X Y SCALE   # drag-and-drop / zoom
#   ./phone.sh info | notifs [n] | clip "text" [paste]        # device info / notifications / clipboard
#   ./phone.sh batch '<json steps array>' [continue]          # many tools in one request
#   ./phone.sh call <tool> '<json args>'   # any tool
set -euo pipefail
: "${RELAY_URL:?set RELAY_URL}" "${RELAY_TOKEN:?set RELAY_TOKEN}"
RELAY_URL="${RELAY_URL%/}"
AUTH=(-H "Authorization: Bearer $RELAY_TOKEN" -H "Content-Type: application/json")

dev() {
  if [[ -n "${RELAY_DEVICE:-}" ]]; then echo "$RELAY_DEVICE"; return; fi
  curl -sf "${AUTH[@]}" "$RELAY_URL/api/devices" | python3 -c '
import json,sys; d=json.load(sys.stdin)["devices"]; on=[x for x in d if x["online"]] or d
print(on[0]["deviceId"] if on else "", end="")'
}
call() { # tool json
  local d; d=$(dev); [[ -z "$d" ]] && { echo "no phone registered/online" >&2; exit 2; }
  curl -s "${AUTH[@]}" -d "{\"name\":\"$1\",\"arguments\":${2:-{\}}}" "$RELAY_URL/api/devices/$d/tools/call"
}
pretty() { python3 -c 'import json,sys; d=json.load(sys.stdin); d.pop("image",None); print(json.dumps(d,ensure_ascii=False,indent=1))'; }

cmd="${1:-help}"; shift || true
case "$cmd" in
  devices) curl -sf "${AUTH[@]}" "$RELAY_URL/api/devices" | python3 -c '
import json,sys
for x in json.load(sys.stdin)["devices"]: print(("● " if x["online"] else "○ ")+x["deviceId"], x.get("model",""), x.get("screen",""), "a11y="+str(x.get("accessibilityEnabled")))' ;;
  status)  d=$(dev); curl -s "${AUTH[@]}" "$RELAY_URL/api/devices/$d" | pretty ;;
  ui)      call get_ui_elements | python3 -c '
import json,sys; r=json.load(sys.stdin); flt=" ".join(sys.argv[1:]).lower()
if not r.get("ok"): print(r); sys.exit(1)
d=r["data"]; print("app: %s (%s)  elements: %s" % (d.get("label"), d.get("package"), d.get("count")))
for e in d.get("elements",[]):
    if flt and flt not in json.dumps(e, ensure_ascii=False).lower(): continue
    f="".join(c for c,k in (("C","clickable"),("E","editable"),("S","scrollable")) if e.get(k))
    label=(e.get("text") or e.get("desc") or e.get("hint") or "")[:60]
    print("  [%3d] (%4d,%4d) %-3s %-14s %-24s %r" % (e["i"], e["cx"], e["cy"], f, e.get("cls",""), e.get("id",""), label))' "$@" ;;
  shot)    out="${1:-screen.png}"; d=$(dev); q="maxWidth=${2:-540}&format=${3:-png}&grid=${4:-0}${5:+&region=$5}"; curl -sf "${AUTH[@]}" -D /dev/stderr -o "$out" "$RELAY_URL/api/devices/$d/screenshot.png?$q" 2>&1 | grep -i "^x-screen\|^x-image" || true; echo "saved $out" ;;
  see)     # act_and_see: see <cmd> <args...>  -> runs the input tool, waits, saves see.png, prints result
           sub="$1"; shift; case "$sub" in
             tap) act="{\"name\":\"tap\",\"arguments\":{\"x\":$1,\"y\":$2}}" ;;
             dtap) act="{\"name\":\"double_tap\",\"arguments\":{\"x\":$1,\"y\":$2}}" ;;
             long) act="{\"name\":\"long_press\",\"arguments\":{\"x\":$1,\"y\":$2,\"duration\":${3:-800}}}" ;;
             swipe) act="{\"name\":\"swipe\",\"arguments\":{\"x1\":$1,\"y1\":$2,\"x2\":$3,\"y2\":$4,\"duration\":${5:-300}}}" ;;
             back) act='{"name":"press_back"}' ;; home) act='{"name":"press_home"}' ;;
             tapel) act="$(python3 -c 'import json,sys; print(json.dumps({"name":"tap_element","arguments":{"text":sys.argv[1]}}))' "$*")" ;;
             *) echo "see: unknown sub-command $sub" >&2; exit 1 ;;
           esac
           d=$(dev); curl -s "${AUTH[@]}" -d "{\"name\":\"act_and_see\",\"arguments\":{\"action\":$act,\"waitMs\":${SEE_WAIT:-400},\"maxWidth\":${SEE_WIDTH:-720},\"format\":\"jpeg\",\"grid\":${SEE_GRID:-0}}}" "$RELAY_URL/api/devices/$d/tools/call" | python3 -c '
import json,sys,base64; d=json.load(sys.stdin); img=d.pop("image",None)
if img: open("see.png","wb").write(base64.b64decode(img["base64"])); d["saved"]="see.png (%dx%d scale=%s)"%(img["w"],img["h"],img["scale"])
print(json.dumps(d,ensure_ascii=False,indent=1))' ;;
  seq)     call tap_sequence "{\"points\":$1}" | pretty ;;
  path)    call swipe_path "{\"points\":$1,\"duration\":${2:-500}}" | pretty ;;
  rep)     call repeat_tap "{\"x\":$1,\"y\":$2,\"count\":${3:-5},\"intervalMs\":${4:-100}}" | pretty ;;
  mtap)    call multi_tap "{\"points\":$1,\"duration\":${2:-60}}" | pretty ;;
  px)      call get_pixels "{\"points\":$1}" | pretty ;;
  color)   call find_color "{\"color\":\"$1\",\"tolerance\":${2:-24}}" | pretty ;;
  waitscreen) call wait_for_screen "{\"mode\":\"${1:-change}\",\"timeoutMs\":${2:-5000}}" | pretty ;;
  remember) call remember "$(python3 -c 'import json,sys; print(json.dumps({"text":sys.argv[1]}))' "$*")" | pretty ;;
  recall)  call recall | python3 -c '
import json,sys; d=json.load(sys.stdin)
for n in d.get("notes",[]): print("  [%d] %s%s" % (n["index"], ("(%s) " % n["app"]) if n.get("app") else "", n["text"]))
print("(%d notes)" % d.get("count",0))' ;;
  forget)  call recall "{\"forget\":${1:--1}}" | pretty ;;
  watch)   ap=true; [[ "${2:-}" == "vanish" ]] && ap=false; call watch_color "{\"color\":\"$1\",\"appear\":$ap,\"timeoutMs\":${3:-5000}}" | pretty ;;
  waitpx)  ap=true; [[ "${4:-}" == "vanish" ]] && ap=false; call wait_pixel "{\"x\":$1,\"y\":$2,\"color\":\"$3\",\"appear\":$ap,\"timeoutMs\":${5:-5000}}" | pretty ;;
  tapcolor) call tap_color "{\"color\":\"$1\",\"tolerance\":${2:-24}}" | pretty ;;
  diff)    call screen_diff | pretty ;;
  findimg) call find_image "$(python3 -c 'import json,sys,base64; print(json.dumps({"image":base64.b64encode(open(sys.argv[1],"rb").read()).decode(),"threshold":float(sys.argv[2])}))' "$1" "${2:-0.85}")" | pretty ;;
  loop)    call game_loop "$1" | pretty ;;
  macros)  call list_macros | python3 -c '
import json,sys; d=json.load(sys.stdin)
for m in d.get("macros",[]): print("  %-28s %2d steps  ran %dx  %s" % (m["name"], m["steps"], m["runs"], m.get("description") or ""))
print("(%d macros)" % d.get("count",0))' ;;
  macro)   call run_macro "{\"name\":\"$1\"}" | pretty ;;
  ocr)     call read_text "$(python3 -c 'import json,sys
r=sys.argv[1]
if r:
  x,y,w,h=map(int,r.split(",")); print(json.dumps({"region":{"x":x,"y":y,"w":w,"h":h}}))
else: print("{}")' "${1:-}")" | python3 -c '
import json,sys; r=json.load(sys.stdin)
if not r.get("ok"): print(r); sys.exit(1)
for l in r.get("data",{}).get("lines",[]): print("  (%4d,%4d) %s" % (l["cx"], l["cy"], l["text"]))
print("(%d lines)" % len(r.get("data",{}).get("lines",[])))' ;;
  taptext) call tap_text "$(python3 -c 'import json,sys; print(json.dumps({"text":sys.argv[1]}))' "$*")" | pretty ;;
  waittext) ap=true; [[ "${2:-}" == "vanish" ]] && ap=false; call wait_for_text "$(python3 -c 'import json,sys; print(json.dumps({"text":sys.argv[1],"appear":sys.argv[2]=="true","timeoutMs":int(sys.argv[3])}))' "$1" "$ap" "${3:-8000}")" | pretty ;;
  colors)  call find_colors "$(python3 -c 'import json,sys; print(json.dumps({"colors":sys.argv[1].split(",")}))' "$1")" | pretty ;;
  stats)   call session_stats | pretty ;;
  look)    call observe "$(python3 -c 'import json,sys
a={"maxWidth":int(sys.argv[4])}
if sys.argv[1] and sys.argv[1] != "0": a["grid"]=int(sys.argv[1])
if sys.argv[2]: a["colors"]=sys.argv[2].split(",")
if sys.argv[3]:
  x,y,w,h=map(int,sys.argv[3].split(",")); a["region"]={"x":x,"y":y,"w":w,"h":h}
print(json.dumps(a))' "${1:-0}" "${2:-}" "${3:-}" "${LOOK_WIDTH:-720}")" | python3 -c '
import json,sys,base64; d=json.load(sys.stdin); img=d.pop("image",None)
if img: open("look.png","wb").write(base64.b64decode(img["base64"])); print("saved look.png (%dx%d scale=%s)" % (img["w"],img["h"],img["scale"]))
app=d.get("app") or {}; print("app:", app.get("label"), "(%s)" % app.get("package"), " screen:", d.get("screen"))
ch=d.get("changed") or {}; print("changed: %s%% %s" % (ch.get("pct"), "(baseline)" if ch.get("baseline") else ""))
for c in (d.get("colors") if isinstance(d.get("colors"),list) else []): print("  color %s: %s" % (c["color"], ("(%d,%d) n=%d" % (c["cx"],c["cy"],c["count"])) if c.get("found") else "not found"))
t=d.get("text") or {}
for l in t.get("lines",[]) if isinstance(t,dict) else []: print("  (%4d,%4d) %s" % (l["cx"], l["cy"], l["text"]))
if isinstance(t,dict) and t.get("ok") is False: print("  ocr:", t.get("error"))
if not d.get("ok"): print("ERROR:", d.get("error")); sys.exit(1)' ;;
  press)   call smart_tap "$(python3 -c 'import json,sys
a={"text":sys.argv[1]}
if len(sys.argv)>3: a["fallback"]={"x":int(sys.argv[2]),"y":int(sys.argv[3])}
print(json.dumps(a))' "$@")" | pretty ;;
  popups)  call dismiss_popups "$(python3 -c 'import json,sys; print(json.dumps({"extra":[s for s in sys.argv[1:] if s]}))' "$@")" | pretty ;;
  until)   call do_until "$(python3 -c 'import json,sys; print(json.dumps({"action":json.loads(sys.argv[1]),"until":json.loads(sys.argv[2]),"maxTries":int(sys.argv[3])}))' "$1" "$2" "${3:-8}")" | pretty ;;
  history) call recent_actions "{\"limit\":${1:-20}}" | python3 -c '
import json,sys; d=json.load(sys.stdin)
for a in d.get("actions",[]):
    extra={k:v for k,v in a.items() if k not in ("ts","ago","status","ms","type","error")}
    print("  %6s ago  %-8s %-14s %5s ms  %s %s" % (a["ago"], a["status"], a["type"], a.get("ms",""), json.dumps(extra,ensure_ascii=False) if extra else "", a.get("error","")))' ;;
  live)    en=false; [[ "${1:-on}" == "on" ]] && en=true; call live_preview "{\"enabled\":$en,\"fps\":${2:-2}}" | pretty ;;
  savemacro) call save_macro "$(python3 -c 'import json,sys; print(json.dumps({"name":sys.argv[1],"steps":json.loads(sys.argv[2]),"description":sys.argv[3]}))' "$1" "$2" "${3:-}")" | pretty ;;
  drag)    call drag "{\"x1\":$1,\"y1\":$2,\"x2\":$3,\"y2\":$4,\"holdMs\":${5:-500}}" | pretty ;;
  pinch)   call pinch "{\"x\":$1,\"y\":$2,\"scale\":$3}" | pretty ;;
  info)    call get_device_info | pretty ;;
  notifs)  call get_notifications "{\"limit\":${1:-20}}" | pretty ;;
  clip)    call set_clipboard "$(python3 -c 'import json,sys; print(json.dumps({"text":sys.argv[1],"paste":sys.argv[2]=="paste"}))' "$1" "${2:-}")" | pretty ;;
  batch)   call batch "$(python3 -c 'import json,sys; print(json.dumps({"steps":json.loads(sys.argv[1]),"continueOnError":sys.argv[2]=="continue"}))' "$1" "${2:-}")" | pretty ;;
  tap)     call tap "{\"x\":$1,\"y\":$2}" | pretty ;;
  dtap)    call double_tap "{\"x\":$1,\"y\":$2}" | pretty ;;
  long)    call long_press "{\"x\":$1,\"y\":$2,\"duration\":${3:-800}}" | pretty ;;
  tapel)   call tap_element "$(python3 -c 'import json,sys; print(json.dumps({"text":sys.argv[1]}))' "$*")" | pretty ;;
  tapid)   call tap_element "{\"elementId\":\"$1\"}" | pretty ;;
  type)    txt="$1"; sub=false; [[ "${2:-}" == "submit" ]] && sub=true
           call type_text "$(python3 -c 'import json,sys; print(json.dumps({"text":sys.argv[1],"submit":sys.argv[2]=="true"}))' "$txt" "$sub")" | pretty ;;
  open)    call open_app "$(python3 -c 'import json,sys; print(json.dumps({"text":sys.argv[1]}))' "$*")" | pretty ;;
  waitfor) call wait_for_element "$(python3 -c 'import json,sys; print(json.dumps({"text":sys.argv[1],"timeoutMs":int(sys.argv[2])}))' "$1" "${2:-8000}")" | pretty ;;
  find)    call find_and_tap "$(python3 -c 'import json,sys; print(json.dumps({"text":sys.argv[1],"direction":sys.argv[2]}))' "$1" "${2:-down}")" | pretty ;;
  url)     call open_url "{\"url\":\"$1\"}" | pretty ;;
  swipe)   call swipe "{\"x1\":$1,\"y1\":$2,\"x2\":$3,\"y2\":$4,\"duration\":${5:-300}}" | pretty ;;
  scroll)  call scroll "{\"direction\":\"${1:-down}\",\"amount\":${2:-0.5}}" | pretty ;;
  back)    call press_back | pretty ;;
  home)    call press_home | pretty ;;
  recents) call open_recents | pretty ;;
  notif)   call open_notifications | pretty ;;
  qs)      call open_quick_settings | pretty ;;
  lock)    call lock_screen | pretty ;;
  wake)    call wake_screen | pretty ;;
  wait)    call wait "{\"ms\":$1}" | pretty ;;
  app)     call get_current_app | pretty ;;
  apps)    call list_apps | python3 -c '
import json,sys
for a in json.load(sys.stdin).get("data",[]): print("  %-30s %s" % (a["label"], a["package"]))' ;;
  call)    call "$1" "${2:-{\}}" | pretty ;;
  *) sed -n '2,37p' "$0" ;;
esac
