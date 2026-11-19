/**
 * Server-side Shared Market-Data Gateway (`P1-1`).
 *
 * Eliminates per-browser-tab vendor WebSocket fanout by maintaining at most ONE
 * upstream Binance WebSocket stream per active `(pair, interval)` channel across
 * all connected clients, with:
 * - Lazy upstream startup & idle teardown when subscriber count drops to 0
 * - Exponential backoff reconnects
 * - Candle timestamp gap detection & automatic REST backfill via `candleCache`
 * - Closed-bar archival into `StateStore` (`upsertCandles`)
 */
import type { Candle, Interval } from '../../types'
import { fetchOptimizedCandles } from '../candleCache'
import { getStateStore } from '../store'

export type CandleDataSource = 'binance' | 'binance-cache'

const INTERVAL_MS_MAP: Record<Interval, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
}

function intervalToMs(interval: Interval): number {
  return INTERVAL_MS_MAP[interval] ?? 15 * 60_000
}

export type GatewayStreamStatus =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'degraded'
  | 'closed'

export type MarketGatewayEvent =
  | {
      type: 'snapshot'
      pair: string
      interval: Interval
      source: CandleDataSource
      candles: Candle[]
      status: GatewayStreamStatus
    }
  | {
      type: 'candle'
      pair: string
      interval: Interval
      candle: Candle
      isClosed: boolean
      gapRecovered?: boolean
    }
  | {
      type: 'status'
      pair: string
      interval: Interval
      status: GatewayStreamStatus
    }

export type MarketGatewayListener = (event: MarketGatewayEvent) => void

export interface WebSocketLike {
  readyState: number
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: unknown) => void) | null
  close(): void
}

export type WebSocketFactory = (url: string) => WebSocketLike

export type MarketGatewayMetrics = {
  activeChannels: number
  totalSubscribers: number
  upstreamConnects: number
  barsIngested: number
  gapsRecovered: number
  channels: {
    key: string
    pair: string
    interval: Interval
    subscribers: number
    status: GatewayStreamStatus
    lastBarTime: number | null
  }[]
}

const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/ws'
const MAX_CHANNEL_BARS = 1_000
const RECONNECT_BASE_MS = 1_500
const RECONNECT_MAX_MS = 30_000

type BinanceWsKlinePayload = {
  k?: {
    t: number
    o: string
    h: string
    l: string
    c: string
    v: string
    x: boolean
  }
}

type ChannelState = {
  key: string
  pair: string
  interval: Interval
  intervalMs: number
  subscribers: Set<MarketGatewayListener>
  status: GatewayStreamStatus
  bars: Candle[]
  lastBarTime: number | null
  ws: WebSocketLike | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectAttempt: number
  backfillInFlight: boolean
  disposed: boolean
}

function pairToBinanceStream(pair: string, interval: Interval): string {
  const symbol = pair.replace('/', '').toLowerCase()
  return `${BINANCE_WS_BASE}/${symbol}@kline_${interval}`
}

function mergeBar(bars: Candle[], incoming: Candle): Candle[] {
  if (bars.length === 0) return [incoming]
  const last = bars[bars.length - 1]
  if (incoming.time === last.time) {
    const next = bars.slice()
    next[next.length - 1] = incoming
    return next
  }
  if (incoming.time > last.time) {
    const next = [...bars, incoming]
    return next.length > MAX_CHANNEL_BARS
      ? next.slice(next.length - MAX_CHANNEL_BARS)
      : next
  }
  return bars
}

function defaultWsFactory(url: string): WebSocketLike {
  const Ctor = globalThis.WebSocket as
    | (new (u: string) => WebSocketLike)
    | undefined
  if (!Ctor) {
    throw new Error('Global WebSocket is unavailable in this Node runtime.')
  }
  return new Ctor(url)
}

export class SharedMarketDataGateway {
  private readonly channels = new Map<string, ChannelState>()
  private wsFactory: WebSocketFactory
  private upstreamConnects = 0
  private barsIngested = 0
  private gapsRecovered = 0

  constructor(wsFactory: WebSocketFactory = defaultWsFactory) {
    this.wsFactory = wsFactory
  }

