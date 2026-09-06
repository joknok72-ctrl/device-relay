import { DurableObject } from 'cloudflare:workers'
import type { Action, CommandMessage, DeviceInfo, LogEntry, PhoneMessage } from './types'

const COMMAND_TIMEOUT_MS = 15_000
const MAX_LOGS = 100

interface Pending {
  resolve: (r: { ok: boolean; error?: string; screenshot?: string; durationMs?: number }) => void
  timer: ReturnType<typeof setTimeout>
  sentAt: number
}

/**
 * One Durable Object instance per deviceId.
 * Holds the phone's WebSocket (hibernation-enabled) and any dashboard viewers,
 * and forwards commands with request/response correlation.
 */
export class DeviceRoom extends DurableObject {
  private pending = new Map<string, Pending>()
  private info: DeviceInfo
  private logs: LogEntry[] = []

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never)
    this.info = {
      deviceId: '',
      online: false,
      commandsSent: 0,
      commandsOk: 0,
      commandsFailed: 0,
    }
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<DeviceInfo>('info')
      if (saved) this.info = { ...saved, online: this.phoneSockets().length > 0 }
      const logs = await ctx.storage.get<LogEntry[]>('logs')
      if (logs) this.logs = logs
    })
  }

  // ---------- helpers ----------
  private phoneSockets(): WebSocket[] {
    return this.ctx.getWebSockets('phone')
  }
  private viewerSockets(): WebSocket[] {
    return this.ctx.getWebSockets('viewer')
  }
  private async persist() {
    await this.ctx.storage.put('info', this.info)
    await this.ctx.storage.put('logs', this.logs)
  }
  private broadcastViewers(msg: unknown) {
    const data = JSON.stringify(msg)
    for (const ws of this.viewerSockets()) {
      try { ws.send(data) } catch { /* ignore */ }
    }
  }
  private addLog(entry: LogEntry) {
    this.logs.unshift(entry)
    if (this.logs.length > MAX_LOGS) this.logs.length = MAX_LOGS
    this.broadcastViewers({ kind: 'log', entry })
  }
  private updateLog(id: string, patch: Partial<LogEntry>) {
    const e = this.logs.find((l) => l.id === id)
    if (e) {
      Object.assign(e, patch)
      this.broadcastViewers({ kind: 'log', entry: e })
    }
  }

  // ---------- HTTP entry (from Worker) ----------
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const deviceId = url.searchParams.get('deviceId') ?? ''
    if (!this.info.deviceId) this.info.deviceId = deviceId

    // WebSocket upgrade: role=phone | role=viewer
    if (request.headers.get('Upgrade') === 'websocket') {
      const role = url.searchParams.get('role') === 'viewer' ? 'viewer' : 'phone'
      const pair = new WebSocketPair()
      const [client, server] = [pair[0], pair[1]]

      // Only one phone connection at a time: close older ones
      if (role === 'phone') {
        for (const old of this.phoneSockets()) {
          try { old.close(4000, 'replaced by new connection') } catch { /* ignore */ }
        }
      }

      this.ctx.acceptWebSocket(server, [role])

      if (role === 'phone') {
        this.info.online = true
        this.info.connectedAt = Date.now()
        this.info.lastSeen = Date.now()
        await this.persist()
        this.broadcastViewers({ kind: 'status', info: this.info })
      } else {
        // Send current snapshot to new viewer
        server.send(JSON.stringify({ kind: 'snapshot', info: this.info, logs: this.logs }))
      }
      return new Response(null, { status: 101, webSocket: client })
    }

    if (url.pathname.endsWith('/info')) {
      this.info.online = this.phoneSockets().length > 0
      return Response.json(this.info)
    }
    if (url.pathname.endsWith('/logs')) {
      return Response.json(this.logs)
    }
    if (url.pathname.endsWith('/command') && request.method === 'POST') {
      const { action, wait } = (await request.json()) as { action: Action; wait?: boolean }
      const result = await this.sendCommand(action, wait !== false)
      return Response.json(result)
    }
    return new Response('not found', { status: 404 })
  }

  // ---------- Command dispatch ----------
  async sendCommand(action: Action, wait: boolean) {
    const id = crypto.randomUUID()
    const phones = this.phoneSockets()
    const ts = Date.now()

    if (phones.length === 0) {
      this.info.online = false
      this.addLog({ id, ts, action, status: 'offline', error: 'device offline' })
      await this.persist()
      return { id, ok: false, error: 'device offline' }
    }

    const msg: CommandMessage = { kind: 'command', id, ts, action }
    this.info.commandsSent++
    this.addLog({ id, ts, action, status: 'sent' })

    try {
      phones[0].send(JSON.stringify(msg))
    } catch (e) {
      this.info.commandsFailed++
      this.updateLog(id, { status: 'failed', error: 'send failed' })
      await this.persist()
      return { id, ok: false, error: 'send failed: ' + String(e) }
    }

    if (!wait) {
      await this.persist()
      return { id, ok: true, queued: true }
    }

    const result = await new Promise<{ ok: boolean; error?: string; screenshot?: string; durationMs?: number }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: 'timeout waiting for device' })
      }, COMMAND_TIMEOUT_MS)
      this.pending.set(id, { resolve, timer, sentAt: ts })
    })

    if (result.ok) this.info.commandsOk++
    else this.info.commandsFailed++
    this.updateLog(id, {
      status: result.ok ? 'ok' : result.error?.startsWith('timeout') ? 'timeout' : 'failed',
      error: result.error,
      durationMs: result.durationMs,
    })
    await this.persist()
    return { id, ...result }
  }

  // ---------- WebSocket events (Hibernation API) ----------
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const tags = this.ctx.getTags(ws)
    if (!tags.includes('phone')) return // viewers are read-only

    this.info.lastSeen = Date.now()
    let msg: PhoneMessage
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    } catch {
      return
    }

    switch (msg.kind) {
      case 'hello': {
        this.info.model = msg.model ?? this.info.model
        this.info.android = msg.android ?? this.info.android
        this.info.appVersion = msg.appVersion ?? this.info.appVersion
        this.info.screen = msg.screen ?? this.info.screen
        this.info.accessibilityEnabled = msg.accessibilityEnabled
        this.info.online = true
        await this.persist()
        this.broadcastViewers({ kind: 'status', info: this.info })
        break
      }
      case 'result': {
        const p = this.pending.get(msg.id)
        if (p) {
          clearTimeout(p.timer)
          this.pending.delete(msg.id)
          p.resolve({
            ok: msg.ok,
            error: msg.error,
            screenshot: msg.screenshot,
            durationMs: msg.durationMs ?? Date.now() - p.sentAt,
          })
        } else {
          // fire-and-forget command result
          if (msg.ok) this.info.commandsOk++
          else this.info.commandsFailed++
          this.updateLog(msg.id, { status: msg.ok ? 'ok' : 'failed', error: msg.error, durationMs: msg.durationMs })
          await this.persist()
        }
        if (msg.screenshot) {
          this.broadcastViewers({ kind: 'screenshot', id: msg.id, data: msg.screenshot })
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
      this.info.online = false
      this.info.lastSeen = Date.now()
      await this.persist()
      this.broadcastViewers({ kind: 'status', info: this.info })
      // Fail all pending
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.resolve({ ok: false, error: `device disconnected (${code} ${reason})` })
        this.pending.delete(id)
      }
    }
  }

  async webSocketError(ws: WebSocket, _err: unknown) {
    await this.webSocketClose(ws, 1006, 'error')
  }
}
