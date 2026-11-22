import { describe, expect, it } from 'vitest'
import { BITCOIN_20_PREDICTIONS } from '../../predictions'
import { computeNowcast } from '../nowcast'
import type { PromotionReport } from '../replayHarness'
import type { WindowOrderBookSnapshot } from '../../server/prediction/clobBookFeed'
import type { OracleSnapshot } from '../../server/prediction/oracleFeed'
import {
  evaluateSafetyGates,
  isEngineBookSideStale,
  isExcludedPredictionRuleId,
} from './gates'
import {
  checkCanaryRiskBudget,
  DEFAULT_CANARY_RISK_CONFIG,
  evaluatePromotionTransition,
} from './promotion'
import {
  evaluateAllStrategies,
  evaluateStrategy,
  getStrategyDefinition,
  STRATEGY_REGISTRY,
} from './strategies'
import {
  PREDICTION_ENGINE_STRATEGY_IDS,
  type EngineBookSideSnapshot,
  type EngineOracleSnapshot,
  type EngineOrderBookSnapshot,
  type StrategyContext,
} from './types'

const BASE_NOW_MS = 1_760_000_000_000

function makeSide(
  tokenId: string,
  bestBid: number,
  bestAsk: number,
  overrides: Partial<EngineBookSideSnapshot> = {},
): EngineBookSideSnapshot {
  const spread = Math.round((bestAsk - bestBid) * 10_000) / 10_000
  const mid = Math.round(((bestBid + bestAsk) / 2) * 10_000) / 10_000
  return {
    tokenId,
    bestBid,
    bestAsk,
    mid,
    spread,
    bidDepthUsd: 500,
    askDepthUsd: 500,
    top5DepthUsd: 1000,
    asOfMs: BASE_NOW_MS - 1_000,
    source: 'clob-ws',
    ...overrides,
  }
}

function makeBook(
  yesBid = 0.5,
  yesAsk = 0.52,
  noBid = 0.48,
  noAsk = 0.5,
  overrides: Partial<EngineOrderBookSnapshot> = {},
): EngineOrderBookSnapshot {
  const yes = makeSide('yes-tok', yesBid, yesAsk)
  const no = makeSide('no-tok', noBid, noAsk)
  return {
    slug: 'btc-updown-5m-test',
    upTokenId: 'yes-tok',
    downTokenId: 'no-tok',
    yes,
    no,
    minTop5DepthUsd: Math.min(yes.top5DepthUsd, no.top5DepthUsd),
    capturedAtMs: BASE_NOW_MS - 1_000,
    ...overrides,
  }
}

function makeOracle(
  overrides: Partial<EngineOracleSnapshot> = {},
): EngineOracleSnapshot {
  return {
    nowMs: BASE_NOW_MS,
    chainlinkPrice: 100_100,
    chainlinkTwap60s: 100_100,
    chainlinkUpdatedAtMs: BASE_NOW_MS - 1_000,
    chainlinkStaleMs: 1_000,
    binancePrice: 100_105,
    binanceUpdatedAtMs: BASE_NOW_MS - 500,
    binanceStaleMs: 500,
    basisBps: 0.5,
    sigma1m: 0.001,
    median24hSigma1m: 0.001,
    connectedRtds: true,
    connectedBinance: true,
    ...overrides,
  }
}

function makeContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  const timeframe = overrides.timeframe ?? '5m'
  const durationMs =
    timeframe === '5m' ? 300_000 : timeframe === '15m' ? 900_000 : 3_600_000
  const secondsRemaining = overrides.secondsRemaining ?? 90
  const secondsElapsed =
    overrides.secondsElapsed ?? Math.max(0, durationMs / 1000 - secondsRemaining)
  const openTwap = overrides.openTwap ?? 100_000
  const oracle = overrides.oracle ?? makeOracle()
  const currentTwap =
    (overrides.resolutionSource ?? 'chainlink-twap-60s') === 'binance-1h-candle'
      ? oracle.binancePrice ?? 100_100
      : oracle.chainlinkTwap60s ?? 100_100

  const nowcast =
    overrides.nowcast ??
    computeNowcast({
      openTwap: openTwap ?? 100_000,
      currentTwap,
      secondsRemaining,
      sigma1m: oracle.sigma1m ?? 0.001,
    })

  return {
    slug: `btc-updown-${timeframe}-test`,
    timeframe,
    resolutionSource:
      timeframe === '1h' ? 'binance-1h-candle' : 'chainlink-twap-60s',
    startTimeMs: BASE_NOW_MS - secondsElapsed * 1000,
    endTimeMs: BASE_NOW_MS + secondsRemaining * 1000,
    openTwap,
    secondsRemaining,
    secondsElapsed,
    oracle,
    book: overrides.book ?? makeBook(),
    nowcast,
    macroBlackoutWindows: [],
    nowMs: BASE_NOW_MS,
    stakeUsd: 5,
    ...overrides,
  }
}

