import { describe, expect, it } from 'vitest'
import {
  atr,
  bollingerBands,
  computeTechnicalSummary,
  ema,
  macd,
  rsi,
  sma,
  toHeikinAshi,
  vwap,
} from './indicators'
import { crossoverSignals } from './signals'
import type { Candle, SignalParams } from './types'

function candlesFromCloses(closes: number[]): Candle[] {
  return closes.map((close, index) => ({
    time: index * 3_600_000,
    open: close,
    high: close,
    low: close,
    close,
    volume: 0,
  }))
}

describe('sma', () => {
  it('computes the mean of the last N closes', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4])
  })

  it('returns identical values for period 1', () => {
    expect(sma([1, 2, 3], 1)).toEqual([1, 2, 3])
  })

  it('returns only nulls when insufficient data exists', () => {
    expect(sma([1, 2], 5)).toEqual([null, null])
  })
})

describe('ema', () => {
  it('seeds with SMA then applies exponential smoothing', () => {
    expect(ema([2, 4, 6, 8, 6], 3)).toEqual([null, null, 4, 6, 6])
  })

  it('returns only nulls when insufficient data exists', () => {
    expect(ema([1, 2], 5)).toEqual([null, null])
  })
})

describe('rsi', () => {
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89,
    46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
  ]

  it('matches hand-calculated initial Wilder RSI value', () => {
    expect(rsi(closes, 14)[14]).toBeCloseTo(70.46, 1)
  })

  it('applies Wilder smoothing on the second value', () => {
    expect(rsi(closes, 14)[15]).toBeCloseTo(66.25, 1)
  })

  it('returns null before enough warmup candles accumulate', () => {
    expect(rsi([1, 2, 3], 14)).toEqual([null, null, null])
  })

  it('returns 50 on a flat price series', () => {
    expect(rsi(new Array(20).fill(10), 14)[19]).toBe(50)
  })

  it('returns 100 on a strictly rising series', () => {
    const rising = Array.from({ length: 20 }, (_, index) => index)
    expect(rsi(rising, 14)[19]).toBe(100)
  })

  it('returns 0 on a strictly falling series', () => {
    const falling = Array.from({ length: 20 }, (_, index) => 20 - index)
    expect(rsi(falling, 14)[19]).toBe(0)
  })
})

describe('crossoverSignals', () => {
  const params: SignalParams = { fastPeriod: 2, slowPeriod: 3, average: 'sma' }
  const closes = [10, 10, 10, 10, 9, 8, 7, 8, 9, 10, 11, 12, 11, 10, 9]

  it('detects a sell, a buy, and another sell crossover', () => {
    const signals = crossoverSignals(candlesFromCloses(closes), params)

    expect(signals.map((signal) => [signal.index, signal.side])).toEqual([
      [4, 'sell'],
      [8, 'buy'],
      [13, 'sell'],
    ])
  })

  it('emits no signals on a flat price series', () => {
    const flat = new Array(10).fill(5)
    expect(crossoverSignals(candlesFromCloses(flat), params)).toEqual([])
  })

  it('has zero lookahead bias', () => {
    const full = crossoverSignals(candlesFromCloses(closes), params)
    const partial = crossoverSignals(candlesFromCloses(closes.slice(0, 10)), params)

    expect(full.filter((signal) => signal.index < 10)).toEqual(partial)
  })
})

describe('360-candle spectrum with 50-bar pre-warmup (zero gaps in chart)', () => {
  it('ensures SMA 50, EMA 50, and RSI 14 have zero nulls across visible window [50..360]', () => {
    const closes = Array.from(
      { length: 360 },
      (_, i) => 85000 + Math.sin(i / 6) * 450 + i * 2,
    )
    const warmupBars = 50
    const sma50Visible = sma(closes, 50).slice(warmupBars)
    const ema50Visible = ema(closes, 50).slice(warmupBars)
    const rsi14Visible = rsi(closes, 14).slice(warmupBars)

    expect(sma50Visible).toHaveLength(310)
    expect(ema50Visible).toHaveLength(310)
    expect(rsi14Visible).toHaveLength(310)

    expect(sma50Visible.every((v) => v !== null && Number.isFinite(v))).toBe(true)
    expect(ema50Visible.every((v) => v !== null && Number.isFinite(v))).toBe(true)
    expect(rsi14Visible.every((v) => v !== null && Number.isFinite(v))).toBe(true)
  })
})

describe('studio indicators (BB, MACD, VWAP, ATR, Heikin Ashi, Technical Summary)', () => {
  it('computes Bollinger Bands with upper > basis > lower', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5)
    const bb = bollingerBands(closes, 20, 2)
    expect(bb.basis[18]).toBeNull()
    expect(bb.upper[29]).not.toBeNull()
    expect(bb.lower[29]).not.toBeNull()
    expect(bb.upper[29]!).toBeGreaterThan(bb.basis[29]!)
    expect(bb.lower[29]!).toBeLessThan(bb.basis[29]!)
  })

  it('computes MACD, signal line, and histogram matching macd - signal', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.8)
    const res = macd(closes, 12, 26, 9)
    expect(res.macd[24]).toBeNull()
    expect(res.macd[25]).not.toBeNull()
    expect(res.signal[33]).not.toBeNull()
    expect(res.histogram[59]).toBeCloseTo(
      res.macd[59]! - res.signal[59]!,
      8,
    )
  })

  it('computes session VWAP and resets at UTC day boundaries', () => {
    const day0 = Date.UTC(2026, 0, 1, 12, 0)
    const day1 = Date.UTC(2026, 0, 2, 0, 0)
    const sample: Candle[] = [
      { time: day0, open: 100, high: 102, low: 98, close: 100, volume: 10 },
      { time: day1, open: 200, high: 203, low: 197, close: 200, volume: 5 },
    ]
    const out = vwap(sample)
    expect(out[0]).toBeCloseTo(100, 6)
    expect(out[1]).toBeCloseTo(200, 6)
  })

  it('computes Wilder ATR(14) and transforms candles to Heikin Ashi', () => {
    const series: Candle[] = Array.from({ length: 45 }, (_, i) => ({
      time: i * 900_000,
      open: 100 + i,
      high: 103 + i,
      low: 99 + i,
      close: 102 + i,
      volume: 25 + i,
    }))
    const atr14 = atr(series, 14)
    expect(atr14[13]).toBeNull()
    expect(atr14[14]).toBeGreaterThan(0)

    const ha = toHeikinAshi(series)
    expect(ha).toHaveLength(series.length)
    expect(ha[0].close).toBeCloseTo((100 + 103 + 99 + 102) / 4, 6)
    expect(ha[1].high).toBeGreaterThanOrEqual(Math.max(ha[1].open, ha[1].close))
  })

  it('produces a valid technical consensus summary on an uptrend', () => {
    const rising = Array.from({ length: 80 }, (_, i) => ({
      time: i * 900_000,
      open: 100 + i * 2,
      high: 102 + i * 2,
      low: 99 + i * 2,
      close: 101.5 + i * 2,
      volume: 100,
    }))
    const summary = computeTechnicalSummary(rising, {
      fastPeriod: 9,
      slowPeriod: 20,
      average: 'ema',
    })
    expect(summary).not.toBeNull()
    expect(summary!.score).toBeGreaterThan(0)
    expect(summary!.oscillators.length).toBeGreaterThanOrEqual(4)
  })
})
