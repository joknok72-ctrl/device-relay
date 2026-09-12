import type { AuthContext, DeviceInfo, GameProfile, Macro, Note, Playbook, PlaySession, ScreenLabel } from './types'
import { TOOLS } from './tools'

/**
 * Self-describing bootstrap document for AI agents.
 * A human only has to paste ONE url into a new chat:  <origin>/agent/<token>
 * The agent fetches it and gets everything: credentials, commands, tools, rules, live device status.
 */
export interface BootstrapExtras { profiles?: GameProfile[]; sessions?: PlaySession[]; currentApp?: string; appLabels?: Record<string, string>; playbooks?: Record<string, Playbook>; }

/** v4.7.3 render one playbook (the AI's own expertise file) verbatim so the new chat inherits skill, not just facts. */
function fmtPlaybook(pb: Playbook, title: string): string {
  const L: string[] = [`  █ ${title}${pb.skill ? `  — self-rated skill ${pb.skill}/5` : ''}  (${pb.updates} updates, last ${new Date(pb.ts).toISOString().slice(0, 10)})`]
  if (pb.overview) L.push(`    OVERVIEW: ${pb.overview}`)
  const sec = (name: string, arr: string[], numbered = false) => { if (arr.length) { L.push(`    ${name}:`); arr.forEach((x, i) => L.push(`      ${numbered ? `${i + 1}.` : '•'} ${x}`)) } }
  sec('STRATEGY (rules of thumb, in priority order)', pb.strategy, true)
  sec('PROCEDURE (one move / turn — follow exactly)', pb.procedure, true)
  sec('TRICKS that worked', pb.tricks)
  sec('MISTAKES — never repeat', pb.mistakes)
  sec('SCREENS (recognise + what to press)', pb.screens)
  sec('FACTS', pb.facts)
  if (pb.calibration && Object.keys(pb.calibration).length) L.push(`    CALIBRATION (exact numbers the algorithm relies on): ${Object.entries(pb.calibration).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  ')}`)
  if (pb.algorithm?.code) {
    L.push(`    ALGORITHM${pb.algorithm.lang ? ` (${pb.algorithm.lang})` : ''} — your complete planner from the last chat. Re-use it AS IS (paste into your scratchpad / run it) instead of inventing a new one; verify its first 1-2 moves against the live screen before trusting it blindly, then keep improving it.${pb.algorithm.description ? ` ${pb.algorithm.description}` : ''}`)
    L.push('    PRECEDENCE: whatever this ALGORITHM / PROCEDURE / CALIBRATION says about HOW to observe or act for THIS game (which tools, which regions, screenshot vs play_frame, timings, 3x3 scans, separate OCR calls…) OVERRIDES the general advice in sections 6 and 7 of this document. The general rules are defaults for unknown games; the playbook is measured knowledge about this one.')
    L.push('    -----8<----- ALGORITHM START -----8<-----')
    L.push(pb.algorithm.code.split('\n').map((l) => '    ' + l).join('\n'))
    L.push('    -----8<----- ALGORITHM END -----8<-----')
  } else L.push('    ALGORITHM: (none saved yet — when you write a planner/scoring function for this game, save it: playbook {merge:{algorithm:{lang, description, code}}}; without it the next chat cannot reproduce your play quality)')
  return L.join('\n')
}

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
    if (p.strategies?.length) lines.push('    strategies (learned autopilot policies, best first): ' + p.strategies.map((s) => `${s.name} f=${s.fitness} (${s.runs} runs, +${s.gained}, ${s.deaths} deaths)`).join('  ') + `  → play_loop {strategy:"best"} replays #1; play_loop {strategy:"${p.strategies[0].name}"} for a specific one`)
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
  const playbooks = extras.playbooks ?? {}
  const curPb = currentApp ? playbooks[currentApp] : undefined
  const genPb = playbooks['*']
  const curNotes = notes.filter((n) => n.app === currentApp)
  const curMacros = macros.filter((m) => m.app === currentApp)
  const quickStart = currentApp
    ? `## 0. QUICK START — the phone is currently in: ${cur?.label ?? extras.appLabels?.[currentApp] ?? currentApp}  (${currentApp})
${cur ? `You already know this game${cur.genre ? ` (genre: ${cur.genre} → follow playbook 7.${cur.genre})` : ' (genre unknown — set it: game_profile genre=...)'}. Use the @names below directly (tap at:"@jump", joystick at:"@stick", aim at:"@look", fire_burst at:"@fire", read_number region:"@score") — do NOT rediscover.
${fmtProfile(cur)}` : 'No profile for this app yet → first turn: observe + sample_colors, calibrate each control, then game_profile set:{...}.'}
${curPb ? `
### YOUR PLAYBOOK FOR THIS GAME — written by you in earlier chats. This IS your experience: apply it from the very first move, do not re-learn, do not experiment with things listed under MISTAKES. It restores your PROGRAM and NUMBERS; the outcome still has to be verified live (observe before/after the first move, read score/level by OCR). GAME-SPECIFIC INSTRUCTIONS HERE TAKE PRIORITY over any conflicting general rule below (tool choice, observation method, timings).
${fmtPlaybook(curPb, cur?.label ?? extras.appLabels?.[currentApp] ?? currentApp)}
→ Keep it current: playbook {merge:{tricks:[...], mistakes:[...], strategy:[...]}} whenever you learn something; raise skill when you clearly play better.` : `
No playbook for this game yet. After your first ~10 successful moves call playbook {merge:{overview:"...", strategy:[...], procedure:[...], facts:[...], skill:1}} — that file is what lets the NEXT chat restore your program and numbers (its results still need live verification).`}
${genPb ? `
### GENERAL PLAYBOOK (all games) — your cross-game skills
${fmtPlaybook(genPb, 'ANY GAME')}` : ''}
${curNotes.length ? `Notes for this game: ${curNotes.map((n) => n.text).join(' | ')}` : ''}
${curMacros.length ? `Macros for this game: ${curMacros.map((m) => `run_macro "${m.name}"`).join(', ')}` : ''}
Suggested first call:  ${cur ? './phone.sh look' : './phone.sh look 100 && ./phone.sh palette'}
When you finish (or get stuck):  1) playbook {merge:{..., algorithm:{lang,description,code}, calibration:{...}}} with everything you learned this session INCLUDING the full planner code you used, then 2) session_report summary="..." outcome=win|loss|progress|stuck score=N nextTime="..."  — both mandatory, they are how the next chat plays at your level.
`
    : ''
  // playbooks of games that are NOT open right now (so the agent knows what it already masters)
  const otherPbs = Object.entries(playbooks).filter(([app]) => app !== '*' && app !== currentApp)
  const otherPbBlock = otherPbs.length ? `\n## 5g. Playbooks for other games you already know (open one with open_app and its playbook applies)\n${otherPbs.map(([app, pb]) => fmtPlaybook(pb, extras.appLabels?.[app] ?? profiles.find((p) => p.app === app)?.label ?? app)).join('\n')}\n` : ''
  const genPbOnly = !currentApp && genPb ? `\n## 5h. GENERAL PLAYBOOK (all games)\n${fmtPlaybook(genPb, 'ANY GAME')}\n` : ''
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
⚠ HTTP CLIENT RULE: always send a User-Agent header, e.g. "User-Agent: device-relay-agent/1.0". Cloudflare's edge rejects requests whose UA is Python-urllib/* or libwww-perl/* with "403 error code: 1010" BEFORE they reach this server — that is NOT a token problem. curl / requests / httpx / fetch / axios are fine; if you use urllib.request set req.add_header("User-Agent","device-relay-agent/1.0"). A 403 whose body is JSON {"error":...} comes from this server (token/scope); a 403 HTML page with "error code: 1010" is the UA block.

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

