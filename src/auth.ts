/**
 * Authentication & rate limiting.
 *  - RELAY_TOKEN (secret)          -> admin: all devices + /api/admin/*
 *  - per-device tokens (registry)  -> scoped to ONE deviceId (optionally read-only)
 * Tokens are never stored in clear text: only SHA-256 hashes live in the registry.
 */
import type { AuthContext, Bindings, TokenRecord } from './types'
import type { DeviceRegistry } from './registry'

export type AuthEnv = Bindings & { REGISTRY: DurableObjectNamespace<DeviceRegistry> }

/** Constant-time string compare */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function randomToken(prefix = 'dr'): string {
  const b = new Uint8Array(24)
  crypto.getRandomValues(b)
  return `${prefix}_${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`
}

export function registry(env: AuthEnv) {
  return env.REGISTRY.get(env.REGISTRY.idFromName('global'))
}

/** Extract bearer token from Authorization header or ?token= (browsers' WebSocket cannot set headers). */
export function extractToken(req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined }): string {
  const h = req.header('Authorization') ?? ''
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim()
  return req.query('token') ?? ''
}

/** Resolve a token string to an AuthContext (or null). */
export async function authenticate(env: AuthEnv, token: string): Promise<(AuthContext & { readOnly?: boolean }) | null> {
  if (!token) return null
  if (env.RELAY_TOKEN && safeEqual(token, env.RELAY_TOKEN)) return { role: 'admin' }
  if (!token.startsWith('dr_')) return null
  const hash = await sha256Hex(token)
  const rec: TokenRecord | undefined = await registry(env).getToken(hash)
  if (!rec) return null
  registry(env).touchToken(hash).catch(() => {})
  if (rec.admin) return { role: 'admin', tokenId: rec.id, label: rec.label }
  return { role: 'device', deviceId: rec.deviceId, tokenId: rec.id, label: rec.label, readOnly: rec.readOnly }
}

/** Can this auth context act on deviceId? */
export function canAccess(auth: AuthContext, deviceId: string): boolean {
  return auth.role === 'admin' || auth.deviceId === deviceId
}

// ---------------------------------------------------------------- rate limiting (per isolate, sliding window)
const buckets = new Map<string, number[]>()
const WINDOW_MS = 10_000
const MAX_PER_WINDOW = 120 // 12 req/s sustained per token

export function rateLimit(key: string): { ok: boolean; retryAfterMs?: number; remaining: number } {
  const now = Date.now()
  let arr = buckets.get(key)
  if (!arr) { arr = []; buckets.set(key, arr) }
  while (arr.length && arr[0] <= now - WINDOW_MS) arr.shift()
  if (arr.length >= MAX_PER_WINDOW) return { ok: false, retryAfterMs: arr[0] + WINDOW_MS - now, remaining: 0 }
  arr.push(now)
  if (buckets.size > 5000) for (const [k, v] of buckets) if (!v.length || v[v.length - 1] < now - WINDOW_MS) buckets.delete(k)
  return { ok: true, remaining: MAX_PER_WINDOW - arr.length }
}
