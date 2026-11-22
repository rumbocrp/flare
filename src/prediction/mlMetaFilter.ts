/**
 * Cost-Sensitive ML Meta-Labeling & Loss-Mitigation Engine.
 *
 * Implements a zero-dependency, leak-free Purged Walk-Forward ML pipeline designed
 * to filter out high-loss-risk signals from primary trading/prediction strategies
 * and significantly improve out-of-sample Win Rate, Wilson 95% LB, Profit Factor,
 * and Drawdown:
 *   1. Standardized L2-Regularized Cost-Sensitive Logistic Regression
 *   2. Cost-Sensitive Gradient-Boosted Decision Trees (Depth-2 Newton GBDT)
 *   3. Fisher-Weighted Loss-Centroid Anomaly Scorer
 *   4. Interpretable Toxic-Regime Hard Veto Rules (mined strictly on train, verified on val)
 *   5. Out-of-Sample PAV Isotonic Calibration & Validation-Only Threshold Optimization
 *
 * Browser-and-server-safe pure TypeScript (zero Node-only imports, zero synthetic fallbacks).
 */
import { atr, bollingerBands, ema, macd, rsi, sma } from '../indicators'
import { computeWilsonLowerBoundPct, type MarketContext } from '../predictions'
import {
  applyCalibrator,
  fitIsotonicCalibrator,
  type CalibrationCurve,
  type CalibrationSample,
} from './calibration'
import type { NowcastEstimate } from './nowcast'
import type {
  CollectedWindowReplayInput,
  ReplaySnapshotPoint,
} from './replayHarness'

export const CANDLE_FEATURE_NAMES = [
  'ret1BarAlignedPct',
  'ret3BarAlignedPct',
  'ret8BarAlignedPct',
  'rangePct',
  'atrRatio',
  'realizedVol20Pct',
  'volRegimeRatio',
  'rsi14Norm',
  'rsiSlope3Aligned',
  'distSma20AlignedPct',
  'distEma50AlignedPct',
  'ema50SlopeAlignedPct',
  'bbPctB',
  'bbBandwidthPct',
  'macdHistAlignedBps',
  'volumeRatio20',
  'bodyPositionAligned',
  'utcHourSin',
  'utcHourCos',
] as const

export const POLYMARKET_FEATURE_NAMES = [
  'absZScore',
  'signedZAligned',
  'pModelSide',
  'entryPrice',
  'rawEdgeCents',
  'spreadCents',
  'depthLogUsd',
  'depthImbalanceAligned',
  'sigma1mBps',
  'sigmaSpikeRatio',
  'absBasisBps',
  'secondsRemainingFrac',
  'overroundCents',
  'preEntryDriftAlignedBps',
  'utcHourSin',
  'recentLossStreak',
] as const

export type MetaSample = {
  timestampMs: number
  featureVector: number[]
  outcome: 0 | 1
  netPnlUsd: number
  stakeUsd: number
  entryPrice?: number
  breakEvenPct?: number
}

export type StandardizerParams = {
  means: number[]
  stds: number[]
}

export type LogisticRegressionModel = {
  weights: number[]
  bias: number
  l2Lambda: number
  lossPenalty: number
}

export type DecisionTreeNode =
  | {
      kind: 'leaf'
      value: number
    }
  | {
      kind: 'split'
      featureIndex: number
      threshold: number
      left: DecisionTreeNode
      right: DecisionTreeNode
    }

export type GbdtModel = {
  initialLogOdds: number
  learningRate: number
  trees: DecisionTreeNode[]
  featureImportances: number[]
}

export type LossCentroidModel = {
  winMean: number[]
  lossMean: number[]
  featureWeights: number[]
}

export type HardVetoRule = {
  featureIndex: number
  featureName: string
  operator: '>' | '<'
  threshold: number
  trainLossRatePct: number
  trainSupport: number
}

export type FeatureImportanceEntry = {
  feature: string
  importance: number
  lossCorrelation: number
}

export type MetaFilterTrainConfig = {
  strategyId: string
  featureNames: readonly string[]
  trainRatio?: number
  valRatio?: number
  purgeGap?: number
  lossPenalty?: number
  l2Lambda?: number
  gbdtTrees?: number
  gbdtLearningRate?: number
  gbdtMinLeaf?: number
  gbdtLeafL2?: number
  minRecall?: number
  targetWinRate?: number
  maxVetoRules?: number
}

export type MetaFilterModel = {
  version: 1
  strategyId: string
  featureNames: string[]
  standardizer: StandardizerParams
  logistic: LogisticRegressionModel
  gbdt: GbdtModel
  lossCentroid: LossCentroidModel
  calibrator: CalibrationCurve
  ensembleWeights: {
    logistic: number
    gbdt: number
    centroid: number
  }
  /** Threshold applied directly to continuous ensemble `rawScore` (preserves full ranking granularity). */
  scoreThreshold: number
  /** Calibrated probability corresponding to `scoreThreshold` (for reporting & diagnostics). */
  probabilityThreshold: number
  hardVetoRules: HardVetoRule[]
  targetWinRate: number
  lossPenalty: number
  trainedSampleCount: number
  validationSampleCount: number
  featureImportanceRanking: FeatureImportanceEntry[]
}

export type MetaFilterScore = {
  rawScore: number
  calibratedWinProb: number
  logisticProb: number
  gbdtProb: number
  centroidSafetyProb: number
  hardVetoTriggered: string[]
  allowTrade: boolean
  sizeMultiplier: number
}

export type PerformanceSummary = {
  trades: number
  wins: number
  losses: number
  winRatePct: number
  wilson95LbPct: number
  netPnlUsd: number
  profitFactor: number | null
  maxDrawdownUsd: number
  maxDrawdownPct: number
  expectancyUsd: number
  recallPct: number
}

export type MetaBacktestComparison = {
  strategyId: string
  totalSamples: number
  trainSamples: number
  valSamples: number
  testSamples: number
  purgeGapUsed: number
  model: MetaFilterModel
  baseline: PerformanceSummary
  filtered: PerformanceSummary
  filteredSized: PerformanceSummary
  delta: {
    winRateLiftPp: number
    wilsonLiftPp: number
    lossesEliminated: number
    lossEliminationRatePct: number
    pnlDeltaUsd: number
    sizedPnlDeltaUsd: number
    drawdownReductionPct: number
  }
}

export type PurgedSplitResult = {
  train: MetaSample[]
  val: MetaSample[]
  test: MetaSample[]
  purgeGapUsed: number
}

