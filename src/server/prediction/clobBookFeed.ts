/**
 * Live Polymarket CLOB top-of-book & depth feed (`src/server/prediction/clobBookFeed.ts`).
 *
 * - Cold hydration via `GET https://clob.polymarket.com/book?token_id=<tokenId>`
 * - Real-time updates via CLOB Market WebSocket (`wss://ws-subscriptions-clob.polymarket.com/ws/market`)
 * - Computes top-5 cumulative USD depth on bids & asks (`sum(price * size)`),
 *   best bid, best ask, mid, spread, and `asOfMs` for YES (`upTokenId`) and NO (`downTokenId`).
 * - Zero simulated fallback quotes: returns `null` when missing, closed, crossed, or stale.
 */
import { POLYMARKET_FEES } from '../../predictionMarket'
import type { ExecutablePredictionQuote } from '../../market/quoteService'
import type { PredictionOutcome } from '../../predictions'
import type { PolymarketWindow } from '../polymarketAdapter'

export const DEFAULT_BOOK_STALE_MS = 10_000
export const DEFAULT_CLOB_REST_URL = 'https://clob.polymarket.com'
export const DEFAULT_CLOB_WS_URL =
  'wss://ws-subscriptions-clob.polymarket.com/ws/market'
const MAX_FUTURE_SKEW_MS = 5_000
const DEFAULT_PING_INTERVAL_MS = 10_000
const DEFAULT_RECONNECT_MIN_MS = 1_000
const DEFAULT_RECONNECT_MAX_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000

export type ClobBookSideSnapshot = {
  tokenId: string
  bestBid: number | null
  bestAsk: number | null
  mid: number | null
  spread: number | null
  bidDepthUsd: number
  askDepthUsd: number
  top5DepthUsd: number
  asOfMs: number
  source: 'clob-ws' | 'clob-rest'
}

export type WindowOrderBookSnapshot = {
  slug: string
  upTokenId: string
  downTokenId: string
  yes: ClobBookSideSnapshot | null
  no: ClobBookSideSnapshot | null
  minTop5DepthUsd: number
  capturedAtMs: number
}

export type WebSocketLike = {
  readyState: number
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: unknown) => void) | null
  send(data: string): void
  close(): void
}

export type WebSocketFactory = (url: string) => WebSocketLike

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

export type ClobBookFeedOptions = {
  fetchImpl?: FetchLike
  wsFactory?: WebSocketFactory
  nowMs?: () => number
  restBaseUrl?: string
  wsUrl?: string
  pingIntervalMs?: number
  reconnectMinMs?: number
  reconnectMaxMs?: number
  requestTimeoutMs?: number
}

type TokenBookState = {
  bids: Map<number, number>
  asks: Map<number, number>
  snapshot: ClobBookSideSnapshot
}

type TimerHandle = ReturnType<typeof setTimeout>

function roundPrice(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function toFiniteNumber(value: unknown): number | null {
  const n =
    typeof value === 'string'
      ? Number(value)
      : typeof value === 'number'
        ? value
        : NaN
  return Number.isFinite(n) ? n : null
}

function parseLevels(rawLevels: unknown): Map<number, number> {
  const map = new Map<number, number>()
  if (!Array.isArray(rawLevels)) return map
  for (const item of rawLevels) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const rawPrice = toFiniteNumber(rec.price)
    const size = toFiniteNumber(rec.size)
    if (rawPrice === null || size === null) continue
    const price = roundPrice(rawPrice)
    if (price <= 0 || price >= 1 || size <= 0) continue
    map.set(price, (map.get(price) ?? 0) + size)
  }
  return map
}

