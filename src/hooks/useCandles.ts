import { useEffect, useRef, useState } from 'react'
import {
  fetchMarketCandlesFromGateway,
  subscribeToMarketGatewayStream,
} from '../api/botClient'
import { binanceSource } from '../market/binance'
import {
  mergeLiveCandle,
  mergeLiveCandlesBatch,
  subscribeBinanceKlineStream,
  type LiveStreamStatus,
} from '../market/liveStream'
import type {
  AsyncState,
  Candle,
  Interval,
  MarketDataSource,
} from '../types'

type Stored = {
  key: string
  state: AsyncState<Candle[]>
}

type LiveStored = {
  key: string
  state: AsyncState<Candle[]>
  streamStatus: LiveStreamStatus
  lastTickAt: number | null
}

type LiveCandlesResult = {
  state: AsyncState<Candle[]>
  streamStatus: LiveStreamStatus
  lastTickAt: number | null
}

async function fetchCandlesPreferringGateway(
  source: MarketDataSource,
  pair: string,
  interval: Interval,
  limit: number,
  signal: AbortSignal,
): Promise<Candle[]> {
  if (source === binanceSource) {
    const gateway = await fetchMarketCandlesFromGateway(
      pair,
      interval,
      limit,
      signal,
    )
    if (gateway && gateway.candles.length > 0) {
      return gateway.candles
    }
  }
  return source.getCandles({ pair, interval, limit, signal })
}

export function useCandles(
  source: MarketDataSource,
  pair: string,
  interval: Interval,
  limit: number,
  reloadKey: number,
): AsyncState<Candle[]> {
  const key = `${pair}|${interval}|${limit}|${reloadKey}`
  const [stored, setStored] = useState<Stored | null>(null)

  useEffect(() => {
    const controller = new AbortController()

    fetchCandlesPreferringGateway(
      source,
      pair,
      interval,
      limit,
      controller.signal,
    )
      .then((data) => {
        if (controller.signal.aborted) return
        setStored({ key, state: { status: 'success', data } })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const message =
          error instanceof Error ? error.message : 'Unknown error'
        setStored({ key, state: { status: 'error', message } })
      })

    return () => controller.abort()
  }, [source, pair, interval, limit, key])

  if (stored !== null && stored.key === key) return stored.state
  return { status: 'loading' }
}

const WS_RECONCILE_MS = 30_000
const REST_POLL_MS = 4_000

/**
 * Loads the initial historical series and keeps it synced in real time.
 * Prefers FLARE's shared server-side market-data gateway (`/api/market/stream`)
 * so multiple tabs reuse one upstream Binance socket, degrading cleanly to
 * direct Binance WebSocket + REST reconciliation if the backend is unavailable.
 */
