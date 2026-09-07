// Shared protocol types between Worker, Monitor page and Android client

export type Bindings = {
  /** Master/admin token. Full access to every device + admin API. */
  RELAY_TOKEN: string
  /** Optional: HTTP endpoint that receives {event, deviceId, info} JSON on online/offline. */
  WEBHOOK_URL?: string
  DEVICE_ROOM: DurableObjectNamespace
  ASSETS: Fetcher
}

/** Automation actions the phone can execute via AccessibilityService */
export type Action =
  | { type: 'tap'; x: number; y: number }
  | { type: 'long_press'; x: number; y: number; duration?: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; duration?: number }
  | { type: 'back' }
  | { type: 'home' }
  | { type: 'recents' }
  | { type: 'notifications' }
  | { type: 'lock' }
  | { type: 'screenshot'; maxWidth?: number; quality?: number; format?: 'png' | 'jpeg'; grid?: number; region?: Region }
  | { type: 'ping' }
  | { type: 'double_tap'; x: number; y: number }
  | { type: 'quick_settings' }
  | { type: 'wake' }
  | { type: 'ui_dump' }
  | { type: 'tap_element'; text?: string; elementId?: string; index?: number }
  | { type: 'type_text'; text: string; elementId?: string; clear?: boolean; submit?: boolean }
  | { type: 'open_app'; text: string }
  | { type: 'open_url'; url: string }
  | { type: 'list_apps' }
  | { type: 'current_app' }
  // v1.4
  | { type: 'pinch'; x: number; y: number; scale: number; duration?: number }
  | { type: 'drag'; x1: number; y1: number; x2: number; y2: number; duration?: number; holdMs?: number }
  | { type: 'set_clipboard'; text: string; paste?: boolean }
  | { type: 'get_notifications'; limit?: number }
  | { type: 'device_info' }
  | { type: 'scroll_element'; text?: string; elementId?: string; direction: 'forward' | 'backward' }
  // v1.5 — games / precision input (executed ON the phone for exact timing)
  | { type: 'tap_sequence'; points: SeqPoint[] }
  | { type: 'multi_tap'; points: Point[]; duration?: number }
  | { type: 'swipe_path'; points: Point[]; duration?: number }
  | { type: 'repeat_tap'; x: number; y: number; count: number; intervalMs: number }
  // v1.5 — vision helpers
  | { type: 'pixel'; points: Point[] }
  | { type: 'find_color'; color: string; tolerance?: number; region?: Region }
  | { type: 'screen_hash' }

export interface Point { x: number; y: number }
export interface SeqPoint extends Point { delayMs?: number; durationMs?: number }
export interface Region { x: number; y: number; w: number; h: number }
export interface Note { text: string; ts: number }

/** Per-command timeout: long on-phone sequences need more than the default 15s. */
export function actionTimeoutMs(a: Action): number {
  const base = 15_000
  switch (a.type) {
    case 'tap_sequence': return base + a.points.reduce((t, p) => t + (p.delayMs ?? 0) + (p.durationMs ?? 60), 0)
    case 'repeat_tap': return base + a.count * (a.intervalMs + 60)
    case 'swipe_path': return base + (a.duration ?? 500)
    case 'long_press': return base + (a.duration ?? 800)
    case 'drag': return base + (a.duration ?? 600) + (a.holdMs ?? 500)
    default: return base
  }
}

export const ACTION_TYPES = [
  'tap', 'long_press', 'swipe', 'back', 'home', 'recents',
  'notifications', 'lock', 'screenshot', 'ping', 'double_tap', 'quick_settings', 'wake',
  'ui_dump', 'tap_element', 'type_text', 'open_app', 'open_url', 'list_apps', 'current_app',
  'pinch', 'drag', 'set_clipboard', 'get_notifications', 'device_info', 'scroll_element',
  'tap_sequence', 'multi_tap', 'swipe_path', 'repeat_tap', 'pixel', 'find_color', 'screen_hash',
] as const

/** Read-only actions may bypass the serialized input queue (safe to run concurrently). */
export const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  'screenshot', 'ping', 'ui_dump', 'list_apps', 'current_app', 'get_notifications', 'device_info',
  'pixel', 'find_color', 'screen_hash',
])

/** Message sent server -> phone */
export interface CommandMessage {
  kind: 'command'
  id: string
  ts: number
  action: Action
}

/** Message sent phone -> server after executing a command */
export interface ResultMessage {
  kind: 'result'
  id: string
  ok: boolean
  error?: string
  /** base64 PNG/JPEG for screenshot actions */
  screenshot?: string
  /** mime of screenshot (default image/png) */
  screenshotMime?: string
  durationMs?: number
  /** structured payload (ui elements, app list, ...) */
  data?: unknown
}

/** Periodic status from phone */
export interface HelloMessage {
  kind: 'hello'
  model?: string
  android?: string
  appVersion?: string
  screen?: { w: number; h: number }
  accessibilityEnabled?: boolean
  battery?: number
  charging?: boolean
}

export type PhoneMessage = ResultMessage | HelloMessage | { kind: 'pong' }

export interface DeviceInfo {
  deviceId: string
  online: boolean
  connectedAt?: number
  lastSeen?: number
  model?: string
  android?: string
  appVersion?: string
  screen?: { w: number; h: number }
  accessibilityEnabled?: boolean
  battery?: number
  charging?: boolean
  commandsSent: number
  commandsOk: number
  commandsFailed: number
  /** commands currently waiting in the serialized input queue */
  queued?: number
  /** optional human label set via admin API */
  label?: string
}

export interface LogEntry {
  id: string
  ts: number
  action: Action
  status: 'sent' | 'ok' | 'failed' | 'timeout' | 'offline' | 'queued' | 'rate_limited'
  error?: string
  durationMs?: number
}

// ---------------------------------------------------------------- auth
export type AuthContext =
  | { role: 'admin'; tokenId?: string; label?: string }
  | { role: 'device'; deviceId: string; tokenId: string; label?: string }

export interface TokenRecord {
  /** short public id (first 8 hex of hash) */
  id: string
  deviceId: string
  label?: string
  createdAt: number
  lastUsedAt?: number
  /** true = can only read (screenshot/ui/status), no input */
  readOnly?: boolean
  /** true = full admin token (same power as RELAY_TOKEN); deviceId is '*' */
  admin?: boolean
}
