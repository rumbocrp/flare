import { describe, expect, it } from 'vitest'
import { buildMarketContext } from '../predictions'
import { computeNowcast } from './nowcast'
import {
  buildCandleFeatureCache,
  CANDLE_FEATURE_NAMES,
  extractCandleFeatures,
  extractPolymarketWindowFeatures,
  POLYMARKET_FEATURE_NAMES,
  scoreWithMetaFilterModel,
  splitPurgedChronological,
  trainAndEvaluateMetaFilter,
  type MetaSample,
} from './mlMetaFilter'
import type { Candle } from '../types'

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeStructuredSamples(count: number, seed = 42): MetaSample[] {
  const rng = mulberry32(seed)
  const samples: MetaSample[] = []
  const baseTs = 1_760_000_000_000

  for (let i = 0; i < count; i++) {
    const spreadCents = 0.5 + rng() * 5.5
    const volSpike = 0.6 + rng() * 3.0
    const absBasisBps = rng() * 45
    const zAligned = 0.3 + rng() * 2.8
    const depthLog = 1.5 + rng() * 2.0
    const lossStreak = Math.floor(rng() * 5)

    // Structured non-linear toxic loss regimes:
    // Regime A: High volSpike (> 2.2) & wide spread (> 3.2c) -> heavy losses
    // Regime B: Extreme basis divergence (> 28 bps) -> adverse selection losses
    // Regime C: Weak zAligned (< 0.85) + streak >= 3 -> chop losses
    const toxicA = volSpike > 2.1 && spreadCents > 3.0
    const toxicB = absBasisBps > 27
    const toxicC = zAligned < 0.85 && lossStreak >= 3
    const winProb = toxicA
      ? 0.08
      : toxicB
        ? 0.12
        : toxicC
          ? 0.18
          : 0.93

    const outcome: 0 | 1 = rng() < winProb ? 1 : 0
    const stakeUsd = 5
    const netPnlUsd = outcome === 1 ? 1.85 : -5.08

    samples.push({
      timestampMs: baseTs + i * 300_000,
      featureVector: [
        zAligned,
        zAligned,
        outcome === 1 ? 0.82 : 0.79, // subtle model signal
        0.74,
        4.0,
        spreadCents,
        depthLog,
        rng() * 0.4 - 0.2,
        12 * volSpike,
        volSpike,
        absBasisBps,
        0.4,
        1.2,
        rng() * 6 - 3,
        Math.sin((i % 24) * (Math.PI / 12)),
        lossStreak,
      ],
      outcome,
      netPnlUsd,
      stakeUsd,
    })
  }
  return samples
}

