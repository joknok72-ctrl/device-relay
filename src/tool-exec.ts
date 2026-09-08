import type { Bindings, DeviceInfo } from './types'
import { parseAction } from './validate'
import { toolToAction, TOOLS, READ_ONLY_TOOLS, OBSERVATION_TOOLS } from './tools'
import type { DeviceRegistry } from './registry'
import type { CommandResult } from './device-room'
import { BOT_TEMPLATES, templateSummary } from './bot-templates'

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
  /** set by composite tools for their internal sub-calls (not recorded by record_macro) */
  internal?: boolean
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
/** Input tools that must not be captured by record_macro (meta / non-replayable). */
const NO_RECORD: ReadonlySet<string> = new Set(['record_macro', 'save_macro', 'run_macro', 'remember', 'label_screen', 'game_loop', 'do_until', 'auto_react', 'act_and_see', 'batch', 'dismiss_popups', 'game_profile', 'calibrate', 'session_report', 'game_bot'])

/** Push a visual event to /monitor viewers (fire-and-forget). */
function overlay(env: Bindings, deviceId: string, o: Record<string, unknown>) {
  room(env, deviceId).fetch(`https://do/overlay?deviceId=${deviceId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) }).catch(() => {})
}

export async function deviceInfo(env: Bindings, deviceId: string): Promise<DeviceInfo> {
  const r = await room(env, deviceId).fetch(`https://do/info?deviceId=${deviceId}`)
  return (await r.json()) as DeviceInfo
}

// ---------------------------------------------------------------- v2.3 @name resolution against the game profile
interface ProfileRec { app: string; label?: string; controls: Record<string, { x: number; y: number; note?: string; reactMs?: number }>; colors: Record<string, { hex: string; tolerance?: number }>; regions: Record<string, { x: number; y: number; w: number; h: number }>; settings: Record<string, unknown>; ts: number; genre?: string; bestScore?: number; lastReport?: unknown; reports?: number }
async function loadProfile(env: Bindings, deviceId: string, app?: string): Promise<{ app: string; profile: ProfileRec | null }> {
  let pkg = app?.trim() ?? ''
  if (!pkg || pkg === 'current') {
    // cheap: the DO remembers the last app it saw; only ask the phone when it knows nothing
    const r = (await (await room(env, deviceId).fetch(`https://do/profile?deviceId=${deviceId}`)).json()) as { currentApp?: string }
    pkg = r.currentApp || (await currentPackage(env, deviceId))
  }
  if (!pkg) return { app: '', profile: null }
  const r = (await (await room(env, deviceId).fetch(`https://do/profile?deviceId=${deviceId}&app=${encodeURIComponent(pkg)}`)).json()) as { profile: ProfileRec | null }
  return { app: pkg, profile: r.profile }
}
function hasRef(v: unknown): boolean {
  if (typeof v === 'string') return v.startsWith('@')
  if (Array.isArray(v)) return v.some(hasRef)
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).some(hasRef)
  return false
}
/** "@jump" | "@jump+20,-10" -> {name, dx, dy} */
function parseRef(s: string, known?: (name: string) => boolean): { name: string; dx: number; dy: number } | null {
  // "@name", "@name+20,-10", "@name-500". Names may contain '-', so "@stick-500" is ambiguous: prefer whatever exists in the profile.
  const plain = s.match(/^@([a-z0-9_-]+)$/i)
  const off = s.match(/^@([a-z0-9_]+(?:-[a-z_][a-z0-9_]*)*)([+-]\d+)(?:,([+-]?\d+))?$/i)
  if (plain && (!off || (known ? known(plain[1].toLowerCase()) : false))) return { name: plain[1].toLowerCase(), dx: 0, dy: 0 }
  const m = off ?? plain
  return m ? { name: m[1].toLowerCase(), dx: Number(m[2] ?? 0), dy: Number(m[3] ?? 0) } : null
}
/** Replace @refs in tool args using the profile. Returns error if an @ref is unknown. */
function resolveRefs(args: Record<string, unknown>, p: ProfileRec): { args: Record<string, unknown>; error?: string; used: string[] } {
  const used: string[] = []
  let error: string | undefined
  const known = (n: string) => n in p.controls || n in p.colors || n in p.regions || n in p.settings
  const look = (ref: string) => { const r = parseRef(ref, known); if (!r) { error = `bad reference ${ref}`; return null } return r }
  const walk = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x))
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      const out: Record<string, unknown> = {}
      // point objects: {at:"@jump"} or x/y refs
      const at = typeof o.at === 'string' && o.at.startsWith('@') ? look(o.at) : null
      if (at) {
        const c = p.controls[at.name]
        if (!c) error = `unknown control @${at.name} (known: ${Object.keys(p.controls).join(', ') || 'none'})`
        else { out.x = c.x + at.dx; out.y = c.y + at.dy; used.push('@' + at.name) }
      }
      for (const [k, val] of Object.entries(o)) {
        if (k === 'at' && at) continue
        out[k] = walk(val, k)
      }
      return out
    }
    if (typeof v === 'string' && v.startsWith('@')) {
      const r = look(v); if (!r) return v
      const k = (key ?? '').toLowerCase()
      if (k === 'color' || k === 'stopcolor' || k === 'colors' || k === 'hex') { const c = p.colors[r.name]; if (!c) { error = `unknown color @${r.name} (known: ${Object.keys(p.colors).join(', ') || 'none'})`; return v } used.push('@' + r.name); return c.hex }
      if (k === 'region' || k === 'stopregion') { const g = p.regions[r.name]; if (!g) { error = `unknown region @${r.name} (known: ${Object.keys(p.regions).join(', ') || 'none'})`; return v } used.push('@' + r.name); return { x: g.x, y: g.y, w: g.w, h: g.h } }
      if (/^(x|x1|x2|tapx|cx|crosshairx|nearx)$/.test(k)) { const c = p.controls[r.name]; if (!c) { error = `unknown control @${r.name}`; return v } used.push('@' + r.name); return c.x + r.dx }
      if (/^(y|y1|y2|tapy|cy|crosshairy|neary)$/.test(k)) { const c = p.controls[r.name]; if (!c) { error = `unknown control @${r.name}`; return v } used.push('@' + r.name); return c.y + (r.dx || 0) } // for y fields the single offset applies to y
      // colors arrays
      const c = p.colors[r.name]; if (c) { used.push('@' + r.name); return c.hex }
      const s = p.settings[r.name]; if (s !== undefined) { used.push('@' + r.name); return s }
      error = `unknown reference @${r.name}`
      return v
    }
    return v
  }
  const resolved = walk(args) as Record<string, unknown>
  return { args: resolved, error, used }
}