## 5i. Play history on this device (most recent first)
${sessionsBlock}
${otherPbBlock}${genPbOnly}
## 5j. Built-in game bots (run ON the phone, no round-trips)
  domino_bot — Domino "All Fives / أمريكاني" 1v1 in com.big.ludocafe (10-second turns). op:"start" (startDelayMs default 3500: the user switches back to the game) → the phone reads hand + table from screenshots every ~300 ms, picks the best move (immediate points − expected opponent reply over unseen tiles + blocking + hand flexibility + heavy-tile dumping) and drags the tile exactly onto the open end; op:"status" shows moves/fails/log, op:"stop", op:"analyze" = one frame (hand, table, ends, ranked moves) to debug the vision. The human has the same buttons on /setup. When the user asks you to play THIS game: do NOT hand-play tile by tile — start the bot, then watch status and only intervene if it reports fails.

## 5e. Memory hygiene
Everything above (notes, macros, screens) is grouped per app package. If the user says a game was UPDATED / looks different / your notes are wrong:
  recall forget="app" [app=<package>]   → wipe that game's notes (macros/screens: list_macros delete=..., identify_screen delete=...)
  ./phone.sh memory                     → see everything grouped per game  ·  ./phone.sh memory wipe <package>  → wipe one game
The human can also review/delete/export all of it visually in the owner panel (/setup, section "ذاكرة الـ AI"). Never keep relying on notes that contradict what you observe — delete them and re-learn.

