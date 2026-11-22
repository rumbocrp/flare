/**
 * Dual BTC/USD price oracle & realized volatility service for the Polymarket
 * prediction engine.
 *
 * - Polymarket RTDS Chainlink `btc/usd` WebSocket stream (`60s` TWAP + `>= 24h` buffer)
 * - Binance public `btcusdt@aggTrade` WebSocket stream (`1s` reference + `1m` bars)
 * - Direct Binance REST `/api/v3/klines?symbol=BTCUSDT&interval=1m` volatility bootstrap
 *
 * Runtime paths return `null` when upstream data is unconnected, empty, or stale.
 */

export interface WebSocketLike {
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

export type TwapResult = {
  twap: number
  sampleCount: number
  ageMs: number
}

export type OracleSnapshot = {
  nowMs: number
  chainlinkPrice: number | null
  chainlinkTwap60s: number | null
  chainlinkUpdatedAtMs: number | null
  chainlinkStaleMs: number
  binancePrice: number | null
  binanceUpdatedAtMs: number | null
  binanceStaleMs: number
  basisBps: number | null
  sigma1m: number | null
  median24hSigma1m: number | null
  connectedRtds: boolean
  connectedBinance: boolean
}

export type OracleFeedOptions = {
  wsFactory?: WebSocketFactory
  fetchImpl?: FetchLike
  nowMs?: () => number
  random?: () => number
  rtdsUrl?: string
  binanceWsUrl?: string
  binanceRestUrl?: string
  rtdsPingIntervalMs?: number
  rtdsSilentTimeoutMs?: number
  binanceSilentTimeoutMs?: number
  bootstrapKlinesLimit?: number
}

type ChainlinkTick = {
  timestampMs: number
  price: number
}

type BarPoint = {
  timeMs: number
  close: number
  lastTradeMs: number
}

type TimerHandle = ReturnType<typeof setTimeout>

const RTDS_WS_URL = 'wss://ws-live-data.polymarket.com'
const BINANCE_AGG_TRADE_WS_URL =
  'wss://stream.binance.com:9443/ws/btcusdt@aggTrade'
const BINANCE_KLINES_REST_URL = 'https://api.binance.com/api/v3/klines'

const RTDS_PING_INTERVAL_MS = 5_000
const RTDS_SILENT_TIMEOUT_MS = 12_000
const BINANCE_SILENT_TIMEOUT_MS = 30_000
const WATCHDOG_POLL_MS = 1_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

const CHAINLINK_RETENTION_MS = 24 * 60 * 60_000 + 120_000
const MAX_CHAINLINK_TICKS = 200_000
const MAX_1S_BARS = 3_600
const MAX_1M_BARS = 1_500
const VOL_WINDOW_MINUTES = 60
const VOL_24H_RETURNS = 1_440
const VOL_FLOOR_MULTIPLIER = 0.35
const STALE_ORACLE_THRESHOLD_MS = 15_000
const REST_TIMEOUT_MS = 4_500
const BOOTSTRAP_KLINES_LIMIT = 500
const DEFAULT_TWAP_WINDOW_MS = 60_000
const ZOH_TERMINAL_SPAN_MS = 1_000

function defaultWsFactory(url: string): WebSocketLike {
  const Ctor = globalThis.WebSocket as
    | (new (u: string) => WebSocketLike)
    | undefined
  if (!Ctor) {
    throw new Error('Global WebSocket is unavailable in this Node runtime.')
  }
  return new Ctor(url)
}

function defaultFetchImpl(
  url: string,
  init?: { signal?: AbortSignal },
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  return fetch(url, init)
}

function unrefTimer(timer: TimerHandle): TimerHandle {
  const maybeTimer = timer as { unref?: () => void }
  maybeTimer.unref?.()
  return timer
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return null
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function toPositiveFinite(value: unknown): number | null {
  const num = toFiniteNumber(value)
  return num !== null && num > 0 ? num : null
}

function normalizeTimestampMs(raw: unknown, fallbackMs: number): number | null {
  if (raw === undefined || raw === null) return fallbackMs
  const num = toFiniteNumber(raw)
  if (num === null || num < 0) return null
  return num < 1e12 ? Math.round(num * 1_000) : Math.round(num)
}

function decodeWsMessageData(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data))
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    )
  }
  return null
}

