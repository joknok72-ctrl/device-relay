import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { AuthContext, DeviceInfo, TokenRecord } from './types'
import { parseAction, isValidDeviceId } from './validate'
import { DeviceRoom } from './device-room'
import { DeviceRegistry } from './registry'
import { TOOLS, openaiTools, anthropicTools, geminiTools, openapiSpec } from './tools'
import { executeTool } from './tool-exec'
import { handleMcp } from './mcp'
import { agentBootstrap } from './agent-bootstrap'
import { PHONE_SH } from './phone-sh'
import { authenticate, canAccess, extractToken, randomToken, rateLimit, registry as reg, sha256Hex, type AuthEnv } from './auth'

export { DeviceRoom, DeviceRegistry }

const VERSION = '1.4.0'

type Auth = AuthContext & { readOnly?: boolean }
type Env = { Bindings: AuthEnv; Variables: { auth: Auth } }

const app = new Hono<Env>()

app.use('*', logger())
app.use('/api/*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'], exposeHeaders: ['X-Screen-Width', 'X-Screen-Height', 'X-Image-Scale', 'X-RateLimit-Remaining'] }))

// ---------------- Helpers ----------------
function room(c: { env: AuthEnv }, deviceId: string) {
  return c.env.DEVICE_ROOM.get(c.env.DEVICE_ROOM.idFromName(deviceId))
}
async function allDevices(env: AuthEnv, auth?: Auth): Promise<DeviceInfo[]> {
  let ids = (await reg(env).list()) as string[]
  if (auth && auth.role === 'device') ids = ids.filter((id) => id === auth.deviceId)
  const meta = await reg(env).allMeta()
  const infos = await Promise.all(
    ids.map(async (id) => {
      const info = (await (await env.DEVICE_ROOM.get(env.DEVICE_ROOM.idFromName(id)).fetch(`https://do/info?deviceId=${id}`)).json()) as DeviceInfo
      if (meta[id]?.label && !info.label) info.label = meta[id].label
      return info
    }),
  )
  infos.sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
  return infos
}
const unauthorized = (c: { json: (b: unknown, s: 401) => Response }) => c.json({ error: 'unauthorized' }, 401)

/** Reject if the token cannot act on this device. */
function guardDevice(c: { get: (k: 'auth') => Auth; json: (b: unknown, s: 403) => Response }, deviceId: string): Response | null {
  if (!canAccess(c.get('auth'), deviceId)) return c.json({ error: `token not allowed for device ${deviceId}` }, 403)
  return null
}

// ---------------- Public ----------------
app.get('/api/health', (c) => c.json({ ok: true, ts: Date.now(), service: 'device-relay', version: VERSION }))

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

