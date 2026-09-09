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
  // v1.9
  // v2.5 multi-touch
  | { type: 'finger_down'; finger: number; x: number; y: number; duration?: number }
  | { type: 'finger_move'; finger: number; x?: number; y?: number; points?: Point[]; duration?: number }
  | { type: 'finger_up'; finger: number }
  | { type: 'joystick'; x: number; y: number; angle: number; distance: number; duration: number; finger: number; release: boolean }
  | { type: 'aim'; x: number; y: number; dx: number; dy: number; duration: number; finger: number; steps: number; release: boolean }
  | { type: 'fire_burst'; x: number; y: number; count: number; intervalMs: number; holdMs: number }
  | { type: 'combo'; combo: ComboStep[] }
  // v2.6 bots (definitions are pushed to the phone; the phone runs them locally and exposes them in its notification)
  | { type: 'bot_sync'; bots: Bot[] }
  | { type: 'bot_start'; botId: string }
  | { type: 'bot_stop' }
  | { type: 'bot_status' }
  // v3.3 native aim engine (AimEngine.kt)
  | { type: 'aim_config'; aim: AimConfig }
  | { type: 'aim_start' }
  | { type: 'aim_stop' }
  | { type: 'aim_status' }
  | { type: 'aim_clear' }
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
export interface ComboStep { op: 'down' | 'move' | 'up' | 'tap' | 'wait' | 'joystick' | 'aim' | 'fire'; finger?: number; x?: number; y?: number; dx?: number; dy?: number; angle?: number; distance?: number; duration?: number; delayMs?: number; count?: number; intervalMs?: number; holdMs?: number; release?: boolean }
/** One auto_react lane: colour trigger → tap or swipe. */
export interface ReactLane { color: string; tolerance?: number; region?: Region; minCount?: number; tapX?: number; tapY?: number; tapOffsetX?: number; tapOffsetY?: number; swipe?: { dx: number; dy: number; durationMs?: number }; cooldownMs?: number; name?: string }
/** Named screen fingerprint: 112-bit perceptual hash (hex) + a few OCR words, used by identify_screen. */
export interface ScreenLabel { name: string; hash: string; words: string[]; app?: string; ts: number }
/** v2.3 structured per-app knowledge: named controls, colours, regions and settings the AI can reference by name (@jump, @enemy...). */
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
  /** v2.4 progress tracking filled by session_report */
  bestScore?: number
  lastReport?: SessionReport
  reports?: number
}
/** v2.4 end-of-session handover written by the AI for the next session. */
export interface SessionReport { ts: number; outcome?: 'win' | 'loss' | 'progress' | 'stuck' | 'other'; score?: number; level?: string; summary: string; learned?: string[]; nextTime?: string; blockers?: string[]; durationMs?: number }
/** v2.3 one play session (from first to last command within the same app, gaps < 10 min). */
export interface PlaySession { app: string; label?: string; start: number; end: number; commands: number; failed: number; screenshots: number; report?: SessionReport }
// ---------------------------------------------------------------- v2.6 game bots (run entirely on the phone)
/** A condition evaluated on the phone against the current frame. */
/** v2.7: every condition may carry forMs — it only counts as true once it has held continuously for that long. */
export type BotCondition = ({ forMs?: number; /** v3.1 colour match mode: rgb (per-channel tolerance) | hue (hue distance in degrees, ignores shading — best for 3D objects) */ match?: 'rgb' | 'hue' }) & (
  | { type: 'color_present'; color?: string; colors?: string[]; tolerance?: number; region?: Region; minCount?: number }
  | { type: 'color_absent'; color?: string; colors?: string[]; tolerance?: number; region?: Region; minCount?: number }
  /** v2.7 blob detection: an object of this colour (any of colors) between minSize..maxSize px; pick which one becomes `found` */
  | { type: 'object_present'; color?: string; colors?: string[]; tolerance?: number; region?: Region; minSize?: number; maxSize?: number; pick?: 'largest' | 'nearest' | 'topmost' | 'lowest'; nearX?: number; nearY?: number; minCount?: number; /** v3.1 keep following the object picked last tick if it is still within this many px (default 220, 0 = off) */ lockRadius?: number }
  | { type: 'object_absent'; color?: string; colors?: string[]; tolerance?: number; region?: Region; minSize?: number; maxSize?: number }
  | { type: 'pixel_is'; x: number; y: number; color: string; tolerance?: number }
  | { type: 'pixel_not'; x: number; y: number; color: string; tolerance?: number }
  | { type: 'text_present'; text: string; region?: Region }
  | { type: 'text_absent'; text: string; region?: Region }
  | { type: 'number_below'; region: Region; value: number }
  | { type: 'number_above'; region: Region; value: number }
  | { type: 'screen_changed'; minPct?: number }
  | { type: 'every_ms'; ms: number }
  | { type: 'always' })