export function useLiveCandles(
  source: MarketDataSource,
  pair: string,
  interval: Interval,
  limit: number,
  reloadKey: number,
): LiveCandlesResult {
  const key = `${pair}|${interval}|${limit}|${reloadKey}`
  const [stored, setStored] = useState<LiveStored | null>(null)
  const streamStatusRef = useRef<LiveStreamStatus>('idle')

  useEffect(() => {
    const controller = new AbortController()
    let unsubscribeStream: (() => void) | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let active = true
    let inFlightPoll = false
    let lastPollAt = 0

    streamStatusRef.current = source === binanceSource ? 'connecting' : 'off'

    const startDirectFallbackSync = () => {
      if (!active || source !== binanceSource) return

      unsubscribeStream = subscribeBinanceKlineStream(
        pair,
        interval,
        (candle) => {
          if (!active) return
          const now = Date.now()
          setStored((prev) => {
            if (!prev || prev.key !== key || prev.state.status !== 'success') {
              return prev
            }
            const nextCandles = mergeLiveCandle(prev.state.data, candle, limit)
            if (nextCandles === prev.state.data && prev.streamStatus === 'ws') {
              return { ...prev, lastTickAt: now }
            }
            return {
              key,
              state: { status: 'success', data: nextCandles },
              streamStatus: 'ws',
              lastTickAt: now,
            }
          })
        },
        (nextStatus) => {
          if (!active) return
          streamStatusRef.current = nextStatus
          setStored((prev) => {
            if (!prev || prev.key !== key || prev.streamStatus === nextStatus) {
              return prev
            }
            return { ...prev, streamStatus: nextStatus }
          })
        },
      )

      const tailLimit = Math.min(limit, 3)
      pollTimer = setInterval(() => {
        if (!active || inFlightPoll) return
        const now = Date.now()
        const minInterval =
          streamStatusRef.current === 'ws' ? WS_RECONCILE_MS : REST_POLL_MS
        if (now - lastPollAt < minInterval - 200) return

        inFlightPoll = true
        lastPollAt = now
        source
          .getCandles({
            pair,
            interval,
            limit: tailLimit,
            signal: controller.signal,
          })
          .then((tail) => {
            if (!active || controller.signal.aborted || tail.length === 0) {
              return
            }
            const tickAt = Date.now()
            setStored((prev) => {
              if (
                !prev ||
                prev.key !== key ||
                prev.state.status !== 'success'
              ) {
                return prev
              }
              const nextCandles = mergeLiveCandlesBatch(
                prev.state.data,
                tail,
                limit,
              )
              return {
                key,
                state: { status: 'success', data: nextCandles },
                streamStatus: prev.streamStatus,
                lastTickAt: tickAt,
              }
            })
          })
          .catch(() => {
            // Silently retry on the next reconciliation cycle
          })
          .finally(() => {
            inFlightPoll = false
          })
      }, REST_POLL_MS)
    }

    const startSharedGatewaySync = () => {
      if (!active || source !== binanceSource) return

      unsubscribeStream = subscribeToMarketGatewayStream(
        pair,
        interval,
        limit,
        (event) => {
          if (!active) return
          const now = Date.now()
          if (event.type === 'snapshot' && event.candles.length > 0) {
            streamStatusRef.current = 'ws'
            setStored({
              key,
              state: { status: 'success', data: event.candles.slice(-limit) },
              streamStatus: 'ws',
              lastTickAt: now,
            })
            return
          }
          if (event.type === 'candle') {
            streamStatusRef.current = 'ws'
            setStored((prev) => {
              if (!prev || prev.key !== key || prev.state.status !== 'success') {
                return prev
              }
              const nextCandles = mergeLiveCandle(
                prev.state.data,
                event.candle,
                limit,
              )
              return {
                key,
                state: { status: 'success', data: nextCandles },
                streamStatus: 'ws',
                lastTickAt: now,
              }
            })
            return
          }
          if (event.type === 'status') {
            const mapped: LiveStreamStatus =
              event.status === 'live'
                ? 'ws'
                : event.status === 'connecting' ||
                    event.status === 'reconnecting'
                  ? 'connecting'
                  : 'poll'
            streamStatusRef.current = mapped
            setStored((prev) =>
              prev && prev.key === key
                ? { ...prev, streamStatus: mapped }
                : prev,
            )
          }
        },
        () => {
          if (!active) return
          unsubscribeStream = null
          startDirectFallbackSync()
        },
      )
    }

    fetchCandlesPreferringGateway(
      source,
      pair,
      interval,
      limit,
      controller.signal,
    )
      .then((data) => {
        if (!active || controller.signal.aborted) return
        setStored({
          key,
          state: { status: 'success', data },
          streamStatus: source === binanceSource ? 'connecting' : 'off',
          lastTickAt: Date.now(),
        })
        startSharedGatewaySync()
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return
        const message =
          error instanceof Error ? error.message : 'Unknown error'
        setStored({
          key,
          state: { status: 'error', message },
          streamStatus: 'off',
          lastTickAt: null,
        })
      })

    return () => {
      active = false
      controller.abort()
      unsubscribeStream?.()
      if (pollTimer !== null) clearInterval(pollTimer)
    }
  }, [source, pair, interval, limit, key])

  if (stored !== null && stored.key === key) {
    return {
      state: stored.state,
      streamStatus: stored.streamStatus,
      lastTickAt: stored.lastTickAt,
    }
  }

  return {
    state: { status: 'loading' },
    streamStatus: source === binanceSource ? 'connecting' : 'off',
    lastTickAt: null,
  }
}