function makePromotionReport(
  overrides: Partial<PromotionReport> = {},
): PromotionReport {
  return {
    strategyId: 'c5-late-favorite',
    totalInputWindows: 600,
    settledWindowCount: 520,
    trainWindowCount: 364,
    testWindowCount: 156,
    trainRatio: 0.7,
    calibrator: {
      mode: 'pav',
      sampleCount: 364,
      blocks: [],
    },
    tradeCount: 95,
    wins: 90,
    winRatePct: 94.7,
    wilsonLowerBoundPct: 88.3,
    avgEntryPrice: 0.85,
    avgFeePerShare: 0.0089,
    avgBreakEvenPct: 85.9,
    edgeVsBreakEvenPp: 8.8,
    wilsonEdgeVsBreakEvenPp: 2.4,
    brierModel: 0.045,
    brierMarket: 0.06,
    brierSkillScore: 0.25,
    meanMarkout30s: 0.012,
    markoutSampleCount: 95,
    netPnlUsd: 42.5,
    totalFeesUsd: 4.1,
    totalSpreadDragUsd: 2.3,
    maxDrawdownUsd: 10,
    maxDrawdownPct: 1.0,
    equityCurve: [],
    trades: [],
    minSamplesRequired: 500,
    sampleProgressText: '520 / 500',
    sampleWarning: null,
    gateFailures: [],
    eligibleForCanary: true,
    eligibleForPaperLive: true,
    ...overrides,
  }
}

describe('Prediction Engine Strategy Registry & Purity', () => {
  it('registers all 8 canonical strategies with expected lanes and default modes', () => {
    expect(STRATEGY_REGISTRY).toHaveLength(8)
    expect(STRATEGY_REGISTRY.map((s) => s.id)).toEqual([
      ...PREDICTION_ENGINE_STRATEGY_IDS,
    ])

    const highHitRate = STRATEGY_REGISTRY.filter(
      (s) => s.lane === 'high-hit-rate',
    )
    const edge = STRATEGY_REGISTRY.filter((s) => s.lane === 'edge')
    expect(highHitRate).toHaveLength(3)
    expect(edge).toHaveLength(5)

    expect(getStrategyDefinition('c5-late-favorite').defaultMode).toBe('paper')
    expect(getStrategyDefinition('c5-nowcast-maker').defaultMode).toBe('paper')
    expect(getStrategyDefinition('c15-favorite-carry').defaultMode).toBe('paper')
    expect(getStrategyDefinition('c15-late-favorite-guarded').defaultMode).toBe(
      'research',
    )
    expect(getStrategyDefinition('c1h-late-nowcast').defaultMode).toBe(
      'research',
    )
    expect(getStrategyDefinition('c1h-exhaustion-limit').defaultMode).toBe(
      'paper',
    )
    expect(getStrategyDefinition('cx-nested-coherence').defaultMode).toBe(
      'research',
    )
    expect(getStrategyDefinition('c5-15-longshot-fade').defaultMode).toBe(
      'paper',
    )
  })

  it('maintains structural compatibility with OracleSnapshot and WindowOrderBookSnapshot', () => {
    const serverOracle: OracleSnapshot = makeOracle()
    const serverBook: WindowOrderBookSnapshot = makeBook()
    const ctx = makeContext({ oracle: serverOracle, book: serverBook })
    expect(evaluateSafetyGates(ctx).allowed).toBe(true)
  })
})