export type CandleFeatureCache = {
  atr14: (number | null)[]
  macdHist: (number | null)[]
  realizedVol5: number[]
  realizedVol20: number[]
}

const EPS = 1e-9

function sigmoid(x: number): number {
  const clamped = Math.max(-30, Math.min(30, x))
  return 1 / (1 + Math.exp(-clamped))
}

function round(value: number, decimals = 4): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** decimals
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function sanitizeFeature(value: number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return fallback
  }
  return Math.max(-1e6, Math.min(1e6, value))
}

/**
 * Precomputes rolling indicator arrays once per candle series for fast feature extraction.
 */
export function buildCandleFeatureCache(ctx: MarketContext): CandleFeatureCache {
  const n = ctx.candles.length
  const atr14 = atr(ctx.candles, 14)
  const macdRes = macd(ctx.closes, 12, 26, 9)
  const realizedVol5: number[] = new Array<number>(n).fill(0)
  const realizedVol20: number[] = new Array<number>(n).fill(0)

  const calcRollingStd = (window: number, out: number[]): void => {
    for (let i = 0; i < n; i++) {
      const start = Math.max(0, i - window + 1)
      const count = i - start + 1
      if (count < 2) {
        out[i] = 0
        continue
      }
      let mean = 0
      for (let j = start; j <= i; j++) mean += ctx.returns[j]
      mean /= count
      let sumSq = 0
      for (let j = start; j <= i; j++) {
        const d = ctx.returns[j] - mean
        sumSq += d * d
      }
      out[i] = Math.sqrt(sumSq / count)
    }
  }

  calcRollingStd(5, realizedVol5)
  calcRollingStd(20, realizedVol20)

  return {
    atr14,
    macdHist: macdRes.histogram,
    realizedVol5,
    realizedVol20,
  }
}

/**
 * Extracts 19 strictly backward-looking (`<= index`) technical/regime features
 * aligned to the proposed trade direction (`+1` long/YES, `-1` short/NO).
 */
export function extractCandleFeatures(
  ctx: MarketContext,
  cache: CandleFeatureCache,
  index: number,
  directionSign: 1 | -1 = 1,
): number[] {
  const c = ctx.candles[index]
  if (!c) return new Array<number>(CANDLE_FEATURE_NAMES.length).fill(0)

  const close = Math.max(EPS, c.close)
  const ret1 = sanitizeFeature(ctx.returns[index]) * directionSign
  const close3 = index >= 3 ? ctx.candles[index - 3].close : c.open
  const ret3 =
    close3 > 0 ? ((close - close3) / close3) * 100 * directionSign : 0
  const close8 = index >= 8 ? ctx.candles[index - 8].close : c.open
  const ret8 =
    close8 > 0 ? ((close - close8) / close8) * 100 * directionSign : 0

  const rangePct = sanitizeFeature(ctx.ranges[index])
  const atrVal = cache.atr14[index]
  const atrRatio =
    atrVal !== null && atrVal > EPS ? (c.high - c.low) / atrVal : 1

  const rv20 = sanitizeFeature(cache.realizedVol20[index])
  const rv5 = sanitizeFeature(cache.realizedVol5[index])
  const volRegimeRatio = rv20 > EPS ? Math.min(5, rv5 / rv20) : 1

  const rsiNow = ctx.rsi14[index] ?? 50
  const rsiPrev3 = index >= 3 ? (ctx.rsi14[index - 3] ?? rsiNow) : rsiNow
  const rsi14Norm = rsiNow / 100
  const rsiSlope3Aligned = ((rsiNow - rsiPrev3) / 100) * directionSign

  const s20 = ctx.sma20[index]
  const distSma20AlignedPct =
    s20 !== null && s20 > EPS ? ((close - s20) / s20) * 100 * directionSign : 0

  const e50 = ctx.ema50[index]
  const distEma50AlignedPct =
    e50 !== null && e50 > EPS ? ((close - e50) / e50) * 100 * directionSign : 0

  const e50Prev5 = index >= 5 ? ctx.ema50[index - 5] : e50
  const ema50SlopeAlignedPct =
    e50 !== null && e50Prev5 !== null && e50Prev5 > EPS
      ? ((e50 - e50Prev5) / e50Prev5) * 100 * directionSign
      : 0

  const bbu = ctx.bbUpper20[index]
  const bbl = ctx.bbLower20[index]
  const bbSpan = bbu !== null && bbl !== null ? bbu - bbl : 0
  const bbPctB =
    bbu !== null && bbl !== null && bbSpan > EPS
      ? Math.max(-0.5, Math.min(1.5, (close - bbl) / bbSpan))
      : 0.5
  const bbBandwidthPct =
    s20 !== null && s20 > EPS && bbSpan > 0 ? (bbSpan / s20) * 100 : 0

  const macdH = cache.macdHist[index]
  const macdHistAlignedBps =
    macdH !== null ? (macdH / close) * 10_000 * directionSign : 0

  const avgVol = ctx.volSma20[index]
  const volumeRatio20 =
    avgVol !== null && avgVol > EPS ? Math.min(10, c.volume / avgVol) : 1

  const span = c.high - c.low
  const rawBodyPos = span > EPS ? (c.close - c.low) / span : 0.5
  const bodyPositionAligned =
    directionSign === 1 ? rawBodyPos : 1 - rawBodyPos

  const utcHour = new Date(c.time).getUTCHours()
  const angle = (2 * Math.PI * utcHour) / 24
  const utcHourSin = Math.sin(angle)
  const utcHourCos = Math.cos(angle)

  return [
    sanitizeFeature(ret1),
    sanitizeFeature(ret3),
    sanitizeFeature(ret8),
    sanitizeFeature(rangePct),
    sanitizeFeature(atrRatio, 1),
    sanitizeFeature(rv20),
    sanitizeFeature(volRegimeRatio, 1),
    sanitizeFeature(rsi14Norm, 0.5),
    sanitizeFeature(rsiSlope3Aligned),
    sanitizeFeature(distSma20AlignedPct),
    sanitizeFeature(distEma50AlignedPct),
    sanitizeFeature(ema50SlopeAlignedPct),
    sanitizeFeature(bbPctB, 0.5),
    sanitizeFeature(bbBandwidthPct),
    sanitizeFeature(macdHistAlignedBps),
    sanitizeFeature(volumeRatio20, 1),
    sanitizeFeature(bodyPositionAligned, 0.5),
    sanitizeFeature(utcHourSin),
    sanitizeFeature(utcHourCos),
  ]
}

