import type { Bindings, DeviceInfo } from './types'
import { parseAction } from './validate'
import { toolToAction, TOOLS, READ_ONLY_TOOLS } from './tools'
import type { DeviceRegistry } from './registry'
import type { CommandResult } from './device-room'

export interface ToolResult {
  ok: boolean
  error?: string
  durationMs?: number
  screen?: { w: number; h: number }
  image?: { mime: string; base64: string; w: number; h: number; scale: number }
  status?: DeviceInfo
  queuedMs?: number
  [k: string]: unknown
}

export interface ExecOptions {
  /** true when the caller's token is read-only: input tools are rejected */
  readOnly?: boolean
  /** recursion depth guard for batch */
  depth?: number
}

/** Read JPEG width/height from SOF marker of a base64 JPEG. */
export function jpegSize(b64: string): { w: number; h: number } | null {
  try {
    const bin = atob(b64.slice(0, Math.min(b64.length, 120_000)))
    if (bin.charCodeAt(0) !== 0xff || bin.charCodeAt(1) !== 0xd8) return null
    let i = 2
    while (i < bin.length - 9) {
      if (bin.charCodeAt(i) !== 0xff) { i++; continue }
      const marker = bin.charCodeAt(i + 1)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: (bin.charCodeAt(i + 5) << 8) | bin.charCodeAt(i + 6), w: (bin.charCodeAt(i + 7) << 8) | bin.charCodeAt(i + 8) }
      }
      i += 2 + ((bin.charCodeAt(i + 2) << 8) | bin.charCodeAt(i + 3))
    }
    return null
  } catch { return null }
}

/** Read PNG width/height from IHDR chunk of a base64 PNG (no full decode). */
export function pngSize(b64: string): { w: number; h: number } | null {
  try {
    const head = atob(b64.slice(0, 48))
    if (head.charCodeAt(0) !== 0x89 || head.slice(1, 4) !== 'PNG') return null
    const be = (o: number) => ((head.charCodeAt(o) << 24) | (head.charCodeAt(o + 1) << 16) | (head.charCodeAt(o + 2) << 8) | head.charCodeAt(o + 3)) >>> 0
    return { w: be(16), h: be(20) }
  } catch {
    return null
  }
}

function room(env: Bindings, deviceId: string) {
  return env.DEVICE_ROOM.get(env.DEVICE_ROOM.idFromName(deviceId))
}

export async function deviceInfo(env: Bindings, deviceId: string): Promise<DeviceInfo> {
  const r = await room(env, deviceId).fetch(`https://do/info?deviceId=${deviceId}`)
  return (await r.json()) as DeviceInfo
}

