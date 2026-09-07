import type { AuthContext, DeviceInfo, Macro, Note } from './types'
import { TOOLS } from './tools'

/**
 * Self-describing bootstrap document for AI agents.
 * A human only has to paste ONE url into a new chat:  <origin>/agent/<token>
 * The agent fetches it and gets everything: credentials, commands, tools, rules, live device status.
 */
export function agentBootstrap(origin: string, token: string, devices: DeviceInfo[], auth?: AuthContext & { readOnly?: boolean }, notes: Note[] = [], macros: Macro[] = []): string {
  const macrosBlock = macros.length === 0
    ? '  (none yet — use save_macro for sequences you will repeat: open game + skip intro, collect daily reward, ...)'
    : macros.map((m) => `  run_macro "${m.name}"  (${m.steps.length} steps, ran ${m.runs ?? 0}x)${m.description ? `  — ${m.description}` : ''}`).join('\n')
  let notesBlock: string
  if (notes.length === 0) notesBlock = '  (none yet — use "remember" when you learn a layout/coordinate/trick worth keeping)'
  else {
    // group by app tag so a game's notes read as one block
    const groups = new Map<string, string[]>()
    notes.forEach((n, i) => {
      const key = n.app ?? ''
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(`  [${i}] ${new Date(n.ts).toISOString().slice(0, 10)}  ${n.text}`)
    })
    notesBlock = [...groups.entries()].map(([app, lines]) => `${app ? `  — ${app} —` : '  — general —'}\n${lines.join('\n')}`).join('\n')
  }
  const online = devices.filter((d) => d.online)
  const target = online[0] ?? devices[0]
  const deviceLine = devices.length === 0
    ? 'NO PHONE REGISTERED YET. Tell the user: open the Device Relay app on the phone and press Connect, then retry.'
    : devices.map((d) => `  ${d.online ? '● ONLINE ' : '○ offline'}  id=${d.deviceId}${d.label ? ` (${d.label})` : ''}  ${d.model ?? ''}  screen=${d.screen ? `${d.screen.w}x${d.screen.h}` : '?'}  a11y=${d.accessibilityEnabled ?? '?'}${typeof d.battery === 'number' ? `  battery=${d.battery}%${d.charging ? '⚡' : ''}` : ''}${d.queued ? `  queued=${d.queued}` : ''}`).join('\n')
  const scope = auth?.role === 'device'
    ? `This token is scoped to ONE device (id=${auth.deviceId})${auth.readOnly ? ' and is READ-ONLY (observe tools only: screenshot/ui/notifications/status)' : ''}.`
    : 'This token is the ADMIN token: it can control every device and manage per-device tokens (/api/admin/tokens).'

  const toolLines = TOOLS.map((t) => {
    const params = Object.entries(t.parameters.properties).map(([k, v]) => `${k}${t.parameters.required.includes(k) ? '' : '?'}:${v.type}`).join(', ')
    return `  ${t.name}(${params})\n      ${t.description.split('. ')[0]}.`
  }).join('\n')

  return `# DEVICE RELAY — AI AGENT BOOTSTRAP
You (the AI) are the ONLY operator of a real Android phone. The human will not touch it.
Everything you need is below. Do not ask the human for URLs, tokens or ids.

## 1. Credentials (already filled in)
export RELAY_URL="${origin}"
export RELAY_TOKEN="${token}"
export RELAY_DEVICE="${target?.deviceId ?? ''}"
${scope}
Human live monitor (share with the user if they want to watch): ${origin}/monitor/${token}

## 2. Live device status (at the time of this request)
${deviceLine}
Re-check any time:  curl -s -H "Authorization: Bearer $RELAY_TOKEN" $RELAY_URL/api/devices

## 3. Fastest way: the phone.sh helper (bash + curl + python3, no install)
curl -sS "$RELAY_URL/phone.sh" -o phone.sh && chmod +x phone.sh
./phone.sh devices                 # phones + online state
./phone.sh ui                      # visible UI elements: text, id, center (cx,cy) in ORIGINAL pixels  <-- observe with this first
./phone.sh ui "search"             # filter elements
./phone.sh shot screen.png         # PNG screenshot (downscaled; header X-Image-Scale). Open it with your image viewer tool.
./phone.sh open "Chrome"           # launch app by name or package
./phone.sh tapel "Sign in"         # tap element by text / content-description
./phone.sh tapid btn_login         # tap element by view id
./phone.sh type "hello" submit     # type into focused field (+ Enter). Focus a field first with tapel.
./phone.sh waitfor "Inbox" 8000    # wait until an element with that text appears (ms timeout)
./phone.sh find "Privacy"          # scroll down until text appears, then tap it
./phone.sh tap 540 990 | dtap X Y | long X Y [ms] | swipe X1 Y1 X2 Y2 [ms] | drag X1 Y1 X2 Y2 | pinch X Y SCALE | scroll down|up|left|right
./phone.sh back | home | recents | notif | qs | lock | wake | wait 1000 | app | apps | url https://... | info | notifs | clip "text" [paste]
./phone.sh batch '[{"name":"open_app","arguments":{"text":"Chrome"}},{"name":"wait_for_element","arguments":{"text":"Search"}},{"name":"capture_screen"}]'
./phone.sh shot screen.png 1080 jpeg   # high-res JPEG when you need fine detail
./phone.sh look [grid] ["#color"...]   # v1.8 observe: screenshot(look.png) + OCR lines + app + colours + diff in ONE call
./phone.sh press "Skip" [fallbackX fallbackY]  # v1.8 smart_tap: ui → OCR → fallback, verifies the screen changed
./phone.sh popups                      # v1.8 dismiss_popups: close ads/permission/rating dialogs
./phone.sh until '<action json>' '<observation json>' [maxTries]   # v1.8 do_until
./phone.sh history [n]                 # v1.8 recent_actions: what was done on this phone (also by previous sessions)
./phone.sh call <tool> '<json args>'   # any tool below

## 4. Raw HTTP (if you prefer curl / another language)
Auth header on every call:  Authorization: Bearer $RELAY_TOKEN
POST $RELAY_URL/api/devices/$RELAY_DEVICE/tools/call   body {"name":"<tool>","arguments":{...}}
POST $RELAY_URL/api/devices/$RELAY_DEVICE/tools/<tool>  body {...args}
GET  $RELAY_URL/api/devices/$RELAY_DEVICE/screenshot.png
GET  $RELAY_URL/api/tools/schema?format=openai|anthropic|gemini|openapi
MCP (Streamable HTTP, token in URL, no header needed):  ${origin}/mcp/${token}

## 5. Tools
${toolLines}

## 5b. Memory from previous sessions on ${target?.deviceId ?? 'this device'} (remember/recall)
${notesBlock}

## 5c. Saved macros on this device (run_macro / save_macro / list_macros)
${macrosBlock}

## 6. Operating rules
0. START of every session: recall (notes for this app are in 5b) + history 10 (what the last session did) + look. Then act.
1. Observe before acting: "ui" first (exact, cheap). Use "look" (observe) when visuals matter (games, images, WebView) or when ui is empty — it gives image + text + app + diff at once.
2. After every action that changes the screen, observe again and verify before the next step.
3. Coordinates are ORIGINAL screen pixels (screen.w x screen.h). Elements from "ui" are already original. Screenshot px / scale = original.
4. Prefer open_app, press (smart_tap), tapel/tapid, type over raw coordinates. Use waitfor / wait_for_text after actions that load content.
4b. Unexpected dialog/ad/permission prompt? Call popups (dismiss_popups) once, then look again. Do not hand-craft taps for common dismiss buttons.
5. Handle popups / permission dialogs / keyboards sensibly, then continue toward the goal.
6. If the phone is offline or a11y=false, tell the human exactly what to enable on the phone; do not loop.
7. Never invent screen content; never claim success without an observed confirmation. Report steps + final result briefly.
8. Use "batch" to chain predictable steps (open → waitfor → tap → type → shot) in ONE call; it stops at the first failure and returns every step result.
9. Input actions are serialized per phone (a queue); read-only actions (shot/ui/notifs) run in parallel. Results include queuedMs when they had to wait.
10. For OTP codes / incoming messages use "notifs" (get_notifications) instead of opening apps.
11. Read section 5b first; after finishing, "remember" anything a future session would need (layouts, coordinates, quirks). Keep notes short and factual.

## 7. GAME PLAYBOOK (canvas / OpenGL apps have NO ui tree — vision + precise input only)
Setup (once per game):
  a. ./phone.sh shot g.png 1080 jpeg 100     # high-res + grid every 100px → read exact coordinates off the labelled grid
  b. Identify controls/HUD. "remember" their coordinates: "GameX: jump=(950,2100) fire=(200,2100) hp-bar y=180 x 120..960".
  c. Sample key colours with get_pixels (e.g. HP bar red, enemy colour) and "remember" them for find_color.
Loop (each turn, ONE round-trip):
  ./phone.sh see tap 540 1500                # act_and_see: action + wait + screenshot in one call
  ./phone.sh see swipe 300 1800 800 1800 150 # ... or any input tool
  Add grid/region when precision matters:  ./phone.sh call act_and_see '{"action":{"name":"tap","arguments":{"x":540,"y":1500}},"grid":100,"region":{"x":0,"y":1400,"w":1080,"h":600}}'
Timing-critical input (executed on the phone, no network jitter):
  tap_sequence  [{x,y,delayMs,durationMs}...]  → combos, rhythm, rapid menus
  repeat_tap    x y count intervalMs           → auto-clicker / skip dialogues
  swipe_path    [{x,y}...] duration            → joystick arcs, drawing, slingshots, pattern unlock
  multi_tap     [{x,y},{x,y}] duration         → press two buttons at once
  long_press / drag (holdMs)                   → charge shots, drag units
Cheap perception (no image transfer):
  get_pixels [{x,y}...]         → read HP/cooldown/state colours in ~50ms
  find_color "#rrggbb" tol region → locate enemies/gems/buttons; returns centre + bbox + count
  wait_for_screen change|stable → wait for a level to load / animation to end instead of guessing sleeps
Reflexes (v1.6 — the phone waits/reacts, you don't poll):
  watch_color "#rrggbb" region appear=true|false timeoutMs → blocks until colour appears/vanishes; returns cx,cy,waitedMs
  wait_pixel x y "#rrggbb" appear                        → same for one pixel (cooldown ready, lane clear)
  tap_color "#rrggbb" [region] [offsetX/Y]              → find + tap in one call
  screen_diff                                             → which regions changed since last call (changedPct, boxes) — cheap "what happened?"
  find_image <base64 template> [region] threshold         → locate an icon/sprite you cropped earlier (capture_screen region=...)
  game_loop when={find_color…} then={tap x:"$cx" y:"$cy"} stopWhen={…} iterations → server runs the whole loop; ONE call replaces 20-60
  save_macro name steps[] / run_macro name              → reusable sequences (open game, skip intro, daily reward)
Composite intelligence (v1.8 — fewer, smarter round-trips):
  observe [grid] [colors] [region]   → image + OCR lines + app + colour hits + what changed, in parallel. Your default look in games.
  smart_tap "label" [fallback{x,y}]  → ui element → OCR text → fallback; returns via + changed. Use for any named button.
  do_until action={...} until={observation}  → e.g. action=smart_tap "Skip" until=wait_for_text "PLAY": repeats until the screen says so.
  dismiss_popups [extra labels]     → clears ads/permissions/rating prompts; call it when something unexpected covers the game.
  recent_actions                     → what you (or the previous session) already did; avoid repeating a failed approach.
  remember auto-tags notes with the current game package; recall app="current" shows only this game's notes.
OCR (v1.7 — read text where there is no ui tree):
  read_text [region]           → all visible text lines with cx,cy (scores, timers, dialogue, menus in games)
  tap_text "PLAY" [region]     → OCR + tap; the game-world tap_element
  wait_for_text "LEVEL COMPLETE" / appear=false "Loading" → wait on text instead of guessing
  find_colors ["#a","#b",...]  → several colours in one frame (enemies + gems + HP at once)
  session_stats                → your own success rate / latency; adapt if flaky
  live_preview true            → stream frames to the human's /monitor page when they want to watch
Decision guide: named button anywhere → smart_tap. Popup in the way → dismiss_popups. Text on screen → tap_text / wait_for_text. Known button position → tap/tap_sequence. Moving/coloured target → tap_color or game_loop. Unknown layout → shot with grid, then remember. Waiting for something → watch_color / wait_pixel / wait_for_screen, never sleep-polling.
Rules for games: never spam raw "tap" in a loop over the network — use repeat_tap/tap_sequence. Prefer region crops at maxWidth 1080 over full-screen 540 when reading small text. Verify outcomes with find_color/get_pixels before claiming a win. If the game shows a permission/ad/popup, handle it, then "remember" how you dismissed it.
`
}
