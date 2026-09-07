import type { Bindings, DeviceInfo } from './types'
import { parseAction } from './validate'
import { toolToAction, TOOLS, READ_ONLY_TOOLS, OBSERVATION_TOOLS } from './tools'
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
  if (mapped.special === 'tap_color') return tapColor(env, deviceId, args, opts)
  if (mapped.special === 'game_loop') return gameLoop(env, deviceId, args, opts)
  if (mapped.special === 'save_macro') return saveMacro(env, deviceId, args)
  if (mapped.special === 'run_macro') return runMacro(env, deviceId, args, opts)
  if (mapped.special === 'list_macros') return listMacros(env, deviceId, args)
  if (mapped.special === 'tap_text') return tapText(env, deviceId, args, opts)
  if (mapped.special === 'wait_for_text') return waitForText(env, deviceId, args, opts)
  if (mapped.special === 'session_stats') return (await (await room(env, deviceId).fetch(`https://do/stats?deviceId=${deviceId}`)).json()) as ToolResult

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

// ---------------------------------------------------------------- v1.6 reflexes, loops, macros

/** find_color + tap in one round-trip */
async function tapColor(env: Bindings, deviceId: string, args: Record<string, unknown>, opts: ExecOptions): Promise<ToolResult> {
  const f = await executeTool(env, deviceId, 'find_color', { color: args.color, tolerance: args.tolerance, region: args.region }, opts)
  const d = f.data as { found?: boolean; count?: number; cx?: number; cy?: number } | undefined
  const minCount = Math.max(1, Number(args.minCount ?? 20) || 20)
  if (!f.ok) return f
  if (!d?.found || (d.count ?? 0) < minCount) return { ok: false, found: false, error: `color ${args.color} not found (count=${d?.count ?? 0} < ${minCount})`, count: d?.count ?? 0 }
  const x = Math.round((d.cx ?? 0) + (Number(args.offsetX) || 0)), y = Math.round((d.cy ?? 0) + (Number(args.offsetY) || 0))
  const t = await executeTool(env, deviceId, 'tap', { x, y }, opts)
  return { ...t, found: true, tapped: { x, y }, count: d.count, cx: d.cx, cy: d.cy }
}

/** Does an observation result count as a match? Returns [matched, cx, cy]. */
function observationMatched(name: string, r: ToolResult, minChange: number): [boolean, number | undefined, number | undefined] {
  if (!r.ok) return [false, undefined, undefined]
  const d = (r.data ?? r) as Record<string, unknown>
  switch (name) {
    case 'find_color': case 'tap_color': return [d.found === true, d.cx as number | undefined, d.cy as number | undefined]
    case 'watch_color': case 'wait_pixel': return [d.matched === true || d.found === true, d.cx as number | undefined, d.cy as number | undefined]
    case 'find_image': { const m = (d.matches as { cx: number; cy: number }[] | undefined) ?? []; return [m.length > 0, m[0]?.cx, m[0]?.cy] }
    case 'screen_diff': return [Number(d.changedPct ?? 0) >= minChange, (d.regions as { cx: number; cy: number }[] | undefined)?.[0]?.cx, (d.regions as { cx: number; cy: number }[] | undefined)?.[0]?.cy]
    case 'get_pixels': { const px = (d.pixels as { hex: string }[] | undefined) ?? []; return [px.length > 0, undefined, undefined] }
    case 'find_colors': { const res = (d.results as { found: boolean; cx?: number; cy?: number }[] | undefined) ?? []; const f = res.find((x) => x.found); return [!!f, f?.cx, f?.cy] }
    case 'read_text': { const lines = (d.lines as { cx: number; cy: number }[] | undefined) ?? []; return [lines.length > 0, lines[0]?.cx, lines[0]?.cy] }
    case 'wait_for_text': { const m = r.match as { cx: number; cy: number } | undefined; return [r.found === true, m?.cx, m?.cy] }
    case 'wait_for_element': { const e = r.element as { cx: number; cy: number } | undefined; return [r.found === true, e?.cx, e?.cy] }
    default: return [false, undefined, undefined]
  }
}
function injectXY(args: Record<string, unknown> | undefined, cx?: number, cy?: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args ?? {})) {
    if (v === '$cx') out[k] = cx ?? 0
    else if (v === '$cy') out[k] = cy ?? 0
    else if (typeof v === 'string' && /^\$c[xy][+-]\d+$/.test(v)) { const base = v[2] === 'x' ? (cx ?? 0) : (cy ?? 0); out[k] = base + Number(v.slice(3)) }
    else out[k] = v
  }
  return out
}