/** Execute one AI tool against a device and return a normalized result. */
export async function executeTool(env: Bindings, deviceId: string, name: string, args: Record<string, unknown>, opts: ExecOptions = {}): Promise<ToolResult> {
  const mapped = toolToAction(name, args ?? {})
  if (mapped.error) return { ok: false, error: mapped.error }
  if (opts.readOnly && !READ_ONLY_TOOLS.has(name)) return { ok: false, error: `token is read-only: tool '${name}' not allowed` }

  if (mapped.special === 'batch') return runBatch(env, deviceId, args, opts)

  if (mapped.special === 'wait') {
    const ms = Math.min(Math.max(Number(args?.ms) || 0, 0), 10_000)
    await new Promise((r) => setTimeout(r, ms))
    return { ok: true, waitedMs: ms }
  }
  if (mapped.special === 'status') {
    const info = await deviceInfo(env, deviceId)
    return { ok: true, status: info, screen: info.screen }
  }

  if (mapped.special === 'wait_for') return waitForElement(env, deviceId, args)
  if (mapped.special === 'find_tap') return findAndTap(env, deviceId, args)
  if (mapped.special === 'act_and_see') return actAndSee(env, deviceId, args, opts)
  if (mapped.special === 'wait_for_screen') return waitForScreen(env, deviceId, args)
  if (mapped.special === 'remember') return remember(env, deviceId, args)
  if (mapped.special === 'recall') return recall(env, deviceId, args)

  let actionInput: Record<string, unknown> | undefined = mapped.action
  if (mapped.special === 'scroll') {
    const info = await deviceInfo(env, deviceId)
    const w = info.screen?.w ?? 1080
    const h = info.screen?.h ?? 2400
    const amt = Math.min(Math.max(Number(args?.amount) || 0.5, 0.1), 0.9)
    const cx = Math.round(w / 2), cy = Math.round(h / 2)
    const dy = Math.round(h * amt / 2), dx = Math.round(w * amt / 2)
    const dir = String(args?.direction ?? 'down').toLowerCase()
    const map: Record<string, [number, number, number, number]> = {
      down: [cx, cy + dy, cx, cy - dy], up: [cx, cy - dy, cx, cy + dy],
      right: [cx + dx, cy, cx - dx, cy], left: [cx - dx, cy, cx + dx, cy],
    }
    const c = map[dir]
    if (!c) return { ok: false, error: 'direction must be down|up|left|right' }
    actionInput = { type: 'swipe', x1: c[0], y1: c[1], x2: c[2], y2: c[3], duration: 350 }
  }

  const { action, error } = parseAction(actionInput)
  if (!action) return { ok: false, error }

  const r = await room(env, deviceId).fetch(`https://do/command?deviceId=${deviceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, wait: true }),
  })
  const res = (await r.json()) as CommandResult

  const out: ToolResult = { ok: res.ok, error: res.error, durationMs: res.durationMs }
  if (res.queuedMs) out.queuedMs = res.queuedMs
  if (res.data !== undefined) out.data = res.data
  if (name === 'capture_screen') {
    const info = await deviceInfo(env, deviceId)
    out.screen = info.screen
    if (res.screenshot) {
      const mime = res.screenshotMime ?? 'image/png'
      const sz = (mime === 'image/jpeg' ? jpegSize(res.screenshot) : pngSize(res.screenshot)) ?? { w: 0, h: 0 }
      const scale = info.screen?.w && sz.w ? sz.w / info.screen.w : 1
      out.image = { mime, base64: res.screenshot, w: sz.w, h: sz.h, scale: Number(scale.toFixed(4)) }
    }
  }
  return out
}

/** batch: run N tools sequentially in one request. */
async function runBatch(env: Bindings, deviceId: string, args: Record<string, unknown>, opts: ExecOptions): Promise<ToolResult> {
  if ((opts.depth ?? 0) >= 1) return { ok: false, error: 'nested batch not allowed' }
  const steps = args.steps
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 25) return { ok: false, error: 'steps must be an array of 1..25 {name, arguments}' }
  const continueOnError = args.continueOnError === true
  const results: Array<{ name: string } & ToolResult> = []
  let allOk = true
  const t0 = Date.now()
  for (const raw of steps) {
    const st = raw as { name?: string; arguments?: Record<string, unknown>; args?: Record<string, unknown> }
    const name = String(st?.name ?? '')
    if (!TOOLS.some((t) => t.name === name)) {
      results.push({ name, ok: false, error: `unknown tool ${name}` })
      allOk = false
      if (!continueOnError) break
      continue
    }
    const r = await executeTool(env, deviceId, name, st.arguments ?? st.args ?? {}, { ...opts, depth: (opts.depth ?? 0) + 1 })
    results.push({ name, ...r })
    if (!r.ok) { allOk = false; if (!continueOnError) break }
  }
  // keep only the LAST image to bound payload size
  let lastImg: ToolResult['image'] | undefined
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].image) { if (!lastImg) lastImg = results[i].image; delete results[i].image }
  }
  return { ok: allOk, steps: results.length, results, durationMs: Date.now() - t0, image: lastImg }
}

/** Pick a default device: the first online one, else first known. */
export async function defaultDevice(env: Bindings & { REGISTRY: DurableObjectNamespace<DeviceRegistry> }): Promise<string | null> {
  const reg = env.REGISTRY.get(env.REGISTRY.idFromName('global'))
  const ids = (await reg.list()) as string[]
  if (ids.length === 0) return null
  for (const id of ids) {
    const info = await deviceInfo(env, id)
    if (info.online) return id
  }
  return ids[0]
}

// ---------------------------------------------------------------- v1.5 game primitives

/** One action + wait + screenshot in a single round-trip. */
async function actAndSee(env: Bindings, deviceId: string, args: Record<string, unknown>, opts: ExecOptions): Promise<ToolResult> {
  const act = args.action as { name?: string; arguments?: Record<string, unknown> } | undefined
  if (!act || typeof act.name !== 'string') return { ok: false, error: 'act_and_see requires action {name, arguments}' }
  if (['act_and_see', 'batch', 'capture_screen'].includes(act.name)) return { ok: false, error: `action '${act.name}' not allowed inside act_and_see` }
  const t0 = Date.now()
  const a = await executeTool(env, deviceId, act.name, act.arguments ?? {}, { ...opts, depth: (opts.depth ?? 0) + 1 })
  const waitMs = Math.min(Math.max(Number(args.waitMs ?? 400) || 0, 0), 10_000)
  if (a.ok && waitMs) await new Promise((r) => setTimeout(r, waitMs))
  const shotArgs: Record<string, unknown> = {}
  for (const k of ['maxWidth', 'format', 'quality', 'grid', 'region']) if (args[k] !== undefined) shotArgs[k] = args[k]
  const shot = a.ok ? await executeTool(env, deviceId, 'capture_screen', shotArgs, opts) : { ok: false, error: 'skipped (action failed)' }
  const { image, ...shotRest } = shot
  return { ok: a.ok && shot.ok, action: { name: act.name, ...a }, screenshot: shotRest, image, screen: shot.screen, durationMs: Date.now() - t0 }
}

/** Poll cheap on-device frame hashes until the screen changes or stabilises. */
async function waitForScreen(env: Bindings, deviceId: string, args: Record<string, unknown>): Promise<ToolResult> {
  const mode = args.mode === 'stable' ? 'stable' : 'change'
  const timeout = Math.min(Math.max(Number(args.timeoutMs) || 5000, 200), 30_000)
  const interval = Math.min(Math.max(Number(args.intervalMs) || 250, 100), 2000)
  const stableFor = Math.min(Math.max(Number(args.stableFor) || 600, 200), 5000)
  const start = Date.now()
  const first = await hashOf(env, deviceId)
  if (!first.ok) return { ok: false, error: first.error ?? 'screen_hash failed (update the Android app to v1.5)' }
  let last = first.hash, lastChange = Date.now(), polls = 1
  while (Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, interval))
    const h = await hashOf(env, deviceId); polls++
    if (!h.ok) return { ok: false, error: h.error }
    const changed = h.hash !== last
    if (mode === 'change' && changed) return { ok: true, changed: true, waitedMs: Date.now() - start, polls }
    if (changed) { last = h.hash; lastChange = Date.now() }
    if (mode === 'stable' && Date.now() - lastChange >= stableFor) return { ok: true, stable: true, waitedMs: Date.now() - start, polls }
  }
  return { ok: false, [mode === 'change' ? 'changed' : 'stable']: false, error: `screen did not ${mode === 'change' ? 'change' : 'stabilise'} within ${timeout}ms`, waitedMs: Date.now() - start, polls }
}
async function hashOf(env: Bindings, deviceId: string): Promise<{ ok: boolean; hash?: string; error?: string }> {
  const r = await executeTool(env, deviceId, 'screen_hash' as string, {})
  const d = r.data as { hash?: string } | undefined
  return { ok: r.ok && !!d?.hash, hash: d?.hash, error: r.error }
}

/** Persistent per-device notes (memory across chats). */
async function remember(env: Bindings, deviceId: string, args: Record<string, unknown>): Promise<ToolResult> {
  const text = String(args.text ?? '').trim()
  if (!text) return { ok: false, error: 'remember requires text' }
  const r = await room(env, deviceId).fetch(`https://do/notes?deviceId=${deviceId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  return (await r.json()) as ToolResult
}
async function recall(env: Bindings, deviceId: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (args.forget !== undefined && args.forget !== null) {
    const idx = Number(args.forget)
    const r = await room(env, deviceId).fetch(`https://do/notes?deviceId=${deviceId}${idx >= 0 ? `&index=${idx}` : ''}`, { method: 'DELETE' })
    return (await r.json()) as ToolResult
  }
  const r = await room(env, deviceId).fetch(`https://do/notes?deviceId=${deviceId}`)
  const { notes } = (await r.json()) as { notes: { text: string; ts: number }[] }
  return { ok: true, count: notes.length, notes: notes.map((n, i) => ({ index: i, text: n.text, ts: n.ts })) }
}

// ---------------------------------------------------------------- composite tools
interface UiElement { i: number; text?: string; desc?: string; hint?: string; id?: string; cx: number; cy: number; [k: string]: unknown }

function matchElement(elements: UiElement[], text?: unknown, elementId?: unknown): UiElement | undefined {
  const q = typeof text === 'string' && text.trim() ? text.trim().toLowerCase() : undefined
  const id = typeof elementId === 'string' && elementId.trim() ? elementId.trim().toLowerCase() : undefined
  if (!q && !id) return undefined
  const hits = elements.filter((e) => {
    const idOk = !id || e.id?.toLowerCase() === id
    const textOk = !q || [e.text, e.desc, e.hint].some((t) => typeof t === 'string' && t.toLowerCase().includes(q))
    return idOk && textOk
  })
  if (q) {
    const exact = hits.find((e) => [e.text, e.desc].some((t) => typeof t === 'string' && t.trim().toLowerCase() === q))
    if (exact) return exact
  }
  return hits[0]
}

async function uiElements(env: Bindings, deviceId: string): Promise<{ ok: boolean; error?: string; elements: UiElement[] }> {
  const r = await executeTool(env, deviceId, 'get_ui_elements', {})
  const data = r.data as { elements?: UiElement[] } | undefined
  return { ok: r.ok, error: r.error, elements: data?.elements ?? [] }
}

async function waitForElement(env: Bindings, deviceId: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (!args.text && !args.elementId) return { ok: false, error: 'wait_for_element requires text or elementId' }
  const timeout = Math.min(Math.max(Number(args.timeoutMs) || 8000, 500), 30_000)
  const start = Date.now()
  let polls = 0
  while (Date.now() - start < timeout) {
    const ui = await uiElements(env, deviceId)
    polls++
    if (!ui.ok) return { ok: false, error: ui.error ?? 'ui dump failed', polls }
    const hit = matchElement(ui.elements, args.text, args.elementId)
    if (hit) return { ok: true, found: true, element: hit, waitedMs: Date.now() - start, polls }
    await new Promise((r) => setTimeout(r, 600))
  }
  return { ok: false, found: false, error: `element not found within ${timeout}ms`, waitedMs: Date.now() - start, polls }
}

async function findAndTap(env: Bindings, deviceId: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (!args.text && !args.elementId) return { ok: false, error: 'find_and_tap requires text or elementId' }
  const maxScrolls = Math.min(Math.max(Number(args.maxScrolls ?? 8), 0), 30)
  const direction = typeof args.direction === 'string' ? args.direction : 'down'
  for (let attempt = 0; attempt <= maxScrolls; attempt++) {
    const ui = await uiElements(env, deviceId)
    if (!ui.ok) return { ok: false, error: ui.error ?? 'ui dump failed' }
    const hit = matchElement(ui.elements, args.text, args.elementId)
    if (hit) {
      const tapped = await executeTool(env, deviceId, 'tap', { x: hit.cx, y: hit.cy })
      return { ...tapped, found: true, scrolls: attempt, element: hit }
    }
    if (attempt === maxScrolls) break
    const sc = await executeTool(env, deviceId, 'scroll', { direction, amount: 0.5 })
    if (!sc.ok) return { ok: false, error: `scroll failed: ${sc.error}`, scrolls: attempt }
    await new Promise((r) => setTimeout(r, 500))
  }
  return { ok: false, found: false, error: `not found after ${maxScrolls} scrolls`, scrolls: maxScrolls }
}