function computeSnapshot(
  tokenId: string,
  bids: Map<number, number>,
  asks: Map<number, number>,
  asOfMs: number,
  source: 'clob-ws' | 'clob-rest',
): ClobBookSideSnapshot {
  const sortedBids = Array.from(bids.entries()).sort((a, b) => b[0] - a[0])
  const sortedAsks = Array.from(asks.entries()).sort((a, b) => a[0] - b[0])

  const bestBid = sortedBids.length > 0 ? sortedBids[0][0] : null
  const bestAsk = sortedAsks.length > 0 ? sortedAsks[0][0] : null
  const uncrossed =
    bestBid !== null && bestAsk !== null && bestAsk >= bestBid

  const mid = uncrossed ? roundPrice((bestBid + bestAsk) / 2) : null
  const spread = uncrossed ? roundPrice(bestAsk - bestBid) : null

  const bidDepthUsd = roundUsd(
    sortedBids.slice(0, 5).reduce((sum, [p, s]) => sum + p * s, 0),
  )
  const askDepthUsd = roundUsd(
    sortedAsks.slice(0, 5).reduce((sum, [p, s]) => sum + p * s, 0),
  )
  const top5DepthUsd = roundUsd(bidDepthUsd + askDepthUsd)

  return {
    tokenId,
    bestBid,
    bestAsk,
    mid,
    spread,
    bidDepthUsd,
    askDepthUsd,
    top5DepthUsd,
    asOfMs,
    source,
  }
}

export function isBookSideStale(
  side: ClobBookSideSnapshot | null | undefined,
  nowMs: number,
  maxAgeMs = DEFAULT_BOOK_STALE_MS,
): boolean {
  if (!side || !Number.isFinite(side.asOfMs)) return true
  const ageMs = nowMs - side.asOfMs
  return ageMs > maxAgeMs || -ageMs > MAX_FUTURE_SKEW_MS
}

export function toExecutableQuote(
  window: PolymarketWindow,
  outcome: PredictionOutcome,
  bookSnapshot: WindowOrderBookSnapshot | null | undefined,
  nowMs = Date.now(),
  options?: { maxAgeMs?: number },
): ExecutablePredictionQuote | null {
  if (window.status !== 'open' || !bookSnapshot) return null
  if (
    window.slug &&
    bookSnapshot.slug &&
    bookSnapshot.slug !== window.slug
  ) {
    return null
  }
  const side = outcome === 'YES' ? bookSnapshot.yes : bookSnapshot.no
  if (
    !side ||
    side.bestBid === null ||
    side.bestAsk === null ||
    side.bestBid <= 0 ||
    side.bestAsk >= 1 ||
    side.bestBid > side.bestAsk
  ) {
    return null
  }

  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_BOOK_STALE_MS
  if (isBookSideStale(side, nowMs, maxAgeMs)) {
    return null
  }

  return {
    instrumentId: window.slug,
    outcome,
    bid: side.bestBid,
    ask: side.bestAsk,
    mid: side.mid ?? roundPrice((side.bestBid + side.bestAsk) / 2),
    spread: side.spread ?? roundPrice(side.bestAsk - side.bestBid),
    asOfMs: side.asOfMs,
    source: 'polymarket-clob',
    category: 'crypto',
    takerFeeRate: POLYMARKET_FEES.crypto.takerFeeRate,
    tokenId: side.tokenId,
    conditionId: window.conditionId ?? undefined,
    tickSize: window.tickSize ?? 0.01,
    negRisk: window.negRisk ?? false,
  }
}

export class ClobBookFeedService {
  private readonly fetchImpl: FetchLike
  private readonly wsFactory: WebSocketFactory
  private readonly nowMs: () => number
  private readonly restBaseUrl: string
  private readonly wsUrl: string
  private readonly pingIntervalMs: number
  private readonly reconnectMinMs: number
  private readonly reconnectMaxMs: number
  private readonly requestTimeoutMs: number

  private readonly books = new Map<string, TokenBookState>()
  private readonly subscribedTokens = new Set<string>()
  private ws: WebSocketLike | null = null
  private pingTimer: TimerHandle | null = null
  private reconnectTimer: TimerHandle | null = null
  private reconnectAttempts = 0
  private lastMessageAtMs: number | null = null
  private lastError: string | null = null
  private disposed = false

