import type { Action, ComboStep, Point, ReactLane, Region, SeqPoint , ReactWhen, ReactRule, FrameSpec, FrameColor, FrameOcr} from './types'

const HEX = /^#?[0-9a-fA-F]{6}$/
const normHex = (c: string) => '#' + c.trim().replace('#', '').toLowerCase()
function parseLane(v: unknown, i: number): { lane?: ReactLane; error?: string } {
  if (!v || typeof v !== 'object') return { error: `lanes[${i}] must be an object` }
  const l = v as Record<string, unknown>
  if (typeof l.color !== 'string' || !HEX.test(l.color.trim())) return { error: `lanes[${i}].color must be "#RRGGBB"` }
  const lane: ReactLane = { color: normHex(l.color) }
  if (isNum(l.tolerance)) lane.tolerance = clamp(Math.round(l.tolerance), 0, 128)
  if (isNum(l.minCount)) lane.minCount = clamp(Math.round(l.minCount), 1, 1_000_000)
  if (isNum(l.tapX) && isNum(l.tapY)) { lane.tapX = Math.round(l.tapX); lane.tapY = Math.round(l.tapY) }
  if (isNum(l.tapOffsetX)) lane.tapOffsetX = Math.round(l.tapOffsetX)
  if (isNum(l.tapOffsetY)) lane.tapOffsetY = Math.round(l.tapOffsetY)
  if (isNum(l.cooldownMs)) lane.cooldownMs = clamp(Math.round(l.cooldownMs), 0, 5000)
  if (typeof l.name === 'string' && l.name.trim()) lane.name = l.name.trim().slice(0, 24)
  const region = parseRegion(l.region); if (region) lane.region = region
  if (l.swipe && typeof l.swipe === 'object') {
    const s = l.swipe as Record<string, unknown>
    if (!isNum(s.dx) || !isNum(s.dy)) return { error: `lanes[${i}].swipe needs dx, dy` }
    lane.swipe = { dx: clamp(Math.round(s.dx), -4000, 4000), dy: clamp(Math.round(s.dy), -4000, 4000), durationMs: isNum(s.durationMs) ? clamp(Math.round(s.durationMs), 20, 3000) : 120 }
  }
  return { lane }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

function parsePoints(v: unknown, max = 50): Point[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) return null
  const out: Point[] = []
  for (const p of v) {
    const o = p as Record<string, unknown>
    if (!o || !isNum(o.x) || !isNum(o.y)) return null
    out.push({ x: o.x, y: o.y })
  }
  return out
}
function parseRegion(v: unknown): Region | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  if (![r.x, r.y, r.w, r.h].every(isNum)) return undefined
  if ((r.w as number) < 8 || (r.h as number) < 8) return undefined
  return { x: Math.round(r.x as number), y: Math.round(r.y as number), w: Math.round(r.w as number), h: Math.round(r.h as number) }
}

