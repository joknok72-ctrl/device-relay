#!/usr/bin/env bash
# phone.sh — one-liner phone control for AI agents / terminals. Needs: curl, python3 (for pretty output).
#
#   export RELAY_URL=https://device-relay.xxx.workers.dev RELAY_TOKEN=... [RELAY_DEVICE=my-phone]
#   ./phone.sh devices                 # list phones
#   ./phone.sh ui                      # visible elements with coordinates
#   ./phone.sh shot [out.png]          # screenshot -> file
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
  shot)    out="${1:-screen.png}"; d=$(dev); curl -sf "${AUTH[@]}" -D /dev/stderr -o "$out" "$RELAY_URL/api/devices/$d/screenshot.png" 2>&1 | grep -i "^x-screen\|^x-image" || true; echo "saved $out" ;;
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
  *) sed -n '2,22p' "$0" ;;
esac