  constructor(options: ClobBookFeedOptions = {}) {
    this.fetchImpl =
      options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    this.wsFactory =
      options.wsFactory ??
      ((url: string) => new WebSocket(url) as unknown as WebSocketLike)
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.restBaseUrl = (options.restBaseUrl ?? DEFAULT_CLOB_REST_URL).replace(
      /\/+$/,
      '',
    )
    this.wsUrl = options.wsUrl ?? DEFAULT_CLOB_WS_URL
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS
    this.reconnectMinMs = options.reconnectMinMs ?? DEFAULT_RECONNECT_MIN_MS
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  getTokenSnapshot(tokenId: string): ClobBookSideSnapshot | null {
    return this.books.get(tokenId)?.snapshot ?? null
  }

  getWindowSnapshot(
    window: Pick<PolymarketWindow, 'slug' | 'upTokenId' | 'downTokenId'>,
  ): WindowOrderBookSnapshot {
    const upTokenId = window.upTokenId ?? ''
    const downTokenId = window.downTokenId ?? ''
    const yes = upTokenId ? this.getTokenSnapshot(upTokenId) : null
    const no = downTokenId ? this.getTokenSnapshot(downTokenId) : null
    const minTop5DepthUsd =
      yes && no ? roundUsd(Math.min(yes.top5DepthUsd, no.top5DepthUsd)) : 0
    const capturedAtMs =
      yes || no
        ? Math.max(yes?.asOfMs ?? 0, no?.asOfMs ?? 0)
        : this.nowMs()

    return {
      slug: window.slug,
      upTokenId,
      downTokenId,
      yes,
      no,
      minTop5DepthUsd,
      capturedAtMs,
    }
  }

  async hydrateToken(tokenId: string): Promise<ClobBookSideSnapshot | null> {
    const cleanId = tokenId.trim()
    if (!cleanId) return null
    const requestStartedAtMs = this.nowMs()
    const controller = new AbortController()
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.requestTimeoutMs,
    )
    try {
      const res = await this.fetchImpl(
        `${this.restBaseUrl}/book?token_id=${encodeURIComponent(cleanId)}`,
        { signal: controller.signal },
      )
      if (!res.ok) {
        this.lastError = `CLOB REST /book HTTP ${res.status} for ${cleanId}`
        return null
      }
      const raw = await res.json()
      if (!raw || typeof raw !== 'object') {
        this.lastError = `CLOB REST /book malformed response for ${cleanId}`
        return null
      }
      const existing = this.books.get(cleanId)
      if (
        existing &&
        ((existing.snapshot.source === 'clob-ws' &&
          existing.snapshot.asOfMs >= requestStartedAtMs) ||
          existing.snapshot.asOfMs > requestStartedAtMs)
      ) {
        return existing.snapshot
      }
      const rec = raw as Record<string, unknown>
      const bids = parseLevels(rec.bids ?? rec.buys)
      const asks = parseLevels(rec.asks ?? rec.sells)
      const snapshot = computeSnapshot(
        cleanId,
        bids,
        asks,
        requestStartedAtMs,
        'clob-rest',
      )
      this.books.set(cleanId, { bids, asks, snapshot })
      return snapshot
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      return null
    } finally {
      clearTimeout(timeoutId)
    }
  }

  async hydrateWindow(
    window: PolymarketWindow,
  ): Promise<WindowOrderBookSnapshot> {
    const tasks: Promise<ClobBookSideSnapshot | null>[] = []
    if (window.upTokenId) tasks.push(this.hydrateToken(window.upTokenId))
    if (window.downTokenId) tasks.push(this.hydrateToken(window.downTokenId))
    await Promise.all(tasks)
    return this.getWindowSnapshot(window)
  }

