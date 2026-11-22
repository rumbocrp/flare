/**
 * Read-only adapter for Polymarket "Bitcoin Up or Down" markets.
 *
 * - Discovery: Gamma API `markets?slug=btc-updown-{5m|15m}-<startTs>` and
 *   ET-formatted hourly slugs `bitcoin-up-or-down-<month>-<day>-<year>-<hour><am|pm>-et`
 *   with Gamma `/events` fallback for `1h` (settled windows require `closed=true`).
 * - Open price: CLOB `prices-history` of UP token, last point <= window start.
 * - Resolution: `outcomePrices` = ["1","0"] (Up) or ["0","1"] (Down) once `closed`.
 *
 * Polymarket 5m/15m markets typically settle via Chainlink BTC/USD streams while
 * 1h contracts may resolve via Chainlink TWAP or Binance 1h candles.
 */

export type PolymarketTimeframe = '5m' | '15m' | '1h'

export type ResolutionSource =
  | 'chainlink-twap-60s'
  | 'binance-1h-candle'
  | 'unknown'

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
  /** Verified contract settlement source classified from Gamma metadata. */
  resolutionSource?: ResolutionSource
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
export const STEP_SECONDS: Record<PolymarketTimeframe, number> = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
}
const OPEN_TTL_MS = 15_000
const MISSING_TTL_MS = 60_000
const CLOSED_TTL_MS = 7 * 24 * 60 * 60_000
const REQUEST_TIMEOUT_MS = 8_000
const MAX_CACHE_ENTRIES = 500
const CONCURRENCY = 6
const HOURLY_TIME_MATCH_TOLERANCE_MS = 60_000
/** Grace window (seconds) to accept an opening quote published slightly after start. */
const OPEN_PRICE_GRACE_S = 20

const ET_HOUR_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  hourCycle: 'h12',
})

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

export function buildHourlySlug(startTsSeconds: number): string {
  const parts = ET_HOUR_FORMATTER.formatToParts(new Date(startTsSeconds * 1000))
  const lookup = new Map<string, string>()
  for (const part of parts) {
    lookup.set(part.type, part.value)
  }
  const month = (lookup.get('month') ?? '').toLowerCase()
  const day = lookup.get('day') ?? ''
  const year = lookup.get('year') ?? ''
  const rawHour = lookup.get('hour') ?? '12'
  const hour = rawHour === '0' ? '12' : rawHour
  const dayPeriod = (lookup.get('dayPeriod') ?? 'am').toLowerCase()
  return `bitcoin-up-or-down-${month}-${day}-${year}-${hour}${dayPeriod}-et`
}

function windowSlug(tf: PolymarketTimeframe, startTs: number): string {
  return tf === '1h' ? buildHourlySlug(startTs) : `btc-updown-${tf}-${startTs}`
}

function cacheKey(tf: PolymarketTimeframe, startTs: number): string {
  return `${tf}:${startTs}`
}

export function classifyResolutionSource(
  resolutionSource?: unknown,
  description?: unknown,
): ResolutionSource {
  const src =
    typeof resolutionSource === 'string'
      ? resolutionSource.trim().toLowerCase()
      : ''
  const desc =
    typeof description === 'string' ? description.trim().toLowerCase() : ''

  const match = (text: string): ResolutionSource | null => {
    if (!text) return null
    if (/chainlink|data\.chain\.link|twap/.test(text)) {
      return 'chainlink-twap-60s'
    }
    if (/binance|btcusdt|1h\s*candle|1\s*hour/.test(text)) {
      return 'binance-1h-candle'
    }
    return null
  }

  return match(src) ?? match(desc) ?? 'unknown'
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
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (!trimmed) return null
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : null
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null
  }
  return null
}

function normalizeTokenId(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  if (lower === 'null' || lower === 'undefined') return null
  return trimmed
}

function parseTimeMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v < 1e11 ? v * 1000 : v
  }
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  if (!trimmed) return null
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed)
    return Number.isFinite(n) ? (n < 1e11 ? n * 1000 : n) : null
  }
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? parsed : null
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
  resolutionSource: ResolutionSource
}

export function parseGammaMarket(raw: unknown): GammaMarketFields | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const outcomes = parseJsonArray(m.outcomes).map((o) =>
    String(o).trim().toLowerCase(),
  )
  const tokens = parseJsonArray(m.clobTokenIds).map(normalizeTokenId)
  const upIndex = Math.max(0, outcomes.indexOf('up'))
  const explicitDown = outcomes.indexOf('down')
  const downIndex = explicitDown >= 0 ? explicitDown : upIndex === 0 ? 1 : 0
  const parsedTick = toNumber(m.orderPriceMinTickSize)
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
    tickSize: parsedTick !== null && parsedTick > 0 ? parsedTick : 0.01,
    negRisk: m.negRisk === true,
    resolutionSource: classifyResolutionSource(m.resolutionSource, m.description),
  }
}

function readHourlyWindowMatch(
  rawMarket: Record<string, unknown>,
  rawEvent: Record<string, unknown> | null,
  startTs: number,
): boolean | null {
  const targetStartMs = startTs * 1000
  const targetEndMs = (startTs + 3600) * 1000
  const eventStartMs =
    parseTimeMs(rawMarket.eventStartTime) ??
    parseTimeMs(rawEvent?.eventStartTime) ??
    parseTimeMs(rawEvent?.startTime)
  if (eventStartMs !== null) {
    return Math.abs(eventStartMs - targetStartMs) <= HOURLY_TIME_MATCH_TOLERANCE_MS
  }
  const endMs = parseTimeMs(rawMarket.endDate) ?? parseTimeMs(rawEvent?.endDate)
  if (endMs !== null) {
    return Math.abs(endMs - targetEndMs) <= HOURLY_TIME_MATCH_TOLERANCE_MS
  }
  const startMs =
    parseTimeMs(rawMarket.startDate) ?? parseTimeMs(rawEvent?.startDate)
  if (startMs !== null) {
    return Math.abs(startMs - targetStartMs) <= HOURLY_TIME_MATCH_TOLERANCE_MS
  }
  return null
}