describe('Safety Gates: avoid, G1, and G2', () => {
  it('rejects every legacy BITCOIN_20_PREDICTIONS rule ID and playbook avoid rules', () => {
    expect(BITCOIN_20_PREDICTIONS).toHaveLength(20)
    for (const rule of BITCOIN_20_PREDICTIONS) {
      expect(isExcludedPredictionRuleId(rule.id)).toBe(true)
      const res = evaluateSafetyGates(makeContext({ candidateRuleId: rule.id }))
      expect(res.allowed).toBe(false)
      expect(res.avoidPassed).toBe(false)
      expect(res.codes).toContain('AVOID_EXCLUDED_RULE')
    }

    for (const avoidId of [
      'c15-signal-avoid',
      'c5-open-ignore',
      'c1d-updown-avoid',
    ]) {
      expect(isExcludedPredictionRuleId(avoidId)).toBe(true)
      const res = evaluateSafetyGates(makeContext({ candidateRuleId: avoidId }))
      expect(res.allowed).toBe(false)
      expect(res.codes).toContain('AVOID_EXCLUDED_RULE')
    }
  })

  it('enforces the first-60s taker exclusion on 5m and 15m but allows maker and 1h', () => {
    const early5mTaker = evaluateSafetyGates(
      makeContext({ timeframe: '5m', secondsElapsed: 59, secondsRemaining: 241 }),
      { liquidityRole: 'taker' },
    )
    expect(early5mTaker.allowed).toBe(false)
    expect(early5mTaker.avoidPassed).toBe(false)
    expect(early5mTaker.codes).toContain('AVOID_FIRST_60S')

    const early15mTaker = evaluateSafetyGates(
      makeContext({
        timeframe: '15m',
        secondsElapsed: 0,
        secondsRemaining: 900,
      }),
      { liquidityRole: 'taker' },
    )
    expect(early15mTaker.allowed).toBe(false)
    expect(early15mTaker.codes).toContain('AVOID_FIRST_60S')

    const at60s5m = evaluateSafetyGates(
      makeContext({ timeframe: '5m', secondsElapsed: 60, secondsRemaining: 240 }),
      { liquidityRole: 'taker' },
    )
    expect(at60s5m.allowed).toBe(true)

    const early5mMaker = evaluateSafetyGates(
      makeContext({ timeframe: '5m', secondsElapsed: 15, secondsRemaining: 285 }),
      { liquidityRole: 'maker' },
    )
    expect(early5mMaker.allowed).toBe(true)

    const early1hTaker = evaluateSafetyGates(
      makeContext({
        timeframe: '1h',
        resolutionSource: 'binance-1h-candle',
        secondsElapsed: 10,
        secondsRemaining: 3590,
      }),
      { liquidityRole: 'taker' },
    )
    expect(early1hTaker.allowed).toBe(true)
  })

  it('enforces G1 macro blackout (+-30m), volatility spike/null, depth, spread, and per-side book age', () => {
    // Macro blackout inside +-30m
    const insideBlackout = evaluateSafetyGates(
      makeContext({
        macroBlackoutWindows: [{ timestampMs: BASE_NOW_MS + 20 * 60_000, label: 'FOMC' }],
      }),
    )
    expect(insideBlackout.g1Passed).toBe(false)
    expect(insideBlackout.codes).toContain('G1_MACRO_BLACKOUT')

    const outsideBlackout = evaluateSafetyGates(
      makeContext({
        macroBlackoutWindows: [{ timestampMs: BASE_NOW_MS - 31 * 60_000, label: 'CPI' }],
      }),
    )
    expect(outsideBlackout.g1Passed).toBe(true)

    // Volatility spike & null fail-closed
    const volSpike = evaluateSafetyGates(
      makeContext({
        oracle: makeOracle({ sigma1m: 0.0031, median24hSigma1m: 0.001 }),
      }),
    )
    expect(volSpike.g1Passed).toBe(false)
    expect(volSpike.codes).toContain('G1_VOLATILITY_SPIKE')

    const missingVol = evaluateSafetyGates(
      makeContext({
        oracle: makeOracle({ sigma1m: null, median24hSigma1m: 0.001 }),
      }),
    )
    expect(missingVol.g1Passed).toBe(false)
    expect(missingVol.codes).toContain('G1_MISSING_VOLATILITY')

    // Low depth (< $200)
    const lowDepthBook = makeBook()
    lowDepthBook.no = makeSide('no-tok', 0.48, 0.5, { top5DepthUsd: 199 })
    lowDepthBook.minTop5DepthUsd = 199
    const lowDepth = evaluateSafetyGates(makeContext({ book: lowDepthBook }))
    expect(lowDepth.g1Passed).toBe(false)
    expect(lowDepth.codes).toContain('G1_LOW_DEPTH')

    // Exact 0.03 spread allowed (including IEEE-754 0.52 - 0.49), > 0.03 blocked
    const exactSpreadBook = makeBook(0.49, 0.52, 0.48, 0.51)
    expect(evaluateSafetyGates(makeContext({ book: exactSpreadBook })).g1Passed).toBe(
      true,
    )

    const wideSpreadBook = makeBook(0.48, 0.52, 0.48, 0.5)
    const wideSpread = evaluateSafetyGates(makeContext({ book: wideSpreadBook }))
    expect(wideSpread.g1Passed).toBe(false)
    expect(wideSpread.codes).toContain('G1_EXCESSIVE_SPREAD')

    // Per-side staleness: YES fresh (1s), NO stale (11s) even if capturedAtMs is fresh
    const partialStaleBook = makeBook()
    partialStaleBook.no = makeSide('no-tok', 0.48, 0.5, {
      asOfMs: BASE_NOW_MS - 11_000,
    })
    partialStaleBook.capturedAtMs = BASE_NOW_MS - 1_000
    expect(isEngineBookSideStale(partialStaleBook.no, BASE_NOW_MS, 10_000)).toBe(
      true,
    )
    const staleRes = evaluateSafetyGates(makeContext({ book: partialStaleBook }))
    expect(staleRes.g1Passed).toBe(false)
    expect(staleRes.codes).toContain('G1_STALE_BOOK')
  })

  it('enforces G2 resolutionSource, active oracle staleness, and basisBps (fail-closed)', () => {
    const unknownSource = evaluateSafetyGates(
      makeContext({ resolutionSource: 'unknown' }),
    )
    expect(unknownSource.g2Passed).toBe(false)
    expect(unknownSource.codes).toContain('G2_UNKNOWN_RESOLUTION_SOURCE')

    const staleChainlink = evaluateSafetyGates(
      makeContext({
        resolutionSource: 'chainlink-twap-60s',
        oracle: makeOracle({
          chainlinkUpdatedAtMs: BASE_NOW_MS - 16_000,
          chainlinkStaleMs: 16_000,
        }),
      }),
    )
    expect(staleChainlink.g2Passed).toBe(false)
    expect(staleChainlink.codes).toContain('G2_STALE_ORACLE')

    const infiniteChainlink = evaluateSafetyGates(
      makeContext({
        resolutionSource: 'chainlink-twap-60s',
        oracle: makeOracle({
          chainlinkTwap60s: null,
          chainlinkUpdatedAtMs: null,
          chainlinkStaleMs: Infinity,
          basisBps: null,
        }),
      }),
    )
    expect(infiniteChainlink.g2Passed).toBe(false)
    expect(infiniteChainlink.codes).toContain('G2_STALE_ORACLE')
    expect(infiniteChainlink.codes).toContain('G2_MISSING_BASIS')

    // For 1h Binance resolution, stale Binance fails while stale Chainlink does not fail oracle age
    const staleBinance1h = evaluateSafetyGates(
      makeContext({
        timeframe: '1h',
        resolutionSource: 'binance-1h-candle',
        oracle: makeOracle({
          binanceUpdatedAtMs: BASE_NOW_MS - 15_500,
          binanceStaleMs: 15_500,
        }),
      }),
    )
    expect(staleBinance1h.g2Passed).toBe(false)
    expect(staleBinance1h.codes).toContain('G2_STALE_ORACLE')

    const basisDivergence = evaluateSafetyGates(
      makeContext({
        oracle: makeOracle({ basisBps: 25.1 }),
      }),
    )
    expect(basisDivergence.g2Passed).toBe(false)
    expect(basisDivergence.codes).toContain('G2_BASIS_DIVERGENCE')
  })
})

