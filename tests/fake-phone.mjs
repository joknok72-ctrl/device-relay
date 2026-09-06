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
    if (m.action.type === 'screenshot') res.screenshot = FAKE_SCREEN
    ws.send(JSON.stringify(res))
  }, 50)
}
ws.onclose = (e) => { console.log('[phone] closed', e.code, e.reason); process.exit(0) }
ws.onerror = (e) => console.error('[phone] error', e.message)
const ttl = Number(process.env.TTL_MS || 25000)
setTimeout(() => ws.close(), ttl)