/** The helper script, served from the relay itself (no GitHub dependency) */
app.get('/phone.sh', (c) => c.text(PHONE_SH, 200, { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store' }))

// ---------------- Token-in-URL entry points (an agent needs exactly ONE string) ----------------
/** Self-describing bootstrap for AI agents */
app.get('/agent/:token', async (c) => {
  const token = c.req.param('token')
  const auth = await authenticate(c.env, token)
  if (!auth) return c.text('unauthorized', 401)
  const infos = await allDevices(c.env, auth)
  return c.text(agentBootstrap(new URL(c.req.url).origin, token, infos, auth), 200, { 'Cache-Control': 'no-store' })
})

/** MCP with token in the URL (for clients that cannot set headers) */
app.all('/mcp/:token', async (c) => {
  const auth = await authenticate(c.env, c.req.param('token'))
  if (!auth) return unauthorized(c)
  return handleMcp(c.env, c.req.raw, auth)
})

/** Human monitor page with token in the URL: /monitor/<token> */
app.get('/monitor/:token', async (c) => {
  const auth = await authenticate(c.env, c.req.param('token'))
  if (!auth) return c.text('unauthorized', 401)
  const res = await c.env.ASSETS.fetch(new Request(new URL('/monitor.html', c.req.url).toString()))
  return new Response(res.body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
})

// ---------------- Auth middleware ----------------
const authMiddleware = async (c: any, next: () => Promise<void>) => {
  if (!c.env.RELAY_TOKEN) return c.json({ error: 'server misconfigured: RELAY_TOKEN not set' }, 500)
  const auth = await authenticate(c.env, extractToken(c.req))
  if (!auth) return unauthorized(c)
  const rl = rateLimit(auth.role === 'admin' ? 'admin' : `tok:${auth.tokenId}`)
  c.header('X-RateLimit-Remaining', String(rl.remaining))
  if (!rl.ok) {
    c.header('Retry-After', String(Math.ceil((rl.retryAfterMs ?? 1000) / 1000)))
    return c.json({ error: 'rate limited', retryAfterMs: rl.retryAfterMs }, 429)
  }
  c.set('auth', auth)
  await next()
}
app.use('/mcp', authMiddleware)
app.use('/api/*', authMiddleware)

// ---------------- Admin API (RELAY_TOKEN only) ----------------
const admin = new Hono<Env>()
admin.use('*', async (c, next) => {
  if (c.get('auth').role !== 'admin') return c.json({ error: 'admin token required' }, 403)
  await next()
})

/** Create a per-device token. Body: { deviceId, label?, readOnly? } → returns the token ONCE. */
admin.post('/tokens', async (c) => {
  let body: { deviceId?: string; label?: string; readOnly?: boolean }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid JSON body' }, 400) }
  const deviceId = String(body.deviceId ?? '')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const token = randomToken('dr')
  const hash = await sha256Hex(token)
  const rec: TokenRecord = { id: hash.slice(0, 8), deviceId, label: body.label?.slice(0, 64), createdAt: Date.now(), readOnly: body.readOnly === true }
  await reg(c.env).putToken(hash, rec)
  await reg(c.env).register(deviceId)
  const origin = new URL(c.req.url).origin
  return c.json({
    ok: true, token, ...rec,
    agentUrl: `${origin}/agent/${token}`,
    mcpUrl: `${origin}/mcp/${token}`,
    monitorUrl: `${origin}/monitor/${token}`,
    note: 'Store this token now; it cannot be retrieved again.',
  }, 201)
})
admin.get('/tokens', async (c) => c.json({ tokens: await reg(c.env).listTokens(c.req.query('deviceId') || undefined) }))
admin.delete('/tokens/:id', async (c) => {
  const ok = await reg(c.env).revokeToken(c.req.param('id'))
  return ok ? c.json({ ok: true }) : c.json({ error: 'token not found' }, 404)
})
admin.post('/devices/:deviceId/label', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const { label } = (await c.req.json().catch(() => ({}))) as { label?: string }
  await reg(c.env).setMeta(deviceId, { label })
  await room(c, deviceId).fetch(`https://do/label?deviceId=${deviceId}`, { method: 'POST', body: JSON.stringify({ label }), headers: { 'Content-Type': 'application/json' } })
  return c.json({ ok: true })
})
admin.post('/devices/:deviceId/clear-logs', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  await room(c, deviceId).fetch(`https://do/clear-logs?deviceId=${deviceId}`, { method: 'POST' })
  return c.json({ ok: true })
})
admin.post('/devices/:deviceId/disconnect', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  await room(c, deviceId).fetch(`https://do/disconnect?deviceId=${deviceId}`, { method: 'POST' })
  return c.json({ ok: true })
})
app.route('/api/admin', admin)

/** Who am I? */
app.get('/api/me', (c) => c.json({ ...c.get('auth'), version: VERSION }))

// ---------------- Devices ----------------
app.get('/api/devices', async (c) => c.json({ devices: await allDevices(c.env, c.get('auth')) }))

app.get('/api/devices/:deviceId', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const g = guardDevice(c, deviceId); if (g) return g
  return c.json(await (await room(c, deviceId).fetch(`https://do/info?deviceId=${deviceId}`)).json())
})

app.delete('/api/devices/:deviceId', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  if (c.get('auth').role !== 'admin') return c.json({ error: 'admin token required' }, 403)
  await reg(c.env).unregister(deviceId)
  return c.json({ ok: true })
})

app.get('/api/devices/:deviceId/logs', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const g = guardDevice(c, deviceId); if (g) return g
  return c.json(await (await room(c, deviceId).fetch(`https://do/logs?deviceId=${deviceId}`)).json())
})

/** Last screenshot the phone produced (cached in the DO, no new capture). */
app.get('/api/devices/:deviceId/last-screenshot', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const g = guardDevice(c, deviceId); if (g) return g
  return c.json(await (await room(c, deviceId).fetch(`https://do/last-screenshot?deviceId=${deviceId}`)).json())
})

/** Send ONE automation command. Body: { "action": {...}, "wait": true } */
app.post('/api/devices/:deviceId/command', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const g = guardDevice(c, deviceId); if (g) return g
  if (c.get('auth').readOnly) return c.json({ error: 'token is read-only; use /tools/* observation tools' }, 403)

  let body: { action?: unknown; wait?: boolean }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid JSON body' }, 400) }
  const { action, error } = parseAction(body.action ?? body)
  if (!action) return c.json({ error }, 400)

  const r = await room(c, deviceId).fetch(`https://do/command?deviceId=${deviceId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, wait: body.wait !== false }),
  })
  const result = (await r.json()) as { ok: boolean }
  return c.json(result, result.ok ? 200 : 502)
})

/** Macro: { "steps": [ {action}, {"type":"wait","ms":500}, ... ], "continueOnError": false } */
app.post('/api/devices/:deviceId/macro', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const g = guardDevice(c, deviceId); if (g) return g
  if (c.get('auth').readOnly) return c.json({ error: 'token is read-only' }, 403)
  let body: { steps?: unknown[]; continueOnError?: boolean }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid JSON body' }, 400) }
  if (!Array.isArray(body.steps) || body.steps.length === 0 || body.steps.length > 50) {
    return c.json({ error: 'steps must be an array of 1..50 items' }, 400)
  }
  const cont = body.continueOnError === true
  const results: unknown[] = []
  for (const step of body.steps) {
    const s = step as { type?: string; ms?: number }
    if (s.type === 'wait') {
      await new Promise((r) => setTimeout(r, Math.min(Math.max(Number(s.ms) || 0, 0), 10_000)))
      results.push({ type: 'wait', ok: true })
      continue
    }
    const { action, error } = parseAction(step)
    if (!action) { results.push({ ok: false, error }); if (!cont) break; continue }
    const r = await room(c, deviceId).fetch(`https://do/command?deviceId=${deviceId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, wait: true }),
    })
    const res = (await r.json()) as { ok: boolean }
    results.push({ action: action.type, ...res })
    if (!res.ok && !cont) break
  }
  const ok = results.every((r) => (r as { ok: boolean }).ok)
  return c.json({ ok, results }, ok ? 200 : 502)
})

