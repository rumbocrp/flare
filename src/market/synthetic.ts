import { intervalMs } from './intervals'
import type { Candle, Interval, MarketDataSource } from '../types'

const basePrices: Record<string, number> = {
  'BTC/USDT': 60000,
  'ETH/USDT': 3000,
  'SOL/USDT': 150,
}

const volatility: Record<Interval, number> = {
  '5m': 0.001,
  '15m': 0.003,
  '1h': 0.006,
  '4h': 0.012,
  '1d': 0.025,
}

const END_TIME = Date.UTC(2026, 0, 1)

function hashString(text: string): number {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export const syntheticSource: MarketDataSource = {
  name: 'Datos sintéticos',
  description: 'Velas generadas por código. No son precios reales.',

  async getCandles({ pair, interval, limit }) {
    await delay(400)

    const random = mulberry32(hashString(`${pair}|${interval}`))
    const step = intervalMs[interval]
    const range = volatility[interval]

    let price = basePrices[pair] ?? 100
    const candles: Candle[] = []

    for (let index = 0; index < limit; index++) {
      const open = round2(price)
      const close = round2(open * (1 + (random() - 0.5) * 2 * range))
      const high = round2(Math.max(open, close) * (1 + random() * range * 0.5))
      const low = round2(Math.min(open, close) * (1 - random() * range * 0.5))

      candles.push({
        time: END_TIME - (limit - index) * step,
        open,
        high: Math.max(high, open, close),
        low: Math.min(low, open, close),
        close,
        volume: Math.round(100 + random() * 900),
      })

      price = close
    }

    return candles
  },
}
