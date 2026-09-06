import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { Bindings, DeviceInfo } from './types'
import { parseAction, isValidDeviceId } from './validate'
import { DeviceRoom } from './device-room'
import { DeviceRegistry } from './registry'
import { TOOLS, openaiTools, anthropicTools, geminiTools, openapiSpec } from './tools'
import { executeTool } from './tool-exec'
import { handleMcp } from './mcp'
import { agentBootstrap } from './agent-bootstrap'
import { PHONE_SH } from './phone-sh'

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

/** Token-in-path variants so an agent needs exactly ONE string */
function tokenOk(c: { env: Bindings }, token: string) {
  return !!c.env.RELAY_TOKEN && safeEqual(token, c.env.RELAY_TOKEN)
}

/** Self-describing bootstrap for AI agents: the only thing a human pastes into a new chat. */
app.get('/agent/:token', async (c) => {
  const token = c.req.param('token')
  if (!tokenOk(c, token)) return c.text('unauthorized', 401)
  const ids = (await registry(c).list()) as string[]
  const infos = await Promise.all(ids.map(async (id) => (await (await room(c, id).fetch(`https://do/info?deviceId=${id}`)).json()) as DeviceInfo))
  infos.sort((a, b) => Number(b.online) - Number(a.online))
  return c.text(agentBootstrap(new URL(c.req.url).origin, token, infos), 200, { 'Cache-Control': 'no-store' })
})

/** MCP with token in the URL (for clients that cannot set headers) */
app.all('/mcp/:token', (c) => {
  if (!tokenOk(c, c.req.param('token'))) return c.json({ error: 'unauthorized' }, 401)
  return handleMcp(c.env, c.req.raw)
})

/** The helper script, served from the relay itself (no GitHub dependency) */
app.get('/phone.sh', (c) => c.text(PHONE_SH, 200, { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store' }))

app.use('/mcp', async (c, next) => {
  const expected = c.env.RELAY_TOKEN
  const token = extractToken(c)
  if (!expected || !token || !safeEqual(token, expected)) return c.json({ error: 'unauthorized' }, 401)
  await next()
})

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/tools/schema') return next() // public, no secrets
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
  const ids = (await registry(c).list()) as string[]
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

// ---------------- AI Tools ----------------
/** Tool schemas in every popular format (public: contains no secrets) */
app.get('/api/tools/schema', (c) => {
  const fmt = c.req.query('format') ?? 'openai'
  const origin = new URL(c.req.url).origin
  switch (fmt) {
    case 'openai': return c.json(openaiTools())
    case 'anthropic': return c.json(anthropicTools())
    case 'gemini': return c.json(geminiTools())
    case 'openapi': return c.json(openapiSpec(origin))
    case 'raw': return c.json(TOOLS)
    default: return c.json({ error: 'format must be openai|anthropic|gemini|openapi|raw' }, 400)
  }
})

/** Generic tool call: { "name": "tap", "arguments": { "x": 1, "y": 2 } } */
app.post('/api/devices/:deviceId/tools/call', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  let body: { name?: string; arguments?: Record<string, unknown> }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid JSON body' }, 400) }
  if (!body.name) return c.json({ error: 'name required' }, 400)
  const res = await executeTool(c.env, deviceId, body.name, body.arguments ?? {})
  return c.json(res, res.ok ? 200 : 502)
})

/** One endpoint per tool (matches the OpenAPI spec): POST /api/devices/:id/tools/tap {x,y} */
app.post('/api/devices/:deviceId/tools/:tool', async (c) => {
  const deviceId = c.req.param('deviceId')
  const tool = c.req.param('tool')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  if (!TOOLS.some((t) => t.name === tool)) return c.json({ error: `unknown tool ${tool}` }, 404)
  let args: Record<string, unknown> = {}
  if (c.req.header('content-length') && c.req.header('content-length') !== '0') {
    try { args = await c.req.json() } catch { return c.json({ error: 'invalid JSON body' }, 400) }
  }
  const res = await executeTool(c.env, deviceId, tool, args)
  return c.json(res, res.ok ? 200 : 502)
})

/** Raw PNG screenshot — easiest for vision models / python */
app.get('/api/devices/:deviceId/screenshot.png', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const res = await executeTool(c.env, deviceId, 'capture_screen', {})
  if (!res.ok || !res.image) return c.json({ error: res.error ?? 'no screenshot' }, 502)
  const bin = Uint8Array.from(atob(res.image.base64), (ch) => ch.charCodeAt(0))
  return new Response(bin, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
      'X-Screen-Width': String(res.screen?.w ?? ''),
      'X-Screen-Height': String(res.screen?.h ?? ''),
      'X-Image-Scale': String(res.image.scale),
    },
  })
})

/** MCP server (Streamable HTTP) */
app.all('/mcp', (c) => handleMcp(c.env, c.req.raw))

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