/** Execute one AI tool against a device and return a normalized result. */
export async function executeTool(env: Bindings, deviceId: string, name: string, args: Record<string, unknown>, opts: ExecOptions = {}): Promise<ToolResult> {
  // v2.3: resolve @names (controls / colours / regions / settings from game_profile) anywhere in the arguments
  let usedRefs: string[] | undefined
  if (args && hasRef(args) && name !== 'game_profile' && name !== 'remember' && name !== 'record_macro' && name !== 'save_macro' && name !== 'game_bot') {
    const { app, profile } = await loadProfile(env, deviceId, typeof args.app === 'string' ? args.app : undefined)
    if (!profile) return { ok: false, error: `arguments use @names but no game_profile exists for ${app || 'the current app'} — save one with game_profile set:{...} first` }
    const r = resolveRefs(args, profile)
    if (r.error) return { ok: false, error: r.error, profile: { controls: Object.keys(profile.controls), colors: Object.keys(profile.colors), regions: Object.keys(profile.regions) } }
    args = r.args; usedRefs = r.used
  }
  const mapped = toolToAction(name, args ?? {})
  if (mapped.error) return { ok: false, error: mapped.error }
  if (opts.readOnly && !READ_ONLY_TOOLS.has(name)) return { ok: false, error: `token is read-only: tool '${name}' not allowed` }

  if (mapped.special === 'record_macro') return recordMacro(env, deviceId, args)
  // v2.0: while a recording is active, top-level input tools are appended to the draft (fire-and-forget)
  if (!(opts.depth ?? 0) && !opts.internal && !READ_ONLY_TOOLS.has(name) && !NO_RECORD.has(name) && TOOLS.some((t) => t.name === name)) {
    room(env, deviceId).fetch(`https://do/record-step?deviceId=${deviceId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args ?? {} }) }).catch(() => {})
  }
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
  if (mapped.special === 'observe') return observe(env, deviceId, args, opts)
  if (mapped.special === 'smart_tap') return smartTap(env, deviceId, args, opts)
  if (mapped.special === 'do_until') return doUntil(env, deviceId, args, opts)
  if (mapped.special === 'dismiss_popups') return dismissPopups(env, deviceId, args, opts)
  if (mapped.special === 'recent_actions') return recentActions(env, deviceId, args)
  if (mapped.special === 'session_report') return sessionReport(env, deviceId, args)
  if (mapped.special === 'game_bot') {
    const act = String(args.action ?? 'list').toLowerCase()
    if (opts.readOnly && !['list', 'get', 'status', 'templates'].includes(act)) return { ok: false, error: `token is read-only: game_bot ${act} not allowed` }
    return gameBot(env, deviceId, args)
  }
  if (mapped.special === 'game_profile') {
    if (opts.readOnly && (args.set || args.unset || args.delete || args.label || args.genre)) return { ok: false, error: 'token is read-only: game_profile can only be read' }
    return gameProfile(env, deviceId, args)
  }
  if (mapped.special === 'read_number') return readNumber(env, deviceId, args, opts)
  if (mapped.special === 'watch_value') return watchValue(env, deviceId, args, opts)
  if (mapped.special === 'calibrate') return calibrate(env, deviceId, args, opts)
  if (mapped.special === 'label_screen') return labelScreen(env, deviceId, args, opts)
  if (mapped.special === 'identify_screen') return identifyScreen(env, deviceId, args, opts)

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
  if (usedRefs?.length) out.resolved = usedRefs
  if (res.queuedMs) out.queuedMs = res.queuedMs
  if (res.data !== undefined) out.data = res.data
  if (res.ok) emitOverlay(env, deviceId, action as unknown as Record<string, unknown>, res.data)
  if (res.ok && (action.type === 'current_app' || action.type === 'ui_dump')) noteAppSeen(env, deviceId, res.data)
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

/** Derive monitor overlay events from executed actions (taps, swipes, colour/object/OCR detections). */
function emitOverlay(env: Bindings, deviceId: string, action: Record<string, unknown>, data: unknown) {
  const d = (data ?? {}) as Record<string, unknown>
  switch (action.type) {
    case 'tap': case 'double_tap': case 'long_press': return overlay(env, deviceId, { type: 'tap', points: [{ x: action.x, y: action.y }] })
    case 'swipe': case 'drag': return overlay(env, deviceId, { type: 'swipe', from: { x: action.x1, y: action.y1 }, to: { x: action.x2, y: action.y2 } })
    case 'tap_sequence': case 'multi_tap': return overlay(env, deviceId, { type: 'tap', points: (action.points as { x: number; y: number }[]).map((p) => ({ x: p.x, y: p.y })) })
    case 'repeat_tap': return overlay(env, deviceId, { type: 'tap', points: [{ x: action.x, y: action.y }], repeat: action.count })
    case 'swipe_path': { const pts = action.points as { x: number; y: number }[]; return overlay(env, deviceId, { type: 'path', points: pts }) }
    case 'find_color': if (d.found) return overlay(env, deviceId, { type: 'detect', color: action.color, boxes: [{ ...(d.bounds as object), cx: d.cx, cy: d.cy }] }); return
    case 'find_colors': { const res = (d.results as { found: boolean; color: string; bounds?: object; cx?: number; cy?: number }[] | undefined) ?? []; const boxes = res.filter((r) => r.found).map((r) => ({ ...(r.bounds ?? {}), cx: r.cx, cy: r.cy, color: r.color })); if (boxes.length) overlay(env, deviceId, { type: 'detect', boxes }); return }
    case 'find_objects': { const objs = (d.objects as { bounds: object; cx: number; cy: number; i: number }[] | undefined) ?? []; if (objs.length) overlay(env, deviceId, { type: 'detect', color: action.color, boxes: objs.map((o) => ({ ...o.bounds, cx: o.cx, cy: o.cy, label: `#${o.i}` })) }); return }
    case 'find_image': { const m = (d.matches as { x: number; y: number; w: number; h: number; cx: number; cy: number }[] | undefined) ?? []; if (m.length) overlay(env, deviceId, { type: 'detect', boxes: m }); return }
    case 'read_text': { const lines = (d.lines as { x?: number; y?: number; w?: number; h?: number; cx: number; cy: number; text: string }[] | undefined) ?? []; if (lines.length) overlay(env, deviceId, { type: 'ocr', boxes: lines.slice(0, 40).map((l) => ({ x: l.x, y: l.y, w: l.w, h: l.h, cx: l.cx, cy: l.cy, label: l.text })) }); return }
    case 'joystick': return overlay(env, deviceId, { type: 'swipe', from: { x: action.x, y: action.y }, to: { x: d.tipX ?? action.x, y: d.tipY ?? action.y } })
    case 'aim': return overlay(env, deviceId, { type: 'swipe', from: { x: action.x, y: action.y }, to: { x: Number(action.x) + Number(action.dx), y: Number(action.y) + Number(action.dy) } })
    case 'fire_burst': return overlay(env, deviceId, { type: 'tap', points: [{ x: action.x, y: action.y }], repeat: action.count })
    case 'finger_down': return overlay(env, deviceId, { type: 'tap', points: [{ x: action.x, y: action.y }] })
    case 'auto_react': { const taps = (d.taps as { x: number; y: number }[] | undefined) ?? []; if (taps.length) overlay(env, deviceId, { type: 'tap', points: taps.map((t) => ({ x: t.x, y: t.y })), reflex: true }); return }
    case 'track_object': { const pts = (d.samples as { x: number; y: number }[] | undefined) ?? []; const p = d.predicted as { x: number; y: number } | undefined; if (pts.length) overlay(env, deviceId, { type: 'path', points: pts.concat(p ? [p] : []), color: action.color }); return }
    case 'sample_colors': { const cs = (d.colors as { hex: string; cx: number; cy: number }[] | undefined) ?? []; if (cs.length) overlay(env, deviceId, { type: 'detect', boxes: cs.map((c) => ({ cx: c.cx, cy: c.cy, color: c.hex, label: c.hex })) }); return }
    case 'watch_color': case 'wait_pixel': if (d.matched && d.cx !== undefined) overlay(env, deviceId, { type: 'detect', color: action.color, boxes: [{ cx: d.cx, cy: d.cy, ...(d.bounds as object ?? {}) }] }); return
  }
}

/** record_macro: start / stop+save / status / cancel */
async function recordMacro(env: Bindings, deviceId: string, args: Record<string, unknown>): Promise<ToolResult> {
  const r = room(env, deviceId)
  const current = async () => ((await (await r.fetch(`https://do/recording?deviceId=${deviceId}`)).json()) as { recording: { name?: string; description?: string; steps: unknown[]; startedAt: number } | null }).recording
  if (args.status === true) { const rec = await current(); return { ok: true, recording: !!rec, draft: rec } }
  if (args.cancel === true) { const res = (await (await r.fetch(`https://do/recording?deviceId=${deviceId}`, { method: 'DELETE' })).json()) as { recording: unknown }; return { ok: true, cancelled: !!res.recording, discardedSteps: (res.recording as { steps?: unknown[] } | null)?.steps?.length ?? 0 } }
  if (args.start === true) {
    const res = await r.fetch(`https://do/recording?deviceId=${deviceId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: args.name, description: args.description, keepWaits: args.keepWaits !== false }) })
    const j = (await res.json()) as ToolResult
    if (!j.ok) return j
    return { ok: true, recording: true, name: args.name, hint: 'now perform the steps with normal input tools; call record_macro start=false to save (max 25 steps; observe/read-only tools are not recorded)' }
  }
  if (args.start === false) {
    const rec = await current()
    if (!rec) return { ok: false, error: 'not recording — call record_macro start=true first' }
    const name = String(args.name ?? rec.name ?? '').trim()
    if (!name) return { ok: false, error: 'name required (pass it at start or at stop)', draft: rec }
    if (!rec.steps.length) { await r.fetch(`https://do/recording?deviceId=${deviceId}`, { method: 'DELETE' }); return { ok: false, error: 'nothing was recorded — draft discarded' } }
    const saved = await saveMacro(env, deviceId, { name, steps: rec.steps, description: args.description ?? rec.description })
    if (saved.ok) await r.fetch(`https://do/recording?deviceId=${deviceId}`, { method: 'DELETE' })
    return { ...saved, steps: rec.steps.length, recordedMs: Date.now() - rec.startedAt }
  }
  return { ok: false, error: 'record_macro needs start=true|false, status=true or cancel=true' }
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
  const r = await executeTool(env, deviceId, 'screen_hash' as string, {}, { internal: true })
  const d = r.data as { hash?: string } | undefined
  return { ok: r.ok && !!d?.hash, hash: d?.hash, error: r.error }
}

/** Best-effort current foreground package (empty string when unknown). */
async function currentPackage(env: Bindings, deviceId: string): Promise<string> {
  try {
    const r = await executeTool(env, deviceId, 'get_current_app', {}, { internal: true })
    const d = r.data as { package?: string; label?: string } | undefined
    return r.ok && typeof d?.package === 'string' ? d.package : ''
  } catch { return '' }
}
/** v2.2: remember which apps/games the AI has worked in (fire-and-forget) so the owner can manage memory per game. */
function noteAppSeen(env: Bindings, deviceId: string, data: unknown) {
  const d = data as { package?: string; label?: string } | undefined
  if (!d?.package || d.package === 'com.devicerelay.client') return
  room(env, deviceId).fetch(`https://do/app-seen?deviceId=${deviceId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app: d.package, label: d.label }) }).catch(() => {})
}

/** Persistent per-device notes (memory across chats). */
async function remember(env: Bindings, deviceId: string, args: Record<string, unknown>): Promise<ToolResult> {
  const text = String(args.text ?? '').trim()
  if (!text) return { ok: false, error: 'remember requires text' }
  const app = typeof args.app === 'string' && args.app.trim() ? args.app.trim() : await currentPackage(env, deviceId)
  const r = await room(env, deviceId).fetch(`https://do/notes?deviceId=${deviceId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, app: app || undefined }) })
  const out = (await r.json()) as ToolResult
  if (app) out.app = app
  return out
}
async function recall(env: Bindings, deviceId: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (args.forget !== undefined && args.forget !== null) {
    // forget=index | -1 (all) | "app" (all notes of args.app / current app)
    if (args.forget === 'app') {
      let app = typeof args.app === 'string' ? args.app.trim() : 'current'
      if (app === 'current' || !app) app = await currentPackage(env, deviceId)
      if (!app) return { ok: false, error: 'could not determine current app; pass app=<package>' }
      const r = await room(env, deviceId).fetch(`https://do/memory?deviceId=${deviceId}&kind=notes&app=${encodeURIComponent(app)}`, { method: 'DELETE' })
      return { ...((await r.json()) as ToolResult), app }
    }
    const idx = Number(args.forget)
    const r = await room(env, deviceId).fetch(`https://do/notes?deviceId=${deviceId}${idx >= 0 ? `&index=${idx}` : ''}`, { method: 'DELETE' })
    return (await r.json()) as ToolResult
  }
  const r = await room(env, deviceId).fetch(`https://do/notes?deviceId=${deviceId}`)
  const { notes } = (await r.json()) as { notes: { text: string; ts: number; app?: string }[] }
  let filter = typeof args.app === 'string' ? args.app.trim() : ''
  if (filter === 'current') filter = await currentPackage(env, deviceId)
  const all = notes.map((n, i) => ({ index: i, text: n.text, ts: n.ts, ...(n.app ? { app: n.app } : {}) }))
  const list = filter ? all.filter((n) => n.app === filter) : all
  return { ok: true, count: list.length, total: all.length, ...(filter ? { app: filter } : {}), notes: list }
}

// ---------------------------------------------------------------- v1.8 composite intelligence

/** observe: screenshot + OCR + current app + colours + diff, all in parallel (read-only actions bypass the queue). */
async function observe(env: Bindings, deviceId: string, args: Record<string, unknown>, opts: ExecOptions): Promise<ToolResult> {
  const t0 = Date.now()
  const wantImage = args.image !== false, wantOcr = args.ocr !== false, wantDiff = args.diff !== false
  const colors = Array.isArray(args.colors) ? (args.colors as unknown[]).filter((c) => typeof c === 'string').slice(0, 8) : []
  const shotArgs: Record<string, unknown> = {}
  for (const k of ['maxWidth', 'grid', 'region']) if (args[k] !== undefined) shotArgs[k] = args[k]
  const tasks: Promise<[string, ToolResult]>[] = [
    executeTool(env, deviceId, 'get_current_app', {}, opts).then((r) => ['app', r] as [string, ToolResult]),
  ]
  if (wantImage) tasks.push(executeTool(env, deviceId, 'capture_screen', shotArgs, opts).then((r) => ['shot', r]))
  if (wantOcr) tasks.push(executeTool(env, deviceId, 'read_text', args.region ? { region: args.region } : {}, opts).then((r) => ['ocr', r]))
  if (colors.length) tasks.push(executeTool(env, deviceId, 'find_colors', { colors, tolerance: args.tolerance, region: args.region }, opts).then((r) => ['colors', r]))
  if (wantDiff) tasks.push(executeTool(env, deviceId, 'screen_diff', {}, opts).then((r) => ['diff', r]))
  if (args.identify !== false) tasks.push(identifyScreen(env, deviceId, {}, opts).then((r) => ['screen', r]))
  // v2.4 profile-aware: evaluate the game's @colors (objects) and numeric @regions in the same call
  let profileP: Promise<ProfileRec | null> | undefined
  if (args.profile !== false) profileP = loadProfile(env, deviceId).then((x) => x.profile).catch(() => null)
  const settled = await Promise.all(tasks.map((p) => p.catch((e) => ['error', { ok: false, error: String(e) }] as [string, ToolResult])))
  const parts: Record<string, ToolResult> = {}
  for (const [k, r] of settled) parts[k] = r

  const out: ToolResult = { ok: true, durationMs: Date.now() - t0 }
  const appD = parts.app?.data as { package?: string; label?: string } | undefined
  out.app = parts.app?.ok ? { package: appD?.package, label: appD?.label } : { ok: false, error: parts.app?.error }
  if (parts.shot) {
    if (parts.shot.ok) { out.image = parts.shot.image; out.screen = parts.shot.screen } else out.imageError = parts.shot.error
  }
  if (parts.ocr) {
    const d = parts.ocr.data as { lines?: unknown[]; text?: string } | undefined
    out.text = parts.ocr.ok ? { count: d?.lines?.length ?? 0, lines: d?.lines ?? [] } : { ok: false, error: parts.ocr.error }
  }
  if (parts.colors) {
    const d = parts.colors.data as { results?: unknown[] } | undefined
    out.colors = parts.colors.ok ? d?.results ?? [] : { ok: false, error: parts.colors.error }
  }
  if (parts.diff) {
    const d = parts.diff.data as { changedPct?: number; regions?: unknown[]; baseline?: boolean } | undefined
    out.changed = parts.diff.ok ? { pct: d?.changedPct ?? 0, regions: (d?.regions ?? []).slice(0, 6), baseline: d?.baseline === true } : { ok: false, error: parts.diff.error }
  }
  if (parts.screen) {
    out.screenName = parts.screen.ok ? (parts.screen.screenName as string | null) : null
    if (parts.screen.ok && parts.screen.confidence !== undefined && Number(parts.screen.count) > 0) out.screenConfidence = parts.screen.confidence
  }
  if (profileP) {
    const prof = await profileP
    if (prof && (Object.keys(prof.colors).length || Object.keys(prof.regions).length)) {
      const game: Record<string, unknown> = { app: prof.app, label: prof.label }
      const colorNames = Object.keys(prof.colors).slice(0, 6)
      const objs: Record<string, unknown> = {}
      await Promise.all(colorNames.map(async (nm) => {
        const c = prof.colors[nm]
        const r = await executeTool(env, deviceId, 'find_objects', { color: c.hex, tolerance: c.tolerance ?? 24, maxResults: 5, ...(args.region ? { region: args.region } : {}) }, { ...opts, internal: true })
        const d = r.data as { count?: number; objects?: { cx: number; cy: number; area: number }[] } | undefined
        objs['@' + nm] = r.ok ? { count: d?.count ?? 0, objects: (d?.objects ?? []).slice(0, 5).map((o) => ({ cx: o.cx, cy: o.cy, area: o.area })) } : { error: r.error }
      }))
      if (colorNames.length) game.objects = objs
      // numeric regions: names that hint at numbers, or any region when OCR lines exist
      const numRegions = Object.entries(prof.regions).filter(([nm]) => /score|coin|gem|gold|hp|health|time|timer|level|lvl|distance|point|kill|money|cash|star|ammo|energy|combo|wave|round/i.test(nm)).slice(0, 4)
      if (numRegions.length) {
        const values: Record<string, unknown> = {}
        await Promise.all(numRegions.map(async ([nm, g]) => {
          const r = await readNumber(env, deviceId, { region: { x: g.x, y: g.y, w: g.w, h: g.h } }, { ...opts, internal: true })
          values['@' + nm] = r.ok ? r.value : null
        }))
        game.values = values
      }
      if (prof.bestScore !== undefined) game.bestScore = prof.bestScore
      out.game = game
    }
  }
  // the call is ok if at least the screenshot (or, image=false, the OCR/app) worked
  out.ok = wantImage ? !!parts.shot?.ok : (parts.ocr?.ok ?? parts.app?.ok ?? false)
  if (!out.ok) out.error = parts.shot?.error ?? parts.ocr?.error ?? parts.app?.error ?? 'observe failed'
  return out
}

/** smart_tap: ui element → OCR text → fallback point, then optional change verification. */
async function smartTap(env: Bindings, deviceId: string, args: Record<string, unknown>, opts: ExecOptions): Promise<ToolResult> {
  const q = String(args.text ?? '').trim()
  const id = typeof args.elementId === 'string' ? args.elementId.trim() : ''
  if (!q && !id) return { ok: false, error: 'smart_tap requires text (or elementId)' }
  const index = Math.max(0, Number(args.index) || 0)
  const t0 = Date.now()
  const tried: string[] = []
  let target: { x: number; y: number } | undefined, via: 'ui' | 'ocr' | 'fallback' | undefined, match: unknown

  const ui = await uiElements(env, deviceId)
  tried.push(`ui:${ui.ok ? ui.elements.length : 'err'}`)
  if (ui.ok && ui.elements.length) {
    const hits = ui.elements.filter((e) => {
      const idOk = !id || e.id?.toLowerCase() === id.toLowerCase()
      const textOk = !q || [e.text, e.desc, e.hint].some((t) => typeof t === 'string' && t.toLowerCase().includes(q.toLowerCase()))
      return idOk && textOk
    })
    const exact = q ? hits.filter((e) => [e.text, e.desc].some((t) => typeof t === 'string' && t.trim().toLowerCase() === q.toLowerCase())) : []
    const pool = exact.length ? exact : hits
    const h = pool[Math.min(index, pool.length - 1)]
    if (h) { target = { x: h.cx, y: h.cy }; via = 'ui'; match = { i: h.i, text: h.text, id: h.id } }
  }
  if (!target && q) {
    const o = await ocrLines(env, deviceId, args.region, opts)
    tried.push(`ocr:${o.ok ? o.lines.length : 'err'}`)
    if (o.ok) {
      const hits = matchLines(o.lines, q)
      const h = hits[Math.min(index, hits.length - 1)]
      if (h) { target = { x: h.cx, y: h.cy }; via = 'ocr'; match = { text: h.text, confidence: (h as { confidence?: number }).confidence } }
    }
  }
  const fb = args.fallback as { x?: unknown; y?: unknown } | undefined
  if (!target && fb && Number.isFinite(Number(fb.x)) && Number.isFinite(Number(fb.y))) { target = { x: Number(fb.x), y: Number(fb.y) }; via = 'fallback' }
  if (!target) return { ok: false, found: false, error: `"${q || id}" not found via ui or ocr (no fallback given)`, tried, durationMs: Date.now() - t0 }

  const verify = args.verify !== false
  const before = verify ? await hashOf(env, deviceId) : { ok: false }
  const t = await executeTool(env, deviceId, 'tap', target, { ...opts, internal: true })
  const out: ToolResult = { ...t, found: true, via, match, tapped: target, tried }
  if (t.ok && verify && before.ok) {
    const waitMs = Math.min(Math.max(Number(args.waitMs ?? 500) || 0, 0), 5000)
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs))
    const after = await hashOf(env, deviceId)
    out.changed = after.ok ? after.hash !== before.hash : undefined
    if (out.changed === false) out.hint = 'screen did not change after the tap — target may be disabled, or needs a longer waitMs'
  }
  out.durationMs = Date.now() - t0
  return out
}

/** do_until: repeat action until an observation matches (checked before every try). */
async function doUntil(env: Bindings, deviceId: string, args: Record<string, unknown>, opts: ExecOptions): Promise<ToolResult> {
  type Call = { name?: string; arguments?: Record<string, unknown> }
  const action = args.action as Call | undefined, until = args.until as Call | undefined
  if (!action?.name || !TOOLS.some((t) => t.name === action.name)) return { ok: false, error: 'action must be a valid tool {name, arguments}' }
  if (['do_until', 'game_loop', 'batch', 'run_macro', 'act_and_see'].includes(action.name)) return { ok: false, error: `action cannot be ${action.name}` }
  if (!until?.name || !OBSERVATION_TOOLS.has(until.name)) return { ok: false, error: `until must be an observation tool: ${[...OBSERVATION_TOOLS].join('|')}` }
  const maxTries = Math.min(Math.max(Number(args.maxTries) || 8, 1), 30)
  const interval = Math.min(Math.max(Number(args.intervalMs ?? 600) || 0, 0), 5000)
  const minChange = Number(args.minChange ?? 2) || 2
  const t0 = Date.now()
  const sub = { ...opts, depth: (opts.depth ?? 0) + 1 }
  const trace: unknown[] = []
  let tries = 0
  for (let i = 0; i <= maxTries; i++) {
    if (Date.now() - t0 > 55_000) return { ok: false, error: 'do_until exceeded 55s', tries, matched: false, trace, durationMs: Date.now() - t0 }
    const o = await executeTool(env, deviceId, until.name, until.arguments ?? {}, sub)
    const [hit, cx, cy] = observationMatched(until.name, o, minChange)
    if (hit) return { ok: true, matched: true, tries, ...(cx !== undefined ? { cx, cy } : {}), observation: o.data ?? { ok: o.ok }, trace, durationMs: Date.now() - t0 }
    if (i === maxTries) break
    const r = await executeTool(env, deviceId, action.name, action.arguments ?? {}, sub)
    tries++
    trace.push({ i, ok: r.ok, ...(r.error ? { error: r.error } : {}), ...(r.via ? { via: r.via } : {}) })
    if (!r.ok && !['smart_tap', 'tap_text', 'tap_color', 'find_and_tap'].includes(action.name)) return { ok: false, error: `action failed at try ${tries}: ${r.error}`, tries, matched: false, trace, durationMs: Date.now() - t0 }
    if (interval) await new Promise((r) => setTimeout(r, interval))
  }
  return { ok: false, matched: false, error: `condition not met after ${tries} tries`, tries, trace, durationMs: Date.now() - t0 }
}

const DISMISS_LABELS = ['skip ad', 'skip', 'close', 'not now', 'no thanks', 'no, thanks', 'maybe later', 'later', 'dismiss', 'got it', 'cancel', 'deny', "don't allow", 'continue', 'ok', 'okay', 'allow', 'accept', 'agree', 'i agree', 'x', '×', 'reject all', 'accept all', 'while using the app', 'only this time', 'تخطي', 'إغلاق', 'لاحقا', 'ليس الآن', 'موافق', 'متابعة', 'إلغاء', 'فهمت']
const DISMISS_IDS = ['close', 'btn_close', 'dismiss', 'skip', 'cancel', 'negative', 'button2', 'permission_deny_button', 'permission_allow_foreground_only_button']

/** dismiss_popups: find & tap common dismiss labels via ui + OCR, repeat while something is found. */
async function dismissPopups(env: Bindings, deviceId: string, args: Record<string, unknown>, opts: ExecOptions): Promise<ToolResult> {
  const extra = Array.isArray(args.extra) ? (args.extra as unknown[]).filter((s) => typeof s === 'string').map((s) => (s as string).toLowerCase().trim()) : []
  const labels = [...extra, ...DISMISS_LABELS]
  const rounds = Math.min(Math.max(Number(args.rounds) || 2, 1), 5)
  const useOcr = args.ocr !== false
  const t0 = Date.now()
  const dismissed: unknown[] = []
  const norm = (s: unknown) => (typeof s === 'string' ? s.toLowerCase().replace(/\s+/g, ' ').trim() : '')
  for (let r = 0; r < rounds; r++) {
    let target: { x: number; y: number; label: string; via: string } | undefined
    const ui = await uiElements(env, deviceId)
    if (ui.ok) {
      // rank: exact label match on clickable elements first, then id match, then substring
      let best: { score: number; e: UiElement; label: string } | undefined
      for (const e of ui.elements) {
        const texts = [e.text, e.desc, e.hint].map(norm).filter(Boolean)
        const idn = norm(e.id).split('/').pop() ?? ''
        let score = 0, label = ''
        for (let li = 0; li < labels.length; li++) {
          const l = labels[li]
          if (texts.some((t) => t === l)) { score = Math.max(score, 100 - li); label = l }
          else if (l.length >= 4 && texts.some((t) => t.includes(l))) { score = Math.max(score, 40 - li * 0.5); label = label || l }
        }
        if (!score && idn && DISMISS_IDS.some((d) => idn === d || idn.endsWith(d))) { score = 60; label = `id:${idn}` }
        if (score && e.clickable === false) score -= 30
        if (score > 0 && (!best || score > best.score)) best = { score, e, label }
      }
      if (best) target = { x: best.e.cx, y: best.e.cy, label: best.label, via: 'ui' }
    }
    if (!target && useOcr) {
      const o = await ocrLines(env, deviceId, undefined, opts)
      if (o.ok) {
        for (const l of labels) {
          const hit = o.lines.find((ln) => norm(ln.text) === l) ?? (l.length >= 4 ? o.lines.find((ln) => norm(ln.text).includes(l)) : undefined)
          if (hit) { target = { x: hit.cx, y: hit.cy, label: hit.text, via: 'ocr' }; break }
        }
      }
    }
    if (!target) break
    const t = await executeTool(env, deviceId, 'tap', { x: target.x, y: target.y }, { ...opts, internal: true })
    dismissed.push({ ...target, ok: t.ok })
    if (!t.ok) break
    await new Promise((res) => setTimeout(res, 600))
  }
  return { ok: true, dismissed: dismissed.length, actions: dismissed, durationMs: Date.now() - t0 }
}

// ---------------------------------------------------------------- v2.6 game bots
const BOT_CONDITIONS = new Set(['color_present', 'color_absent', 'object_present', 'object_absent', 'pixel_is', 'pixel_not', 'text_present', 'text_absent', 'number_below', 'number_above', 'screen_changed', 'every_ms', 'always'])
const BOT_ACTIONS = new Set(['tap', 'tap_found', 'tap_all_found', 'aim_to_found', 'swipe', 'long_press', 'tap_sequence', 'repeat_tap', 'joystick', 'aim', 'fire_burst', 'combo', 'finger_up', 'back', 'home', 'wait', 'stop_bot'])
const FOUND_CONDS = new Set(['color_present', 'object_present', 'pixel_is', 'text_present'])
const HEX_RE = /^#[0-9a-f]{6}$/
const isFin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
function normColor(v: unknown): string | null { if (typeof v !== 'string') return null; const s = v.trim().toLowerCase(); const h = s.startsWith('#') ? s : '#' + s; return HEX_RE.test(h) ? h : null }
function validRegion(v: unknown): v is { x: number; y: number; w: number; h: number } { const r = v as Record<string, unknown> | null; return !!r && typeof r === 'object' && isFin(r.x) && isFin(r.y) && isFin(r.w) && isFin(r.h) && r.w > 0 && r.h > 0 }
/** Validate + normalise bot rules (after @name resolution). Returns error string or null. */
function validateRules(rules: unknown): { rules?: import('./types').BotRule[]; error?: string } {
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > 25) return { error: 'rules must be an array of 1..25' }
  const out: import('./types').BotRule[] = []
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i] as Record<string, unknown>
    if (!r || typeof r !== 'object') return { error: `rules[${i}] must be an object` }
    const name = String(r.name ?? `rule-${i + 1}`).slice(0, 40)
    if (!Array.isArray(r.when) || r.when.length === 0 || r.when.length > 6) return { error: `rules[${i}] (${name}).when must have 1..6 conditions` }
    if (!Array.isArray(r.then) || r.then.length === 0 || r.then.length > 10) return { error: `rules[${i}] (${name}).then must have 1..10 actions` }
    let hasColorCond = false, hasFoundCond = false, hasObjectCond = false
    for (let c = 0; c < r.when.length; c++) {
      const w = r.when[c] as Record<string, unknown>
      if (!w || typeof w.type !== 'string' || !BOT_CONDITIONS.has(w.type)) return { error: `rules[${i}].when[${c}].type must be one of ${[...BOT_CONDITIONS].join('|')}` }
      if (['color_present', 'color_absent', 'object_present', 'object_absent'].includes(w.type)) {
        // v2.7: `colors: [...]` (any of) or single `color`
        const list = Array.isArray(w.colors) ? w.colors : (w.color !== undefined ? [w.color] : [])
        const norm = list.map(normColor)
        if (!norm.length || norm.some((x) => !x)) return { error: `rules[${i}].when[${c}] needs color "#rrggbb" or colors ["#..",..] (or @color)` }
        if (norm.length > 8) return { error: `rules[${i}].when[${c}] max 8 colors` }
        w.color = norm[0]; if (norm.length > 1) w.colors = norm; else delete w.colors
        if (w.type.endsWith('_present')) { hasColorCond = true; hasFoundCond = true }
        if (w.type.startsWith('object')) { hasObjectCond = w.type === 'object_present'; w.minSize ??= 12; w.maxSize ??= 0; if (w.pick !== undefined && !['largest', 'nearest', 'topmost', 'lowest'].includes(String(w.pick))) return { error: `rules[${i}].when[${c}].pick must be largest|nearest|topmost|lowest` } }
      }
      if (['pixel_is', 'pixel_not'].includes(w.type)) { const col = normColor(w.color); if (!col) return { error: `rules[${i}].when[${c}] needs color "#rrggbb" (or @color)` }; w.color = col; if (w.type === 'pixel_is') hasFoundCond = true }
      if (w.type === 'text_present') hasFoundCond = true
      if (w.forMs !== undefined && (!isFin(w.forMs) || w.forMs < 0 || w.forMs > 60_000)) return { error: `rules[${i}].when[${c}].forMs must be 0..60000` }
      if (['pixel_is', 'pixel_not'].includes(w.type) && (!isFin(w.x) || !isFin(w.y))) return { error: `rules[${i}].when[${c}] (${w.type}) needs x,y` }
      if (['text_present', 'text_absent'].includes(w.type) && (typeof w.text !== 'string' || !w.text.trim())) return { error: `rules[${i}].when[${c}] needs text` }
      if (['number_below', 'number_above'].includes(w.type) && (!validRegion(w.region) || !isFin(w.value))) return { error: `rules[${i}].when[${c}] (${w.type}) needs region {x,y,w,h} and value` }
      if (w.type === 'every_ms' && (!isFin(w.ms) || w.ms < 50)) return { error: `rules[${i}].when[${c}] every_ms needs ms >= 50` }
      if (w.region !== undefined && !validRegion(w.region)) return { error: `rules[${i}].when[${c}].region must be {x,y,w,h}` }
    }
    for (let t = 0; t < r.then.length; t++) {
      const a = r.then[t] as Record<string, unknown>
      if (!a || typeof a.type !== 'string' || !BOT_ACTIONS.has(a.type)) return { error: `rules[${i}].then[${t}].type must be one of ${[...BOT_ACTIONS].join('|')}` }
      if (a.type === 'tap_found' && !hasFoundCond) return { error: `rules[${i}] (${name}) uses tap_found but has no color_present/object_present/pixel_is/text_present condition` }
      if (a.type === 'tap_all_found' && !hasObjectCond) return { error: `rules[${i}] (${name}) uses tap_all_found but has no object_present condition` }
      if (a.type === 'aim_to_found' && !hasFoundCond) return { error: `rules[${i}] (${name}) uses aim_to_found but has no *_present condition` }
      if (a.type === 'aim_to_found') { if (!isFin(a.x) || !isFin(a.y)) return { error: `rules[${i}].then[${t}] aim_to_found needs x,y (start point on the look area, or at:"@look")` }; a.sensitivity ??= 1; a.maxStep ??= 300; a.deadzone ??= 12; a.duration ??= 60; a.finger ??= 1; if (a.autoTune !== false) delete a.autoTune; if (!isFin(a.predictMs) || a.predictMs <= 0) delete a.predictMs; else a.predictMs = Math.min(a.predictMs, 600); if (!isFin(a.maxRange) || a.maxRange <= 0) delete a.maxRange }
      if (a.type === 'tap_all_found') { a.max ??= 5; a.intervalMs ??= 40 }
      if (['tap', 'long_press', 'repeat_tap', 'joystick', 'aim', 'fire_burst'].includes(a.type) && (!isFin(a.x) || !isFin(a.y))) return { error: `rules[${i}].then[${t}] (${a.type}) needs x,y (or at:"@control")` }
      if (a.type === 'swipe' && ![a.x1, a.y1, a.x2, a.y2].every(isFin)) return { error: `rules[${i}].then[${t}] swipe needs x1,y1,x2,y2` }
      if (a.type === 'tap_sequence' && !Array.isArray(a.points)) return { error: `rules[${i}].then[${t}] tap_sequence needs points` }
      if (a.type === 'combo' && !Array.isArray(a.combo ?? a.steps)) return { error: `rules[${i}].then[${t}] combo needs steps` }
      if (a.type === 'combo' && a.steps && !a.combo) { a.combo = a.steps; delete a.steps }
      if (a.type === 'wait' && !isFin(a.ms)) return { error: `rules[${i}].then[${t}] wait needs ms` }
      // defaults matching the phone's expectations
      if (a.type === 'joystick') { if (!isFin(a.angle)) { const m: Record<string, number> = { right: 0, 'down-right': 45, down: 90, 'down-left': 135, left: 180, 'up-left': 225, up: 270, 'up-right': 315 }; a.angle = m[String(a.direction ?? 'up').toLowerCase()] ?? 270; delete a.direction } a.distance ??= 150; a.duration ??= 500; a.finger ??= 0; a.release ??= true }
      if (a.type === 'aim') { a.dx ??= 0; a.dy ??= 0; a.duration ??= 120; a.finger ??= 1; a.steps ??= 4; a.release ??= true; if (a.alternate !== true) delete a.alternate }
      if (a.type === 'fire_burst') { a.count ??= 5; a.intervalMs ??= 90; a.holdMs ??= 0; if (!isFin(a.maxRange) || a.maxRange <= 0) delete a.maxRange; else if (!hasFoundCond) return { error: `rules[${i}].then[${t}] fire_burst.maxRange needs a *_present condition` } }
      if (a.type === 'repeat_tap') { a.count ??= 5; a.intervalMs ??= 100 }
      if (a.type === 'finger_up') a.finger ??= -1
    }
    out.push({ name, when: r.when as import('./types').BotCondition[], then: r.then as import('./types').BotAction[], cooldownMs: isFin(r.cooldownMs) ? Math.min(Math.max(r.cooldownMs, 0), 60_000) : 300, priority: isFin(r.priority) ? r.priority : 0, exclusive: r.exclusive !== false, enabled: r.enabled !== false, ...(isFin(r.maxFires) && r.maxFires > 0 ? { maxFires: Math.floor(r.maxFires) } : {}) })
  }
  return { rules: out }
}
async function gameBot(env: Bindings, deviceId: string, args: Record<string, unknown>): Promise<ToolResult> {
  const act = String(args.action ?? 'list').toLowerCase()
  const r = room(env, deviceId)
  const { app, profile } = await loadProfile(env, deviceId, typeof args.app === 'string' ? args.app : undefined)
  const list = async () => ((await (await r.fetch(`https://do/bots?deviceId=${deviceId}`)).json()) as { bots: import('./types').Bot[]; status: unknown })
  const findBot = (bots: import('./types').Bot[]) => bots.find((b) => (args.id && b.id === args.id) || (args.name && b.app === app && b.name === String(args.name).toLowerCase().replace(/[^a-z0-9_-]/g, '-')))
  if (act === 'list') { const { bots, status } = await list(); const mine = app ? bots.filter((b) => b.app === app) : bots; return { ok: true, app, count: mine.length, bots: mine.map((b) => ({ id: b.id, name: b.name, app: b.app, description: b.description, rules: b.rules.length, runs: b.runs ?? 0, lastRun: b.lastRun })), others: bots.length - mine.length, botStatus: status } }
  if (act === 'status') { const s = (await (await r.fetch(`https://do/bot-status?deviceId=${deviceId}`)).json()) as { status: unknown; online: boolean }; const live = await executeTool(env, deviceId, 'bot_status' as string, {}, { internal: true }).catch(() => null); return { ok: true, botStatus: live?.ok ? live.data : s.status, online: s.online, hint: live?.ok ? undefined : 'phone did not answer bot_status (needs app v2.6+); showing last known' } }
  if (act === 'get') { const { bots } = await list(); const b = findBot(bots); return b ? { ok: true, bot: b } : { ok: false, error: 'bot not found', available: bots.map((x) => ({ id: x.id, name: x.name, app: x.app })) } }
  if (act === 'delete') { const { bots } = await list(); const b = findBot(bots); if (!b) return { ok: false, error: 'bot not found' }; const res = (await (await r.fetch(`https://do/bots?deviceId=${deviceId}&id=${encodeURIComponent(b.id)}`, { method: 'DELETE' })).json()) as ToolResult; return { ...res, deleted: b.name } }
  if (act === 'stop') { const res = await executeTool(env, deviceId, 'bot_stop' as string, {}, { internal: true }); return { ...res, hint: res.ok ? 'bot stopped' : 'phone did not accept bot_stop (needs app v2.6+)' } }
  if (act === 'run') {
    const { bots } = await list(); const b = findBot(bots); if (!b) return { ok: false, error: 'bot not found', available: bots.map((x) => ({ id: x.id, name: x.name })) }
    const res = await executeTool(env, deviceId, 'bot_start' as string, { botId: b.id }, { internal: true })
    return { ...res, bot: { id: b.id, name: b.name }, hint: res.ok ? `bot '${b.name}' is running on the phone; the user can stop it from the notification. Observe for ~20s and fix rules if needed.` : 'phone refused bot_start — is the Android app v2.6+ and the game in the foreground?' }
  }
  if (act === 'templates') return { ok: true, templates: templateSummary(), hint: 'game_bot action=template template=<id> params={...@names...}. Set the @names with game_profile first (sample_colors/find_objects to pick a UNIQUE stable colour).' }
  let template: string | undefined
  if (act === 'template') {
    const t = BOT_TEMPLATES.find((x) => x.id === String(args.template ?? '').toLowerCase())
    if (!t) return { ok: false, error: `unknown template ${args.template}`, available: BOT_TEMPLATES.map((x) => x.id) }
    const params = (args.params && typeof args.params === 'object' ? args.params : {}) as Record<string, unknown>
    for (const pd of t.params) if (pd.default !== undefined && params[pd.key] === undefined) params[pd.key] = pd.default
    const missing = t.params.filter((pd) => pd.required && params[pd.key] === undefined).map((pd) => `${pd.key} (${pd.kind}: ${pd.doc})`)
    if (missing.length) return { ok: false, error: `template ${t.id} needs params: ${missing.join('; ')}`, params: t.params }
    args.rules = t.build(params)
    if (params.mode === 'assist' || params.mode === 'trigger') args.assist = true
    args.tickMs ??= t.tickMs
    args.name ??= `${t.id}-bot`
    args.description ??= t.title
    template = t.id
  }
  if (act === 'create' || act === 'update' || act === 'template') {
    if (!app) return { ok: false, error: 'could not determine the current app; pass app=<package>' }
    let existing: import('./types').Bot | undefined
    if (act === 'template') { const { bots } = await list(); existing = findBot(bots) } // template re-run with the same name = overwrite
    if (act === 'update') { const { bots } = await list(); existing = findBot(bots); if (!existing) return { ok: false, error: 'bot not found for update' } }
    const nameRaw = String(args.name ?? existing?.name ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40)
    if (!nameRaw) return { ok: false, error: 'name required' }
    let rulesIn: unknown = args.rules ?? existing?.rules
    if (!rulesIn) return { ok: false, error: 'rules required' }
    // resolve @names inside rules against the profile
    if (hasRef(rulesIn)) {
      if (!profile) return { ok: false, error: `rules use @names but no game_profile exists for ${app}` }
      const rr = resolveRefs({ rules: rulesIn } as Record<string, unknown>, profile)
      if (rr.error) return { ok: false, error: rr.error, profile: { controls: Object.keys(profile.controls), colors: Object.keys(profile.colors), regions: Object.keys(profile.regions) } }
      rulesIn = (rr.args as { rules: unknown }).rules
    }
    const v = validateRules(rulesIn)
    if (v.error) return { ok: false, error: v.error }
    const hasStop = v.rules!.some((x) => x.then.some((a) => a.type === 'stop_bot'))
    const bot: import('./types').Bot = {
      id: existing?.id ?? `bot_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, app, label: profile?.label, name: nameRaw,
      description: typeof args.description === 'string' ? args.description.slice(0, 200) : existing?.description,
      rules: v.rules!, tickMs: isFin(args.tickMs) ? Math.min(Math.max(args.tickMs, 50), 2000) : existing?.tickMs ?? 120,
      maxRunMs: isFin(args.maxRunMs) ? Math.min(Math.max(args.maxRunMs, 10_000), 21_600_000) : existing?.maxRunMs ?? 1_800_000,
      stopOnAppChange: typeof args.stopOnAppChange === 'boolean' ? args.stopOnAppChange : existing?.stopOnAppChange ?? true,
      ...((typeof args.autoStart === 'boolean' ? args.autoStart : existing?.autoStart) ? { autoStart: true } : {}),
      ...((typeof args.assist === 'boolean' ? args.assist : existing?.assist) ? { assist: true } : {}),
      ...(existing?.learned ? { learned: existing.learned } : {}),
      createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(), ...(template ? { template } : existing?.template ? { template: existing.template } : {}),
    }
    const res = (await (await r.fetch(`https://do/bots?deviceId=${deviceId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bot) })).json()) as ToolResult
    if (!res.ok) return res
    const ruleNames = bot.rules.map((x) => x.name)
    return { ok: true, action: act, bot: { id: bot.id, name: bot.name, app, rules: bot.rules.length, ruleNames, tickMs: bot.tickMs, maxRunMs: bot.maxRunMs, ...(template ? { template } : {}) }, warnings: hasStop ? [] : ['no stop_bot rule — add a GAME OVER / popup safety rule'], hint: `saved and pushed to the phone. Start: game_bot action=run name="${bot.name}" — or the user taps ▶ in the Device Relay notification. Tell the user the bot name.` }
  }
  return { ok: false, error: 'action must be create|update|list|get|delete|run|stop|status|template|templates' }
}

// ---------------------------------------------------------------- v2.3 game profile
async function gameProfile(env: Bindings, deviceId: string, args: Record<string, unknown>): Promise<ToolResult> {
  const { app, profile } = await loadProfile(env, deviceId, typeof args.app === 'string' ? args.app : undefined)
  if (!app) return { ok: false, error: 'could not determine the current app; pass app=<package>' }
  const r = room(env, deviceId)
  const q = `https://do/profile?deviceId=${deviceId}&app=${encodeURIComponent(app)}`
  if (args.delete === true) { const res = (await (await r.fetch(q, { method: 'DELETE' })).json()) as ToolResult; return { ...res, app } }
  const hasSet = args.set && typeof args.set === 'object', hasUnset = args.unset && typeof args.unset === 'object'
  let prof = profile
  if (hasSet || hasUnset || typeof args.label === 'string' || typeof args.genre === 'string') {
    // validate shapes
    const set = (args.set ?? {}) as Record<string, Record<string, unknown>>
    for (const [name, c] of Object.entries(set.controls ?? {})) { const o = c as { x?: unknown; y?: unknown }; if (!Number.isFinite(Number(o?.x)) || !Number.isFinite(Number(o?.y))) return { ok: false, error: `controls.${name} needs numeric x,y` } }
    for (const [name, c] of Object.entries(set.colors ?? {})) { const o = c as { hex?: unknown }; if (typeof o?.hex !== 'string' || !/^#?[0-9a-f]{6}$/i.test(o.hex)) return { ok: false, error: `colors.${name} needs hex "#rrggbb"` }; (o as { hex: string }).hex = '#' + o.hex.replace('#', '').toLowerCase() }
    for (const [name, g] of Object.entries(set.regions ?? {})) { const o = g as { x?: unknown; y?: unknown; w?: unknown; h?: unknown }; if (![o?.x, o?.y, o?.w, o?.h].every((n) => Number.isFinite(Number(n)))) return { ok: false, error: `regions.${name} needs numeric x,y,w,h` } }
    const res = (await (await r.fetch(q, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: args.label, genre: args.genre, set: args.set, unset: args.unset }) })).json()) as { ok: boolean; error?: string; profile?: ProfileRec }
    if (!res.ok) return { ok: false, error: res.error }
    prof = res.profile ?? null
  }
  const out: ToolResult = { ok: true, app, exists: !!prof, profile: prof ?? { app, controls: {}, colors: {}, regions: {}, settings: {} } }
  if (!prof) out.hint = 'no profile yet — after sample_colors/calibrate save with game_profile set:{controls:{jump:{x,y}}, colors:{enemy:{hex}}, regions:{score:{x,y,w,h}}}'
  if (args.history === true) {
    const s = (await (await r.fetch(`https://do/sessions?deviceId=${deviceId}&app=${encodeURIComponent(app)}&limit=10`)).json()) as { sessions: { start: number; end: number; commands: number; failed: number; report?: { outcome?: string; score?: number; summary: string } }[] }
    out.history = s.sessions.map((x) => ({ when: new Date(x.start).toISOString(), minutes: Math.round((x.end - x.start) / 60000), commands: x.commands, failed: x.failed, ...(x.report ? { outcome: x.report.outcome, score: x.report.score, summary: x.report.summary } : {}) }))
  }
  if (args.verify === true && prof) out.verify = await verifyProfile(env, deviceId, prof)
  return out
}

