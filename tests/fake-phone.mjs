// Simulates the Android client: connects via WS, replies to commands.
// Usage: node tests/fake-phone.mjs ws://localhost:3000 TOKEN deviceId
const [base = 'ws://localhost:3000', token = 'dev-secret-token-123', deviceId = 'test-phone'] = process.argv.slice(2)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const here = dirname(fileURLToPath(import.meta.url))
let hashCounter = 0, diffCounter = 0, streaming = false, pfCounter = 0, pfHook = 0
// v1.9: two fake 'screens' — 'menu' (default) and 'home' (after home action); recents switches back
let screen = 'menu'
const fingersDown = new Map()
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
    if (a.type === 'find_color') res.data = a.color === '#ff0000' ? { found: true, count: 1200, cx: 540, cy: 1500, bounds: { x: 500, y: 1450, w: 80, h: 100 } }
      : (a.color === '#e0342a' && a.region) ? { found: true, count: Math.round(a.region.w * a.region.h * 0.6), cx: a.region.x + a.region.w * 0.3, cy: a.region.y + a.region.h / 2, bounds: { x: a.region.x, y: a.region.y, w: Math.round(a.region.w * 0.6), h: a.region.h } } // bar 60% full
      : { found: false, count: 0 }
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
    if (a.type === 'set_device_id') res.data = { deviceId: a.text, reconnecting: true }
    if (a.type === 'domino_bot') { if (a.text === 'start') { dominoRunning = true; res.data = { started: true, startDelayMs: a.holdMs ?? 3500, maxMs: a.duration ?? 1800000 } } else if (a.text === 'stop') { dominoRunning = false; res.data = { stopped: true } } else if (a.text === 'analyze') res.data = { w: 1600, h: 720, myTurn: true, hand: [{ tile: '1|4', x: 512, y: 582, kind: 'cream' }], table: [{ tile: '5|5', x: 831, y: 305, orient: 'v' }], layout: 'spinner=5', ends: [{ id: 'S', value: 5, double: true, dropX: 740, dropY: 305 }], plans: [] }; else res.data = { running: dominoRunning, ticks: 3, moves: 1, fails: 0, passes: 0, lastMove: '1|4→S(5)', log: ['0s armed'] } }
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
    // v4.1 AI-direct play primitives
    if (a.type === 'play_frame') {
      const f = a.frame || {}
      if ((f.quality ?? 0) !== pfHook) { pfHook = f.quality ?? 0; pfCounter = 0 }
      pfCounter++
      // test hooks: quality 11 = frozen screen (changedPct 0); quality 12 = moving world (red drifts right 30px/frame, score +10/frame)
      // quality 13 = threat: red falls 200px/frame toward the player and grows; hp (region named hp) drops 5/frame
      const frozen = f.quality === 11, moving = f.quality === 12, threat = f.quality === 13
      const drift = moving ? pfCounter * 30 : 0, bonus = moving ? pfCounter * 10 : 0
      const fall = threat ? Math.min(pfCounter * 200, 900) : 0, grow = threat ? 1 + pfCounter * 0.3 : 1
      const present = (c) => c === '#ff0000' || c === '#00ff00'
      const objects = {}
      for (const [i, o] of (f.objects || []).entries()) {
        const name = o.name || `c${i}`
        const list = o.color === '#ff0000'
          ? [ { cx: 540 + drift, cy: (threat ? 600 : 1500) + fall, area: Math.round(8000 * grow), w: 80, h: 100, top: 1450 }, { cx: 200, cy: 1200, area: 2500, w: 50, h: 50, top: 1175 }, { cx: 900, cy: 800, area: 900, w: 30, h: 30, top: 785 } ]
          : (o.color === '#00ff00' ? [ { cx: 300, cy: 700, area: 4400, w: 70, h: 70, top: 665 } ] : [])
        const filtered = list.filter(x => x.w >= (o.minSize ?? 6) && (o.maxSize == null || x.w <= o.maxSize)).slice(0, o.max ?? 6)
        objects[name] = { count: filtered.length, objects: filtered, present: present(o.color) }
      }
      const ocr = {}
      for (const [i, r] of (f.ocr || []).entries()) {
        const name = r.name || `r${i}`
        const val = threat && name === 'hp' ? Math.max(0, 100 - pfCounter * 5) : 1250 + bonus
        ocr[name] = r.number ? { value: val, text: String(val) } : [ { text: 'SCORE 1250', cx: 190, cy: 90 } ]
      }
      const pixels = (f.pixels || []).map(p => ({ x: p.x, y: p.y, hex: p.y > 1200 ? '#ff0000' : '#000000' }))
      res.screenshot = FAKE_SCREEN; res.screenshotMime = 'image/jpeg'
      res.data = { w: 1080, h: 2400, objects, ocr, pixels, ...(f.diff === true ? { changedPct: frozen ? 0 : 7.5 } : {}), scale: 0.59, ms: 80 }
    }
    if (a.type === 'react_script') {
      const present = (w) => (w.type === 'always') || (w.type === 'color_present' && (w.color === '#ff0000' || w.color === '#00ff00')) || (w.type === 'color_absent' && !(w.color === '#ff0000' || w.color === '#00ff00')) || (w.type === 'text_present' && /score|play|continue/i.test(w.text || '')) || (w.type === 'text_absent' && !/score|play|continue/i.test(w.text || '')) || (w.type === 'pixel_is' && w.color === '#ff0000' && w.y > 1200) || (w.type === 'pixel_not' && !(w.color === '#ff0000' && w.y > 1200))
      const fires = {}; const log = []; let triggers = 0; let stoppedBy = 'timeout'
      const stop = (a.stopRules || []).find(present)
      if (stop) stoppedBy = 'stopRule'
      else {
        outer: for (let round = 0; round < 3; round++) for (const [i, r] of a.rules.entries()) {
          if (!r.when.every(present)) continue
          const name = r.name || `rule${i}`
          if (r.maxFires != null && (fires[name] || 0) >= r.maxFires) continue
          fires[name] = (fires[name] || 0) + 1; triggers++
          log.push({ t: 60 + triggers * 90, rule: name, steps: r.then.length })
          if (a.maxTriggers && triggers >= a.maxTriggers) { stoppedBy = 'maxTriggers'; break outer }
          if (r.exclusive) break
        }
      }
      fingersDown.clear()
      res.data = { triggers, frames: 40, elapsedMs: stop ? 90 : Math.min(a.timeoutMs ?? 10000, 3000), stoppedBy, fires, log }
    }
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
    ws.send(JSON.stringify(res))
  }, delay)
}
ws.onclose = (e) => { console.log('[phone] closed', e.code, e.reason); process.exit(0) }
ws.onerror = (e) => console.error('[phone] error', e.message)
const ttl = Number(process.env.TTL_MS || 25000)
setTimeout(() => ws.close(), ttl)