function isBtcUsdSymbol(rawSymbol: unknown): boolean {
  if (rawSymbol === undefined || rawSymbol === null) return true
  if (typeof rawSymbol !== 'string') return false
  const normalized = rawSymbol.toLowerCase().trim()
  return normalized === 'btc/usd' || normalized === 'btcusd'
}

function sampleStdev(values: readonly number[]): number | null {
  if (values.length < 2) return null
  let sum = 0
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]
  }
  const mean = sum / values.length
  let sqDiffSum = 0
  for (let i = 0; i < values.length; i += 1) {
    const diff = values[i] - mean
    sqDiffSum += diff * diff
  }
  return Math.sqrt(sqDiffSum / (values.length - 1))
}

function computeMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

export class OracleFeedService {
  private readonly wsFactory: WebSocketFactory
  private readonly fetchImpl: FetchLike
  private readonly nowMs: () => number
  private readonly random: () => number
  private readonly rtdsUrl: string
  private readonly binanceWsUrl: string
  private readonly binanceRestUrl: string
  private readonly rtdsPingIntervalMs: number
  private readonly rtdsSilentTimeoutMs: number
  private readonly binanceSilentTimeoutMs: number
  private readonly bootstrapKlinesLimit: number

  private started = false
  private sessionId = 0
  private startPromise: Promise<void> | null = null

  private rtdsWs: WebSocketLike | null = null
  private connectedRtds = false
  private rtdsAttempt = 0
  private rtdsOpenedAtMs = 0
  private lastRtdsTickAtMs: number | null = null
  private rtdsPingTimer: TimerHandle | null = null
  private rtdsWatchdogTimer: TimerHandle | null = null
  private rtdsReconnectTimer: TimerHandle | null = null

  private binanceWs: WebSocketLike | null = null
  private connectedBinance = false
  private binanceAttempt = 0
  private binanceOpenedAtMs = 0
  private lastBinanceMsgAtMs: number | null = null
  private binanceWatchdogTimer: TimerHandle | null = null
  private binanceReconnectTimer: TimerHandle | null = null

  private chainlinkTicks: ChainlinkTick[] = []
  private chainlinkPrice: number | null = null
  private chainlinkUpdatedAtMs: number | null = null

  private bars1s: BarPoint[] = []
  private bars1m: BarPoint[] = []
  private binancePrice: number | null = null
  private binanceUpdatedAtMs: number | null = null

  private volCacheDirty = true
  private volCacheMinMs: number | null = null
  private cachedSigma1m: number | null = null
  private cachedMedian24hSigma1m: number | null = null

  constructor(options: OracleFeedOptions = {}) {
    this.wsFactory = options.wsFactory ?? defaultWsFactory
    this.fetchImpl = options.fetchImpl ?? defaultFetchImpl
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.random = options.random ?? (() => Math.random())
    this.rtdsUrl = options.rtdsUrl ?? RTDS_WS_URL
    this.binanceWsUrl = options.binanceWsUrl ?? BINANCE_AGG_TRADE_WS_URL
    this.binanceRestUrl = options.binanceRestUrl ?? BINANCE_KLINES_REST_URL
    this.rtdsPingIntervalMs = options.rtdsPingIntervalMs ?? RTDS_PING_INTERVAL_MS
    this.rtdsSilentTimeoutMs =
      options.rtdsSilentTimeoutMs ?? RTDS_SILENT_TIMEOUT_MS
    this.binanceSilentTimeoutMs =
      options.binanceSilentTimeoutMs ?? BINANCE_SILENT_TIMEOUT_MS
    this.bootstrapKlinesLimit =
      options.bootstrapKlinesLimit ?? BOOTSTRAP_KLINES_LIMIT
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    if (this.started) return Promise.resolve()

    this.started = true
    const currentSession = (this.sessionId += 1)

    this.connectRtds()
    this.connectBinance()

    const pending = this.bootstrapBinanceKlines(currentSession)
      .then(() => undefined)
      .finally(() => {
        if (this.sessionId === currentSession) {
          this.startPromise = null
        }
      })
    this.startPromise = pending
    return pending
  }

