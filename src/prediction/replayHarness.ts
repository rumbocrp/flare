/**
 * Deterministic out-of-sample walk-forward replay & promotion harness
 * over collected 5m/15m/1h Polymarket BTC Up/Down windows.
 * Enforces zero future leakage: PAV calibration fits strictly on chronological
 * train windows; PnL, fees, Wilson LB, Brier, +30s markout, and promotion gates
 * are evaluated strictly on held-out test windows.
 * Browser-and-server-safe TypeScript (zero Node-only imports).
 */
import {
  POLYMARKET_FEES,
  polymarketFeePerShare,
  type LiquidityRole,
  type MarketCostModel,
} from '../predictionMarket'
import { computeWilsonLowerBoundPct } from '../predictions'
import { computeNowcast } from './nowcast'
import {
  applyCalibrator,
  brierSkillScore,
  computeBrierScore,
  fitIsotonicCalibrator,
  type CalibrationCurve,
  type CalibrationSample,
} from './calibration'

export type ReplayTimeframe = '5m' | '15m' | '1h'

export type ReplayResolutionSource =
  | 'chainlink-twap-60s'
  | 'binance-1h-candle'
  | 'unknown'

export type ReplaySnapshotPoint = {
  slug: string
  capturedAtMs: number
  secondsRemaining: number
  twapPrice: number | null
  binancePrice?: number | null
  sigma1m: number | null
  basisBps?: number | null
  yesBid: number | null
  yesAsk: number | null
  yesDepthUsd?: number | null
  noBid: number | null
  noAsk: number | null
  noDepthUsd?: number | null
  pModelYes?: number | null
}

export type CollectedWindowReplayInput = {
  slug: string
  timeframe: ReplayTimeframe
  conditionId?: string
  upTokenId?: string
  downTokenId?: string
  resolutionSource: ReplayResolutionSource
  startTimeMs: number
  endTimeMs: number
  openTwap: number | null
  closeTwap: number | null
  resolvedUp: boolean | null
  tickSize?: number
  negRisk?: boolean
  volumeUsd?: number | null
  updatedAt?: number
  snapshots: readonly ReplaySnapshotPoint[]
}

export type ReplayIntent = {
  outcome: 'YES' | 'NO'
  liquidityRole: LiquidityRole
  limitPrice?: number
  stakeUsd?: number
  reason?: string
}

export type StrategyReplayEvaluator = (
  snapshot: ReplaySnapshotPoint,
  calibratedPYes: number,
  window: CollectedWindowReplayInput,
  rawPYes: number,
) => ReplayIntent | null

export type ReplayConfig = {
  strategyId?: string
  trainRatio?: number
  stakeUsd?: number
  initialBankrollUsd?: number
  blendWeight?: number
  minSamplesForPromotion?: number
  minEdgeOverBreakEvenPp?: number
  minMeanMarkout30s?: number
  takerFeeRate?: number
  makerRebateShare?: number
  minCalibrationSamples?: number
}

export type ReplayTradeRecord = {
  slug: string
  timeframe: ReplayTimeframe
  outcome: 'YES' | 'NO'
  liquidityRole: LiquidityRole
  entryTimeMs: number
  entryPrice: number
  feePerShare: number
  breakEvenPct: number
  stakeUsd: number
  shares: number
  feeUsd: number
  spreadDragUsd: number
  pRawYes: number
  pCalibratedYes: number
  markout30s: number | null
  resolvedUp: boolean
  won: boolean
  netPnlUsd: number
}

export type ReplayEquityPoint = {
  timeMs: number
  equityUsd: number
  slug: string
}

