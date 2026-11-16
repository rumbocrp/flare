import type { Candle, MarketDataSource } from '../types'

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

export const binanceSource: MarketDataSource = {
  name: 'Binance Public API',
  description: 'Live spot market candles without API keys.',

  async getCandles({ pair, interval, limit, signal }) {
    const symbol = encodeURIComponent(pair.replace('/', ''))
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`

    const response = await fetch(url, { signal })
    if (!response.ok) {
      throw new Error(`Market API responded with HTTP ${response.status}`)
    }

    const rows: unknown = await response.json()
    if (!Array.isArray(rows)) {
      throw new Error('Market API returned an unexpected payload')
    }

    return rows.map((row) => parseKline(row))
  },
}