  stop(): void {
    this.started = false
    this.startPromise = null
    this.sessionId += 1

    this.clearRtdsTimers()
    if (this.rtdsReconnectTimer !== null) {
      clearTimeout(this.rtdsReconnectTimer)
      this.rtdsReconnectTimer = null
    }
    this.teardownSocket(this.rtdsWs)
    this.rtdsWs = null
    this.connectedRtds = false

    this.clearBinanceTimers()
    if (this.binanceReconnectTimer !== null) {
      clearTimeout(this.binanceReconnectTimer)
      this.binanceReconnectTimer = null
    }
    this.teardownSocket(this.binanceWs)
    this.binanceWs = null
    this.connectedBinance = false
  }

  getChainlinkTickCount(): number {
    return this.chainlinkTicks.length
  }

  getOneSecondBarCount(): number {
    return this.bars1s.length
  }

  getOneMinuteBarCount(): number {
    return this.bars1m.length
  }

  ingestChainlinkTick(price: number, timestampMs: number): boolean {
    if (
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(timestampMs) ||
      timestampMs < 0
    ) {
      return false
    }

    const ticks = this.chainlinkTicks
    if (ticks.length === 0 || timestampMs > ticks[ticks.length - 1].timestampMs) {
      ticks.push({ timestampMs, price })
    } else if (timestampMs === ticks[ticks.length - 1].timestampMs) {
      ticks[ticks.length - 1].price = price
    } else {
      const idx = this.lowerBoundTicks(timestampMs)
      if (idx < ticks.length && ticks[idx].timestampMs === timestampMs) {
        ticks[idx].price = price
      } else {
        ticks.splice(idx, 0, { timestampMs, price })
      }
    }

    const latestTick = ticks[ticks.length - 1]
    const retentionCutoff = latestTick.timestampMs - CHAINLINK_RETENTION_MS
    let pruneCount = 0
    while (
      pruneCount < ticks.length &&
      ticks[pruneCount].timestampMs < retentionCutoff
    ) {
      pruneCount += 1
    }
    if (ticks.length - pruneCount > MAX_CHAINLINK_TICKS) {
      pruneCount = ticks.length - MAX_CHAINLINK_TICKS
    }
    if (pruneCount === 1) {
      ticks.shift()
    } else if (pruneCount > 1) {
      ticks.splice(0, pruneCount)
    }

    const tail = ticks[ticks.length - 1]
    this.chainlinkPrice = tail.price
    this.chainlinkUpdatedAtMs = tail.timestampMs
    return true
  }

  ingestBinanceTrade(price: number, timestampMs: number): boolean {
    if (
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(timestampMs) ||
      timestampMs < 0
    ) {
      return false
    }

    if (
      this.binanceUpdatedAtMs === null ||
      timestampMs >= this.binanceUpdatedAtMs
    ) {
      this.binancePrice = price
      this.binanceUpdatedAtMs = timestampMs
    }

    const secMs = Math.floor(timestampMs / 1_000) * 1_000
    this.upsertBar(this.bars1s, secMs, price, MAX_1S_BARS, true, timestampMs)

    const minMs = Math.floor(timestampMs / 60_000) * 60_000
    if (
      this.upsertBar(this.bars1m, minMs, price, MAX_1M_BARS, true, timestampMs)
    ) {
      this.volCacheDirty = true
    }

    return true
  }