export type PromotionReport = {
  strategyId: string
  totalInputWindows: number
  settledWindowCount: number
  trainWindowCount: number
  testWindowCount: number
  trainRatio: number
  calibrator: CalibrationCurve
  tradeCount: number
  wins: number
  winRatePct: number
  wilsonLowerBoundPct: number
  avgEntryPrice: number
  avgFeePerShare: number
  avgBreakEvenPct: number
  edgeVsBreakEvenPp: number
  wilsonEdgeVsBreakEvenPp: number
  brierModel: number
  brierMarket: number | null
  brierSkillScore: number | null
  meanMarkout30s: number
  markoutSampleCount: number
  netPnlUsd: number
  totalFeesUsd: number
  totalSpreadDragUsd: number
  maxDrawdownUsd: number
  maxDrawdownPct: number
  equityCurve: ReplayEquityPoint[]
  trades: ReplayTradeRecord[]
  minSamplesRequired: number
  sampleProgressText: string
  sampleWarning: string | null
  gateFailures: string[]
  eligibleForCanary: boolean
  eligibleForPaperLive: boolean
}

function clampProb(value: number): number {
  return Math.min(0.9999, Math.max(0.0001, value))
}

function deriveMarketMidYes(snapshot: ReplaySnapshotPoint): number | null {
  if (
    snapshot.yesBid !== null &&
    snapshot.yesAsk !== null &&
    Number.isFinite(snapshot.yesBid) &&
    Number.isFinite(snapshot.yesAsk) &&
    snapshot.yesAsk >= snapshot.yesBid
  ) {
    return clampProb((snapshot.yesBid + snapshot.yesAsk) / 2)
  }
  if (
    snapshot.noBid !== null &&
    snapshot.noAsk !== null &&
    Number.isFinite(snapshot.noBid) &&
    Number.isFinite(snapshot.noAsk) &&
    snapshot.noAsk >= snapshot.noBid
  ) {
    return clampProb(1 - (snapshot.noBid + snapshot.noAsk) / 2)
  }
  return null
}

function deriveSnapshotRawPYes(
  snapshot: ReplaySnapshotPoint,
  window: CollectedWindowReplayInput,
  blendWeight: number | undefined,
): number | null {
  if (
    snapshot.pModelYes !== null &&
    snapshot.pModelYes !== undefined &&
    Number.isFinite(snapshot.pModelYes)
  ) {
    return clampProb(snapshot.pModelYes)
  }
  if (
    window.openTwap !== null &&
    Number.isFinite(window.openTwap) &&
    snapshot.twapPrice !== null &&
    Number.isFinite(snapshot.twapPrice) &&
    snapshot.sigma1m !== null &&
    Number.isFinite(snapshot.sigma1m)
  ) {
    const marketMidYes =
      blendWeight !== undefined ? deriveMarketMidYes(snapshot) ?? undefined : undefined
    const est = computeNowcast({
      openTwap: window.openTwap,
      currentTwap: snapshot.twapPrice,
      secondsRemaining: snapshot.secondsRemaining,
      sigma1m: snapshot.sigma1m,
      marketMidYes,
      blendWeight,
    })
    if (!est.valid) return null
    return blendWeight !== undefined ? est.pBlendedYes : est.pRawYes
  }
  return null
}

function computeOutcomeMid(
  snapshot: ReplaySnapshotPoint,
  outcome: 'YES' | 'NO',
): number | null {
  const bid = outcome === 'YES' ? snapshot.yesBid : snapshot.noBid
  const ask = outcome === 'YES' ? snapshot.yesAsk : snapshot.noAsk
  if (
    bid !== null &&
    ask !== null &&
    Number.isFinite(bid) &&
    Number.isFinite(ask) &&
    ask >= bid
  ) {
    return (bid + ask) / 2
  }
  if (ask !== null && Number.isFinite(ask)) return ask
  if (bid !== null && Number.isFinite(bid)) return bid
  return null
}

/**
 * Runs a deterministic, zero-leakage chronological replay over collected windows.
 */
