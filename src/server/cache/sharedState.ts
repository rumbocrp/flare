/**
 * Shared state and coordination abstraction (`SharedStateAdapter`) supporting:
 * - Single-node / test in-memory execution (`MemorySharedStateAdapter`)
 * - Multi-node Redis deployment (`RedisSharedStateAdapter`) when `REDIS_URL` is configured
 *
 * Used for sliding-window rate limits, distributed coordination locks, TTL caching,
 * and cross-node pub/sub fanout.
 */

export type SharedStateBackend = 'memory' | 'redis'

export type SharedStateSubscriber = (message: string, channel: string) => void

export interface SharedStateAdapter {
  readonly backend: SharedStateBackend
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlMs?: number): Promise<void>
  del(key: string): Promise<void>
  /**
   * Atomically increments a counter inside a time window and returns
   * `{ count, resetAtMs }`.
   */
  incrWindow(
    key: string,
    windowMs: number,
  ): Promise<{ count: number; resetAtMs: number }>
  /**
   * Best-effort distributed lease lock (`SET key owner NX PX ttlMs`).
   */
  acquireLock(key: string, owner: string, ttlMs: number): Promise<boolean>
  releaseLock(key: string, owner: string): Promise<boolean>
  publish(channel: string, message: string): Promise<void>
  subscribe(
    channel: string,
    listener: SharedStateSubscriber,
  ): Promise<() => Promise<void>>
  close(): Promise<void>
}

export interface RedisClientLike {
  get(key: string): Promise<string | null>
  set(
    key: string,
    value: string,
    options?: { PX?: number; NX?: boolean },
  ): Promise<string | null>
  del(key: string): Promise<number>
  incr(key: string): Promise<number>
  pExpire(key: string, ttlMs: number): Promise<number | boolean>
  pTTL(key: string): Promise<number>
  publish?(channel: string, message: string): Promise<number>
  duplicate?(): RedisClientLike & {
    connect?: () => Promise<void>
    subscribe?: (
      channel: string,
      listener: (message: string, channel: string) => void,
    ) => Promise<void>
    unsubscribe?: (channel: string) => Promise<void>
    quit?: () => Promise<void>
  }
  quit?(): Promise<void>
}

type StoredValue = {
  value: string
  expiresAtMs: number | null
}

type WindowCounter = {
  count: number
  resetAtMs: number
}

const MAX_MEMORY_ENTRIES = 10_000

export class MemorySharedStateAdapter implements SharedStateAdapter {
  readonly backend: SharedStateBackend = 'memory'
  private readonly store = new Map<string, StoredValue>()
  private readonly windows = new Map<string, WindowCounter>()
  private readonly locks = new Map<string, { owner: string; expiresAtMs: number }>()
  private readonly channels = new Map<string, Set<SharedStateSubscriber>>()

  private pruneIfNeeded(): void {
    if (this.store.size <= MAX_MEMORY_ENTRIES) return
    const now = Date.now()
    for (const [k, entry] of this.store) {
      if (entry.expiresAtMs !== null && entry.expiresAtMs <= now) {
        this.store.delete(k)
      }
    }
    while (this.store.size > MAX_MEMORY_ENTRIES) {
      const oldest = this.store.keys().next().value
      if (oldest === undefined) break
      this.store.delete(oldest)
    }
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key)
    if (!entry) return null
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
      this.store.delete(key)
      return null
    }
    return entry.value
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.store.delete(key)
    const expiresAtMs =
      typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0
        ? Date.now() + ttlMs
        : null
    this.store.set(key, { value, expiresAtMs })
    this.pruneIfNeeded()
  }

  async del(key: string): Promise<void> {
    this.store.delete(key)
    this.windows.delete(key)
  }

  async incrWindow(
    key: string,
    windowMs: number,
  ): Promise<{ count: number; resetAtMs: number }> {
    const now = Date.now()
    const safeWindow = Math.max(1_000, windowMs)
    const existing = this.windows.get(key)
    if (!existing || existing.resetAtMs <= now) {
      const next: WindowCounter = { count: 1, resetAtMs: now + safeWindow }
      this.windows.set(key, next)
      if (this.windows.size > MAX_MEMORY_ENTRIES) {
        for (const [wk, wv] of this.windows) {
          if (wv.resetAtMs <= now) this.windows.delete(wk)
        }
      }
      return { ...next }
    }
    existing.count += 1
    return { count: existing.count, resetAtMs: existing.resetAtMs }
  }

  async acquireLock(
    key: string,
    owner: string,
    ttlMs: number,
  ): Promise<boolean> {
    const now = Date.now()
    const current = this.locks.get(key)
    if (current && current.expiresAtMs > now && current.owner !== owner) {
      return false
    }
    this.locks.set(key, {
      owner,
      expiresAtMs: now + Math.max(500, ttlMs),
    })
    return true
  }

  async releaseLock(key: string, owner: string): Promise<boolean> {
    const current = this.locks.get(key)
    if (!current || current.owner !== owner) return false
    this.locks.delete(key)
    return true
  }

  async publish(channel: string, message: string): Promise<void> {
    const listeners = this.channels.get(channel)
    if (!listeners || listeners.size === 0) return
    for (const listener of listeners) {
      try {
        listener(message, channel)
      } catch {
        // Isolate subscriber errors
      }
    }
  }

  async subscribe(
    channel: string,
    listener: SharedStateSubscriber,
  ): Promise<() => Promise<void>> {
    let set = this.channels.get(channel)
    if (!set) {
      set = new Set()
      this.channels.set(channel, set)
    }
    set.add(listener)
    return async () => {
      const current = this.channels.get(channel)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) {
        this.channels.delete(channel)
      }
    }
  }

  clearAll(): void {
    this.store.clear()
    this.windows.clear()
    this.locks.clear()
    this.channels.clear()
  }

  async close(): Promise<void> {
    this.clearAll()
  }
}

