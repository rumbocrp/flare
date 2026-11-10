import { useEffect, useState } from 'react'
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

    source
      .getCandles({ pair, interval, limit, signal: controller.signal })
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