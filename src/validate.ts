import type { Action } from './types'

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

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