  getTwapAt(
    targetMs: number,
    windowMs = DEFAULT_TWAP_WINDOW_MS,
  ): TwapResult | null {
    if (!Number.isFinite(targetMs) || !Number.isFinite(windowMs) || windowMs <= 0) {
      return null
    }

    const ticks = this.chainlinkTicks
    if (ticks.length === 0) return null

    const windowStartMs = targetMs - windowMs
    const startIdx = this.lowerBoundTicks(windowStartMs)
    const endIdx = this.upperBoundTicks(targetMs) - 1
    if (startIdx > endIdx || startIdx >= ticks.length || endIdx < 0) {
      return null
    }

    const lastTick = ticks[endIdx]
    const ageMs = Math.max(0, targetMs - lastTick.timestampMs)

    let weightedSum = 0
    let totalWeight = 0

    if (startIdx > 0 && ticks[startIdx].timestampMs > windowStartMs) {
      const prev = ticks[startIdx - 1]
      if (windowStartMs - prev.timestampMs <= STALE_ORACLE_THRESHOLD_MS) {
        const carryDt = ticks[startIdx].timestampMs - windowStartMs
        if (carryDt > 0) {
          weightedSum += prev.price * carryDt
          totalWeight += carryDt
        }
      }
    }

    for (let i = startIdx; i < endIdx; i += 1) {
      const dt = ticks[i + 1].timestampMs - ticks[i].timestampMs
      if (dt > 0) {
        weightedSum += ticks[i].price * dt
        totalWeight += dt
      }
    }

    const tailDt =
      targetMs > lastTick.timestampMs
        ? targetMs - lastTick.timestampMs
        : ZOH_TERMINAL_SPAN_MS
    weightedSum += lastTick.price * tailDt
    totalWeight += tailDt

    if (totalWeight <= 0) return null

    return {
      twap: weightedSum / totalWeight,
      sampleCount: endIdx - startIdx + 1,
      ageMs,
    }
  }

  getWindowOpenTwap(
    startTimeMs: number,
    maxAgeMs = STALE_ORACLE_THRESHOLD_MS,
  ): number | null {
    const res = this.getTwapAt(startTimeMs, DEFAULT_TWAP_WINDOW_MS)
    if (res === null || res.ageMs > maxAgeMs) return null
    return res.twap
  }

  getSnapshot(nowMs = this.nowMs()): OracleSnapshot {
    const chainlinkTwap60s =
      this.getTwapAt(nowMs, DEFAULT_TWAP_WINDOW_MS)?.twap ?? null
    const chainlinkStaleMs =
      this.chainlinkUpdatedAtMs !== null
        ? Math.max(0, nowMs - this.chainlinkUpdatedAtMs)
        : Number.POSITIVE_INFINITY
    const binanceStaleMs =
      this.binanceUpdatedAtMs !== null
        ? Math.max(0, nowMs - this.binanceUpdatedAtMs)
        : Number.POSITIVE_INFINITY
    const basisBps =
      chainlinkTwap60s !== null &&
      this.binancePrice !== null &&
      this.binancePrice > 0
        ? (Math.abs(chainlinkTwap60s - this.binancePrice) / this.binancePrice) *
          10_000
        : null

    const { sigma1m, median24hSigma1m } = this.computeVolatility(nowMs)

    return {
      nowMs,
      chainlinkPrice: this.chainlinkPrice,
      chainlinkTwap60s,
      chainlinkUpdatedAtMs: this.chainlinkUpdatedAtMs,
      chainlinkStaleMs,
      binancePrice: this.binancePrice,
      binanceUpdatedAtMs: this.binanceUpdatedAtMs,
      binanceStaleMs,
      basisBps,
      sigma1m,
      median24hSigma1m,
      connectedRtds: this.connectedRtds,
      connectedBinance: this.connectedBinance,
    }
  }