  subscribeTokens(tokenIds: readonly string[]): void {
    if (this.disposed) return
    const added: string[] = []
    for (const rawId of tokenIds) {
      const id = rawId.trim()
      if (!id || this.subscribedTokens.has(id)) continue
      this.subscribedTokens.add(id)
      added.push(id)
    }
    if (this.subscribedTokens.size === 0) return

    if (!this.ws) {
      this.connectWs()
      return
    }
    if (this.ws.readyState === 1 && added.length > 0) {
      try {
        this.ws.send(
          JSON.stringify({ assets_ids: added, operation: 'subscribe' }),
        )
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err)
      }
    }
  }

  subscribeWindows(windows: readonly PolymarketWindow[]): void {
    const ids: string[] = []
    for (const w of windows) {
      if (w.upTokenId) ids.push(w.upTokenId)
      if (w.downTokenId) ids.push(w.downTokenId)
    }
    this.subscribeTokens(ids)
  }

  ingestWsMessage(rawMessage: unknown, receivedAtMs = this.nowMs()): void {
    this.lastMessageAtMs = receivedAtMs

    let parsed: unknown = rawMessage
    if (typeof rawMessage === 'string') {
      const trimmed = rawMessage.trim()
      if (!trimmed || trimmed === 'PONG' || trimmed === 'PING') return
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        return
      }
    }

    const events = Array.isArray(parsed) ? parsed : [parsed]
    for (const evt of events) {
      if (!evt || typeof evt !== 'object') continue
      const rec = evt as Record<string, unknown>
      const eventType =
        typeof rec.event_type === 'string'
          ? rec.event_type
          : typeof rec.type === 'string'
            ? rec.type
            : ''

      if (eventType === 'book') {
        const assetId =
          typeof rec.asset_id === 'string'
            ? rec.asset_id.trim()
            : typeof rec.token_id === 'string'
              ? rec.token_id.trim()
              : ''
        if (!assetId) continue
        const bids = parseLevels(rec.bids ?? rec.buys)
        const asks = parseLevels(rec.asks ?? rec.sells)
        const snapshot = computeSnapshot(
          assetId,
          bids,
          asks,
          receivedAtMs,
          'clob-ws',
        )
        this.books.set(assetId, { bids, asks, snapshot })
      } else if (eventType === 'price_change') {
        const touchedAssets = new Set<string>()
        if (Array.isArray(rec.price_changes)) {
          for (const item of rec.price_changes) {
            if (!item || typeof item !== 'object') continue
            const delta = item as Record<string, unknown>
            const assetId =
              typeof delta.asset_id === 'string' ? delta.asset_id.trim() : ''
            if (!assetId) continue
            if (
              this.applyLevelDelta(
                assetId,
                delta.side,
                delta.price,
                delta.size,
                receivedAtMs,
              )
            ) {
              touchedAssets.add(assetId)
            }
          }
        }
        if (typeof rec.asset_id === 'string' && Array.isArray(rec.changes)) {
          const assetId = rec.asset_id.trim()
          if (assetId) {
            for (const item of rec.changes) {
              if (!item || typeof item !== 'object') continue
              const delta = item as Record<string, unknown>
              if (
                this.applyLevelDelta(
                  assetId,
                  delta.side,
                  delta.price,
                  delta.size,
                  receivedAtMs,
                )
              ) {
                touchedAssets.add(assetId)
              }
            }
          }
        }

        for (const assetId of touchedAssets) {
          const state = this.books.get(assetId)
          if (!state) continue
          state.snapshot = computeSnapshot(
            assetId,
            state.bids,
            state.asks,
            receivedAtMs,
            'clob-ws',
          )
        }
      }
    }
  }

  getStatus(): {
    connected: boolean
    subscribedTokenCount: number
    cachedTokenCount: number
    reconnectAttempts: number
    lastMessageAtMs: number | null
    lastError: string | null
  } {
    return {
      connected: this.ws?.readyState === 1,
      subscribedTokenCount: this.subscribedTokens.size,
      cachedTokenCount: this.books.size,
      reconnectAttempts: this.reconnectAttempts,
      lastMessageAtMs: this.lastMessageAtMs,
      lastError: this.lastError,
    }
  }

  close(): void {
    this.disposed = true
    this.clearTimers()
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onerror = null
      this.ws.onclose = null
      try {
        this.ws.close()
      } catch {
        // ignore close errors during teardown
      }
      this.ws = null
    }
  }

  private applyLevelDelta(
    assetId: string,
    rawSide: unknown,
    rawPrice: unknown,
    rawSize: unknown,
    receivedAtMs: number,
  ): boolean {
    const sideStr =
      typeof rawSide === 'string' ? rawSide.trim().toUpperCase() : ''
    if (sideStr !== 'BUY' && sideStr !== 'SELL') return false

    const priceNum = toFiniteNumber(rawPrice)
    const sizeNum = toFiniteNumber(rawSize)
    if (priceNum === null || sizeNum === null) return false
    const price = roundPrice(priceNum)
    if (price <= 0 || price >= 1) return false

    let state = this.books.get(assetId)
    if (!state) {
      const bids = new Map<number, number>()
      const asks = new Map<number, number>()
      state = {
        bids,
        asks,
        snapshot: computeSnapshot(assetId, bids, asks, receivedAtMs, 'clob-ws'),
      }
      this.books.set(assetId, state)
    }

    const bookMap = sideStr === 'BUY' ? state.bids : state.asks
    if (sizeNum <= 0) {
      bookMap.delete(price)
    } else {
      bookMap.set(price, sizeNum)
    }
    return true
  }

  private connectWs(): void {
    if (this.disposed || this.ws) return
    this.clearReconnectTimer()

    let socket: WebSocketLike
    try {
      socket = this.wsFactory(this.wsUrl)
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.scheduleReconnect()
      return
    }

    this.ws = socket

    socket.onopen = () => {
      if (this.disposed || this.ws !== socket) return
      this.reconnectAttempts = 0
      this.lastError = null
      try {
        socket.send(
          JSON.stringify({
            assets_ids: Array.from(this.subscribedTokens),
            type: 'market',
          }),
        )
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err)
      }
      this.startPingTimer(socket)
    }

    socket.onmessage = (event) => {
      if (this.disposed || this.ws !== socket) return
      this.ingestWsMessage(event.data, this.nowMs())
    }

    socket.onerror = () => {
      if (this.disposed || this.ws !== socket) return
      this.lastError = 'CLOB WebSocket transport error'
    }

    socket.onclose = () => {
      if (this.ws === socket) {
        this.ws = null
      }
      this.clearPingTimer()
      if (!this.disposed && this.subscribedTokens.size > 0) {
        this.scheduleReconnect()
      }
    }
  }

  private startPingTimer(socket: WebSocketLike): void {
    this.clearPingTimer()
    const timer = setInterval(() => {
      if (this.disposed || this.ws !== socket) return
      if (socket.readyState === 1) {
        try {
          socket.send('PING')
        } catch {
          // ignore send errors; onclose handles reconnect
        }
      }
    }, this.pingIntervalMs)
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      ;(timer as { unref: () => void }).unref()
    }
    this.pingTimer = timer
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return
    const baseDelay = Math.min(
      this.reconnectMaxMs,
      this.reconnectMinMs * 2 ** this.reconnectAttempts,
    )
    const delayMs = Math.max(
      50,
      Math.round(baseDelay * (0.8 + 0.2 * Math.random())),
    )
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 10)
    const timer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.disposed && this.subscribedTokens.size > 0) {
        this.connectWs()
      }
    }, delayMs)
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      ;(timer as { unref: () => void }).unref()
    }
    this.reconnectTimer = timer
  }

  private clearPingTimer(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearTimers(): void {
    this.clearPingTimer()
    this.clearReconnectTimer()
  }
}

let singletonFeed: ClobBookFeedService | null = null

export function getClobBookFeed(): ClobBookFeedService {
  if (!singletonFeed) {
    singletonFeed = new ClobBookFeedService()
  }
  return singletonFeed
}

export function resetClobBookFeed(): void {
  if (singletonFeed) {
    singletonFeed.close()
    singletonFeed = null
  }
}
