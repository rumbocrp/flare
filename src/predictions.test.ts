import { describe, expect, it } from 'vitest'
import { syntheticSource } from './market/synthetic'
import {
  BITCOIN_20_PREDICTIONS,
  computeWilsonLowerBoundPct,
  evaluatePredictionRule,
  evaluatePredictionRuleDetailed,
  evaluateTimeframePredictions,
} from './predictions'
import type { Interval } from './types'

describe('predictions engine (Bitcoin 20 Prediction Market Rules)', () => {
  it('contains exactly 20 rules (4 per timeframe: 5m, 15m, 1h, 4h, 1d)', () => {
    expect(BITCOIN_20_PREDICTIONS).toHaveLength(20)

    const intervals: Interval[] = ['5m', '15m', '1h', '4h', '1d']
    for (const tf of intervals) {
      const count = BITCOIN_20_PREDICTIONS.filter(
        (r) => r.timeframe === tf,
      ).length
      expect(count).toBe(4)
    }
  })

  it('penalizes small sample sizes using the 95% Wilson lower bound', () => {
    const smallSample = computeWilsonLowerBoundPct(2, 2) // 100% nominal at n=2
    const largeSample = computeWilsonLowerBoundPct(90, 100) // 90% nominal at n=100

    expect(smallSample).toBeLessThan(40)
    expect(largeSample).toBeGreaterThan(82)
  })

  it('evaluates all rules across deterministic synthetic candle series without error', async () => {
    const intervals: Interval[] = ['5m', '15m', '1h', '4h', '1d']

    for (const tf of intervals) {
      const candles = await syntheticSource.getCandles({
        pair: 'BTC/USDT',
        interval: tf,
        limit: 250,
      })
      const results = evaluateTimeframePredictions(tf, candles)

      expect(results).toHaveLength(4)
      for (const res of results) {
        expect(res.timeframe).toBe(tf)
        expect(res.triggers).toBeGreaterThanOrEqual(0)
        expect(res.hits).toBeGreaterThanOrEqual(0)
        expect(res.hits).toBeLessThanOrEqual(res.triggers)
        expect(res.winRatePct).toBeGreaterThanOrEqual(0)
        expect(res.winRatePct).toBeLessThanOrEqual(100)
        expect(res.wilsonLowerBoundPct).toBeLessThanOrEqual(res.winRatePct)
      }
    }
  })

  it('accurately computes fairYesPrice, wilsonLowerBoundPct, and quarterKellyPct', async () => {
    const candles = await syntheticSource.getCandles({
      pair: 'BTC/USDT',
      interval: '15m',
      limit: 400,
    })
    const rule = BITCOIN_20_PREDICTIONS.find(
      (r) => r.id === 'm15-sma20-bear-hold',
    )!
    const stats = evaluatePredictionRule(rule, candles)

    expect(stats.triggers).toBeGreaterThan(0)
    expect(stats.fairYesPrice).toBeCloseTo(
      Math.round(stats.winRatePct) / 100,
      2,
    )
    expect(stats.wilsonLowerBoundPct).toBeGreaterThan(0)
    expect(stats.recentOutcomes.length).toBe(Math.min(16, stats.triggers))
  })

  it('returns per-trigger events and cumulative win-rate series for rule detail disclosure', async () => {
    const candles = await syntheticSource.getCandles({
      pair: 'BTC/USDT',
      interval: '5m',
      limit: 400,
    })
    const rule = BITCOIN_20_PREDICTIONS.find(
      (r) => r.id === 'm5-ema50-bear-cap',
    )!
    const base = evaluatePredictionRule(rule, candles)
    const detailed = evaluatePredictionRuleDetailed(rule, candles)

    expect(detailed.stats).toEqual(base)
    expect(detailed.events).toHaveLength(base.triggers)
    for (const ev of detailed.events) {
      expect(ev.resolveIndex).toBe(ev.index + rule.horizonBars)
      expect(ev.cumulativeWinRatePct).toBeGreaterThanOrEqual(0)
      expect(ev.cumulativeWinRatePct).toBeLessThanOrEqual(100)
    }
  })
})
