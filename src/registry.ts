import { DurableObject } from 'cloudflare:workers'

/** Singleton Durable Object that remembers every deviceId that ever connected. */
export class DeviceRegistry extends DurableObject {
  async register(deviceId: string) {
    await this.ctx.storage.put(`dev:${deviceId}`, Date.now())
  }
  async unregister(deviceId: string) {
    await this.ctx.storage.delete(`dev:${deviceId}`)
  }
  async list(): Promise<string[]> {
    const map = await this.ctx.storage.list<number>({ prefix: 'dev:' })
    return [...map.keys()].map((k) => k.slice(4))
  }
}
