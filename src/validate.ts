import type { Action } from './types'

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

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
      if (![a.x1, a.y1, a.x2, a.y2].every(isNum)) return { error: 'swipe requires numeric x1,y1,x2,y2' }
      return {
        action: {
          type: 'swipe',
          x1: a.x1 as number, y1: a.y1 as number, x2: a.x2 as number, y2: a.y2 as number,
          duration: isNum(a.duration) ? a.duration : 300,
        },
      }
    case 'back': case 'home': case 'recents': case 'notifications':
    case 'lock': case 'screenshot': case 'ping':
      return { action: { type: a.type } as Action }
    default:
      return { error: `unknown action type: ${String(a.type)}` }
  }
}

export function isValidDeviceId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id)
}
