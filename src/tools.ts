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
    description: 'Tap (single click) the phone screen at pixel coordinates (x, y). Origin is top-left. You may pass at:"@name" (a control saved in game_profile) instead of x/y.',
    parameters: {
      type: 'object',
      properties: { x: coord('Horizontal pixel position'), y: coord('Vertical pixel position'), at: { type: 'string', description: '"@control" from game_profile instead of x/y (e.g. "@jump", "@jump+20,-10")' } },
      required: [],
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
        steps: { type: 'array', description: 'Array of {name: string, arguments: object}', items: { type: 'object' } },
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
      properties: { points: { type: 'array', description: '[{x, y, delayMs?, durationMs?}, ...]', items: { type: 'object' } } },
      required: ['points'],
    },
  },
  {
    name: 'multi_tap',
    description: 'Tap up to 10 points SIMULTANEOUSLY (true multi-touch) for duration ms. Use for two-button game controls, chords, hidden gestures.',
    parameters: {
      type: 'object',
      properties: { points: { type: 'array', description: '[{x,y}, ...]', items: { type: 'object' } }, duration: { type: 'integer', description: 'Hold time (default 60)', minimum: 20, maximum: 5000, default: 60 } },
      required: ['points'],
    },
  },
  {
    name: 'swipe_path',
    description: 'One continuous finger stroke through many points (curves, joystick moves, drawing, pattern unlock, slingshot aiming). duration is the total time. 2-50 points.',
    parameters: {
      type: 'object',
      properties: { points: { type: 'array', description: '[{x,y}, ...] in order', items: { type: 'object' } }, duration: { type: 'integer', description: 'Total ms (default 500)', minimum: 50, maximum: 30000, default: 500 } },
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
    parameters: { type: 'object', properties: { points: { type: 'array', description: '[{x,y}, ...]', items: { type: 'object' } } }, required: ['points'] },
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
  // ------------------------------------------------------------ v1.6 smarter perception + reflexes
  {
    name: 'screen_diff',
    description:
      'What CHANGED since the last screen_diff/act call? Compares the current frame with the previous one on-device and returns the changed regions (bounding boxes in original px, % of screen changed). ' +
      'Use after an action to see exactly where the game reacted (enemy spawned, popup appeared) without downloading a full image. First call just stores a baseline.',
    parameters: {
      type: 'object',
      properties: {
        threshold: { type: 'integer', description: 'Per-pixel grey difference to count as changed (4-128, default 32)', minimum: 4, maximum: 128, default: 32 },
        cell: { type: 'integer', description: 'Grid cell size in px for change map (20-400, default 60)', minimum: 20, maximum: 400, default: 60 },
      },
      required: [],
    },
  },
  {
    name: 'watch_color',
    description:
      'REFLEX: block on the phone until a colour APPEARS (appear=true) or DISAPPEARS (appear=false) in region, polling every intervalMs (default 150) up to timeoutMs (default 5000). Returns where it was found (cx,cy,bounds,count) and how long it took. ' +
      'Perfect for "wait for the green GO button", "wait until the red enemy shows up in the lane", "wait until the loading bar is gone". Far faster and cheaper than screenshot polling.',
    parameters: {
      type: 'object',
      properties: {
        color: { type: 'string', description: '#RRGGBB' },
        tolerance: { type: 'integer', description: '0-128 (default 24)', minimum: 0, maximum: 128, default: 24 },
        region: { type: 'object', description: '{x,y,w,h} to watch (default whole screen)' },
        appear: { type: 'boolean', description: 'true = wait for it to appear (default), false = wait for it to vanish', default: true },
        minCount: { type: 'integer', description: 'Min matching pixels to count as present (default 20)', minimum: 1, default: 20 },
        timeoutMs: { type: 'integer', description: 'Max wait (default 5000, max 30000)', minimum: 200, maximum: 30000, default: 5000 },
        intervalMs: { type: 'integer', description: 'Poll interval (default 150)', minimum: 50, maximum: 2000, default: 150 },
      },
      required: ['color'],
    },
  },
  {
    name: 'wait_pixel',
    description: 'REFLEX for a single pixel: wait until the pixel at (x,y) matches color (appear=true) or stops matching (appear=false). Ideal for cooldown indicators, a specific button turning active, a lane becoming clear.',
    parameters: {
      type: 'object',
      properties: {
        x: coord('X'), y: coord('Y'), color: { type: 'string', description: '#RRGGBB' },
        tolerance: { type: 'integer', description: '0-128 (default 24)', minimum: 0, maximum: 128, default: 24 },
        appear: { type: 'boolean', description: 'default true', default: true },
        timeoutMs: { type: 'integer', description: 'default 5000', minimum: 200, maximum: 30000, default: 5000 },
        intervalMs: { type: 'integer', description: 'default 100', minimum: 50, maximum: 2000, default: 100 },
      },
      required: ['x', 'y', 'color'],
    },
  },
  {
    name: 'tap_color',
    description: 'Find a colour (like find_color) and immediately tap its centre in ONE round-trip. Optional offsetX/offsetY shift the tap. Returns whether it was found and where it tapped. Great for "tap the green button", "collect the yellow coin".',
    parameters: {
      type: 'object',
      properties: {
        color: { type: 'string', description: '#RRGGBB' },
        tolerance: { type: 'integer', description: '0-128 (default 24)', minimum: 0, maximum: 128, default: 24 },
        region: { type: 'object', description: 'Optional {x,y,w,h}' },
        minCount: { type: 'integer', description: 'Min matching pixels required (default 20)', minimum: 1, default: 20 },
        offsetX: { type: 'integer', description: 'Shift tap horizontally (default 0)', default: 0 },
        offsetY: { type: 'integer', description: 'Shift tap vertically (default 0)', default: 0 },
      },
      required: ['color'],
    },
  },
  {
    name: 'find_image',
    description:
      'Template matching on-device: locate a small reference image (base64 PNG/JPEG you captured earlier with capture_screen region=..., <=300KB) inside the current screen. Returns matches with score, centre and bounds. ' +
      'Use for icons/buttons/sprites that colour alone cannot identify. Crop the template tightly and at original resolution for best results. threshold 0.5-1 (default 0.85).',
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'base64 template image' },
        threshold: { type: 'number', description: 'Min similarity 0.5-1 (default 0.85)', minimum: 0.5, maximum: 1, default: 0.85 },
        region: { type: 'object', description: 'Search area {x,y,w,h} (default whole screen)' },
        maxResults: { type: 'integer', description: 'default 5', minimum: 1, maximum: 20, default: 5 },
      },
      required: ['image'],
    },
  },
  {
    name: 'game_loop',
    description:
      'Run a tight perception\u2192action loop ON THE SERVER for up to iterations rounds (max 60) or maxMs (max 55000): each round evaluates `when` (a find_color/get_pixels/wait_pixel/watch_color/screen_diff observation), and if it matches runs `then` (any input tool), else optionally `else`. ' +
      'Stops when stopWhen (another observation) matches, or on the first failure. Returns a compact per-round trace. Use for: "while the red enemy is visible, tap it", "collect coins until the timer pixel turns grey". ' +
      'Rule of thumb: prefer game_loop over issuing 20 separate calls.',
    parameters: {
      type: 'object',
      properties: {
        when: { type: 'object', description: '{name, arguments} observation; matches when result.found===true / pixel colour matches / changedPct>=minChange' },
        then: { type: 'object', description: '{name, arguments} input tool to run when `when` matches. Use "$cx"/"$cy" strings in arguments to inject the found centre.' },
        else: { type: 'object', description: 'Optional {name, arguments} to run when `when` does not match' },
        stopWhen: { type: 'object', description: 'Optional observation; loop ends when it matches' },
        iterations: { type: 'integer', description: 'Max rounds (default 20, max 60)', minimum: 1, maximum: 60, default: 20 },
        intervalMs: { type: 'integer', description: 'Pause between rounds (default 200)', minimum: 0, maximum: 5000, default: 200 },
        maxMs: { type: 'integer', description: 'Hard time budget (default 30000, max 55000)', minimum: 1000, maximum: 55000, default: 30000 },
        minChange: { type: 'number', description: 'For screen_diff observations: changedPct needed to count as a match (default 2)', default: 2 },
      },
      required: ['when', 'then'],
    },
  },
  {
    name: 'save_macro',
    description: 'Save a named, replayable sequence of tool calls for THIS device (e.g. "open_game_and_skip_intro", "collect_daily_reward"). Steps are {name, arguments}. Overwrites an existing macro with the same name. Future sessions see macro names in the bootstrap.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'kebab-case name' },
        steps: { type: 'array', description: '[{name, arguments}, ...] max 25', items: { type: 'object' } },
        description: { type: 'string', description: 'What it does (shown in bootstrap)' },
      },
      required: ['name', 'steps'],
    },
  },
  {
    name: 'run_macro',
    description: 'Replay a saved macro by name (runs like batch: stops at first failure unless continueOnError). Returns per-step results.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Macro name' }, continueOnError: { type: 'boolean', description: 'Keep going after a failed step (default false)', default: false } },
      required: ['name'],
    },
  },
  {
    name: 'list_macros',
    description: 'List saved macros for this device (name, description, steps count, runs). Pass delete=name to remove one.',
    parameters: { type: 'object', properties: { delete: { type: 'string', description: 'Macro name to delete' } }, required: [] },
  },
  // ------------------------------------------------------------ v1.7 OCR + multi-colour + self-awareness
  {
    name: 'read_text',
    description:
      'OCR: read all visible text from the screen (or a region) using on-device ML Kit \u2014 works in GAMES and canvas apps where get_ui_elements returns nothing. ' +
      'Returns blocks/lines with text, confidence-ish size, and centre (cx,cy) + bounds in original px. Use for scores, timers, dialogue, level names, currency counters, menu labels. lang: latin (default) | ar | zh | ja | ko | hi.',
    parameters: {
      type: 'object',
      properties: { region: { type: 'object', description: 'Optional {x,y,w,h}' }, lang: { type: 'string', description: 'Script hint (default latin)' } },
      required: [],
    },
  },
  {
    name: 'tap_text',
    description: 'OCR + tap: find on-screen text (case-insensitive, partial match; exact wins) via read_text and tap its centre. The game-world equivalent of tap_element. Returns the matched line and where it tapped.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to find, e.g. "PLAY", "Continue", "x2"' },
        region: { type: 'object', description: 'Optional search area {x,y,w,h}' },
        index: { type: 'integer', description: 'If several match, which one (0-based)', minimum: 0, default: 0 },
      },
      required: ['text'],
    },
  },
  {
    name: 'wait_for_text',
    description: 'Poll OCR until text appears (or disappears with appear=false). Use for "wait until LEVEL COMPLETE shows", "wait until Loading vanishes". Returns the matched line with cx,cy.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to wait for (case-insensitive, partial)' },
        region: { type: 'object', description: 'Optional {x,y,w,h} (smaller = faster)' },
        appear: { type: 'boolean', description: 'true (default) wait to appear; false wait to vanish', default: true },
        timeoutMs: { type: 'integer', description: 'default 8000, max 30000', minimum: 500, maximum: 30000, default: 8000 },
        intervalMs: { type: 'integer', description: 'default 700 (OCR is ~200-500ms)', minimum: 300, maximum: 3000, default: 700 },
      },
      required: ['text'],
    },
  },
  {
    name: 'find_colors',
    description: 'Scan for up to 8 colours in ONE frame (enemies + gems + HP bar at once). Returns per-colour {found,count,cx,cy,bounds}. Cheaper than several find_color calls.',
    parameters: {
      type: 'object',
      properties: {
        colors: { type: 'array', description: '["#rrggbb", ...] up to 8', items: { type: 'string' } },
        tolerance: { type: 'integer', description: '0-128 (default 24)', minimum: 0, maximum: 128, default: 24 },
        region: { type: 'object', description: 'Optional {x,y,w,h}' },
      },
      required: ['colors'],
    },
  },
  {
    name: 'session_stats',
    description: 'Self-check: success rate, latency p50/p90, per-action breakdown and the last failures for this device (last 100 commands). Call it when things feel slow/flaky to adapt (e.g. switch from tap to tap_sequence, add wait_for_screen, lower screenshot size).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'live_preview',
    description: 'Turn the human live preview stream on/off (the phone pushes small JPEG frames at fps to the /monitor page). Does NOT affect your tools. Auto-stops when nobody is watching. Use when the user says they want to watch.',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true to start, false to stop' },
        fps: { type: 'number', description: '0.2-4 (default 2)', minimum: 0.2, maximum: 4, default: 2 },
        maxWidth: { type: 'integer', description: '120-720 (default 360)', minimum: 120, maximum: 720, default: 360 },
      },
      required: ['enabled'],
    },
  },
  // ---------------------------------------------------------------- v4.1 live play: the AI is the player
  {
    name: 'play',
    description:
      'THE game-play primitive (v4.1): one round trip = ACT + WAIT + SEE. Runs an optional action (combo steps: joystick/aim/fire/tap/down/move/up/wait — or a single tool call), waits `waitMs` (default 250), then returns a play_frame: JPEG (maxWidth default 640) + blobs of the colours you name (objects) + OCR/numbers of regions + exact pixels + changedPct. ' +
      'Profile-aware: with a game_profile, `objects` defaults to every @colour of the profile and `ocr` to every numeric @region (score/hp/ammo), so play {} alone = full situational awareness. All coordinates/colours/regions accept @names. ' +
      'Use it as your heartbeat: play {act:[...]} → decide → play {act:[...]} … Typical shooter tick: play {act:[{op:"joystick",at:"@stick",direction:"up",duration:600,release:false},{op:"aim",at:"@look",dx:40}], objects:[{name:"enemy",color:"@enemy"}]}. Never call capture_screen + find_objects + read_text separately.',
    parameters: {
      type: 'object',
      properties: {
        act: { type: 'array', description: 'combo steps to run first (same schema as combo.steps; ops: down|move|up|tap|wait|joystick|aim|fire). Empty/omitted = just look.', items: { type: 'object' } },
        tool: { type: 'object', description: 'Alternative to act: any single tool {name, arguments} (e.g. tap_element, press_back, run_macro).' },
        waitMs: { type: 'integer', description: 'ms to wait after acting before the frame (default 250)', minimum: 0, maximum: 5000 },
        maxWidth: { type: 'integer', description: 'frame image width (default 640; 0 = no image, data only)', minimum: 0, maximum: 2160 },
        quality: { type: 'integer', description: 'JPEG quality (default 60)', minimum: 10, maximum: 100 },
        objects: { type: 'array', description: 'colours to locate: [{name, color(#hex or @name), tolerance, region, minSize, maxSize, max, match:rgb|hue}]. Default: all profile colours.', items: { type: 'object' } },
        ocr: { type: 'array', description: 'regions to read: [{name, region(@name or {x,y,w,h}), number:true}]. Default: numeric profile regions (score/hp/ammo/coins/time…).', items: { type: 'object' } },
        pixels: { type: 'array', description: 'points to sample exact colours [{x,y}] (or @control names)', items: { type: 'object' } },
        diff: { type: 'boolean', description: 'include changedPct vs the previous play frame (default true)' },
        reset: { type: 'boolean', description: 'forget the previous tick (no deltas/events this time) — use at the start of a new round' },
        autoRead: { type: 'boolean', description: 'when the screen has been static for 3 ticks, OCR the whole screen and classify it (menu/game_over/paused) into `stuck` (default true)' },
        autoMenu: { type: 'boolean', description: 'v4.3: when stuck on a menu/game_over/paused screen, tap the obvious button (PLAY/CONTINUE/RETRY/CLAIM/×) automatically (default false; play_loop defaults true)' },
      },
      required: [],
    },
  },
  {
    name: 'play_loop',
    description:
      'AUTOPILOT (v4.3, learning v4.4): give the relay a POLICY (or strategy:"best" to replay the top learned one) and it plays up to 40 ticks (~0.3-0.6 s each, max 25 s) by itself using the full play() perception (objects, deltas, threats, values, stuck) — one action per tick, first matching rule wins (order = priority). ' +
      'policy:[{name, if:{threat:"@enemy"|true, present:"@coin", absent:"@enemy", stuck:"menu|game_over|any", valueBelow:{name:"hp",value:30}, valueAbove:{...}, everyTicks:3, ui:"end turn" (v4.7 clickable UI node), text:["your turn","continue"] (v4.7 OCR; "@text" token = the matched text)}, do:[combo steps — tokens: x:"@found.x", y:"@found.y-40" (nearest matched object), "@threat.x/y" (most urgent threat), "@away.x" (side opposite the threat = dodge), "@center.x/y"] | tool:{name,arguments}, cooldownTicks, waitMs}]. valueBelow/valueAbove also work on bar gauges (profile region + same-named colour → fill %). ' +
      'stopOn:{stuck:"game_over"|"any", event:"hp dropping", valueBelow:{name,value}, valueAbove:{...}}; autoMenu (default true) taps PLAY/CONTINUE/RETRY/× when a menu blocks the game. Returns per-tick log (rule fired, summary, judge), fires per rule, stoppedBy, last frame. ' +
      'v4.6 SELF-CRITIQUE: each rule is judged by the tick after it fires (score gained / threat cleared = good; hp lost / game over = bad) → `rules` {fires,good,bad,score} + `advice` (which rule to fix). A rule that keeps hurting is auto-skipped. A rule may use reflex:{rules:[...react_script rules], timeoutMs} instead of do → hands that phase to the on-device 50 ms engine (hybrid). explore:true rotates priorities when stuck without gain. An automatic session_report is written after each run. ' +
      'Examples — clicker: [{if:{present:"@coin"},do:[{op:"tap",x:"@found.x",y:"@found.y"}]}]. Runner: [{name:"dodge",if:{threat:true},do:[{op:"swipe",x1:540,y1:1700,x2:540,y2:1100,duration:120}]},{if:{present:"@coin"},do:[{op:"tap",x:"@found.x",y:"@found.y"}]}]. Shooter: [{if:{valueBelow:{name:"hp",value:25}},do:[{op:"joystick",at:"@stick",direction:"down",duration:600}]},{if:{present:"@enemy"},do:[{op:"aim",at:"@look",dx:"@found.x-540",dy:0},{op:"fire",at:"@fire",count:4}]},{if:{everyTicks:2},do:[{op:"joystick",at:"@stick",direction:"up",duration:400}]}]. ' +
      'Works for EVERY genre: reflex games via threat/present rules (+reflex hybrid), turn-based games (puzzle/card/board/strategy/rpg/simulation/adventure/sports) via ui/text rules with turnBased pacing. Use play_loop for strategy-level autonomy (seconds), react_script for reflexes (< 100 ms), plain play when you want to think every tick.',
    parameters: {
      type: 'object',
      properties: {
        policy: { type: 'array', description: 'ordered rules [{name, if:{...}, do:[steps] | tool:{name,arguments}, cooldownTicks, waitMs}] (omit when using strategy)', items: { type: 'object' } },
        strategy: { type: 'string', description: 'v4.4: replay a LEARNED policy from the game profile: "best" or a strategy name (see 5f). v4.5: "default" = synthesize a starter policy from the genre + colour/control names (also used by "best" when nothing was learned yet). Skips policy.' },
        name: { type: 'string', description: 'v4.4: name to save this policy under (e.g. "v2"); runs are scored (score gain/tick × survival) and ranked per game' },
        learn: { type: 'boolean', description: 'v4.4: record this run into the game\'s strategies (default true)' },
        explore: { type: 'boolean', description: 'v4.6: when nothing is gained for exploreAfter ticks, rotate rule priority so other matching rules get tried (default false)' },
        exploreAfter: { type: 'integer', description: 'v4.6: ticks without gain before exploring (default 4)' },
        report: { type: 'boolean', description: 'v4.6: auto-write a session_report summarising the run (default true)' },
        turnBased: { type: 'boolean', description: 'v4.7: wait for the screen to settle before each tick + 600 ms action waits (auto-on for puzzle/card/board/strategy/rpg/simulation/adventure/sports genres; force with true/false)' },
        note: { type: 'string', description: 'v4.4: short note stored with the strategy' },
        ticks: { type: 'integer', description: 'max ticks (default 10, max 40)', minimum: 1, maximum: 40 },
        maxMs: { type: 'integer', description: 'time budget ms (default/max 25000)', minimum: 1000, maximum: 25000 },
        stopOn: { type: 'object', description: '{stuck, event, valueBelow:{name,value}, valueAbove:{name,value}}' },
        objects: { type: 'array', description: 'colours to track (default: profile colours)', items: { type: 'object' } },
        ocr: { type: 'array', description: 'regions to read (default: numeric profile regions)', items: { type: 'object' } },
        waitMs: { type: 'integer', description: 'default wait after each action (150)' },
        autoMenu: { type: 'boolean', description: 'auto-tap obvious menu buttons when stuck (default true)' },
        reset: { type: 'boolean', description: 'forget previous tick memory at start' },
      },
      required: [],
    },
  },
  {
    name: 'game_setup',
    description:
      'AUTO-PROFILE AN UNKNOWN GAME (v4.2) — call once when play {} says there is no game_profile. One capture: dominant colours → @colours (red/green/yellow…), OCR digit lines in the HUD → numeric @regions (score/hp/coins/time…), clickable UI buttons → @controls, genre guess. Saves everything as the game_profile (nothing is tapped). ' +
      'Then play {} immediately tracks those colours/values every tick with deltas + events. Rename/prune afterwards with game_profile set/unset. Run in-game (not on a menu) for the best palette; force:true re-scans and merges.',
    parameters: { type: 'object', properties: { force: { type: 'boolean', description: 're-scan even if a profile exists (merge)' }, genre: { type: 'string', description: 'override the genre guess: shooter|runner|racing|fighting|rhythm|puzzle|card|board|sports|strategy|rpg|simulation|adventure|casual|other' }, label: { type: 'string', description: 'human name for the game' }, image: { type: 'boolean', description: 'include a small screenshot (default true)' } }, required: [] },
  },
  {
    name: 'react_script',
    description:
      'ON-DEVICE REFLEX ENGINE (v4.1, app 4.1+): hand the phone a small rule set and let it play the next 1-60 seconds at frame rate (~20-30 fps, ~50 ms reaction) while you think. rules[]: {name, when:[conditions], then:[combo steps], cooldownMs (250), priority, maxFires, exclusive}. ' +
      'Conditions: color_present/color_absent {color, region, minCount | minSize/maxSize (object mode → the matched blob is available to then-steps)}, pixel_is/pixel_not {x,y,color}, text_present/text_absent {text, region} (OCR ~150 ms — use for GAME OVER / popups only), always; forMs = must hold that long. ' +
      'then-steps = combo ops PLUS tap_found {dx,dy offset} (tap the matched blob) and aim_found {x,y = crosshair (at:"@crosshair"), lookX,lookY = look-area start (or "@look"), sensitivity px/px (default 1), maxStep px (220), dy = vertical offset e.g. -12 for the head} (drag the camera so the crosshair lands on the blob). ' +
      'stopRules[] end the script early (e.g. text_present "GAME OVER", color_present @deathRed). Returns triggers, frames, fires per rule, a timeline log, stoppedBy. All fingers are lifted at the end (release:false to keep them). ' +
      'Patterns — runner: rules per lane {color_present @obstacle region @laneMid → swipe up}. Shooter: [{name:"track", when:[{type:"color_present",color:"@enemy",minSize:8,maxSize:120}], then:[{op:"aim_found",at:"@crosshair",lookX:"@look",lookY:"@look",sensitivity:1.4,dy:-10}], cooldownMs:60}, {name:"fire", priority:1, when:[{type:"color_present",color:"@ring",region:"@reticle"}], then:[{op:"fire",at:"@fire",holdMs:350}], cooldownMs:80}]. Clicker: {color_present @target minSize → tap_found}. ' +
      'Replaces auto_react/game_loop for anything with more than one reaction. Chain: react_script (10 s) → play {} → adjust rules → react_script …',
    parameters: {
      type: 'object',
      properties: {
        rules: { type: 'array', description: 'rules [{name, when:[{type,color,region,minCount,minSize,maxSize,x,y,text,forMs}], then:[combo steps], cooldownMs, priority, maxFires, exclusive}]', items: { type: 'object' } },
        stopRules: { type: 'array', description: 'conditions that stop the script when true', items: { type: 'object' } },
        timeoutMs: { type: 'integer', description: 'max run time (default 15000, max 60000)', minimum: 500, maximum: 60000 },
        maxTriggers: { type: 'integer', description: 'stop after this many rule fires (default 100)', minimum: 1, maximum: 500 },
        intervalMs: { type: 'integer', description: 'idle frame interval ms (default 40)', minimum: 15, maximum: 2000 },
        release: { type: 'boolean', description: 'lift all fingers at the end (default true)' },
      },
      required: ['rules'],
    },
  },
  {
    name: 'play_frame',
    description: 'Perception only (v4.1): one capture → image + objects + ocr + pixels + changedPct. Same fields as play without act. Prefer play (it can also act).',
    parameters: { type: 'object', properties: { maxWidth: { type: 'integer', description: 'image width (0 = none)' }, quality: { type: 'integer', description: 'JPEG quality' }, objects: { type: 'array', description: 'colours to locate (see play)', items: { type: 'object' } }, ocr: { type: 'array', description: 'regions to read (see play)', items: { type: 'object' } }, pixels: { type: 'array', description: 'points to sample', items: { type: 'object' } }, diff: { type: 'boolean', description: 'changedPct vs previous frame' } }, required: [] },
  },
  // ---------------------------------------------------------------- v2.5 multi-touch engine (shooters / action games)
  {
    name: 'joystick',
    description:
      'Virtual joystick for movement (Free Fire, PUBG, Brawl Stars, racing...): presses the stick centre (x,y), pushes it toward angle/direction by distance px, HOLDS for duration ms, then releases (release=false keeps the finger down so the next joystick call just changes direction without stopping). ' +
      'angle: 0=right 90=down 180=left 270=up (or direction:"up"|"down-left"...). Uses finger slot 0 by default, so aim/fire_burst (other fingers) can run WHILE moving. Save the stick centre as a control (@stick) and pass at:"@stick".',
    parameters: {
      type: 'object',
      properties: {
        x: coord('Stick centre x'), y: coord('Stick centre y'), at: { type: 'string', description: '"@stick" from game_profile instead of x/y' },
        angle: { type: 'number', description: 'Degrees 0-359 (0=right, 90=down, 270=up)' },
        direction: { type: 'string', description: 'up | down | left | right | up-left | up-right | down-left | down-right (alternative to angle)' },
        distance: { type: 'integer', description: 'Push distance px 10-800 (default 150; bigger = run)', minimum: 10, maximum: 800, default: 150 },
        duration: { type: 'integer', description: 'How long to hold the direction 50-40000 ms (default 500)', minimum: 50, maximum: 40000, default: 500 },
        finger: { type: 'integer', description: 'Finger slot 0-3 (default 0)', minimum: 0, maximum: 3, default: 0 },
        release: { type: 'boolean', description: 'Lift the finger at the end (default true). false = keep moving until the next joystick/finger_up', default: true },
      },
      required: [],
    },
  },
  {
    name: 'aim',
    description:
      'Camera / aim drag for shooters and 3D games: drags finger 1 from (x,y) on the look area by (dx,dy) px over duration ms with smooth intermediate points. Positive dx turns right, positive dy looks down. ' +
      'Runs on its own finger so a held joystick keeps moving. Typical: small dx (40-120) to fine-aim at an enemy found with find_objects; large dx (400+) to turn around. Save the look area centre as @look.',
    parameters: {
      type: 'object',
      properties: {
        x: coord('Start x on the look area (usually right half of screen)'), y: coord('Start y'), at: { type: 'string', description: '"@look" control instead of x/y' },
        dx: { type: 'integer', description: 'Horizontal drag px (-3000..3000)' }, dy: { type: 'integer', description: 'Vertical drag px' },
        duration: { type: 'integer', description: '20-3000 ms (default 120)', minimum: 20, maximum: 3000, default: 120 },
        steps: { type: 'integer', description: 'Intermediate points 1-20 (default 4)', minimum: 1, maximum: 20, default: 4 },
        finger: { type: 'integer', description: 'Finger slot (default 1)', minimum: 0, maximum: 3, default: 1 },
        release: { type: 'boolean', description: 'Lift at the end (default true)', default: true },
      },
      required: [],
    },
  },
  {
    name: 'fire_burst',
    description:
      'Fire / attack button: taps (x,y) count times every intervalMs (burst), or holds it for holdMs (auto-fire / charge). Cadence is kept on the phone. Works while joystick/aim fingers are held. Save the button as @fire and pass at:"@fire".',
    parameters: {
      type: 'object',
      properties: {
        x: coord('Fire button x'), y: coord('Fire button y'), at: { type: 'string', description: '"@fire" control' },
        count: { type: 'integer', description: 'Shots 1-200 (default 5)', minimum: 1, maximum: 200, default: 5 },
        intervalMs: { type: 'integer', description: '30-2000 (default 90)', minimum: 30, maximum: 2000, default: 90 },
        holdMs: { type: 'integer', description: '>0 = hold the button this long instead of tapping (auto-fire / charged shot)', minimum: 0, maximum: 30000, default: 0 },
      },
      required: [],
    },
  },
  {
    name: 'finger',
    description:
      'Low-level persistent finger control (up to 4 simultaneous fingers, slots 0-3): op=down at (x,y) keeps the finger pressed until op=up; op=move drags it to (x,y) or along points while staying down; op=up lifts it (finger=-1 lifts all). ' +
      'Use when joystick/aim/fire_burst are not enough: hold a skill button while steering, two-finger pinch-zoom on a map, drag-and-hold mechanics. ALWAYS lift fingers when done (finger op=up finger=-1).',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'down | move | up' },
        finger: { type: 'integer', description: 'Slot 0-3 (default 0); -1 with op=up lifts all', minimum: -1, maximum: 3, default: 0 },
        x: coord('x'), y: coord('y'), at: { type: 'string', description: '"@control" instead of x/y' },
        points: { type: 'array', description: 'For move: path points [{x,y}...]', items: { type: 'object' } },
        duration: { type: 'integer', description: 'ms for the move / initial press', minimum: 20, maximum: 10000 },
      },
      required: ['op'],
    },
  },
  {
    name: 'combo',
    description:
      'A timed multi-touch SCRIPT executed entirely on the phone (no network jitter between steps): steps[] of {op: down|move|up|tap|wait|joystick|aim|fire, finger?, x?, y?, at?, dx?, dy?, angle?|direction?, distance?, duration?, delayMs?, count?, intervalMs?, holdMs?, release?}. ' +
      'Examples \u2014 shooter peek-and-shoot: [{op:"joystick",at:"@stick",direction:"right",duration:300,release:false},{op:"aim",at:"@look",dx:60},{op:"fire",at:"@fire",count:6},{op:"up",finger:-1}]. Fighting game special move: [{op:"tap",at:"@down"},{op:"tap",at:"@forward",delayMs:60},{op:"tap",at:"@punch",delayMs:60}]. ' +
      'Skill-while-moving: [{op:"down",finger:2,at:"@skill"},{op:"joystick",at:"@stick",direction:"up",duration:800},{op:"up",finger:2}]. Any failure lifts all fingers. Save good combos as macros.',
    parameters: {
      type: 'object',
      properties: { steps: { type: 'array', description: '1-40 steps', items: { type: 'object' } } },
      required: ['steps'],
    },
  },
  // ---------------------------------------------------------------- v2.4 handover + progress
  {
    name: 'session_report',
    description:
      'END-OF-SESSION HANDOVER. Call this when you finish (or get stuck / the user stops you) so the NEXT chat starts smarter: outcome, score reached, level, a 1-3 sentence summary, what you learned (facts), what to do next time, and blockers. ' +
      'It is attached to the current play session and to the game profile (bestScore is tracked automatically; the bootstrap QUICK START shows the last report + best score). ' +
      'Keep learned[] factual and short; put coordinates/colours in game_profile instead.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What happened this session (1-3 sentences)' },
        outcome: { type: 'string', description: 'win | loss | progress | stuck | other' },
        score: { type: 'number', description: 'Final score / coins / distance if applicable' },
        level: { type: 'string', description: 'Level / stage / rank reached' },
        learned: { type: 'array', description: 'Facts worth passing on, e.g. "ads appear after every 2 runs", "jump reacts 120ms late"', items: { type: 'string' } },
        nextTime: { type: 'string', description: 'Concrete advice for the next session' },
        blockers: { type: 'array', description: 'Things that stopped you (login wall, missing permission, unknown screen)', items: { type: 'string' } },
        app: { type: 'string', description: 'Package (default current app)' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'playbook',
    description:
      'YOUR EXPERTISE FILE for a game (v4.7.3) — the how-to that makes a brand-new chat play at your current level from turn one. session_report says what happened once; playbook says HOW TO PLAY WELL. It is injected verbatim into the bootstrap of every future chat (per game + a general "*" one). ' +
      'Read: playbook {} (current app) / {app}. Update: playbook {merge:{overview, strategy:[ordered rules of thumb], procedure:[exact tool steps for one move/turn], tricks:[what worked incl. exact coords/timings], mistakes:[never again], screens:[how to recognise menu/game-over/reward + what to press], facts:[geometry, scoring, piece sizes], skill:1-5}}. ' +
      'Lists accumulate and dedupe; procedure is ordered so a new list replaces it. remove:{tricks:["substring"]} deletes stale lines. app:"*" = cross-game skills (works for ANY genre). ' +
      'UPDATE IT EVERY SESSION: after ~10 successful moves (what works), when something fails (mistakes), and before session_report (final state) — a new chat is only as smart as this file.',
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Package (default current app). "*" = general cross-game playbook' },
        merge: { type: 'object', description: '{overview?, strategy?[], procedure?[], tricks?[], mistakes?[], screens?[], facts?[], skill?}' },
        remove: { type: 'object', description: '{field:[substrings to delete]} e.g. {tricks:["old coordinate"]}' },
        replace: { type: 'boolean', description: 'true = start from an empty playbook before merging' },
        delete: { type: 'boolean', description: 'true = delete the playbook of this app' },
      },
      required: [],
    },
  },
  // ---------------------------------------------------------------- v2.3 game profile (@names) + play history
  {
    name: 'game_profile',
    description:
      'The structured knowledge base for the CURRENT game/app (auto-tagged by package): named controls (x,y), colours (hex), regions ({x,y,w,h}) and settings. ' +
      'Once saved you can use @names in ANY tool instead of raw numbers: tap at:"@jump" · find_objects color:"@enemy" · auto_react color:"@note" region:"@hitline" tapX/tapY via at:"@lane1" · read_number region:"@score" · x:"@jump" also works, and x:"@jump+40" offsets. ' +
      'The next chat gets the whole profile in its bootstrap and can start playing immediately without rediscovery. ' +
      'Actions: get (default) · set {controls:{jump:{x,y,note?}}, colors:{enemy:{hex,tolerance?}}, regions:{hud:{x,y,w,h}}, settings:{difficulty:"hard"}} · unset {controls:["old"]} · delete=true wipes the profile. ' +
      'ALWAYS save controls after calibrate, colours after sample_colors, regions after you crop a HUD area. Names: a-z 0-9 - _ (max 60 each).',
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Package (default: current app)' },
        label: { type: 'string', description: 'Human game name to store' },
        set: { type: 'object', description: '{controls?, colors?, regions?, settings?} entries to add/replace' },
        unset: { type: 'object', description: '{controls?:[names], colors?:[...], regions?:[...], settings?:[...]} to remove' },
        delete: { type: 'boolean', description: 'true = delete the whole profile for this app' },
        history: { type: 'boolean', description: 'true = also return recent play sessions for this app (when, how long, how many commands/failures)' },
        genre: { type: 'string', description: 'v2.5: shooter | runner | puzzle | rhythm | strategy | rpg | racing | fighting | casual | other — stored on the profile; the bootstrap shows the matching playbook' },
        verify: { type: 'boolean', description: 'true = check the profile against the CURRENT screen: is each colour still present (count), does each region still contain text? Returns stale[] so you know what to re-learn after a game update' },
      },
      required: [],
    },
  },
  // ---------------------------------------------------------------- v2.1 colour discovery, motion, numbers, calibration
  {
    name: 'sample_colors',
    description:
      'Discover the dominant colours on screen (or in a region) WITHOUT guessing hex values: returns up to maxColors clusters with hex, share (%), pixel count and centre. ' +
      'Greys/blacks/whites are skipped by default so you get the game\'s actual enemy/gem/button colours. Use it once per game, then feed the hex values into find_color / find_objects / auto_react / tap_color. Runs on the phone in ~100ms.',
    parameters: {
      type: 'object',
      properties: {
        region: { type: 'object', description: '{x,y,w,h} area to analyse (default full screen)' },
        maxColors: { type: 'integer', description: '1-24 (default 8)', minimum: 1, maximum: 24, default: 8 },
        quant: { type: 'integer', description: 'Colour bucket size per channel 8-64 (default 32; smaller = more distinct colours)', minimum: 8, maximum: 64, default: 32 },
        ignoreGrey: { type: 'boolean', description: 'Skip low-saturation colours (default true)', default: true },
      },
      required: [],
    },
  },
  {
    name: 'track_object',
    description:
      'Measure where a coloured object is MOVING: samples its centre N times on the phone and returns velocity (px/s in x and y), direction, speed and a PREDICTED position predictMs in the future. ' +
      'Use it to intercept moving targets (tap where the enemy WILL be), to time jumps (obstacle arriving in ~ms), or to detect when something has stopped (speed ~0). Combine with tap_sequence / auto_react.',
    parameters: {
      type: 'object',
      properties: {
        color: { type: 'string', description: '"#rrggbb" of the object' },
        tolerance: { type: 'integer', description: '0-128 (default 24)', minimum: 0, maximum: 128, default: 24 },
        region: { type: 'object', description: '{x,y,w,h} search area' },
        minCount: { type: 'integer', description: 'Min matching px to count as visible (default 20)', minimum: 1, default: 20 },
        samples: { type: 'integer', description: 'Positions to sample 2-12 (default 5)', minimum: 2, maximum: 12, default: 5 },
        intervalMs: { type: 'integer', description: 'Gap between samples 40-1000 (default 120)', minimum: 40, maximum: 1000, default: 120 },
        predictMs: { type: 'integer', description: 'How far ahead to predict 0-3000 (default 300)', minimum: 0, maximum: 3000, default: 300 },
      },
      required: ['color'],
    },
  },
  {
    name: 'read_number',
    description:
      'Read a NUMBER from the screen via OCR (score, coins, timer, HP %, level). Pass a region around the number for reliability; optional label (e.g. "score") picks the line containing that word. ' +
      'Handles separators ("1,250" / "1.250"), suffixes ("12.5K" → 12500), and mm:ss timers (returns seconds). Returns value, raw text and the line position. Much cheaper for the model than reading a screenshot.',
    parameters: {
      type: 'object',
      properties: {
        region: { type: 'object', description: '{x,y,w,h} around the number (strongly recommended)' },
        label: { type: 'string', description: 'Word that appears next to the number, e.g. "score", "coins"' },
        index: { type: 'integer', description: 'Which number if several (default 0)', minimum: 0, default: 0 },
      },
      required: [],
    },
  },
  {
    name: 'watch_value',
    description:
      'Wait until a NUMBER on screen changes / rises / falls / reaches a threshold (score increased, timer hit 0, HP below 30, coins >= 100). Polls read_number on the phone. ' +
      'Returns from, to, delta, waitedMs. Use it to know when your action paid off or when danger starts, instead of taking screenshots in a loop.',
    parameters: {
      type: 'object',
      properties: {
        region: { type: 'object', description: '{x,y,w,h} around the number' },
        label: { type: 'string', description: 'Word next to the number' },
        condition: { type: 'string', description: 'change (default) | increase | decrease | above | below | equals' },
        value: { type: 'number', description: 'Threshold for above/below/equals' },
        timeoutMs: { type: 'integer', description: '500-40000 (default 10000)', minimum: 500, maximum: 40000, default: 10000 },
        intervalMs: { type: 'integer', description: '300-3000 (default 700)', minimum: 300, maximum: 3000, default: 700 },
      },
      required: [],
    },
  },
  {
    name: 'calibrate',
    description:
      'Verify that a tap at (x,y) actually does something and measure the game\'s reaction time: taps, then polls screen_hash until the screen changes (or times out), reports reactedMs and changed. ' +
      'Call it once on each newly-discovered control before relying on it (e.g. is this really the JUMP button? how long after the tap does the game respond?), and remember the results.',
    parameters: {
      type: 'object',
      properties: {
        x: coord('Tap x'), y: coord('Tap y'),
        timeoutMs: { type: 'integer', description: 'Max wait for a reaction 200-5000 (default 1500)', minimum: 200, maximum: 5000, default: 1500 },
        intervalMs: { type: 'integer', description: 'Hash poll interval 50-500 (default 100)', minimum: 50, maximum: 500, default: 100 },
      },
      required: ['x', 'y'],
    },
  },
  // ---------------------------------------------------------------- v1.9 object detection, reflex loop, screen memory
  {
    name: 'find_objects',
    description:
      'Locate SEPARATE objects of one colour (connected blobs) instead of a single averaged centre: returns each blob with cx, cy, bounds, area, sorted by area desc. ' +
      'Use it when several enemies / gems / bubbles / cards of the same colour are on screen and you need to tap a specific one (e.g. the biggest, the lowest, the left-most). ' +
      'find_color only gives ONE centre (the average of all of them, often in empty space); find_objects gives each. Runs on the phone, ~100ms.',
    parameters: {
      type: 'object',
      properties: {
        match: { type: 'string', description: 'v3.1: rgb (default) | hue — hue-distance matching in degrees (tolerance 18-30), robust to shading on 3D objects' },
        color: { type: 'string', description: '"#rrggbb" target colour' },
        tolerance: { type: 'integer', description: 'Per-channel tolerance 0-128 (default 24)', minimum: 0, maximum: 128, default: 24 },
        region: { type: 'object', description: '{x,y,w,h} search area in original pixels' },
        minSize: { type: 'integer', description: 'Ignore blobs smaller than this many px in width/height (default 12)', minimum: 1, maximum: 2000, default: 12 },
        maxResults: { type: 'integer', description: '1-40 (default 10)', minimum: 1, maximum: 40, default: 10 },
      },
      required: ['color'],
    },
  },
  {
    name: 'auto_react',
    description:
      'REFLEX MODE for fast games: the PHONE itself watches for a colour and taps the moment it appears, repeatedly, with no network round-trip (latency ~50-100ms instead of 500-1000ms). ' +
      'Each time the colour is present (>= minCount px) it taps at the blob centre (+ tapOffsetX/Y), or at a fixed tapX/tapY if given, then waits cooldownMs. Stops after maxTriggers taps or timeoutMs. ' +
      'Perfect for: whack-a-mole, tap-the-green-tile, rhythm notes reaching a line (use a thin region), catching falling items, "tap when bar turns green" mini-games. ' +
      'v2.0: add lanes[] for MULTIPLE independent triggers in one loop (e.g. 4 rhythm lanes, each colour/region → its own tap point; or swipe reactions like {swipe:{dx:0,dy:-600}} for "jump when obstacle red appears"), ' +
      'and stopColor (+stopRegion) to end the loop when e.g. the GAME OVER banner colour shows. Returns triggers (count), taps[] with timestamps/positions/lane, and why it stopped.',
    parameters: {
      type: 'object',
      properties: {
        color: { type: 'string', description: '"#rrggbb" trigger colour' },
        tolerance: { type: 'integer', description: '0-128 (default 24)', minimum: 0, maximum: 128, default: 24 },
        region: { type: 'object', description: '{x,y,w,h} watch area — keep it small for speed (e.g. the hit line)' },
        minCount: { type: 'integer', description: 'Min matching pixels to count as present (default 20)', minimum: 1, default: 20 },
        tapOffsetX: { type: 'integer', description: 'Offset added to the blob centre x when tapping (default 0)' },
        tapOffsetY: { type: 'integer', description: 'Offset added to the blob centre y (default 0)' },
        tapX: { type: 'integer', description: 'Tap a fixed x instead of the blob centre (needs tapY)', minimum: 0 },
        tapY: { type: 'integer', description: 'Tap a fixed y instead of the blob centre', minimum: 0 },
        maxTriggers: { type: 'integer', description: 'Stop after this many taps 1-200 (default 20)', minimum: 1, maximum: 200, default: 20 },
        timeoutMs: { type: 'integer', description: 'Total time budget 500-40000 (default 10000)', minimum: 500, maximum: 40000, default: 10000 },
        intervalMs: { type: 'integer', description: 'Poll interval 30-2000 (default 80)', minimum: 30, maximum: 2000, default: 80 },
        cooldownMs: { type: 'integer', description: 'Pause after each tap 0-5000 (default 250) so one target is not tapped twice', minimum: 0, maximum: 5000, default: 250 },
        lanes: { type: 'array', description: 'Up to 6 extra triggers: [{name?, color, region?, tolerance?, minCount?, tapX?, tapY?, tapOffsetX?, tapOffsetY?, swipe?:{dx,dy,durationMs?}, cooldownMs?}]. The top-level color/region is lane 0.', items: { type: 'object' } },
        stopColor: { type: 'string', description: '"#rrggbb": stop the loop as soon as this colour is present (game over / level complete)' },
        stopRegion: { type: 'object', description: '{x,y,w,h} where to look for stopColor' },
        stopMinCount: { type: 'integer', description: 'Min px of stopColor (default 200)', minimum: 1, default: 200 },
      },
      required: ['color'],
    },
  },
  {
    name: 'record_macro',
    description:
      'Learn by doing: start=true begins recording — every INPUT tool you call afterwards on this device (tap, swipe, smart_tap, type_text, tap_sequence, open_app, press_back, wait, ...) is appended to a draft, with the real pause between calls stored as wait steps. ' +
      'start=false stops and saves the draft as a macro (name required at start or stop) that run_macro replays. Use it whenever you are about to do a sequence you will need again (login flow, open game + skip intro + start level, daily reward). ' +
      'status=true returns the current draft without changing it; cancel=true discards it.',
    parameters: {
      type: 'object',
      properties: {
        start: { type: 'boolean', description: 'true = start recording, false = stop and save' },
        name: { type: 'string', description: 'Macro name (a-z 0-9 - _)' },
        description: { type: 'string', description: 'What the macro does' },
        status: { type: 'boolean', description: 'Just report the draft' },
        cancel: { type: 'boolean', description: 'Discard the draft' },
        keepWaits: { type: 'boolean', description: 'Store real pauses between steps as wait steps (default true, capped at 5s each)', default: true },
      },
      required: [],
    },
  },
  {
    name: 'label_screen',
    description:
      'Teach the relay what the CURRENT screen is called (e.g. "main-menu", "level-complete", "game-over", "shop", "ad-overlay"). ' +
      'Stores a perceptual fingerprint + a few OCR words, tagged with the current app. Later identify_screen (and observe.screenName) tells you which labelled screen you are on without spending a screenshot on reasoning. ' +
      'Label each distinct screen once when you first understand it. Max 60 per device.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Short label, a-z 0-9 - _' } }, required: ['name'] },
  },
  {
    name: 'identify_screen',
    description:
      'Which labelled screen is showing now? Compares the current frame with every label saved by label_screen (image similarity + OCR word overlap) and returns the best match with a confidence 0-1, plus the runner-up. ' +
      'Returns {screenName:null} when nothing is similar enough — that means a NEW screen: look at it and label it. Pass delete="name" (or delete="*") to remove labels; pass list=true to list labels only.',
    parameters: {
      type: 'object',
      properties: {
        minConfidence: { type: 'number', description: '0-1 (default 0.72)', minimum: 0, maximum: 1, default: 0.72 },
        delete: { type: 'string', description: 'Label to delete, or "*" for all' },
        list: { type: 'boolean', description: 'Only list labels (no capture)' },
      },
      required: [],
    },
  },
  // ---------------------------------------------------------------- v1.8 composite intelligence
  {
    name: 'observe',
    description:
      'ONE call = full situational awareness: screenshot (optional grid/region) + OCR text lines with coordinates + current app + optional colour search + what changed since the last observe + screenName (which labelled screen this is, see label_screen). ' +
      'All parts run in parallel on the phone, so it costs about the same as a screenshot. Use it as your default "look" in games and unknown apps instead of 3-4 separate calls. ' +
      'Parts that the phone cannot do (e.g. OCR on an old app version) are reported as {ok:false} without failing the whole call.',
    parameters: {
      type: 'object',
      properties: {
        maxWidth: { type: 'integer', description: 'Screenshot width 120-2160 (default 540)', minimum: 120, maximum: 2160, default: 540 },
        grid: { type: 'integer', description: 'Draw a labelled coordinate grid every N px (0=off)', minimum: 0, maximum: 500 },
        region: { type: 'object', description: '{x,y,w,h} crop for screenshot + OCR (original pixels)' },
        colors: { type: 'array', description: 'Optional "#rrggbb" colours to locate (find_colors)', items: { type: 'string' } },
        tolerance: { type: 'integer', description: 'Colour tolerance 0-255 (default 30)', minimum: 0, maximum: 255, default: 30 },
        ocr: { type: 'boolean', description: 'Include OCR text (default true)', default: true },
        image: { type: 'boolean', description: 'Include the screenshot image (default true; false = text/colours only, much smaller)', default: true },
        diff: { type: 'boolean', description: 'Include screen_diff vs previous call (default true)', default: true },
        identify: { type: 'boolean', description: 'Include screenName from label_screen fingerprints (default true)', default: true },
        profile: { type: 'boolean', description: 'v2.4: also evaluate the game profile in the same call (default true when a profile exists): every @color → objects found (count, biggest cx/cy), every @region with a number → its value. Result in `game`.', default: true },
      },
      required: [],
    },
  },
  {
    name: 'smart_tap',
    description:
      'Tap "anything" by name, resolving the target in this order: accessibility UI element (text/id/description) → OCR text on screen → optional fallback {x,y}. ' +
      'Returns via=ui|ocr|fallback plus the tapped point, and (with verify=true) whether the screen changed afterwards. ' +
      'This is the tool to use when you know WHAT to press but not exactly WHERE — menus, buttons, game HUD labels, ads "Skip".',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Visible label / content-description / OCR text to press (case-insensitive, substring ok)' },
        elementId: { type: 'string', description: 'Optional view id (tried first if given)' },
        region: { type: 'object', description: 'Limit the OCR search to {x,y,w,h}' },
        index: { type: 'integer', description: 'Which match to tap when several (default 0)', minimum: 0, default: 0 },
        fallback: { type: 'object', description: 'Optional {x,y} to tap when nothing matches' },
        verify: { type: 'boolean', description: 'Check that the screen changed after the tap (default true)', default: true },
        waitMs: { type: 'integer', description: 'Delay before verification 0-5000 (default 500)', minimum: 0, maximum: 5000, default: 500 },
      },
      required: ['text'],
    },
  },
  {
    name: 'do_until',
    description:
      'Repeat an action UNTIL an observation matches (the inverse of game_loop): e.g. tap "Skip" until text "PLAY" appears, press_back until a colour is found, swipe until an element exists. ' +
      'Checks the condition BEFORE each repetition (so it does nothing if already satisfied). Observation tools: find_color, find_colors, get_pixels, wait_pixel, watch_color, screen_diff, find_image, wait_for_element, read_text, wait_for_text. ' +
      'Returns tries, matched, and the final observation.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'object', description: '{name, arguments} tool to repeat (any input tool incl. smart_tap/tap_text/press_back)' },
        until: { type: 'object', description: '{name, arguments} observation that ends the loop when it matches' },
        maxTries: { type: 'integer', description: '1-30 (default 8)', minimum: 1, maximum: 30, default: 8 },
        intervalMs: { type: 'integer', description: 'Pause after each action 0-5000 (default 600)', minimum: 0, maximum: 5000, default: 600 },
        minChange: { type: 'number', description: 'For screen_diff: changedPct threshold (default 2)', default: 2 },
      },
      required: ['action', 'until'],
    },
  },
  {
    name: 'dismiss_popups',
    description:
      'Close ads, permission dialogs, rating prompts, "daily reward" overlays, cookie banners: scans UI elements AND OCR text for common dismiss labels ' +
      '(Close, X, Skip, Skip ad, Not now, No thanks, Later, Cancel, Deny, Dismiss, Got it, OK, Allow, Continue...) and taps the best one. Repeats up to rounds times while something is found. ' +
      'Add your own labels with extra. Returns the list of what was tapped. Safe to call before every new step in games.',
    parameters: {
      type: 'object',
      properties: {
        extra: { type: 'array', description: 'Additional labels to treat as dismiss buttons', items: { type: 'string' } },
        rounds: { type: 'integer', description: 'Max popups to close in a row 1-5 (default 2)', minimum: 1, maximum: 5, default: 2 },
        ocr: { type: 'boolean', description: 'Also use OCR (default true; needs app v1.7+)', default: true },
      },
      required: [],
    },
  },
  {
    name: 'recent_actions',
    description: 'Your own action history on this device (most recent first): action type + key args, status, duration, error. Use it at the start of a session to see what the previous session did, or to debug a stuck flow.',
    parameters: { type: 'object', properties: { limit: { type: 'integer', description: '1-100 (default 20)', minimum: 1, maximum: 100, default: 20 } }, required: [] },
  },
  {
    name: 'remember',
    description:
      'Save a persistent note about THIS device that future AI sessions will see in the bootstrap (e.g. "Clash: attack button at (980,2150); shop tab at (140,2250)", "Keyboard sends Enter via type_text submit"). ' +
      'The note is auto-tagged with the app currently open (package), so notes are grouped per game/app; pass app to override. ' +
      'Use it whenever you learn a layout, coordinate, or trick worth reusing. Max 40 notes, 2000 chars each.',
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'The note' }, app: { type: 'string', description: 'Package name to tag (default: current app)' } }, required: ['text'] },
  },
  {
    name: 'recall',
    description: 'List saved notes for this device (index, text, app tag, timestamp). Call at the start of a task to reuse earlier learnings. Filter with app=<package> (or app="current"). Pass forget=index (or forget=-1 for all, or forget="app" to wipe every note of the current/given app — e.g. when the user says the game was updated and old notes are stale) to delete.',
    parameters: { type: 'object', properties: { forget: { type: 'string', description: 'Note index to delete; "-1" deletes all; "app" deletes all notes of app (or current app)' }, app: { type: 'string', description: 'Only notes tagged with this package ("current" = app open now)' } }, required: [] },
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
export function toolToAction(name: string, args: Record<string, unknown>): { action?: Record<string, unknown>; special?: 'wait' | 'status' | 'scroll' | 'wait_for' | 'find_tap' | 'batch' | 'act_and_see' | 'wait_for_screen' | 'remember' | 'recall' | 'tap_color' | 'game_loop' | 'save_macro' | 'run_macro' | 'list_macros' | 'tap_text' | 'wait_for_text' | 'session_stats' | 'observe' | 'smart_tap' | 'do_until' | 'dismiss_popups' | 'recent_actions' | 'label_screen' | 'identify_screen' | 'record_macro' | 'read_number' | 'watch_value' | 'calibrate' | 'game_profile' | 'session_report' | 'playbook' | 'play' | 'play_frame' | 'game_setup' | 'play_loop'; error?: string } {
  switch (name) {
    case 'session_report': return { special: 'session_report' }
    case 'playbook': return { special: 'playbook' }
    case 'joystick': return { action: { type: 'joystick', x: args.x, y: args.y, angle: args.angle, direction: args.direction, distance: args.distance, duration: args.duration, finger: args.finger, release: args.release } }
    case 'aim': return { action: { type: 'aim', x: args.x, y: args.y, dx: args.dx, dy: args.dy, duration: args.duration, steps: args.steps, finger: args.finger, release: args.release } }
    case 'fire_burst': return { action: { type: 'fire_burst', x: args.x, y: args.y, count: args.count, intervalMs: args.intervalMs, holdMs: args.holdMs } }
    case 'finger': {
      const op = String(args.op ?? '').toLowerCase()
      if (op === 'down') return { action: { type: 'finger_down', finger: args.finger, x: args.x, y: args.y, duration: args.duration } }
      if (op === 'move') return { action: { type: 'finger_move', finger: args.finger, x: args.x, y: args.y, points: args.points, duration: args.duration } }
      if (op === 'up') return { action: { type: 'finger_up', finger: args.finger } }
      return { error: 'finger op must be down|move|up' }
    }
    case 'combo': return { action: { type: 'combo', combo: args.steps ?? args.combo } }
    case 'react_script': return { action: { type: 'react_script', rules: args.rules, stopRules: args.stopRules, timeoutMs: args.timeoutMs, maxTriggers: args.maxTriggers, intervalMs: args.intervalMs, release: args.release } }
    case 'play': return { special: 'play' }
    case 'play_frame': return { special: 'play_frame' }
    case 'game_setup': return { special: 'game_setup' }
    case 'play_loop': return { special: 'play_loop' }
    case '_play_frame': return { action: { type: 'play_frame', frame: args.frame } } // internal raw action (used by play)
    case 'game_profile': return { special: 'game_profile' }
    case 'sample_colors': return { action: { type: 'sample_colors', region: args.region, maxColors: args.maxColors, quant: args.quant, ignoreGrey: args.ignoreGrey } }
    case 'track_object': return { action: { type: 'track_object', color: args.color, tolerance: args.tolerance, region: args.region, minCount: args.minCount, samples: args.samples, intervalMs: args.intervalMs, predictMs: args.predictMs } }
    case 'read_number': return { special: 'read_number' }
    case 'watch_value': return { special: 'watch_value' }
    case 'calibrate': return { special: 'calibrate' }
    case 'find_objects': return { action: { type: 'find_objects', color: args.color, tolerance: args.tolerance, region: args.region, minSize: args.minSize, maxResults: args.maxResults, match: args.match } }
    case 'auto_react': return { action: { type: 'auto_react', color: args.color, tolerance: args.tolerance, region: args.region, minCount: args.minCount, tapOffsetX: args.tapOffsetX, tapOffsetY: args.tapOffsetY, tapX: args.tapX, tapY: args.tapY, maxTriggers: args.maxTriggers, timeoutMs: args.timeoutMs, intervalMs: args.intervalMs, cooldownMs: args.cooldownMs, lanes: args.lanes, stopColor: args.stopColor, stopRegion: args.stopRegion, stopMinCount: args.stopMinCount } }
    case 'record_macro': return { special: 'record_macro' }
    case 'label_screen': return { special: 'label_screen' }
    case 'identify_screen': return { special: 'identify_screen' }
    case 'observe': return { special: 'observe' }
    case 'smart_tap': return { special: 'smart_tap' }
    case 'do_until': return { special: 'do_until' }
    case 'dismiss_popups': return { special: 'dismiss_popups' }
    case 'recent_actions': return { special: 'recent_actions' }
    case 'capture_screen': return { action: { type: 'screenshot', maxWidth: args.maxWidth, quality: args.quality, format: args.format, grid: args.grid, region: args.region } }
    case 'tap_sequence': return { action: { type: 'tap_sequence', points: args.points } }
    case 'multi_tap': return { action: { type: 'multi_tap', points: args.points, duration: args.duration ?? 60 } }
    case 'swipe_path': return { action: { type: 'swipe_path', points: args.points, duration: args.duration ?? 500 } }
    case 'repeat_tap': return { action: { type: 'repeat_tap', x: args.x, y: args.y, count: args.count ?? 5, intervalMs: args.intervalMs ?? 100 } }
    case 'get_pixels': return { action: { type: 'pixel', points: args.points } }
    case 'find_color': return { action: { type: 'find_color', color: args.color, tolerance: args.tolerance, region: args.region } }
    case 'screen_hash': return { action: { type: 'screen_hash' } } // internal (used by wait_for_screen)
    case 'screen_diff': return { action: { type: 'screen_diff', threshold: args.threshold, cell: args.cell } }
    case 'watch_color': return { action: { type: 'watch_color', color: args.color, tolerance: args.tolerance, region: args.region, appear: args.appear, timeoutMs: args.timeoutMs, intervalMs: args.intervalMs, minCount: args.minCount } }
    case 'wait_pixel': return { action: { type: 'wait_pixel', x: args.x, y: args.y, color: args.color, tolerance: args.tolerance, appear: args.appear, timeoutMs: args.timeoutMs, intervalMs: args.intervalMs } }
    case 'find_image': return { action: { type: 'find_image', image: args.image, threshold: args.threshold, region: args.region, maxResults: args.maxResults } }
    case 'read_text': return { action: { type: 'read_text', region: args.region, lang: args.lang } }
    case 'find_colors': return { action: { type: 'find_colors', colors: args.colors, tolerance: args.tolerance, region: args.region } }
    case 'live_preview': return { action: { type: 'stream', enabled: args.enabled === true, fps: args.fps ?? 2, maxWidth: args.maxWidth ?? 360, quality: 55 } }
    case 'tap_text': return { special: 'tap_text' }
    case 'wait_for_text': return { special: 'wait_for_text' }
    case 'session_stats': return { special: 'session_stats' }
    case 'tap_color': return { special: 'tap_color' }
    case 'game_loop': return { special: 'game_loop' }
    case 'save_macro': return { special: 'save_macro' }
    case 'run_macro': return { special: 'run_macro' }
    case 'list_macros': return { special: 'list_macros' }
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
/** OpenAI caps function descriptions at 1024 chars — cut at a sentence boundary and point to the bootstrap for the rest. */
function capDesc(d: string, max = 1024): string {
  if (d.length <= max) return d
  const tail = ' (full guide: /agent/<token> §7a)'
  let cut = d.slice(0, max - tail.length)
  const dot = cut.lastIndexOf('. ')
  if (dot > max * 0.6) cut = cut.slice(0, dot + 1)
  return cut + tail
}
export function openaiTools() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: capDesc(t.description), parameters: t.parameters },
  }))
}

/** Anthropic Messages API `tools` array */
export function anthropicTools() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
}

/** Gemini function declarations */
export function geminiTools() {
  return [{ function_declarations: TOOLS.map((t) => ({ name: t.name, description: capDesc(t.description), parameters: t.parameters })) }]
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
      version: '4.7.3',
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
  'get_pixels', 'find_color', 'wait_for_screen', 'recall', 'screen_diff', 'watch_color', 'wait_pixel', 'find_image', 'list_macros',
  'read_text', 'wait_for_text', 'find_colors', 'session_stats', 'live_preview',
  'observe', 'recent_actions', 'find_objects', 'identify_screen', 'sample_colors', 'track_object', 'read_number', 'watch_value', 'game_profile', 'playbook', 'play_frame', '_play_frame', 'screen_hash',
])

/** Observation tools usable as `when`/`stopWhen` in game_loop. */
export const OBSERVATION_TOOLS: ReadonlySet<string> = new Set(['find_color', 'find_colors', 'get_pixels', 'wait_pixel', 'watch_color', 'screen_diff', 'find_image', 'wait_for_element', 'read_text', 'wait_for_text', 'find_objects', 'identify_screen', 'track_object', 'read_number', 'watch_value'])
