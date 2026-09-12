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
  // v1.6 — smarter perception (all on-device)
  | { type: 'screen_diff'; threshold?: number; cell?: number }
  | { type: 'watch_color'; color: string; tolerance?: number; region?: Region; appear?: boolean; timeoutMs?: number; intervalMs?: number; minCount?: number }
  | { type: 'find_image'; image: string; threshold?: number; region?: Region; maxResults?: number }
  | { type: 'wait_pixel'; x: number; y: number; color: string; tolerance?: number; appear?: boolean; timeoutMs?: number; intervalMs?: number }
  // v1.7 — OCR, multi-colour scan, live stream
  | { type: 'read_text'; region?: Region; lang?: string }
  | { type: 'find_colors'; colors: string[]; tolerance?: number; region?: Region }
  | { type: 'stream'; enabled: boolean; fps?: number; maxWidth?: number; quality?: number }
  | { type: 'set_device_id'; text: string }
  // v1.9
  // v2.5 multi-touch
  | { type: 'finger_down'; finger: number; x: number; y: number; duration?: number }
  | { type: 'finger_move'; finger: number; x?: number; y?: number; points?: Point[]; duration?: number }
  | { type: 'finger_up'; finger: number }
  | { type: 'joystick'; x: number; y: number; angle: number; distance: number; duration: number; finger: number; release: boolean }
  | { type: 'aim'; x: number; y: number; dx: number; dy: number; duration: number; finger: number; steps: number; release: boolean }
  | { type: 'fire_burst'; x: number; y: number; count: number; intervalMs: number; holdMs: number }
  | { type: 'combo'; combo: ComboStep[] }
  // v4.1 live play
  | { type: 'react_script'; rules: ReactRule[]; stopRules?: ReactWhen[]; timeoutMs?: number; maxTriggers?: number; intervalMs?: number; release?: boolean }
  | { type: 'play_frame'; frame: FrameSpec }
  // v2.1
  | { type: 'sample_colors'; region?: Region; maxColors?: number; quant?: number; ignoreGrey?: boolean }
  | { type: 'track_object'; color: string; tolerance?: number; region?: Region; minCount?: number; samples?: number; intervalMs?: number; predictMs?: number }
  | { type: 'find_objects'; color: string; tolerance?: number; region?: Region; minSize?: number; maxResults?: number; /** v3.1 */ match?: 'rgb' | 'hue' }
  | { type: 'auto_react'; color: string; tolerance?: number; region?: Region; minCount?: number; tapOffsetX?: number; tapOffsetY?: number; tapX?: number; tapY?: number; maxTriggers?: number; timeoutMs?: number; intervalMs?: number; cooldownMs?: number;
      /** v2.0: extra lanes (each its own colour/region/reaction); the top-level fields act as lane 0 */
      lanes?: ReactLane[]; /** v2.0: stop the loop when this colour is present (e.g. GAME OVER red banner) */ stopColor?: string; stopRegion?: Region; stopMinCount?: number }

