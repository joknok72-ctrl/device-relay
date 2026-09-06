/**
 * Single source of truth for the AI tool catalogue.
 * Exposed as: OpenAI tools, Anthropic tools, OpenAPI 3.1, and MCP tools/list.
 */

export interface ToolDef {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description: string; minimum?: number; maximum?: number; default?: unknown }>
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
      'not the downscaled image size; use image.scale to convert (original = image_px / scale).',
    parameters: { type: 'object', properties: {}, required: [] },
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
export function toolToAction(name: string, args: Record<string, unknown>): { action?: Record<string, unknown>; special?: 'wait' | 'status'; error?: string } {
  switch (name) {
    case 'capture_screen': return { action: { type: 'screenshot' } }
    case 'tap': return { action: { type: 'tap', x: args.x, y: args.y } }
    case 'long_press': return { action: { type: 'long_press', x: args.x, y: args.y, duration: args.duration ?? 800 } }
    case 'swipe': return { action: { type: 'swipe', x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, duration: args.duration ?? 300 } }
    case 'press_back': return { action: { type: 'back' } }
    case 'press_home': return { action: { type: 'home' } }
    case 'open_recents': return { action: { type: 'recents' } }
    case 'open_notifications': return { action: { type: 'notifications' } }
    case 'lock_screen': return { action: { type: 'lock' } }
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
      version: '1.0.0',
      description:
        'Control a real Android phone through an AI agent. Workflow: capture_screen → reason → tap/swipe → capture_screen to verify. ' +
        'All coordinates are in original screen pixels.',
    },
    servers: [{ url: serverUrl }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearerAuth: [] }],
    paths,
  }
}
