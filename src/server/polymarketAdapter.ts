/**
 * Read-only adapter for Polymarket "Bitcoin Up or Down" markets.
 *
 * - Discovery: Gamma API `markets?slug=btc-updown-{5m|15m}-<startTs>`
 *   (settled windows require `closed=true`).
 * - Open price: CLOB `prices-history` of UP token, last point <= window start.
 * - Resolution: `outcomePrices` = ["1","0"] (Up) or ["0","1"] (Down) once `closed`.
 *
 * Polymarket settles using the Chainlink BTC/USD feed rather than Binance, so
 * occasional edge discrepancies can occur against the matching Binance candle.
 */

export type PolymarketTimeframe = '5m' | '15m'

export type PolymarketWindow = {
  slug: string
  timeframe: PolymarketTimeframe
  /** Window open timestamp in ms (aligns with Binance candle `time`). */
  startTime: number
  endTime: number
  status: 'open' | 'closed' | 'missing'
  question: string | null
  /** UP token price at window open (0..1). */
  upPriceAtOpen: number | null
  /** Current UP price: midpoint of best bid/ask when available, else `outcomePrices`. */
  upPriceNow: number | null
  bestBid: number | null
  bestAsk: number | null
  resolvedUp: boolean | null
  volume: number
  /** CLOB token IDs and execution metadata populated from Gamma API. */
  conditionId?: string | null
  upTokenId?: string | null
  downTokenId?: string | null
  tickSize?: number | null
  negRisk?: boolean
}

export type PolymarketSnapshot = {
  source: 'polymarket'
  timeframe: PolymarketTimeframe
  fetchedAt: string
  windows: PolymarketWindow[]
  errors: string[]
}

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

const GAMMA = 'https://gamma-api.polymarket.com'
const CLOB = 'https://clob.polymarket.com'
const STEP_SECONDS: Record<PolymarketTimeframe, number> = { '5m': 300, '15m': 900 }
const OPEN_TTL_MS = 15_000
const MISSING_TTL_MS = 60_000
const CLOSED_TTL_MS = 7 * 24 * 60 * 60_000
const REQUEST_TIMEOUT_MS = 8_000
const MAX_CACHE_ENTRIES = 500
const CONCURRENCY = 6
/** Grace window (seconds) to accept an opening quote published slightly after start. */
const OPEN_PRICE_GRACE_S = 20

const cache = new Map<string, { value: PolymarketWindow; expiresAt: number }>()
let inFlightByFetcher = new WeakMap<
  FetchLike,
  Map<string, Promise<PolymarketWindow>>
>()

function getInFlightMap(
  fetchImpl: FetchLike,
): Map<string, Promise<PolymarketWindow>> {
  let map = inFlightByFetcher.get(fetchImpl)
  if (!map) {
    map = new Map()
    inFlightByFetcher.set(fetchImpl, map)
  }
  return map
}

function getCachedWindow(slug: string, nowMs: number): PolymarketWindow | null {
  const hit = cache.get(slug)
  if (!hit) return null
  if (hit.expiresAt <= nowMs) {
    cache.delete(slug)
    return null
  }
  cache.delete(slug)
  cache.set(slug, hit)
  return hit.value
}

function setCachedWindow(
  slug: string,
  value: PolymarketWindow,
  expiresAt: number,
  nowMs: number,
): void {
  cache.delete(slug)
  if (cache.size >= MAX_CACHE_ENTRIES) {
    for (const [k, entry] of cache) {
      if (entry.expiresAt <= nowMs) {
        cache.delete(k)
      }
    }
    while (cache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value
      if (oldestKey === undefined) break
      cache.delete(oldestKey)
    }
  }
  cache.set(slug, { value, expiresAt })
}

export function clearPolymarketCache(): void {
  cache.clear()
  inFlightByFetcher = new WeakMap()
}

function windowSlug(tf: PolymarketTimeframe, startTs: number): string {
  return `btc-updown-${tf}-${startTs}`
}

export function recentWindowStarts(
  tf: PolymarketTimeframe,
  limit: number,
  nowMs: number,
): number[] {
  const step = STEP_SECONDS[tf]
  const nowS = Math.floor(nowMs / 1000)
  const current = nowS - (nowS % step)
  const out: number[] = []
  for (let k = limit - 1; k >= 0; k--) out.push(current - k * step)
  return out
}