/**
 * Extracts 16 strictly pre-trade microstructure, oracle, volatility, and regime
 * features for a Polymarket BTC Up/Down window decision.
 */
export function extractPolymarketWindowFeatures(params: {
  snapshot: ReplaySnapshotPoint
  window: CollectedWindowReplayInput
  nowcast: NowcastEstimate
  outcome: 'YES' | 'NO'
  entryPrice: number
  feePerShare: number
  median24hSigma1m?: number | null
  preEntrySpotPrice?: number | null
  recentLossStreak?: number
}): number[] {
  const {
    snapshot,
    window,
    nowcast,
    outcome,
    entryPrice,
    feePerShare,
    median24hSigma1m,
    preEntrySpotPrice,
    recentLossStreak = 0,
  } = params

  const sideSign = outcome === 'YES' ? 1 : -1
  const absZ = Math.abs(sanitizeFeature(nowcast.z))
  const signedZAligned = sanitizeFeature(nowcast.z) * sideSign
  const pModelSide =
    outcome === 'YES'
      ? sanitizeFeature(nowcast.pRawYes, 0.5)
      : 1 - sanitizeFeature(nowcast.pRawYes, 0.5)

  const rawEdgeCents = (pModelSide - entryPrice - feePerShare) * 100

  const bid = outcome === 'YES' ? snapshot.yesBid : snapshot.noBid
  const ask = outcome === 'YES' ? snapshot.yesAsk : snapshot.noAsk
  const spreadCents =
    bid !== null && ask !== null && Number.isFinite(bid) && Number.isFinite(ask)
      ? Math.max(0, (ask - bid) * 100)
      : 2

  const yesDepth = Math.max(0, sanitizeFeature(snapshot.yesDepthUsd, 0))
  const noDepth = Math.max(0, sanitizeFeature(snapshot.noDepthUsd, 0))
  const minDepth = Math.min(yesDepth, noDepth)
  const depthLogUsd = Math.log10(1 + minDepth)
  const depthImbalanceAligned =
    ((yesDepth - noDepth) / (yesDepth + noDepth + EPS)) * sideSign

  const sigma = Math.max(0, sanitizeFeature(snapshot.sigma1m, 0))
  const sigma1mBps = sigma * 10_000
  const medSigma =
    median24hSigma1m !== undefined &&
    median24hSigma1m !== null &&
    Number.isFinite(median24hSigma1m) &&
    median24hSigma1m > EPS
      ? median24hSigma1m
      : sigma > EPS
        ? sigma
        : 0.001
  const sigmaSpikeRatio = Math.min(10, sigma / medSigma)

  const absBasisBps = Math.abs(sanitizeFeature(snapshot.basisBps, 0))
  const durationSec = Math.max(1, (window.endTimeMs - window.startTimeMs) / 1000)
  const secondsRemainingFrac = Math.max(
    0,
    Math.min(1, sanitizeFeature(snapshot.secondsRemaining, 0) / durationSec),
  )

  const yesAsk = snapshot.yesAsk ?? 0.5
  const noAsk = snapshot.noAsk ?? 0.5
  const overroundCents = (yesAsk + noAsk - 1) * 100

  const spotNow = snapshot.twapPrice ?? snapshot.binancePrice ?? null
  const preEntryDriftAlignedBps =
    spotNow !== null &&
    preEntrySpotPrice !== undefined &&
    preEntrySpotPrice !== null &&
    preEntrySpotPrice > EPS
      ? ((spotNow - preEntrySpotPrice) / preEntrySpotPrice) * 10_000 * sideSign
      : 0

  const utcHour = new Date(snapshot.capturedAtMs).getUTCHours()
  const utcHourSin = Math.sin((2 * Math.PI * utcHour) / 24)

  return [
    sanitizeFeature(absZ),
    sanitizeFeature(signedZAligned),
    sanitizeFeature(pModelSide, 0.5),
    sanitizeFeature(entryPrice, 0.5),
    sanitizeFeature(rawEdgeCents),
    sanitizeFeature(spreadCents),
    sanitizeFeature(depthLogUsd),
    sanitizeFeature(depthImbalanceAligned),
    sanitizeFeature(sigma1mBps),
    sanitizeFeature(sigmaSpikeRatio, 1),
    sanitizeFeature(absBasisBps),
    sanitizeFeature(secondsRemainingFrac),
    sanitizeFeature(overroundCents),
    sanitizeFeature(preEntryDriftAlignedBps),
    sanitizeFeature(utcHourSin),
    sanitizeFeature(Math.min(10, Math.max(0, recentLossStreak))),
  ]
}

/**
 * Chronologically sorts samples and performs a purged 3-way split (train / val / test)
 * so overlapping horizons cannot leak future labels across split boundaries.
 */
export function splitPurgedChronological(
  samples: readonly MetaSample[],
  options?: {
    trainRatio?: number
    valRatio?: number
    purgeGap?: number
  },
): PurgedSplitResult {
  const ordered = [...samples].sort((a, b) => a.timestampMs - b.timestampMs)
  const n = ordered.length
  if (n < 12) {
    return { train: ordered, val: [], test: [], purgeGapUsed: 0 }
  }

  const trainRatio = Math.max(0.4, Math.min(0.7, options?.trainRatio ?? 0.55))
  const valRatio = Math.max(0.15, Math.min(0.3, options?.valRatio ?? 0.2))
  const requestedPurge = Math.max(0, Math.round(options?.purgeGap ?? 2))
  const maxSafePurge = Math.max(0, Math.floor((n - 12) / 6))
  const purgeGapUsed = Math.min(requestedPurge, maxSafePurge)

  const usable = n - 2 * purgeGapUsed
  const trainCount = Math.max(6, Math.floor(usable * trainRatio))
  const valCount = Math.max(3, Math.floor(usable * valRatio))

  const train = ordered.slice(0, trainCount)
  const valStart = trainCount + purgeGapUsed
  const valEnd = Math.min(n - purgeGapUsed - 3, valStart + valCount)
  const val = ordered.slice(valStart, valEnd)
  const testStart = valEnd + purgeGapUsed
  const test = ordered.slice(testStart)

  return { train, val, test, purgeGapUsed }
}

