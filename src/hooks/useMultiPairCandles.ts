import { useEffect, useState } from 'react'
import type {
  AsyncState,
  Candle,
  Interval,
  MarketDataSource,
} from '../types'

type MultiPairState = {
  batchKey: string
  byPair: Record<string, AsyncState<Candle[]>>
}

/**
 * Fetches recent candles in parallel for multiple pairs without simulated fallbacks.
 * Each pair updates independently as soon as the market data source responds.
 */
export function useMultiPairCandles(
  source: MarketDataSource,
  pairs: readonly string[],
  interval: Interval,
  limit: number,
  reloadKey: number,
): Record<string, AsyncState<Candle[]>> {
  const pairsKey = pairs.join(',')
  const batchKey = `${pairsKey}|${interval}|${limit}|${reloadKey}`
  const [stored, setStored] = useState<MultiPairState>({
    batchKey,
    byPair: {},
  })

  useEffect(() => {
    const controller = new AbortController()
    const targetPairs = pairsKey ? pairsKey.split(',') : []

    for (const pair of targetPairs) {
      source
        .getCandles({ pair, interval, limit, signal: controller.signal })
        .then((data) => {
          if (controller.signal.aborted) return
          setStored((prev) => {
            const base = prev.batchKey === batchKey ? prev.byPair : {}
            return {
              batchKey,
              byPair: {
                ...base,
                [pair]: { status: 'success', data },
              },
            }
          })
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          const message =
            error instanceof Error ? error.message : 'Network error'
          setStored((prev) => {
            const base = prev.batchKey === batchKey ? prev.byPair : {}
            return {
              batchKey,
              byPair: {
                ...base,
                [pair]: { status: 'error', message },
              },
            }
          })
        })
    }

    return () => controller.abort()
  }, [source, pairsKey, interval, limit, reloadKey, batchKey])

  const result: Record<string, AsyncState<Candle[]>> = {}
  for (const pair of pairs) {
    result[pair] =
      stored.batchKey === batchKey && stored.byPair[pair]
        ? stored.byPair[pair]
        : { status: 'loading' }
  }
  return result
}
