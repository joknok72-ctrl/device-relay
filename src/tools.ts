/**
 * Single source of truth for the AI tool catalogue.
 * Exposed as: OpenAI tools, Anthropic tools, OpenAPI 3.1, and MCP tools/list.
 */

export interface ToolDef {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description: string; minimum?: number; maximum?: number; default?: unknown; items?: unknown }>
    required: string[]
  }
}

const coord = (d: string) => ({ type: 'integer', description: d, minimum: 0 })

export const TOOLS: ToolDef[] = [
  {
    name: 'capture_screen',
    description:
      'Take a screenshot of the phone screen RIGHT NOW and return it as a PNG image (base64) plus the real screen size in pixels. ' +
      'Always call this first to see the current state, and after any action to verify the result. ' +
      'Coordinates you pass to tap/swipe must be in the ORIGINAL screen pixel space returned here (screen.w x screen.h), ' +
      'not the downscaled image size; use image.scale to convert (original = image_px / scale). ' +
      'Default output is a 540px-wide PNG; pass maxWidth up to 2160 for fine detail (games, small text) or format=jpeg + quality for smaller payloads.',
    parameters: {
      type: 'object',
      properties: {
        maxWidth: { type: 'integer', description: 'Max image width in px (120-2160, default 540)', minimum: 120, maximum: 2160, default: 540 },
        format: { type: 'string', description: 'png (default) | jpeg' },
        quality: { type: 'integer', description: 'JPEG/PNG quality 10-100 (default 80)', minimum: 10, maximum: 100, default: 80 },
      },
      required: [],
    },
  },
  {
    name: 'tap',
    description: 'Tap (single click) the phone screen at pixel coordinates (x, y). Origin is top-left.',
    parameters: {
      type: 'object',
      properties: { x: coord('Horizontal pixel position'), y: coord('Vertical pixel position') },
      required: ['x', 'y'],
    },
  },
  {
    name: 'long_press',
    description: 'Press and hold at (x, y) for duration milliseconds (default 800).',
    parameters: {
      type: 'object',
      properties: {
        x: coord('Horizontal pixel position'),
        y: coord('Vertical pixel position'),
        duration: { type: 'integer', description: 'Hold time in ms', minimum: 100, maximum: 10000, default: 800 },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'swipe',
    description:
      'Swipe/drag from (x1,y1) to (x2,y2) over duration ms (default 300). ' +
      'Use for scrolling (swipe up = scroll down), carousels, and drag gestures. Fast durations (100-200ms) act like flicks.',
    parameters: {
      type: 'object',
      properties: {
        x1: coord('Start X'), y1: coord('Start Y'), x2: coord('End X'), y2: coord('End Y'),
        duration: { type: 'integer', description: 'Gesture time in ms', minimum: 50, maximum: 10000, default: 300 },
      },
      required: ['x1', 'y1', 'x2', 'y2'],
    },
  },
  {
    name: 'get_ui_elements',
    description:
      'Read the current screen\'s UI tree via Android Accessibility (NO image). Returns the foreground app and a list of visible elements ' +
      'with text, contentDescription (desc), view id, class, center coordinates (cx, cy) in ORIGINAL screen pixels, and flags (clickable, editable, scrollable, checked). ' +
      'This is the most reliable way to find buttons, inputs and labels — much more precise than guessing from a screenshot. ' +
      'Use it before tap_element/type_text, and combine with capture_screen when visuals matter (games, images, canvas apps).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'tap_element',
    description:
      'Tap a UI element by its visible text / contentDescription (case-insensitive, partial match; exact matches win) or by view id. ' +
      'Uses the accessibility click action when possible, else taps the element center. Preferred over tap(x,y) for buttons, menu items, links, list rows.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Visible text or content description to match, e.g. "Sign in", "Settings"' },
        elementId: { type: 'string', description: 'View id (from get_ui_elements "id" field), e.g. "btn_login"' },
        index: { type: 'integer', description: 'If several elements match, which one (0-based, top to bottom)', minimum: 0, default: 0 },
      },
      required: [],
    },
  },
  {
    name: 'type_text',
    description:
      'Type text into the focused input field (tap the field first with tap/tap_element), or into the field with elementId. ' +
      'Replaces existing content unless clear=false. Set submit=true to press the keyboard action (Enter/Search/Go) afterwards. Supports any language/emoji.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
        elementId: { type: 'string', description: 'Optional view id of the target field' },
        clear: { type: 'boolean', description: 'Clear the field before typing (default true)', default: true },
        submit: { type: 'boolean', description: 'Press Enter/IME action after typing (default false)', default: false },
      },
      required: ['text'],
    },
  },
  {
    name: 'open_app',
    description: 'Launch an installed app by its name (e.g. "Chrome", "WhatsApp", "Settings") or package name (e.g. "com.android.chrome"). Partial names work.',
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'App name or package name' } }, required: ['text'] },
  },
  {
    name: 'open_url',
    description: 'Open a URL (or any deep link like tel:, mailto:, intent scheme) in the default handler / browser.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL to open' } }, required: ['url'] },
  },
  {
    name: 'list_apps',
    description: 'List all launchable installed apps (label + package). Use when unsure of an app name for open_app.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_current_app',
    description: 'Return the package and label of the app currently in the foreground.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'double_tap',
    description: 'Double-tap at (x, y) in original screen pixels (zoom, like, select word).',
    parameters: { type: 'object', properties: { x: coord('Horizontal pixel position'), y: coord('Vertical pixel position') }, required: ['x', 'y'] },
  },
  {
    name: 'scroll',
    description:
      'Convenience scroll gesture in a direction (down = see content further below, up, left, right) performed in the middle of the screen. ' +
      'amount is fraction of screen height/width to move (0.1-0.9, default 0.5).',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', description: 'down | up | left | right' },
        amount: { type: 'number', description: 'Fraction of screen to scroll (0.1-0.9)', minimum: 0.1, maximum: 0.9, default: 0.5 },
      },
      required: ['direction'],
    },
  },
  {
    name: 'wait_for_element',
    description: 'Poll the UI tree until an element whose text/desc/hint contains `text` (or id equals elementId) appears. Returns the element (with cx,cy) or times out. Use after opening apps or submitting forms.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to wait for (case-insensitive, partial)' },
        elementId: { type: 'string', description: 'Or a view id to wait for' },
        timeoutMs: { type: 'integer', description: 'Max wait (default 8000, max 30000)', minimum: 500, maximum: 30000, default: 8000 },
      },
      required: [],
    },
  },
  {
    name: 'find_and_tap',
    description: 'Scroll (down by default) up to maxScrolls times until an element matching text/elementId is visible, then tap it. Great for long settings pages, menus and lists.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to find (case-insensitive, partial)' },
        elementId: { type: 'string', description: 'Or a view id' },
        direction: { type: 'string', description: 'Scroll direction while searching: down (default) | up | left | right' },
        maxScrolls: { type: 'integer', description: 'Max scroll attempts (default 8)', minimum: 0, maximum: 30, default: 8 },
      },
      required: [],
    },
  },
  {
    name: 'drag',
    description: 'Drag-and-drop: long-press at (x1,y1) for holdMs, then move to (x2,y2) over duration ms and release. Use for rearranging icons, sliders, map panning, and games that need press-and-hold movement.',
    parameters: {
      type: 'object',
      properties: {
        x1: coord('Start X'), y1: coord('Start Y'), x2: coord('End X'), y2: coord('End Y'),
        holdMs: { type: 'integer', description: 'Hold before moving (default 500)', minimum: 0, maximum: 5000, default: 500 },
        duration: { type: 'integer', description: 'Move time in ms (default 600)', minimum: 50, maximum: 10000, default: 600 },
      },
      required: ['x1', 'y1', 'x2', 'y2'],
    },
  },
  {
    name: 'pinch',
    description: 'Two-finger pinch centered at (x,y). scale > 1 zooms IN (fingers spread), scale < 1 zooms OUT. Use on maps, photos, web pages.',
    parameters: {
      type: 'object',
      properties: {
        x: coord('Center X'), y: coord('Center Y'),
        scale: { type: 'number', description: 'Zoom factor, e.g. 2 = zoom in 2x, 0.5 = zoom out', minimum: 0.1, maximum: 10 },
        duration: { type: 'integer', description: 'Gesture time in ms (default 400)', minimum: 50, maximum: 5000, default: 400 },
      },
      required: ['x', 'y', 'scale'],
    },
  },
  {
    name: 'scroll_element',
    description: 'Scroll a specific scrollable container (found by text/desc or view id) using the accessibility scroll action — precise, no gesture guessing. direction forward = down/right, backward = up/left.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text/desc inside or on the scrollable element' },
        elementId: { type: 'string', description: 'View id of the scrollable element' },
        direction: { type: 'string', description: 'forward (default) | backward' },
      },
      required: [],
    },
  },
  {
    name: 'set_clipboard',
    description: 'Put text on the phone clipboard. With paste=true it also pastes into the focused field (useful for long text, passwords, or fields that reject type_text).',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to place on the clipboard' },
        paste: { type: 'boolean', description: 'Paste into the focused input after copying (default false)', default: false },
      },
      required: ['text'],
    },
  },
  {
    name: 'get_notifications',
    description: 'Read the currently visible status-bar notifications (app, title, text, time) WITHOUT opening the shade. Great for OTP codes, chat messages, and confirming background events. Requires "Notification access" enabled in the Device Relay app.',
    parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'Max notifications (default 20)', minimum: 1, maximum: 50, default: 20 } }, required: [] },
  },
  {
    name: 'get_device_info',
    description: 'Detailed live device info from the phone: battery %, charging, screen on/off, locked, orientation, wifi SSID/connection type, free storage, current app.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'batch',
    description:
      'Run several tools in ONE request, sequentially, and get all results back. Cuts round-trips dramatically (e.g. open_app → wait_for_element → tap_element → type_text → capture_screen). ' +
      'Each step is {name, arguments}. Stops at the first failure unless continueOnError=true. Max 25 steps.',
    parameters: {
      type: 'object',
      properties: {
        steps: { type: 'array', description: 'Array of {name: string, arguments: object}' },
        continueOnError: { type: 'boolean', description: 'Keep going after a failed step (default false)', default: false },
      },
      required: ['steps'],
    },
  },
  // ------------------------------------------------------------ v1.5 games / precision
  {
    name: 'act_and_see',
    description:
      'GAME LOOP PRIMITIVE. Perform ONE action, wait, then return a screenshot \u2014 all in a single round-trip. ' +
      'action is any input tool call {name, arguments} (tap, swipe, tap_sequence, swipe_path, ...). waitMs (default 400) lets the game render. ' +
      'Screenshot options: maxWidth, format, quality, grid (draw a labelled coordinate grid every N px \u2014 makes reading exact positions from the image trivial), region {x,y,w,h} (crop at full resolution).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'object', description: '{name: string, arguments: object} \u2014 the input tool to run' },
        waitMs: { type: 'integer', description: 'Delay before the screenshot (default 400)', minimum: 0, maximum: 10000, default: 400 },
        maxWidth: { type: 'integer', description: 'Screenshot width (default 540)', minimum: 120, maximum: 2160 },
        format: { type: 'string', description: 'png | jpeg' },
        quality: { type: 'integer', description: '10-100', minimum: 10, maximum: 100 },
        grid: { type: 'integer', description: 'Overlay a coordinate grid every N original px (e.g. 100). 0 = none', minimum: 0, maximum: 500 },
        region: { type: 'object', description: 'Crop {x,y,w,h} in original px' },
      },
      required: ['action'],
    },
  },
  {
    name: 'tap_sequence',
    description:
      'Precise on-device tap choreography: taps points in order with per-point delayMs (before the tap) and durationMs (hold). Executed entirely on the phone \u2014 zero network jitter between taps. ' +
      'Use for rhythm games, combos, fast menus, typing on custom keyboards. Max 50 points / 50s total.',
    parameters: {
      type: 'object',
      properties: { points: { type: 'array', description: '[{x, y, delayMs?, durationMs?}, ...]' } },
      required: ['points'],
    },
  },
  {
    name: 'multi_tap',
    description: 'Tap up to 10 points SIMULTANEOUSLY (true multi-touch) for duration ms. Use for two-button game controls, chords, hidden gestures.',
    parameters: {
      type: 'object',
      properties: { points: { type: 'array', description: '[{x,y}, ...]' }, duration: { type: 'integer', description: 'Hold time (default 60)', minimum: 20, maximum: 5000, default: 60 } },
      required: ['points'],
    },
  },
  {
    name: 'swipe_path',
    description: 'One continuous finger stroke through many points (curves, joystick moves, drawing, pattern unlock, slingshot aiming). duration is the total time. 2-50 points.',
    parameters: {
      type: 'object',
      properties: { points: { type: 'array', description: '[{x,y}, ...] in order' }, duration: { type: 'integer', description: 'Total ms (default 500)', minimum: 50, maximum: 30000, default: 500 } },
      required: ['points'],
    },
  },
  {
    name: 'repeat_tap',
    description: 'Tap the same point count times every intervalMs, on-device (auto-clicker for idle/clicker games, skipping dialogues, spamming attack). Max 100 taps / 50s.',
    parameters: {
      type: 'object',
      properties: {
        x: coord('X'), y: coord('Y'),
        count: { type: 'integer', description: 'Number of taps (default 5)', minimum: 1, maximum: 100, default: 5 },
        intervalMs: { type: 'integer', description: 'Gap between taps (default 100)', minimum: 30, maximum: 5000, default: 100 },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'get_pixels',
    description: 'Read exact RGB hex colours at up to 50 original-pixel points from a fresh frame. Cheap way to detect HP bars, cooldowns, button states, tile colours without a full screenshot.',
    parameters: { type: 'object', properties: { points: { type: 'array', description: '[{x,y}, ...]' } }, required: ['points'] },
  },
  {
    name: 'find_color',
    description: 'Locate where a colour appears on screen: returns bounding box, centre and match count for pixels within tolerance of color (#RRGGBB), optionally inside region {x,y,w,h}. Great for finding enemies, gems, buttons, markers in games.',
    parameters: {
      type: 'object',
      properties: {
        color: { type: 'string', description: '#RRGGBB' },
        tolerance: { type: 'integer', description: 'Per-channel tolerance 0-128 (default 24)', minimum: 0, maximum: 128, default: 24 },
        region: { type: 'object', description: 'Optional crop {x,y,w,h}' },
      },
      required: ['color'],
    },
  },
  {
    name: 'wait_for_screen',
    description:
      'Wait until the screen CHANGES (mode=change, e.g. after a tap that starts a level) or becomes STABLE (mode=stable, e.g. animation/loading finished), by comparing cheap frame hashes on the device. ' +
      'Much better than a fixed wait. Returns when the condition is met or timeoutMs elapses.',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: 'change (default) | stable' },
        timeoutMs: { type: 'integer', description: 'Max wait (default 5000)', minimum: 200, maximum: 30000, default: 5000 },
        intervalMs: { type: 'integer', description: 'Poll interval (default 250)', minimum: 100, maximum: 2000, default: 250 },
        stableFor: { type: 'integer', description: 'stable mode: ms the frame must stay identical (default 600)', minimum: 200, maximum: 5000, default: 600 },
      },
      required: [],
    },
  },
  {
    name: 'remember',
    description:
      'Save a persistent note about THIS device that future AI sessions will see in the bootstrap (e.g. "Clash: attack button at (980,2150); shop tab at (140,2250)", "Keyboard sends Enter via type_text submit"). ' +
      'Use it whenever you learn a layout, coordinate, or trick worth reusing. Max 40 notes, 2000 chars each.',
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'The note' } }, required: ['text'] },
  },
  {
    name: 'recall',
    description: 'List saved notes for this device (index, text, timestamp). Call at the start of a task to reuse earlier learnings. Pass forget=index (or forget=-1 for all) to delete.',
    parameters: { type: 'object', properties: { forget: { type: 'integer', description: 'Delete note at index; -1 deletes all' } }, required: [] },
  },
  { name: 'wake_screen', description: 'Wake the display if it is off (you may still need to swipe up / unlock).', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'open_quick_settings', description: 'Open the quick-settings panel (Wi-Fi, Bluetooth, flashlight toggles...).', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'press_back', description: 'Press the Android BACK button.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'press_home', description: 'Press the Android HOME button (go to launcher).', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'open_recents', description: 'Open the recent-apps switcher.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'open_notifications', description: 'Pull down the notification shade.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'lock_screen', description: 'Lock the phone screen.', parameters: { type: 'object', properties: {}, required: [] } },
  {
    name: 'wait',
    description: 'Pause for ms milliseconds (max 10000) to let animations/loading finish before the next screenshot.',
    parameters: {
      type: 'object',
      properties: { ms: { type: 'integer', description: 'Milliseconds to wait', minimum: 0, maximum: 10000 } },
      required: ['ms'],
    },
  },
  {
    name: 'get_device_status',
    description: 'Return device online status, model, Android version, screen size, and whether the accessibility service is enabled.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
]

/** Map AI tool name + args -> relay Action (or special) */
export function toolToAction(name: string, args: Record<string, unknown>): { action?: Record<string, unknown>; special?: 'wait' | 'status' | 'scroll' | 'wait_for' | 'find_tap' | 'batch' | 'act_and_see' | 'wait_for_screen' | 'remember' | 'recall'; error?: string } {
  switch (name) {
    case 'capture_screen': return { action: { type: 'screenshot', maxWidth: args.maxWidth, quality: args.quality, format: args.format, grid: args.grid, region: args.region } }
    case 'tap_sequence': return { action: { type: 'tap_sequence', points: args.points } }
    case 'multi_tap': return { action: { type: 'multi_tap', points: args.points, duration: args.duration ?? 60 } }
    case 'swipe_path': return { action: { type: 'swipe_path', points: args.points, duration: args.duration ?? 500 } }
    case 'repeat_tap': return { action: { type: 'repeat_tap', x: args.x, y: args.y, count: args.count ?? 5, intervalMs: args.intervalMs ?? 100 } }
    case 'get_pixels': return { action: { type: 'pixel', points: args.points } }
    case 'find_color': return { action: { type: 'find_color', color: args.color, tolerance: args.tolerance, region: args.region } }
    case 'act_and_see': return { special: 'act_and_see' }
    case 'wait_for_screen': return { special: 'wait_for_screen' }
    case 'remember': return { special: 'remember' }
    case 'recall': return { special: 'recall' }
    case 'tap': return { action: { type: 'tap', x: args.x, y: args.y } }
    case 'long_press': return { action: { type: 'long_press', x: args.x, y: args.y, duration: args.duration ?? 800 } }
    case 'swipe': return { action: { type: 'swipe', x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, duration: args.duration ?? 300 } }
    case 'press_back': return { action: { type: 'back' } }
    case 'press_home': return { action: { type: 'home' } }
    case 'open_recents': return { action: { type: 'recents' } }
    case 'open_notifications': return { action: { type: 'notifications' } }
    case 'lock_screen': return { action: { type: 'lock' } }
    case 'get_ui_elements': return { action: { type: 'ui_dump' } }
    case 'tap_element': return { action: { type: 'tap_element', text: args.text, elementId: args.elementId, index: args.index ?? 0 } }
    case 'type_text': return { action: { type: 'type_text', text: args.text, elementId: args.elementId, clear: args.clear !== false, submit: args.submit === true } }
    case 'open_app': return { action: { type: 'open_app', text: args.text } }
    case 'open_url': return { action: { type: 'open_url', url: args.url } }
    case 'list_apps': return { action: { type: 'list_apps' } }
    case 'get_current_app': return { action: { type: 'current_app' } }
    case 'double_tap': return { action: { type: 'double_tap', x: args.x, y: args.y } }
    case 'wake_screen': return { action: { type: 'wake' } }
    case 'open_quick_settings': return { action: { type: 'quick_settings' } }
    case 'drag': return { action: { type: 'drag', x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, duration: args.duration ?? 600, holdMs: args.holdMs ?? 500 } }
    case 'pinch': return { action: { type: 'pinch', x: args.x, y: args.y, scale: args.scale, duration: args.duration ?? 400 } }
    case 'scroll_element': return { action: { type: 'scroll_element', text: args.text, elementId: args.elementId, direction: args.direction ?? 'forward' } }
    case 'set_clipboard': return { action: { type: 'set_clipboard', text: args.text, paste: args.paste === true } }
    case 'get_notifications': return { action: { type: 'get_notifications', limit: args.limit ?? 20 } }
    case 'get_device_info': return { action: { type: 'device_info' } }
    case 'batch': return { special: 'batch' }
    case 'scroll': return { special: 'scroll' }
    case 'wait_for_element': return { special: 'wait_for' }
    case 'find_and_tap': return { special: 'find_tap' }
    case 'wait': return { special: 'wait' }
    case 'get_device_status': return { special: 'status' }
    default: return { error: `unknown tool: ${name}` }
  }
}

// ---------------------------------------------------------------- exporters

/** OpenAI Chat Completions `tools` array */
export function openaiTools() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

/** Anthropic Messages API `tools` array */
export function anthropicTools() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
}