export interface Point { x: number; y: number }
export interface SeqPoint extends Point { delayMs?: number; durationMs?: number }
export interface Region { x: number; y: number; w: number; h: number }
export interface Note { text: string; ts: number; /** package name of the app open when the note was saved */ app?: string }
/** v2.5 combo step (executed on the phone) */
export interface ComboStep { op: 'down' | 'move' | 'up' | 'tap' | 'wait' | 'joystick' | 'aim' | 'fire' | 'tap_found' | 'aim_found'; finger?: number; x?: number; y?: number; dx?: number; dy?: number; angle?: number; distance?: number; duration?: number; delayMs?: number; count?: number; intervalMs?: number; holdMs?: number; release?: boolean; lookX?: number; lookY?: number; sensitivity?: number; maxStep?: number }
/** One auto_react lane: colour trigger → tap or swipe. */
/** v4.1 react_script */
export interface ReactWhen { type: 'color_present' | 'color_absent' | 'pixel_is' | 'pixel_not' | 'text_present' | 'text_absent' | 'always'; color?: string; tolerance?: number; region?: Region; minCount?: number; x?: number; y?: number; text?: string; minSize?: number; maxSize?: number; forMs?: number }
export interface ReactRule { name?: string; when: ReactWhen[]; then: ComboStep[]; cooldownMs?: number; priority?: number; maxFires?: number; exclusive?: boolean }
export interface FrameColor { name?: string; color: string; tolerance?: number; region?: Region; minSize?: number; maxSize?: number; max?: number; match?: 'rgb' | 'hue' }
export interface FrameOcr { name?: string; region?: Region; number?: boolean }
export interface FrameSpec { maxWidth?: number; quality?: number; objects?: FrameColor[]; ocr?: FrameOcr[]; pixels?: { x: number; y: number }[]; diff?: boolean }
export interface ReactLane { color: string; tolerance?: number; region?: Region; minCount?: number; tapX?: number; tapY?: number; tapOffsetX?: number; tapOffsetY?: number; swipe?: { dx: number; dy: number; durationMs?: number }; cooldownMs?: number; name?: string }
/** Named screen fingerprint: 112-bit perceptual hash (hex) + a few OCR words, used by identify_screen. */
export interface ScreenLabel { name: string; hash: string; words: string[]; app?: string; ts: number }
/** v2.3 structured per-app knowledge: named controls, colours, regions and settings the AI can reference by name (@jump, @enemy...). */
/** v4.2 compact snapshot of the previous play frame (per app) used to compute deltas/events. */
export interface PlayState {
  ts: number
  /** per object name: nearest object centre + count */
  objects: Record<string, { count: number; cx?: number; cy?: number; area?: number; all?: { cx: number; cy: number; area?: number }[] }>
  /** per ocr name: last numeric value */
  values: Record<string, number>
  /** consecutive ticks with changedPct < 1 (screen frozen / menu) */
  staticTicks: number
  /** ticks since the frame was started */
  tick: number
}

/**
 * v4.7.3 Playbook = the AI's transferable EXPERTISE for one game (or '*' = cross-game skills), written by the AI itself.
 * Unlike a session_report (what happened once) this is the distilled how-to, kept current with every chat and injected
 * verbatim into the bootstrap of the next chat so a brand-new conversation plays at the same level from turn one.
 */
export interface Playbook {
  app: string
  /** one paragraph: what the game is, how to win, what matters */
  overview?: string
  /** ordered rules of thumb — the strategy ("clear rows before placing big pieces", "keep 2 columns free") */
  strategy: string[]
  /** exact step-by-step procedure for one move/turn/round with the tools to call */
  procedure: string[]
  /** things that worked (tricks, exact coords, timings) */
  tricks: string[]
  /** things that failed and must not be repeated */
  mistakes: string[]
  /** how to tell menu / game over / paused / reward screens and what to press */
  screens: string[]
  /** free-form facts (piece sizes, board geometry, scoring) */
  facts: string[]
  /** skill level 1-5 the AI believes it has reached in this game */
  skill?: number
  /**
   * v4.7.4 the COMPLETE decision algorithm / planner the AI used (code, pseudo-code or exact rules), verbatim, up to 24 KB.
   * Notes like "clear a row" are not enough to reproduce play quality — the next chat must be able to re-run the same planner
   * (e.g. the Python/JS block that scores candidate placements). Optional language tag + short description of inputs/outputs.
   */
  algorithm?: { lang?: string; description?: string; code: string; ts: number }
  /** v4.7.4 exact geometry / calibration the algorithm needs (screen size the numbers were measured on, offsets, cell sizes…) */
  calibration?: Record<string, string | number | boolean>
  ts: number
  updates: number
}

/** v4.4 one autopilot policy + how it performed (kept per game, max 5, sorted by fitness). */
export interface Strategy {
  name: string
  policy: unknown[]
  stopOn?: unknown
  runs: number
  ticks: number
  /** sum of positive score-like deltas observed while running */
  gained: number
  /** how many runs ended in game_over / a hp<threshold stop */
  deaths: number
  fitness: number
  ts: number
  note?: string
}

