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
  ws.send(JSON.stringify({ kind: 'hello', model: 'Pixel 8 (fake)', android: '15', appVersion: '1.0.0', screen: { w: 1080, h: 2400 }, accessibilityEnabled: true }))
}
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.kind !== 'command') return
  console.log('[phone] got command', m.action)
  const t0 = Date.now()
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
    ws.send(JSON.stringify(res))
  }, 50)
}
ws.onclose = (e) => { console.log('[phone] closed', e.code, e.reason); process.exit(0) }
ws.onerror = (e) => console.error('[phone] error', e.message)
const ttl = Number(process.env.TTL_MS || 25000)
setTimeout(() => ws.close(), ttl)