  private lowerBoundTicks(targetMs: number): number {
    const ticks = this.chainlinkTicks
    let lo = 0
    let hi = ticks.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (ticks[mid].timestampMs < targetMs) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    return lo
  }

  private upperBoundTicks(targetMs: number): number {
    const ticks = this.chainlinkTicks
    let lo = 0
    let hi = ticks.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (ticks[mid].timestampMs <= targetMs) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    return lo
  }

  private upsertBar(
    bars: BarPoint[],
    timeMs: number,
    close: number,
    maxBars: number,
    overwriteExisting: boolean,
    tradeMs = timeMs,
  ): boolean {
    if (bars.length === 0 || timeMs > bars[bars.length - 1].timeMs) {
      bars.push({ timeMs, close, lastTradeMs: tradeMs })
      if (bars.length > maxBars) {
        bars.splice(0, bars.length - maxBars)
      }
      return true
    }

    if (timeMs === bars[bars.length - 1].timeMs) {
      const tail = bars[bars.length - 1]
      if (overwriteExisting && tradeMs >= tail.lastTradeMs) {
        tail.close = close
        tail.lastTradeMs = tradeMs
        return true
      }
      return false
    }

    let lo = 0
    let hi = bars.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (bars[mid].timeMs < timeMs) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }

    if (lo < bars.length && bars[lo].timeMs === timeMs) {
      const existing = bars[lo]
      if (overwriteExisting && tradeMs >= existing.lastTradeMs) {
        existing.close = close
        existing.lastTradeMs = tradeMs
        return true
      }
      return false
    }