/** v2.4: check every profile colour/region against the live screen; report what looks stale. */
async function verifyProfile(env: Bindings, deviceId: string, p: ProfileRec): Promise<Record<string, unknown>> {
  const colors = Object.entries(p.colors)
  const regions = Object.entries(p.regions)
  const stale: string[] = []
  const colorResults: Record<string, unknown> = {}
  if (colors.length) {
    const r = await executeTool(env, deviceId, 'find_colors', { colors: colors.slice(0, 8).map(([, c]) => c.hex), tolerance: 30 }, { internal: true })
    const res = (r.data as { results?: { color: string; found: boolean; count: number }[] } | undefined)?.results ?? []
    colors.slice(0, 8).forEach(([name, c], i) => { const x = res[i]; colorResults['@' + name] = x ? { present: x.found, count: x.count } : { error: r.error }; if (x && !x.found) stale.push(`@${name} (${c.hex}) not on screen right now`) })
  }
  const regionResults: Record<string, unknown> = {}
  for (const [name, g] of regions.slice(0, 6)) {
    const r = await executeTool(env, deviceId, 'read_text', { region: { x: g.x, y: g.y, w: g.w, h: g.h } }, { internal: true })
    const lines = (r.data as { lines?: { text: string }[] } | undefined)?.lines ?? []
    regionResults['@' + name] = { ok: r.ok, lines: lines.length, text: lines.slice(0, 3).map((l) => l.text) }
  }
  const controlsOff: string[] = []
  const info = await deviceInfo(env, deviceId)
  for (const [name, c] of Object.entries(p.controls)) if (info.screen && (c.x < 0 || c.y < 0 || c.x > info.screen.w || c.y > info.screen.h)) { controlsOff.push('@' + name); stale.push(`@${name} is outside the ${info.screen.w}x${info.screen.h} screen`) }
  return { colors: colorResults, regions: regionResults, controlsOffScreen: controlsOff, stale, verdict: stale.length ? 'some entries look stale — re-check them with observe before trusting; delete with game_profile unset' : 'profile consistent with the current screen' }
}