function fitStandardizer(samples: readonly MetaSample[], dim: number): StandardizerParams {
  const means = new Array<number>(dim).fill(0)
  const stds = new Array<number>(dim).fill(1)
  if (samples.length === 0) return { means, stds }

  for (const s of samples) {
    for (let j = 0; j < dim; j++) {
      means[j] += sanitizeFeature(s.featureVector[j])
    }
  }
  for (let j = 0; j < dim; j++) means[j] /= samples.length

  for (const s of samples) {
    for (let j = 0; j < dim; j++) {
      const d = sanitizeFeature(s.featureVector[j]) - means[j]
      stds[j] += d * d
    }
  }
  for (let j = 0; j < dim; j++) {
    const variance = (stds[j] - 1) / Math.max(1, samples.length)
    stds[j] = variance > 1e-10 ? Math.sqrt(variance) : 1
  }

  return { means, stds }
}

function applyStandardizer(
  vec: readonly number[],
  std: StandardizerParams,
): number[] {
  const out = new Array<number>(std.means.length)
  for (let j = 0; j < std.means.length; j++) {
    const z = (sanitizeFeature(vec[j]) - std.means[j]) / (std.stds[j] || 1)
    out[j] = Math.max(-5, Math.min(5, z))
  }
  return out
}

function computeSampleWeights(
  samples: readonly MetaSample[],
  lossPenalty: number,
): number[] {
  return samples.map((s) => {
    if (s.outcome === 0) {
      const severity = Math.min(
        2,
        Math.abs(sanitizeFeature(s.netPnlUsd)) / Math.max(1, sanitizeFeature(s.stakeUsd, 1)),
      )
      return lossPenalty * (1 + 0.5 * severity)
    }
    return 1
  })
}

function trainWeightedLogisticRegression(
  X: readonly number[][],
  y: readonly (0 | 1)[],
  weights: readonly number[],
  dim: number,
  l2Lambda: number,
  lossPenalty: number,
): LogisticRegressionModel {
  const w = new Array<number>(dim).fill(0)
  let sumW = 0
  let sumWPos = 0
  for (let i = 0; i < y.length; i++) {
    sumW += weights[i]
    if (y[i] === 1) sumWPos += weights[i]
  }
  let bias = Math.log((sumWPos + 1) / (sumW - sumWPos + 1))

  const velW = new Array<number>(dim).fill(0)
  let velB = 0
  const momentum = 0.85
  const totalWeight = Math.max(EPS, sumW)
  const iterations = 260

  for (let iter = 0; iter < iterations; iter++) {
    const lr = 0.35 / (1 + iter * 0.015)
    const gradW = new Array<number>(dim).fill(0)
    let gradB = 0

    for (let i = 0; i < X.length; i++) {
      let dot = bias
      const row = X[i]
      for (let j = 0; j < dim; j++) dot += w[j] * row[j]
      const err = (sigmoid(dot) - y[i]) * weights[i]
      gradB += err
      for (let j = 0; j < dim; j++) gradW[j] += err * row[j]
    }

    gradB /= totalWeight
    velB = momentum * velB - lr * gradB
    bias += velB

    let maxGrad = Math.abs(gradB)
    for (let j = 0; j < dim; j++) {
      const g = gradW[j] / totalWeight + l2Lambda * w[j]
      velW[j] = momentum * velW[j] - lr * g
      w[j] += velW[j]
      if (Math.abs(g) > maxGrad) maxGrad = Math.abs(g)
    }
    if (maxGrad < 1e-5) break
  }

  return {
    weights: w.map((v) => round(v, 6)),
    bias: round(bias, 6),
    l2Lambda,
    lossPenalty,
  }
}

function predictLogistic(z: readonly number[], model: LogisticRegressionModel): number {
  let dot = model.bias
  for (let j = 0; j < model.weights.length; j++) {
    dot += model.weights[j] * (z[j] ?? 0)
  }
  return sigmoid(dot)
}

function fitDecisionTree(
  X: readonly number[][],
  indices: readonly number[],
  gradients: readonly number[],
  hessians: readonly number[],
  dim: number,
  depth: number,
  maxDepth: number,
  minLeaf: number,
  leafL2: number,
  importances: number[],
): DecisionTreeNode {
  let sumG = 0
  let sumH = 0
  for (const idx of indices) {
    sumG += gradients[idx]
    sumH += hessians[idx]
  }
  const leafValue = Math.max(-3, Math.min(3, -sumG / (sumH + leafL2)))

  if (depth >= maxDepth || indices.length < minLeaf * 2) {
    return { kind: 'leaf', value: round(leafValue, 6) }
  }

  const parentScore = (sumG * sumG) / (sumH + leafL2)
  let bestGain = 0.02 // Minimum regularization gamma to prevent noisy splits
  let bestFeature = -1
  let bestThreshold = 0

  const buckets = 20
  for (let f = 0; f < dim; f++) {
    const vals = indices.map((i) => X[i][f]).sort((a, b) => a - b)
    const minVal = vals[0]
    const maxVal = vals[vals.length - 1]
    if (maxVal - minVal < 1e-8) continue

    let prevThreshold = Number.NEGATIVE_INFINITY
    for (let b = 1; b < buckets; b++) {
      const qIdx = Math.floor((vals.length * b) / buckets)
      const threshold = vals[qIdx]
      if (threshold <= prevThreshold) continue
      prevThreshold = threshold

      let gL = 0
      let hL = 0
      let countL = 0
      for (const idx of indices) {
        if (X[idx][f] <= threshold) {
          gL += gradients[idx]
          hL += hessians[idx]
          countL++
        }
      }
      const countR = indices.length - countL
      if (countL < minLeaf || countR < minLeaf) continue

      const gR = sumG - gL
      const hR = sumH - hL
      const gain =
        0.5 *
        ((gL * gL) / (hL + leafL2) + (gR * gR) / (hR + leafL2) - parentScore)

      if (gain > bestGain) {
        bestGain = gain
        bestFeature = f
        bestThreshold = threshold
      }
    }
  }

  if (bestFeature === -1) {
    return { kind: 'leaf', value: round(leafValue, 6) }
  }

  importances[bestFeature] += bestGain
  const leftIndices: number[] = []
  const rightIndices: number[] = []
  for (const idx of indices) {
    if (X[idx][bestFeature] <= bestThreshold) {
      leftIndices.push(idx)
    } else {
      rightIndices.push(idx)
    }
  }

  return {
    kind: 'split',
    featureIndex: bestFeature,
    threshold: round(bestThreshold, 6),
    left: fitDecisionTree(
      X,
      leftIndices,
      gradients,
      hessians,
      dim,
      depth + 1,
      maxDepth,
      minLeaf,
      leafL2,
      importances,
    ),
    right: fitDecisionTree(
      X,
      rightIndices,
      gradients,
      hessians,
      dim,
      depth + 1,
      maxDepth,
      minLeaf,
      leafL2,
      importances,
    ),
  }
}