function hasUpDownOutcomes(rawMarket: Record<string, unknown>): boolean {
  const outcomes = parseJsonArray(rawMarket.outcomes).map((o) =>
    String(o).trim().toLowerCase(),
  )
  return outcomes.includes('up') && outcomes.includes('down')
}

function readSlug(raw: Record<string, unknown> | null | undefined): string | null {
  if (!raw || typeof raw.slug !== 'string') return null
  const trimmed = raw.slug.trim()
  return trimmed.length > 0 ? trimmed : null
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
  getFallbackEvents: () => Promise<unknown[]>,
): Promise<PolymarketWindow> {
  const primarySlug = windowSlug(tf, startTs)
  const step = STEP_SECONDS[tf]
  const isPast = (startTs + step) * 1000 <= nowMs

  let market: GammaMarketFields | null = null
  let matchedSlug = primarySlug

  if (tf !== '1h') {
    const queries = isPast
      ? [`slug=${primarySlug}&closed=true`, `slug=${primarySlug}`]
      : [`slug=${primarySlug}`, `slug=${primarySlug}&closed=true`]
    for (const q of queries) {
      const body = await getJson(fetchImpl, `${GAMMA}/markets?${q}`)
      const first = Array.isArray(body) ? body[0] : null
      market = parseGammaMarket(first)
      if (market) break
    }
  } else {
    const altSlug = `btc-updown-1h-${startTs}`
    const slugCandidates = [primarySlug, altSlug]
    for (const candidate of slugCandidates) {
      const queries = isPast
        ? [`slug=${candidate}&closed=true`, `slug=${candidate}`]
        : [`slug=${candidate}`, `slug=${candidate}&closed=true`]
      for (const q of queries) {
        const body = await getJson(fetchImpl, `${GAMMA}/markets?${q}`)
        if (!Array.isArray(body)) continue
        for (const item of body) {
          if (!item || typeof item !== 'object') continue
          const rawObj = item as Record<string, unknown>
          if (candidate === primarySlug) {
            const timeOk = readHourlyWindowMatch(rawObj, null, startTs)
            if (timeOk === false) continue
          }
          const parsed = parseGammaMarket(rawObj)
          if (parsed) {
            market = parsed
            matchedSlug = readSlug(rawObj) ?? candidate
            break
          }
        }
        if (market) break
      }
      if (market) break
    }

    if (!market) {
      const events = await getFallbackEvents()
      for (const ev of events) {
        if (!ev || typeof ev !== 'object') continue
        const evObj = ev as Record<string, unknown>
        const evSlug = readSlug(evObj)
        const nestedMarkets = Array.isArray(evObj.markets)
          ? evObj.markets
          : [evObj]
        for (const item of nestedMarkets) {
          if (!item || typeof item !== 'object') continue
          const mObj = item as Record<string, unknown>
          if (!hasUpDownOutcomes(mObj)) continue
          const mSlug = readSlug(mObj)
          const effectiveSlug = mSlug ?? evSlug
          if (!effectiveSlug) continue

          const timeMatch = readHourlyWindowMatch(mObj, evObj, startTs)
          const matchesExact =
            effectiveSlug === altSlug ||
            (effectiveSlug === primarySlug && timeMatch !== false)
          const matchesPrefixAndTime =
            (effectiveSlug.startsWith('bitcoin-up-or-down-') ||
              effectiveSlug.startsWith('btc-updown-1h-')) &&
            timeMatch === true

          if (!matchesExact && !matchesPrefixAndTime) continue

          const parsed = parseGammaMarket(mObj)
          if (parsed) {
            market = parsed
            matchedSlug = effectiveSlug
            break
          }
        }
        if (market) break
      }
    }
  }

  const base: PolymarketWindow = {
    slug: matchedSlug,
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
    resolutionSource: 'unknown',
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
    resolutionSource: market.resolutionSource,
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

  let fallbackEventsPromise: Promise<unknown[]> | null = null
  const getFallbackEvents = (): Promise<unknown[]> => {
    if (!fallbackEventsPromise) {
      fallbackEventsPromise = getJson(
        fetchImpl,
        `${GAMMA}/events?tag_slug=bitcoin&limit=100`,
      )
        .then((res) => (Array.isArray(res) ? res : []))
        .catch(() => [])
    }
    return fallbackEventsPromise
  }

  const windows = await mapLimit(starts, CONCURRENCY, async (startTs) => {
    const slug = windowSlug(tf, startTs)
    const key = cacheKey(tf, startTs)
    const cached = getCachedWindow(key, nowMs)
    if (cached) return cached

    try {
      let pending = inFlight.get(key)
      if (!pending) {
        pending = (async () => {
          const value = await loadWindow(
            fetchImpl,
            tf,
            startTs,
            nowMs,
            getFallbackEvents,
          )
          const permanent = value.status === 'closed' && value.resolvedUp !== null
          const ttl = permanent
            ? CLOSED_TTL_MS
            : value.status === 'missing'
              ? MISSING_TTL_MS
              : OPEN_TTL_MS
          setCachedWindow(key, value, nowMs + ttl, nowMs)
          return value
        })().finally(() => {
          inFlight.delete(key)
        })
        inFlight.set(key, pending)
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
        resolutionSource: 'unknown' as const,
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