export class RedisSharedStateAdapter implements SharedStateAdapter {
  readonly backend: SharedStateBackend = 'redis'
  private readonly client: RedisClientLike
  private readonly prefix: string
  private readonly localChannels = new Map<string, Set<SharedStateSubscriber>>()

  constructor(client: RedisClientLike, prefix = 'flare:') {
    this.client = client
    this.prefix = prefix
  }

  private k(key: string): string {
    return `${this.prefix}${key}`
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(this.k(key))
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    if (typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0) {
      await this.client.set(this.k(key), value, { PX: Math.round(ttlMs) })
    } else {
      await this.client.set(this.k(key), value)
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(this.k(key))
  }

  async incrWindow(
    key: string,
    windowMs: number,
  ): Promise<{ count: number; resetAtMs: number }> {
    const namespaced = this.k(`rl:${key}`)
    const safeWindow = Math.max(1_000, Math.round(windowMs))
    const count = await this.client.incr(namespaced)
    let ttl = await this.client.pTTL(namespaced)
    if (count === 1 || ttl < 0) {
      await this.client.pExpire(namespaced, safeWindow)
      ttl = safeWindow
    }
    return {
      count,
      resetAtMs: Date.now() + Math.max(0, ttl),
    }
  }

  async acquireLock(
    key: string,
    owner: string,
    ttlMs: number,
  ): Promise<boolean> {
    const res = await this.client.set(this.k(`lock:${key}`), owner, {
      NX: true,
      PX: Math.max(500, Math.round(ttlMs)),
    })
    return res === 'OK'
  }

  async releaseLock(key: string, owner: string): Promise<boolean> {
    const namespaced = this.k(`lock:${key}`)
    const current = await this.client.get(namespaced)
    if (current !== owner) return false
    await this.client.del(namespaced)
    return true
  }

  async publish(channel: string, message: string): Promise<void> {
    const namespaced = this.k(`pub:${channel}`)
    if (this.client.publish) {
      await this.client.publish(namespaced, message)
    }
    const local = this.localChannels.get(channel)
    if (local) {
      for (const listener of local) {
        listener(message, channel)
      }
    }
  }

  async subscribe(
    channel: string,
    listener: SharedStateSubscriber,
  ): Promise<() => Promise<void>> {
    if (this.client.duplicate) {
      const sub = this.client.duplicate()
      if (sub.connect) await sub.connect()
      const namespaced = this.k(`pub:${channel}`)
      if (sub.subscribe) {
        await sub.subscribe(namespaced, (msg) => listener(msg, channel))
      }
      return async () => {
        if (sub.unsubscribe) await sub.unsubscribe(namespaced)
        if (sub.quit) await sub.quit()
      }
    }

    let set = this.localChannels.get(channel)
    if (!set) {
      set = new Set()
      this.localChannels.set(channel, set)
    }
    set.add(listener)
    return async () => {
      const current = this.localChannels.get(channel)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.localChannels.delete(channel)
    }
  }

  async close(): Promise<void> {
    this.localChannels.clear()
    if (this.client.quit) {
      await this.client.quit()
    }
  }
}

let activeSharedState: SharedStateAdapter = new MemorySharedStateAdapter()

export function getSharedStateAdapter(): SharedStateAdapter {
  return activeSharedState
}

export function setSharedStateAdapter(adapter: SharedStateAdapter): void {
  activeSharedState = adapter
}

export function resetSharedStateAdapter(): MemorySharedStateAdapter {
  const memory = new MemorySharedStateAdapter()
  activeSharedState = memory
  return memory
}