/** Server-side perception→action loop */
async function gameLoop(env: Bindings, deviceId: string, args: Record<string, unknown>, opts: ExecOptions): Promise<ToolResult> {
  type Call = { name?: string; arguments?: Record<string, unknown> }
  const when = args.when as Call | undefined, then = args.then as Call | undefined, els = args.else as Call | undefined, stop = args.stopWhen as Call | undefined
  if (!when?.name || !OBSERVATION_TOOLS.has(when.name)) return { ok: false, error: `when must be an observation tool: ${[...OBSERVATION_TOOLS].join('|')}` }
  if (!then?.name || !TOOLS.some((t) => t.name === then.name)) return { ok: false, error: 'then must be a valid tool {name, arguments}' }
  if (['game_loop', 'batch', 'act_and_see', 'run_macro'].includes(then.name)) return { ok: false, error: `then cannot be ${then.name}` }
  if (stop && (!stop.name || !OBSERVATION_TOOLS.has(stop.name))) return { ok: false, error: 'stopWhen must be an observation tool' }
  const iterations = Math.min(Math.max(Number(args.iterations) || 20, 1), 60)
  const interval = Math.min(Math.max(Number(args.intervalMs ?? 200) || 0, 0), 5000)
  const maxMs = Math.min(Math.max(Number(args.maxMs) || 30_000, 1000), 55_000)
  const minChange = Number(args.minChange ?? 2) || 2
  const t0 = Date.now()
  const trace: unknown[] = []
  let acted = 0, matched = 0, stoppedBy: string | undefined
  const sub = { ...opts, depth: (opts.depth ?? 0) + 1 }
  for (let i = 0; i < iterations; i++) {
    if (Date.now() - t0 > maxMs) { stoppedBy = 'maxMs'; break }
    if (stop) {
      const s = await executeTool(env, deviceId, stop.name!, stop.arguments ?? {}, sub)
      if (observationMatched(stop.name!, s, minChange)[0]) { stoppedBy = 'stopWhen'; trace.push({ i, stop: true }); break }
    }
    const w = await executeTool(env, deviceId, when.name, when.arguments ?? {}, sub)
    if (!w.ok && !['watch_color', 'wait_pixel'].includes(when.name)) { trace.push({ i, when: 'error', error: w.error }); return { ok: false, error: `observation failed: ${w.error}`, rounds: i + 1, acted, matched, trace, durationMs: Date.now() - t0 } }
    const [hit, cx, cy] = observationMatched(when.name, w, minChange)
    const step: Record<string, unknown> = { i, hit, ...(cx !== undefined ? { cx, cy } : {}) }
    if (hit) {
      matched++
      const r = await executeTool(env, deviceId, then.name, injectXY(then.arguments, cx, cy), sub)
      acted++
      step.then = { name: then.name, ok: r.ok, ...(r.error ? { error: r.error } : {}) }
      if (!r.ok) { trace.push(step); return { ok: false, error: `then failed at round ${i}: ${r.error}`, rounds: i + 1, acted, matched, trace, durationMs: Date.now() - t0 } }
    } else if (els?.name) {
      const r = await executeTool(env, deviceId, els.name, injectXY(els.arguments, cx, cy), sub)
      step.else = { name: els.name, ok: r.ok, ...(r.error ? { error: r.error } : {}) }
    }
    trace.push(step)
    if (interval) await new Promise((r) => setTimeout(r, interval))
  }
  return { ok: true, rounds: trace.length, acted, matched, stoppedBy: stoppedBy ?? 'iterations', trace, durationMs: Date.now() - t0 }
}