/** Gemini function declarations */
export function geminiTools() {
  return [{ function_declarations: TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }]
}

/** OpenAPI 3.1 document (for GPT Actions / any OpenAPI-aware agent) */
export function openapiSpec(serverUrl: string) {
  const paths: Record<string, unknown> = {}
  for (const t of TOOLS) {
    paths[`/api/devices/{deviceId}/tools/${t.name}`] = {
      post: {
        operationId: t.name,
        summary: t.description.split('.')[0],
        description: t.description,
        parameters: [{ name: 'deviceId', in: 'path', required: true, schema: { type: 'string' }, description: 'Target phone id' }],
        requestBody: t.parameters.required.length || Object.keys(t.parameters.properties).length
          ? { required: t.parameters.required.length > 0, content: { 'application/json': { schema: t.parameters } } }
          : undefined,
        responses: {
          '200': {
            description: 'Tool result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    error: { type: 'string' },
                    durationMs: { type: 'integer' },
                    screen: { type: 'object', properties: { w: { type: 'integer' }, h: { type: 'integer' } } },
                    image: {
                      type: 'object',
                      description: 'Only for capture_screen',
                      properties: { mime: { type: 'string' }, base64: { type: 'string' }, w: { type: 'integer' }, h: { type: 'integer' }, scale: { type: 'number' } },
                    },
                  },
                },
              },
            },
          },
        },
        security: [{ bearerAuth: [] }],
      },
    }
  }
  paths['/api/devices'] = {
    get: {
      operationId: 'list_devices', summary: 'List all registered phones and their online status',
      responses: { '200': { description: 'Devices' } }, security: [{ bearerAuth: [] }],
    },
  }
  paths['/api/devices/{deviceId}/logs'] = {
    get: {
      operationId: 'get_logs', summary: 'Last 100 commands for the device with status and latency',
      parameters: [{ name: 'deviceId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Log entries' } }, security: [{ bearerAuth: [] }],
    },
  }
  paths['/api/devices/{deviceId}/screenshot.png'] = {
    get: {
      operationId: 'screenshot_png', summary: 'Capture the screen and return raw PNG bytes',
      parameters: [{ name: 'deviceId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'PNG image', content: { 'image/png': {} } } }, security: [{ bearerAuth: [] }],
    },
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Device Relay — Android Automation Tools',
      version: '1.4.0',
      description:
        'Control a real Android phone through an AI agent. Workflow: capture_screen → reason → tap/swipe → capture_screen to verify. For games use act_and_see (action+screenshot in one call), grid screenshots, tap_sequence/swipe_path for precise timing, find_color/get_pixels for cheap detection, and remember/recall to persist layouts. ' +
        'All coordinates are in original screen pixels.',
    },
    servers: [{ url: serverUrl }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearerAuth: [] }],
    paths,
  }
}

/** Tools that only observe (allowed for read-only tokens). */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'capture_screen', 'get_ui_elements', 'get_current_app', 'list_apps', 'get_device_status', 'get_notifications', 'get_device_info', 'wait', 'wait_for_element',
  'get_pixels', 'find_color', 'wait_for_screen', 'recall',
])
