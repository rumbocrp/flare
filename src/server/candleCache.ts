import { binanceSource } from '../market/binance'
import type { Candle, Interval, MarketDataSource } from '../types'

export type DataSourceKind = 'binance' | 'binance-cache'

export class UpstreamMarketDataError extends Error {
  readonly pair: string
  readonly interval: Interval

  constructor(pair: string, interval: Interval, cause?: unknown) {
    const detail =
      cause instanceof Error ? cause.message : String(cause ?? 'Network error')
    super(
      `Upstream market data unavailable for ${pair} (${interval}): ${detail}`,
    )
    this.name = 'UpstreamMarketDataError'
    this.pair = pair
    this.interval = interval
  }
}

type CachedCandleResult = {
  candles: Candle[]
  source: DataSourceKind
  latencyMs: number
  cachedAt: number
}

export type ServerCacheMetrics = {
  hits: number
  misses: number
  coalescedRequests: number
  binanceErrors: number
  hitRatePct: number
  avgLatencyMs: number
  lastSource: DataSourceKind
  activeCacheEntries: number
}

type CacheEntry = {
  candles: Candle[]
  source: 'binance'
  storedAt: number
  expiresAt: number
}

const TTL_BY_INTERVAL: Record<Interval, number> = {
  '5m': 5_000,
  '15m': 8_000,
  '1h': 15_000,
  '4h': 30_000,
  '1d': 60_000,
}

const BINANCE_TIMEOUT_MS = 4_500
const STALE_WINDOW_MS = 300_000
const MAX_CACHE_ENTRIES = 200

const cacheStore = new Map<string, CacheEntry>()
const inFlightRequests = new Map<string, Promise<CachedCandleResult>>()

let activeMarketSource: MarketDataSource = binanceSource

/**
 * Allows unit tests to inject a deterministic `MarketDataSource` without ever
 * embedding synthetic fallback data in runtime code.
 */
export function setCandleMarketSource(source: MarketDataSource): void {
  activeMarketSource = source
}

export function resetCandleMarketSource(): void {
  activeMarketSource = binanceSource
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 500
  return Math.min(1_000, Math.max(1, Math.round(limit)))
}

function setCacheEntry(key: string, entry: CacheEntry, now: number): void {
  cacheStore.delete(key)
  if (cacheStore.size >= MAX_CACHE_ENTRIES) {
    for (const [k, existing] of cacheStore) {
      if (now - existing.storedAt >= STALE_WINDOW_MS) {
        cacheStore.delete(k)
      }
    }
    while (cacheStore.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = cacheStore.keys().next().value
      if (oldestKey === undefined) break
      cacheStore.delete(oldestKey)
    }
  }
  cacheStore.set(key, entry)
}

let hits = 0
let misses = 0
let coalescedRequests = 0
let binanceErrors = 0
let totalLatencyMs = 0
let latencySamples = 0
let lastSource: DataSourceKind = 'binance'

function makeCacheKey(pair: string, interval: Interval, limit: number): string {
  return `${pair.toUpperCase()}:${interval}:${limit}`
}

function recordLatency(ms: number): void {
  totalLatencyMs += ms
  latencySamples += 1
}

/**
 * Fetches live candles with per-timeframe TTL caching, concurrent request
 * coalescing, strict fetch timeout, and Stale-While-Revalidate over recent real
 * Binance bars (< 5 min). Throws `UpstreamMarketDataError` when no live or
 * recently cached real market data is available (never fabricates synthetic data).
 */
export async function fetchOptimizedCandles(
  pair: string,
  interval: Interval,
  limit = 500,
  options?: { forceRefresh?: boolean },
): Promise<CachedCandleResult> {
  const safeLimit = clampLimit(limit)
  const key = makeCacheKey(pair, interval, safeLimit)
  const now = Date.now()

  if (!options?.forceRefresh) {
    const cached = cacheStore.get(key)
    if (cached && now < cached.expiresAt) {
      cacheStore.delete(key)
      cacheStore.set(key, cached)
      hits += 1
      lastSource = 'binance-cache'
      return {
        candles: cached.candles,
        source: lastSource,
        latencyMs: 0,
        cachedAt: cached.storedAt,
      }
    }
  }

  const existingPromise = inFlightRequests.get(key)
  if (existingPromise) {
    coalescedRequests += 1
    return existingPromise
  }

  misses += 1

  const requestPromise = (async (): Promise<CachedCandleResult> => {
    const startMs = Date.now()
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), BINANCE_TIMEOUT_MS)

    try {
      const candles = await activeMarketSource.getCandles({
        pair,
        interval,
        limit: safeLimit,
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      const latencyMs = Math.max(1, Date.now() - startMs)
      recordLatency(latencyMs)

      const storedAt = Date.now()
      setCacheEntry(
        key,
        {
          candles,
          source: 'binance',
          storedAt,
          expiresAt: storedAt + TTL_BY_INTERVAL[interval],
        },
        storedAt,
      )
      lastSource = 'binance'

      return {
        candles,
        source: 'binance',
        latencyMs,
        cachedAt: storedAt,
      }
    } catch (err) {
      clearTimeout(timeoutId)
      binanceErrors += 1

      // Serve recent real cached Binance bars (< 5 min) on transient upstream hiccups
      const stale = cacheStore.get(key)
      if (stale && Date.now() - stale.storedAt < STALE_WINDOW_MS) {
        lastSource = 'binance-cache'
        return {
          candles: stale.candles,
          source: 'binance-cache',
          latencyMs: Math.max(1, Date.now() - startMs),
          cachedAt: stale.storedAt,
        }
      }

      throw new UpstreamMarketDataError(pair, interval, err)
    } finally {
      inFlightRequests.delete(key)
    }
  })()

  inFlightRequests.set(key, requestPromise)
  return requestPromise
}

export function getCacheMetrics(): ServerCacheMetrics {
  const totalRequests = hits + misses
  const hitRatePct =
    totalRequests > 0 ? Math.round((hits / totalRequests) * 1000) / 10 : 0
  const avgLatencyMs =
    latencySamples > 0 ? Math.round(totalLatencyMs / latencySamples) : 0

  return {
    hits,
    misses,
    coalescedRequests,
    binanceErrors,
    hitRatePct,
    avgLatencyMs,
    lastSource,
    activeCacheEntries: cacheStore.size,
  }
}

export function clearCandleCache(): void {
  cacheStore.clear()
  inFlightRequests.clear()
  hits = 0
  misses = 0
  coalescedRequests = 0
  binanceErrors = 0
  totalLatencyMs = 0
  latencySamples = 0
}