/** Validate untrusted JSON into a typed Action. Returns error string if invalid. */
export function parseAction(input: unknown): { action?: Action; error?: string } {
  if (!input || typeof input !== 'object') return { error: 'action must be an object' }
  const a = input as Record<string, unknown>
  switch (a.type) {
    case 'tap':
      if (!isNum(a.x) || !isNum(a.y)) return { error: 'tap requires numeric x,y' }
      return { action: { type: 'tap', x: a.x, y: a.y } }
    case 'long_press':
      if (!isNum(a.x) || !isNum(a.y)) return { error: 'long_press requires numeric x,y' }
      return { action: { type: 'long_press', x: a.x, y: a.y, duration: isNum(a.duration) ? a.duration : 800 } }
    case 'swipe':
    case 'drag': {
      if (![a.x1, a.y1, a.x2, a.y2].every(isNum)) return { error: `${a.type} requires numeric x1,y1,x2,y2` }
      const base = { x1: a.x1 as number, y1: a.y1 as number, x2: a.x2 as number, y2: a.y2 as number }
      if (a.type === 'drag') {
        return { action: { type: 'drag', ...base, duration: isNum(a.duration) ? a.duration : 600, holdMs: isNum(a.holdMs) ? clamp(a.holdMs, 0, 5000) : 500 } }
      }
      return { action: { type: 'swipe', ...base, duration: isNum(a.duration) ? a.duration : 300 } }
    }
    case 'pinch': {
      if (!isNum(a.x) || !isNum(a.y) || !isNum(a.scale)) return { error: 'pinch requires numeric x,y,scale' }
      return { action: { type: 'pinch', x: a.x, y: a.y, scale: clamp(a.scale, 0.1, 10), duration: isNum(a.duration) ? a.duration : 400 } }
    }
    case 'double_tap':
      if (!isNum(a.x) || !isNum(a.y)) return { error: 'double_tap requires numeric x,y' }
      return { action: { type: 'double_tap', x: a.x, y: a.y } }
    case 'tap_element': {
      const text = typeof a.text === 'string' && a.text.trim() ? a.text.trim().slice(0, 200) : undefined
      const elementId = typeof a.elementId === 'string' && a.elementId.trim() ? a.elementId.trim().slice(0, 200) : undefined
      if (!text && !elementId) return { error: 'tap_element requires text or elementId' }
      return { action: { type: 'tap_element', text, elementId, index: isNum(a.index) ? a.index : 0 } }
    }
    case 'scroll_element': {
      const text = typeof a.text === 'string' && a.text.trim() ? a.text.trim().slice(0, 200) : undefined
      const elementId = typeof a.elementId === 'string' && a.elementId.trim() ? a.elementId.trim().slice(0, 200) : undefined
      const direction = a.direction === 'backward' ? 'backward' : 'forward'
      return { action: { type: 'scroll_element', text, elementId, direction } }
    }
    case 'type_text': {
      if (typeof a.text !== 'string') return { error: 'type_text requires text' }
      return {
        action: {
          type: 'type_text', text: a.text.slice(0, 5000),
          elementId: typeof a.elementId === 'string' ? a.elementId : undefined,
          clear: a.clear !== false, submit: a.submit === true,
        },
      }
    }
    case 'set_clipboard':
      if (typeof a.text !== 'string') return { error: 'set_clipboard requires text' }
      return { action: { type: 'set_clipboard', text: a.text.slice(0, 20_000), paste: a.paste === true } }
    case 'get_notifications':
      return { action: { type: 'get_notifications', limit: isNum(a.limit) ? clamp(Math.round(a.limit), 1, 50) : 20 } }
    case 'open_app':
      if (typeof a.text !== 'string' || !a.text.trim()) return { error: 'open_app requires text (app name or package)' }
      return { action: { type: 'open_app', text: a.text.trim().slice(0, 200) } }
    case 'open_url':
      if (typeof a.url !== 'string' || !a.url.trim()) return { error: 'open_url requires url' }
      return { action: { type: 'open_url', url: a.url.trim().slice(0, 2000) } }
    case 'screenshot': {
      const action: Action = { type: 'screenshot' }
      if (isNum(a.maxWidth)) action.maxWidth = clamp(Math.round(a.maxWidth), 120, 2160)
      if (isNum(a.quality)) action.quality = clamp(Math.round(a.quality), 10, 100)
      if (a.format === 'jpeg' || a.format === 'jpg') action.format = 'jpeg'
      else if (a.format === 'png') action.format = 'png'
      if (isNum(a.grid) && a.grid > 0) action.grid = clamp(Math.round(a.grid), 20, 500)
      const region = parseRegion(a.region)
      if (region) action.region = region
      return { action }
    }
    case 'tap_sequence': {
      if (!Array.isArray(a.points) || a.points.length === 0 || a.points.length > 50) return { error: 'tap_sequence requires points[1..50]' }
      const points: SeqPoint[] = []
      let total = 0
      for (const p of a.points as Record<string, unknown>[]) {
        if (!p || !isNum(p.x) || !isNum(p.y)) return { error: 'each point needs numeric x,y' }
        const sp: SeqPoint = { x: p.x, y: p.y }
        if (isNum(p.delayMs)) sp.delayMs = clamp(Math.round(p.delayMs), 0, 10_000)
        if (isNum(p.durationMs)) sp.durationMs = clamp(Math.round(p.durationMs), 20, 5_000)
        total += (sp.delayMs ?? 0) + (sp.durationMs ?? 60)
        points.push(sp)
      }
      if (total > 50_000) return { error: 'tap_sequence total time must be <= 50s' }
      return { action: { type: 'tap_sequence', points } }
    }
    case 'multi_tap': {
      const points = parsePoints(a.points, 10)
      if (!points) return { error: 'multi_tap requires points[1..10] with numeric x,y' }
      return { action: { type: 'multi_tap', points, duration: isNum(a.duration) ? clamp(a.duration, 20, 5000) : 60 } }
    }
    case 'swipe_path': {
      const points = parsePoints(a.points, 50)
      if (!points || points.length < 2) return { error: 'swipe_path requires points[2..50]' }
      return { action: { type: 'swipe_path', points, duration: isNum(a.duration) ? clamp(a.duration, 50, 30_000) : 500 } }
    }
    case 'repeat_tap': {
      if (!isNum(a.x) || !isNum(a.y)) return { error: 'repeat_tap requires numeric x,y' }
      const count = isNum(a.count) ? clamp(Math.round(a.count), 1, 100) : 5
      const intervalMs = isNum(a.intervalMs) ? clamp(Math.round(a.intervalMs), 30, 5000) : 100
      if (count * (intervalMs + 60) > 50_000) return { error: 'repeat_tap total time must be <= 50s' }
      return { action: { type: 'repeat_tap', x: a.x, y: a.y, count, intervalMs } }
    }
    case 'pixel': {
      const points = parsePoints(a.points, 50)
      if (!points) return { error: 'pixel requires points[1..50]' }
      return { action: { type: 'pixel', points } }
    }
    case 'find_color': {
      if (typeof a.color !== 'string' || !/^#?[0-9a-fA-F]{6}$/.test(a.color.trim())) return { error: 'find_color requires color "#RRGGBB"' }
      const color = '#' + a.color.trim().replace('#', '').toLowerCase()
      const action: Action = { type: 'find_color', color, tolerance: isNum(a.tolerance) ? clamp(Math.round(a.tolerance), 0, 128) : 24 }
      const region = parseRegion(a.region)
      if (region) action.region = region
      return { action }
    }
    case 'screen_hash':
      return { action: { type: 'screen_hash' } }
    case 'screen_diff':
      return { action: { type: 'screen_diff', threshold: isNum(a.threshold) ? clamp(Math.round(a.threshold), 4, 128) : 32, cell: isNum(a.cell) ? clamp(Math.round(a.cell), 20, 400) : 60 } }
    case 'watch_color': {
      if (typeof a.color !== 'string' || !/^#?[0-9a-fA-F]{6}$/.test(a.color.trim())) return { error: 'watch_color requires color "#RRGGBB"' }
      const action: Action = {
        type: 'watch_color', color: '#' + a.color.trim().replace('#', '').toLowerCase(),
        tolerance: isNum(a.tolerance) ? clamp(Math.round(a.tolerance), 0, 128) : 24,
        appear: a.appear !== false,
        timeoutMs: isNum(a.timeoutMs) ? clamp(Math.round(a.timeoutMs), 200, 30_000) : 5000,
        intervalMs: isNum(a.intervalMs) ? clamp(Math.round(a.intervalMs), 50, 2000) : 150,
        minCount: isNum(a.minCount) ? clamp(Math.round(a.minCount), 1, 1_000_000) : 20,
      }
      const region = parseRegion(a.region); if (region) action.region = region
      return { action }
    }
    case 'wait_pixel': {
      if (!isNum(a.x) || !isNum(a.y)) return { error: 'wait_pixel requires numeric x,y' }
      if (typeof a.color !== 'string' || !/^#?[0-9a-fA-F]{6}$/.test(a.color.trim())) return { error: 'wait_pixel requires color "#RRGGBB"' }
      return { action: { type: 'wait_pixel', x: a.x, y: a.y, color: '#' + a.color.trim().replace('#', '').toLowerCase(),
        tolerance: isNum(a.tolerance) ? clamp(Math.round(a.tolerance), 0, 128) : 24, appear: a.appear !== false,
        timeoutMs: isNum(a.timeoutMs) ? clamp(Math.round(a.timeoutMs), 200, 30_000) : 5000,
        intervalMs: isNum(a.intervalMs) ? clamp(Math.round(a.intervalMs), 50, 2000) : 100 } }
    }
    case 'read_text': {
      const action: Action = { type: 'read_text' }
      const region = parseRegion(a.region); if (region) action.region = region
      if (typeof a.lang === 'string' && /^[a-z]{2,3}$/i.test(a.lang)) action.lang = a.lang.toLowerCase()
      return { action }
    }
    case 'find_colors': {
      if (!Array.isArray(a.colors) || a.colors.length === 0 || a.colors.length > 8) return { error: 'find_colors requires colors[1..8] of "#RRGGBB"' }
      const colors: string[] = []
      for (const c of a.colors) { if (typeof c !== 'string' || !/^#?[0-9a-fA-F]{6}$/.test(c.trim())) return { error: `bad color ${String(c)}` }; colors.push('#' + c.trim().replace('#', '').toLowerCase()) }
      const action: Action = { type: 'find_colors', colors, tolerance: isNum(a.tolerance) ? clamp(Math.round(a.tolerance), 0, 128) : 24 }
      const region = parseRegion(a.region); if (region) action.region = region
      return { action }
    }
    // ---- v2.5 multi-touch
    case 'finger_down': {
      if (!isNum(a.x) || !isNum(a.y)) return { error: 'finger_down requires x, y' }
      return { action: { type: 'finger_down', finger: isNum(a.finger) ? clamp(Math.round(a.finger), 0, 3) : 0, x: Math.round(a.x), y: Math.round(a.y), duration: isNum(a.duration) ? clamp(Math.round(a.duration), 20, 1000) : 60 } }
    }
    case 'finger_move': {
      const action: Action = { type: 'finger_move', finger: isNum(a.finger) ? clamp(Math.round(a.finger), 0, 3) : 0, duration: isNum(a.duration) ? clamp(Math.round(a.duration), 20, 10_000) : 150 }
      if (Array.isArray(a.points) && a.points.length) { const pts = parsePoints(a.points, 20); if (!pts) return { error: 'bad points' }; action.points = pts }
      else if (isNum(a.x) && isNum(a.y)) { action.x = Math.round(a.x); action.y = Math.round(a.y) }
      else return { error: 'finger_move requires x,y or points' }
      return { action }
    }
    case 'finger_up': return { action: { type: 'finger_up', finger: isNum(a.finger) ? clamp(Math.round(a.finger), -1, 3) : 0 } }
    case 'joystick': {
      if (!isNum(a.x) || !isNum(a.y)) return { error: 'joystick requires x, y (stick centre)' }
      let angle = isNum(a.angle) ? a.angle : undefined
      if (angle === undefined && typeof a.direction === 'string') { const m: Record<string, number> = { right: 0, 'down-right': 45, down: 90, 'down-left': 135, left: 180, 'up-left': 225, up: 270, 'up-right': 315 }; angle = m[a.direction.toLowerCase()] }
      if (angle === undefined) return { error: 'joystick requires angle (deg, 0=right 90=down 270=up) or direction (up|down|left|right|up-left|...)' }
      return { action: { type: 'joystick', x: Math.round(a.x), y: Math.round(a.y), angle: ((angle % 360) + 360) % 360, distance: isNum(a.distance) ? clamp(Math.round(a.distance), 10, 800) : 150, duration: isNum(a.duration) ? clamp(Math.round(a.duration), 50, 40_000) : 500, finger: isNum(a.finger) ? clamp(Math.round(a.finger), 0, 3) : 0, release: a.release !== false } }
    }
    case 'aim': {
      if (!isNum(a.x) || !isNum(a.y)) return { error: 'aim requires x, y (start point on the look/camera area)' }
      const dx = isNum(a.dx) ? Math.round(a.dx) : 0, dy = isNum(a.dy) ? Math.round(a.dy) : 0
      if (!dx && !dy) return { error: 'aim requires dx and/or dy (pixels to drag the camera)' }
      return { action: { type: 'aim', x: Math.round(a.x), y: Math.round(a.y), dx: clamp(dx, -3000, 3000), dy: clamp(dy, -3000, 3000), duration: isNum(a.duration) ? clamp(Math.round(a.duration), 20, 3000) : 120, finger: isNum(a.finger) ? clamp(Math.round(a.finger), 0, 3) : 1, steps: isNum(a.steps) ? clamp(Math.round(a.steps), 1, 20) : 4, release: a.release !== false } }
    }
    case 'fire_burst': {
      if (!isNum(a.x) || !isNum(a.y)) return { error: 'fire_burst requires x, y' }
      return { action: { type: 'fire_burst', x: Math.round(a.x), y: Math.round(a.y), count: isNum(a.count) ? clamp(Math.round(a.count), 1, 200) : 5, intervalMs: isNum(a.intervalMs) ? clamp(Math.round(a.intervalMs), 30, 2000) : 90, holdMs: isNum(a.holdMs) ? clamp(Math.round(a.holdMs), 0, 30_000) : 0 } }
    }
    case 'combo': {
      const raw = a.combo ?? a.steps
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > 40) return { error: 'combo requires steps[1..40] of {op,...}' }
      const ops = new Set(['down', 'move', 'up', 'tap', 'wait', 'joystick', 'aim', 'fire', 'tap_found', 'aim_found'])
      const combo: ComboStep[] = []
      for (let i = 0; i < raw.length; i++) {
        const s = raw[i] as Record<string, unknown>
        if (!s || typeof s !== 'object' || typeof s.op !== 'string' || !ops.has(s.op)) return { error: `combo[${i}].op must be one of ${[...ops].join('|')}` }
        const st: ComboStep = { op: s.op as ComboStep['op'] }
        for (const k of ['finger', 'x', 'y', 'dx', 'dy', 'angle', 'distance', 'duration', 'delayMs', 'count', 'intervalMs', 'holdMs', 'lookX', 'lookY', 'maxStep'] as const) if (isNum(s[k])) (st as unknown as Record<string, unknown>)[k] = Math.round(s[k] as number)
        if (isNum(s.sensitivity)) st.sensitivity = Math.min(Math.max(s.sensitivity as number, 0.05), 5)
        if (typeof s.release === 'boolean') st.release = s.release
        if (st.op === 'joystick' && st.angle === undefined && typeof s.direction === 'string') { const m: Record<string, number> = { right: 0, 'down-right': 45, down: 90, 'down-left': 135, left: 180, 'up-left': 225, up: 270, 'up-right': 315 }; st.angle = m[s.direction.toLowerCase()] }
        if (['down', 'tap', 'joystick', 'aim', 'fire', 'aim_found'].includes(st.op) && (st.x === undefined || st.y === undefined)) return { error: `combo[${i}] (${st.op}) requires x, y` }
        combo.push(st)
      }
      return { action: { type: 'combo', combo } }
    }
    case 'react_script': {
      const rulesRaw = a.rules
      if (!Array.isArray(rulesRaw) || rulesRaw.length === 0 || rulesRaw.length > 12) return { error: 'react_script requires rules[1..12] of {when:[...], then:[...]}' }
      const whenTypes = new Set(['color_present', 'color_absent', 'pixel_is', 'pixel_not', 'text_present', 'text_absent', 'always'])
      const parseWhen = (w: Record<string, unknown>, where: string): { when?: ReactWhen; error?: string } => {
        if (!w || typeof w !== 'object' || typeof w.type !== 'string' || !whenTypes.has(w.type)) return { error: `${where}.type must be one of ${[...whenTypes].join('|')}` }
        const out: ReactWhen = { type: w.type as ReactWhen['type'] }
        if ((w.type.startsWith('color') || w.type.startsWith('pixel'))) { if (typeof w.color !== 'string' || !HEX.test(w.color.trim())) return { error: `${where}.color must be #rrggbb` }; out.color = normHex(w.color) }
        if (w.type.startsWith('text')) { if (typeof w.text !== 'string' || !w.text.trim()) return { error: `${where}.text required` }; out.text = w.text.trim() }
        if (w.type.startsWith('pixel')) { if (!isNum(w.x) || !isNum(w.y)) return { error: `${where} requires x,y` }; out.x = Math.round(w.x as number); out.y = Math.round(w.y as number) }
        const region = parseRegion(w.region); if (region) out.region = region
        for (const k of ['tolerance', 'minCount', 'minSize', 'maxSize', 'forMs'] as const) if (isNum(w[k])) out[k] = Math.round(w[k] as number)
        return { when: out }
      }
      const rules: ReactRule[] = []
      for (let i = 0; i < rulesRaw.length; i++) {
        const r = rulesRaw[i] as Record<string, unknown>
        if (!r || typeof r !== 'object' || !Array.isArray(r.when) || !Array.isArray(r.then) || r.then.length === 0) return { error: `rules[${i}] requires when[] and then[1..]` }
        const when: ReactWhen[] = []
        for (let c = 0; c < r.when.length; c++) { const pw = parseWhen(r.when[c] as Record<string, unknown>, `rules[${i}].when[${c}]`); if (pw.error) return { error: pw.error }; when.push(pw.when!) }
        if (when.length === 0) when.push({ type: 'always' })
        const combo = parseAction({ type: 'combo', steps: r.then })
        if (combo.error || !combo.action || combo.action.type !== 'combo') return { error: `rules[${i}].then: ${combo.error}` }
        const rule: ReactRule = { when, then: combo.action.combo }
        if (typeof r.name === 'string') rule.name = r.name.slice(0, 40)
        for (const k of ['cooldownMs', 'priority', 'maxFires'] as const) if (isNum(r[k])) rule[k] = Math.round(r[k] as number)
        if (typeof r.exclusive === 'boolean') rule.exclusive = r.exclusive
        rules.push(rule)
      }
      const action: Action = { type: 'react_script', rules }
      if (Array.isArray(a.stopRules)) { const srs: ReactWhen[] = []; for (let c = 0; c < a.stopRules.length; c++) { const pw = parseWhen(a.stopRules[c] as Record<string, unknown>, `stopRules[${c}]`); if (pw.error) return { error: pw.error }; srs.push(pw.when!) }; action.stopRules = srs }
      if (isNum(a.timeoutMs)) action.timeoutMs = clamp(Math.round(a.timeoutMs), 500, 60_000)
      if (isNum(a.maxTriggers)) action.maxTriggers = clamp(Math.round(a.maxTriggers), 1, 500)
      if (isNum(a.intervalMs)) action.intervalMs = clamp(Math.round(a.intervalMs), 15, 2000)
      if (typeof a.release === 'boolean') action.release = a.release
      return { action }
    }
    case 'play_frame': {
      const f = (a.frame ?? a) as Record<string, unknown>
      const frame: FrameSpec = {}
      if (isNum(f.maxWidth)) frame.maxWidth = clamp(Math.round(f.maxWidth), 0, 2160)
      if (isNum(f.quality)) frame.quality = clamp(Math.round(f.quality), 10, 100)
      if (f.diff === true) frame.diff = true
      if (Array.isArray(f.objects)) {
        frame.objects = []
        for (let i = 0; i < Math.min(f.objects.length, 8); i++) {
          const o = f.objects[i] as Record<string, unknown>
          if (!o || typeof o.color !== 'string' || !HEX.test(o.color.trim())) return { error: `frame.objects[${i}].color must be #rrggbb` }
          const fc: FrameColor = { color: normHex(o.color) }
          if (typeof o.name === 'string') fc.name = o.name.slice(0, 32)
          for (const k of ['tolerance', 'minSize', 'maxSize', 'max'] as const) if (isNum(o[k])) fc[k] = Math.round(o[k] as number)
          const region = parseRegion(o.region); if (region) fc.region = region
          if (o.match === 'hue') fc.match = 'hue'
          frame.objects.push(fc)
        }
      }
      if (Array.isArray(f.ocr)) {
        frame.ocr = []
        for (let i = 0; i < Math.min(f.ocr.length, 6); i++) { const o = f.ocr[i] as Record<string, unknown>; const fo: FrameOcr = {}; if (typeof o?.name === 'string') fo.name = o.name.slice(0, 32); const region = parseRegion(o?.region); if (region) fo.region = region; if (o?.number === true) fo.number = true; frame.ocr.push(fo) }
      }
      if (Array.isArray(f.pixels)) frame.pixels = (f.pixels as Record<string, unknown>[]).filter((p) => p && isNum(p.x) && isNum(p.y)).slice(0, 24).map((p) => ({ x: Math.round(p.x as number), y: Math.round(p.y as number) }))
      return { action: { type: 'play_frame', frame } }
    }
    case 'sample_colors': {
      const action: Action = { type: 'sample_colors', maxColors: isNum(a.maxColors) ? clamp(Math.round(a.maxColors), 1, 24) : 8, quant: isNum(a.quant) ? clamp(Math.round(a.quant), 8, 64) : 32, ignoreGrey: a.ignoreGrey !== false }
      const region = parseRegion(a.region); if (region) action.region = region
      return { action }
    }
    case 'track_object': {
      if (typeof a.color !== 'string' || !HEX.test(a.color.trim())) return { error: 'track_object requires color "#RRGGBB"' }
      const action: Action = { type: 'track_object', color: normHex(a.color), tolerance: isNum(a.tolerance) ? clamp(Math.round(a.tolerance), 0, 128) : 24, minCount: isNum(a.minCount) ? clamp(Math.round(a.minCount), 1, 1_000_000) : 20, samples: isNum(a.samples) ? clamp(Math.round(a.samples), 2, 12) : 5, intervalMs: isNum(a.intervalMs) ? clamp(Math.round(a.intervalMs), 40, 1000) : 120, predictMs: isNum(a.predictMs) ? clamp(Math.round(a.predictMs), 0, 3000) : 300 }
      const region = parseRegion(a.region); if (region) action.region = region
      return { action }
    }
    case 'find_objects': {
      if (typeof a.color !== 'string' || !/^#?[0-9a-fA-F]{6}$/.test(a.color.trim())) return { error: 'find_objects requires color "#RRGGBB"' }
      const action: Action = { type: 'find_objects', color: '#' + a.color.trim().replace('#', '').toLowerCase(), tolerance: isNum(a.tolerance) ? clamp(Math.round(a.tolerance), 0, 128) : 24, minSize: isNum(a.minSize) ? clamp(Math.round(a.minSize), 1, 2000) : 12, maxResults: isNum(a.maxResults) ? clamp(Math.round(a.maxResults), 1, 40) : 10 }
      const region = parseRegion(a.region); if (region) action.region = region
      if (a.match === 'hue') action.match = 'hue'
      return { action }
    }
    case 'auto_react': {
      if (typeof a.color !== 'string' || !/^#?[0-9a-fA-F]{6}$/.test(a.color.trim())) return { error: 'auto_react requires color "#RRGGBB"' }
      const action: Action = {
        type: 'auto_react', color: '#' + a.color.trim().replace('#', '').toLowerCase(),
        tolerance: isNum(a.tolerance) ? clamp(Math.round(a.tolerance), 0, 128) : 24,
        minCount: isNum(a.minCount) ? clamp(Math.round(a.minCount), 1, 1_000_000) : 20,
        maxTriggers: isNum(a.maxTriggers) ? clamp(Math.round(a.maxTriggers), 1, 200) : 20,
        timeoutMs: isNum(a.timeoutMs) ? clamp(Math.round(a.timeoutMs), 500, 40_000) : 10_000,
        intervalMs: isNum(a.intervalMs) ? clamp(Math.round(a.intervalMs), 30, 2000) : 80,
        cooldownMs: isNum(a.cooldownMs) ? clamp(Math.round(a.cooldownMs), 0, 5000) : 250,
      }
      if (isNum(a.tapOffsetX)) action.tapOffsetX = Math.round(a.tapOffsetX)
      if (isNum(a.tapOffsetY)) action.tapOffsetY = Math.round(a.tapOffsetY)
      if (isNum(a.tapX) && isNum(a.tapY)) { action.tapX = Math.round(a.tapX); action.tapY = Math.round(a.tapY) }
      const region = parseRegion(a.region); if (region) action.region = region
      if (Array.isArray(a.lanes)) {
        if (a.lanes.length > 6) return { error: 'auto_react supports at most 6 lanes' }
        const lanes: ReactLane[] = []
        for (let i = 0; i < a.lanes.length; i++) { const r = parseLane(a.lanes[i], i); if (r.error) return { error: r.error }; lanes.push(r.lane!) }
        if (lanes.length) action.lanes = lanes
      }
      if (typeof a.stopColor === 'string') {
        if (!HEX.test(a.stopColor.trim())) return { error: 'stopColor must be "#RRGGBB"' }
        action.stopColor = normHex(a.stopColor)
        const sr = parseRegion(a.stopRegion); if (sr) action.stopRegion = sr
        if (isNum(a.stopMinCount)) action.stopMinCount = clamp(Math.round(a.stopMinCount), 1, 1_000_000)
      }
      return { action }
    }
    case 'stream': {
      const action: Action = { type: 'stream', enabled: a.enabled === true }
      if (isNum(a.fps)) action.fps = clamp(a.fps, 0.2, 4)
      if (isNum(a.maxWidth)) action.maxWidth = clamp(Math.round(a.maxWidth), 120, 720)
      if (isNum(a.quality)) action.quality = clamp(Math.round(a.quality), 10, 90)
      return { action }
    }
    case 'set_device_id': {
      // v4.7.3 admin rename: the phone saves the new id and reconnects under it
      if (typeof a.text !== 'string' || !isValidDeviceId(a.text)) return { error: 'set_device_id requires a valid text (new device id)' }
      return { action: { type: 'set_device_id', text: a.text } }
    }
    case 'domino_bot': {
      const op = typeof a.text === 'string' ? a.text.toLowerCase() : 'status'
      if (!['start', 'stop', 'status', 'analyze'].includes(op)) return { error: 'domino_bot text must be start|stop|status|analyze' }
      const action: Action = { type: 'domino_bot', text: op }
      if (isNum(a.duration)) action.duration = clamp(Math.round(a.duration), 10_000, 6 * 3_600_000)
      if (isNum(a.holdMs)) action.holdMs = clamp(Math.round(a.holdMs), 0, 30_000)
      return { action }
    }
    case 'find_image': {
      if (typeof a.image !== 'string' || a.image.length < 16 || a.image.length > 400_000) return { error: 'find_image requires image (base64 PNG/JPEG, <= 300KB)' }
      const action: Action = { type: 'find_image', image: a.image.replace(/^data:image\/\w+;base64,/, ''), threshold: isNum(a.threshold) ? clamp(a.threshold, 0.5, 1) : 0.85, maxResults: isNum(a.maxResults) ? clamp(Math.round(a.maxResults), 1, 20) : 5 }
      const region = parseRegion(a.region); if (region) action.region = region
      return { action }
    }
    case 'back': case 'home': case 'recents': case 'notifications': case 'quick_settings': case 'wake':
    case 'lock': case 'ping': case 'ui_dump': case 'list_apps': case 'current_app': case 'device_info':
      return { action: { type: a.type } as Action }
    default:
      return { error: `unknown action type: ${String(a.type)}` }
  }
}

export function isValidDeviceId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id)
}
