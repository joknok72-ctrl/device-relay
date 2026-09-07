import { DurableObject } from 'cloudflare:workers'
import type { Action, Bindings, CommandMessage, DeviceInfo, LogEntry, Note, PhoneMessage } from './types'
import { READ_ONLY_ACTIONS, actionTimeoutMs } from './types'

const MAX_LOGS = 100
const MAX_NOTES = 40
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
        server.send(JSON.stringify({ kind: 'snapshot', info: this.snapshotInfo(), logs: this.logs, screenshot: this.lastScreenshot }))
      }
      return new Response(null, { status: 101, webSocket: client })
    }

    if (url.pathname.endsWith('/info')) return Response.json(this.snapshotInfo())
    if (url.pathname.endsWith('/logs')) return Response.json(this.logs)
    if (url.pathname.endsWith('/last-screenshot')) return Response.json(this.lastScreenshot ?? { ts: 0, data: null })
    if (url.pathname.endsWith('/notes')) {
      if (request.method === 'GET') return Response.json({ notes: this.notes })
      if (request.method === 'POST') {
        const { text } = (await request.json()) as { text?: string }
        const t = String(text ?? '').trim().slice(0, 2000)
        if (!t) return Response.json({ ok: false, error: 'text required' }, { status: 400 })
        this.notes.push({ text: t, ts: Date.now() })
        if (this.notes.length > MAX_NOTES) this.notes.splice(0, this.notes.length - MAX_NOTES)
        await this.ctx.storage.put('notes', this.notes)
        return Response.json({ ok: true, count: this.notes.length })
      }
      if (request.method === 'DELETE') {
        const idx = Number(url.searchParams.get('index'))
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
      return await this.dispatch(id, action, wait, ts, queuedMs)
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