describe('8-Strategy Evaluators', () => {
  it('1. c5-late-favorite triggers in 30..120s with p >= 0.94 and ask <= min(0.97, p - 0.02)', () => {
    const ctx = makeContext({
      timeframe: '5m',
      secondsRemaining: 90,
      secondsElapsed: 210,
      calibratedPYes: 0.96,
      book: makeBook(0.91, 0.93, 0.06, 0.08),
    })
    const intents = evaluateStrategy('c5-late-favorite', ctx)
    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({
      strategyId: 'c5-late-favorite',
      lane: 'high-hit-rate',
      outcome: 'YES',
      liquidityRole: 'taker',
      orderType: 'FOK',
      limitPrice: 0.93,
    })

    // Rejects ask > 0.97 even if pModel = 0.995
    const expensive = evaluateStrategy(
      'c5-late-favorite',
      makeContext({
        timeframe: '5m',
        secondsRemaining: 90,
        secondsElapsed: 210,
        calibratedPYes: 0.995,
        book: makeBook(0.96, 0.975, 0.02, 0.04),
      }),
    )
    expect(expensive).toHaveLength(0)

    // Rejects outside 30..120s
    const tooEarly = evaluateStrategy(
      'c5-late-favorite',
      makeContext({
        timeframe: '5m',
        secondsRemaining: 125,
        secondsElapsed: 175,
        calibratedPYes: 0.96,
        book: makeBook(0.91, 0.93, 0.06, 0.08),
      }),
    )
    expect(tooEarly).toHaveLength(0)
  })

  it('2. c5-nowcast-maker quotes two-sided GTC maker bids, suppresses at |z|>2.5, and supports >=10c taker override', () => {
    // Two-sided maker quote when fair value sits near mid
    const makerCtx = makeContext({
      timeframe: '5m',
      secondsRemaining: 180,
      secondsElapsed: 120,
      calibratedPYes: 0.55,
      book: makeBook(0.52, 0.54, 0.46, 0.48),
      nowcast: computeNowcast({
        openTwap: 100_000,
        currentTwap: 100_015,
        secondsRemaining: 180,
        sigma1m: 0.001,
      }),
    })
    const makerIntents = evaluateStrategy('c5-nowcast-maker', makerCtx)
    expect(makerIntents.length).toBeGreaterThanOrEqual(1)
    expect(makerIntents.every((i) => i.liquidityRole === 'maker')).toBe(true)
    expect(makerIntents.every((i) => i.orderType === 'GTC')).toBe(true)
    expect(
      makerIntents.every((i) => i.cancelAtSecondsRemaining === 20),
    ).toBe(true)

    // Suppresses when |z| > 2.5
    const extremeZ = evaluateStrategy(
      'c5-nowcast-maker',
      makeContext({
        timeframe: '5m',
        secondsRemaining: 180,
        secondsElapsed: 120,
        nowcast: {
          z: 2.6,
          pRawYes: 0.995,
          pBlendedYes: 0.995,
          remainingMinutes: 3,
          valid: true,
        },
        book: makeBook(0.52, 0.54, 0.46, 0.48),
      }),
    )
    expect(extremeZ).toHaveLength(0)

    // Taker override when |pModel - ask| >= 0.10 and depth >= 3 * stakeUsd (15)
    const overrideCtx = makeContext({
      timeframe: '5m',
      secondsRemaining: 150,
      secondsElapsed: 150,
      calibratedPYes: 0.72,
      stakeUsd: 5,
      book: makeBook(0.57, 0.59, 0.41, 0.43),
      nowcast: {
        z: 1.2,
        pRawYes: 0.72,
        pBlendedYes: 0.72,
        remainingMinutes: 2.5,
        valid: true,
      },
    })
    const overrideIntents = evaluateStrategy('c5-nowcast-maker', overrideCtx)
    expect(overrideIntents).toHaveLength(1)
    expect(overrideIntents[0]).toMatchObject({
      outcome: 'YES',
      liquidityRole: 'taker',
      orderType: 'FOK',
      limitPrice: 0.59,
    })

    // Clamps rawBid (0.53998 < bestAsk 0.54) to 0.5399 instead of rounding up to 0.54 and dropping
    const clampCtx = makeContext({
      timeframe: '5m',
      secondsRemaining: 180,
      secondsElapsed: 120,
      calibratedPYes: 0.57664,
      book: makeBook(0.52, 0.54, 0.46, 0.48),
      nowcast: {
        z: 0.3,
        pRawYes: 0.57664,
        pBlendedYes: 0.57664,
        remainingMinutes: 3,
        valid: true,
      },
    })
    const clampedIntents = evaluateStrategy('c5-nowcast-maker', clampCtx)
    const clampedYes = clampedIntents.find((i) => i.outcome === 'YES')
    expect(clampedYes).toBeDefined()
    expect(clampedYes).toMatchObject({
      strategyId: 'c5-nowcast-maker',
      outcome: 'YES',
      liquidityRole: 'maker',
      orderType: 'GTC',
      limitPrice: 0.5399,
    })
  })

  it('3. c15-favorite-carry buys 70-88c favorites with >=4c discount and >=300s remaining', () => {
    const ctx = makeContext({
      timeframe: '15m',
      secondsRemaining: 420,
      secondsElapsed: 480,
      calibratedPYes: 0.85,
      book: makeBook(0.76, 0.78, 0.22, 0.24),
    })
    const intents = evaluateStrategy('c15-favorite-carry', ctx)
    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({
      strategyId: 'c15-favorite-carry',
      outcome: 'YES',
      limitPrice: 0.78,
    })

    // Rejects < 300s remaining or ask > 0.88
    expect(
      evaluateStrategy(
        'c15-favorite-carry',
        makeContext({
          timeframe: '15m',
          secondsRemaining: 299,
          secondsElapsed: 601,
          calibratedPYes: 0.85,
          book: makeBook(0.76, 0.78, 0.22, 0.24),
        }),
      ),
    ).toHaveLength(0)

    expect(
      evaluateStrategy(
        'c15-favorite-carry',
        makeContext({
          timeframe: '15m',
          secondsRemaining: 420,
          secondsElapsed: 480,
          calibratedPYes: 0.95,
          book: makeBook(0.87, 0.89, 0.11, 0.13),
        }),
      ),
    ).toHaveLength(0)
  })

  it('4. c15-late-favorite-guarded enforces strict pModel - ask >= 0.04 floor', () => {
    // Rejected: 0.96 - 0.93 = 0.03 < 0.04
    const insufficientBuffer = evaluateStrategy(
      'c15-late-favorite-guarded',
      makeContext({
        timeframe: '15m',
        secondsRemaining: 120,
        secondsElapsed: 780,
        calibratedPYes: 0.96,
        book: makeBook(0.91, 0.93, 0.07, 0.09),
      }),
    )
    expect(insufficientBuffer).toHaveLength(0)

    // Accepted: 0.96 - 0.92 = 0.04 >= 0.04 and ask <= 0.96
    const valid = evaluateStrategy(
      'c15-late-favorite-guarded',
      makeContext({
        timeframe: '15m',
        secondsRemaining: 120,
        secondsElapsed: 780,
        calibratedPYes: 0.96,
        book: makeBook(0.9, 0.92, 0.08, 0.1),
      }),
    )
    expect(valid).toHaveLength(1)
    expect(valid[0]).toMatchObject({
      strategyId: 'c15-late-favorite-guarded',
      outcome: 'YES',
      limitPrice: 0.92,
    })
  })

  it('5. c1h-late-nowcast triggers on 1h Binance windows with |z| >= 2.0 and p >= 0.93', () => {
    const valid = evaluateStrategy(
      'c1h-late-nowcast',
      makeContext({
        timeframe: '1h',
        resolutionSource: 'binance-1h-candle',
        secondsRemaining: 300,
        secondsElapsed: 3300,
        calibratedPYes: 0.96,
        nowcast: {
          z: 2.2,
          pRawYes: 0.986,
          pBlendedYes: 0.986,
          remainingMinutes: 5,
          valid: true,
        },
        book: makeBook(0.91, 0.93, 0.07, 0.09),
      }),
    )
    expect(valid).toHaveLength(1)
    expect(valid[0]).toMatchObject({
      strategyId: 'c1h-late-nowcast',
      outcome: 'YES',
      limitPrice: 0.93,
      cancelAtSecondsRemaining: 30,
    })

    // Rejects |z| < 2.0
    const weakZ = evaluateStrategy(
      'c1h-late-nowcast',
      makeContext({
        timeframe: '1h',
        resolutionSource: 'binance-1h-candle',
        secondsRemaining: 300,
        secondsElapsed: 3300,
        calibratedPYes: 0.96,
        nowcast: {
          z: 1.9,
          pRawYes: 0.971,
          pBlendedYes: 0.971,
          remainingMinutes: 5,
          valid: true,
        },
        book: makeBook(0.91, 0.93, 0.07, 0.09),
      }),
    )
    expect(weakZ).toHaveLength(0)
  })

  it('6. c1h-exhaustion-limit posts GTC BUY YES at min(0.52, ask) before T+10m and rejects ask > 0.54', () => {
    const validMaker = evaluateStrategy(
      'c1h-exhaustion-limit',
      makeContext({
        timeframe: '1h',
        resolutionSource: 'binance-1h-candle',
        secondsRemaining: 3400,
        secondsElapsed: 200,
        hourlyIndicators: { consecutiveRedHours: 3, rsi14: 42 },
        book: makeBook(0.51, 0.53, 0.47, 0.49),
      }),
    )
    expect(validMaker).toHaveLength(1)
    expect(validMaker[0]).toMatchObject({
      strategyId: 'c1h-exhaustion-limit',
      outcome: 'YES',
      liquidityRole: 'maker',
      orderType: 'GTC',
      limitPrice: 0.52,
      cancelAtSecondsRemaining: 3000,
    })

    const validRsiTaker = evaluateStrategy(
      'c1h-exhaustion-limit',
      makeContext({
        timeframe: '1h',
        resolutionSource: 'binance-1h-candle',
        secondsRemaining: 3300,
        secondsElapsed: 300,
        hourlyIndicators: { consecutiveRedHours: 1, rsi14: 32 },
        book: makeBook(0.48, 0.5, 0.5, 0.52),
      }),
    )
    expect(validRsiTaker).toHaveLength(1)
    expect(validRsiTaker[0]).toMatchObject({
      liquidityRole: 'taker',
      limitPrice: 0.5,
    })

    // Rejects ask > 0.54
    expect(
      evaluateStrategy(
        'c1h-exhaustion-limit',
        makeContext({
          timeframe: '1h',
          resolutionSource: 'binance-1h-candle',
          secondsRemaining: 3400,
          secondsElapsed: 200,
          hourlyIndicators: { consecutiveRedHours: 4, rsi14: 28 },
          book: makeBook(0.53, 0.55, 0.45, 0.47),
        }),
      ),
    ).toHaveLength(0)

    // Rejects after T+10m (secondsRemaining <= 3000)
    expect(
      evaluateStrategy(
        'c1h-exhaustion-limit',
        makeContext({
          timeframe: '1h',
          resolutionSource: 'binance-1h-candle',
          secondsRemaining: 3000,
          secondsElapsed: 600,
          hourlyIndicators: { consecutiveRedHours: 3, rsi14: 30 },
          book: makeBook(0.49, 0.51, 0.49, 0.51),
        }),
      ),
    ).toHaveLength(0)
  })

  it('7. cx-nested-coherence detects >=4c child/parent dislocation and validates parent safety gates', () => {
    // Child book priced too cheap (0.45 vs ~0.70+ implied) -> buy child YES
    const childDislocated = evaluateStrategy(
      'cx-nested-coherence',
      makeContext({
        timeframe: '5m',
        openTwap: 100_000,
        secondsRemaining: 120,
        secondsElapsed: 180,
        oracle: makeOracle({ chainlinkTwap60s: 100_120, sigma1m: 0.001 }),
        book: makeBook(0.44, 0.46, 0.54, 0.56),
        nestedParent: {
          slug: 'btc-updown-15m-parent',
          timeframe: '15m',
          resolutionSource: 'chainlink-twap-60s',
          openTwap: 100_000,
          secondsRemaining: 600,
          secondsElapsed: 300,
          marketMidYes: 0.65,
        },
      }),
    )
    expect(childDislocated).toHaveLength(1)
    expect(childDislocated[0]).toMatchObject({
      strategyId: 'cx-nested-coherence',
      slug: 'btc-updown-5m-test',
      outcome: 'YES',
      limitPrice: 0.46,
    })

    // Parent book mispriced by >= 0.04 while child is aligned -> trades parent leg
    const parentBook = makeBook(0.44, 0.46, 0.54, 0.56, {
      slug: 'btc-updown-15m-parent',
    })
    const parentDislocated = evaluateStrategy(
      'cx-nested-coherence',
      makeContext({
        timeframe: '5m',
        openTwap: 100_000,
        secondsRemaining: 120,
        secondsElapsed: 180,
        oracle: makeOracle({ chainlinkTwap60s: 100_250, sigma1m: 0.001 }),
        book: makeBook(0.95, 0.97, 0.03, 0.05),
        nestedParent: {
          slug: 'btc-updown-15m-parent',
          timeframe: '15m',
          resolutionSource: 'chainlink-twap-60s',
          openTwap: 100_000,
          secondsRemaining: 600,
          secondsElapsed: 300,
          book: parentBook,
          marketMidYes: 0.45,
        },
      }),
    )
    expect(parentDislocated).toHaveLength(1)
    expect(parentDislocated[0]).toMatchObject({
      strategyId: 'cx-nested-coherence',
      slug: 'btc-updown-15m-parent',
      timeframe: '15m',
      outcome: 'YES',
      limitPrice: 0.46,
    })

    // Fails closed if parent book fails G1
    const badParentBook = makeBook(0.44, 0.46, 0.54, 0.56, {
      slug: 'btc-updown-15m-parent',
      minTop5DepthUsd: 50,
    })
    expect(
      evaluateStrategy(
        'cx-nested-coherence',
        makeContext({
          timeframe: '5m',
          openTwap: 100_000,
          secondsRemaining: 120,
          secondsElapsed: 180,
          oracle: makeOracle({ chainlinkTwap60s: 100_250, sigma1m: 0.001 }),
          book: makeBook(0.95, 0.97, 0.03, 0.05),
          nestedParent: {
            slug: 'btc-updown-15m-parent',
            timeframe: '15m',
            resolutionSource: 'chainlink-twap-60s',
            openTwap: 100_000,
            secondsRemaining: 600,
            secondsElapsed: 300,
            book: badParentBook,
            marketMidYes: 0.45,
          },
        }),
      ),
    ).toHaveLength(0)

    // Allows child trade when fresh parent.book passes G1 & G2 and marketMidYes is omitted
    const freshParentBook = makeBook(0.69, 0.71, 0.29, 0.31, {
      slug: 'btc-updown-15m-parent',
    })
    const freshParentDerivedChild = evaluateStrategy(
      'cx-nested-coherence',
      makeContext({
        timeframe: '5m',
        openTwap: 100_000,
        secondsRemaining: 120,
        secondsElapsed: 180,
        oracle: makeOracle({ chainlinkTwap60s: 100_165, sigma1m: 0.001 }),
        book: makeBook(0.44, 0.46, 0.54, 0.56),
        nestedParent: {
          slug: 'btc-updown-15m-parent',
          timeframe: '15m',
          resolutionSource: 'chainlink-twap-60s',
          openTwap: 100_000,
          secondsRemaining: 600,
          secondsElapsed: 300,
          book: freshParentBook,
        },
      }),
    )
    expect(freshParentDerivedChild).toHaveLength(1)
    expect(freshParentDerivedChild[0]).toMatchObject({
      strategyId: 'cx-nested-coherence',
      slug: 'btc-updown-5m-test',
      outcome: 'YES',
      limitPrice: 0.46,
    })

    // Rejects stale parent.book (asOfMs = nowMs - 60_000) when marketMidYes is omitted even if recommendedLeg === 'child'
    const staleParentBook = makeBook(0.69, 0.71, 0.29, 0.31, {
      slug: 'btc-updown-15m-parent',
      yes: makeSide('yes-parent', 0.69, 0.71, {
        asOfMs: BASE_NOW_MS - 60_000,
      }),
      no: makeSide('no-parent', 0.29, 0.31),
    })
    expect(
      evaluateStrategy(
        'cx-nested-coherence',
        makeContext({
          timeframe: '5m',
          openTwap: 100_000,
          secondsRemaining: 120,
          secondsElapsed: 180,
          oracle: makeOracle({ chainlinkTwap60s: 100_165, sigma1m: 0.001 }),
          book: makeBook(0.44, 0.46, 0.54, 0.56),
          nestedParent: {
            slug: 'btc-updown-15m-parent',
            timeframe: '15m',
            resolutionSource: 'chainlink-twap-60s',
            openTwap: 100_000,
            secondsRemaining: 600,
            secondsElapsed: 300,
            book: staleParentBook,
          },
        }),
      ),
    ).toHaveLength(0)

    // Rejects unknown parent resolutionSource even when marketMidYes is provided for child trade
    expect(
      evaluateStrategy(
        'cx-nested-coherence',
        makeContext({
          timeframe: '5m',
          openTwap: 100_000,
          secondsRemaining: 120,
          secondsElapsed: 180,
          oracle: makeOracle({ chainlinkTwap60s: 100_120, sigma1m: 0.001 }),
          book: makeBook(0.44, 0.46, 0.54, 0.56),
          nestedParent: {
            slug: 'btc-updown-15m-parent',
            timeframe: '15m',
            resolutionSource: 'unknown',
            openTwap: 100_000,
            secondsRemaining: 600,
            secondsElapsed: 300,
            marketMidYes: 0.65,
          },
        }),
      ),
    ).toHaveLength(0)

    // Rejects same-slug self-parenting and non-strictly-longer parent secondsRemaining
    expect(
      evaluateStrategy(
        'cx-nested-coherence',
        makeContext({
          timeframe: '5m',
          openTwap: 100_000,
          secondsRemaining: 120,
          secondsElapsed: 180,
          oracle: makeOracle({ chainlinkTwap60s: 100_120, sigma1m: 0.001 }),
          book: makeBook(0.44, 0.46, 0.54, 0.56),
          nestedParent: {
            slug: 'btc-updown-5m-test',
            timeframe: '5m',
            resolutionSource: 'chainlink-twap-60s',
            openTwap: 100_000,
            secondsRemaining: 120,
            secondsElapsed: 180,
            marketMidYes: 0.9,
          },
        }),
      ),
    ).toHaveLength(0)

    expect(
      evaluateStrategy(
        'cx-nested-coherence',
        makeContext({
          timeframe: '5m',
          openTwap: 100_000,
          secondsRemaining: 120,
          secondsElapsed: 180,
          oracle: makeOracle({ chainlinkTwap60s: 100_120, sigma1m: 0.001 }),
          book: makeBook(0.44, 0.46, 0.54, 0.56),
          nestedParent: {
            slug: 'btc-updown-15m-equal-rem',
            timeframe: '15m',
            resolutionSource: 'chainlink-twap-60s',
            openTwap: 100_000,
            secondsRemaining: 120,
            secondsElapsed: 780,
            marketMidYes: 0.9,
          },
        }),
      ),
    ).toHaveLength(0)

    // Fails closed on parent leg when 15m parent omits secondsElapsed (must not bypass AVOID_FIRST_60S)
    expect(
      evaluateStrategy(
        'cx-nested-coherence',
        makeContext({
          timeframe: '5m',
          openTwap: 100_000,
          secondsRemaining: 120,
          secondsElapsed: 180,
          oracle: makeOracle({ chainlinkTwap60s: 100_250, sigma1m: 0.001 }),
          book: makeBook(0.95, 0.97, 0.03, 0.05),
          nestedParent: {
            slug: 'btc-updown-15m-parent',
            timeframe: '15m',
            resolutionSource: 'chainlink-twap-60s',
            openTwap: 100_000,
            secondsRemaining: 600,
            book: parentBook,
          },
        }),
      ),
    ).toHaveLength(0)
  })

  it('8. c5-15-longshot-fade supports both YES-favorite and NO-favorite orientations', () => {
    // Orientation A: NO bid overpriced at 0.25 (model NO = 0.16), YES ask at 0.75 (model YES = 0.84)
    const buyYes = evaluateStrategy(
      'c5-15-longshot-fade',
      makeContext({
        timeframe: '5m',
        secondsRemaining: 120,
        secondsElapsed: 180,
        calibratedPYes: 0.84,
        book: makeBook(0.73, 0.75, 0.25, 0.27),
      }),
    )
    expect(buyYes).toHaveLength(1)
    expect(buyYes[0]).toMatchObject({
      strategyId: 'c5-15-longshot-fade',
      outcome: 'YES',
      limitPrice: 0.75,
    })

    // Orientation B: YES bid overpriced at 0.25 (model YES = 0.15), NO ask at 0.76 (model NO = 0.85)
    const buyNo = evaluateStrategy(
      'c5-15-longshot-fade',
      makeContext({
        timeframe: '15m',
        secondsRemaining: 300,
        secondsElapsed: 600,
        calibratedPYes: 0.15,
        book: makeBook(0.25, 0.27, 0.74, 0.76),
      }),
    )
    expect(buyNo).toHaveLength(1)
    expect(buyNo[0]).toMatchObject({
      strategyId: 'c5-15-longshot-fade',
      outcome: 'NO',
      limitPrice: 0.76,
    })

    // evaluateAllStrategies aggregates matching intents
    const allIntents = evaluateAllStrategies(
      makeContext({
        timeframe: '15m',
        secondsRemaining: 350,
        secondsElapsed: 550,
        calibratedPYes: 0.84,
        book: makeBook(0.73, 0.75, 0.25, 0.27),
      }),
    )
    const ids = allIntents.map((i) => i.strategyId)
    expect(ids).toContain('c15-favorite-carry')
    expect(ids).toContain('c5-15-longshot-fade')
  })
})