## 6. Operating rules
PRECEDENCE: rules 1-13 below are DEFAULTS for unknown apps. When section 0 contains a PLAYBOOK (ALGORITHM / PROCEDURE / CALIBRATION / TRICKS) for the current game, its game-specific instructions WIN over any conflicting default here or in section 7 (e.g. if the playbook says to read the board with separate capture_screen + 3x3 scans or separate OCR calls, do that even though the defaults prefer play/play_frame). Only MISTAKES are absolute.
0. START of every session: read section 0 (QUICK START: your PLAYBOOK for this game = your accumulated expertise, the previous session's report and NEXT TIME advice) and 5f (profiles). A new chat RESTORES the same program: the playbook's ALGORITHM + CALIBRATION + STRATEGY + PROCEDURE are re-used from move one, existing @names are not recalibrated, nothing under MISTAKES is retried. The RESULT is not guaranteed by the file alone — verify on the live screen (one observation before the first move, one after) and treat any mismatch (different screen size, moved buttons, new game version) as a reason to re-check that item, update the playbook, and continue; never claim equal performance without measured evidence (score/level read by OCR). YOU are the player: there are no bots — when the user says "play" / "العب" you play, live, with the fast loop in section 7a. END of every session: session_report. If a profile exists for the current game, use its @names immediately — never re-run sample_colors/calibrate for known controls. Otherwise: look → palette → calibrate → game_profile set. Then history 10 to avoid repeating a failed approach.
1. Observe before acting: "ui" first (exact, cheap). Use "look" (observe) when visuals matter (games, images, WebView) or when ui is empty — it gives image + text + app + diff at once.
2. After every action that changes the screen, observe again and verify before the next step.
3. Coordinates are ORIGINAL screen pixels = the full-resolution screenshot size (play.frame.w/h, capture_screen w/h before scaling). Elements from "ui" are already original. Screenshot px / scale = original. NOTE: on some phones hello.screen (status/devices) is the app WINDOW (e.g. 720x1448) while screenshots/gestures use the FULL display (e.g. 720x1600) — app 4.1.7+ reports the full display; if the two differ, trust the screenshot size and record it in the playbook FACTS.
4. Prefer open_app, press (smart_tap), tapel/tapid, type over raw coordinates. Use waitfor / wait_for_text after actions that load content.
4b. Unexpected dialog/ad/permission prompt? Call popups (dismiss_popups) once, then look again. Do not hand-craft taps for common dismiss buttons.
5. Handle popups / permission dialogs / keyboards sensibly, then continue toward the goal.
6. If the phone is offline or a11y=false, tell the human exactly what to enable on the phone; do not loop.
7. Never invent screen content; never claim success without an observed confirmation. Report steps + final result briefly.
8. Use "batch" to chain predictable steps (open → waitfor → tap → type → shot) in ONE call; it stops at the first failure and returns every step result.
9. Input actions are serialized per phone (a queue); read-only actions (shot/ui/notifs) run in parallel. Results include queuedMs when they had to wait.
10. For OTP codes / incoming messages use "notifs" (get_notifications) instead of opening apps.
11. Read section 5b first; after finishing, "remember" anything a future session would need (layouts, coordinates, quirks). Keep notes short and factual.
12. EXPERTISE TRANSFER (v4.7.3): the playbook tool is your long-term skill memory — profile = WHERE things are, session_report = WHAT happened, playbook = HOW to play well. Update it (a) after the first ~10 successful moves of a new game (overview/strategy/procedure/facts), (b) the moment something fails (mistakes) or works surprisingly well (tricks), (c) before session_report. Put genre-independent lessons ("OCR the score region after every move", "wait_for_screen stable before deciding") in playbook app:"*". Anything you do NOT write there is lost when this chat ends.
13. REPRODUCIBLE SKILL (v4.7.4): if you wrote ANY code / scoring function / planner / lookup table to decide moves (a Python or JS block, a 3x3-scan heuristic, a search over candidate placements, aim math, a build order…) you MUST store it verbatim with playbook {merge:{algorithm:{lang, description, code}}} together with calibration:{...} (exact screen size the numbers were measured on, offsets, cell size, drag compensation, timings). At the START of a chat, if the playbook has an ALGORITHM block: re-use it as is (paste it into your working notes / run it), do NOT design a new one; then keep improving it and re-save. This applies to EVERY genre: puzzle planners, shooter aim/strafe rules, card-game hand evaluators, racing line timings, farming build orders, chess/board openings, rhythm timing offsets — the next chat must be able to run the same brain (and then verify it against the live screen).

## 7a. HOW TO PLAY LIVE — you are the player (v4.7: game_setup + play + play_loop(+learning +self-critique +turnBased) + react_script)
v4.7 EVERY GENRE: play_loop rules may test UI buttons and screen text — if:{ui:"end turn"} (clickable node text/id contains it), if:{text:["your turn","continue"]} (OCR) — and act with tool:{name:"tap_text",arguments:{text:"@text"}} or do:[{op:"tap",x:"@found.x",y:"@found.y"}]. turnBased (auto for puzzle/card/board/strategy/rpg/simulation/adventure/sports, or turnBased:true) waits for the screen to settle before each tick and uses 600 ms action waits so animations finish. strategy:"default" now builds a sensible starter for ALL genres (shooter/runner/racing/fighting reflex policies; turn-based flow-keepers: end-turn/next/confirm/collect buttons, highlighted tiles, threats).
v4.6 SELF-CRITIQUE: play_loop judges every rule by what happened on the NEXT tick (score up / threat cleared = good, hp down / game over = bad) and returns rules{fires,good,bad,score} + advice[] ("'dodge' hurt more than it helped — change its action", "never fired: collect — colour name wrong?"). A rule that keeps hurting is auto-skipped. Workflow: play_loop → read advice → fix ONE rule → play_loop name:"v2" → compare rank. explore:true rotates priorities when nothing is gained for 4 ticks (find what works). HYBRID: put reflex:{rules:[react_script rules], timeoutMs:3000} in a rule instead of do → that phase runs on the phone at 50 ms (e.g. if:{present:"@enemy"} → reflex aim_found+fire). Every run auto-writes a session_report, so nothing is lost if the chat ends.
v4.5 ZERO-TO-PLAYING in two calls on ANY unknown game: game_setup {} → play_loop {strategy:"default", ticks:20}. The default policy is synthesized from the genre + colour/control names (threat → dodge/shoot, coin → collect, hp low → retreat, menu → dismiss). Read its log, then write a better policy with name:"v2" and let the ranking judge.
v4.5 perception: "tracks" = every blob (up to 4 per colour) matched across ticks with its own vx/vy/dir/eta — threats are per object, not per colour; "bars" = fill % of gauges (a region named hp/energy/shield/... that has a same-named @colour) → hp=63% in summary, valueBelow works on it, "⚠ hp dropping" events. Save bars once: game_profile set:{regions:{hp:{x,y,w,h}}, colors:{hp:{hex:"#e0342a"}}}. Tokens for play_loop actions: @found.x/y, @threat.x/y, @away.x (dodge side), @center.x/y.
v4.4 LEARNING: every play_loop run is scored (score-like gains per tick × survival) and saved as a named strategy on the game profile (max 5, best first, shown in 5f/QUICK START). Known game → play_loop {strategy:"best"} FIRST, read its log, then improve the policy and run again with name:"v2" — the ranking tells you if v2 beat v1. This is how each chat gets better than the last without re-thinking from zero.
Four tools make you fast; everything else is for setup. Pick the layer by the reaction time the game needs: think every tick (play, ~1 s) → autopilot with a policy (play_loop, ~0.4 s/tick for up to 25 s) → reflexes on the phone (react_script, ~50 ms).
  • play_loop — your autopilot. Hand over an ordered policy and the relay plays up to 40 ticks alone: if:{threat:true | present:"@coin" | absent | stuck:"menu" | valueBelow:{name:"hp",value:30} | everyTicks:N} → do:[combo steps using x:"@found.x", y:"@found.y"] or tool:{...}. stopOn:{stuck:"game_over", event:"hp dropping", valueBelow}. autoMenu taps PLAY/CONTINUE/RETRY for you. Read the per-tick log, tune the policy, run again. This is how you play 5-25 s stretches without spending a turn per tick.
    v4.3 perception extras in every play/play_loop tick: deltas carry vx/vy (px/s), growth (area ratio) and etaMs; "threats" lists objects moving toward the player zone (bottom) sorted by urgency (summary shows THREAT @name eta); "memory" on tick 1 = what the previous session learned (lastOutcome, bestScore, nextTime, learned) — read it before your first move; autoMenu:true lets play tap the obvious menu button itself.
  • game_setup — UNKNOWN game? call it ONCE in-game (not on a menu). It auto-builds the profile: dominant colours → @red/@green/@yellow…, HUD digit lines → numeric @score/@hp/@coins/@time regions, clickable buttons → @controls, genre guess. Then rename what matters (game_profile set:{colors:{enemy:{hex:"@red"}}}, unset:{colors:["red"]}). Nothing is tapped.
  • play — your heartbeat. ONE round trip = act + wait + see. play {act:[combo steps]} runs joystick/aim/fire/tap on separate fingers, waits ~250 ms, and returns image + objects (every @colour of the profile, or the ones you pass) + numbers (score/hp/ammo regions) + changedPct + a one-line summary. play {} = just look. Never call capture_screen/find_objects/read_text separately while playing.
    v4.2 memory between ticks (per game): "deltas" (nearest @object moved dx/dy → dir, each number's ±change), "events" ("@enemy appeared", "@coin vanished", "score +50", "⚠ hp dropping"), "tick" counter, and "stuck" — when the screen has been static for 3 ticks it OCRs the whole screen and classifies it (menu / game_over / paused) with the visible button texts + advice. Read summary → deltas → events → stuck, in that order. play {reset:true} at the start of a new round.
  • react_script — your reflexes. Hand the phone 1-12 rules (WHEN colour/pixel/text → THEN combo steps, cooldown/priority/maxFires) and it plays the next 3-20 s at ~25 fps with ~50 ms reactions while you plan the next move. tap_found taps the matched blob; aim_found drags the camera so the crosshair lands on it (dy:-10 = head). stopRules end it on GAME OVER / death colour.
The loop:  play {} → read summary → decide → EITHER play {act:[...]} for a deliberate move OR react_script {rules, timeoutMs:8000} for a reactive phase → play {} → …  Keep each turn to ONE call; the phone does the rest.
Decision heuristics that work in ANY game: (1) moving toward you (dir down / area growing) = threat → dodge or shoot; (2) a number you want going up (score/coins) stopped for 3+ ticks = you are stuck → change strategy; (3) hp/lives dropping = retreat first, attack later; (4) stuck.kind = menu → tap the obvious button via play {tool:{name:"tap_text",arguments:{text:"PLAY"}}}; game_over → session_report, then retry; (5) nothing detected for 5 ticks → your colours are wrong: game_setup {force:true} or sample_colors and re-save.
Setup once per game (then it lives in QUICK START): game_setup {} first; if it is not enough: observe grid:100 + sample_colors → pick UNIQUE stable colours (nameplates, health bars, hit markers, outlines — not skins) → verify each with find_objects (count ≈ things on screen, 0 when absent) → calibrate controls → game_profile set:{controls,colors,regions,genre}. Measure the aim ratio once: play {act:[{op:"aim",at:"@look",dx:200}]} and compare where a landmark moved.
Speed rules: maxWidth 540-640 jpeg; regions instead of full-screen colour scans; react_script for anything reactive (obstacles, targets popping up, fire-when-red); combo instead of sequential taps; play waitMs 0-150 in fast games.
Safety: react_script lifts all fingers when it ends; after play {act:[joystick release:false]} remember to lift with {op:"up",finger:-1} or the character keeps running. Every session ends with session_report.

## 7. GAME PLAYBOOK (canvas / OpenGL apps have NO ui tree — vision + precise input only)
You will play MANY different games — action, shooter, racing, fighting, rhythm, runner, puzzle, card, board, sports, strategy, rpg, simulation, adventure, casual. First thing in any game: decide its genre and store it (game_profile genre=<one of those>; game_setup guesses it for you) — then follow that genre's section below (7.ANY if none fits). Turn-based genres (puzzle/card/board/strategy/rpg/simulation/adventure/sports) get turnBased autopilot automatically: it waits for animations, taps buttons by UI/text, and leaves the real decision to you each turn. Switching games = switching profiles automatically (everything is keyed by package); never carry @names or assumptions from one game into another.

### 7.shooter — Free Fire, PUBG, CoD Mobile, Brawl Stars, any twin-stick / FPS / TPS  (Android app v4.1+)
  Controls to find & save once: @stick (movement joystick centre, usually bottom-left), @look (empty area on the right half for camera drag), @fire (fire button, bottom-right), @aim/@scope, @jump, @crouch, @reload, @skill1.. ; colours: @enemy (enemy nameplate/outline or health-bar red), @teammate, @loot; regions: @hp (own health bar), @ammo, @minimap, @killfeed.
  Move:   joystick at:"@stick" direction:"up" duration:2000 release:false      (hold-to-run; call again with another direction to steer; finger op=up finger=0 to stop)
  Look:   aim at:"@look" dx:+/-N dy:+/-N   (turn right = +dx; look up = -dy). Fine aim: dx 30-80. 180° turn: dx 600-900. Measure once: aim dx:200 then observe how far the world moved; remember the ratio.
  Shoot:  fire_burst at:"@fire" count:6 intervalMs:80  (or holdMs:1500 for auto weapons). Everything runs on separate fingers: you can move + aim + fire simultaneously via combo.
  Find & engage: play {act:[{op:"joystick",at:"@stick",direction:"up",duration:500,release:false}]} → summary tells you "@enemy×2 nearest(cx,cy)" → play {act:[{op:"aim",at:"@look",dx:(cx-centerX)*ratio,dy:(cy-centerY)*ratio},{op:"fire",at:"@fire",count:6,intervalMs:80}]}. Verify: @enemy count dropped / kill counter rose.
  Reactive phase (fights): react_script {rules:[{name:"track",when:[{type:"color_present",color:"@enemy",minSize:8,maxSize:140}],then:[{op:"aim_found",at:"@crosshair",lookX:"@look",lookY:"@look",sensitivity:ratio,maxStep:180,dy:-10}],cooldownMs:70},{name:"fire",priority:1,when:[{type:"color_present",color:"@ring",region:"@reticle",minCount:30}],then:[{op:"fire",at:"@fire",holdMs:300}],cooldownMs:60}], stopRules:[{type:"text_present",text:"DEFEAT"}], timeoutMs:10000}. @ring = the game's own red crosshair colour → fires only when the GAME confirms the target.
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
### 7.card — Baloot, Tarneeb, UNO, Solitaire, Poker, Hearthstone-likes, Yu-Gi-Oh
  Card games are READ-then-DECIDE: read_text (or play {} with ocr regions @hand/@table/@opponent) gives ranks/suits/values; ui tree often has the cards as clickable nodes (get_ui_elements → text "K♠"). Build the state (my hand, table, scores) BEFORE every move, reason about the rule set, then ONE tap (or drag from @hand to @table). Save @hand (row region), @table, @myScore, @oppScore, @deal/@pass/@bid buttons. Bidding/pass = tap_text. Turn detection: watch for @myTurn colour/glow or text "YOUR TURN" (play_loop if:{text:["your turn"]}). Never tap while cards animate → wait_for_screen stable. Default autopilot only keeps the flow (deal/next/collect); the actual card choice is YOUR reasoning each turn.
### 7.board — Chess, Checkers, Ludo, Dominoes, Backgammon, Carrom, Go, Monopoly
  Treat the board as a matrix: find_objects per piece colour (or ui tree if the app exposes cells) → coordinates of every piece; save @boardOrigin + @cellSize in settings so cell (r,c) = origin + c*cell. A move = tap source then tap destination (or drag for Carrom/pool: drag with holdMs, aim by angle). Dice games: tap @roll, read_number the dice region, then pick the piece. Chess/checkers: enumerate legal moves from the matrix, evaluate, then move; verify with play {} that the board changed as expected (changedPct + piece positions). Turn = text "your turn"/glow colour/timer bar → play_loop turnBased (auto). Board games are pure reasoning: spend your effort on the position, not on speed.
### 7.sports — FIFA/eFootball, NBA, cricket, tennis, golf, pool, bowling, fishing
  Two families: (a) joystick + action buttons (football/basketball/hockey): controls like shooter (@stick move, @pass/@shoot/@sprint/@tackle), players = @teammate/@opponent colours, ball = @ball; run toward the goal (@goal region), pass when an opponent is closer than a teammate, shoot when @ball is inside @shootZone. (b) timing/aim games (golf, pool, bowling, cricket batting, tennis serve): a power/timing bar → find_color on @powerBar region and wait_pixel/react_script when the marker reaches the sweet spot; aim = swipe/drag from @ball to the target with the right length (calibrate once: swipe 300 px → how far did the shot go?). Read the scoreboard with @myScore/@oppScore/@time regions.
### 7.simulation — farms, tycoons, city builders, cooking, idle managers, pet/breeding games
  UI-driven and slow: read_text + get_ui_elements do most of the work; timers are the core (watch_value region:"@timer" condition:equals value:0 → collect). Loop = collect everything ready (tap_color on @readyGlow, or find_objects @coinBubble → tap_sequence), spend (tap_text "Upgrade"/"Build"), wait. Save @collectAll/@shop/@build/@upgrade/@back and every resource counter as numeric regions (coins/gems/energy/food). Use play_loop turnBased with rules on if:{ui:"collect"} / if:{present:"@readyGlow"} / if:{valueAbove:{name:"coins",value:N}} → tool tap_text "Upgrade". Progress = resource numbers rising (learning uses them automatically).
### 7.adventure — story games, point-and-click, hidden object, escape rooms, open-world exploration
  Read everything first: read_text for dialogue/choices, get_ui_elements for interactables, screenshot with grid for hidden-object scenes. Choices = tap_text the option (reason about the story). Exploration (3D): joystick @stick + camera @look like a shooter but slow; interact via @action button when a prompt text appears (wait_for_text "Press"/"Talk"/"Open" → tap @action). Hidden objects: find_image with a crop of the target, or find_objects per distinct colour; tap each candidate once (tap_sequence) and check the checklist text. Puzzles inside adventures → 7.puzzle. Keep a remember note of where you are in the story (chapter, objective) so the next chat continues instead of restarting.

### 7.ANY — the universal loop that works for every genre above (use when the game fits none, or several)
  1) game_setup {} → 2) look at what came back: numbers rising = progress metric; colours = actors; buttons = actions. 3) Decide the game's TEMPO: reflex (things move fast → play_loop default + react_script) or turn (nothing moves until you act → play_loop turnBased with if:{ui}/if:{text} rules, or plain play {act} per turn with your own reasoning). 4) Every action must be followed by a look (play does both). 5) Verify progress by a number (score/coins/level/turn counter) — if nothing you read ever changes, you are measuring the wrong thing: find the right region. 6) Menus/ads/popups are the #1 time sink in ALL genres → stuck.kind/autoMenu/dismiss_popups. 7) End with session_report (or let play_loop auto-report). The tool set is genre-agnostic: joystick/aim/fire/combo for real-time control, tap/swipe/drag/long_press for turn-based and UI games, read_text/read_number/find_objects/tracks/bars for perception, play_loop/react_script for autonomy, game_profile/strategies/notes for memory.

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
