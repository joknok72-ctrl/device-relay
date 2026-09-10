import { DurableObject } from 'cloudflare:workers'
import type { TokenRecord } from './types'

/**
 * Singleton Durable Object: remembers every deviceId that ever connected,
 * stores per-device API tokens (hashed) and per-device metadata (label).
 */
export class DeviceRegistry extends DurableObject {
  // ---------- devices ----------
  async register(deviceId: string) {
    await this.ctx.storage.put(`dev:${deviceId}`, Date.now())
  }
  async unregister(deviceId: string) {
    await this.ctx.storage.delete(`dev:${deviceId}`)
    await this.ctx.storage.delete(`meta:${deviceId}`)
    const toks = await this.ctx.storage.list<TokenRecord>({ prefix: 'tok:' })
    const del = [...toks.entries()].filter(([, v]) => v.deviceId === deviceId).map(([k]) => k)
    if (del.length) await this.ctx.storage.delete(del)
  }
  async list(): Promise<string[]> {
    const map = await this.ctx.storage.list<number>({ prefix: 'dev:' })
    return [...map.keys()].map((k) => k.slice(4))
  }
  async setMeta(deviceId: string, meta: { label?: string }) {
    const cur = (await this.ctx.storage.get<{ label?: string }>(`meta:${deviceId}`)) ?? {}
    await this.ctx.storage.put(`meta:${deviceId}`, { ...cur, ...meta })
  }
  /** v4.7.3 rename: move registration, label and every device-scoped token from `from` to `to`. */
  async rename(from: string, to: string): Promise<{ tokens: number }> {
    await this.ctx.storage.put(`dev:${to}`, (await this.ctx.storage.get<number>(`dev:${from}`)) ?? Date.now())
    const meta = await this.ctx.storage.get<{ label?: string }>(`meta:${from}`)
    if (meta) await this.ctx.storage.put(`meta:${to}`, meta)
    const toks = await this.ctx.storage.list<TokenRecord>({ prefix: 'tok:' })
    let n = 0
    for (const [k, v] of toks) if (v.deviceId === from) { await this.ctx.storage.put(k, { ...v, deviceId: to }); n++ }
    await this.ctx.storage.delete(`dev:${from}`)
    await this.ctx.storage.delete(`meta:${from}`)
    return { tokens: n }
  }
  async allMeta(): Promise<Record<string, { label?: string }>> {
    const map = await this.ctx.storage.list<{ label?: string }>({ prefix: 'meta:' })
    const out: Record<string, { label?: string }> = {}
    for (const [k, v] of map) out[k.slice(5)] = v
    return out
  }

  // ---------- per-device tokens (stored under SHA-256 hash, never clear text) ----------
  async putToken(hash: string, rec: TokenRecord) {
    await this.ctx.storage.put(`tok:${hash}`, rec)
  }
  async getToken(hash: string): Promise<TokenRecord | undefined> {
    return this.ctx.storage.get<TokenRecord>(`tok:${hash}`)
  }
  async touchToken(hash: string) {
    const rec = await this.ctx.storage.get<TokenRecord>(`tok:${hash}`)
    if (rec) { rec.lastUsedAt = Date.now(); await this.ctx.storage.put(`tok:${hash}`, rec) }
  }
  async listTokens(deviceId?: string): Promise<TokenRecord[]> {
    const map = await this.ctx.storage.list<TokenRecord>({ prefix: 'tok:' })
    const all = [...map.values()]
    return (deviceId ? all.filter((t) => t.deviceId === deviceId) : all).sort((a, b) => b.createdAt - a.createdAt)
  }
  /** Revoke by public token id (first 8 hex of hash). */
  async revokeToken(id: string): Promise<boolean> {
    const map = await this.ctx.storage.list<TokenRecord>({ prefix: 'tok:' })
    for (const [k, v] of map) if (v.id === id) { await this.ctx.storage.delete(k); return true }
    return false
  }
}