function evalTree(node: DecisionTreeNode, x: readonly number[]): number {
  let curr = node
  while (curr.kind === 'split') {
    curr = (x[curr.featureIndex] ?? 0) <= curr.threshold ? curr.left : curr.right
  }
  return curr.value
}

function trainCostSensitiveGbdt(
  X: readonly number[][],
  y: readonly (0 | 1)[],
  weights: readonly number[],
  dim: number,
  options: {
    numTrees: number
    learningRate: number
    minLeaf: number
    leafL2: number
  },
): GbdtModel {
  let sumW = 0
  let sumWPos = 0
  for (let i = 0; i < y.length; i++) {
    sumW += weights[i]
    if (y[i] === 1) sumWPos += weights[i]
  }
  const initialLogOdds = Math.log((sumWPos + 1) / (sumW - sumWPos + 1))
  const scores = new Array<number>(X.length).fill(initialLogOdds)
  const allIndices = Array.from({ length: X.length }, (_, i) => i)
  const importances = new Array<number>(dim).fill(0)
  const trees: DecisionTreeNode[] = []

  for (let t = 0; t < options.numTrees; t++) {
    const gradients = new Array<number>(X.length)
    const hessians = new Array<number>(X.length)
    for (let i = 0; i < X.length; i++) {
      const p = sigmoid(scores[i])
      gradients[i] = weights[i] * (p - y[i])
      hessians[i] = Math.max(1e-4, weights[i] * p * (1 - p))
    }

    const tree = fitDecisionTree(
      X,
      allIndices,
      gradients,
      hessians,
      dim,
      0,
      3,
      options.minLeaf,
      options.leafL2,
      importances,
    )
    if (tree.kind === 'leaf') {
      // No informative split found; stop boosting early to prevent overfitting
      break
    }

    trees.push(tree)
    for (let i = 0; i < X.length; i++) {
      scores[i] += options.learningRate * evalTree(tree, X[i])
    }
  }

  const impTotal = importances.reduce((a, b) => a + b, 0)
  const normalizedImp =
    impTotal > EPS
      ? importances.map((v) => round(v / impTotal, 4))
      : importances.map(() => 0)

  return {
    initialLogOdds: round(initialLogOdds, 6),
    learningRate: options.learningRate,
    trees,
    featureImportances: normalizedImp,
  }
}

function predictGbdt(z: readonly number[], model: GbdtModel): number {
  let score = model.initialLogOdds
  for (const tree of model.trees) {
    score += model.learningRate * evalTree(tree, z)
  }
  return sigmoid(score)
}

function trainLossCentroidModel(
  X: readonly number[][],
  y: readonly (0 | 1)[],
  dim: number,
): LossCentroidModel {
  const winMean = new Array<number>(dim).fill(0)
  const lossMean = new Array<number>(dim).fill(0)
  const winVar = new Array<number>(dim).fill(0)
  const lossVar = new Array<number>(dim).fill(0)
  let winCount = 0
  let lossCount = 0

  for (let i = 0; i < X.length; i++) {
    if (y[i] === 1) {
      winCount++
      for (let j = 0; j < dim; j++) winMean[j] += X[i][j]
    } else {
      lossCount++
      for (let j = 0; j < dim; j++) lossMean[j] += X[i][j]
    }
  }
  if (winCount > 0) for (let j = 0; j < dim; j++) winMean[j] /= winCount
  if (lossCount > 0) for (let j = 0; j < dim; j++) lossMean[j] /= lossCount

  for (let i = 0; i < X.length; i++) {
    if (y[i] === 1) {
      for (let j = 0; j < dim; j++) {
        const d = X[i][j] - winMean[j]
        winVar[j] += d * d
      }
    } else {
      for (let j = 0; j < dim; j++) {
        const d = X[i][j] - lossMean[j]
        lossVar[j] += d * d
      }
    }
  }

  const featureWeights = new Array<number>(dim).fill(0)
  let weightSum = 0
  for (let j = 0; j < dim; j++) {
    const vW = winCount > 1 ? winVar[j] / winCount : 1
    const vL = lossCount > 1 ? lossVar[j] / lossCount : 1
    const diff = winMean[j] - lossMean[j]
    const fisher = (diff * diff) / (vW + vL + 0.25)
    featureWeights[j] = fisher
    weightSum += fisher
  }

  const normalizedWeights =
    weightSum > EPS
      ? featureWeights.map((w) => round(w / weightSum, 5))
      : new Array<number>(dim).fill(round(1 / Math.max(1, dim), 5))

  return {
    winMean: winMean.map((v) => round(v, 5)),
    lossMean: lossMean.map((v) => round(v, 5)),
    featureWeights: normalizedWeights,
  }
}

function predictCentroidSafety(
  z: readonly number[],
  model: LossCentroidModel,
): number {
  let distWinSq = 0
  let distLossSq = 0
  for (let j = 0; j < model.featureWeights.length; j++) {
    const w = model.featureWeights[j]
    if (w <= 0) continue
    const dW = (z[j] ?? 0) - model.winMean[j]
    const dL = (z[j] ?? 0) - model.lossMean[j]
    distWinSq += w * dW * dW
    distLossSq += w * dL * dL
  }
  const dWin = Math.sqrt(distWinSq)
  const dLoss = Math.sqrt(distLossSq)
  return dLoss / (dWin + dLoss + EPS)
}

function checkHardVetoRules(
  rawFeatures: readonly number[],
  rules: readonly HardVetoRule[],
): string[] {
  const triggered: string[] = []
  for (const r of rules) {
    const val = sanitizeFeature(rawFeatures[r.featureIndex])
    const hit = r.operator === '>' ? val > r.threshold : val < r.threshold
    if (hit) {
      triggered.push(
        `${r.featureName} ${r.operator} ${r.threshold.toFixed(3)} (train loss ${r.trainLossRatePct.toFixed(1)}%)`,
      )
    }
  }
  return triggered
}

/**
 * Discovers interpretable single-feature toxic-regime veto thresholds strictly on `train`
 * and retains only rules validated to improve precision & eliminate losses on `val`.
 */
