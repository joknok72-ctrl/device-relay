import { DurableObject } from 'cloudflare:workers'
import type { Action, Bindings, CommandMessage, DeviceInfo, GameProfile, LogEntry, Macro, Note, PhoneMessage, PlaySession, Recording, ScreenLabel, SessionReport } from './types'
import { READ_ONLY_ACTIONS, actionTimeoutMs } from './types'

const MAX_LOGS = 100
const MAX_NOTES = 40
const MAX_MACROS = 30
const MAX_SCREENS = 60
const MAX_QUEUE = 32

export interface CommandResult {
  id: string
  ok: boolean
  error?: string
  screenshot?: string
  screenshotMime?: string
  durationMs?: number
  /** time spent waiting in queue before being sent */
  queuedMs?: number
  data?: unknown
  queued?: boolean
}

interface Pending {
  resolve: (r: Omit<CommandResult, 'id'>) => void
  timer: ReturnType<typeof setTimeout>
  sentAt: number
}

/**
 * One Durable Object instance per deviceId.
 * Holds the phone's WebSocket (hibernation-enabled) and any monitor viewers,
 * and forwards commands with request/response correlation.
 *
 * Concurrency model (v1.4):
 *  - INPUT actions (tap/swipe/type/...) are serialized through a FIFO queue so two AI
 *    calls never interleave gestures on the phone.
 *  - READ-ONLY actions (screenshot/ui_dump/...) bypass the queue and run concurrently.
 */
export class DeviceRoom extends DurableObject<Bindings> {
  private pending = new Map<string, Pending>()
  private info: DeviceInfo
  private logs: LogEntry[] = []
  private lastScreenshot: { ts: number; data: string; mime: string } | null = null
  /** Persistent notes written by AI agents (game layouts, coordinates, learnings) — survive across chats. */
  private notes: Note[] = []
  /** Named replayable tool sequences saved by agents. */
  private macros: Macro[] = []
  /** Named screen fingerprints (perceptual hash + optional OCR words) for identify_screen. */
  private screens: ScreenLabel[] = []
  /** v2.0 macro recording draft (record_macro). */
  private recording: Recording | null = null
  /** v2.2 apps the AI has seen (package -> label, first/last seen) so memory can be grouped per game. */
  private apps: Record<string, { label?: string; first: number; last: number; n: number }> = {}
  /** v2.3 structured per-app profiles (controls/colors/regions/settings) keyed by package. */
  private profiles: Record<string, GameProfile> = {}
  /** v2.3 play history: sessions (most recent first, max 100). */
  private sessions: PlaySession[] = []
  private currentApp = ''

