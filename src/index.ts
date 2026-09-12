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

const VERSION = '4.8.0'

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
  const target = infos.find((d) => d.online) ?? infos[0]
  let notes: import('./types').Note[] = []
  let macros: import('./types').Macro[] = []
  let screens: import('./types').ScreenLabel[] = []
  const extras: import('./agent-bootstrap').BootstrapExtras = {}
  if (target) {
    const r = room(c, target.deviceId)
    try {
      const [n, m, s, mem] = await Promise.all([
        r.fetch(`https://do/notes?deviceId=${target.deviceId}`).then((x) => x.json() as Promise<{ notes: import('./types').Note[] }>),
        r.fetch(`https://do/macros?deviceId=${target.deviceId}`).then((x) => x.json() as Promise<{ macros: import('./types').Macro[] }>),
        r.fetch(`https://do/screens?deviceId=${target.deviceId}`).then((x) => x.json() as Promise<{ screens: import('./types').ScreenLabel[] }>),
        r.fetch(`https://do/memory?deviceId=${target.deviceId}`).then((x) => x.json() as Promise<{ groups: { app: string; label?: string; profile?: import('./types').GameProfile; playbook?: import('./types').Playbook }[]; sessions: import('./types').PlaySession[]; currentApp: string; generalPlaybook?: import('./types').Playbook | null }>),
      ])
      notes = n.notes; macros = m.macros; screens = s.screens
      extras.profiles = mem.groups.map((g) => g.profile).filter((p): p is import('./types').GameProfile => !!p)
      extras.playbooks = Object.fromEntries(mem.groups.filter((g) => g.playbook).map((g) => [g.app, g.playbook as import('./types').Playbook]))
      if (mem.generalPlaybook) extras.playbooks['*'] = mem.generalPlaybook
      extras.sessions = mem.sessions; extras.currentApp = mem.currentApp
      extras.appLabels = Object.fromEntries(mem.groups.filter((g) => g.label).map((g) => [g.app, g.label as string]))
    } catch { /* ignore */ }
  }
  return c.text(agentBootstrap(new URL(c.req.url).origin, token, infos, auth, notes, macros, screens, extras), 200, { 'Cache-Control': 'no-store' })
})

/** MCP with token in the URL (for clients that cannot set headers) */
app.all('/mcp/:token', async (c) => {
  const auth = await authenticate(c.env, c.req.param('token'))
  if (!auth) return unauthorized(c)
  return handleMcp(c.env, c.req.raw, auth)
})

