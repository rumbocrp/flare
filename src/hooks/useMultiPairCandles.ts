import { useEffect, useState } from 'react'
import { fetchMarketCandlesFromGateway } from '../api/botClient'
import { binanceSource } from '../market/binance'
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
 * Fetches recent candles in parallel for multiple pairs, preferring FLARE's
 * shared backend market-data gateway before falling back to direct source calls.
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
      const loadPair = async (): Promise<Candle[]> => {
        if (source === binanceSource) {
          const gw = await fetchMarketCandlesFromGateway(
            pair,
            interval,
            limit,
            controller.signal,
          )
          if (gw && gw.candles.length > 0) return gw.candles
        }
        return source.getCandles({
          pair,
          interval,
          limit,
          signal: controller.signal,
        })
      }

      loadPair()
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
