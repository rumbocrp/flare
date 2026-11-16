import { describe, expect, it } from 'vitest'
import type { Candle } from './types'
import type { PredictionRule } from './predictions'
import { BITCOIN_20_PREDICTIONS } from './predictions'
import {
  DEFAULT_SIMULATION_CONFIG,
  analyzeRulesMarket,
  binaryKellyFraction,
  chooseSide,
  collectRuleSignals,
  costModelForCategory,
  effectiveEntryPrice,
  entryCostPct,
  maxDrawdownPct,
  polymarketFeePerShare,
  polymarketFeePctOfStake,
  runMonteCarlo,
  shrinkProbability,
  simulatePredictionStrategy,
  splitBoundary,
  type SimulationConfig,
} from './predictionMarket'
import { buildMarketContext } from './predictions'
import { buildDirectionalRules } from './directionalRules'

function makeCandles(closes: number[]): Candle[] {
  return closes.map((close, i) => {
    const open = i > 0 ? closes[i - 1] : close
    return {
      time: 1_700_000_000_000 + i * 60_000,
      open,
      high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999,
      close,
      volume: 100,
    }
  })
}

/** Even-indexed bars precede gains; odd-indexed bars precede pullbacks. */
function zigzagCloses(n: number): number[] {
  const out = [100]
  for (let i = 0; i < n - 1; i++) {
    out.push(out[i] * (i % 2 === 0 ? 1.01 : 0.995))
  }
  return out
}

function testRule(
  id: string,
  condition: PredictionRule['condition'],
  horizonBars = 1,
): PredictionRule {
  return {
    id,
    number: 99,
    timeframe: '15m',
    title: id,
    contractQuestion: id,
    predictedOutcome: 'YES',
    horizonBars,
    category: 'momentum',
    condition,
    resolve: (ctx, i) => ctx.closes[i + 1] > ctx.closes[i],
  }
}

const evenRule = testRule('even', (_ctx, i) => i % 2 === 0)
const oddRule = testRule('odd', (_ctx, i) => i % 2 === 1)

describe('predictionMarket: pricing math', () => {
  it('uses actual contract price for binary Kelly rather than fixed 0.50 odds', () => {
    expect(binaryKellyFraction(0.6, 0.5)).toBeCloseTo(0.2, 6)
    expect(binaryKellyFraction(0.7, 0.6)).toBeCloseTo(0.25, 6)
    expect(binaryKellyFraction(0.5, 0.6)).toBe(0)
    expect(binaryKellyFraction(0.9, 1)).toBe(0)
  })

  it('adds half-spread and notional fee to effective entry price', () => {
    expect(effectiveEntryPrice(0.5, { spreadCents: 2, feePct: 1 })).toBeCloseTo(0.5151, 6)
    expect(effectiveEntryPrice(0.5, { spreadCents: 0, feePct: 0 })).toBeCloseTo(0.5, 6)
  })

  it('picks NO when YES probability sits below market price and NO is allowed', () => {
    const costs = { spreadCents: 2, feePct: 1 }
    const decision = chooseSide(0.3, 0.5, costs, 0.03, true)
    expect(decision?.side).toBe('NO')
    expect(decision?.edge).toBeCloseTo(0.7 - 0.5151, 6)
    expect(chooseSide(0.3, 0.5, costs, 0.03, false)).toBeNull()
    expect(chooseSide(0.52, 0.5, costs, 0.03, true)).toBeNull()
  })

  it('shrinks small samples back toward base rate to avoid phantom edge', () => {
    expect(shrinkProbability(0, 0, 0.55)).toBeCloseTo(0.55, 6)
    expect(shrinkProbability(2, 2, 0.5)).toBeLessThan(0.6)
    expect(shrinkProbability(900, 1000, 0.5)).toBeGreaterThan(0.89)
  })
})

