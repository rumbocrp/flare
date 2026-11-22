import { describe, expect, it } from 'vitest'
import {
  appendHeikinAshiTail,
  appendLiveAnalysisTail,
  buildAnalysisPrefix,
  buildHeikinAshiPrefix,
  computeChartYDomain,
  resolveAxisTagPositions,
} from './chartRenderer'
import {
  atr,
  bollingerBands,
  ema,
  macd,
  rsi,
  sma,
  toHeikinAshi,
  vwap,
} from './indicators'
import { RSI_PERIOD, crossoverSignals } from './signals'
import type { Candle, ChartOverlay, SignalParams } from './types'

function makeCandles(count: number): Candle[] {
  const start = 1_700_000_000_000
  return Array.from({ length: count }, (_, i) => {
    const wave = Math.sin(i / 7) * 25 + Math.cos(i / 19) * 40
    const open = 500 + wave
    const close = open + Math.sin(i / 3) * 12
    const high = Math.max(open, close) + 8
    const low = Math.min(open, close) - 7
    return {
      time: start + i * 900_000,
      open,
      high,
      low,
      close,
      volume: 100 + (i % 15) * 20,
    }
  })
}

describe('chartRenderer', () => {
  it('includes EMA 50, EMA 200, VWAP, BB, order lines, and livePrice in y-domain without clipping', () => {
    const overlays: ChartOverlay[] = [
      { id: 'ema50', label: 'EMA 50', kind: 'trend', values: [120, 125] },
      { id: 'ema200', label: 'EMA 200', kind: 'ema200', values: [80, 82] },
      { id: 'vwap', label: 'VWAP', kind: 'vwap', values: [135, 138] },
      { id: 'bb-upper', label: 'BB Hi', kind: 'bb-upper', values: [115, 118] },
      { id: 'vol-sma', label: 'Vol', kind: 'vol-sma', values: [99999, 99999] },
    ]
    const domain = computeChartYDomain({
      candleMin: 98,
      candleMax: 105,
      overlays,
      orderLines: [
        { id: 'tp', kind: 'tp', price: 145, badge: 'TP', label: 'TP' },
      ],
      livePrice: 102,
      plotHeight: 360,
    })

    // Every enabled price overlay & order line is strictly inside [yMin, yMax]
    expect(domain.yMin).toBeLessThan(80)
    expect(domain.yMax).toBeGreaterThan(145)
    // Volume SMA must NOT pollute the price domain
    expect(domain.yMax).toBeLessThan(1000)
    expect(domain.ticks.length).toBeGreaterThanOrEqual(3)
  })

  it('collision-resolves clustered right-axis tags in priority order with zero overlap', () => {
    const resolved = resolveAxisTagPositions(
      [
        { id: 'crosshair', y: 120, priority: 100 },
        { id: 'last', y: 122, priority: 90 },
        { id: 'entry', y: 122, priority: 70 },
        { id: 'tp', y: 124, priority: 60 },
        { id: 'sl', y: 125, priority: 55 },
      ],
      20,
      300,
      19,
      22,
    )

    // Highest-priority tag keeps exact coordinate
    expect(resolved.get('crosshair')).toBe(120)
    // Placed tags have at least 19px separation
    const ys = Array.from(resolved.values()).sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(19)
    }
  })

  it('matches full indicator & signal computation bit-for-bit via incremental live-tail update', () => {
    const candles = makeCandles(260)
    const params: SignalParams = {
      fastPeriod: 12,
      slowPeriod: 26,
      average: 'ema',
    }
    const closed = candles.slice(0, -1)
    const live = candles[candles.length - 1]
    const prevClosed = closed[closed.length - 1]

    const cache = buildAnalysisPrefix(closed, params)
    const inc = appendLiveAnalysisTail(cache, live, prevClosed, params)

    const closes = candles.map((c) => c.close)
    const volumes = candles.map((c) => c.volume)
    const fullFast = ema(closes, params.fastPeriod)
    const fullSlow = ema(closes, params.slowPeriod)
    const fullEma50 = ema(closes, 50)
    const fullEma200 = ema(closes, 200)
    const fullBb = bollingerBands(closes, 20, 2)
    const fullVwap = vwap(candles)
    const fullVolSma = sma(volumes, 20)
    const fullAtr = atr(candles, 14)
    const fullRsi = rsi(closes, RSI_PERIOD)
    const fullMacd = macd(closes, 12, 26, 9)
    const fullSignals = crossoverSignals(candles, params)

    const last = candles.length - 1
    expect(inc.fastFull[last]).toBeCloseTo(fullFast[last]!, 10)
    expect(inc.slowFull[last]).toBeCloseTo(fullSlow[last]!, 10)
    expect(inc.ema50Full[last]).toBeCloseTo(fullEma50[last]!, 10)
    expect(inc.ema200Full[last]).toBeCloseTo(fullEma200[last]!, 10)
    expect(inc.bbFull.upper[last]).toBeCloseTo(fullBb.upper[last]!, 10)
    expect(inc.bbFull.basis[last]).toBeCloseTo(fullBb.basis[last]!, 10)
    expect(inc.bbFull.lower[last]).toBeCloseTo(fullBb.lower[last]!, 10)
    expect(inc.vwapFull[last]).toBeCloseTo(fullVwap[last]!, 10)
    expect(inc.volSmaFull[last]).toBeCloseTo(fullVolSma[last]!, 10)
    expect(inc.atrFull[last]).toBeCloseTo(fullAtr[last]!, 10)
    expect(inc.rsiFull[last]).toBeCloseTo(fullRsi[last]!, 10)
    expect(inc.macdFull.macd[last]).toBeCloseTo(fullMacd.macd[last]!, 10)
    expect(inc.macdFull.signal[last]).toBeCloseTo(fullMacd.signal[last]!, 10)
    expect(inc.macdFull.histogram[last]).toBeCloseTo(fullMacd.histogram[last]!, 10)
    expect(inc.signalsFull).toEqual(fullSignals)
  })

  it('produces exact single Heikin Ashi conversion via prefix + live tail', () => {
    const candles = makeCandles(40)
    const fullHa = toHeikinAshi(candles)
    const incHa = appendHeikinAshiTail(
      buildHeikinAshiPrefix(candles.slice(0, -1)),
      candles[candles.length - 1],
    )
    expect(incHa).toEqual(fullHa)
    // Verify single HA conversion differs from double HA conversion
    const doubleHa = toHeikinAshi(fullHa)
    const last = candles.length - 1
    expect(incHa[last].close).not.toBeCloseTo(doubleHa[last].close, 4)
  })
})
