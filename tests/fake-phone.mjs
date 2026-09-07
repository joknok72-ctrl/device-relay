// Simulates the Android client: connects via WS, replies to commands.
// Usage: node tests/fake-phone.mjs ws://localhost:3000 TOKEN deviceId
const [base = 'ws://localhost:3000', token = 'dev-secret-token-123', deviceId = 'test-phone'] = process.argv.slice(2)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const here = dirname(fileURLToPath(import.meta.url))
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
  const delay = ['tap','swipe','drag','pinch','long_press','type_text'].includes(m.action.type) ? 300 : 50
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
    if (a.type === 'screen_hash') { hashCounter++; res.data = { hash: hashCounter < 3 ? 'aaaa' : 'bbbb', w: 1080, h: 2400 } }
    ws.send(JSON.stringify(res))
  }, delay)
}
ws.onclose = (e) => { console.log('[phone] closed', e.code, e.reason); process.exit(0) }
ws.onerror = (e) => console.error('[phone] error', e.message)
const ttl = Number(process.env.TTL_MS || 25000)
setTimeout(() => ws.close(), ttl)
