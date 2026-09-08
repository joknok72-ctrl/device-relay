import type { AuthContext, DeviceInfo, GameProfile, Macro, Note, PlaySession, ScreenLabel } from './types'
import { TOOLS } from './tools'

/**
 * Self-describing bootstrap document for AI agents.
 * A human only has to paste ONE url into a new chat:  <origin>/agent/<token>
 * The agent fetches it and gets everything: credentials, commands, tools, rules, live device status.
 */
export interface BootstrapExtras { profiles?: GameProfile[]; sessions?: PlaySession[]; currentApp?: string; appLabels?: Record<string, string> }

export function agentBootstrap(origin: string, token: string, devices: DeviceInfo[], auth?: AuthContext & { readOnly?: boolean }, notes: Note[] = [], macros: Macro[] = [], screens: ScreenLabel[] = [], extras: BootstrapExtras = {}): string {
  const profiles = extras.profiles ?? []
  const sessions = extras.sessions ?? []
  const currentApp = extras.currentApp ?? ''
  const fmtProfile = (p: GameProfile) => {
    const lines: string[] = [`  ▶ ${p.label ?? extras.appLabels?.[p.app] ?? p.app}  (${p.app})${p.genre ? `  genre=${p.genre} → see playbook 7.${p.genre}` : '  genre=? (set with game_profile genre=...)'}`]
    const ctl = Object.entries(p.controls); if (ctl.length) lines.push('    controls: ' + ctl.map(([k, v]) => `@${k}=(${v.x},${v.y})${v.reactMs ? `~${v.reactMs}ms` : ''}${v.note ? ` "${v.note}"` : ''}`).join('  '))
    const col = Object.entries(p.colors); if (col.length) lines.push('    colors:   ' + col.map(([k, v]) => `@${k}=${v.hex}${v.tolerance ? `±${v.tolerance}` : ''}`).join('  '))
    const reg = Object.entries(p.regions); if (reg.length) lines.push('    regions:  ' + reg.map(([k, v]) => `@${k}={${v.x},${v.y},${v.w}x${v.h}}`).join('  '))
    const set = Object.entries(p.settings); if (set.length) lines.push('    settings: ' + set.map(([k, v]) => `@${k}=${JSON.stringify(v)}`).join('  '))
    if (p.bestScore !== undefined || p.lastReport) {
      const r = p.lastReport
      lines.push(`    progress: ${p.bestScore !== undefined ? `best score ${p.bestScore}` : ''}${p.reports ? ` · ${p.reports} reports` : ''}`)
      if (r) lines.push(`    last session (${new Date(r.ts).toISOString().slice(0, 10)}${r.outcome ? `, ${r.outcome}` : ''}${r.score !== undefined ? `, score ${r.score}` : ''}${r.level ? `, ${r.level}` : ''}): ${r.summary}${r.nextTime ? `\n    NEXT TIME: ${r.nextTime}` : ''}${r.learned?.length ? `\n    learned: ${r.learned.join(' | ')}` : ''}${r.blockers?.length ? `\n    blockers: ${r.blockers.join(' | ')}` : ''}`)
    }
    return lines.join('\n')
  }
  const profilesBlock = profiles.length === 0
    ? '  (none yet — after sample_colors + calibrate, save with game_profile set:{controls:{jump:{x,y}}, colors:{enemy:{hex}}, regions:{score:{x,y,w,h}}} so the NEXT chat starts instantly)'
    : profiles.map(fmtProfile).join('\n')
  const sessionsBlock = sessions.length === 0
    ? '  (no play history yet)'
    : sessions.slice(0, 8).map((s) => `  ${new Date(s.start).toISOString().slice(0, 16).replace('T', ' ')}  ${Math.max(1, Math.round((s.end - s.start) / 60000))}min  ${s.label ?? s.app}  ${s.commands} cmds${s.failed ? ` (${s.failed} failed)` : ''}${s.report ? `  → ${s.report.outcome ?? 'report'}${s.report.score !== undefined ? ` ${s.report.score}` : ''}: ${s.report.summary.slice(0, 80)}` : '  (no report)'}`).join('\n')
  const cur = profiles.find((p) => p.app === currentApp)
  const curNotes = notes.filter((n) => n.app === currentApp)
  const curMacros = macros.filter((m) => m.app === currentApp)
  const quickStart = currentApp
    ? `## 0. QUICK START — the phone is currently in: ${cur?.label ?? extras.appLabels?.[currentApp] ?? currentApp}  (${currentApp})
${cur ? `You already know this game${cur.genre ? ` (genre: ${cur.genre} → follow playbook 7.${cur.genre})` : ' (genre unknown — set it: game_profile genre=...)'}. Use the @names below directly (tap at:"@jump", joystick at:"@stick", aim at:"@look", fire_burst at:"@fire", read_number region:"@score") — do NOT rediscover.
${fmtProfile(cur)}` : 'No profile for this app yet → first turn: observe + sample_colors, calibrate each control, then game_profile set:{...}.'}
${curNotes.length ? `Notes for this game: ${curNotes.map((n) => n.text).join(' | ')}` : ''}
${curMacros.length ? `Macros for this game: ${curMacros.map((m) => `run_macro "${m.name}"`).join(', ')}` : ''}
Suggested first call:  ${cur ? './phone.sh look' : './phone.sh look 100 && ./phone.sh palette'}
When you finish (or get stuck):  session_report summary="..." outcome=win|loss|progress|stuck score=N nextTime="..."  — mandatory, it is how the next chat gets smarter.
`
    : ''
  const screensBlock = screens.length === 0
    ? '  (none yet — label_screen "main-menu" etc. once per distinct screen; then observe/identify_screen tell you where you are)'
    : screens.map((s) => `  ${s.name}${s.app ? `  (${s.app})` : ''}${s.words.length ? `  words: ${s.words.slice(0, 5).join(' ')}` : ''}`).join('\n')
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
${quickStart}
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
./phone.sh objects '#rrggbb' [tol] [x,y,w,h]   # v1.9 find_objects: each blob (cx,cy,area) sorted by size
./phone.sh react '#rrggbb' [x,y,w,h] [maxTriggers] [timeoutMs]   # v1.9 auto_react: phone taps the colour the instant it appears (reflex loop)
./phone.sh label "main-menu" | which | screens     # v1.9 screen memory: label current screen / identify / list
./phone.sh rec start <name> | rec stop | rec status | rec cancel   # v2.0 record_macro: your next input calls become a replayable macro
./phone.sh react2 '<json auto_react args with lanes/stopColor>'    # v2.0 multi-lane reflex loop
./phone.sh memory | memory wipe <package|all> | memory export > backup.json   # v2.2 per-game AI memory
./phone.sh palette [x,y,w,h] | track '#rrggbb' [x,y,w,h] | num [x,y,w,h] [label] | watchnum <change|increase|decrease|above|below> [value] [x,y,w,h] | calib X Y   # v2.1
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

## 5d. Labelled screens on this device (label_screen / identify_screen — observe returns screenName)
${screensBlock}

## 5f. GAME PROFILES — structured knowledge you can reference by @name in ANY tool argument (game_profile)
${profilesBlock}
  Syntax: at:"@jump" (or x:"@jump", y:"@jump"), "@jump+20,-10" offsets, color:"@enemy", region:"@hud", colors:["@a","@b"], stopColor:"@gameover". Unknown @name → the error lists what exists.
  Save as soon as you learn: game_profile set:{controls:{jump:{x:950,y:2100,reactMs:120}}, colors:{enemy:{hex:"#ff2020",tolerance:30}}, regions:{score:{x:0,y:60,w:500,h:120}}, settings:{lanes:4}}. game_profile history=true shows past sessions (with their reports).
  game_profile verify=true  → checks every @color/@region against the live screen and lists stale entries (use after a game update or when @names stop working).
  observe is PROFILE-AWARE (v2.4): when a profile exists it also returns game.objects (each @color → count + biggest blobs) and game.values (numeric @regions like @score → number). One look = full game state.
  session_report at the end of EVERY session (summary, outcome, score, learned[], nextTime). bestScore is tracked; the next chat sees the last report in QUICK START and 5f.

## 5g. Play history on this device (most recent first)
${sessionsBlock}

## 5e. Memory hygiene
Everything above (notes, macros, screens) is grouped per app package. If the user says a game was UPDATED / looks different / your notes are wrong:
  recall forget="app" [app=<package>]   → wipe that game's notes (macros/screens: list_macros delete=..., identify_screen delete=...)
  ./phone.sh memory                     → see everything grouped per game  ·  ./phone.sh memory wipe <package>  → wipe one game
The human can also review/delete/export all of it visually in the owner panel (/setup, section "ذاكرة الـ AI"). Never keep relying on notes that contradict what you observe — delete them and re-learn.

## 6. Operating rules
0. START of every session: read section 0 (QUICK START, incl. the previous session's report and NEXT TIME advice) and 5f (profiles). END of every session: session_report. If a profile exists for the current game, use its @names immediately — never re-run sample_colors/calibrate for known controls. Otherwise: look → palette → calibrate → game_profile set. Then history 10 to avoid repeating a failed approach.
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
You will play MANY different games. First thing in any game: decide its genre and store it (game_profile genre=shooter|runner|puzzle|rhythm|strategy|rpg|racing|fighting|casual) — then follow that genre's section below. Switching games = switching profiles automatically (everything is keyed by package); never carry @names or assumptions from one game into another.

### 7.shooter — Free Fire, PUBG, CoD Mobile, Brawl Stars, any twin-stick / FPS / TPS  (needs Android app v2.5+)
  Controls to find & save once: @stick (movement joystick centre, usually bottom-left), @look (empty area on the right half for camera drag), @fire (fire button, bottom-right), @aim/@scope, @jump, @crouch, @reload, @skill1.. ; colours: @enemy (enemy nameplate/outline or health-bar red), @teammate, @loot; regions: @hp (own health bar), @ammo, @minimap, @killfeed.
  Move:   joystick at:"@stick" direction:"up" duration:2000 release:false      (hold-to-run; call again with another direction to steer; finger op=up finger=0 to stop)
  Look:   aim at:"@look" dx:+/-N dy:+/-N   (turn right = +dx; look up = -dy). Fine aim: dx 30-80. 180° turn: dx 600-900. Measure once: aim dx:200 then observe how far the world moved; remember the ratio.
  Shoot:  fire_burst at:"@fire" count:6 intervalMs:80  (or holdMs:1500 for auto weapons). Everything runs on separate fingers: you can move + aim + fire simultaneously via combo.
  Find enemies: observe (profile-aware) → game.objects["@enemy"] gives each enemy's cx,cy. Enemy at cx > screen centre → aim dx = (cx - centerX) * ratio. Then fire_burst. Verify with observe (did the count drop? did @hp change?).
  Reflex: auto_react color:"@enemy" region:"@crosshairZone" tapX/tapY at:"@fire" → phone fires the instant an enemy crosses the crosshair (~80 ms).
  Loop per engagement (ONE combo): [{op:"joystick",at:"@stick",direction:"up-right",duration:400,release:false},{op:"aim",at:"@look",dx:60},{op:"fire",at:"@fire",count:5},{op:"up",finger:-1}]  then observe.
  Survival: watch_value region:"@hp" condition:below value:30 → retreat (joystick away + heal button). Read @ammo before fights; tap @reload when low. Ads/lobby popups → dismiss_popups.
  Safety: ALWAYS finish with finger op=up finger=-1 — a finger left down keeps the character running.
### 7.runner — Subway Surfers, Temple Run, endless runners
  Save @lanes (left/mid/right x), @jumpSwipe start; colours: @obstacle, @coin, @train. Use track_object on @obstacle to get arrival time; auto_react lanes with swipe reactions: {color:"@obstacle",region:"@laneMid",swipe:{dx:0,dy:-600}} = jump when it reaches the hit zone. read_number region:"@score" after the run, session_report with score.
### 7.puzzle — match-3, 2048, word/sudoku, merge
  ui tree usually EMPTY: observe with grid:100 + find_objects per tile colour to build the board as a matrix (cx,cy per tile). Reason about the whole board BEFORE acting; execute moves with swipe / drag (holdMs for drag-and-drop). Verify each move with observe.changed. wait_for_screen stable before reading the next board.
### 7.rhythm — Piano Tiles, Beatstar, Cytus
  Save @lane1..@laneN tap points and a thin @hitline region per lane; auto_react lanes:[{color:"@note",region:"@hit1",tapX,tapY},...] stopColor:"@gameover" maxTriggers:200 timeoutMs:40000 — the phone plays the song; you only restart it. Do not tap from the network.
### 7.strategy / rpg — Clash Royale, Clash of Clans, idle RPGs, card games
  UI-heavy: prefer smart_tap / tap_text / read_number (elixir, gold, timers) over vision. Timers: watch_value condition:equals value:0. Long deploy = long_press / drag. Save @card1..@card4, @deployZone regions. Turn loops: observe → decide → batch of taps → wait_for_screen stable.
### 7.racing — Asphalt, Hill Climb, kart games
  Save @gas @brake @left @right (or tilt is off). Hold controls with finger op=down (gas) while tapping steer; combo: [{op:"down",finger:0,at:"@gas"},{op:"tap",at:"@left",delayMs:300},{op:"tap",at:"@left",delayMs:200}, ...]. track_object on the road edge colour to anticipate turns.
### 7.fighting — Shadow Fight, MK Mobile, Street Fighter
  Save @punch @kick @block @special, @dpad directions. Specials = combo with delayMs 50-80 between taps. watch_value region:"@enemyHp" condition:decrease to confirm hits; read @myHp to decide block vs attack.
### 7.casual — tap games, clickers, mini-games, quizzes
  smart_tap + repeat_tap + read_number cover 90%. dismiss_popups before every step (ads). For quizzes: read_text → reason → tap_text the answer.

General (all genres):
Setup (once per game):
  a. ./phone.sh shot g.png 1080 jpeg 100     # high-res + grid every 100px → read exact coordinates off the labelled grid
  b. Identify controls/HUD and SAVE them as @names: game_profile genre=... set:{controls:{jump:{x:950,y:2100}, fire:{x:200,y:2100}}, regions:{hp:{x:120,y:170,w:840,h:20}}}.
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
Reflexes v2 + object detection + screen memory (v1.9):
  find_objects "#rrggbb" [region] minSize  → EVERY blob of that colour (cx,cy,bounds,area) sorted by size. find_color gives one averaged centre (often empty space between enemies); find_objects gives each target.
  auto_react "#rrggbb" region maxTriggers timeoutMs [tapX/tapY | tapOffsetX/Y] → the PHONE taps the colour within ~80ms of it appearing, repeatedly. Use for whack-a-mole, rhythm hit-lines (thin region), "tap when green", catching items. One call replaces a whole reflex loop over the network.
  label_screen "name"  once per distinct screen (menu, playing, level-complete, game-over, shop, ad). Afterwards observe returns screenName and identify_screen gives confidence.
  identify_screen  → where am I? null = new screen → look + label it. Usable as do_until/game_loop condition (matches when any label is recognised).
Discovery, motion, numbers, calibration (v2.1):
  sample_colors [region]      → the dominant NON-grey colours with hex + share + centre. Do this FIRST in a new game instead of guessing hex values; then use those hexes everywhere.
  track_object "#rrggbb" [region] samples intervalMs predictMs → velocity (px/s), direction, speed and predicted {x,y}: tap where the target WILL be; use speed~0 to know it stopped.
  read_number [region] [label] → score / coins / timer / HP as a NUMBER (handles 1,250 · 12.5K · 03:45 · 87%). Crop a region around the digits.
  watch_value condition=increase|decrease|above|below|equals|change value [region] → blocks until the number does that: "did my move score?", "timer hit 0?", "HP below 30?".
  calibrate x y                → tap + measure reactedMs via screen_hash. Run once per newly found control, then remember "jump=(950,2100) reacts in ~120ms".
Learning + multi-lane reflexes (v2.0):
  record_macro start=true name="open-level"  → then do the steps normally (open_app, smart_tap, tap, type_text, wait...) → record_macro start=false. Real pauses are kept as wait steps. Next session: run_macro "open-level". Record BEFORE doing any sequence you expect to repeat.
  auto_react lanes=[{color,region,tapX,tapY},{...}] → up to 6 independent triggers in ONE phone-side loop (rhythm game: one lane per column; each lane taps its own button). A lane may swipe instead: {color,region,swipe:{dx:0,dy:-600}} = "jump when red obstacle appears".
  auto_react stopColor="#rrggbb" stopRegion={...} → loop ends the instant the game-over / level-complete colour shows, so you never tap into a menu by mistake.
  The human /monitor page now draws your taps, swipes, detections, OCR boxes, the screenName badge and a REC badge live — tell the user to open it if they want to see what you see.
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
Decision guide: unknown genre → look, decide, game_profile genre=... first. Shooter/3D → joystick + aim + fire_burst (+combo) with separate fingers. Known game (profile in 5f) → play with @names right away. New game → sample_colors, calibrate each control, then game_profile set (not just remember). Moving target → track_object then tap the predicted point. Need a score/timer/HP value → read_number / watch_value (never eyeball digits from a screenshot). About to do a repeatable sequence → record_macro first. Rhythm/multi-column reflexes → auto_react with lanes + stopColor. Several same-colour targets → find_objects then tap_sequence. Must react in <200ms → auto_react (phone-side). Lost / "which screen is this?" → identify_screen. Named button anywhere → smart_tap. Popup in the way → dismiss_popups. Text on screen → tap_text / wait_for_text. Known button position → tap/tap_sequence. Moving/coloured target → tap_color or game_loop. Unknown layout → shot with grid, then remember. Waiting for something → watch_color / wait_pixel / wait_for_screen, never sleep-polling.
Rules for games: never spam raw "tap" in a loop over the network — use repeat_tap/tap_sequence. Prefer region crops at maxWidth 1080 over full-screen 540 when reading small text. Verify outcomes with find_color/get_pixels before claiming a win. If the game shows a permission/ad/popup, handle it, then "remember" how you dismissed it.
`
}