describe('predictionMarket: Polymarket fee curve', () => {
  it('charges the published fee per share and is symmetric around 50 cents', () => {
    const crypto = { spreadCents: 0, feePct: 0, takerFeeRate: 0.07 }
    expect(polymarketFeePerShare(0.5, crypto)).toBeCloseTo(0.0175, 8)
    expect(polymarketFeePerShare(0.3, crypto)).toBeCloseTo(0.0147, 8)
    expect(polymarketFeePerShare(0.7, crypto)).toBeCloseTo(0.0147, 8)
    expect(polymarketFeePerShare(0.9, crypto)).toBeCloseTo(0.0063, 8)
  })

  it('uses the category rate for sports and politics and zero for geopolitics', () => {
    expect(polymarketFeePctOfStake(0.5, 'crypto')).toBeCloseTo(3.5, 8)
    expect(polymarketFeePctOfStake(0.5, 'sports')).toBeCloseTo(2.5, 8)
    expect(polymarketFeePctOfStake(0.5, 'politics')).toBeCloseTo(2.0, 8)
    expect(polymarketFeePctOfStake(0.5, 'geopolitics')).toBe(0)
    expect(polymarketFeePctOfStake(0.9, 'crypto')).toBeCloseTo(0.7, 8)
    expect(polymarketFeePctOfStake(0.1, 'sports')).toBeCloseTo(4.5, 8)
  })

  it('credits a maker rebate instead of charging a taker fee', () => {
    const maker = costModelForCategory('crypto', 'maker', 0)
    expect(polymarketFeePerShare(0.5, maker)).toBeCloseTo(-0.0035, 8)
    expect(polymarketFeePctOfStake(0.5, 'crypto', 'maker')).toBeCloseTo(-0.7, 8)
    expect(effectiveEntryPrice(0.5, maker)).toBeCloseTo(0.4965, 8)
  })

  it('adds the curve to half-spread and keeps the legacy flat fee composable', () => {
    expect(
      effectiveEntryPrice(0.5, { spreadCents: 0, feePct: 0, takerFeeRate: 0.07 }),
    ).toBeCloseTo(0.5175, 8)
    expect(
      effectiveEntryPrice(0.5, { spreadCents: 0, feePct: 0, takerFeeRate: 0.05 }),
    ).toBeCloseTo(0.5125, 8)
    expect(
      effectiveEntryPrice(0.5, { spreadCents: 0, feePct: 0, takerFeeRate: 0.04 }),
    ).toBeCloseTo(0.51, 8)
    expect(
      effectiveEntryPrice(0.5, { spreadCents: 2, feePct: 1, takerFeeRate: 0.07 }),
    ).toBeCloseTo(0.51 * 1.01 + 0.07 * 0.51 * 0.49, 8)
  })

  it('reports all-in cost including half-spread', () => {
    const crypto = costModelForCategory('crypto', 'taker', 1)
    const ask = 0.505
    const expected = ((ask + 0.07 * ask * (1 - ask) - 0.5) / 0.5) * 100
    expect(entryCostPct(0.5, crypto)).toBeCloseTo(expected, 8)
    expect(entryCostPct(0.5, crypto)).toBeGreaterThan(4)
    expect(entryCostPct(0.5, costModelForCategory('crypto', 'maker', 1))).toBeLessThan(1.1)
  })
})