    bars.splice(lo, 0, { timeMs, close, lastTradeMs: tradeMs })
    if (bars.length > maxBars) {
      bars.splice(0, bars.length - maxBars)
    }
    return true
  }

  private computeVolatility(nowMs: number): {
    sigma1m: number | null
    median24hSigma1m: number | null
  } {
    const currentMinMs = Math.floor(nowMs / 60_000) * 60_000
    if (!this.volCacheDirty && this.volCacheMinMs === currentMinMs) {
      return {
        sigma1m: this.cachedSigma1m,
        median24hSigma1m: this.cachedMedian24hSigma1m,
      }
    }

    const closedBars = this.bars1m.filter((bar) => bar.timeMs < currentMinMs)
    const returns: number[] = []
    for (let i = 1; i < closedBars.length; i += 1) {
      const prev = closedBars[i - 1]
      const curr = closedBars[i]
      const gapMinutes = Math.round((curr.timeMs - prev.timeMs) / 60_000)
      if (gapMinutes >= 1 && prev.close > 0 && curr.close > 0) {
        returns.push(Math.log(curr.close / prev.close) / Math.sqrt(gapMinutes))
      }
    }

    const sigma1mRaw = sampleStdev(returns.slice(-VOL_WINDOW_MINUTES))
    let median24hSigma1m: number | null = null

    if (returns.length >= 2) {
      if (returns.length <= VOL_WINDOW_MINUTES) {
        median24hSigma1m = sigma1mRaw
      } else {
        const recent24h = returns.slice(-VOL_24H_RETURNS)
        const rollingSigmas: number[] = []
        for (
          let end = VOL_WINDOW_MINUTES;
          end <= recent24h.length;
          end += 1
        ) {
          const stdev = sampleStdev(
            recent24h.slice(end - VOL_WINDOW_MINUTES, end),
          )
          if (stdev !== null) {
            rollingSigmas.push(stdev)
          }
        }
        median24hSigma1m = computeMedian(rollingSigmas)
      }
    }

    const sigma1mEffective =
      sigma1mRaw !== null && median24hSigma1m !== null
        ? Math.max(sigma1mRaw, VOL_FLOOR_MULTIPLIER * median24hSigma1m)
        : sigma1mRaw

    this.volCacheMinMs = currentMinMs
    this.volCacheDirty = false
    this.cachedSigma1m = sigma1mEffective
    this.cachedMedian24hSigma1m = median24hSigma1m

    return {
      sigma1m: sigma1mEffective,
      median24hSigma1m,
    }
  }

  private computeBackoffMs(attempt: number): number {
    const raw = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(attempt, 5),
    )
    const jittered = Math.round(raw * (0.85 + 0.3 * this.random()))
    return Math.min(RECONNECT_MAX_MS, Math.max(RECONNECT_BASE_MS, jittered))
  }

  private teardownSocket(ws: WebSocketLike | null): void {
    if (!ws) return
    ws.onopen = null
    ws.onmessage = null
    ws.onerror = null
    ws.onclose = null
    try {
      ws.close()
    } catch {
      // Ignore close errors on already-closed sockets
    }
  }

  private clearRtdsTimers(): void {
    if (this.rtdsPingTimer !== null) {
      clearInterval(this.rtdsPingTimer)
      this.rtdsPingTimer = null
    }
    if (this.rtdsWatchdogTimer !== null) {
      clearInterval(this.rtdsWatchdogTimer)
      this.rtdsWatchdogTimer = null
    }
  }

  private clearBinanceTimers(): void {
    if (this.binanceWatchdogTimer !== null) {
      clearInterval(this.binanceWatchdogTimer)
      this.binanceWatchdogTimer = null
    }
  }

  private connectRtds(): void {
    if (!this.started) return
    this.clearRtdsTimers()
    this.teardownSocket(this.rtdsWs)

    let ws: WebSocketLike
    try {
      ws = this.wsFactory(this.rtdsUrl)
    } catch {
      this.connectedRtds = false
      this.scheduleRtdsReconnect()
      return
    }

    this.rtdsWs = ws

    ws.onopen = () => {
      if (!this.started || this.rtdsWs !== ws) return
      this.connectedRtds = true
      this.rtdsAttempt = 0
      this.rtdsOpenedAtMs = this.nowMs()

      try {
        ws.send(
          JSON.stringify({
            action: 'subscribe',
            subscriptions: [
              {
                topic: 'crypto_prices_chainlink',
                type: '*',
                filters: '{"symbol":"btc/usd"}',
              },
            ],
          }),
        )
      } catch {
        // Ignore transient send failure; watchdog/close handles reconnect
      }

      this.rtdsPingTimer = unrefTimer(
        setInterval(() => {
          if (!this.started || this.rtdsWs !== ws || ws.readyState !== 1) return
          try {
            ws.send('PING')
          } catch {
            // Ignore transient ping errors; watchdog/close triggers reconnect
          }
        }, this.rtdsPingIntervalMs),
      )

      this.rtdsWatchdogTimer = unrefTimer(
        setInterval(() => {
          this.checkRtdsSilent(ws)
        }, WATCHDOG_POLL_MS),
      )
    }

    ws.onmessage = (event) => {
      if (!this.started || this.rtdsWs !== ws) return
      this.handleRtdsMessage(event.data)
    }

    ws.onerror = () => {
      if (!this.started || this.rtdsWs !== ws) return
      this.handleRtdsDisconnect(ws)
    }

    ws.onclose = () => {
      if (!this.started || this.rtdsWs !== ws) return
      this.handleRtdsDisconnect(ws)
    }
  }

  private handleRtdsDisconnect(ws: WebSocketLike): void {
    this.clearRtdsTimers()
    if (this.rtdsWs === ws) {
      this.teardownSocket(ws)
      this.rtdsWs = null
    }
    this.connectedRtds = false
    this.scheduleRtdsReconnect()
  }

  private checkRtdsSilent(ws: WebSocketLike): void {
    if (!this.started || this.rtdsWs !== ws) return
    const refMs =
      this.lastRtdsTickAtMs !== null &&
      this.lastRtdsTickAtMs >= this.rtdsOpenedAtMs
        ? this.lastRtdsTickAtMs
        : this.rtdsOpenedAtMs
    if (this.nowMs() - refMs > this.rtdsSilentTimeoutMs) {
      this.handleRtdsDisconnect(ws)
    }
  }

  private scheduleRtdsReconnect(): void {
    if (!this.started || this.rtdsReconnectTimer !== null) return
    const delayMs = this.computeBackoffMs(this.rtdsAttempt)
    this.rtdsAttempt += 1
    this.rtdsReconnectTimer = unrefTimer(
      setTimeout(() => {
        this.rtdsReconnectTimer = null
        if (this.started) {
          this.connectRtds()
        }
      }, delayMs),
    )
  }

  private handleRtdsMessage(data: unknown): void {
    const raw = decodeWsMessageData(data)
    if (raw === null) return
    const trimmed = raw.trim()
    if (!trimmed) return

    const upper = trimmed.toUpperCase()
    if (upper === 'PONG' || upper === 'PING') return

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return
    }
    if (!isRecord(parsed)) return

    if (
      typeof parsed.type === 'string' &&
      parsed.type.toLowerCase() === 'pong'
    ) {
      return
    }

    if (
      typeof parsed.topic === 'string' &&
      parsed.topic !== 'crypto_prices_chainlink'
    ) {
      return
    }

    const payload = isRecord(parsed.payload) ? parsed.payload : parsed
    const containerSymbol = payload.symbol ?? parsed.symbol
    if (!isBtcUsdSymbol(containerSymbol)) return

    let ingestedAny = false
    if (Array.isArray(payload.data)) {
      for (const item of payload.data) {
        if (!isRecord(item)) continue
        if (!isBtcUsdSymbol(item.symbol ?? containerSymbol)) continue
        const price = toPositiveFinite(item.value ?? item.price ?? item.p)
        const ts = normalizeTimestampMs(
          item.timestamp ?? item.t ?? item.ts,
          this.nowMs(),
        )
        if (price !== null && ts !== null && this.ingestChainlinkTick(price, ts)) {
          ingestedAny = true
        }
      }
    } else {
      const price = toPositiveFinite(
        payload.value ?? payload.price ?? payload.p,
      )
      const ts = normalizeTimestampMs(
        payload.timestamp ?? payload.t ?? payload.ts ?? parsed.timestamp,
        this.nowMs(),
      )
      if (price !== null && ts !== null && this.ingestChainlinkTick(price, ts)) {
        ingestedAny = true
      }
    }

    if (ingestedAny) {
      this.lastRtdsTickAtMs = this.nowMs()
    }
  }

  private connectBinance(): void {
    if (!this.started) return
    this.clearBinanceTimers()
    this.teardownSocket(this.binanceWs)

    let ws: WebSocketLike
    try {
      ws = this.wsFactory(this.binanceWsUrl)
    } catch {
      this.connectedBinance = false
      this.scheduleBinanceReconnect()
      return
    }

    this.binanceWs = ws

    ws.onopen = () => {
      if (!this.started || this.binanceWs !== ws) return
      this.connectedBinance = true
      this.binanceAttempt = 0
      this.binanceOpenedAtMs = this.nowMs()

      this.binanceWatchdogTimer = unrefTimer(
        setInterval(() => {
          this.checkBinanceSilent(ws)
        }, WATCHDOG_POLL_MS),
      )
    }

    ws.onmessage = (event) => {
      if (!this.started || this.binanceWs !== ws) return
      this.handleBinanceMessage(event.data)
    }

    ws.onerror = () => {
      if (!this.started || this.binanceWs !== ws) return
      this.handleBinanceDisconnect(ws)
    }

    ws.onclose = () => {
      if (!this.started || this.binanceWs !== ws) return
      this.handleBinanceDisconnect(ws)
    }
  }

  private handleBinanceDisconnect(ws: WebSocketLike): void {
    this.clearBinanceTimers()
    if (this.binanceWs === ws) {
      this.teardownSocket(ws)
      this.binanceWs = null
    }
    this.connectedBinance = false
    this.scheduleBinanceReconnect()
  }

  private checkBinanceSilent(ws: WebSocketLike): void {
    if (!this.started || this.binanceWs !== ws) return
    const refMs =
      this.lastBinanceMsgAtMs !== null &&
      this.lastBinanceMsgAtMs >= this.binanceOpenedAtMs
        ? this.lastBinanceMsgAtMs
        : this.binanceOpenedAtMs
    if (this.nowMs() - refMs > this.binanceSilentTimeoutMs) {
      this.handleBinanceDisconnect(ws)
    }
  }

  private scheduleBinanceReconnect(): void {
    if (!this.started || this.binanceReconnectTimer !== null) return
    const delayMs = this.computeBackoffMs(this.binanceAttempt)
    this.binanceAttempt += 1
    this.binanceReconnectTimer = unrefTimer(
      setTimeout(() => {
        this.binanceReconnectTimer = null
        if (this.started) {
          this.connectBinance()
        }
      }, delayMs),
    )
  }

  private handleBinanceMessage(data: unknown): void {
    const raw = decodeWsMessageData(data)
    if (raw === null) return

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (!isRecord(parsed)) return

    const price = toPositiveFinite(parsed.p ?? parsed.price)
    const ts = normalizeTimestampMs(parsed.T ?? parsed.E, this.nowMs())
    if (price !== null && ts !== null && this.ingestBinanceTrade(price, ts)) {
      this.lastBinanceMsgAtMs = this.nowMs()
    }
  }

  private async bootstrapBinanceKlines(session: number): Promise<number> {
    const url = `${this.binanceRestUrl}?symbol=BTCUSDT&interval=1m&limit=${this.bootstrapKlinesLimit}`
    const controller = new AbortController()
    const timeoutId = unrefTimer(
      setTimeout(() => controller.abort(), REST_TIMEOUT_MS),
    )

    try {
      const response = await this.fetchImpl(url, { signal: controller.signal })
      if (!response.ok || session !== this.sessionId) return 0

      const payload = await response.json()
      if (!Array.isArray(payload) || session !== this.sessionId) return 0

      const now = this.nowMs()
      const currentMinMs = Math.floor(now / 60_000) * 60_000
      let inserted = 0

      for (const row of payload) {
        if (!Array.isArray(row) || row.length < 5) continue
        const openTimeMs = toFiniteNumber(row[0])
        const close = toPositiveFinite(row[4])
        const closeTimeMs = row.length >= 7 ? toFiniteNumber(row[6]) : null
        if (openTimeMs === null || openTimeMs < 0 || close === null) continue

        const minMs = Math.floor(openTimeMs / 60_000) * 60_000
        const isUnclosed =
          closeTimeMs !== null ? closeTimeMs > now : minMs >= currentMinMs
        if (isUnclosed) continue

        if (
          this.upsertBar(
            this.bars1m,
            minMs,
            close,
            MAX_1M_BARS,
            false,
            closeTimeMs ?? minMs + 59_999,
          )
        ) {
          inserted += 1
        }
      }

      if (inserted > 0) {
        this.volCacheDirty = true
      }
      return inserted
    } catch {
      return 0
    } finally {
      clearTimeout(timeoutId)
    }
  }
}

let singletonOracleFeed: OracleFeedService | null = null

export function getOracleFeed(): OracleFeedService {
  if (singletonOracleFeed === null) {
    singletonOracleFeed = new OracleFeedService()
  }
  return singletonOracleFeed
}

export function stopOracleFeedIfActive(): void {
  singletonOracleFeed?.stop()
}

export function resetOracleFeed(
  options?: OracleFeedOptions,
): OracleFeedService {
  singletonOracleFeed?.stop()
  singletonOracleFeed = new OracleFeedService(options)
  return singletonOracleFeed
}
