/**
 * Minimal MCP (Model Context Protocol) server over Streamable HTTP (stateless JSON-RPC).
 * Any MCP client (Claude Desktop/Code, Cursor, OpenAI Agents SDK, etc.) can connect to
 *   POST https://<host>/mcp   with  Authorization: Bearer <RELAY_TOKEN>
 * Optional query ?deviceId=<id> pins the target phone; otherwise the first online one is used.
 */
import type { AuthContext, Bindings } from './types'
import { TOOLS } from './tools'
import { executeTool, defaultDevice } from './tool-exec'
import { canAccess } from './auth'

import type { DeviceRegistry } from './registry'

type Env = Bindings & { REGISTRY: DurableObjectNamespace<DeviceRegistry> }
type Auth = AuthContext & { readOnly?: boolean }

interface RpcReq { jsonrpc: '2.0'; id?: number | string | null; method: string; params?: any }

const rpcOk = (id: RpcReq['id'], result: unknown) => ({ jsonrpc: '2.0', id, result })
const rpcErr = (id: RpcReq['id'], code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })

export async function handleMcp(env: Env, request: Request, auth: Auth): Promise<Response> {
  if (request.method === 'GET') {
    // Streamable HTTP allows GET for server->client SSE; we don't push, so reply 405 per spec.
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } })
  }
  let body: RpcReq | RpcReq[]
  try {
    body = await request.json()
  } catch {
    return Response.json(rpcErr(null, -32700, 'parse error'), { status: 400 })
  }
  const url = new URL(request.url)
  const pinned = url.searchParams.get('deviceId')

  const handle = async (req: RpcReq): Promise<unknown | null> => {
    const { id, method, params } = req
    switch (method) {
      case 'initialize':
        return rpcOk(id, {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'device-relay', version: '3.3.0' },
          instructions:
            'You control a real Android phone. Start with capture_screen to see the screen, then tap/swipe using ORIGINAL pixel coordinates (screen.w x screen.h). ' +
            'Prefer get_ui_elements + tap_element/type_text over raw coordinates. After each action observe again to verify. Use batch to chain several steps in one call. Prefer wait_for_element after taps that trigger navigation or loading.',
        })
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null // notifications get no response
      case 'ping':
        return rpcOk(id, {})
      case 'tools/list':
        return rpcOk(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: { ...t.parameters, properties: { ...t.parameters.properties, deviceId: { type: 'string', description: 'Optional: target phone id (defaults to the first online phone)' } } },
          })),
        })
      case 'tools/call': {
        const name: string = params?.name
        const args: Record<string, unknown> = { ...(params?.arguments ?? {}) }
        const deviceId = auth.role === 'device' ? auth.deviceId : ((args.deviceId as string) || pinned || (await defaultDevice(env)))
        delete args.deviceId
        if (!deviceId) return rpcOk(id, { content: [{ type: 'text', text: 'No phone is registered/online. Open the Device Relay app and press Connect.' }], isError: true })
        if (!canAccess(auth, deviceId)) return rpcOk(id, { content: [{ type: 'text', text: `token not allowed for device ${deviceId}` }], isError: true })
        if (!TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, `unknown tool ${name}`)

        const res = await executeTool(env, deviceId, name, args, { readOnly: auth.readOnly })
        const content: unknown[] = []
        const { image, ...rest } = res
        content.push({ type: 'text', text: JSON.stringify({ deviceId, ...rest }) })
        if (image) content.push({ type: 'image', data: image.base64, mimeType: image.mime })
        return rpcOk(id, { content, isError: !res.ok })
      }
      case 'resources/list':
        return rpcOk(id, { resources: [] })
      case 'prompts/list':
        return rpcOk(id, { prompts: [] })
      default:
        return rpcErr(id, -32601, `method not found: ${method}`)
    }
  }

  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(handle))).filter((x) => x !== null)
    return Response.json(out)
  }
  const out = await handle(body)
  if (out === null) return new Response(null, { status: 202 })
  return Response.json(out)
}