/** Setup / control panel for the human owner (admin token only): /setup/<token> */
app.get('/setup/:token', async (c) => {
  const auth = await authenticate(c.env, c.req.param('token'))
  if (!auth || auth.role !== 'admin') return c.text('unauthorized — admin token required', 401)
  const res = await c.env.ASSETS.fetch(new Request(new URL('/setup.html', c.req.url).toString()))
  return new Response(res.body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
})

/** Human monitor page with token in the URL: /monitor/<token> */
app.get('/monitor/:token', async (c) => {
  const auth = await authenticate(c.env, c.req.param('token'))
  if (!auth) return c.text('unauthorized', 401)
  const res = await c.env.ASSETS.fetch(new Request(new URL('/monitor.html', c.req.url).toString()))
  return new Response(res.body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
})

/** Phone pairing helper: opens the app via deep link, with a manual fallback. Token stays in the URL fragment-free query (user's own device). */
app.get('/pair', (c) => {
  const q = new URL(c.req.url).searchParams
  const server = q.get('server') ?? new URL(c.req.url).origin
  const token = q.get('token') ?? ''
  const device = q.get('device') ?? ''
  const deep = `devicerelay://pair?server=${encodeURIComponent(server)}&token=${encodeURIComponent(token)}&device=${encodeURIComponent(device)}`
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  return c.html(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ربط الهاتف — Device Relay</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;color:#e2e8f0;font-family:system-ui,Tahoma,sans-serif}main{max-width:520px;padding:28px;text-align:center}a.btn{display:block;background:#34d399;color:#0f172a;font-weight:700;padding:16px;border-radius:14px;text-decoration:none;font-size:1.1rem;margin:18px 0}code{display:block;background:#1e293b;padding:10px;border-radius:8px;direction:ltr;text-align:left;word-break:break-all;margin:6px 0;font-size:.85rem}p{color:#94a3b8;line-height:1.7}.k{color:#64748b;font-size:.8rem;margin-top:14px}</style></head>
<body><main><h1>📱 ربط الهاتف</h1><p>افتح هذه الصفحة <b>من هاتف الأندرويد</b> المثبَّت عليه تطبيق Device Relay ثم اضغط:</p>
<a class="btn" href="${esc(deep)}" id="open">افتح التطبيق واملأ الإعدادات</a>
<p>لو لم يفتح التطبيق: ثبّته من <a style="color:#34d399" href="https://github.com/joknok72-ctrl/device-relay/releases/tag/latest">Releases</a> ثم أعد المحاولة، أو أدخل القيم يدويًا:</p>
<div class="k">رابط السيرفر</div><code>${esc(server)}</code>
<div class="k">Bearer Token</div><code>${esc(token || '(لم يُمرَّر)')}</code>
<div class="k">Device ID (اختياري)</div><code>${esc(device || '(سيُولَّد تلقائيًا)')}</code>
<p style="margin-top:22px">بعد الاتصال: فعّل <b>خدمة إمكانية الوصول</b> و(اختياريًا) <b>قراءة الإشعارات</b> من داخل التطبيق.</p></main>
<script>setTimeout(()=>{try{location.href=document.getElementById('open').href}catch(e){}},600)</script></body></html>`)
})

// ---------------- Auth middleware ----------------
const authMiddleware = async (c: any, next: () => Promise<void>) => {
  if (!c.env.RELAY_TOKEN) return c.json({ error: 'server misconfigured: RELAY_TOKEN not set' }, 500)
  const auth = await authenticate(c.env, extractToken(c.req))
  if (!auth) return unauthorized(c)
  const rl = rateLimit(auth.tokenId ? `tok:${auth.tokenId}` : 'admin')
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

/** Build every URL a human/AI needs for a token. */
function tokenUrls(origin: string, token: string, deviceId: string, isAdmin: boolean) {
  const pair = `${origin}/pair?server=${encodeURIComponent(origin)}&token=${encodeURIComponent(token)}&device=${encodeURIComponent(deviceId === '*' ? '' : deviceId)}`
  return {
    agentUrl: `${origin}/agent/${token}`,
    mcpUrl: `${origin}/mcp/${token}`,
    monitorUrl: `${origin}/monitor/${token}`,
    ...(isAdmin ? { setupUrl: `${origin}/setup/${token}` } : {}),
    pairUrl: pair,
    newChatPrompt: `${origin}/agent/${token}\nافتح الرابط ونفّذ ما فيه، ثم: <مهمتك هنا>`,
  }
}

/**
 * Create a token. Body: { deviceId, label?, readOnly? }  → per-device token
 *                 or   { admin: true, label? }            → another full admin token (for rotation / a second owner)
 * Returns the token ONCE.
 */
admin.post('/tokens', async (c) => {
  let body: { deviceId?: string; label?: string; readOnly?: boolean; admin?: boolean }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid JSON body' }, 400) }
  const isAdmin = body.admin === true
  const deviceId = isAdmin ? '*' : String(body.deviceId ?? '')
  if (!isAdmin && !isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const token = randomToken(isAdmin ? 'dr_admin' : 'dr')
  const hash = await sha256Hex(token)
  const rec: TokenRecord = { id: hash.slice(0, 8), deviceId, label: body.label?.slice(0, 64), createdAt: Date.now(), readOnly: !isAdmin && body.readOnly === true, admin: isAdmin || undefined }
  await reg(c.env).putToken(hash, rec)
  if (!isAdmin) await reg(c.env).register(deviceId)
  const origin = new URL(c.req.url).origin
  return c.json({ ok: true, token, ...rec, ...tokenUrls(origin, token, deviceId, isAdmin), note: 'Store this token now; it cannot be retrieved again.' }, 201)
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
/**
 * v4.7.3 — rename a device WITHOUT losing what the AI learned.
 * POST /api/admin/devices/:id/rename  { newId, keepOld?: boolean }
 * Copies the whole memory (profiles + learned strategies, sessions, notes, macros, labelled screens, apps) to `newId`,
 * moves the label and all device tokens, tells the phone (if online) to reconnect under the new id, and unregisters the
 * old id (unless keepOld). Also useful after a reinstall: the app's default id changes → rename the OLD id to the NEW one.
 */
admin.post('/devices/:deviceId/rename', async (c) => {
  const from = c.req.param('deviceId')
  const { newId, keepOld } = (await c.req.json().catch(() => ({}))) as { newId?: string; keepOld?: boolean }
  const to = String(newId ?? '').trim()
  if (!isValidDeviceId(from)) return c.json({ error: 'invalid deviceId' }, 400)
  if (!isValidDeviceId(to)) return c.json({ error: 'invalid newId (letters, digits, - and _ ; 3-64 chars)' }, 400)
  if (from === to) return c.json({ error: 'newId equals current id' }, 400)
  const src = room(c, from), dst = room(c, to)
  const mem = (await (await src.fetch(`https://do/memory/full?deviceId=${from}`)).json()) as Record<string, unknown>
  const merged = (await (await dst.fetch(`https://do/memory/full?deviceId=${to}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...mem, mode: 'merge' }) })).json()) as { totals?: Record<string, number> }
  const moved = await reg(c.env).rename(from, to)
  // the phone (if connected under the old id) is told to switch: it saves the new id and reconnects
  const phone = await src.fetch(`https://do/command?deviceId=${from}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: { type: 'set_device_id', text: to }, wait: true }) }).then((r) => r.json() as Promise<{ ok: boolean; error?: string }>).catch(() => ({ ok: false, error: 'offline' }))
  if (!keepOld) {
    await src.fetch(`https://do/memory?deviceId=${from}`, { method: 'DELETE' }).catch(() => {})
    await src.fetch(`https://do/disconnect?deviceId=${from}`, { method: 'POST' }).catch(() => {})
  } else await reg(c.env).register(from)
  return c.json({ ok: true, from, to, memory: merged.totals, tokensMoved: moved.tokens, phone: phone.ok ? 'switched (reconnecting under the new id)' : `not switched (${phone.error ?? 'offline'}) — set the Device ID to '${to}' in the app` })
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
/**
 * v2.2 — AI memory management (what the AI learned about each game/app on a device).
 * GET    /api/admin/devices/:id/memory                 → grouped by app: notes, macros, labelled screens, recording draft, apps seen
 * GET    /api/admin/devices/:id/memory?format=export   → downloadable JSON backup
 * DELETE /api/admin/devices/:id/memory?kind=all|notes|macros|screens|recording|apps&app=<pkg>&index=<n>&name=<x>
 *   - no params: wipe everything the AI remembers about this device
 *   - app=<pkg>: wipe only that game's memory (use when the game was updated and old layouts are stale)
 * POST   /api/admin/devices/:id/memory/import          → restore from an export (merge)
 */
admin.get('/devices/:deviceId/memory', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const mem = (await (await room(c, deviceId).fetch(`https://do/memory?deviceId=${deviceId}`)).json()) as Record<string, unknown>
  if (c.req.query('format') === 'export') {
    const body = JSON.stringify({ exportedAt: new Date().toISOString(), version: VERSION, ...mem }, null, 2)
    return new Response(body, { headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="device-relay-memory-${deviceId}-${new Date().toISOString().slice(0, 10)}.json"` } })
  }
  return c.json(mem)
})
admin.delete('/devices/:deviceId/memory', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const qs = new URLSearchParams()
  for (const k of ['kind', 'app', 'index', 'name']) { const v = c.req.query(k); if (v !== undefined) qs.set(k, v) }
  return c.json(await (await room(c, deviceId).fetch(`https://do/memory?deviceId=${deviceId}&${qs.toString()}`, { method: 'DELETE' })).json())
})
admin.post('/devices/:deviceId/memory/import', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  let body: { groups?: { app?: string; notes?: { text: string; app?: string }[]; macros?: Record<string, unknown>[]; screens?: Record<string, unknown>[]; profile?: Record<string, unknown>; playbook?: Record<string, unknown> }[]; generalPlaybook?: Record<string, unknown> | null }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid JSON' }, 400) }
  const r = room(c, deviceId)
  const hdr = { 'Content-Type': 'application/json' }
  let notes = 0, macros = 0, screens = 0, profiles = 0, playbooks = 0
  if (body.generalPlaybook) { const res = await r.fetch(`https://do/playbook?deviceId=${deviceId}&app=*`, { method: 'POST', headers: hdr, body: JSON.stringify({ app: '*', merge: body.generalPlaybook }) }); if (res.ok) playbooks++ }
  for (const g of body.groups ?? []) {
    if (g.playbook && g.app) { const res = await r.fetch(`https://do/playbook?deviceId=${deviceId}&app=${encodeURIComponent(g.app)}`, { method: 'POST', headers: hdr, body: JSON.stringify({ app: g.app, merge: g.playbook }) }); if (res.ok) playbooks++ }
    if (g.profile && g.app) { const res = await r.fetch(`https://do/profile?deviceId=${deviceId}&app=${encodeURIComponent(g.app)}`, { method: 'POST', headers: hdr, body: JSON.stringify({ replace: g.profile }) }); if (res.ok) profiles++ }
    for (const n of g.notes ?? []) { if (typeof n.text === 'string') { await r.fetch(`https://do/notes?deviceId=${deviceId}`, { method: 'POST', headers: hdr, body: JSON.stringify({ text: n.text, app: n.app }) }); notes++ } }
    for (const m of g.macros ?? []) { const res = await r.fetch(`https://do/macros?deviceId=${deviceId}`, { method: 'POST', headers: hdr, body: JSON.stringify(m) }); if (res.ok) macros++ }
    for (const s of g.screens ?? []) { const res = await r.fetch(`https://do/screens?deviceId=${deviceId}`, { method: 'POST', headers: hdr, body: JSON.stringify(s) }); if (res.ok) screens++ }
  }
  return c.json({ ok: true, imported: { notes, macros, screens, profiles, playbooks } })
})
/** Everything the setup page needs in one call */
admin.get('/overview', async (c) => {
  const [devices, tokens] = await Promise.all([allDevices(c.env), reg(c.env).listTokens()])
  const origin = new URL(c.req.url).origin
  return c.json({ origin, version: VERSION, devices, tokens, me: c.get('auth'), webhookConfigured: !!c.env.WEBHOOK_URL })
})
app.route('/api/admin', admin)

/** Who am I? (+ all the URLs for the token that was used) */
app.get('/api/me', (c) => {
  const auth = c.get('auth')
  const token = extractToken(c.req)
  const origin = new URL(c.req.url).origin
  const deviceId = auth.role === 'device' ? auth.deviceId : '*'
  return c.json({ ...auth, version: VERSION, ...tokenUrls(origin, token, deviceId, auth.role === 'admin') })
})

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

/** v2.2: read-only memory summary for any token that can access the device (admin manages it via /api/admin/.../memory). */
app.get('/api/devices/:deviceId/memory', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const g = guardDevice(c, deviceId); if (g) return g
  return c.json(await (await room(c, deviceId).fetch(`https://do/memory?deviceId=${deviceId}`)).json())
})

/** Persistent per-device notes (memory across AI sessions). */
app.get('/api/devices/:deviceId/notes', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const g = guardDevice(c, deviceId); if (g) return g
  return c.json(await (await room(c, deviceId).fetch(`https://do/notes?deviceId=${deviceId}`)).json())
})
app.post('/api/devices/:deviceId/notes', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const g = guardDevice(c, deviceId); if (g) return g
  const body = await c.req.text()
  return c.json(await (await room(c, deviceId).fetch(`https://do/notes?deviceId=${deviceId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).json())
})
app.delete('/api/devices/:deviceId/notes', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!isValidDeviceId(deviceId)) return c.json({ error: 'invalid deviceId' }, 400)
  const g = guardDevice(c, deviceId); if (g) return g
  const idx = c.req.query('index')
  return c.json(await (await room(c, deviceId).fetch(`https://do/notes?deviceId=${deviceId}${idx !== undefined ? `&index=${idx}` : ''}`, { method: 'DELETE' })).json())
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
  const grid = Number(c.req.query('grid')); if (grid) args.grid = grid
  const region = c.req.query('region') // "x,y,w,h"
  if (region) { const [x, y, w, h] = region.split(',').map(Number); if ([x, y, w, h].every(Number.isFinite)) args.region = { x, y, w, h } }
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
