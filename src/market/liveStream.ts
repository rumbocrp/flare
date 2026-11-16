import type { Candle, Interval } from '../types'

export type LiveStreamStatus = 'idle' | 'connecting' | 'ws' | 'poll' | 'off'

type ParsedBinanceKline = {
  symbol: string
  interval: string
  candle: Candle
  isClosed: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Converts a display pair like `BTC/USDT` to Binance symbol `BTCUSDT`. */
export function toBinanceSymbol(pair: string): string {
  return pair.replace(/\//g, '').trim().toUpperCase()
}

/** Parses a JSON payload from Binance WebSocket `kline` stream. */
export function parseBinanceKlineEvent(
  payload: unknown,
): ParsedBinanceKline | null {
  if (!isRecord(payload)) return null
  const root = isRecord(payload.data) ? payload.data : payload
  const k = root.k
  if (!isRecord(k)) return null

  const time = Number(k.t)
  const open = Number(k.o)
  const high = Number(k.h)
  const low = Number(k.l)
  const close = Number(k.c)
  const volume = Number(k.v)

  if (
    !Number.isFinite(time) ||
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close) ||
    !Number.isFinite(volume) ||
    open <= 0 ||
    high <= 0 ||
    low <= 0 ||
    close <= 0 ||
    volume < 0
  ) {
    return null
  }

  const symbol =
    typeof root.s === 'string'
      ? root.s
      : typeof k.s === 'string'
        ? k.s
        : ''
  const interval = typeof k.i === 'string' ? k.i : ''

  return {
    symbol,
    interval,
    candle: { time, open, high, low, close, volume },
    isClosed: Boolean(k.x),
  }
}

function candlesEqual(a: Candle, b: Candle): boolean {
  return (
    a.time === b.time &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume
  )
}

/**
 * Merges a live incoming candle into the series while preserving strict
 * chronological order and the configured bar limit.
 */
export function mergeLiveCandle(
  candles: Candle[],
  incoming: Candle,
  maxLimit: number,
): Candle[] {
  const limit = Math.max(1, maxLimit)
  if (candles.length === 0) return [incoming]

  const lastIndex = candles.length - 1
  const last = candles[lastIndex]

  if (incoming.time === last.time) {
    if (candlesEqual(last, incoming)) return candles
    const next = candles.slice()
    next[lastIndex] = incoming
    return next
  }

  if (incoming.time > last.time) {
    const appended = [...candles, incoming]
    return appended.length > limit
      ? appended.slice(appended.length - limit)
      : appended
  }

  for (let i = lastIndex - 1; i >= 0; i -= 1) {
    if (candles[i].time === incoming.time) {
      if (candlesEqual(candles[i], incoming)) return candles
      const next = candles.slice()
      next[i] = incoming
      return next
    }
    if (candles[i].time < incoming.time) break
  }

  return candles
}

/** Sequentially merges a short REST tail batch (used for WS reconciliation). */
export function mergeLiveCandlesBatch(
  candles: Candle[],
  batch: Candle[],
  maxLimit: number,
): Candle[] {
  if (batch.length === 0) return candles
  let next = candles
  for (const candle of batch) {
    next = mergeLiveCandle(next, candle, maxLimit)
  }
  return next
}

/**
 * Subscribes to live candles via Binance Spot WebSocket with exponential backoff.
 */
export function subscribeBinanceKlineStream(
  pair: string,
  interval: Interval,
  onCandle: (candle: Candle, isClosed: boolean) => void,
  onStatus?: (status: LiveStreamStatus) => void,
): () => void {
  if (typeof WebSocket === 'undefined') {
    onStatus?.('poll')
    return () => {}
  }

  const symbol = toBinanceSymbol(pair).toLowerCase()
  if (!/^[a-z0-9]{2,20}$/.test(symbol)) {
    onStatus?.('off')
    return () => {}
  }

  const streamUrl = `wss://stream.binance.com:9443/ws/${symbol}@kline_${interval}`
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let attempts = 0
  let disposed = false

  const clearTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  const connect = () => {
    if (disposed) return
    onStatus?.(attempts === 0 ? 'connecting' : 'poll')

    let socket: WebSocket
    try {
      socket = new WebSocket(streamUrl)
    } catch {
      onStatus?.('poll')
      scheduleReconnect()
      return
    }

    ws = socket

    socket.onopen = () => {
      if (disposed) {
        socket.close()
        return
      }
      attempts = 0
      onStatus?.('ws')
    }

    socket.onmessage = (event) => {
      if (disposed || typeof event.data !== 'string') return
      try {
        const raw = JSON.parse(event.data) as unknown
        const parsed = parseBinanceKlineEvent(raw)
        if (!parsed) return
        if (parsed.symbol && parsed.symbol.toLowerCase() !== symbol) return
        if (parsed.interval && parsed.interval !== interval) return
        onCandle(parsed.candle, parsed.isClosed)
      } catch {
        // Ignore malformed frames without interrupting the active stream
      }
    }

    socket.onerror = () => {
      try {
        socket.close()
      } catch {
        // No-op
      }
    }

    socket.onclose = () => {
      if (ws === socket) ws = null
      if (disposed) return
      onStatus?.('poll')
      scheduleReconnect()
    }
  }

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== null) return
    const delayMs = Math.min(12_000, 1_500 * 2 ** Math.min(attempts, 3))
    attempts += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delayMs)
  }

  connect()

  return () => {
    disposed = true
    clearTimer()
    if (ws) {
      try {
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        ws.close()
      } catch {
        // No-op
      }
      ws = null
    }
    onStatus?.('off')
  }
}