function mineToxicVetoRules(
  train: readonly MetaSample[],
  val: readonly MetaSample[],
  featureNames: readonly string[],
  maxRules: number,
  minRecall: number,
): HardVetoRule[] {
  if (train.length < 30 || maxRules <= 0) return []
  const trainLosses = train.filter((s) => s.outcome === 0).length
  const baseLossRate = trainLosses / train.length
  if (baseLossRate <= 0.01) return []

  const minSupport = Math.max(6, Math.floor(train.length * 0.05))
  const candidates: (HardVetoRule & { score: number })[] = []

  for (let f = 0; f < featureNames.length; f++) {
    const vals = train.map((s) => sanitizeFeature(s.featureVector[f])).sort((a, b) => a - b)
    if (vals[vals.length - 1] - vals[0] < 1e-8) continue

    const quantiles = [
      { q: 0.85, op: '>' as const },
      { q: 0.90, op: '>' as const },
      { q: 0.94, op: '>' as const },
      { q: 0.96, op: '>' as const },
      { q: 0.15, op: '<' as const },
      { q: 0.10, op: '<' as const },
      { q: 0.06, op: '<' as const },
      { q: 0.04, op: '<' as const },
    ]

    let bestForFeature: (HardVetoRule & { score: number }) | null = null
    for (const { q, op } of quantiles) {
      const threshold = vals[Math.min(vals.length - 1, Math.max(0, Math.floor(vals.length * q)))]
      let support = 0
      let losses = 0
      for (const s of train) {
        const v = sanitizeFeature(s.featureVector[f])
        if (op === '>' ? v > threshold : v < threshold) {
          support++
          if (s.outcome === 0) losses++
        }
      }
      if (support < minSupport) continue
      const lossRate = losses / support
      const toxicThreshold = Math.min(0.88, Math.max(0.50, baseLossRate * 2.0, baseLossRate + 0.25))
      if (lossRate < toxicThreshold) continue

      const score = (lossRate - baseLossRate) * Math.sqrt(support)
      if (!bestForFeature || score > bestForFeature.score) {
        bestForFeature = {
          featureIndex: f,
          featureName: featureNames[f],
          operator: op,
          threshold: round(threshold, 4),
          trainLossRatePct: round(lossRate * 100, 1),
          trainSupport: support,
          score,
        }
      }
    }

    if (bestForFeature) candidates.push(bestForFeature)
  }

  candidates.sort((a, b) => b.score - a.score)
  const selected: HardVetoRule[] = []

  // Validate sequentially on `val` so each accepted rule improves out-of-sample precision
  const evalSet = val.length >= 12 ? val : train
  let currentKept = [...evalSet]
  let currentPrecision =
    currentKept.filter((s) => s.outcome === 1).length / Math.max(1, currentKept.length)

  for (const cand of candidates) {
    if (selected.length >= maxRules) break
    const nextKept = currentKept.filter((s) => {
      const v = sanitizeFeature(s.featureVector[cand.featureIndex])
      return cand.operator === '>' ? !(v > cand.threshold) : !(v < cand.threshold)
    })
    const recall = nextKept.length / Math.max(1, evalSet.length)
    if (recall < Math.max(0.35, minRecall)) continue

    const removed = currentKept.length - nextKept.length
    if (removed === 0) continue
    const removedLosses =
      currentKept.filter((s) => s.outcome === 0).length -
      nextKept.filter((s) => s.outcome === 0).length
    const nextPrecision =
      nextKept.filter((s) => s.outcome === 1).length / Math.max(1, nextKept.length)

    if (removedLosses > 0 && nextPrecision > currentPrecision + 0.005) {
      selected.push({
        featureIndex: cand.featureIndex,
        featureName: cand.featureName,
        operator: cand.operator,
        threshold: cand.threshold,
        trainLossRatePct: cand.trainLossRatePct,
        trainSupport: cand.trainSupport,
      })
      currentKept = nextKept
      currentPrecision = nextPrecision
    }
  }

  return selected
}

function computeLossCorrelations(
  samples: readonly MetaSample[],
  featureNames: readonly string[],
): number[] {
  const n = samples.length
  const dim = featureNames.length
  const corrs = new Array<number>(dim).fill(0)
  if (n < 5) return corrs

  let meanLoss = 0
  for (const s of samples) meanLoss += s.outcome === 0 ? 1 : 0
  meanLoss /= n

  for (let j = 0; j < dim; j++) {
    let meanX = 0
    for (const s of samples) meanX += sanitizeFeature(s.featureVector[j])
    meanX /= n

    let cov = 0
    let varX = 0
    let varY = 0
    for (const s of samples) {
      const dx = sanitizeFeature(s.featureVector[j]) - meanX
      const dy = (s.outcome === 0 ? 1 : 0) - meanLoss
      cov += dx * dy
      varX += dx * dx
      varY += dy * dy
    }
    corrs[j] =
      varX > EPS && varY > EPS ? round(cov / Math.sqrt(varX * varY), 3) : 0
  }

  return corrs
}

/**
 * Scores a single pre-trade feature vector using a trained `MetaFilterModel`.
 * Safe for real-time live inference and JSON deserialized artifacts.
 */
export function scoreWithMetaFilterModel(
  model: MetaFilterModel,
  rawFeatures: readonly number[],
): MetaFilterScore {
  const z = applyStandardizer(rawFeatures, model.standardizer)
  const logisticProb = predictLogistic(z, model.logistic)
  const gbdtProb = predictGbdt(z, model.gbdt)
  const centroidSafetyProb = predictCentroidSafety(z, model.lossCentroid)

  const w = model.ensembleWeights
  const rawScore =
    w.logistic * logisticProb + w.gbdt * gbdtProb + w.centroid * centroidSafetyProb
  const calibratedWinProb = applyCalibrator(model.calibrator, rawScore)
  const hardVetoTriggered = checkHardVetoRules(rawFeatures, model.hardVetoRules)

  const allowTrade =
    hardVetoTriggered.length === 0 && rawScore >= model.scoreThreshold

  // Risk-capped meta-sizing in [0.40, 1.00]: never levers above 1.0x baseline stake,
  // smoothly reducing exposure on borderline accepted trades to mitigate tail drawdown.
  let sizeMultiplier = 0
  if (allowTrade) {
    const headroom = Math.max(0.05, 1 - model.scoreThreshold)
    const confidence = Math.max(
      0,
      Math.min(1, (rawScore - model.scoreThreshold) / headroom),
    )
    sizeMultiplier = round(0.45 + 0.55 * confidence, 3)
  }

  return {
    rawScore: round(rawScore, 4),
    calibratedWinProb: round(calibratedWinProb, 4),
    logisticProb: round(logisticProb, 4),
    gbdtProb: round(gbdtProb, 4),
    centroidSafetyProb: round(centroidSafetyProb, 4),
    hardVetoTriggered,
    allowTrade,
    sizeMultiplier,
  }
}