/** An action the bot performs on the phone (a subset of Action, plus tap_found which taps the matched colour blob). */
export type BotAction =
  | { type: 'tap'; x: number; y: number }
  | { type: 'tap_found'; offsetX?: number; offsetY?: number }
  /** v2.7 tap every detected object (object_present), up to max, intervalMs apart */
  | { type: 'tap_all_found'; max?: number; intervalMs?: number; offsetX?: number; offsetY?: number }
  /** v2.7 aimbot: drag the look area so the crosshair moves onto the found object. drag = offset * sensitivity, clamped to maxStep */
  | { type: 'aim_to_found'; x: number; y: number; crosshairX?: number; crosshairY?: number; sensitivity?: number; maxStep?: number; deadzone?: number; duration?: number; finger?: number; offsetX?: number; offsetY?: number; /** v2.8 adapt sensitivity from overshoot/undershoot (default true) */ autoTune?: boolean; /** v3.0 lead the target: aim at where it will be predictMs from now (velocity from the last frames, default 0 = off) */ predictMs?: number; /** v3.0 only aim when the target is within this many px of the crosshair (0 = always) — assist mode keeps corrections tiny */ maxRange?: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; duration?: number }
  | { type: 'long_press'; x: number; y: number; duration?: number }
  | { type: 'tap_sequence'; points: SeqPoint[] }
  | { type: 'repeat_tap'; x: number; y: number; count: number; intervalMs: number }
  | { type: 'joystick'; x: number; y: number; angle: number; distance: number; duration: number; finger: number; release: boolean }
  | { type: 'aim'; x: number; y: number; dx: number; dy: number; duration: number; finger: number; steps: number; release: boolean; /** v2.7 flip dx/dy sign every time this action runs (camera sweep) */ alternate?: boolean }
  | { type: 'fire_burst'; x: number; y: number; count: number; intervalMs: number; holdMs: number; /** v3.0 only fire when the found target is within this many px of the crosshair (needs a *_present condition) */ maxRange?: number; crosshairX?: number; crosshairY?: number; /** v3.1 skip the burst when the preceding aim correction was larger than this (px) — the crosshair is still moving */ gateErr?: number }
  | { type: 'combo'; combo: ComboStep[] }
  | { type: 'finger_up'; finger: number }
  | { type: 'back' } | { type: 'home' }
  | { type: 'wait'; ms: number }
  | { type: 'stop_bot'; reason?: string }
export interface BotRule {
  name: string
  /** all conditions must hold (AND). Use several rules for OR. */
  when: BotCondition[]
  then: BotAction[]
  /** ms to wait after firing before this rule may fire again (default 300) */
  cooldownMs?: number
  /** higher runs first when several rules match in one tick (default 0) */
  priority?: number
  /** stop evaluating lower-priority rules this tick when this fires (default true) */
  exclusive?: boolean
  /** disable a rule without deleting it */
  enabled?: boolean
  /** v2.7 fire at most this many times per run (e.g. 1 for "tap PLAY once") */
  maxFires?: number
}
export interface Bot {
  id: string
  app: string
  label?: string
  name: string
  description?: string
  rules: BotRule[]
  /** frame poll interval ms (default 120) */
  tickMs?: number
  /** auto-stop after this many ms (default 30 min, max 6 h) */
  maxRunMs?: number
  /** stop when the foreground app is not `app` (default true) */
  stopOnAppChange?: boolean
  createdAt: number
  updatedAt: number
  runs?: number
  lastRun?: { start: number; end?: number; ticks: number; fired: number; stoppedBy?: string; ruleHits?: Record<string, number> }
  /** v2.7 template this bot was generated from (shooter/runner/…) */
  template?: string
  /** v2.8 start automatically ~2 s after this bot's app comes to the foreground (once per app session) */
  autoStart?: boolean
  /** v2.8 learned parameters reported by the phone (e.g. aim_to_found sensitivity per action key) */
  learned?: Record<string, number>
  /** v3.2 write the learned aim sensitivity back into the rules after each run (default true) */
  autoApplyLearned?: boolean
  /** v3.2 how many times the rules were auto-tuned */
  tuned?: number
  /** v3.0 assist mode: the USER plays (moves, turns the camera); the bot only injects micro-actions (≤60 ms aim nudges + fire taps) when its trigger colour appears. No movement/sweep rules. */
  assist?: boolean
}
/** Live bot status reported by the phone */
export interface BotStatusMessage { kind: 'bot_status'; botId?: string; name?: string; running: boolean; ticks?: number; fired?: number; lastRule?: string; startedAt?: number; stoppedBy?: string; error?: string; ts: number; /** v2.7 */ ruleHits?: Record<string, number>; avgTickMs?: number; /** v2.8 self-tuned params (aim gain per action) */ learned?: Record<string, number>; /** v2.8 how the run was started: notification|overlay|volume|auto|relay */ startedBy?: string }
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
  'find_objects', 'auto_react', 'sample_colors', 'track_object',
  'finger_down', 'finger_move', 'finger_up', 'joystick', 'aim', 'fire_burst', 'combo',
  'bot_sync', 'bot_start', 'bot_stop', 'bot_status',
  'aim_config', 'aim_start', 'aim_stop', 'aim_status', 'aim_clear',
] as const