  setWebSocketFactory(factory: WebSocketFactory): void {
    this.wsFactory = factory
  }

  private keyOf(pair: string, interval: Interval): string {
    return `${pair.toUpperCase()}|${interval}`
  }

  async getCandles(
    pair: string,
    interval: Interval,
    limit = 250,
    options?: { forceRefresh?: boolean },
  ): Promise<{
    candles: Candle[]
    source: CandleDataSource
    latencyMs: number
  }> {
    const result = await fetchOptimizedCandles(pair, interval, limit, options)

    // Persist live candles asynchronously into the time-series archive
    if (result.candles.length > 0) {
      void getStateStore()
        .upsertCandles(pair, interval, result.candles)
        .catch(() => {})
    }

    const ch = this.channels.get(this.keyOf(pair, interval))
    if (ch && result.candles.length > 0) {
      ch.bars = result.candles.slice(-MAX_CHANNEL_BARS)
      ch.lastBarTime = ch.bars[ch.bars.length - 1]?.time ?? ch.lastBarTime
    }

    return result
  }

  private emit(channel: ChannelState, event: MarketGatewayEvent): void {
    for (const listener of channel.subscribers) {
      try {
        listener(event)
      } catch {
        // Isolate subscriber callback errors
      }
    }
  }

  private setStatus(
    channel: ChannelState,
    status: GatewayStreamStatus,
  ): void {
    if (channel.status === status) return
    channel.status = status
    this.emit(channel, {
      type: 'status',
      pair: channel.pair,
      interval: channel.interval,
      status,
    })
  }

  private async recoverGap(channel: ChannelState): Promise<void> {
    if (channel.backfillInFlight || channel.disposed) return
    channel.backfillInFlight = true
    try {
      const { candles, source } = await fetchOptimizedCandles(
        channel.pair,
        channel.interval,
        200,
        { forceRefresh: true },
      )
      if (channel.disposed || candles.length === 0) return
      channel.bars = candles.slice(-MAX_CHANNEL_BARS)
      channel.lastBarTime = channel.bars[channel.bars.length - 1]?.time ?? null
      this.gapsRecovered += 1
      void getStateStore()
        .upsertCandles(channel.pair, channel.interval, candles)
        .catch(() => {})
      this.emit(channel, {
        type: 'snapshot',
        pair: channel.pair,
        interval: channel.interval,
        source,
        candles: channel.bars,
        status: channel.status,
      })
    } catch {
      if (!channel.disposed) {
        this.setStatus(channel, 'degraded')
      }
    } finally {
      channel.backfillInFlight = false
    }
  }