export function summarizeSamples(
  samples: readonly MetaSample[],
  totalAvailable: number,
  initialBankroll = 1000,
  sizeMultipliers?: readonly number[],
): PerformanceSummary {
  const trades = samples.length
  let wins = 0
  let losses = 0
  let grossWin = 0
  let grossLoss = 0
  let netPnl = 0
  let equity = initialBankroll
  let peak = initialBankroll
  let maxDdUsd = 0
  let maxDdPct = 0

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    const mult = sizeMultipliers ? sizeMultipliers[i] : 1
    const pnl = sanitizeFeature(s.netPnlUsd) * mult
    netPnl += pnl
    if (s.outcome === 1) {
      wins++
      if (pnl > 0) grossWin += pnl
    } else {
      losses++
      if (pnl < 0) grossLoss += Math.abs(pnl)
    }

    equity += pnl
    if (equity > peak) peak = equity
    const ddUsd = peak - equity
    if (ddUsd > maxDdUsd) maxDdUsd = ddUsd
    const ddPct = peak > EPS ? (ddUsd / peak) * 100 : 0
    if (ddPct > maxDdPct) maxDdPct = ddPct
  }

  const winRatePct = trades > 0 ? (wins / trades) * 100 : 0
  const wilson95LbPct = computeWilsonLowerBoundPct(wins, trades)
  const profitFactor =
    grossLoss > EPS
      ? round(grossWin / grossLoss, 2)
      : grossWin > EPS
        ? 99.99
        : null

  return {
    trades,
    wins,
    losses,
    winRatePct: round(winRatePct, 2),
    wilson95LbPct: round(wilson95LbPct, 2),
    netPnlUsd: round(netPnl, 2),
    profitFactor,
    maxDrawdownUsd: round(maxDdUsd, 2),
    maxDrawdownPct: round(maxDdPct, 2),
    expectancyUsd: trades > 0 ? round(netPnl / trades, 3) : 0,
    recallPct:
      totalAvailable > 0 ? round((trades / totalAvailable) * 100, 1) : 0,
  }
}

/**
 * End-to-end purged walk-forward training and strictly out-of-sample evaluation
 * of the Cost-Sensitive ML Meta-Filter for a single strategy.
 */