describe('ML Meta-Labeling & Loss-Mitigation Engine', () => {
  it('enforces chronological ordering and exact purge gaps across train / val / test splits', () => {
    const samples = makeStructuredSamples(200, 11).reverse()
    const split = splitPurgedChronological(samples, {
      trainRatio: 0.55,
      valRatio: 0.20,
      purgeGap: 5,
    })

    expect(split.purgeGapUsed).toBe(5)
    expect(split.train.length).toBeGreaterThan(90)
    expect(split.val.length).toBeGreaterThan(30)
    expect(split.test.length).toBeGreaterThan(30)
    expect(split.train.length + split.val.length + split.test.length).toBe(190)

    const lastTrainTs = split.train[split.train.length - 1].timestampMs
    const firstValTs = split.val[0].timestampMs
    const lastValTs = split.val[split.val.length - 1].timestampMs
    const firstTestTs = split.test[0].timestampMs

    // Exactly 5 intervals (6 * 300_000 ms) between train->val and val->test
    expect(firstValTs - lastTrainTs).toBe(6 * 300_000)
    expect(firstTestTs - lastValTs).toBe(6 * 300_000)
  })

  it('guarantees zero future leakage: mutating held-out test outcomes leaves the trained model byte-for-byte identical', () => {
    const baseSamples = makeStructuredSamples(320, 77)
    const split = splitPurgedChronological(baseSamples, {
      trainRatio: 0.55,
      valRatio: 0.20,
      purgeGap: 3,
    })
    const testStartTs = split.test[0].timestampMs

    const mutatedSamples = baseSamples.map((s) =>
      s.timestampMs >= testStartTs
        ? { ...s, outcome: (s.outcome === 1 ? 0 : 1) as 0 | 1, netPnlUsd: -s.netPnlUsd }
        : s,
    )

    const cfg = {
      strategyId: 'leak-check-strat',
      featureNames: POLYMARKET_FEATURE_NAMES,
      trainRatio: 0.55,
      valRatio: 0.20,
      purgeGap: 3,
      lossPenalty: 4.0,
    }

    const resA = trainAndEvaluateMetaFilter(baseSamples, cfg)
    const resB = trainAndEvaluateMetaFilter(mutatedSamples, cfg)

    // Trained weights, trees, veto rules, calibrator, and threshold must be 100% identical
    expect(resB.model).toEqual(resA.model)
    // Out-of-sample test metrics genuinely differ
    expect(resB.baseline.wins).not.toBe(resA.baseline.wins)
  })

  it('eliminates most toxic negative outcomes and significantly increases out-of-sample win rate & profit factor', () => {
    const samples = makeStructuredSamples(450, 123)
    const res = trainAndEvaluateMetaFilter(samples, {
      strategyId: 'c5-test-loss-mitigation',
      featureNames: POLYMARKET_FEATURE_NAMES,
      lossPenalty: 4.0,
      minRecall: 0.35,
      targetWinRate: 0.90,
      purgeGap: 2,
    })

    expect(res.testSamples).toBeGreaterThan(80)
    expect(res.baseline.losses).toBeGreaterThan(15)
    // Significant out-of-sample win rate improvement & loss elimination
    expect(res.filtered.winRatePct).toBeGreaterThan(res.baseline.winRatePct + 10)
    expect(res.delta.lossEliminationRatePct).toBeGreaterThanOrEqual(65)
    expect(res.filtered.trades).toBeGreaterThanOrEqual(20)
    expect(res.filtered.netPnlUsd).toBeGreaterThan(res.baseline.netPnlUsd)
    expect(res.model.featureImportanceRanking[0]?.importance).toBeGreaterThan(0)

    // Serialization round-trip produces exact identical live inference scores
    const serialized = JSON.parse(JSON.stringify(res.model)) as typeof res.model
    const probeVec = samples[samples.length - 1].featureVector
    expect(scoreWithMetaFilterModel(serialized, probeVec)).toEqual(
      scoreWithMetaFilterModel(res.model, probeVec),
    )
  })

  it('extracts finite candle and Polymarket feature vectors matching canonical schemas', () => {
    const candles: Candle[] = Array.from({ length: 80 }, (_, i) => {
      const open = 95_000 + Math.sin(i / 5) * 300
      const close = open + Math.cos(i / 3) * 120
      return {
        time: 1_760_000_000_000 + i * 300_000,
        open,
        high: Math.max(open, close) + 60,
        low: Math.min(open, close) - 60,
        close,
        volume: 500 + (i % 7) * 90,
      }
    })
    const ctx = buildMarketContext(candles)
    const cache = buildCandleFeatureCache(ctx)
    const candleVec = extractCandleFeatures(ctx, cache, 70, 1)
    expect(candleVec).toHaveLength(CANDLE_FEATURE_NAMES.length)
    expect(candleVec.every((v) => Number.isFinite(v))).toBe(true)

    const nowcast = computeNowcast({
      openTwap: 95_000,
      currentTwap: 95_180,
      secondsRemaining: 90,
      sigma1m: 0.0012,
    })
    const polyVec = extractPolymarketWindowFeatures({
      snapshot: {
        slug: 'btc-updown-5m-1',
        capturedAtMs: 1_760_000_210_000,
        secondsRemaining: 90,
        twapPrice: 95_180,
        binancePrice: 95_185,
        sigma1m: 0.0012,
        basisBps: 0.5,
        yesBid: 0.89,
        yesAsk: 0.91,
        yesDepthUsd: 800,
        noBid: 0.08,
        noAsk: 0.10,
        noDepthUsd: 650,
      },
      window: {
        slug: 'btc-updown-5m-1',
        timeframe: '5m',
        resolutionSource: 'chainlink-twap-60s',
        startTimeMs: 1_760_000_000_000,
        endTimeMs: 1_760_000_300_000,
        openTwap: 95_000,
        closeTwap: 95_220,
        resolvedUp: true,
        snapshots: [],
      },
      nowcast,
      outcome: 'YES',
      entryPrice: 0.91,
      feePerShare: 0.0057,
      median24hSigma1m: 0.001,
      preEntrySpotPrice: 95_140,
      recentLossStreak: 1,
    })
    expect(polyVec).toHaveLength(POLYMARKET_FEATURE_NAMES.length)
    expect(polyVec.every((v) => Number.isFinite(v))).toBe(true)
  })
})