// ---------------- AI Tools ----------------
/** Generic tool call: { "name": "tap", "arguments": { "x": 1, "y": 2 } } */
app.post('/api/devices/:deviceId/tools/call', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const g = guardDevice(c, deviceId); if (g) return g
  let body: { name?: string; arguments?: Record<string, unknown> }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid JSON body' }, 400) }
  if (!body.name) return c.json({ error: 'name required' }, 400)
  const res = await executeTool(c.env, deviceId, body.name, body.arguments ?? {}, { readOnly: c.get('auth').readOnly })
  return c.json(res, res.ok ? 200 : 502)
})

/** One endpoint per tool (matches the OpenAPI spec) */
app.post('/api/devices/:deviceId/tools/:tool', async (c) => {
  const deviceId = c.req.param('deviceId')
  const tool = c.req.param('tool')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const g = guardDevice(c, deviceId); if (g) return g
  if (!TOOLS.some((t) => t.name === tool)) return c.json({ error: `unknown tool ${tool}` }, 404)
  let args: Record<string, unknown> = {}
  if (c.req.header('content-length') && c.req.header('content-length') !== '0') {
    try { args = await c.req.json() } catch { return c.json({ error: 'invalid JSON body' }, 400) }
  }
  const res = await executeTool(c.env, deviceId, tool, args, { readOnly: c.get('auth').readOnly })
  return c.json(res, res.ok ? 200 : 502)
})

/** Raw screenshot — easiest for vision models / python. ?maxWidth=&format=jpeg&quality= */
async function screenshotHandler(c: any, forceFormat?: 'jpeg') {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const g = guardDevice(c, deviceId); if (g) return g
  const args: Record<string, unknown> = {}
  const mw = Number(c.req.query('maxWidth')); if (mw) args.maxWidth = mw
  const q = Number(c.req.query('quality')); if (q) args.quality = q
  const fmt = forceFormat ?? c.req.query('format'); if (fmt) args.format = fmt
  const res = await executeTool(c.env, deviceId, 'capture_screen', args)
  if (!res.ok || !res.image) return c.json({ error: res.error ?? 'no screenshot' }, 502)
  const bin = Uint8Array.from(atob(res.image.base64), (ch) => ch.charCodeAt(0))
  return new Response(bin, {
    headers: {
      'Content-Type': res.image.mime, 'Cache-Control': 'no-store',
      'X-Screen-Width': String(res.screen?.w ?? ''), 'X-Screen-Height': String(res.screen?.h ?? ''), 'X-Image-Scale': String(res.image.scale),
    },
  })
}
app.get('/api/devices/:deviceId/screenshot.png', (c) => screenshotHandler(c))
app.get('/api/devices/:deviceId/screenshot.jpg', (c) => screenshotHandler(c, 'jpeg'))

/** MCP server (Streamable HTTP) */
app.all('/mcp', (c) => handleMcp(c.env, c.req.raw, c.get('auth')))

// ---------------- WebSocket endpoints ----------------
/** Phone connects here: wss://host/api/ws/phone/<deviceId>  (Authorization: Bearer ...) */
app.get('/api/ws/phone/:deviceId', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected WebSocket', 426)
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const g = guardDevice(c, deviceId); if (g) return g
  if (c.get('auth').readOnly) return c.json({ error: 'read-only token cannot register a phone' }, 403)
  await reg(c.env).register(deviceId)
  const url = new URL(c.req.url)
  url.searchParams.set('deviceId', deviceId)
  url.searchParams.set('role', 'phone')
  return room(c, deviceId).fetch(new Request(url.toString(), c.req.raw))
})

/** Monitor live view: wss://host/api/ws/viewer/<deviceId>?token=... */
app.get('/api/ws/viewer/:deviceId', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected WebSocket', 426)
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const g = guardDevice(c, deviceId); if (g) return g
  const url = new URL(c.req.url)
  url.searchParams.set('deviceId', deviceId)
  url.searchParams.set('role', 'viewer')
  return room(c, deviceId).fetch(new Request(url.toString(), c.req.raw))
})

// ---------------- Static (public/) ----------------
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
