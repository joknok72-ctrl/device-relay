import type { Action, Point, ReactLane, Region, SeqPoint } from './types'

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
