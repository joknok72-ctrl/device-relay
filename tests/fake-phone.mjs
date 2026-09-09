// Simulates the Android client: connects via WS, replies to commands.
// Usage: node tests/fake-phone.mjs ws://localhost:3000 TOKEN deviceId
const [base = 'ws://localhost:3000', token = 'dev-secret-token-123', deviceId = 'test-phone'] = process.argv.slice(2)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const here = dirname(fileURLToPath(import.meta.url))
let hashCounter = 0, diffCounter = 0, streaming = false
// v1.9: two fake 'screens' — 'menu' (default) and 'home' (after home action); recents switches back
let screen = 'menu'
const fingersDown = new Map()
let botStore = []
let botRunning = null
let aimCfg = null; let aimRun = null
function aimStatusJson() { return { engine: 'aim', running: !!aimRun, configured: !!aimCfg, ...(aimCfg ? { name: aimCfg.name, configApp: aimCfg.app, trigger: aimCfg.trigger || 'reticle', aimEnabled: !!aimCfg.aimEnabled, autoStart: aimCfg.autoStart !== false, mode: aimCfg.mode || 'auto' } : {}), shizuku: 'ready', ...(aimRun ? (aimCfg && aimCfg.mode === 'headlock' ? { startedAt: aimRun.startedAt, frames: 240, fps: 30, firing: true, locked: true, lockErrPx: 1, locks: 3, nudges: 57, headX: 812, headY: 351 } : { startedAt: aimRun.startedAt, frames: 240, fps: 30, holding: true, holdCount: 4, heldMs: 3200, aimMoves: 12, reloads: 1 }) : {}) } }
const HASHES = { menu: 'ffff0000ffff0000ffff0000ffff', home: '0f0f0f0f0f0f0f0f0f0f0f0f0f0f' }
const FAKE_SCREEN = readFileSync(join(here, 'fake-screen.b64'), 'utf8').trim()
const ws = new WebSocket(`${base}/api/ws/phone/${deviceId}`, { headers: { Authorization: `Bearer ${token}` } })
ws.onopen = () => {
  console.log('[phone] connected')
  ws.send(JSON.stringify({ kind: 'hello', model: 'Pixel 8 (fake)', android: '15', appVersion: '1.4.0', screen: { w: 1080, h: 2400 }, accessibilityEnabled: true, battery: 77, charging: false }))
}
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.kind !== 'command') return
  console.log('[phone] got command', m.action)
  const t0 = Date.now()
  const delay = ['tap','swipe','drag','pinch','long_press','type_text','tap_sequence','repeat_tap','swipe_path','multi_tap'].includes(m.action.type) ? 300 : 50
  setTimeout(() => {
    const res = { kind: 'result', id: m.id, ok: true, durationMs: Date.now() - t0 }
    const a = m.action
    if (a.type === 'screenshot') res.screenshot = FAKE_SCREEN
    if (a.type === 'ui_dump') res.data = { package: 'com.example.spacerunner', label: 'Space Runner', count: 5, elements: [
      { i: 0, text: 'SPACE RUNNER', cls: 'TextView', cx: 540, cy: 270, bounds: '300,240,780,300' },
      { i: 1, text: 'PLAY', id: 'btn_play', cls: 'Button', cx: 540, cy: 990, bounds: '180,900,900,1080', clickable: true },
      { i: 2, text: 'SETTINGS', id: 'btn_settings', cls: 'Button', cx: 540, cy: 1270, bounds: '180,1180,900,1360', clickable: true },
      { i: 3, text: 'SHOP', id: 'btn_shop', cls: 'Button', cx: 540, cy: 1550, bounds: '180,1460,900,1640', clickable: true },
      { i: 4, hint: 'Player name', id: 'edit_name', cls: 'EditText', cx: 540, cy: 2240, bounds: '40,2160,1040,2320', editable: true, clickable: true },
    ] }
    if (a.type === 'tap_element') {
      const q = (a.text || a.elementId || '').toLowerCase()
      const hit = ['play', 'settings', 'shop', 'btn_play', 'btn_settings', 'btn_shop', 'edit_name'].find((x) => x.includes(q))
      if (hit) res.data = { matched: 1, index: 0, text: hit.toUpperCase(), cx: 540, cy: 990, method: 'action_click' }
      else { res.ok = false; res.error = `no element matching ${a.text || a.elementId}` }
    }
    if (a.type === 'type_text') res.data = { typed: a.text.length, submitted: !!a.submit }
    if (a.type === 'open_app') res.data = { package: 'com.android.chrome', label: 'Chrome' }
    if (a.type === 'list_apps') res.data = [{ package: 'com.android.chrome', label: 'Chrome' }, { package: 'com.android.settings', label: 'Settings' }]
    if (a.type === 'current_app') res.data = { package: 'com.example.spacerunner', label: 'Space Runner' }
    if (a.type === 'get_notifications') res.data = { count: 2, notifications: [
      { package: 'com.google.android.apps.messaging', app: 'Messages', title: 'Bank', text: 'Your OTP is 482913', time: Date.now() - 20000 },
      { package: 'com.whatsapp', app: 'WhatsApp', title: 'Ali', text: 'hey, are you there?', time: Date.now() - 60000 } ] }
    if (a.type === 'device_info') res.data = { battery: 77, charging: false, screenOn: true, locked: false, orientation: 'portrait', network: 'wifi', wifiSsid: 'HomeNet', freeStorageMb: 12000, package: 'com.example.spacerunner' }
    if (a.type === 'set_clipboard') res.data = { copied: a.text.length, pasted: !!a.paste }
    if (a.type === 'scroll_element') res.data = { scrolled: true, direction: a.direction }
    if (a.type === 'screenshot' && a.format === 'jpeg') res.screenshotMime = 'image/jpeg'
    if (a.type === 'screenshot' && (a.grid || a.region)) res.data = { ...(a.grid ? { grid: a.grid } : {}), ...(a.region ? { cropX: a.region.x, cropY: a.region.y, cropW: a.region.w, cropH: a.region.h } : {}) }
    if (a.type === 'tap_sequence') res.data = { taps: a.points.length }
    if (a.type === 'multi_tap') res.data = { fingers: a.points.length }
    if (a.type === 'swipe_path') res.data = { points: a.points.length }
    if (a.type === 'repeat_tap') res.data = { taps: a.count, elapsedMs: a.count * a.intervalMs }
    if (a.type === 'pixel') res.data = { pixels: a.points.map(p => ({ x: p.x, y: p.y, hex: p.y > 1200 ? '#ff0000' : '#1e293b', r: 0, g: 0, b: 0 })) }
    if (a.type === 'find_color') res.data = a.color === '#ff0000' ? { found: true, count: 1200, cx: 540, cy: 1500, bounds: { x: 500, y: 1450, w: 80, h: 100 } } : { found: false, count: 0 }
    if (a.type === 'screen_diff') { diffCounter++; res.data = diffCounter === 1 ? { baseline: true, changedPct: 0 } : { changedPct: 7.5, changedCells: 30, cells: 400, regions: [{ x: 480, y: 1440, w: 120, h: 120, cx: 540, cy: 1500, cells: 4 }] } }
    if (a.type === 'watch_color') { const present = a.color === '#ff0000'; res.ok = present === (a.appear !== false); if (res.ok) res.data = { matched: true, appear: a.appear !== false, found: present, count: present ? 1200 : 0, cx: 540, cy: 1500, waitedMs: 120, polls: 1 }; else res.error = 'color did not appear within ' + a.timeoutMs + 'ms' }
    if (a.type === 'wait_pixel') { const match = a.color === '#ff0000' && a.y > 1200; res.ok = match === (a.appear !== false); if (res.ok) res.data = { matched: true, hex: '#ff0000', waitedMs: 80, polls: 1, cx: a.x, cy: a.y }; else res.error = 'pixel did not match' }
    if (a.type === 'find_image') res.data = a.image.startsWith('iVBOR') ? { found: true, count: 1, scale: 2, matches: [{ score: 0.93, x: 500, y: 950, w: 80, h: 80, cx: 540, cy: 990 }] } : { found: false, count: 0, matches: [] }
    if (a.type === 'read_text') res.data = { count: 3, lines: [
      { text: 'SCORE 1250', x: 40, y: 60, w: 300, h: 60, cx: 190, cy: 90 },
      { text: 'PLAY', x: 440, y: 950, w: 200, h: 80, cx: 540, cy: 990 },
      { text: 'Continue', x: 400, y: 1600, w: 280, h: 70, cx: 540, cy: 1635 } ], text: 'SCORE 1250\nPLAY\nContinue', ...(a.region ? { region: a.region } : {}) }
    if (a.type === 'find_colors') res.data = { results: a.colors.map(c => c === '#ff0000' ? { color: c, found: true, count: 1200, cx: 540, cy: 1500, bounds: { x: 500, y: 1450, w: 80, h: 100 } } : { color: c, found: false, count: 0 }) }
    if (a.type === 'stream') { streaming = !!a.enabled; res.data = { streaming }; if (streaming) { const push = () => { if (!streaming) return; ws.send(JSON.stringify({ kind: 'frame', data: FAKE_SCREEN, mime: 'image/png', ts: Date.now() })); setTimeout(push, 500) }; setTimeout(push, 100) } }
    if (a.type === 'screen_hash') { hashCounter++; res.data = { hash: screen === 'home' ? HASHES.home : (hashCounter < 3 ? HASHES.menu : HASHES.menu.replace('ffff0000ffff', 'ffff0000fffe')), w: 1080, h: 2400 } }
    if (a.type === 'home') screen = 'home'
    if (a.type === 'recents' || a.type === 'open_app' || a.type === 'tap_element') screen = 'menu'
    if (a.type === 'find_objects') { const objs = a.color === '#ff0000' ? [ { i: 0, cx: 540, cy: 1500, area: 8000, bounds: { x: 500, y: 1450, w: 80, h: 100 } }, { i: 1, cx: 200, cy: 1200, area: 2500, bounds: { x: 175, y: 1175, w: 50, h: 50 } }, { i: 2, cx: 900, cy: 800, area: 900, bounds: { x: 885, y: 785, w: 30, h: 30 } } ].filter(o => o.bounds.w >= (a.minSize ?? 12)).slice(0, a.maxResults ?? 10) : []; res.data = { found: objs.length > 0, count: objs.length, total: objs.length, objects: objs, sampleStep: 2 } }
    // v2.5 multi-touch (fake: track finger slots)
    if (a.type === 'finger_down') { if (fingersDown.has(a.finger)) { res.ok = false; res.error = `finger ${a.finger} already down; finger_up first` } else { fingersDown.set(a.finger, { x: a.x, y: a.y }); res.data = { finger: a.finger, x: a.x, y: a.y, down: fingersDown.size } } }
    if (a.type === 'finger_move') { const f = fingersDown.get(a.finger); if (!f) { res.ok = false; res.error = `finger ${a.finger} is not down; finger_down first` } else { const last = a.points ? a.points[a.points.length - 1] : { x: a.x, y: a.y }; f.x = last.x; f.y = last.y; res.data = { finger: a.finger, x: f.x, y: f.y } } }
    if (a.type === 'finger_up') { const ids = a.finger === -1 ? [...fingersDown.keys()] : [a.finger]; let n = 0; for (const id of ids) if (fingersDown.delete(id)) n++; res.data = { lifted: n, down: fingersDown.size } }
    if (a.type === 'joystick') { const rad = a.angle * Math.PI / 180; const tipX = Math.round(a.x + Math.cos(rad) * a.distance), tipY = Math.round(a.y + Math.sin(rad) * a.distance); if (a.release) fingersDown.delete(a.finger); else fingersDown.set(a.finger, { x: tipX, y: tipY }); res.data = { finger: a.finger, angle: a.angle, distance: a.distance, heldMs: a.duration, released: a.release, tipX, tipY } }
    if (a.type === 'aim') { if (a.release) fingersDown.delete(a.finger); else fingersDown.set(a.finger, { x: a.x + a.dx, y: a.y + a.dy }); res.data = { finger: a.finger, dx: a.dx, dy: a.dy, durationMs: a.duration } }
    if (a.type === 'fire_burst') res.data = a.holdMs > 0 ? { held: a.holdMs, elapsedMs: a.holdMs } : { shots: a.count, elapsedMs: a.count * a.intervalMs }
    if (a.type === 'combo') { let bad = a.combo.findIndex(s => s.op === 'move' && !fingersDown.has(s.finger ?? 0) && !a.combo.slice(0, a.combo.indexOf(s)).some(p => p.op === 'down' && (p.finger ?? 0) === (s.finger ?? 0))); if (bad >= 0) { fingersDown.clear(); res.ok = false; res.error = `combo step ${bad + 1} (move) failed: finger ${a.combo[bad].finger ?? 0} is not down; finger_down first` } else { for (const s of a.combo) { if (s.op === 'down') fingersDown.set(s.finger ?? 0, { x: s.x, y: s.y }); if (s.op === 'up') { if ((s.finger ?? 0) === -1) fingersDown.clear(); else fingersDown.delete(s.finger ?? 0) } if (s.op === 'joystick' && s.release === false) fingersDown.set(s.finger ?? 0, { x: s.x, y: s.y }) } res.data = { steps: a.combo.length, elapsedMs: a.combo.reduce((t, s) => t + (s.delayMs ?? 0) + (s.duration ?? 0), 0), fingersDown: fingersDown.size } } }
    if (a.type === 'sample_colors') { const all = [ { hex: '#ff0000', share: 41.2, count: 8000, cx: 540, cy: 1500 }, { hex: '#00ff00', share: 22.5, count: 4400, cx: 300, cy: 700 }, { hex: '#3366ff', share: 9.1, count: 1800, cx: 900, cy: 400 }, { hex: '#ffcc00', share: 3.3, count: 650, cx: 120, cy: 2200 } ]; res.data = { colors: all.slice(0, a.maxColors ?? 8), analysedPx: 19400, quant: a.quant ?? 32, ...(a.region ? { region: a.region } : {}) } }
    if (a.type === 'track_object') { if (a.color !== '#ff0000') res.data = { found: false, samples: [], visible: 0 }; else { const n = a.samples ?? 5, iv = a.intervalMs ?? 120; const samples = []; for (let i = 0; i < n; i++) samples.push({ t: i * iv, x: 540 + i * 24, y: 1500, count: 1200 }); const vx = 24 * 1000 / iv; res.data = { found: true, visible: n, samples, cx: samples[n-1].x, cy: 1500, vx: Math.round(vx), vy: 0, speed: Math.round(vx), direction: 'right', angle: 0, predicted: { x: Math.round(samples[n-1].x + vx * (a.predictMs ?? 300) / 1000), y: 1500, inMs: a.predictMs ?? 300 } } } }
    if (a.type === 'auto_react') {
      // lane 0 = top-level; extra lanes fire in order. Only '#ff0000' and '#00ff00' are 'present' on the fake screen.
      const lanes = [{ name: 'lane0', color: a.color, tapX: a.tapX, tapY: a.tapY, tapOffsetX: a.tapOffsetX, tapOffsetY: a.tapOffsetY, cooldownMs: a.cooldownMs }, ...(a.lanes || [])]
      const present = (c) => c === '#ff0000' || c === '#00ff00'
      const taps = []; let stoppedBy = 'timeout'
      if (a.stopColor && present(a.stopColor)) stoppedBy = 'stopColor'
      else {
        outer: for (let round = 0; round < 3; round++) for (let li = 0; li < lanes.length; li++) {
          const l = lanes[li]; if (!present(l.color)) continue
          const base = l.color === '#ff0000' ? { x: 540, y: 1500 } : { x: 300, y: 700 }
          const t = { t: 80 + taps.length * 120, lane: li, name: l.name, count: 1200 }
          if (l.swipe) Object.assign(t, { swipe: true, x: base.x, y: base.y, x2: base.x + l.swipe.dx, y2: base.y + l.swipe.dy })
          else Object.assign(t, { x: l.tapX ?? base.x + (l.tapOffsetX ?? 0), y: l.tapY ?? base.y + (l.tapOffsetY ?? 0) })
          taps.push(t)
          if (taps.length >= (a.maxTriggers ?? 20)) { stoppedBy = 'maxTriggers'; break outer }
        }
      }
      res.data = { triggers: taps.length, taps, polls: taps.length + 5, stoppedBy, lanes: lanes.length, elapsedMs: taps.length ? 80 + taps.length * 120 : Math.min(a.timeoutMs ?? 10000, 600) }
    }
    // v3.3 native aim engine (fake: store config, emit aim_status on start/stop)
    if (a.type === 'aim_config') { aimCfg = a.aim || null; res.data = aimStatusJson() }
    if (a.type === 'aim_start') {
      if (!aimCfg) { res.ok = false; res.error = 'no aim config' }
      else { aimRun = { startedAt: Date.now() }; res.data = aimStatusJson()
        ws.send(JSON.stringify({ kind: 'aim_status', running: true, name: aimCfg.name, app: aimCfg.app, startedAt: aimRun.startedAt, frames: 0, fps: 30, holding: false, holdCount: 0, heldMs: 0, aimMoves: 0, reloads: 0, startedBy: 'relay', ts: Date.now() })) }
    }
    if (a.type === 'aim_stop') { const was = aimRun; aimRun = null; res.data = aimStatusJson()
      if (was) ws.send(JSON.stringify({ kind: 'aim_status', running: false, name: aimCfg?.name, app: aimCfg?.app, startedAt: was.startedAt, frames: 240, fps: 30, holding: false, holdCount: 4, heldMs: 3200, aimMoves: 12, reloads: 1, lastTrigger: 'reticle', stoppedBy: 'relay', startedBy: 'relay', ts: Date.now() })) }
    if (a.type === 'aim_status') res.data = aimStatusJson()
    if (a.type === 'aim_clear') { aimCfg = null; aimRun = null; res.data = aimStatusJson() }
    // v2.6 bots (fake: store synced bots, emit bot_status on start/stop)
    if (a.type === 'bot_sync') { botStore = Array.isArray(a.bots) ? a.bots : []; res.data = { synced: botStore.length } }
    if (a.type === 'bot_start') {
      const b = botStore.find(x => x.id === a.botId)
      if (!b) { res.ok = false; res.error = `bot ${a.botId} not on device` }
      else { botRunning = { botId: b.id, name: b.name, app: b.app, startedAt: Date.now(), ticks: 0, fired: 0, rules: b.rules }; res.data = { started: true, botId: b.id, name: b.name, rules: (b.rules || []).length }
        ws.send(JSON.stringify({ kind: 'bot_status', running: true, botId: b.id, name: b.name, startedAt: botRunning.startedAt, ticks: 0, fired: 0, ts: Date.now() })) }
    }
    if (a.type === 'bot_stop') { const was = botRunning; botRunning = null; res.data = { stopped: !!was, botId: was?.botId ?? null }
      if (was) ws.send(JSON.stringify({ kind: 'bot_status', running: false, botId: was.botId, name: was.name, startedAt: was.startedAt, ticks: 12, fired: 3, stoppedBy: 'user', ruleHits: { [ (was.rules && was.rules[0] && was.rules[0].name) || 'rule' ]: 3 }, avgTickMs: 41, learned: (was.rules || []).some(r => (r.then || []).some(a => a.type === 'aim_to_found')) ? { [((was.rules[0] || {}).name || 'rule') + '/0/sensitivity']: 0.73 } : undefined, startedBy: 'relay', ts: Date.now() })) }
    if (a.type === 'bot_status') res.data = botRunning ? { running: true, botId: botRunning.botId, name: botRunning.name, startedAt: botRunning.startedAt, ticks: 12, fired: 3, ruleHits: { [(botRunning.rules && botRunning.rules[0] && botRunning.rules[0].name) || 'rule']: 3 }, avgTickMs: 41 } : { running: false, bots: botStore.length }
    ws.send(JSON.stringify(res))
  }, delay)
}
ws.onclose = (e) => { console.log('[phone] closed', e.code, e.reason); process.exit(0) }
ws.onerror = (e) => console.error('[phone] error', e.message)
const ttl = Number(process.env.TTL_MS || 25000)
setTimeout(() => ws.close(), ttl)