function toNumber(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

function parseJsonArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (typeof v !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(v)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Latest quote published at or within 20s after window start. */
export function priceAtOpen(
  history: { t: number; p: number }[],
  startTs: number,
): number | null {
  let best: { t: number; p: number } | null = null
  for (const point of history) {
    if (!Number.isFinite(point.t) || !Number.isFinite(point.p)) continue
    if (point.t > startTs + OPEN_PRICE_GRACE_S) continue
    if (!best || point.t > best.t) best = point
  }
  return best ? best.p : null
}

type GammaMarketFields = {
  question: string | null
  closed: boolean
  conditionId: string | null
  upTokenId: string | null
  downTokenId: string | null
  upIndex: number
  outcomePrices: number[]
  bestBid: number | null
  bestAsk: number | null
  volume: number
  tickSize: number | null
  negRisk: boolean
}

export function parseGammaMarket(raw: unknown): GammaMarketFields | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const outcomes = parseJsonArray(m.outcomes).map((o) => String(o).toLowerCase())
  const tokens = parseJsonArray(m.clobTokenIds).map(String)
  const upIndex = Math.max(0, outcomes.indexOf('up'))
  const explicitDown = outcomes.indexOf('down')
  const downIndex = explicitDown >= 0 ? explicitDown : upIndex === 0 ? 1 : 0
  return {
    question: typeof m.question === 'string' ? m.question : null,
    closed: m.closed === true,
    conditionId: typeof m.conditionId === 'string' ? m.conditionId : null,
    upTokenId: tokens[upIndex] ?? null,
    downTokenId: tokens[downIndex] ?? null,
    upIndex,
    outcomePrices: parseJsonArray(m.outcomePrices).map((p) => toNumber(p) ?? NaN),
    bestBid: toNumber(m.bestBid),
    bestAsk: toNumber(m.bestAsk),
    volume: toNumber(m.volume) ?? 0,
    tickSize: toNumber(m.orderPriceMinTickSize) ?? 0.01,
    negRisk: m.negRisk === true,
  }
}

async function getJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${url.split('?')[0]}`)
    return await res.json()
  } finally {
    clearTimeout(timeoutId)
  }
}

async function loadWindow(
  fetchImpl: FetchLike,
  tf: PolymarketTimeframe,
  startTs: number,
  nowMs: number,
): Promise<PolymarketWindow> {
  const slug = windowSlug(tf, startTs)
  const step = STEP_SECONDS[tf]
  const isPast = (startTs + step) * 1000 <= nowMs

  const queries = isPast
    ? [`slug=${slug}&closed=true`, `slug=${slug}`]
    : [`slug=${slug}`, `slug=${slug}&closed=true`]
  let market: GammaMarketFields | null = null
  for (const q of queries) {
    const body = await getJson(fetchImpl, `${GAMMA}/markets?${q}`)
    const first = Array.isArray(body) ? body[0] : null
    market = parseGammaMarket(first)
    if (market) break
  }

  const base: PolymarketWindow = {
    slug,
    timeframe: tf,
    startTime: startTs * 1000,
    endTime: (startTs + step) * 1000,
    status: 'missing',
    question: null,
    upPriceAtOpen: null,
    upPriceNow: null,
    bestBid: null,
    bestAsk: null,
    resolvedUp: null,
    volume: 0,
  }
  if (!market) return base

  let upPriceAtOpen: number | null = null
  if (market.upTokenId && startTs * 1000 <= nowMs) {
    const hist = await getJson(
      fetchImpl,
      `${CLOB}/prices-history?market=${market.upTokenId}&startTs=${startTs - 600}&endTs=${startTs + 60}&fidelity=1`,
    )
    const points = (hist as { history?: { t: number; p: number }[] }).history ?? []
    upPriceAtOpen = priceAtOpen(points, startTs)
  }

  const upOutcome = market.outcomePrices[market.upIndex]
  const resolvedUp =
    market.closed && (upOutcome === 1 || upOutcome === 0) ? upOutcome === 1 : null
  const mid =
    market.bestBid !== null && market.bestAsk !== null && market.bestAsk > 0
      ? (market.bestBid + market.bestAsk) / 2
      : Number.isFinite(upOutcome)
        ? upOutcome
        : null

  return {
    ...base,
    status: market.closed ? 'closed' : 'open',
    question: market.question,
    upPriceAtOpen,
    upPriceNow: market.closed ? null : mid,
    bestBid: market.closed ? null : market.bestBid,
    bestAsk: market.closed ? null : market.bestAsk,
    resolvedUp,
    volume: market.volume,
    conditionId: market.conditionId,
    upTokenId: market.upTokenId,
    downTokenId: market.downTokenId,
    tickSize: market.tickSize,
    negRisk: market.negRisk,
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      out[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return out
}

export async function fetchPolymarketUpDown(
  tf: PolymarketTimeframe,
  limit: number,
  options: { fetchImpl?: FetchLike; nowMs?: number } = {},
): Promise<PolymarketSnapshot> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const nowMs = options.nowMs ?? Date.now()
  const safeLimit = Math.min(96, Math.max(4, Math.round(limit)))
  const starts = recentWindowStarts(tf, safeLimit, nowMs)
  const errors: string[] = []
  const inFlight = getInFlightMap(fetchImpl)

  const windows = await mapLimit(starts, CONCURRENCY, async (startTs) => {
    const slug = windowSlug(tf, startTs)
    const cached = getCachedWindow(slug, nowMs)
    if (cached) return cached

    try {
      let pending = inFlight.get(slug)
      if (!pending) {
        pending = (async () => {
          const value = await loadWindow(fetchImpl, tf, startTs, nowMs)
          const permanent = value.status === 'closed' && value.resolvedUp !== null
          const ttl = permanent
            ? CLOSED_TTL_MS
            : value.status === 'missing'
              ? MISSING_TTL_MS
              : OPEN_TTL_MS
          setCachedWindow(slug, value, nowMs + ttl, nowMs)
          return value
        })().finally(() => {
          inFlight.delete(slug)
        })
        inFlight.set(slug, pending)
      }
      return await pending
    } catch (err) {
      errors.push(`${slug}: ${err instanceof Error ? err.message : String(err)}`)
      return {
        slug,
        timeframe: tf,
        startTime: startTs * 1000,
        endTime: (startTs + STEP_SECONDS[tf]) * 1000,
        status: 'missing' as const,
        question: null,
        upPriceAtOpen: null,
        upPriceNow: null,
        bestBid: null,
        bestAsk: null,
        resolvedUp: null,
        volume: 0,
      }
    }
  })

  return {
    source: 'polymarket',
    timeframe: tf,
    fetchedAt: new Date(nowMs).toISOString(),
    windows,
    errors,
  }
}