// ---- OCR helpers
interface OcrLine { text: string; cx: number; cy: number; x?: number; y?: number; w?: number; h?: number }
async function ocrLines(env: Bindings, deviceId: string, region: unknown, opts: ExecOptions): Promise<{ ok: boolean; error?: string; lines: OcrLine[] }> {
  const r = await executeTool(env, deviceId, 'read_text', region ? { region } : {}, opts)
  const d = r.data as { lines?: OcrLine[] } | undefined
  return { ok: r.ok, error: r.error, lines: d?.lines ?? [] }
}
function matchLines(lines: OcrLine[], q: string): OcrLine[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return []
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const exact = lines.filter((l) => norm(l.text) === needle)
  if (exact.length) return exact
  return lines.filter((l) => norm(l.text).includes(needle))
}
async function tapText(env: Bindings, deviceId: string, args: Record<string, unknown>, opts: ExecOptions): Promise<ToolResult> {
  const q = String(args.text ?? '')
  if (!q.trim()) return { ok: false, error: 'tap_text requires text' }
  const o = await ocrLines(env, deviceId, args.region, opts)
  if (!o.ok) return { ok: false, error: o.error ?? 'OCR failed (needs Android app v1.7+)' }
  const hits = matchLines(o.lines, q)
  if (!hits.length) return { ok: false, found: false, error: `text "${q}" not found on screen`, seen: o.lines.slice(0, 15).map((l) => l.text) }
  const idx = Math.min(Math.max(Number(args.index) || 0, 0), hits.length - 1)
  const h = hits[idx]
  const t = await executeTool(env, deviceId, 'tap', { x: h.cx, y: h.cy }, opts)
  return { ...t, found: true, matched: hits.length, match: h, tapped: { x: h.cx, y: h.cy } }
}
async function waitForText(env: Bindings, deviceId: string, args: Record<string, unknown>, opts: ExecOptions): Promise<ToolResult> {
  const q = String(args.text ?? '')
  if (!q.trim()) return { ok: false, error: 'wait_for_text requires text' }
  const appear = args.appear !== false
  const timeout = Math.min(Math.max(Number(args.timeoutMs) || 8000, 500), 30_000)
  const interval = Math.min(Math.max(Number(args.intervalMs) || 700, 300), 3000)
  const start = Date.now(); let polls = 0
  while (Date.now() - start < timeout) {
    const o = await ocrLines(env, deviceId, args.region, opts); polls++
    if (!o.ok) return { ok: false, error: o.error ?? 'OCR failed' }
    const hits = matchLines(o.lines, q)
    if ((hits.length > 0) === appear) return { ok: true, found: hits.length > 0, appear, match: hits[0], waitedMs: Date.now() - start, polls }
    await new Promise((r) => setTimeout(r, interval))
  }
  return { ok: false, found: !appear, error: `text "${q}" did not ${appear ? 'appear' : 'disappear'} within ${timeout}ms`, waitedMs: Date.now() - start, polls }
}

// ---- macros
async function saveMacro(env: Bindings, deviceId: string, args: Record<string, unknown>): Promise<ToolResult> {
  const steps = args.steps
  if (!Array.isArray(steps)) return { ok: false, error: 'steps must be an array' }
  for (const s of steps as { name?: string }[]) if (!s?.name || !TOOLS.some((t) => t.name === s.name) || ['run_macro', 'save_macro'].includes(s.name)) return { ok: false, error: `invalid step tool: ${s?.name}` }
  const r = await room(env, deviceId).fetch(`https://do/macros?deviceId=${deviceId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: args.name, steps, description: args.description }) })
  return (await r.json()) as ToolResult
}
async function listMacros(env: Bindings, deviceId: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (typeof args.delete === 'string' && args.delete) {
    const r = await room(env, deviceId).fetch(`https://do/macros?deviceId=${deviceId}&name=${encodeURIComponent(args.delete)}`, { method: 'DELETE' })
    return (await r.json()) as ToolResult
  }
  const { macros } = (await (await room(env, deviceId).fetch(`https://do/macros?deviceId=${deviceId}`)).json()) as { macros: { name: string; description?: string; steps: unknown[]; runs?: number; ts: number }[] }
  return { ok: true, count: macros.length, macros: macros.map((m) => ({ name: m.name, description: m.description, steps: m.steps.length, runs: m.runs ?? 0, ts: m.ts })) }
}
async function runMacro(env: Bindings, deviceId: string, args: Record<string, unknown>, opts: ExecOptions): Promise<ToolResult> {
  const name = String(args.name ?? '').trim().toLowerCase()
  const { macros } = (await (await room(env, deviceId).fetch(`https://do/macros?deviceId=${deviceId}`)).json()) as { macros: { name: string; steps: unknown[] }[] }
  const m = macros.find((x) => x.name === name)
  if (!m) return { ok: false, error: `macro '${name}' not found`, available: macros.map((x) => x.name) }
  const r = await runBatch(env, deviceId, { steps: m.steps, continueOnError: args.continueOnError === true }, { ...opts, depth: 0 })
  room(env, deviceId).fetch(`https://do/macro-ran?deviceId=${deviceId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).catch(() => {})
  return { ...r, macro: name }
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