  private inputBusy = false
  private inputQueue: Array<() => void> = []

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env)
    this.info = { deviceId: '', online: false, commandsSent: 0, commandsOk: 0, commandsFailed: 0 }
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<DeviceInfo>('info')
      if (saved) this.info = { ...saved, online: this.phoneSockets().length > 0 }
      const logs = await ctx.storage.get<LogEntry[]>('logs')
      if (logs) this.logs = logs
      const notes = await ctx.storage.get<Note[]>('notes')
      if (notes) this.notes = notes
      const macros = await ctx.storage.get<Macro[]>('macros')
      if (macros) this.macros = macros
      const screens = await ctx.storage.get<ScreenLabel[]>('screens')
      if (screens) this.screens = screens
      const rec = await ctx.storage.get<Recording>('recording')
      if (rec) this.recording = rec
      const apps = await ctx.storage.get<typeof this.apps>('apps')
      if (apps) this.apps = apps
      const profiles = await ctx.storage.get<typeof this.profiles>('profiles')
      if (profiles) this.profiles = profiles
      const sessions = await ctx.storage.get<PlaySession[]>('sessions')
      if (sessions) this.sessions = sessions
    })
  }

  // ---------- helpers ----------
  private phoneSockets(): WebSocket[] { return this.ctx.getWebSockets('phone') }
  private viewerSockets(): WebSocket[] { return this.ctx.getWebSockets('viewer') }

  private async persist() {
    await this.ctx.storage.put('info', this.info)
    await this.ctx.storage.put('logs', this.logs)
  }
  private broadcastViewers(msg: unknown) {
    const data = JSON.stringify(msg)
    for (const ws of this.viewerSockets()) { try { ws.send(data) } catch { /* ignore */ } }
  }
  private addLog(entry: LogEntry) {
    this.logs.unshift(entry)
    if (this.logs.length > MAX_LOGS) this.logs.length = MAX_LOGS
    this.broadcastViewers({ kind: 'log', entry })
  }
  private updateLog(id: string, patch: Partial<LogEntry>) {
    const e = this.logs.find((l) => l.id === id)
    if (e) { Object.assign(e, patch); this.broadcastViewers({ kind: 'log', entry: e }) }
  }
  /** v2.3: extend the open session for this app or start a new one (gap > 10 min or app changed). */
  private touchSession(app: string, label?: string, patch?: { commands?: number; failed?: number; screenshots?: number }) {
    const now = Date.now()
    const cur = this.sessions[0]
    if (cur && cur.app === app && now - cur.end < 10 * 60_000) {
      cur.end = now; if (label && !cur.label) cur.label = label
      if (patch) { cur.commands += patch.commands ?? 0; cur.failed += patch.failed ?? 0; cur.screenshots += patch.screenshots ?? 0 }
    } else {
      this.sessions.unshift({ app, label, start: now, end: now, commands: patch?.commands ?? 0, failed: patch?.failed ?? 0, screenshots: patch?.screenshots ?? 0 })
      if (this.sessions.length > 100) this.sessions.length = 100
    }
    this.ctx.waitUntil(this.ctx.storage.put('sessions', this.sessions))
  }
  private snapshotInfo(): DeviceInfo {
    this.info.online = this.phoneSockets().length > 0
    this.info.queued = this.inputQueue.length + (this.inputBusy ? 1 : 0)
    return this.info
  }

  /** Fire-and-forget webhook on presence change */
  private webhook(event: 'online' | 'offline') {
    const url = this.env.WEBHOOK_URL
    if (!url) return
    const body = JSON.stringify({ event, deviceId: this.info.deviceId, ts: Date.now(), info: this.info })
    this.ctx.waitUntil(fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {}))
  }

  // ---------- HTTP entry (from Worker) ----------
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const deviceId = url.searchParams.get('deviceId') ?? ''
    if (!this.info.deviceId) this.info.deviceId = deviceId

    if (request.headers.get('Upgrade') === 'websocket') {
      const role = url.searchParams.get('role') === 'viewer' ? 'viewer' : 'phone'
      const pair = new WebSocketPair()
      const [client, server] = [pair[0], pair[1]]

      if (role === 'phone') {
        for (const old of this.phoneSockets()) { try { old.close(4000, 'replaced by new connection') } catch { /* ignore */ } }
      }
      this.ctx.acceptWebSocket(server, [role])

      if (role === 'phone') {
        const wasOnline = this.info.online
        this.info.online = true
        this.info.connectedAt = Date.now()
        this.info.lastSeen = Date.now()
        await this.persist()
        this.broadcastViewers({ kind: 'status', info: this.snapshotInfo() })
        if (!wasOnline) this.webhook('online')
      } else {
        server.send(JSON.stringify({ kind: 'snapshot', info: this.snapshotInfo(), logs: this.logs, screenshot: this.lastScreenshot, recording: this.recording ? { active: true, name: this.recording.name, steps: this.recording.steps.length } : { active: false } }))
      }
      return new Response(null, { status: 101, webSocket: client })
    }

    if (url.pathname.endsWith('/info')) return Response.json(this.snapshotInfo())
    if (url.pathname.endsWith('/logs')) return Response.json(this.logs)
    if (url.pathname.endsWith('/stats')) {
      // derived from the last 100 log entries: success rate, latency, per-action breakdown
      const done = this.logs.filter((l) => ['ok', 'failed', 'timeout'].includes(l.status))
      const ok = done.filter((l) => l.status === 'ok')
      const lat = ok.map((l) => l.durationMs ?? 0).filter((n) => n > 0).sort((a, b) => a - b)
      const byType: Record<string, { n: number; ok: number; avgMs: number }> = {}
      for (const l of done) {
        const t = byType[l.action.type] ??= { n: 0, ok: 0, avgMs: 0 }
        t.n++; if (l.status === 'ok') { t.ok++; t.avgMs += l.durationMs ?? 0 }
      }
      for (const t of Object.values(byType)) t.avgMs = t.ok ? Math.round(t.avgMs / t.ok) : 0
      const failures = done.filter((l) => l.status !== 'ok').slice(0, 5).map((l) => ({ action: l.action.type, error: l.error, ts: l.ts }))
      return Response.json({
        window: done.length, successRate: done.length ? Math.round((ok.length / done.length) * 100) : null,
        latencyMs: lat.length ? { p50: lat[Math.floor(lat.length / 2)], p90: lat[Math.floor(lat.length * 0.9)], max: lat[lat.length - 1] } : null,
        byAction: byType, recentFailures: failures, queued: this.inputQueue.length + (this.inputBusy ? 1 : 0), online: this.phoneSockets().length > 0,
        totals: { sent: this.info.commandsSent, ok: this.info.commandsOk, failed: this.info.commandsFailed },
      })
    }
    if (url.pathname.endsWith('/last-screenshot')) return Response.json(this.lastScreenshot ?? { ts: 0, data: null })
    if (url.pathname.endsWith('/macros')) {
      if (request.method === 'GET') return Response.json({ macros: this.macros })
      if (request.method === 'POST') {
        const m = (await request.json()) as Partial<Macro>
        const name = String(m.name ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40)
        if (!name || !Array.isArray(m.steps) || m.steps.length === 0 || m.steps.length > 25) return Response.json({ ok: false, error: 'name and steps[1..25] required' }, { status: 400 })
        const rec: Macro = { name, steps: m.steps.map((s) => ({ name: String(s.name), arguments: s.arguments ?? {} })), description: m.description?.slice(0, 200), ts: Date.now(), runs: 0, app: m.app?.slice(0, 120) || undefined }
        const i = this.macros.findIndex((x) => x.name === name)
        if (i >= 0) { rec.runs = this.macros[i].runs; this.macros[i] = rec } else { this.macros.push(rec); if (this.macros.length > MAX_MACROS) this.macros.shift() }
        await this.ctx.storage.put('macros', this.macros)
        return Response.json({ ok: true, saved: name, count: this.macros.length })
      }
      if (request.method === 'DELETE') {
        const name = url.searchParams.get('name')
        const before = this.macros.length
        this.macros = name ? this.macros.filter((x) => x.name !== name) : []
        await this.ctx.storage.put('macros', this.macros)
        return Response.json({ ok: true, removed: before - this.macros.length })
      }
    }
    if (url.pathname.endsWith('/screens')) {
      if (request.method === 'GET') return Response.json({ screens: this.screens })
      if (request.method === 'POST') {
        const s = (await request.json()) as Partial<ScreenLabel>
        const name = String(s.name ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40)
        if (!name || typeof s.hash !== 'string' || s.hash.length < 8) return Response.json({ ok: false, error: 'name and hash required' }, { status: 400 })
        const rec: ScreenLabel = { name, hash: s.hash, words: (s.words ?? []).slice(0, 12), app: s.app, ts: Date.now() }
        const i = this.screens.findIndex((x) => x.name === name)
        if (i >= 0) this.screens[i] = rec; else { this.screens.push(rec); if (this.screens.length > MAX_SCREENS) this.screens.shift() }
        await this.ctx.storage.put('screens', this.screens)
        return Response.json({ ok: true, saved: name, count: this.screens.length })
      }
      if (request.method === 'DELETE') {
        const name = url.searchParams.get('name')
        const before = this.screens.length
        this.screens = name ? this.screens.filter((x) => x.name !== name) : []
        await this.ctx.storage.put('screens', this.screens)
        return Response.json({ ok: true, removed: before - this.screens.length })
      }
    }
    // ---------- v2.2 memory management (human-facing) ----------
    if (url.pathname.endsWith('/memory')) {
      if (request.method === 'GET') {
        type Group = { app: string; label?: string; lastSeen?: number; notes: (Note & { index: number })[]; macros: Macro[]; screens: ScreenLabel[]; profile?: GameProfile; sessions: number; playedMs: number }
        const groups: Record<string, Group> = {}
        const g = (app: string): Group => (groups[app] ??= { app, label: this.apps[app]?.label ?? this.profiles[app]?.label, lastSeen: this.apps[app]?.last, notes: [], macros: [], screens: [], profile: this.profiles[app], sessions: 0, playedMs: 0 })
        this.notes.forEach((n, index) => g(n.app ?? '').notes.push({ ...n, index }))
        for (const m of this.macros) g(m.app ?? '').macros.push(m)
        for (const s of this.screens) g(s.app ?? '').screens.push(s)
        for (const app of Object.keys(this.profiles)) g(app)
        for (const app of Object.keys(this.apps)) g(app)
        for (const s of this.sessions) { const grp = g(s.app); grp.sessions++; grp.playedMs += s.end - s.start }
        const list = Object.values(groups).sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
        return Response.json({
          deviceId: this.info.deviceId,
          totals: { notes: this.notes.length, macros: this.macros.length, screens: this.screens.length, apps: Object.keys(this.apps).length, profiles: Object.keys(this.profiles).length, sessions: this.sessions.length, recording: !!this.recording },
          recording: this.recording, groups: list, apps: this.apps, sessions: this.sessions.slice(0, 20), currentApp: this.currentApp,
        })
      }
      if (request.method === 'DELETE') {
        // ?kind=notes|macros|screens|recording|apps|all  &app=<package|"">  &index=<n>  &name=<macro/screen name>
        const kind = url.searchParams.get('kind') ?? 'all'
        const app = url.searchParams.get('app')
        const name = url.searchParams.get('name')
        const idx = url.searchParams.get('index')
        const before = { notes: this.notes.length, macros: this.macros.length, screens: this.screens.length, apps: Object.keys(this.apps).length }
        const byApp = <T extends { app?: string }>(arr: T[]) => (app === null ? [] : arr.filter((x) => (x.app ?? '') !== app))
        if (kind === 'notes' || kind === 'all') {
          if (idx !== null) { const i = Number(idx); if (Number.isInteger(i) && i >= 0 && i < this.notes.length) this.notes.splice(i, 1) }
          else this.notes = app !== null ? byApp(this.notes) : []
        }
        if (kind === 'macros' || kind === 'all') {
          if (name) this.macros = this.macros.filter((m) => m.name !== name)
          else this.macros = app !== null ? byApp(this.macros) : []
        }
        if (kind === 'screens' || kind === 'all') {
          if (name) this.screens = this.screens.filter((s) => s.name !== name)
          else this.screens = app !== null ? byApp(this.screens) : []
        }
        if (kind === 'recording' || kind === 'all') { this.recording = null; await this.ctx.storage.delete('recording'); this.broadcastViewers({ kind: 'recording', active: false }) }
        if (kind === 'apps' || kind === 'all') { if (app !== null) delete this.apps[app]; else if (kind === 'apps') this.apps = {} }
        if (kind === 'all' && app === null) this.apps = {}
        const beforeProfiles = Object.keys(this.profiles).length, beforeSessions = this.sessions.length
        if (kind === 'profiles' || kind === 'all') { if (app !== null) delete this.profiles[app]; else this.profiles = {} }
        if (kind === 'sessions' || kind === 'all') { this.sessions = app !== null ? this.sessions.filter((s) => s.app !== app) : [] }
        await Promise.all([this.ctx.storage.put('notes', this.notes), this.ctx.storage.put('macros', this.macros), this.ctx.storage.put('screens', this.screens), this.ctx.storage.put('apps', this.apps), this.ctx.storage.put('profiles', this.profiles), this.ctx.storage.put('sessions', this.sessions)])
        return Response.json({ ok: true, removed: { notes: before.notes - this.notes.length, macros: before.macros - this.macros.length, screens: before.screens - this.screens.length, apps: before.apps - Object.keys(this.apps).length, profiles: beforeProfiles - Object.keys(this.profiles).length, sessions: beforeSessions - this.sessions.length }, totals: { notes: this.notes.length, macros: this.macros.length, screens: this.screens.length, profiles: Object.keys(this.profiles).length } })
      }
    }
    if (url.pathname.endsWith('/app-seen') && request.method === 'POST') {
      const { app, label } = (await request.json()) as { app?: string; label?: string }
      const pkg = String(app ?? '').trim().slice(0, 120)
      if (pkg) {
        const cur = this.apps[pkg] ?? { first: Date.now(), last: 0, n: 0 }
        cur.last = Date.now(); cur.n++; if (label) cur.label = label.slice(0, 64)
        this.apps[pkg] = cur
        // cap to 60 most recent apps
        const keys = Object.keys(this.apps)
        if (keys.length > 60) { const oldest = keys.sort((a, b) => this.apps[a].last - this.apps[b].last)[0]; delete this.apps[oldest] }
        await this.ctx.storage.put('apps', this.apps)
        this.currentApp = pkg
        this.touchSession(pkg, label)
      }
      return Response.json({ ok: true })
    }
    // ---------- v2.3 profiles (structured per-app knowledge the AI references by @name) ----------
    if (url.pathname.endsWith('/profile')) {
      const app = url.searchParams.get('app') ?? ''
      if (request.method === 'GET') return Response.json({ profile: app ? this.profiles[app] ?? null : null, apps: Object.keys(this.profiles), currentApp: this.currentApp })
      if (request.method === 'POST') {
        if (!app) return Response.json({ ok: false, error: 'app required' }, { status: 400 })
        const patch = (await request.json()) as { label?: string; genre?: string; set?: Partial<Pick<GameProfile, 'controls' | 'colors' | 'regions' | 'settings'>>; unset?: { controls?: string[]; colors?: string[]; regions?: string[]; settings?: string[] }; replace?: GameProfile }
        let p: GameProfile = this.profiles[app] ?? { app, controls: {}, colors: {}, regions: {}, settings: {}, ts: Date.now() }
        if (patch.replace) p = { ...patch.replace, app, ts: Date.now() }
        if (patch.label) p.label = patch.label.slice(0, 64)
        if (patch.genre) p.genre = patch.genre.toLowerCase().slice(0, 20)
        for (const k of ['controls', 'colors', 'regions', 'settings'] as const) {
          const s = patch.set?.[k] as Record<string, unknown> | undefined
          if (s) for (const [name, v] of Object.entries(s)) { const key = name.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_-]/g, '-').slice(0, 32); if (key) (p[k] as Record<string, unknown>)[key] = v }
          for (const name of patch.unset?.[k] ?? []) delete (p[k] as Record<string, unknown>)[name.replace(/^@/, '')]
          if (Object.keys(p[k]).length > 60) return Response.json({ ok: false, error: `too many ${k} (max 60)` }, { status: 400 })
        }
        p.ts = Date.now()
        this.profiles[app] = p
        if (Object.keys(this.profiles).length > 60) { const oldest = Object.values(this.profiles).sort((a, b) => a.ts - b.ts)[0]; delete this.profiles[oldest.app] }
        await this.ctx.storage.put('profiles', this.profiles)
        return Response.json({ ok: true, profile: p })
      }
      if (request.method === 'DELETE') {
        const had = app ? (this.profiles[app] ? 1 : 0) : Object.keys(this.profiles).length
        if (app) delete this.profiles[app]; else this.profiles = {}
        await this.ctx.storage.put('profiles', this.profiles)
        return Response.json({ ok: true, removed: had })
      }
    }
    // ---------- v2.4 session report: AI's handover note, attached to the current session + profile ----------
    if (url.pathname.endsWith('/session-report') && request.method === 'POST') {
      const b = (await request.json()) as Partial<SessionReport> & { app?: string; label?: string }
      const app = String(b.app ?? this.currentApp ?? '').trim()
      if (!app) return Response.json({ ok: false, error: 'no current app' }, { status: 400 })
      const summary = String(b.summary ?? '').trim().slice(0, 600)
      if (!summary) return Response.json({ ok: false, error: 'summary required' }, { status: 400 })
      const cur = this.sessions[0]
      const rep: SessionReport = {
        ts: Date.now(), summary,
        outcome: (['win', 'loss', 'progress', 'stuck', 'other'] as const).find((o) => o === b.outcome),
        score: typeof b.score === 'number' && Number.isFinite(b.score) ? b.score : undefined,
        level: typeof b.level === 'string' ? b.level.slice(0, 60) : undefined,
        learned: Array.isArray(b.learned) ? b.learned.filter((x) => typeof x === 'string').map((x) => x.slice(0, 200)).slice(0, 10) : undefined,
        nextTime: typeof b.nextTime === 'string' ? b.nextTime.slice(0, 400) : undefined,
        blockers: Array.isArray(b.blockers) ? b.blockers.filter((x) => typeof x === 'string').map((x) => x.slice(0, 200)).slice(0, 5) : undefined,
        durationMs: cur && cur.app === app ? cur.end - cur.start : undefined,
      }
      if (cur && cur.app === app && Date.now() - cur.end < 10 * 60_000) cur.report = rep
      else { this.sessions.unshift({ app, label: b.label, start: Date.now(), end: Date.now(), commands: 0, failed: 0, screenshots: 0, report: rep }); if (this.sessions.length > 100) this.sessions.length = 100 }
      const p: GameProfile = this.profiles[app] ?? { app, controls: {}, colors: {}, regions: {}, settings: {}, ts: Date.now() }
      if (b.label && !p.label) p.label = b.label.slice(0, 64)
      p.lastReport = rep; p.reports = (p.reports ?? 0) + 1
      let newBest = false
      if (rep.score !== undefined && (p.bestScore === undefined || rep.score > p.bestScore)) { p.bestScore = rep.score; newBest = true }
      p.ts = Date.now(); this.profiles[app] = p
      await Promise.all([this.ctx.storage.put('sessions', this.sessions), this.ctx.storage.put('profiles', this.profiles)])
      this.broadcastViewers({ kind: 'report', app, report: rep, newBest })
      return Response.json({ ok: true, app, report: rep, bestScore: p.bestScore, newBest, reports: p.reports })
    }
    if (url.pathname.endsWith('/sessions') && request.method === 'GET') {
      const app = url.searchParams.get('app')
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 30), 1), 100)
      const list = (app ? this.sessions.filter((s) => s.app === app) : this.sessions).slice(0, limit)
      return Response.json({ sessions: list, currentApp: this.currentApp })
    }
    if (url.pathname.endsWith('/recording')) {
      if (request.method === 'GET') return Response.json({ recording: this.recording })
      if (request.method === 'POST') {
        const b = (await request.json()) as { name?: string; description?: string; keepWaits?: boolean }
        if (this.recording) return Response.json({ ok: false, error: `already recording '${this.recording.name || '(unnamed)'}' since ${new Date(this.recording.startedAt).toISOString()} — stop or cancel first`, recording: this.recording }, { status: 409 })
        this.recording = { name: b.name, description: b.description, keepWaits: b.keepWaits !== false, startedAt: Date.now(), lastAt: Date.now(), steps: [] }
        await this.ctx.storage.put('recording', this.recording)
        this.broadcastViewers({ kind: 'recording', active: true, name: b.name })
        return Response.json({ ok: true, recording: this.recording })
      }
      if (request.method === 'DELETE') {
        const r = this.recording; this.recording = null
        await this.ctx.storage.delete('recording')
        this.broadcastViewers({ kind: 'recording', active: false })
        return Response.json({ ok: true, recording: r })
      }
    }
    if (url.pathname.endsWith('/record-step') && request.method === 'POST') {
      if (!this.recording) return Response.json({ ok: false, recording: false })
      const { name, arguments: args } = (await request.json()) as { name: string; arguments?: Record<string, unknown> }
      const now = Date.now()
      const gap = now - this.recording.lastAt
      if (this.recording.keepWaits && this.recording.steps.length > 0 && gap >= 300) this.recording.steps.push({ name: 'wait', arguments: { ms: Math.min(gap, 5000) } })
      this.recording.steps.push({ name, arguments: args ?? {} })
      this.recording.lastAt = now
      if (this.recording.steps.length > 25) this.recording.steps.length = 25
      await this.ctx.storage.put('recording', this.recording)
      return Response.json({ ok: true, steps: this.recording.steps.length })
    }
    if (url.pathname.endsWith('/overlay') && request.method === 'POST') {
      // agent-side visual events for the human monitor (taps, detections, ocr boxes, screen name). Never stored.
      const o = (await request.json()) as Record<string, unknown>
      this.broadcastViewers({ kind: 'overlay', ts: Date.now(), ...o })
      return Response.json({ ok: true })
    }
    if (url.pathname.endsWith('/macro-ran') && request.method === 'POST') {
      const { name } = (await request.json()) as { name: string }
      const m = this.macros.find((x) => x.name === name)
      if (m) { m.runs = (m.runs ?? 0) + 1; await this.ctx.storage.put('macros', this.macros) }
      return Response.json({ ok: true })
    }
    if (url.pathname.endsWith('/notes')) {
      if (request.method === 'GET') return Response.json({ notes: this.notes })
      if (request.method === 'POST') {
        const { text, app } = (await request.json()) as { text?: string; app?: string }
        const t = String(text ?? '').trim().slice(0, 2000)
        if (!t) return Response.json({ ok: false, error: 'text required' }, { status: 400 })
        const note: Note = { text: t, ts: Date.now() }
        const tag = String(app ?? '').trim().slice(0, 120)
        if (tag) note.app = tag
        this.notes.push(note)
        if (this.notes.length > MAX_NOTES) this.notes.splice(0, this.notes.length - MAX_NOTES)
        await this.ctx.storage.put('notes', this.notes)
        return Response.json({ ok: true, count: this.notes.length })
      }
      if (request.method === 'DELETE') {
        const rawIdx = url.searchParams.get('index')
        const idx = rawIdx === null ? -1 : Number(rawIdx)
        if (Number.isInteger(idx) && idx >= 0 && idx < this.notes.length) this.notes.splice(idx, 1)
        else this.notes = []
        await this.ctx.storage.put('notes', this.notes)
        return Response.json({ ok: true, count: this.notes.length })
      }
    }
    if (url.pathname.endsWith('/label') && request.method === 'POST') {
      const { label } = (await request.json()) as { label?: string }
      this.info.label = label?.slice(0, 64) || undefined
      await this.persist()
      this.broadcastViewers({ kind: 'status', info: this.snapshotInfo() })
      return Response.json({ ok: true })
    }
    if (url.pathname.endsWith('/clear-logs') && request.method === 'POST') {
      this.logs = []
      await this.persist()
      this.broadcastViewers({ kind: 'snapshot', info: this.snapshotInfo(), logs: [], screenshot: this.lastScreenshot })
      return Response.json({ ok: true })
    }
    if (url.pathname.endsWith('/disconnect') && request.method === 'POST') {
      for (const s of this.phoneSockets()) { try { s.close(4001, 'disconnected by admin') } catch { /* ignore */ } }
      return Response.json({ ok: true })
    }
    if (url.pathname.endsWith('/command') && request.method === 'POST') {
      const { action, wait } = (await request.json()) as { action: Action; wait?: boolean }
      return Response.json(await this.sendCommand(action, wait !== false))
    }
    return new Response('not found', { status: 404 })
  }

  // ---------- queue ----------
  private acquireInput(): Promise<void> {
    if (!this.inputBusy) { this.inputBusy = true; return Promise.resolve() }
    return new Promise((resolve) => this.inputQueue.push(resolve))
  }
  private releaseInput() {
    const next = this.inputQueue.shift()
    if (next) next()
    else this.inputBusy = false
  }

  // ---------- Command dispatch ----------
  async sendCommand(action: Action, wait: boolean): Promise<CommandResult> {
    const id = crypto.randomUUID()
    const ts = Date.now()

    if (this.phoneSockets().length === 0) {
      this.info.online = false
      this.addLog({ id, ts, action, status: 'offline', error: 'device offline' })
      await this.persist()
      return { id, ok: false, error: 'device offline' }
    }

    const readOnly = READ_ONLY_ACTIONS.has(action.type)
    let queuedMs = 0
    if (!readOnly) {
      if (this.inputQueue.length >= MAX_QUEUE) {
        this.addLog({ id, ts, action, status: 'failed', error: 'queue full' })
        return { id, ok: false, error: `input queue full (${MAX_QUEUE})` }
      }
      if (this.inputBusy) this.addLog({ id, ts, action, status: 'queued' })
      await this.acquireInput()
      queuedMs = Date.now() - ts
    }

    try {
      const res = await this.dispatch(id, action, wait, ts, queuedMs)
      // v2.3 play history: attribute the command to the current app's session
      if (this.currentApp && action.type !== 'ping' && action.type !== 'current_app' && action.type !== 'screen_hash') this.touchSession(this.currentApp, undefined, { commands: 1, failed: res.ok ? 0 : 1, screenshots: action.type === 'screenshot' ? 1 : 0 })
      return res
    } finally {
      if (!readOnly) this.releaseInput()
    }
  }

  private async dispatch(id: string, action: Action, wait: boolean, ts: number, queuedMs: number): Promise<CommandResult> {
    const phones = this.phoneSockets()
    const logged = this.logs.some((l) => l.id === id)
    if (phones.length === 0) {
      if (logged) this.updateLog(id, { status: 'offline', error: 'device offline' })
      else this.addLog({ id, ts, action, status: 'offline', error: 'device offline' })
      return { id, ok: false, error: 'device offline (disconnected while queued)', queuedMs }
    }

    const msg: CommandMessage = { kind: 'command', id, ts: Date.now(), action }
    this.info.commandsSent++
    if (logged) this.updateLog(id, { status: 'sent' })
    else this.addLog({ id, ts, action, status: 'sent' })

    try {
      phones[0].send(JSON.stringify(msg))
    } catch (e) {
      this.info.commandsFailed++
      this.updateLog(id, { status: 'failed', error: 'send failed' })
      await this.persist()
      return { id, ok: false, error: 'send failed: ' + String(e), queuedMs }
    }

    if (!wait) {
      await this.persist()
      return { id, ok: true, queued: true, queuedMs }
    }

    const sentAt = Date.now()
    const result = await new Promise<Omit<CommandResult, 'id'>>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: 'timeout waiting for device' })
      }, actionTimeoutMs(action))
      this.pending.set(id, { resolve, timer, sentAt })
    })

    if (result.ok) this.info.commandsOk++
    else this.info.commandsFailed++
    this.updateLog(id, {
      status: result.ok ? 'ok' : result.error?.startsWith('timeout') ? 'timeout' : 'failed',
      error: result.error,
      durationMs: result.durationMs,
    })
    await this.persist()
    return { id, ...result, queuedMs: queuedMs || undefined }
  }

  // ---------- WebSocket events (Hibernation API) ----------
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const tags = this.ctx.getTags(ws)
    if (!tags.includes('phone')) return

    this.info.lastSeen = Date.now()
    let msg: PhoneMessage
    try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) } catch { return }

    switch (msg.kind) {
      case 'hello': {
        this.info.model = msg.model ?? this.info.model
        this.info.android = msg.android ?? this.info.android
        this.info.appVersion = msg.appVersion ?? this.info.appVersion
        this.info.screen = msg.screen ?? this.info.screen
        this.info.accessibilityEnabled = msg.accessibilityEnabled
        if (typeof msg.battery === 'number') this.info.battery = msg.battery
        if (typeof msg.charging === 'boolean') this.info.charging = msg.charging
        this.info.online = true
        await this.persist()
        this.broadcastViewers({ kind: 'status', info: this.snapshotInfo() })
        break
      }
      case 'result': {
        const p = this.pending.get(msg.id)
        if (p) {
          clearTimeout(p.timer)
          this.pending.delete(msg.id)
          p.resolve({
            ok: msg.ok, error: msg.error, screenshot: msg.screenshot, screenshotMime: msg.screenshotMime,
            data: msg.data, durationMs: msg.durationMs ?? Date.now() - p.sentAt,
          })
        } else {
          if (msg.ok) this.info.commandsOk++
          else this.info.commandsFailed++
          this.updateLog(msg.id, { status: msg.ok ? 'ok' : 'failed', error: msg.error, durationMs: msg.durationMs })
          await this.persist()
        }
        if (msg.screenshot) {
          this.lastScreenshot = { ts: Date.now(), data: msg.screenshot, mime: msg.screenshotMime ?? 'image/png' }
          this.broadcastViewers({ kind: 'screenshot', id: msg.id, ts: this.lastScreenshot.ts, mime: this.lastScreenshot.mime, data: msg.screenshot })
        }
        break
      }
      case 'frame': {
        // live preview frame → viewers only (never stored). Auto-stop if nobody is watching.
        if (this.viewerSockets().length === 0) {
          try { ws.send(JSON.stringify({ kind: 'command', id: crypto.randomUUID(), ts: Date.now(), action: { type: 'stream', enabled: false } })) } catch { /* ignore */ }
          break
        }
        this.broadcastViewers({ kind: 'frame', ts: msg.ts, mime: msg.mime, data: msg.data })
        break
      }
      case 'pong':
        break
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    const tags = this.ctx.getTags(ws)
    if (tags.includes('phone') && this.phoneSockets().length === 0) {
      const wasOnline = this.info.online
      this.info.online = false
      this.info.lastSeen = Date.now()
      await this.persist()
      this.broadcastViewers({ kind: 'status', info: this.snapshotInfo() })
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.resolve({ ok: false, error: `device disconnected (${code} ${reason})` })
        this.pending.delete(id)
      }
      if (wasOnline) this.webhook('offline')
    }
  }

  async webSocketError(ws: WebSocket, _err: unknown) {
    await this.webSocketClose(ws, 1006, 'error')
  }
}