describe('Promotion Gate & Canary Risk Budget', () => {
  it('enforces n >= 500, Wilson LB >= breakEven + 1.0pp, netPnl > 0, and markout >= -0.02 for canary/scale', () => {
    // Non-live transitions always succeed
    expect(
      evaluatePromotionTransition('research', 'paper', null).allowed,
    ).toBe(true)

    // Blocks missing report or n = 499
    const noReport = evaluatePromotionTransition('paper', 'canary', null)
    expect(noReport.allowed).toBe(false)

    const underSampled = evaluatePromotionTransition(
      'paper',
      'canary',
      makePromotionReport({ settledWindowCount: 499, eligibleForCanary: false }),
    )
    expect(underSampled.allowed).toBe(false)
    expect(underSampled.failures[0]).toContain('499 / 500')

    // Blocks Wilson LB < breakEven + 1.0pp
    const weakWilson = evaluatePromotionTransition(
      'paper',
      'scale',
      makePromotionReport({
        wilsonLowerBoundPct: 86.5,
        avgBreakEvenPct: 85.9,
        eligibleForCanary: false,
      }),
    )
    expect(weakWilson.allowed).toBe(false)

    // Blocks negative PnL and poor markout
    const negativePnl = evaluatePromotionTransition(
      'paper',
      'canary',
      makePromotionReport({ netPnlUsd: -1.5, meanMarkout30s: -0.03 }),
    )
    expect(negativePnl.allowed).toBe(false)
    expect(negativePnl.failures).toHaveLength(2)

    // Passes when all criteria met
    const passed = evaluatePromotionTransition(
      'paper',
      'canary',
      makePromotionReport(),
    )
    expect(passed.allowed).toBe(true)
    expect(passed.forcedOverride).toBe(false)
    expect(passed.requiresAudit).toBe(true)
    expect(passed.auditDetails?.action).toBe('prediction.strategy.promote')

    // Force override requires non-empty reason
    const missingReason = evaluatePromotionTransition(
      'paper',
      'canary',
      makePromotionReport({ settledWindowCount: 120 }),
      { forceOverride: true, overrideReason: '   ' },
    )
    expect(missingReason.allowed).toBe(false)

    const validOverride = evaluatePromotionTransition(
      'paper',
      'canary',
      makePromotionReport({ settledWindowCount: 120 }),
      { forceOverride: true, overrideReason: 'Operator canary smoke test' },
    )
    expect(validOverride.allowed).toBe(true)
    expect(validOverride.forcedOverride).toBe(true)
    expect(validOverride.requiresAudit).toBe(true)
    expect(validOverride.auditDetails?.overrideReason).toBe(
      'Operator canary smoke test',
    )
  })

  it('enforces $5/trade, 3-4 daily losses, $15-$20 daily loss cap, and $15 BTC single-factor exposure cap', () => {
    // Rejects stake > $5
    const overStake = checkCanaryRiskBudget([], 0, 0, DEFAULT_CANARY_RISK_CONFIG, 10)
    expect(overStake.allowed).toBe(false)

    // Allows 3rd trade after 2 losses with fees (todayLossUsd = 10.35 < 15)
    const twoLossesWithFees = checkCanaryRiskBudget([], 2, 10.35)
    expect(twoLossesWithFees.allowed).toBe(true)
    expect(twoLossesWithFees.approvedStakeUsd).toBe(5)

    // Halts at 3 daily losses under default config
    const threeLosses = checkCanaryRiskBudget([], 3, 15)
    expect(threeLosses.allowed).toBe(false)

    // Allows 4th loss slot when maxDailyLosses = 4 (cap $20)
    const fourLimitConfig = { maxDailyLosses: 4 as const }
    const threeOfFour = checkCanaryRiskBudget([], 3, 15.5, fourLimitConfig)
    expect(threeOfFour.allowed).toBe(true)
    const fourOfFour = checkCanaryRiskBudget([], 4, 20.5, fourLimitConfig)
    expect(fourOfFour.allowed).toBe(false)

    // Enforces $15 BTC single-factor exposure cap across 5m + 15m + 1h
    const openPositions = [
      { slug: 'btc-5m-1', timeframe: '5m' as const, stakeUsd: 5 },
      { slug: 'btc-15m-1', timeframe: '15m' as const, stakeUsd: 5 },
      { slug: 'btc-1h-1', timeframe: '1h' as const, stakeUsd: 5 },
    ]
    const btcCapped = checkCanaryRiskBudget(openPositions, 0, 0)
    expect(btcCapped.allowed).toBe(false)
    expect(btcCapped.openBtcExposureUsd).toBe(15)
    expect(btcCapped.remainingBtcExposureUsd).toBe(0)

    // Non-BTC positions do not consume the BTC single-factor exposure cap
    const ethPositions = [
      { slug: 'eth-5m-1', timeframe: '5m' as const, stakeUsd: 5, asset: 'ETH' },
      { slug: 'btc-5m-1', timeframe: '5m' as const, stakeUsd: 5, asset: 'BTC' },
    ]
    const allowedWithEth = checkCanaryRiskBudget(ethPositions, 0, 0)
    expect(allowedWithEth.allowed).toBe(true)
    expect(allowedWithEth.openBtcExposureUsd).toBe(5)
    expect(allowedWithEth.remainingBtcExposureUsd).toBe(10)
  })
})