describe('predictionMarket: signals and validation', () => {
  it('enforces cooldown so overlapping contracts on the same rule cannot open', () => {
    const ctx = buildMarketContext(makeCandles(zigzagCloses(120)))
    const always = testRule('always', () => true, 3)
    const overlapping = collectRuleSignals(always, ctx, 50, 110, false)
    const spaced = collectRuleSignals(always, ctx, 50, 110, true)
    expect(overlapping.length).toBe(61)
    expect(spaced.length).toBe(21)
    for (let k = 1; k < spaced.length; k++) {
      expect(spaced[k].index).toBeGreaterThanOrEqual(spaced[k - 1].resolveIndex)
    }
  })

  it('calibrates strictly on training candles without lookahead leakage', () => {
    const n = 300
    const boundary = splitBoundary(n, 0.7)
    const closes: number[] = [100]
    for (let i = 1; i < n; i++) {
      closes.push(closes[i - 1] * (i <= boundary ? 0.999 : 1.002))
    }
    const always = testRule('always', () => true)
    const result = simulatePredictionStrategy(makeCandles(closes), [always], {
      ...DEFAULT_SIMULATION_CONFIG,
      monteCarloRuns: 10,
    })
    expect(result.insufficientData).toBe(false)
    expect(result.calibration[0].trainHits).toBe(0)
    expect(result.calibration[0].probability).toBeLessThan(0.05)
  })

  it('wins out of sample using YES on positive edge and NO on inverted edge', () => {
    const candles = makeCandles(zigzagCloses(400))
    const config: SimulationConfig = { ...DEFAULT_SIMULATION_CONFIG, monteCarloRuns: 50 }
    const result = simulatePredictionStrategy(candles, [evenRule, oddRule], config)

    expect(result.metrics.tickets).toBeGreaterThan(20)
    expect(result.metrics.winRatePct).toBe(100)
    expect(result.metrics.roiPct).toBeGreaterThan(0)
    expect(result.metrics.yesTickets).toBeGreaterThan(0)
    expect(result.metrics.noTickets).toBeGreaterThan(0)
    expect(result.tickets.every((tk) => tk.entryIndex >= splitBoundary(400, 0.7))).toBe(true)
    for (const tk of result.tickets) {
      expect(tk.stake).toBeLessThanOrEqual((config.maxStakePct / 100) * tk.equityAtEntry + 0.01)
    }
  })

  it('filters entries via minConfluence when too few rules agree', () => {
    const candles = makeCandles(zigzagCloses(400))
    const result = simulatePredictionStrategy(candles, [evenRule, oddRule], {
      ...DEFAULT_SIMULATION_CONFIG,
      minConfluence: 2,
      monteCarloRuns: 10,
    })
    expect(result.metrics.tickets).toBe(0)
    expect(result.metrics.skippedConfluence).toBeGreaterThan(0)
  })

  it('bets a constant percentage of initial bankroll in fixed mode', () => {
    const candles = makeCandles(zigzagCloses(400))
    const result = simulatePredictionStrategy(candles, [evenRule], {
      ...DEFAULT_SIMULATION_CONFIG,
      sizing: 'fixed',
      fixedStakePct: 1,
      monteCarloRuns: 10,
    })
    expect(result.tickets.length).toBeGreaterThan(0)
    for (const tk of result.tickets) expect(tk.stake).toBe(10)
  })

  it('reports insufficient data instead of fabricating trades', () => {
    const result = simulatePredictionStrategy(makeCandles(zigzagCloses(60)), [evenRule])
    expect(result.insufficientData).toBe(true)
    expect(result.tickets).toHaveLength(0)
  })
})

describe('predictionMarket: Monte Carlo and metrics', () => {
  it('produces deterministic output for identical seed', () => {
    const returns = [0.05, -0.03, 0.02, -0.04, 0.06, -0.01, 0.03]
    const a = runMonteCarlo(returns, 1000, 200, 7)
    const b = runMonteCarlo(returns, 1000, 200, 7)
    expect(a).toEqual(b)
    expect(a!.finalP5).toBeLessThanOrEqual(a!.finalP50)
    expect(a!.finalP50).toBeLessThanOrEqual(a!.finalP95)
  })

  it('computes peak-to-trough max drawdown percentage', () => {
    expect(maxDrawdownPct([100, 120, 90, 130, 117])).toBe(25)
  })

  it('evaluates all 20 built-in rules without error', () => {
    const candles = makeCandles(zigzagCloses(500))
    const stats = analyzeRulesMarket(BITCOIN_20_PREDICTIONS, candles, DEFAULT_SIMULATION_CONFIG.costs)
    expect(stats).toHaveLength(20)
    for (const s of stats) {
      expect(s.baseRatePct).toBeGreaterThanOrEqual(0)
      expect(s.baseRatePct).toBeLessThanOrEqual(100)
      expect(s.priceSource).toBe('modeled')
      if (s.side === null) expect(s.netEdgePct).toBe(0)
    }
  })

  it('accepts quoteProvider for real market quotes and skips windows without market pricing', () => {
    const candles = makeCandles(zigzagCloses(400))
    const dirRules = buildDirectionalRules('15m')
    expect(dirRules).toHaveLength(8)

    const result = simulatePredictionStrategy(
      candles,
      [evenRule],
      { ...DEFAULT_SIMULATION_CONFIG, monteCarloRuns: 10 },
      (_rule, entryIndex) => {
        if (entryIndex % 4 === 0) return { mid: 0.45, resolvedYes: true }
        return null
      },
    )
    expect(result.priceSource).toBe('real')
    expect(result.metrics.tickets).toBeGreaterThan(0)
    expect(result.metrics.skippedNoMarket).toBeGreaterThan(0)
  })
})