export function runWindowReplay(
  windows: readonly CollectedWindowReplayInput[],
  evaluator: StrategyReplayEvaluator,
  config?: ReplayConfig,
): PromotionReport {
  const strategyId = config?.strategyId ?? 'custom-replay'
  const trainRatio = Math.min(0.9, Math.max(0.5, config?.trainRatio ?? 0.7))
  const defaultStakeUsd = Math.max(0.01, config?.stakeUsd ?? 5)
  const initialBankrollUsd = Math.max(1, config?.initialBankrollUsd ?? 1000)
  const blendWeight =
    config?.blendWeight !== undefined && Number.isFinite(config.blendWeight)
      ? Math.min(1, Math.max(0, config.blendWeight))
      : undefined
  const minSamplesRequired = Math.max(
    1,
    Math.floor(config?.minSamplesForPromotion ?? 500),
  )
  const minEdgeOverBreakEvenPp = config?.minEdgeOverBreakEvenPp ?? 1.0
  const minMeanMarkout30s = config?.minMeanMarkout30s ?? -0.02
  const takerFeeRate = config?.takerFeeRate ?? POLYMARKET_FEES.crypto.takerFeeRate
  const makerRebateShare =
    config?.makerRebateShare ?? POLYMARKET_FEES.crypto.makerRebateShare
  const minCalibrationSamples = Math.max(
    1,
    Math.floor(config?.minCalibrationSamples ?? 30),
  )

  const settled: CollectedWindowReplayInput[] = windows
    .filter((w) => w.resolvedUp !== null)
    .map((w) => ({
      ...w,
      snapshots: [...w.snapshots].sort((a, b) => a.capturedAtMs - b.capturedAtMs),
    }))
    .sort((a, b) => {
      if (a.startTimeMs !== b.startTimeMs) return a.startTimeMs - b.startTimeMs
      if (a.endTimeMs !== b.endTimeMs) return a.endTimeMs - b.endTimeMs
      return a.slug.localeCompare(b.slug)
    })

  const splitIdx = Math.floor(settled.length * trainRatio)
  const trainWindows = settled.slice(0, splitIdx)
  const testWindows = settled.slice(splitIdx)

  // Train phase: strictly isolated to trainWindows so zero future leakage occurs.
  const trainSamples: CalibrationSample[] = []
  for (const w of trainWindows) {
    const outcome: 0 | 1 = w.resolvedUp ? 1 : 0
    for (const snap of w.snapshots) {
      const pRaw = deriveSnapshotRawPYes(snap, w, blendWeight)
      if (pRaw === null) continue
      trainSamples.push({ pRaw, outcome })
    }
  }
  const calibrator = fitIsotonicCalibrator(trainSamples, minCalibrationSamples)

  // Out-of-sample test phase
  let equity = initialBankrollUsd
  let peak = initialBankrollUsd
  let maxDrawdownUsd = 0
  let maxDrawdownPct = 0

  const brierModelPairs: { p: number; outcome: 0 | 1 }[] = []
  const brierMarketPairs: { p: number; outcome: 0 | 1 }[] = []
  const trades: ReplayTradeRecord[] = []
  const equityCurve: ReplayEquityPoint[] = []

  for (const w of testWindows) {
    const resolvedUp = w.resolvedUp === true
    const outcomeNum: 0 | 1 = resolvedUp ? 1 : 0
    let tradedThisWindow = false

    for (let i = 0; i < w.snapshots.length; i++) {
      const snap = w.snapshots[i]
      const rawPYes = deriveSnapshotRawPYes(snap, w, blendWeight)
      if (rawPYes === null) continue

      const calibratedPYes = applyCalibrator(calibrator, rawPYes)
      const marketMidYes = deriveMarketMidYes(snap)

      brierModelPairs.push({ p: calibratedPYes, outcome: outcomeNum })
      if (marketMidYes !== null) {
        brierMarketPairs.push({ p: marketMidYes, outcome: outcomeNum })
      }

      if (tradedThisWindow) continue

      const intent = evaluator(snap, calibratedPYes, w, rawPYes)
      if (!intent) continue

      const bookBid = intent.outcome === 'YES' ? snap.yesBid : snap.noBid
      const bookAsk = intent.outcome === 'YES' ? snap.yesAsk : snap.noAsk
      const rawEntryPrice =
        intent.limitPrice !== undefined
          ? intent.limitPrice
          : intent.liquidityRole === 'taker'
            ? bookAsk
            : bookBid

      if (
        rawEntryPrice === null ||
        !Number.isFinite(rawEntryPrice) ||
        rawEntryPrice <= 0 ||
        rawEntryPrice >= 1
      ) {
        continue
      }

      const entryPrice = rawEntryPrice
      const costModel: MarketCostModel = {
        spreadCents: 0,
        feePct: 0,
        takerFeeRate,
        makerRebateShare,
        liquidityRole: intent.liquidityRole,
      }
      const feePerShare = polymarketFeePerShare(entryPrice, costModel)
      const tradeStake = Math.max(0.01, intent.stakeUsd ?? defaultStakeUsd)
      const shares = tradeStake / entryPrice
      const feeUsd = shares * feePerShare
      const halfSpread =
        bookBid !== null &&
        bookAsk !== null &&
        Number.isFinite(bookBid) &&
        Number.isFinite(bookAsk) &&
        bookAsk >= bookBid
          ? (bookAsk - bookBid) / 2
          : 0
      const spreadDragUsd =
        intent.liquidityRole === 'taker' ? shares * halfSpread : 0
      const won =
        (intent.outcome === 'YES' && resolvedUp) ||
        (intent.outcome === 'NO' && !resolvedUp)
      const netPnlUsd = (won ? shares : 0) - tradeStake - feeUsd

      let markout30s: number | null = null
      const targetTs = snap.capturedAtMs + 30_000
      for (let j = i + 1; j < w.snapshots.length; j++) {
        if (w.snapshots[j].capturedAtMs >= targetTs) {
          const mid30 = computeOutcomeMid(w.snapshots[j], intent.outcome)
          if (mid30 !== null && Number.isFinite(mid30)) {
            markout30s = mid30 - entryPrice
          }
          break
        }
      }

      equity += netPnlUsd
      if (equity > peak) {
        peak = equity
      }
      const ddUsd = peak - equity
      if (ddUsd > maxDrawdownUsd) {
        maxDrawdownUsd = ddUsd
      }
      const ddPct = peak > 0 ? (ddUsd / peak) * 100 : 0
      if (ddPct > maxDrawdownPct) {
        maxDrawdownPct = ddPct
      }

      const breakEvenPct = Math.min(100, Math.max(0, (entryPrice + feePerShare) * 100))

      trades.push({
        slug: w.slug,
        timeframe: w.timeframe,
        outcome: intent.outcome,
        liquidityRole: intent.liquidityRole,
        entryTimeMs: snap.capturedAtMs,
        entryPrice,
        feePerShare,
        breakEvenPct,
        stakeUsd: tradeStake,
        shares,
        feeUsd,
        spreadDragUsd,
        pRawYes: rawPYes,
        pCalibratedYes: calibratedPYes,
        markout30s,
        resolvedUp,
        won,
        netPnlUsd,
      })

      equityCurve.push({
        timeMs: snap.capturedAtMs,
        equityUsd: equity,
        slug: w.slug,
      })

      tradedThisWindow = true
    }
  }

  const tradeCount = trades.length
  const wins = trades.filter((t) => t.won).length
  const winRatePct = tradeCount > 0 ? (wins / tradeCount) * 100 : 0
  const wilsonLowerBoundPct = computeWilsonLowerBoundPct(wins, tradeCount)
  const avgEntryPrice =
    tradeCount > 0
      ? trades.reduce((acc, t) => acc + t.entryPrice, 0) / tradeCount
      : 0
  const avgFeePerShare =
    tradeCount > 0
      ? trades.reduce((acc, t) => acc + t.feePerShare, 0) / tradeCount
      : 0
  const avgBreakEvenPct =
    tradeCount > 0
      ? trades.reduce((acc, t) => acc + (t.entryPrice + t.feePerShare), 0) /
        tradeCount *
        100
      : 0
  const edgeVsBreakEvenPp = tradeCount > 0 ? winRatePct - avgBreakEvenPct : 0
  const wilsonEdgeVsBreakEvenPp =
    tradeCount > 0 ? wilsonLowerBoundPct - avgBreakEvenPct : 0

  const brierModel = computeBrierScore(brierModelPairs)
  const brierMarket =
    brierMarketPairs.length > 0 ? computeBrierScore(brierMarketPairs) : null
  const brierSkill =
    brierMarket !== null ? brierSkillScore(brierModel, brierMarket) : null

  const markoutValues: number[] = []
  for (const t of trades) {
    if (t.markout30s !== null) markoutValues.push(t.markout30s)
  }
  const markoutSampleCount = markoutValues.length
  const meanMarkout30s =
    markoutSampleCount > 0
      ? markoutValues.reduce((acc, v) => acc + v, 0) / markoutSampleCount
      : 0

  const netPnlUsd = trades.reduce((acc, t) => acc + t.netPnlUsd, 0)
  const totalFeesUsd = trades.reduce((acc, t) => acc + t.feeUsd, 0)
  const totalSpreadDragUsd = trades.reduce((acc, t) => acc + t.spreadDragUsd, 0)

  const settledWindowCount = settled.length
  const sampleProgressText = `${settledWindowCount} / ${minSamplesRequired}`
  const sampleWarning =
    settledWindowCount < minSamplesRequired
      ? `Insufficient settled windows for promotion (${sampleProgressText})`
      : null

  const gateFailures: string[] = []
  if (settledWindowCount < minSamplesRequired) {
    gateFailures.push(
      `Minimum sample gate failed: ${settledWindowCount} / ${minSamplesRequired} settled windows`,
    )
  }
  if (tradeCount === 0) {
    gateFailures.push('No out-of-sample trades executed on test split')
  } else if (wilsonLowerBoundPct < avgBreakEvenPct + minEdgeOverBreakEvenPp) {
    gateFailures.push(
      `Wilson 95% LB (${wilsonLowerBoundPct.toFixed(1)}%) below break-even + ${minEdgeOverBreakEvenPp.toFixed(1)}pp (${(avgBreakEvenPct + minEdgeOverBreakEvenPp).toFixed(1)}%)`,
    )
  }
  if (netPnlUsd <= 0) {
    gateFailures.push(
      `Out-of-sample net PnL must be positive ($${netPnlUsd.toFixed(2)})`,
    )
  }
  if (meanMarkout30s < minMeanMarkout30s) {
    gateFailures.push(
      `Mean +30s markout (${meanMarkout30s.toFixed(4)}) below floor (${minMeanMarkout30s.toFixed(4)})`,
    )
  }

  const eligible = gateFailures.length === 0

  return {
    strategyId,
    totalInputWindows: windows.length,
    settledWindowCount,
    trainWindowCount: trainWindows.length,
    testWindowCount: testWindows.length,
    trainRatio,
    calibrator,
    tradeCount,
    wins,
    winRatePct,
    wilsonLowerBoundPct,
    avgEntryPrice,
    avgFeePerShare,
    avgBreakEvenPct,
    edgeVsBreakEvenPp,
    wilsonEdgeVsBreakEvenPp,
    brierModel,
    brierMarket,
    brierSkillScore: brierSkill,
    meanMarkout30s,
    markoutSampleCount,
    netPnlUsd,
    totalFeesUsd,
    totalSpreadDragUsd,
    maxDrawdownUsd,
    maxDrawdownPct,
    equityCurve,
    trades,
    minSamplesRequired,
    sampleProgressText,
    sampleWarning,
    gateFailures,
    eligibleForCanary: eligible,
    eligibleForPaperLive: eligible,
  }
}