/** Read-only actions may bypass the serialized input queue (safe to run concurrently). */
export const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  'screenshot', 'ping', 'ui_dump', 'list_apps', 'current_app', 'get_notifications', 'device_info',
  'pixel', 'find_color', 'screen_hash', 'screen_diff', 'watch_color', 'find_image', 'wait_pixel',
  'read_text', 'find_colors', 'stream', 'find_objects', 'sample_colors', 'track_object', 'bot_status', 'aim_status',
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

/** v3.3 native aim engine config (mirrors AimEngine.Config on the phone; all fields optional → phone defaults) */
export interface AimBox { x: number; y: number; w: number; h: number }
export interface AimConfig {
  app: string; name?: string
  fireX?: number; fireY?: number
  trigger?: 'reticle' | 'target' | 'both'
  reticleColor?: string; reticleTol?: number; reticleMin?: number; reticleBox?: AimBox
  targetColor?: string; targetTol?: number; targetMin?: number; targetBox?: AimBox
  armFrames?: number; releaseFrames?: number; maxHoldMs?: number
  aimEnabled?: boolean; aimColor?: string; aimTol?: number; aimMinSize?: number; aimMaxSize?: number; aimBox?: AimBox
  crosshairX?: number; crosshairY?: number; lookX?: number; lookY?: number
  aimGain?: number; aimMaxStep?: number; aimDeadzone?: number; aimRange?: number; aimOffsetY?: number
  reloadEnabled?: boolean; reloadColor?: string; reloadTol?: number; reloadMin?: number; reloadBox?: AimBox; reloadX?: number; reloadY?: number
  fps?: number; autoStart?: boolean; stopOnAppChange?: boolean
  /** v3.4 HeadLock (user fires, engine locks the crosshair on the head via the Shizuku touch proxy) */
  mode?: 'auto' | 'headlock'; fireRadius?: number
  headColor?: string; headTol?: number; headMinSize?: number; headMaxSize?: number; headBox?: AimBox; excludeBox?: AimBox
  headTopOffset?: number; headTopRows?: number; bodyColor?: string; bodyTol?: number
  bodyFirst?: boolean; bodyMaxLum?: number; bodyMinW?: number; bodyMaxW?: number; bodyMinH?: number; bodyMaxH?: number; headSearchUp?: number; skinMinR?: number; skinMinRB?: number; skinMinRG?: number; skinMinG?: number
  lockRange?: number; headGain?: number; headMaxStep?: number; headDeadzone?: number; headLead?: number; lookTravel?: number; stickyMs?: number
  /** relay-side bookkeeping */
  updatedAt?: number
}
export interface AimStatusMessage { kind: 'aim_status'; running: boolean; name?: string; app?: string; startedAt?: number; frames?: number; fps?: number; holding?: boolean; holdCount?: number; heldMs?: number; aimMoves?: number; reloads?: number; lastTrigger?: string; stoppedBy?: string; error?: string; startedBy?: string; ts: number; mode?: string; firing?: boolean; locked?: boolean; lockErrPx?: number; nudges?: number; locks?: number; shizuku?: string; headX?: number; headY?: number }

export type PhoneMessage = ResultMessage | HelloMessage | FrameMessage | BotStatusMessage | AimStatusMessage | { kind: 'pong' }

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
