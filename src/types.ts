// Shared protocol types between Worker, Dashboard and Android client

export type Bindings = {
  RELAY_TOKEN: string
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
  | { type: 'screenshot' }
  | { type: 'ping' }

export const ACTION_TYPES = [
  'tap', 'long_press', 'swipe', 'back', 'home', 'recents',
  'notifications', 'lock', 'screenshot', 'ping',
] as const

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
  /** base64 PNG for screenshot actions */
  screenshot?: string
  durationMs?: number
}

/** Periodic status from phone */
export interface HelloMessage {
  kind: 'hello'
  model?: string
  android?: string
  appVersion?: string
  screen?: { w: number; h: number }
  accessibilityEnabled?: boolean
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
  commandsSent: number
  commandsOk: number
  commandsFailed: number
}

export interface LogEntry {
  id: string
  ts: number
  action: Action
  status: 'sent' | 'ok' | 'failed' | 'timeout' | 'offline'
  error?: string
  durationMs?: number
}