  private openUpstream(channel: ChannelState): void {
    if (channel.disposed || channel.subscribers.size === 0) return
    this.setStatus(
      channel,
      channel.reconnectAttempt === 0 ? 'connecting' : 'reconnecting',
    )

    let ws: WebSocketLike
    try {
      ws = this.wsFactory(pairToBinanceStream(channel.pair, channel.interval))
      this.upstreamConnects += 1
    } catch {
      this.setStatus(channel, 'degraded')
      return
    }

    channel.ws = ws

    ws.onopen = () => {
      if (channel.disposed || channel.ws !== ws) return
      channel.reconnectAttempt = 0
      this.setStatus(channel, 'live')
    }

    ws.onmessage = (event) => {
      if (channel.disposed || channel.ws !== ws) return
      try {
        const raw =
          typeof event.data === 'string'
            ? event.data
            : String(event.data ?? '')
        const parsed = JSON.parse(raw) as BinanceWsKlinePayload
        const k = parsed.k
        if (!k) return

        const candle: Candle = {
          time: Number(k.t),
          open: Number(k.o),
          high: Number(k.h),
          low: Number(k.l),
          close: Number(k.c),
          volume: Number(k.v),
        }
        if (
          !Number.isFinite(candle.time) ||
          !Number.isFinite(candle.open) ||
          !Number.isFinite(candle.close)
        ) {
          return
        }

        const prevTime = channel.lastBarTime
        const gapDetected =
          prevTime !== null &&
          candle.time > prevTime + channel.intervalMs * 1.5

        channel.bars = mergeBar(channel.bars, candle)
        channel.lastBarTime = candle.time
        this.barsIngested += 1

        if (k.x) {
          void getStateStore()
            .upsertCandles(channel.pair, channel.interval, [candle])
            .catch(() => {})
        }

        this.emit(channel, {
          type: 'candle',
          pair: channel.pair,
          interval: channel.interval,
          candle,
          isClosed: Boolean(k.x),
          gapRecovered: gapDetected || undefined,
        })

        if (gapDetected) {
          void this.recoverGap(channel)
        }
      } catch {
        // Ignore malformed frame
      }
    }

    ws.onerror = () => {
      if (channel.disposed || channel.ws !== ws) return
      this.setStatus(channel, 'degraded')
    }

    ws.onclose = () => {
      if (channel.ws === ws) {
        channel.ws = null
      }
      if (channel.disposed || channel.subscribers.size === 0) return
      const delay = Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_BASE_MS * 2 ** Math.min(channel.reconnectAttempt, 5),
      )
      channel.reconnectAttempt += 1
      this.setStatus(channel, 'reconnecting')
      channel.reconnectTimer = setTimeout(() => {
        channel.reconnectTimer = null
        this.openUpstream(channel)
      }, delay)
      channel.reconnectTimer.unref?.()
    }
  }

  private teardownChannel(channel: ChannelState): void {
    channel.disposed = true
    if (channel.reconnectTimer) {
      clearTimeout(channel.reconnectTimer)
      channel.reconnectTimer = null
    }
    if (channel.ws) {
      try {
        channel.ws.close()
      } catch {
        // Ignore close errors
      }
      channel.ws = null
    }
    channel.status = 'closed'
    this.channels.delete(channel.key)
  }

  /**
   * Subscribes to shared real-time updates for `(pair, interval)`.
   * Opens at most one upstream stream per channel regardless of subscriber count.
   */
  subscribe(
    pair: string,
    interval: Interval,
    listener: MarketGatewayListener,
  ): () => void {
    const key = this.keyOf(pair, interval)
    let channel = this.channels.get(key)
    if (!channel) {
      channel = {
        key,
        pair: pair.toUpperCase(),
        interval,
        intervalMs: intervalToMs(interval),
        subscribers: new Set(),
        status: 'connecting',
        bars: [],
        lastBarTime: null,
        ws: null,
        reconnectTimer: null,
        reconnectAttempt: 0,
        backfillInFlight: false,
        disposed: false,
      }
      this.channels.set(key, channel)
      channel.subscribers.add(listener)
      this.openUpstream(channel)
    } else {
      channel.subscribers.add(listener)
      listener({
        type: 'status',
        pair: channel.pair,
        interval: channel.interval,
        status: channel.status,
      })
    }

    const activeChannel = channel
    return () => {
      activeChannel.subscribers.delete(listener)
      if (activeChannel.subscribers.size === 0) {
        this.teardownChannel(activeChannel)
      }
    }
  }

  getMetrics(): MarketGatewayMetrics {
    let totalSubscribers = 0
    const channels: MarketGatewayMetrics['channels'] = []
    for (const ch of this.channels.values()) {
      totalSubscribers += ch.subscribers.size
      channels.push({
        key: ch.key,
        pair: ch.pair,
        interval: ch.interval,
        subscribers: ch.subscribers.size,
        status: ch.status,
        lastBarTime: ch.lastBarTime,
      })
    }
    return {
      activeChannels: this.channels.size,
      totalSubscribers,
      upstreamConnects: this.upstreamConnects,
      barsIngested: this.barsIngested,
      gapsRecovered: this.gapsRecovered,
      channels,
    }
  }

  closeAll(): void {
    for (const ch of Array.from(this.channels.values())) {
      this.teardownChannel(ch)
    }
  }
}

let activeGateway: SharedMarketDataGateway | null = null

export function getMarketGateway(): SharedMarketDataGateway {
  if (!activeGateway) {
    activeGateway = new SharedMarketDataGateway()
  }
  return activeGateway
}

export function resetMarketGateway(
  wsFactory?: WebSocketFactory,
): SharedMarketDataGateway {
  activeGateway?.closeAll()
  activeGateway = new SharedMarketDataGateway(wsFactory)
  return activeGateway
}