export interface GameProfile {
  app: string
  label?: string
  controls: Record<string, { x: number; y: number; note?: string; reactMs?: number }>
  colors: Record<string, { hex: string; tolerance?: number; note?: string }>
  regions: Record<string, { x: number; y: number; w: number; h: number; note?: string }>
  settings: Record<string, string | number | boolean>
  ts: number
  /** v2.5 game genre: shooter | runner | puzzle | rhythm | strategy | rpg | racing | casual | other — selects the playbook */
  genre?: string
  /** v4.4 learned autopilot policies (play_loop records how each ran; best = highest score gain per tick, then survival) */
  strategies?: Strategy[]
  /** v2.4 progress tracking filled by session_report */
  bestScore?: number
  lastReport?: SessionReport
  reports?: number
}
/** v2.4 end-of-session handover written by the AI for the next session. */
export interface SessionReport { ts: number; outcome?: 'win' | 'loss' | 'progress' | 'stuck' | 'other'; score?: number; level?: string; summary: string; learned?: string[]; nextTime?: string; blockers?: string[]; durationMs?: number }
/** v2.3 one play session (from first to last command within the same app, gaps < 10 min). */
export interface PlaySession { app: string; label?: string; start: number; end: number; commands: number; failed: number; screenshots: number; report?: SessionReport }
/** In-progress macro recording (record_macro). */
export interface Recording { name?: string; description?: string; keepWaits: boolean; startedAt: number; lastAt: number; steps: { name: string; arguments?: Record<string, unknown> }[] }
/** Named, replayable tool sequence stored per device. */
export interface Macro { name: string; steps: { name: string; arguments?: Record<string, unknown> }[]; description?: string; ts: number; runs?: number; /** package of the app open when saved (v2.2) */ app?: string }

/** Per-command timeout: long on-phone sequences need more than the default 15s. */
export function actionTimeoutMs(a: Action): number {
  const base = 15_000
  switch (a.type) {
    case 'tap_sequence': return base + a.points.reduce((t, p) => t + (p.delayMs ?? 0) + (p.durationMs ?? 60), 0)
    case 'repeat_tap': return base + a.count * (a.intervalMs + 60)
    case 'swipe_path': return base + (a.duration ?? 500)
    case 'long_press': return base + (a.duration ?? 800)
    case 'drag': return base + (a.duration ?? 600) + (a.holdMs ?? 500)
    case 'watch_color': case 'wait_pixel': return base + (a.timeoutMs ?? 5000)
    case 'read_text': return 25_000
    case 'auto_react': return base + (a.timeoutMs ?? 10_000)
    case 'track_object': return base + (a.samples ?? 5) * (a.intervalMs ?? 120)
    case 'joystick': return base + a.duration
    case 'fire_burst': return base + a.holdMs + a.count * a.intervalMs
    case 'combo': return base + a.combo.reduce((t, s) => t + (s.delayMs ?? 0) + (s.duration ?? 0) + (s.holdMs ?? 0) + (s.count ?? 0) * (s.intervalMs ?? 90), 0)
    // v4.1 on-device engines: react_script runs up to timeoutMs (≤ 60 s); play_frame may run several OCR passes
    case 'react_script': return base + (a.timeoutMs ?? 15_000)
    case 'play_frame': return base + ((a.frame?.ocr?.length ?? 0) * 1500)
    default: return base
  }
}

export const ACTION_TYPES = [
  'tap', 'long_press', 'swipe', 'back', 'home', 'recents',
  'notifications', 'lock', 'screenshot', 'ping', 'double_tap', 'quick_settings', 'wake',
  'ui_dump', 'tap_element', 'type_text', 'open_app', 'open_url', 'list_apps', 'current_app',
  'pinch', 'drag', 'set_clipboard', 'get_notifications', 'device_info', 'scroll_element',
  'tap_sequence', 'multi_tap', 'swipe_path', 'repeat_tap', 'pixel', 'find_color', 'screen_hash',
  'screen_diff', 'watch_color', 'find_image', 'wait_pixel',
  'read_text', 'find_colors', 'stream',
  'find_objects', 'auto_react', 'sample_colors', 'track_object', 'play_frame',
  'finger_down', 'finger_move', 'finger_up', 'joystick', 'aim', 'fire_burst', 'combo', 'react_script', 'play_frame',
] as const

/** Read-only actions may bypass the serialized input queue (safe to run concurrently). */
export const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  'screenshot', 'ping', 'ui_dump', 'list_apps', 'current_app', 'get_notifications', 'device_info',
  'pixel', 'find_color', 'screen_hash', 'screen_diff', 'watch_color', 'find_image', 'wait_pixel',
  'read_text', 'find_colors', 'stream', 'find_objects', 'sample_colors', 'track_object', 'play_frame',
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

/** Live preview frame pushed by the phone while streaming is enabled (monitor page only). */
export interface FrameMessage { kind: 'frame'; data: string; mime: string; ts: number }

export type PhoneMessage = ResultMessage | HelloMessage | FrameMessage | { kind: 'pong' }

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