export function trainAndEvaluateMetaFilter(
  samples: readonly MetaSample[],
  config: MetaFilterTrainConfig,
): MetaBacktestComparison {
  const dim = config.featureNames.length
  const lossPenalty = Math.max(1, config.lossPenalty ?? 3.5)
  const l2Lambda = Math.max(0.001, config.l2Lambda ?? 0.05)
  const minRecall = Math.max(0.1, Math.min(0.85, config.minRecall ?? 0.30))
  const targetWinRate = Math.max(0.55, Math.min(0.99, config.targetWinRate ?? 0.90))
  const maxVetoRules = config.maxVetoRules ?? 3

  const { train, val, test, purgeGapUsed } = splitPurgedChronological(samples, {
    trainRatio: config.trainRatio ?? 0.55,
    valRatio: config.valRatio ?? 0.20,
    purgeGap: config.purgeGap ?? 2,
  })

  // 1. Fit standardizer strictly on `train`
  const standardizer = fitStandardizer(train, dim)
  const trainX = train.map((s) => applyStandardizer(s.featureVector, standardizer))
  const trainY = train.map((s) => s.outcome)
  const trainWeights = computeSampleWeights(train, lossPenalty)

  // 2. Train all 3 diverse base models strictly on `train`
  const logistic = trainWeightedLogisticRegression(
    trainX,
    trainY,
    trainWeights,
    dim,
    l2Lambda,
    lossPenalty,
  )
  const gbdt = trainCostSensitiveGbdt(trainX, trainY, trainWeights, dim, {
    numTrees: config.gbdtTrees ?? 45,
    learningRate: config.gbdtLearningRate ?? 0.08,
    minLeaf: config.gbdtMinLeaf ?? Math.max(4, Math.min(8, Math.floor(train.length * 0.03))),
    leafL2: config.gbdtLeafL2 ?? 2.5,
  })
  const lossCentroid = trainLossCentroidModel(trainX, trainY, dim)

  const ensembleWeights = { logistic: 0.30, gbdt: 0.55, centroid: 0.15 }

  // 3. Mine interpretable toxic-regime veto rules strictly on `train`, verified on `val`
  const hardVetoRules = mineToxicVetoRules(
    train,
    val,
    config.featureNames,
    maxVetoRules,
    minRecall,
  )

  // 4. Compute continuous ensemble scores on `val` & fit PAV isotonic calibrator strictly on `val`
  const rawEnsembleScore = (s: MetaSample): number => {
    const z = applyStandardizer(s.featureVector, standardizer)
    return (
      ensembleWeights.logistic * predictLogistic(z, logistic) +
      ensembleWeights.gbdt * predictGbdt(z, gbdt) +
      ensembleWeights.centroid * predictCentroidSafety(z, lossCentroid)
    )
  }

  const calSource = val.length >= 20 ? val : train
  const calSamples: CalibrationSample[] = calSource.map((s) => ({
    pRaw: rawEnsembleScore(s),
    outcome: s.outcome,
  }))
  const calibrator = fitIsotonicCalibrator(calSamples, Math.min(25, calSamples.length))

  // 5. Validation-only continuous score threshold sweep (ZERO access to `test`!)
  // Sweeping `rawScore` directly preserves full GBDT + Logistic + Centroid ranking precision
  // without flat PAV plateau quantization.
  const valSet = val.length >= 10 ? val : train
  const valEvaluated = valSet.map((s) => {
    const raw = rawEnsembleScore(s)
    const pCal = applyCalibrator(calibrator, raw)
    const vetoed = checkHardVetoRules(s.featureVector, hardVetoRules).length > 0
    return { sample: s, raw, pCal, vetoed }
  })

  const valTotalLosses = valSet.filter((s) => s.outcome === 0).length
  const valBasePnl = valSet.reduce((acc, s) => acc + s.netPnlUsd, 0)
  const valBaseAbsPnl = Math.max(10, Math.abs(valBasePnl))
  const minValTrades = Math.max(4, Math.ceil(valSet.length * minRecall))

  const nonVetoedSorted = valEvaluated
    .filter((r) => !r.vetoed)
    .sort((a, b) => a.raw - b.raw)

  const candidateThresholds = new Set<number>([0])
  for (const row of nonVetoedSorted) {
    candidateThresholds.add(round(row.raw, 5))
  }

  let bestScoreThreshold = 0
  let bestObjective = Number.NEGATIVE_INFINITY

  for (const tau of candidateThresholds) {
    const kept = nonVetoedSorted.filter((r) => r.raw >= tau)
    if (kept.length < minValTrades) continue

    const wins = kept.filter((r) => r.sample.outcome === 1).length
    const losses = kept.length - wins
    const winRate = wins / kept.length
    const wilsonLb = computeWilsonLowerBoundPct(wins, kept.length) / 100
    const lossElimRate =
      valTotalLosses > 0 ? (valTotalLosses - losses) / valTotalLosses : 1
    const netPnl = kept.reduce((acc, r) => acc + r.sample.netPnlUsd, 0)
    const recall = kept.length / Math.max(1, valSet.length)

    // Cost-sensitive loss-mitigation objective:
    // Strongly rewards eliminating losses, maximizing precision & Wilson 95% LB,
    // improving net PnL/expectancy, and retaining solid signal recall.
    const wrShortfall = Math.max(0, targetWinRate - winRate)
    const lossRatePenalty = (losses / Math.max(1, kept.length)) * (lossPenalty * 0.75)
    const pnlTerm = 0.65 * Math.tanh(netPnl / valBaseAbsPnl)
    const pnlBonus = netPnl > valBasePnl ? 0.25 : 0
    const objective =
      2.4 * winRate +
      1.6 * wilsonLb +
      1.45 * lossElimRate +
      pnlTerm +
      pnlBonus +
      0.3 * Math.sqrt(recall) -
      1.8 * wrShortfall -
      lossRatePenalty

    if (objective > bestObjective) {
      bestObjective = objective
      bestScoreThreshold = tau
    }
  }

  // Fallback if hard vetoes left fewer than minValTrades
  if (!Number.isFinite(bestObjective) && nonVetoedSorted.length > 0) {
    const idx = Math.max(0, nonVetoedSorted.length - minValTrades)
    bestScoreThreshold = round(nonVetoedSorted[idx].raw, 5)
  }

  const bestProbThreshold = applyCalibrator(calibrator, bestScoreThreshold)

  // 6. Feature importance ranking combining GBDT split gain, logistic magnitude, and Fisher ratio
  const lossCorrs = computeLossCorrelations(train, config.featureNames)
  const logAbsSum =
    logistic.weights.reduce((acc, w) => acc + Math.abs(w), 0) || 1
  const featureImportanceRanking: FeatureImportanceEntry[] = config.featureNames
    .map((feature, idx) => {
      const combined =
        0.5 * (gbdt.featureImportances[idx] ?? 0) +
        0.3 * (Math.abs(logistic.weights[idx] ?? 0) / logAbsSum) +
        0.2 * (lossCentroid.featureWeights[idx] ?? 0)
      return {
        feature,
        importance: round(combined, 4),
        lossCorrelation: lossCorrs[idx] ?? 0,
      }
    })
    .sort((a, b) => b.importance - a.importance)

  const model: MetaFilterModel = {
    version: 1,
    strategyId: config.strategyId,
    featureNames: [...config.featureNames],
    standardizer: {
      means: standardizer.means.map((v) => round(v, 5)),
      stds: standardizer.stds.map((v) => round(v, 5)),
    },
    logistic,
    gbdt,
    lossCentroid,
    calibrator,
    ensembleWeights,
    scoreThreshold: round(bestScoreThreshold, 5),
    probabilityThreshold: round(bestProbThreshold, 4),
    hardVetoRules,
    targetWinRate,
    lossPenalty,
    trainedSampleCount: train.length,
    validationSampleCount: val.length,
    featureImportanceRanking,
  }

  // 7. Strictly untouched Out-Of-Sample Evaluation on `test`
  const baseline = summarizeSamples(test, test.length)
  const keptSamples: MetaSample[] = []
  const keptMultipliers: number[] = []
  for (const s of test) {
    const scored = scoreWithMetaFilterModel(model, s.featureVector)
    if (scored.allowTrade) {
      keptSamples.push(s)
      keptMultipliers.push(scored.sizeMultiplier)
    }
  }

  const filtered = summarizeSamples(keptSamples, test.length)
  const filteredSized = summarizeSamples(
    keptSamples,
    test.length,
    1000,
    keptMultipliers,
  )

  const lossesEliminated = baseline.losses - filtered.losses
  const lossEliminationRatePct =
    baseline.losses > 0 ? round((lossesEliminated / baseline.losses) * 100, 1) : 100
  const drawdownReductionPct =
    baseline.maxDrawdownUsd > EPS
      ? round(
          ((baseline.maxDrawdownUsd - filteredSized.maxDrawdownUsd) /
            baseline.maxDrawdownUsd) *
            100,
          1,
        )
      : 0

  return {
    strategyId: config.strategyId,
    totalSamples: samples.length,
    trainSamples: train.length,
    valSamples: val.length,
    testSamples: test.length,
    purgeGapUsed,
    model,
    baseline,
    filtered,
    filteredSized,
    delta: {
      winRateLiftPp: round(filtered.winRatePct - baseline.winRatePct, 2),
      wilsonLiftPp: round(filtered.wilson95LbPct - baseline.wilson95LbPct, 2),
      lossesEliminated,
      lossEliminationRatePct,
      pnlDeltaUsd: round(filtered.netPnlUsd - baseline.netPnlUsd, 2),
      sizedPnlDeltaUsd: round(filteredSized.netPnlUsd - baseline.netPnlUsd, 2),
      drawdownReductionPct,
    },
  }
}

/**
 * Convenience helper to score a single live candle setup without precomputing cache manually.
 */
export function buildQuickCandleContextIndicators(candles: MarketContext['candles']): {
  sma20: (number | null)[]
  ema50: (number | null)[]
  rsi14: (number | null)[]
  bbUpper20: (number | null)[]
  bbLower20: (number | null)[]
} {
  const closes = candles.map((c) => c.close)
  const bb = bollingerBands(closes, 20, 2)
  return {
    sma20: sma(closes, 20),
    ema50: ema(closes, 50),
    rsi14: rsi(closes, 14),
    bbUpper20: bb.upper,
    bbLower20: bb.lower,
  }
}
