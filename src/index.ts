import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { Bindings, DeviceInfo } from './types'
import { parseAction, isValidDeviceId } from './validate'
import { DeviceRoom } from './device-room'
import { DeviceRegistry } from './registry'

export { DeviceRoom, DeviceRegistry }

type Env = { Bindings: Bindings & { REGISTRY: DurableObjectNamespace<DeviceRegistry> } }

const app = new Hono<Env>()

app.use('*', logger())
app.use('/api/*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'] }))

// ---------------- Auth ----------------
/** Constant-time string compare */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

function extractToken(c: { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined } }): string {
  const h = c.req.header('Authorization') ?? ''
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim()
  // WebSocket clients (browsers) cannot set headers -> allow ?token=
  return c.req.query('token') ?? ''
}

// Public health check (registered before auth middleware)
app.get('/api/health', (c) => c.json({ ok: true, ts: Date.now(), service: 'device-relay' }))

app.use('/api/*', async (c, next) => {
  const expected = c.env.RELAY_TOKEN
  if (!expected) return c.json({ error: 'server misconfigured: RELAY_TOKEN not set' }, 500)
  const token = extractToken(c)
  if (!token || !safeEqual(token, expected)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
})

// ---------------- Helpers ----------------
function room(c: { env: Bindings }, deviceId: string) {
  const id = c.env.DEVICE_ROOM.idFromName(deviceId)
  return c.env.DEVICE_ROOM.get(id)
}
function registry(c: { env: Env['Bindings'] }) {
  return c.env.REGISTRY.get(c.env.REGISTRY.idFromName('global'))
}

// ---------------- Devices ----------------
app.get('/api/devices', async (c) => {
  const ids = await registry(c).list()
  const infos = await Promise.all(
    ids.map(async (id) => {
      const r = await room(c, id).fetch(`https://do/info?deviceId=${id}`)
      return (await r.json()) as DeviceInfo
    }),
  )
  infos.sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
  return c.json({ devices: infos })
})

app.get('/api/devices/:deviceId', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const r = await room(c, deviceId).fetch(`https://do/info?deviceId=${deviceId}`)
  return c.json(await r.json())
})

app.delete('/api/devices/:deviceId', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  await registry(c).unregister(deviceId)
  return c.json({ ok: true })
})

app.get('/api/devices/:deviceId/logs', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const r = await room(c, deviceId).fetch(`https://do/logs?deviceId=${deviceId}`)
  return c.json(await r.json())
})

/**
 * Send ONE automation command.
 * Body: { "action": { "type": "tap", "x": 500, "y": 900 }, "wait": true }
 */
app.post('/api/devices/:deviceId/command', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)

  let body: { action?: unknown; wait?: boolean }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  const { action, error } = parseAction(body.action ?? body) // allow flat body too
  if (!action) return c.json({ error }, 400)

  const r = await room(c, deviceId).fetch(`https://do/command?deviceId=${deviceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, wait: body.wait !== false }),
  })
  const result = (await r.json()) as { ok: boolean }
  return c.json(result, result.ok ? 200 : 502)
})

/**
 * Send a SEQUENCE of commands (macro), executed in order.
 * Body: { "steps": [ {action}, {"type":"wait","ms":500}, ... ] }
 */
app.post('/api/devices/:deviceId/macro', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  let body: { steps?: unknown[] }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  if (!Array.isArray(body.steps) || body.steps.length === 0 || body.steps.length > 50) {
    return c.json({ error: 'steps must be an array of 1..50 items' }, 400)
  }

  const results: unknown[] = []
  for (const step of body.steps) {
    const s = step as { type?: string; ms?: number }
    if (s.type === 'wait') {
      await new Promise((r) => setTimeout(r, Math.min(Math.max(Number(s.ms) || 0, 0), 10_000)))
      results.push({ type: 'wait', ok: true })
      continue
    }
    const { action, error } = parseAction(step)
    if (!action) {
      results.push({ ok: false, error })
      break
    }
    const r = await room(c, deviceId).fetch(`https://do/command?deviceId=${deviceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, wait: true }),
    })
    const res = (await r.json()) as { ok: boolean }
    results.push({ action: action.type, ...res })
    if (!res.ok) break
  }
  const ok = results.every((r) => (r as { ok: boolean }).ok)
  return c.json({ ok, results }, ok ? 200 : 502)
})

// ---------------- WebSocket endpoints ----------------
/** Phone connects here: wss://host/api/ws/phone/<deviceId>  (Authorization: Bearer ...) */
app.get('/api/ws/phone/:deviceId', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected WebSocket', 426)
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  await registry(c).register(deviceId)
  const url = new URL(c.req.url)
  url.searchParams.set('deviceId', deviceId)
  url.searchParams.set('role', 'phone')
  return room(c, deviceId).fetch(new Request(url.toString(), c.req.raw))
})

/** Dashboard live view: wss://host/api/ws/viewer/<deviceId>?token=... */
app.get('/api/ws/viewer/:deviceId', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected WebSocket', 426)
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const url = new URL(c.req.url)
  url.searchParams.set('deviceId', deviceId)
  url.searchParams.set('role', 'viewer')
  return room(c, deviceId).fetch(new Request(url.toString(), c.req.raw))
})

// ---------------- Static dashboard (public/) ----------------
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