/** v2.4 end-of-session handover */
async function sessionReport(env: Bindings, deviceId: string, args: Record<string, unknown>): Promise<ToolResult> {
  const summary = String(args.summary ?? '').trim()
  if (!summary) return { ok: false, error: 'session_report requires summary' }
  let app = typeof args.app === 'string' && args.app.trim() ? args.app.trim() : ''
  let label: string | undefined
  if (!app) {
    const r = await executeTool(env, deviceId, 'get_current_app', {}, { internal: true })
    const d = r.data as { package?: string; label?: string } | undefined
    app = d?.package ?? ''; label = d?.label
  }
  const res = await room(env, deviceId).fetch(`https://do/session-report?deviceId=${deviceId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app: app || undefined, label, summary, outcome: args.outcome, score: args.score, level: args.level, learned: args.learned, nextTime: args.nextTime, blockers: args.blockers }) })
  const out = (await res.json()) as ToolResult
  if (out.ok) out.hint = out.newBest ? 'NEW BEST SCORE saved to the profile' : 'saved; the next session will see this in QUICK START'
  return out
}

// ---------------------------------------------------------------- v2.1 numbers + calibration

/** Parse the first number-like token of a string: "1,250" "12.5K" "03:45" "87%" -> number */
export function parseNumberToken(text: string): number | null {
  const t = text.replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660)) // Arabic-Indic digits
  const timer = t.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/)
  if (timer) { const a = Number(timer[1]), b = Number(timer[2]), c = timer[3] !== undefined ? Number(timer[3]) : null; return c === null ? a * 60 + b : a * 3600 + b * 60 + c }
  const m = t.match(/-?(?:\d[\d,.\s]*\d|\d)/)
  if (!m) return null
  let raw = m[0].replace(/\s+/g, '')
  const rest = t.slice((m.index ?? 0) + m[0].length).trim().toLowerCase()
  // decide separators: if both , and . appear, the last one is decimal; a lone separator followed by exactly 3 digits is thousands
  const lastSep = Math.max(raw.lastIndexOf(','), raw.lastIndexOf('.'))
  if (lastSep >= 0) {
    const dec = raw.slice(lastSep + 1)
    const isThousands = dec.length === 3 && (raw.match(/[,.]/g) ?? []).length >= 1 && !/^[km]/.test(rest)
    raw = isThousands || dec.length === 3 ? raw.replace(/[,.]/g, '') : raw.slice(0, lastSep).replace(/[,.]/g, '') + '.' + dec
  }
  let v = Number(raw)
  if (!Number.isFinite(v)) return null
  if (/^k\b/.test(rest) || rest.startsWith('k ') || rest === 'k') v *= 1000
  else if (rest.startsWith('m') && !rest.startsWith('min') && !rest.startsWith('ms')) v *= 1_000_000
  return v
}
async function readNumber(env: Bindings, deviceId: string, args: Record<string, unknown>, opts: ExecOptions): Promise<ToolResult> {
  const o = await ocrLines(env, deviceId, args.region, opts)
  if (!o.ok) return { ok: false, error: o.error ?? 'OCR failed (needs Android app v1.7+)' }
  const label = typeof args.label === 'string' ? args.label.trim().toLowerCase() : ''
  let lines = o.lines
  if (label) {
    const withLabel = lines.filter((l) => l.text.toLowerCase().includes(label))
    // the number may be on the labelled line or the nearest line to it
    if (withLabel.length) {
      const near = (a: OcrLine, b: OcrLine) => Math.hypot(a.cx - b.cx, a.cy - b.cy)
      const l0 = withLabel[0]
      const stripped = { ...l0, text: l0.text.replace(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '') }
      lines = [stripped, ...lines.filter((l) => l !== l0).sort((a, b) => near(a, l0) - near(b, l0))]
    } else return { ok: false, found: false, error: `label "${label}" not found on screen`, seen: o.lines.slice(0, 10).map((l) => l.text) }
  }
  const nums = lines.map((l) => ({ line: l, value: parseNumberToken(l.text) })).filter((x) => x.value !== null) as { line: OcrLine; value: number }[]
  if (!nums.length) return { ok: false, found: false, error: 'no number found', seen: o.lines.slice(0, 10).map((l) => l.text) }
  const idx = Math.min(Math.max(Number(args.index) || 0, 0), nums.length - 1)
  const hit = nums[idx]
  return { ok: true, found: true, value: hit.value, raw: hit.line.text, line: { cx: hit.line.cx, cy: hit.line.cy }, candidates: nums.length }
}
async function watchValue(env: Bindings, deviceId: string, args: Record<string, unknown>, opts: ExecOptions): Promise<ToolResult> {
  const cond = String(args.condition ?? 'change').toLowerCase()
  if (!['change', 'increase', 'decrease', 'above', 'below', 'equals'].includes(cond)) return { ok: false, error: 'condition must be change|increase|decrease|above|below|equals' }
  const thr = Number(args.value)
  if (['above', 'below', 'equals'].includes(cond) && !Number.isFinite(thr)) return { ok: false, error: `condition ${cond} requires value` }
  const timeout = Math.min(Math.max(Number(args.timeoutMs) || 10_000, 500), 40_000)
  const interval = Math.min(Math.max(Number(args.intervalMs) || 700, 300), 3000)
  const rn = () => readNumber(env, deviceId, { region: args.region, label: args.label }, opts)
  const start = Date.now()
  const first = await rn(); let polls = 1
  if (!first.ok) return { ok: false, error: first.error, polls }
  const from = first.value as number
  const test = (v: number) => cond === 'change' ? v !== from : cond === 'increase' ? v > from : cond === 'decrease' ? v < from : cond === 'above' ? v > thr : cond === 'below' ? v < thr : v === thr
  if (['above', 'below', 'equals'].includes(cond) && test(from)) return { ok: true, matched: true, from, to: from, delta: 0, waitedMs: 0, polls, alreadyTrue: true }
  while (Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, interval))
    const cur = await rn(); polls++
    if (!cur.ok) continue // number may flicker away mid-animation
    const v = cur.value as number
    if (test(v)) return { ok: true, matched: true, from, to: v, delta: v - from, raw: cur.raw, waitedMs: Date.now() - start, polls }
  }
  return { ok: false, matched: false, from, error: `value did not satisfy '${cond}' within ${timeout}ms`, waitedMs: Date.now() - start, polls }
}
/** calibrate: tap, then measure how long the screen takes to react. */
async function calibrate(env: Bindings, deviceId: string, args: Record<string, unknown>, opts: ExecOptions): Promise<ToolResult> {
  const x = Number(args.x), y = Number(args.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'calibrate requires x, y' }
  const timeout = Math.min(Math.max(Number(args.timeoutMs) || 1500, 200), 5000)
  const interval = Math.min(Math.max(Number(args.intervalMs) || 100, 50), 500)
  const before = await hashOf(env, deviceId)
  if (!before.ok) return { ok: false, error: before.error ?? 'screen_hash failed' }
  const t = await executeTool(env, deviceId, 'tap', { x, y }, { ...opts, internal: true })
  if (!t.ok) return { ok: false, error: `tap failed: ${t.error}` }
  const t0 = Date.now(); let polls = 0
  while (Date.now() - t0 < timeout) {
    const h = await hashOf(env, deviceId); polls++
    if (h.ok && h.hash !== before.hash) return { ok: true, changed: true, reactedMs: Date.now() - t0, polls, tapped: { x, y }, hint: 'control works; wait about reactedMs after tapping before observing' }
    await new Promise((r) => setTimeout(r, interval))
  }
  return { ok: true, changed: false, reactedMs: null, polls, tapped: { x, y }, hint: 'no visible reaction — wrong spot, disabled control, or a change too small for screen_hash (try act_and_see)' }
}

// ---------------------------------------------------------------- v1.9 screen memory

interface ScreenRec { name: string; hash: string; words: string[]; app?: string; ts: number }
const STOP_WORDS = new Set(['the', 'and', 'for', 'you', 'your', 'with', 'this', 'that', 'are', 'not', 'all'])
function keyWords(lines: OcrLine[]): string[] {
  const seen = new Set<string>(); const out: string[] = []
  for (const l of lines) for (const w of l.text.toLowerCase().split(/[^a-z\u0600-\u06ff]+/)) {
    if (w.length < 3 || STOP_WORDS.has(w) || seen.has(w)) continue
    seen.add(w); out.push(w); if (out.length >= 12) return out
  }
  return out
}
/** similarity of two equal-length hex hashes: 1 - hamming/bits */
function hashSimilarity(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 0
  let diff = 0
  for (let i = 0; i < a.length; i++) { let x = (parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 0xf; while (x) { diff += x & 1; x >>= 1 } }
  return 1 - diff / (a.length * 4)
}
function wordOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0
  const s = new Set(a); let n = 0
  for (const w of b) if (s.has(w)) n++
  return n / Math.max(a.length, b.length)
}
/** Fingerprint the current screen: perceptual hash + OCR key words (OCR failure tolerated). */
async function fingerprint(env: Bindings, deviceId: string, opts: ExecOptions): Promise<{ ok: boolean; error?: string; hash: string; words: string[]; app: string; ocrOk: boolean }> {
  const [h, o, app] = await Promise.all([hashOf(env, deviceId), ocrLines(env, deviceId, undefined, opts), currentPackage(env, deviceId)])
  if (!h.ok || !h.hash) return { ok: false, error: h.error ?? 'screen_hash failed (needs Android app v1.5+)', hash: '', words: [], app, ocrOk: false }
  return { ok: true, hash: h.hash, words: o.ok ? keyWords(o.lines) : [], app, ocrOk: o.ok }
}
function scoreScreens(screens: ScreenRec[], fp: { hash: string; words: string[]; app: string }) {
  return screens.map((s) => {
    const img = hashSimilarity(s.hash, fp.hash)
    const txt = wordOverlap(s.words, fp.words)
    const useTxt = s.words.length > 0 && fp.words.length > 0
    // image similarity of a random different screen is ~0.5-0.6; map 0.6..1 -> 0..1
    const imgNorm = Math.max(0, (img - 0.6) / 0.4)
    let confidence = useTxt ? imgNorm * 0.6 + txt * 0.4 : imgNorm
    if (s.app && fp.app && s.app !== fp.app) confidence *= 0.5
    return { name: s.name, confidence: Number(confidence.toFixed(3)), image: Number(img.toFixed(3)), text: Number(txt.toFixed(3)), app: s.app }
  }).sort((a, b) => b.confidence - a.confidence)
}
async function labelScreen(env: Bindings, deviceId: string, args: Record<string, unknown>, opts: ExecOptions): Promise<ToolResult> {
  const name = String(args.name ?? '').trim()
  if (!name) return { ok: false, error: 'label_screen requires name' }
  const fp = await fingerprint(env, deviceId, opts)
  if (!fp.ok) return { ok: false, error: fp.error }
  const r = await room(env, deviceId).fetch(`https://do/screens?deviceId=${deviceId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, hash: fp.hash, words: fp.words, app: fp.app || undefined }) })
  const out = (await r.json()) as ToolResult
  return { ...out, words: fp.words, app: fp.app || undefined, ocr: fp.ocrOk }
}
async function identifyScreen(env: Bindings, deviceId: string, args: Record<string, unknown>, opts: ExecOptions): Promise<ToolResult> {
  if (typeof args.delete === 'string' && args.delete) {
    const q = args.delete === '*' ? '' : `&name=${encodeURIComponent(args.delete)}`
    return (await (await room(env, deviceId).fetch(`https://do/screens?deviceId=${deviceId}${q}`, { method: 'DELETE' })).json()) as ToolResult
  }
  const { screens } = (await (await room(env, deviceId).fetch(`https://do/screens?deviceId=${deviceId}`)).json()) as { screens: ScreenRec[] }
  const labels = screens.map((s) => ({ name: s.name, app: s.app, words: s.words.slice(0, 5), ts: s.ts }))
  if (args.list === true) return { ok: true, count: labels.length, labels }
  if (!screens.length) { overlay(env, deviceId, { type: 'screen', name: null, confidence: 0 }); return { ok: true, screenName: null, confidence: 0, count: 0, hint: 'no labels yet — use label_screen on each distinct screen' } }
  const fp = await fingerprint(env, deviceId, opts)
  if (!fp.ok) return { ok: false, error: fp.error }
  const minConf = Math.min(Math.max(Number(args.minConfidence ?? 0.72) || 0.72, 0), 1)
  const ranked = scoreScreens(screens, fp)
  const best = ranked[0]
  const hit = best && best.confidence >= minConf
  overlay(env, deviceId, { type: 'screen', name: hit ? best.name : null, confidence: best?.confidence ?? 0 })
  return { ok: true, screenName: hit ? best.name : null, confidence: best?.confidence ?? 0, best, runnerUp: ranked[1], count: screens.length, app: fp.app || undefined, ...(hit ? {} : { hint: 'no confident match — this may be a new screen; label_screen it' }) }
}

/** recent_actions: compact view of the DO log for the agent. */
async function recentActions(env: Bindings, deviceId: string, args: Record<string, unknown>): Promise<ToolResult> {
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
  const logs = (await (await room(env, deviceId).fetch(`https://do/logs?deviceId=${deviceId}`)).json()) as { id: string; ts: number; action: Record<string, unknown>; status: string; error?: string; durationMs?: number }[]
  const summarize = (a: Record<string, unknown>) => {
    const o: Record<string, unknown> = { type: a.type }
    for (const k of ['x', 'y', 'x1', 'y1', 'x2', 'y2', 'text', 'elementId', 'url', 'color', 'count', 'direction', 'enabled']) if (a[k] !== undefined) o[k] = typeof a[k] === 'string' ? String(a[k]).slice(0, 40) : a[k]
    if (Array.isArray(a.points)) o.points = (a.points as unknown[]).length
    if (Array.isArray(a.colors)) o.colors = a.colors
    return o
  }
  return { ok: true, count: Math.min(limit, logs.length), actions: logs.slice(0, limit).map((l) => ({ ts: l.ts, ago: `${Math.round((Date.now() - l.ts) / 1000)}s`, status: l.status, ms: l.durationMs, ...(l.error ? { error: l.error } : {}), ...summarize(l.action) })) }
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
  const t = await executeTool(env, deviceId, 'tap', { x, y }, { ...opts, internal: true })
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
    case 'find_objects': { const o = (d.objects as { cx: number; cy: number }[] | undefined) ?? []; return [o.length > 0, o[0]?.cx, o[0]?.cy] }
    case 'track_object': { const p = d.predicted as { x: number; y: number } | undefined; return [d.found === true, p?.x ?? (d.cx as number | undefined), p?.y ?? (d.cy as number | undefined)] }
    case 'read_number': return [typeof r.value === 'number', (r.line as { cx?: number } | undefined)?.cx, (r.line as { cy?: number } | undefined)?.cy]
    case 'watch_value': return [r.ok === true && r.matched === true, undefined, undefined]
    case 'identify_screen': return [typeof r.screenName === 'string' && !!r.screenName, undefined, undefined]
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
  const t = await executeTool(env, deviceId, 'tap', { x: h.cx, y: h.cy }, { ...opts, internal: true })
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
  const app = typeof args.app === 'string' && args.app.trim() ? args.app.trim() : await currentPackage(env, deviceId)
  const r = await room(env, deviceId).fetch(`https://do/macros?deviceId=${deviceId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: args.name, steps, description: args.description, app: app || undefined }) })
  const out = (await r.json()) as ToolResult
  if (app) out.app = app
  return out
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
interface UiElement { i: number; text?: string; desc?: string; hint?: string; id?: string; cx: number; cy: number; clickable?: boolean; [k: string]: unknown }

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
      const tapped = await executeTool(env, deviceId, 'tap', { x: hit.cx, y: hit.cy }, { internal: true })
      return { ...tapped, found: true, scrolls: attempt, element: hit }
    }
    if (attempt === maxScrolls) break
    const sc = await executeTool(env, deviceId, 'scroll', { direction, amount: 0.5 }, { internal: true })
    if (!sc.ok) return { ok: false, error: `scroll failed: ${sc.error}`, scrolls: attempt }
    await new Promise((r) => setTimeout(r, 500))
  }
  return { ok: false, found: false, error: `not found after ${maxScrolls} scrolls`, scrolls: maxScrolls }
}
