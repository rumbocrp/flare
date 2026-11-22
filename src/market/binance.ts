import { intervalMs } from './intervals'
import type { Candle, CandleRequest, MarketDataSource } from '../types'

const BINANCE_MAX_PER_PAGE = 1_000
const MAX_PAGINATED_BARS = 5_000

function toNumber(value: unknown): number {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    throw new Error('Exchange API returned an invalid numeric value')
  }
  return number
}

function parseKline(row: unknown): Candle {
  if (!Array.isArray(row) || row.length < 6) {
    throw new Error('Exchange API returned a malformed candle row')
  }

  return {
    time: toNumber(row[0]),
    open: toNumber(row[1]),
    high: toNumber(row[2]),
    low: toNumber(row[3]),
    close: toNumber(row[4]),
    volume: toNumber(row[5]),
  }
}

async function fetchKlinePage(params: {
  symbol: string
  interval: CandleRequest['interval']
  limit: number
  startTime?: number
  endTime?: number
  signal?: AbortSignal
}): Promise<Candle[]> {
  const qs = new URLSearchParams({
    symbol: params.symbol,
    interval: params.interval,
    limit: String(Math.min(BINANCE_MAX_PER_PAGE, Math.max(1, params.limit))),
  })
  if (params.startTime !== undefined && Number.isFinite(params.startTime)) {
    qs.set('startTime', String(Math.floor(params.startTime)))
  }
  if (params.endTime !== undefined && Number.isFinite(params.endTime)) {
    qs.set('endTime', String(Math.floor(params.endTime)))
  }
  const url = `https://api.binance.com/api/v3/klines?${qs.toString()}`
  const response = await fetch(url, { signal: params.signal })
  if (!response.ok) {
    throw new Error(`Market API responded with HTTP ${response.status}`)
  }

  const rows: unknown = await response.json()
  if (!Array.isArray(rows)) {
    throw new Error('Market API returned an unexpected payload')
  }
  return rows.map((row) => parseKline(row))
}

export const binanceSource: MarketDataSource = {
  name: 'Binance Public API',
  description: 'Live spot market candles without API keys.',

  async getCandles({ pair, interval, limit, from, to, signal }) {
    const symbol = encodeURIComponent(pair.replace('/', ''))
    const hasRange = from !== undefined || to !== undefined

    if (!hasRange && limit <= BINANCE_MAX_PER_PAGE) {
      return fetchKlinePage({
        symbol,
        interval,
        limit,
        signal,
      })
    }

    const targetMax = Math.min(
      MAX_PAGINATED_BARS,
      Math.max(1, Math.round(limit || MAX_PAGINATED_BARS)),
    )
    const stepMs = intervalMs[interval]
    const collected = new Map<number, Candle>()
    let cursorEnd = to !== undefined && Number.isFinite(to) ? Math.floor(to) : undefined
    const minStart = from !== undefined && Number.isFinite(from) ? Math.floor(from) : undefined

    const maxPages = Math.ceil(targetMax / BINANCE_MAX_PER_PAGE) + 2
    for (let page = 0; page < maxPages; page += 1) {
      const remaining = targetMax - collected.size
      if (remaining <= 0) break

      const rows = await fetchKlinePage({
        symbol,
        interval,
        limit: Math.min(BINANCE_MAX_PER_PAGE, remaining),
        startTime: minStart,
        endTime: cursorEnd,
        signal,
      })
      if (rows.length === 0) break

      let earliestTime = Infinity
      for (const c of rows) {
        if (minStart !== undefined && c.time < minStart) continue
        if (to !== undefined && c.time > to) continue
        collected.set(c.time, c)
        if (c.time < earliestTime) earliestTime = c.time
      }

      if (rows.length < BINANCE_MAX_PER_PAGE) break
      if (!Number.isFinite(earliestTime)) break
      if (minStart !== undefined && earliestTime <= minStart) break
      cursorEnd = earliestTime - stepMs
      if (minStart !== undefined && cursorEnd < minStart) break
    }

    const sorted = Array.from(collected.values()).sort((a, b) => a.time - b.time)
    if (sorted.length > targetMax) {
      return sorted.slice(sorted.length - targetMax)
    }
    return sorted
  },
}
