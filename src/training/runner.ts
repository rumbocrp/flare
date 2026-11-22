import { resolveExit } from '../backtest'
import {
  mergePresetPatch,
  resolvePresetPredictionRule,
  type StrategyPreset,
  type StrategyPresetPatch,
} from '../botEngine'
import { computeTradeRMultiple } from '../botRunUtils'
import { computeMetrics } from '../metrics'
import {
  CANDLE_FEATURE_NAMES,
  scoreWithMetaFilterModel,
  splitPurgedChronological,
  trainAndEvaluateMetaFilter,
} from '../prediction/mlMetaFilter'
import {
  DEFAULT_SIMULATION_CONFIG,
  simulatePredictionStrategy,
  type SimulationConfig,
} from '../predictionMarket'
import {
  BITCOIN_20_PREDICTIONS,
  computeWilsonLowerBoundPct,
} from '../predictions'
import { evaluateDonchianExit } from '../spotEngines'
import type { Candle, ExitReason, TradeSide } from '../types'
import { buildSpotMetaSamples, collectSpotPresetSignals } from './metaSamples'
import type {
  MetaFilterRunSummary,
  PredictionMarketRunSummary,
  TrainingCandidateResult,
  TrainingConfig,
  TrainingEquityPoint,
  TrainingFoldResult,
  TrainingParamDiff,
  TrainingProgress,
  TrainingRunMetrics,
  TrainingRunOutput,
  TrainingTradeRecord,
  TrainingVerdict,
} from './types'

export const MAX_COORDINATE_PARAMS = 6
export const MAX_COORDINATE_EVALUATIONS = 24
export const PROGRESS_BAR_CHECKPOINT = 250
export const MIN_VERDICT_SAMPLE = 30
export const MIN_ELIGIBLE_PF = 1.2
export const MAX_ELIGIBLE_DD_PCT = 20
export const MIN_ELIGIBLE_WILSON_PCT = 40

export class TrainingCancelledError extends Error {
  constructor(message = 'Training run cancelled') {
    super(message)
    this.name = 'TrainingCancelledError'
  }
}

export type TrainingRunHooks = {
  onProgress?: (progress: TrainingProgress) => void
  isCancelled?: () => boolean
}

export type TrainingPipelineRequest = {
  candles: Candle[]
  preset: StrategyPreset
  config: TrainingConfig
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000
}

function utcDayKey(timeMs: number): number {
  return Math.floor(timeMs / 86_400_000)
}

function fillPrice(
  rawPrice: number,
  side: TradeSide,
  slippagePct: number,
): number {
  const slip = Math.max(0, slippagePct) / 100
  return side === 'buy' ? rawPrice * (1 + slip) : rawPrice * (1 - slip)
}

function checkCancelled(hooks?: TrainingRunHooks): void {
  if (hooks?.isCancelled?.()) {
    throw new TrainingCancelledError()
  }
}

export function computeTrainingVerdict(input: {
  totalTrades: number
  profitFactor: number | null
  maxDrawdownPct: number
  wilsonLowerBoundPct: number | null
}): { verdict: TrainingVerdict; verdictReason: string } {
  if (input.totalTrades < MIN_VERDICT_SAMPLE) {
    return {
      verdict: 'insufficient',
      verdictReason: `OOS sample size (${input.totalTrades}) is below the ${MIN_VERDICT_SAMPLE}-trade minimum.`,
    }
  }

  const failures: string[] = []
  if (input.profitFactor === null || input.profitFactor < MIN_ELIGIBLE_PF) {
    failures.push(
      `PF ${input.profitFactor === null ? 'n/a' : input.profitFactor.toFixed(2)} < ${MIN_ELIGIBLE_PF.toFixed(1)}`,
    )
  }
  if (input.maxDrawdownPct > MAX_ELIGIBLE_DD_PCT) {
    failures.push(
      `Max DD ${input.maxDrawdownPct.toFixed(1)}% > ${MAX_ELIGIBLE_DD_PCT}%`,
    )
  }
  if (
    input.wilsonLowerBoundPct === null ||
    input.wilsonLowerBoundPct < MIN_ELIGIBLE_WILSON_PCT
  ) {
    failures.push(
      `Wilson 95% LB ${input.wilsonLowerBoundPct === null ? 'n/a' : `${input.wilsonLowerBoundPct.toFixed(1)}%`} < ${MIN_ELIGIBLE_WILSON_PCT}%`,
    )
  }

  if (failures.length === 0) {
    return {
      verdict: 'eligible',
      verdictReason: `Passed OOS gate: ${input.totalTrades} trades (>= ${MIN_VERDICT_SAMPLE}), PF >= ${MIN_ELIGIBLE_PF.toFixed(1)}, Max DD <= ${MAX_ELIGIBLE_DD_PCT}%, Wilson 95% LB >= ${MIN_ELIGIBLE_WILSON_PCT}%.`,
    }
  }

  return {
    verdict: 'below-threshold',
    verdictReason: `Below threshold: ${failures.join('; ')}.`,
  }
}

/**
 * Canonical metrics calculation shared by the client training worker and the
 * server verification path (`PATCH /api/training/runs/:id`).
 * Delegates strictly to `computeMetrics` (`src/metrics.ts`) and
 * `computeWilsonLowerBoundPct` (`src/predictions.ts`).
 */
export function computeCanonicalTrainingMetrics(
  trades: readonly TrainingTradeRecord[],
  initialBalance: number,
  options?: {
    fallbackStopLossPct?: number
    overrideReason?: string | null
  },
): TrainingRunMetrics {
  const tradeList = [...trades]
  const base = computeMetrics(tradeList, initialBalance)
  const wilsonLowerBoundPct =
    base.totalTrades > 0
      ? computeWilsonLowerBoundPct(base.wins, base.totalTrades)
      : null
  const netPnl = round2(tradeList.reduce((acc, t) => acc + t.pnl, 0))
  const returnPct = initialBalance > 0 ? (netPnl / initialBalance) * 100 : 0
  const feesPaid = round2(
    tradeList.reduce((acc, t) => acc + (typeof t.fees === 'number' ? t.fees : 0), 0),
  )

  let rSum = 0
  let rCount = 0
  for (const t of tradeList) {
    const r =
      typeof t.rMultiple === 'number' && Number.isFinite(t.rMultiple)
        ? t.rMultiple
        : computeTradeRMultiple(t, options?.fallbackStopLossPct)
    if (r !== null && Number.isFinite(r)) {
      rSum += r
      rCount += 1
    }
  }
  const averageR = rCount > 0 ? round4(rSum / rCount) : null

  const { verdict, verdictReason } = computeTrainingVerdict({
    totalTrades: base.totalTrades,
    profitFactor: base.profitFactor,
    maxDrawdownPct: base.maxDrawdownPct,
    wilsonLowerBoundPct,
  })

  const overrideReason = options?.overrideReason?.trim() || null
  const finalVerdict: TrainingVerdict =
    overrideReason && overrideReason.length >= 10 && verdict !== 'eligible'
      ? 'override'
      : verdict

  return {
    totalTrades: base.totalTrades,
    wins: base.wins,
    losses: base.losses,
    winRate: base.winRate,
    wilsonLowerBoundPct,
    profitFactor: base.profitFactor,
    maxDrawdown: base.maxDrawdown,
    maxDrawdownPct: base.maxDrawdownPct,
    netPnl,
    returnPct,
    expectancy: base.expectancy,
    averageR,
    feesPaid,
    verdict: finalVerdict,
    verdictReason:
      finalVerdict === 'override'
        ? `Operator override (${overrideReason}). Base gate: ${verdictReason}`
        : verdictReason,
    ...(overrideReason ? { overrideReason } : {}),
  }
}

type TunableParamSpec = {
  key: string
  read: (preset: StrategyPreset) => string | number | boolean
  candidates: (base: StrategyPreset) => (string | number | boolean)[]
  apply: (
    preset: StrategyPreset,
    value: string | number | boolean,
  ) => StrategyPreset
}

function getTunableParamSpecs(preset: StrategyPreset): TunableParamSpec[] {
  const engine = preset.filters?.signalEngine ?? 'momentum-structure'

  const slSpec: TunableParamSpec = {
    key: 'strategy.stopLoss',
    read: (p) => p.strategy.stopLoss,
    candidates: (p) => {
      const base = p.strategy.stopLoss
      return [round2(Math.max(0.2, base * 0.8)), round2(Math.min(25, base * 1.25))]
    },
    apply: (p, v) =>
      mergePresetPatch(p, { strategy: { stopLoss: Number(v) } }),
  }

  const tpSpec: TunableParamSpec = {
    key: 'strategy.takeProfit',
    read: (p) => p.strategy.takeProfit,
    candidates: (p) => {
      const base = p.strategy.takeProfit
      return [round2(Math.max(0.4, base * 0.8)), round2(Math.min(50, base * 1.25))]
    },
    apply: (p, v) =>
      mergePresetPatch(p, { strategy: { takeProfit: Number(v) } }),
  }

  if (engine === 'donchian-breakout') {
    const specs: TunableParamSpec[] = [
      {
        key: 'filters.channelPeriod',
        read: (p) => p.filters?.channelPeriod ?? 20,
        candidates: () => [15, 25],
        apply: (p, v) =>
          mergePresetPatch(p, { filters: { channelPeriod: Number(v) } }),
      },
      {
        key: 'filters.exitPeriod',
        read: (p) => p.filters?.exitPeriod ?? 10,
        candidates: () => [7, 14],
        apply: (p, v) =>
          mergePresetPatch(p, { filters: { exitPeriod: Number(v) } }),
      },
      {
        key: 'filters.atrStopMult',
        read: (p) => p.filters?.atrStopMult ?? 2,
        candidates: () => [1.5, 2.5],
        apply: (p, v) =>
          mergePresetPatch(p, { filters: { atrStopMult: Number(v) } }),
      },
      {
        key: 'filters.minAtrPct',
        read: (p) => p.filters?.minAtrPct ?? 0.15,
        candidates: () => [0.1, 0.25],
        apply: (p, v) =>
          mergePresetPatch(p, { filters: { minAtrPct: Number(v) } }),
      },
      slSpec,
      tpSpec,
    ]
    return specs.slice(0, MAX_COORDINATE_PARAMS)
  }

  if (engine === 'support-resistance') {
    const specs: TunableParamSpec[] = [
      {
        key: 'filters.pivotLookback',
        read: (p) => p.filters?.pivotLookback ?? 2,
        candidates: () => [2, 3],
        apply: (p, v) =>
          mergePresetPatch(p, { filters: { pivotLookback: Number(v) } }),
      },
      {
        key: 'filters.clusterAtrMult',
        read: (p) => p.filters?.clusterAtrMult ?? 0.35,
        candidates: () => [0.25, 0.5],
        apply: (p, v) =>
          mergePresetPatch(p, { filters: { clusterAtrMult: Number(v) } }),
      },
      {
        key: 'filters.touchToleranceAtr',
        read: (p) => p.filters?.touchToleranceAtr ?? 0.25,
        candidates: () => [0.2, 0.4],
        apply: (p, v) =>
          mergePresetPatch(p, { filters: { touchToleranceAtr: Number(v) } }),
      },
      {
        key: 'filters.minLongRsi',
        read: (p) => p.filters?.minLongRsi ?? 40,
        candidates: () => [35, 45],
        apply: (p, v) =>
          mergePresetPatch(p, { filters: { minLongRsi: Number(v) } }),
      },
      slSpec,
      tpSpec,
    ]
    return specs.slice(0, MAX_COORDINATE_PARAMS)
  }

  if (engine === 'break-of-structure') {
    const specs: TunableParamSpec[] = [
      {
        key: 'filters.swingLookback',
        read: (p) => p.filters?.swingLookback ?? 2,
        candidates: () => [2, 3],
        apply: (p, v) =>
          mergePresetPatch(p, { filters: { swingLookback: Number(v) } }),
      },
      {
        key: 'filters.retestWindowBars',
        read: (p) => p.filters?.retestWindowBars ?? 3,
        candidates: () => [2, 5],
        apply: (p, v) =>
          mergePresetPatch(p, { filters: { retestWindowBars: Number(v) } }),
      },
      {
        key: 'filters.stopBufferAtr',
        read: (p) => p.filters?.stopBufferAtr ?? 0.25,
        candidates: () => [0.15, 0.4],
        apply: (p, v) =>
          mergePresetPatch(p, { filters: { stopBufferAtr: Number(v) } }),
      },
      {
        key: 'filters.targetRMultiple',
        read: (p) => p.filters?.targetRMultiple ?? 2,
        candidates: () => [1.5, 2.5],
        apply: (p, v) =>
          mergePresetPatch(p, { filters: { targetRMultiple: Number(v) } }),
      },
      slSpec,
      tpSpec,
    ]
    return specs.slice(0, MAX_COORDINATE_PARAMS)
  }

  if (engine === 'rsi-reversion') {
    const specs: TunableParamSpec[] = [
      {
        key: 'filters.oversoldRsi',
        read: (p) => p.filters?.oversoldRsi ?? 32,
        candidates: () => [28, 38],
        apply: (p, v) =>
          mergePresetPatch(p, { filters: { oversoldRsi: Number(v) } }),
      },
      {
        key: 'filters.overboughtRsi',
        read: (p) => p.filters?.overboughtRsi ?? 68,
        candidates: () => [62, 72],
        apply: (p, v) =>
          mergePresetPatch(p, { filters: { overboughtRsi: Number(v) } }),
      },
      slSpec,
      tpSpec,
    ]
    return specs.slice(0, MAX_COORDINATE_PARAMS)
  }

  if (engine === 'crossover') {
    const specs: TunableParamSpec[] = [
      {
        key: 'signalParams.fastPeriod',
        read: (p) => p.signalParams.fastPeriod,
        candidates: (p) => [
          Math.max(4, p.signalParams.fastPeriod - 3),
          Math.min(40, p.signalParams.fastPeriod + 4),
        ],
        apply: (p, v) =>
          mergePresetPatch(p, { signalParams: { fastPeriod: Number(v) } }),
      },
      {
        key: 'signalParams.slowPeriod',
        read: (p) => p.signalParams.slowPeriod,
        candidates: (p) => [
          Math.max(p.signalParams.fastPeriod + 5, p.signalParams.slowPeriod - 5),
          Math.min(80, p.signalParams.slowPeriod + 8),
        ],
        apply: (p, v) =>
          mergePresetPatch(p, { signalParams: { slowPeriod: Number(v) } }),
      },
      {
        key: 'filters.maxBuyRsi',
        read: (p) => p.filters?.maxBuyRsi ?? 68,
        candidates: () => [62, 74],
        apply: (p, v) =>
          mergePresetPatch(p, { filters: { maxBuyRsi: Number(v) } }),
      },
      {
        key: 'filters.minSellRsi',
        read: (p) => p.filters?.minSellRsi ?? 32,
        candidates: () => [26, 38],
        apply: (p, v) =>
          mergePresetPatch(p, { filters: { minSellRsi: Number(v) } }),
      },
      slSpec,
      tpSpec,
    ]
    return specs.slice(0, MAX_COORDINATE_PARAMS)
  }

  // momentum-structure
  const specs: TunableParamSpec[] = [
    {
      key: 'filters.maxBuyRsi',
      read: (p) => p.filters?.maxBuyRsi ?? 66,
      candidates: () => [60, 72],
      apply: (p, v) =>
        mergePresetPatch(p, { filters: { maxBuyRsi: Number(v) } }),
    },
    {
      key: 'filters.minSellRsi',
      read: (p) => p.filters?.minSellRsi ?? 34,
      candidates: () => [28, 40],
      apply: (p, v) =>
        mergePresetPatch(p, { filters: { minSellRsi: Number(v) } }),
    },
    {
      key: 'filters.breakevenAtOneR',
      read: (p) => p.filters?.breakevenAtOneR ?? true,
      candidates: (p) => [!(p.filters?.breakevenAtOneR ?? true)],
      apply: (p, v) =>
        mergePresetPatch(p, { filters: { breakevenAtOneR: Boolean(v) } }),
    },
    slSpec,
    tpSpec,
  ]
  return specs.slice(0, MAX_COORDINATE_PARAMS)
}

function extractTunableParamMap(
  preset: StrategyPreset,
  specs: readonly TunableParamSpec[],
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const spec of specs) {
    out[spec.key] = spec.read(preset)
  }
  return out
}

function buildParamDiffs(
  defaultPreset: StrategyPreset,
  selectedPreset: StrategyPreset,
  specs: readonly TunableParamSpec[],
): TrainingParamDiff[] {
  const diffs: TrainingParamDiff[] = []
  for (const spec of specs) {
    const defVal = spec.read(defaultPreset)
    const selVal = spec.read(selectedPreset)
    if (defVal !== selVal) {
      diffs.push({
        param: spec.key,
        defaultValue: defVal,
        selectedValue: selVal,
      })
    }
  }
  return diffs
}

type WindowSimResult = {
  trades: TrainingTradeRecord[]
  equity: TrainingEquityPoint[]
  finalBalance: number
}

/**
 * Simulates a spot preset strictly over `windowCandles[evalStartIdx .. end]`,
 * where `windowCandles` NEVER contains any bar beyond the active window end.
 * Warmup bars `[0 .. evalStartIdx - 1]` feed causal indicators only.
 */
function simulateSpotWindow(params: {
  windowCandles: Candle[]
  evalStartIdx: number
  preset: StrategyPreset
  startingBalance: number
  startingTradeId: number
  foldIndex?: number
  recordEquity?: boolean
  onBarStep?: (barOffset: number) => void
  hooks?: TrainingRunHooks
}): WindowSimResult {
  const {
    windowCandles,
    preset,
    startingBalance,
    startingTradeId,
    foldIndex,
    recordEquity = false,
    onBarStep,
    hooks,
  } = params

  const startIdx = Math.max(55, params.evalStartIdx)
  if (startIdx >= windowCandles.length) {
    return { trades: [], equity: [], finalBalance: startingBalance }
  }

  const signals = collectSpotPresetSignals(windowCandles, preset)
  const signalMap = new Map<number, (typeof signals)[number]>()
  for (const s of signals) {
    signalMap.set(s.index, s)
  }

  const { strategy, execution, filters } = preset
  let balance = startingBalance
  let peak = startingBalance
  let dayStartBalance = startingBalance
  let currentDayKey: number | null = null
  let dayHalted = false
  let nextTradeId = startingTradeId

  type OpenPos = {
    side: TradeSide
    entryPrice: number
    entryTime: number
    quantity: number
    notional: number
    entryFee: number
    stopPrice: number
    initialStopPrice: number
    targetPrice: number
    breakevenArmed: boolean
  }

  let openPos: OpenPos | null = null
  const trades: TrainingTradeRecord[] = []
  const equity: TrainingEquityPoint[] = []

  const closeOpenPosition = (
    rawExitPrice: number,
    exitTimeMs: number,
    reason: ExitReason,
  ): void => {
    if (!openPos) return
    const dir = openPos.side === 'buy' ? 1 : -1
    const closeSide: TradeSide = openPos.side === 'buy' ? 'sell' : 'buy'
    const exitPrice = fillPrice(rawExitPrice, closeSide, execution.slippagePct)
    const exitFee = exitPrice * openPos.quantity * (execution.commissionPct / 100)
    const grossPnl = round2((exitPrice - openPos.entryPrice) * openPos.quantity * dir)
    const fees = round2(openPos.entryFee + exitFee)
    const pnl = round2(grossPnl - fees)
    balance = Math.max(0, round2(balance + pnl))

    const trade: TrainingTradeRecord = {
      id: nextTradeId++,
      time: new Date(exitTimeMs).toISOString(),
      pair: strategy.pair,
      side: openPos.side,
      entryPrice: round2(openPos.entryPrice),
      exitPrice: round2(exitPrice),
      size: openPos.notional,
      pnl,
      grossPnl,
      fees,
      entryTime: openPos.entryTime,
      exitTime: exitTimeMs,
      exitReason: reason,
      balanceAfter: balance,
      presetId: preset.id,
      presetName: preset.name,
      initialStopPrice: openPos.initialStopPrice,
      ...(foldIndex !== undefined ? { foldIndex } : {}),
    }
    trade.rMultiple = computeTradeRMultiple(trade, strategy.stopLoss)
    trades.push(trade)
    openPos = null

    if (dayStartBalance > 0) {
      const dailyLossPct = ((dayStartBalance - balance) / dayStartBalance) * 100
      if (dailyLossPct >= strategy.maxDailyRisk) {
        dayHalted = true
      }
    }
  }

  for (let i = startIdx; i < windowCandles.length; i += 1) {
    if ((i - startIdx) % PROGRESS_BAR_CHECKPOINT === 0) {
      checkCancelled(hooks)
      onBarStep?.(i - startIdx)
    }

    const candle = windowCandles[i]
    const dayKey = utcDayKey(candle.time)
    if (currentDayKey === null || dayKey !== currentDayKey) {
      currentDayKey = dayKey
      dayStartBalance = balance
      dayHalted = false
    }

    const sig = signalMap.get(i) ?? null

    if (openPos) {
      const hit = resolveExit(
        {
          side: openPos.side,
          stopPrice: openPos.stopPrice,
          targetPrice: openPos.targetPrice,
        },
        candle,
      )
      if (hit) {
        closeOpenPosition(hit.price, candle.time, hit.reason)
      } else if (
        filters?.signalEngine === 'donchian-breakout' &&
        evaluateDonchianExit(windowCandles, i, openPos.side, filters)
      ) {
        closeOpenPosition(candle.close, candle.time, 'signal')
      } else if (
        filters?.flipOnOppositeSignal &&
        sig &&
        sig.side !== openPos.side
      ) {
        closeOpenPosition(candle.close, candle.time, 'signal')
      } else if (filters?.breakevenAtOneR && !openPos.breakevenArmed) {
        const dir = openPos.side === 'buy' ? 1 : -1
        const totalDist = Math.abs(openPos.targetPrice - openPos.entryPrice)
        if (totalDist > 0) {
          const advance = (candle.close - openPos.entryPrice) * dir
          if (advance >= totalDist * 0.5) {
            const feeBuf =
              openPos.entryPrice * ((execution.commissionPct * 2.5) / 100)
            const beStop = round2(openPos.entryPrice + dir * feeBuf)
            const improves =
              openPos.side === 'buy'
                ? beStop > openPos.stopPrice
                : beStop < openPos.stopPrice
            if (improves) {
              openPos.stopPrice = beStop
              openPos.breakevenArmed = true
            }
          }
        }
      }
    }

    if (!openPos && !dayHalted && sig && i < windowCandles.length - 1 && balance > 10) {
      const entryPrice = fillPrice(candle.close, sig.side, execution.slippagePct)
      if (Number.isFinite(entryPrice) && entryPrice > 0) {
        const notional = round2(
          Math.min(balance, balance * (strategy.positionSize / 100)),
        )
        const quantity = notional / entryPrice
        const dir = sig.side === 'buy' ? 1 : -1
        const entryFee = round2(notional * (execution.commissionPct / 100))

        const defaultStop = round2(
          entryPrice * (1 - dir * (strategy.stopLoss / 100)),
        )
        const defaultTarget = round2(
          entryPrice * (1 + dir * (strategy.takeProfit / 100)),
        )

        const hasValidStop =
          typeof sig.stopPrice === 'number' &&
          Number.isFinite(sig.stopPrice) &&
          sig.stopPrice > 0 &&
          (sig.side === 'buy'
            ? sig.stopPrice < entryPrice
            : sig.stopPrice > entryPrice)
        const initialStopPrice = hasValidStop ? round2(sig.stopPrice!) : defaultStop

        const hasValidTarget =
          typeof sig.targetPrice === 'number' &&
          Number.isFinite(sig.targetPrice) &&
          sig.targetPrice > 0 &&
          (sig.side === 'buy'
            ? sig.targetPrice > entryPrice
            : sig.targetPrice < entryPrice)
        let targetPrice = hasValidTarget ? round2(sig.targetPrice!) : defaultTarget

        if (filters?.signalEngine === 'break-of-structure' && hasValidTarget) {
          targetPrice =
            sig.side === 'buy'
              ? Math.min(targetPrice, defaultTarget)
              : Math.max(targetPrice, defaultTarget)
        }

        openPos = {
          side: sig.side,
          entryPrice: round2(entryPrice),
          entryTime: candle.time,
          quantity,
          notional,
          entryFee,
          stopPrice: initialStopPrice,
          initialStopPrice,
          targetPrice,
          breakevenArmed: false,
        }
      }
    }

    if (recordEquity) {
      let markEquity = balance
      if (openPos) {
        const dir = openPos.side === 'buy' ? 1 : -1
        markEquity = Math.max(
          0,
          round2(
            balance +
              (candle.close - openPos.entryPrice) * openPos.quantity * dir -
              openPos.entryFee,
          ),
        )
      }
      if (markEquity > peak) peak = markEquity
      const ddPct = peak > 0 ? round2(((peak - markEquity) / peak) * 100) : 0
      equity.push({
        time: candle.time,
        equity: markEquity,
        drawdownPct: ddPct,
      })
    }
  }

  if (openPos) {
    const lastCandle = windowCandles[windowCandles.length - 1]
    closeOpenPosition(lastCandle.close, lastCandle.time, 'end')
    if (recordEquity && equity.length > 0) {
      if (balance > peak) peak = balance
      const ddPct = peak > 0 ? round2(((peak - balance) / peak) * 100) : 0
      equity[equity.length - 1] = {
        time: lastCandle.time,
        equity: balance,
        drawdownPct: ddPct,
      }
    }
  }

  return { trades, equity, finalBalance: balance }
}

function scoreValidationCandidate(metrics: {
  totalTrades: number
  profitFactor: number | null
  maxDrawdownPct: number
  netPnl: number
}): { pfScore: number; negDd: number; netPnl: number } {
  if (metrics.totalTrades === 0) {
    return { pfScore: -1, negDd: -100, netPnl: -Infinity }
  }
  const pfScore =
    metrics.profitFactor !== null
      ? metrics.profitFactor
      : metrics.netPnl > 0
        ? 50
        : 0
  return {
    pfScore,
    negDd: -metrics.maxDrawdownPct,
    netPnl: metrics.netPnl,
  }
}

function isBetterValidationCandidate(
  candidate: {
    totalTrades: number
    profitFactor: number | null
    maxDrawdownPct: number
    netPnl: number
  },
  incumbent: {
    totalTrades: number
    profitFactor: number | null
    maxDrawdownPct: number
    netPnl: number
  },
): boolean {
  const a = scoreValidationCandidate(candidate)
  const b = scoreValidationCandidate(incumbent)
  if (Math.abs(a.pfScore - b.pfScore) > 1e-6) {
    return a.pfScore > b.pfScore
  }
  if (Math.abs(a.negDd - b.negDd) > 1e-6) {
    return a.negDd > b.negDd
  }
  return a.netPnl > b.netPnl
}

type FoldBoundaries = {
  foldIndex: number
  foldStart: number
  trainStart: number
  trainEnd: number
  valStart: number
  valEnd: number
  testStart: number
  testEnd: number
}

export function buildWalkForwardFolds(
  candleCount: number,
  config: Pick<
    TrainingConfig,
    'foldCount' | 'foldMode' | 'trainRatio' | 'valRatio' | 'testRatio' | 'purgeGapBars'
  >,
): FoldBoundaries[] {
  const foldCount = Math.max(3, Math.min(8, Math.round(config.foldCount)))
  const testRatio = Math.max(0.1, Math.min(0.4, config.testRatio))
  const valRatio = Math.max(0.1, Math.min(0.35, config.valRatio))
  const requestedPurge = Math.max(1, Math.round(config.purgeGapBars))

  const baseWindow = Math.floor(candleCount / (1 + (foldCount - 1) * testRatio))
  const testLen = Math.max(8, Math.floor(baseWindow * testRatio))
  const valLen = Math.max(8, Math.floor(baseWindow * valRatio))

  const maxFeasiblePurge = Math.max(
    1,
    Math.floor((baseWindow - testLen - valLen - 60) / 2),
  )
  const effectivePurge = Math.min(requestedPurge, maxFeasiblePurge)

  const folds: FoldBoundaries[] = []
  let prevTestEnd = -1

  for (let f = 0; f < foldCount; f += 1) {
    const testEnd =
      f === foldCount - 1
        ? candleCount - 1
        : Math.min(candleCount - 1, baseWindow - 1 + f * testLen)
    let testStart = testEnd - testLen + 1
    if (prevTestEnd >= 0 && testStart <= prevTestEnd) {
      testStart = prevTestEnd + 1
    }
    const valEnd = testStart - 1 - effectivePurge
    const valStart = valEnd - valLen + 1
    const trainEnd = valStart - 1 - effectivePurge
    const foldStart =
      config.foldMode === 'anchored'
        ? 0
        : Math.max(0, testEnd - baseWindow + 1)

    if (
      testStart > testEnd ||
      valStart < foldStart + 56 ||
      trainEnd <= foldStart + 55
    ) {
      continue
    }

    folds.push({
      foldIndex: folds.length,
      foldStart,
      trainStart: foldStart,
      trainEnd,
      valStart,
      valEnd,
      testStart,
      testEnd,
    })
    prevTestEnd = testEnd
  }

  return folds
}

function applyRunAssumptionsToPreset(
  preset: StrategyPreset,
  config: TrainingConfig,
): StrategyPreset {
  const patch: StrategyPresetPatch = {
    timeframe: config.timeframe,
    strategy: { pair: config.pair },
    execution: {
      commissionPct: config.assumptions.commissionPct,
      slippagePct: config.assumptions.slippagePct,
      initialBalance: config.assumptions.initialBalance,
      allowShort: config.assumptions.allowShort,
    },
  }
  return mergePresetPatch(preset, patch)
}

/**
 * Purged walk-forward training runner (`walk-forward`):
 * - Fits bounded coordinate-descent variants strictly on each fold's train slice.
 * - Selects the best variant strictly on each fold's validation slice.
 * - Evaluates ONCE on the held-out test slice (never read during fit/selection).
 */
export function runWalkForwardTraining(
  candles: Candle[],
  basePreset: StrategyPreset,
  config: TrainingConfig,
  hooks?: TrainingRunHooks,
): TrainingRunOutput {
  checkCancelled(hooks)
  const effectiveBase = applyRunAssumptionsToPreset(basePreset, config)
  const foldsSpec = buildWalkForwardFolds(candles.length, config)
  if (foldsSpec.length === 0) {
    throw new Error(
      `Insufficient candles (${candles.length}) for ${config.foldCount}-fold walk-forward split with warmup and purge gap.`,
    )
  }

  const totalBars = candles.length
  hooks?.onProgress?.({
    phase: 'preparing',
    foldIndex: 0,
    foldCount: foldsSpec.length,
    barIndex: 0,
    barCount: totalBars,
  })

  const specs = getTunableParamSpecs(effectiveBase)
  const perFoldBaseBudget = Math.max(
    1,
    Math.floor(MAX_COORDINATE_EVALUATIONS / foldsSpec.length),
  )
  let remainingRemainder =
    MAX_COORDINATE_EVALUATIONS - perFoldBaseBudget * foldsSpec.length

  const foldResults: TrainingFoldResult[] = []
  const allOosTrades: TrainingTradeRecord[] = []
  const allOosEquity: TrainingEquityPoint[] = []
  const candidateLog: TrainingCandidateResult[] = []

  let runningOosBalance = config.assumptions.initialBalance
  let nextTradeId = 1
  let totalEvaluations = 0
  let latestSelectedPreset = effectiveBase

  for (const fold of foldsSpec) {
    checkCancelled(hooks)

    // Strict isolation: ONLY bars `[fold.foldStart .. fold.trainEnd]` enter Fit,
    // and ONLY bars `[fold.foldStart .. fold.valEnd]` enter Validate.
    // Bars `>= fold.testStart` are NEVER sliced or read until the `testing` phase.
    const trainSlice = candles.slice(fold.foldStart, fold.trainEnd + 1)
    const valSlice = candles.slice(fold.foldStart, fold.valEnd + 1)
    const valEvalStart = fold.valStart - fold.foldStart

    const foldBudget =
      perFoldBaseBudget + (remainingRemainder > 0 ? 1 : 0)
    if (remainingRemainder > 0) remainingRemainder -= 1

    hooks?.onProgress?.({
      phase: 'fitting',
      foldIndex: fold.foldIndex,
      foldCount: foldsSpec.length,
      barIndex: fold.trainStart,
      barCount: totalBars,
    })

    const evaluateCandidateOnFold = (
      candPreset: StrategyPreset,
    ): {
      valMetrics: TrainingRunMetrics
      trainMetrics: TrainingRunMetrics
    } => {
      checkCancelled(hooks)
      const trainSim = simulateSpotWindow({
        windowCandles: trainSlice,
        evalStartIdx: 55,
        preset: candPreset,
        startingBalance: config.assumptions.initialBalance,
        startingTradeId: 1,
        hooks,
      })
      const trainMetrics = computeCanonicalTrainingMetrics(
        trainSim.trades,
        config.assumptions.initialBalance,
        { fallbackStopLossPct: candPreset.strategy.stopLoss },
      )
      const valSim = simulateSpotWindow({
        windowCandles: valSlice,
        evalStartIdx: valEvalStart,
        preset: candPreset,
        startingBalance: config.assumptions.initialBalance,
        startingTradeId: 1,
        hooks,
      })
      const valMetrics = computeCanonicalTrainingMetrics(
        valSim.trades,
        config.assumptions.initialBalance,
        { fallbackStopLossPct: candPreset.strategy.stopLoss },
      )
      return { valMetrics, trainMetrics }
    }

    // Coordinate descent starting from baseline candidate
    let bestPreset = effectiveBase
    const baseEval = evaluateCandidateOnFold(effectiveBase)
    let bestValMetrics = baseEval.valMetrics
    let bestCandLogIdx = candidateLog.length
    totalEvaluations += 1
    let foldEvals = 1

    candidateLog.push({
      candidateIndex: totalEvaluations - 1,
      params: extractTunableParamMap(effectiveBase, specs),
      valTrades: bestValMetrics.totalTrades,
      valWinRatePct: bestValMetrics.winRate,
      valProfitFactor: bestValMetrics.profitFactor,
      valMaxDrawdownPct: bestValMetrics.maxDrawdownPct,
      valNetPnlUsd: bestValMetrics.netPnl,
      selected: false,
    })

    hooks?.onProgress?.({
      phase: 'validating',
      foldIndex: fold.foldIndex,
      foldCount: foldsSpec.length,
      barIndex: fold.valStart,
      barCount: totalBars,
    })

    for (const spec of specs) {
      if (foldEvals >= foldBudget || totalEvaluations >= MAX_COORDINATE_EVALUATIONS) {
        break
      }
      const currentVal = spec.read(bestPreset)
      const options = spec.candidates(bestPreset).filter((v) => v !== currentVal)
      for (const candidateVal of options) {
        if (foldEvals >= foldBudget || totalEvaluations >= MAX_COORDINATE_EVALUATIONS) {
          break
        }
        const trialPreset = spec.apply(bestPreset, candidateVal)
        const trialEval = evaluateCandidateOnFold(trialPreset)
        totalEvaluations += 1
        foldEvals += 1

        const logIdx = candidateLog.length
        candidateLog.push({
          candidateIndex: totalEvaluations - 1,
          params: extractTunableParamMap(trialPreset, specs),
          valTrades: trialEval.valMetrics.totalTrades,
          valWinRatePct: trialEval.valMetrics.winRate,
          valProfitFactor: trialEval.valMetrics.profitFactor,
          valMaxDrawdownPct: trialEval.valMetrics.maxDrawdownPct,
          valNetPnlUsd: trialEval.valMetrics.netPnl,
          selected: false,
        })

        // Accept candidate strictly when validation PF improves (tie-broken by lower DD)
        if (isBetterValidationCandidate(trialEval.valMetrics, bestValMetrics)) {
          bestPreset = trialPreset
          bestValMetrics = trialEval.valMetrics
          bestCandLogIdx = logIdx
        }
      }
    }

    if (candidateLog[bestCandLogIdx]) {
      candidateLog[bestCandLogIdx].selected = true
    }
    latestSelectedPreset = bestPreset

    // Held-out TEST window — read ONCE with the selected parameters
    hooks?.onProgress?.({
      phase: 'testing',
      foldIndex: fold.foldIndex,
      foldCount: foldsSpec.length,
      barIndex: fold.testStart,
      barCount: totalBars,
    })

    const testSlice = candles.slice(fold.foldStart, fold.testEnd + 1)
    const testEvalStart = fold.testStart - fold.foldStart
    const testSim = simulateSpotWindow({
      windowCandles: testSlice,
      evalStartIdx: testEvalStart,
      preset: bestPreset,
      startingBalance: runningOosBalance,
      startingTradeId: nextTradeId,
      foldIndex: fold.foldIndex,
      recordEquity: true,
      onBarStep: (offset) => {
        hooks?.onProgress?.({
          phase: 'testing',
          foldIndex: fold.foldIndex,
          foldCount: foldsSpec.length,
          barIndex: Math.min(totalBars, fold.testStart + offset),
          barCount: totalBars,
        })
      },
      hooks,
    })

    nextTradeId += testSim.trades.length
    runningOosBalance = testSim.finalBalance
    allOosTrades.push(...testSim.trades)
    allOosEquity.push(...testSim.equity)

    const foldTestMetrics = computeCanonicalTrainingMetrics(
      testSim.trades,
      config.assumptions.initialBalance,
      { fallbackStopLossPct: bestPreset.strategy.stopLoss },
    )

    foldResults.push({
      foldIndex: fold.foldIndex,
      trainFromMs: candles[fold.trainStart].time,
      trainToMs: candles[fold.trainEnd].time,
      valFromMs: candles[fold.valStart].time,
      valToMs: candles[fold.valEnd].time,
      testFromMs: candles[fold.testStart].time,
      testToMs: candles[fold.testEnd].time,
      trainBars: fold.trainEnd - fold.trainStart + 1,
      valBars: fold.valEnd - fold.valStart + 1,
      testBars: fold.testEnd - fold.testStart + 1,
      selectedParams: extractTunableParamMap(bestPreset, specs),
      valTrades: bestValMetrics.totalTrades,
      valProfitFactor: bestValMetrics.profitFactor,
      valMaxDrawdownPct: bestValMetrics.maxDrawdownPct,
      testTrades: foldTestMetrics.totalTrades,
      testWins: foldTestMetrics.wins,
      testWinRatePct: foldTestMetrics.winRate,
      testProfitFactor: foldTestMetrics.profitFactor,
      testMaxDrawdownPct: foldTestMetrics.maxDrawdownPct,
      testNetPnlUsd: foldTestMetrics.netPnl,
    })
  }

  // Recompute cumulative drawdownPct across the stitched OOS equity series
  let stitchedPeak = config.assumptions.initialBalance
  const normalizedEquity: TrainingEquityPoint[] = allOosEquity.map((pt) => {
    if (pt.equity > stitchedPeak) stitchedPeak = pt.equity
    const ddPct =
      stitchedPeak > 0
        ? round2(((stitchedPeak - pt.equity) / stitchedPeak) * 100)
        : 0
    return {
      time: pt.time,
      equity: pt.equity,
      drawdownPct: ddPct,
    }
  })

  hooks?.onProgress?.({
    phase: 'finalizing',
    foldIndex: foldsSpec.length,
    foldCount: foldsSpec.length,
    barIndex: totalBars,
    barCount: totalBars,
  })

  const aggregateMetrics = computeCanonicalTrainingMetrics(
    allOosTrades,
    config.assumptions.initialBalance,
    { fallbackStopLossPct: latestSelectedPreset.strategy.stopLoss },
  )
  aggregateMetrics.candidatesEvaluated = totalEvaluations
  aggregateMetrics.bestSelectedParams = extractTunableParamMap(
    latestSelectedPreset,
    specs,
  )
  aggregateMetrics.paramDiffs = buildParamDiffs(
    effectiveBase,
    latestSelectedPreset,
    specs,
  )
  aggregateMetrics.candidates = candidateLog

  return {
    metrics: aggregateMetrics,
    folds: foldResults,
    equity: normalizedEquity,
    trades: allOosTrades,
    selectedPreset: latestSelectedPreset,
  }
}

/**
 * Purged walk-forward ML meta-filter runner (`meta-filter`):
 * Reuses `buildSpotMetaSamples` + `trainAndEvaluateMetaFilter` (`CANDLE_FEATURE_NAMES`).
 */
export function runMetaFilterTraining(
  candles: Candle[],
  basePreset: StrategyPreset,
  config: TrainingConfig,
  hooks?: TrainingRunHooks,
): TrainingRunOutput {
  checkCancelled(hooks)
  const effectivePreset = applyRunAssumptionsToPreset(basePreset, config)
  const totalBars = candles.length

  hooks?.onProgress?.({
    phase: 'preparing',
    foldIndex: 0,
    foldCount: 1,
    barIndex: 0,
    barCount: totalBars,
  })

  const built = buildSpotMetaSamples(candles, effectivePreset)
  if (built.samples.length < 15) {
    throw new Error(
      `Insufficient signal samples (${built.samples.length}) for meta-filter training (minimum 15 required).`,
    )
  }

  checkCancelled(hooks)
  hooks?.onProgress?.({
    phase: 'fitting',
    foldIndex: 0,
    foldCount: 1,
    barIndex: Math.floor(totalBars * config.trainRatio),
    barCount: totalBars,
  })

  const comparison = trainAndEvaluateMetaFilter(built.samples, {
    strategyId: effectivePreset.id,
    featureNames: CANDLE_FEATURE_NAMES,
    trainRatio: config.trainRatio,
    valRatio: config.valRatio,
    purgeGap: config.purgeGapBars,
  })

  checkCancelled(hooks)
  hooks?.onProgress?.({
    phase: 'testing',
    foldIndex: 0,
    foldCount: 1,
    barIndex: Math.floor(totalBars * (config.trainRatio + config.valRatio)),
    barCount: totalBars,
  })

  // Align strictly with the exact same purged chronological split used by `trainAndEvaluateMetaFilter`
  const paired = built.samples
    .map((sample, idx) => ({ sample, trade: built.trades[idx] }))
    .sort((a, b) => a.sample.timestampMs - b.sample.timestampMs)

  const split = splitPurgedChronological(
    paired.map((p) => p.sample),
    {
      trainRatio: config.trainRatio,
      valRatio: config.valRatio,
      purgeGap: config.purgeGapBars,
    },
  )

  const testOffset = paired.length - split.test.length
  const oosPairs = paired.slice(testOffset)
  const keptOosTrades: TrainingTradeRecord[] = []
  const equity: TrainingEquityPoint[] = []

  const initBal = config.assumptions.initialBalance
  let filteredBal = initBal
  let filteredPeak = initBal
  let baselineBal = initBal

  for (let i = 0; i < oosPairs.length; i += 1) {
    if (i % PROGRESS_BAR_CHECKPOINT === 0) checkCancelled(hooks)
    const { sample, trade } = oosPairs[i]
    const scored = scoreWithMetaFilterModel(
      comparison.model,
      sample.featureVector,
    )
    baselineBal = round2(baselineBal + trade.pnl)
    if (scored.allowTrade) {
      filteredBal = round2(filteredBal + trade.pnl)
      keptOosTrades.push({
        ...trade,
        id: keptOosTrades.length + 1,
        balanceAfter: filteredBal,
        foldIndex: 0,
      })
    }
    if (filteredBal > filteredPeak) filteredPeak = filteredBal
    const ddPct =
      filteredPeak > 0
        ? round2(((filteredPeak - filteredBal) / filteredPeak) * 100)
        : 0
    equity.push({
      time: trade.exitTime ?? sample.timestampMs,
      equity: filteredBal,
      drawdownPct: ddPct,
      baselineEquity: baselineBal,
    })
  }

  hooks?.onProgress?.({
    phase: 'finalizing',
    foldIndex: 1,
    foldCount: 1,
    barIndex: totalBars,
    barCount: totalBars,
  })

  const metaSummary: MetaFilterRunSummary = {
    totalSamples: comparison.totalSamples,
    trainSamples: comparison.trainSamples,
    valSamples: comparison.valSamples,
    testSamples: comparison.testSamples,
    purgeGapUsed: comparison.purgeGapUsed,
    baseline: comparison.baseline,
    filtered: comparison.filtered,
    filteredSized: comparison.filteredSized,
    delta: comparison.delta,
    hardVetoRules: comparison.model.hardVetoRules,
    featureImportanceRanking: comparison.model.featureImportanceRanking,
  }

  const metrics = computeCanonicalTrainingMetrics(keptOosTrades, initBal, {
    fallbackStopLossPct: effectivePreset.strategy.stopLoss,
  })
  metrics.metaComparison = metaSummary

  const trainEndIdx = Math.max(0, split.train.length - 1)
  const valStartIdx = split.train.length + split.purgeGapUsed
  const valEndIdx = Math.max(valStartIdx, valStartIdx + split.val.length - 1)
  const testStartIdx = testOffset
  const testEndIdx = Math.max(testStartIdx, paired.length - 1)

  const fold: TrainingFoldResult = {
    foldIndex: 0,
    trainFromMs: paired[0]?.sample.timestampMs ?? candles[0].time,
    trainToMs: paired[trainEndIdx]?.sample.timestampMs ?? candles[0].time,
    valFromMs: paired[valStartIdx]?.sample.timestampMs ?? candles[0].time,
    valToMs: paired[valEndIdx]?.sample.timestampMs ?? candles[0].time,
    testFromMs: paired[testStartIdx]?.sample.timestampMs ?? candles[0].time,
    testToMs:
      paired[testEndIdx]?.sample.timestampMs ??
      candles[candles.length - 1].time,
    trainBars: split.train.length,
    valBars: split.val.length,
    testBars: split.test.length,
    selectedParams: {
      scoreThreshold: comparison.model.scoreThreshold,
      probabilityThreshold: comparison.model.probabilityThreshold,
      hardVetoCount: comparison.model.hardVetoRules.length,
    },
    valTrades: split.val.length,
    valProfitFactor: null,
    valMaxDrawdownPct: 0,
    testTrades: metrics.totalTrades,
    testWins: metrics.wins,
    testWinRatePct: metrics.winRate,
    testProfitFactor: metrics.profitFactor,
    testMaxDrawdownPct: metrics.maxDrawdownPct,
    testNetPnlUsd: metrics.netPnl,
  }

  return {
    metrics,
    folds: [fold],
    equity,
    trades: keptOosTrades,
    selectedPreset: effectivePreset,
  }
}

/**
 * Prediction-market walk-forward calibration & out-of-sample runner (`prediction-market`):
 * Reuses `simulatePredictionStrategy` (`src/predictionMarket.ts`).
 */
export function runPredictionMarketTraining(
  candles: Candle[],
  basePreset: StrategyPreset,
  config: TrainingConfig,
  hooks?: TrainingRunHooks,
): TrainingRunOutput {
  checkCancelled(hooks)
  const effectivePreset = applyRunAssumptionsToPreset(basePreset, config)
  const totalBars = candles.length

  hooks?.onProgress?.({
    phase: 'preparing',
    foldIndex: 0,
    foldCount: 1,
    barIndex: 0,
    barCount: totalBars,
  })

  const singleRule = resolvePresetPredictionRule(effectivePreset)
  const rules = singleRule
    ? [singleRule]
    : BITCOIN_20_PREDICTIONS.filter(
        (r) => r.timeframe === effectivePreset.timeframe,
      )
  if (rules.length === 0) {
    throw new Error(
      `No prediction rules matched preset "${effectivePreset.id}" (${effectivePreset.timeframe}).`,
    )
  }

  const initBankroll = config.assumptions.initialBalance
  const clampedTrainRatio = Math.max(
    0.5,
    Math.min(0.9, config.trainRatio + config.valRatio * 0.5),
  )

  const simConfig: SimulationConfig = {
    ...DEFAULT_SIMULATION_CONFIG,
    initialBankroll: initBankroll,
    sizing: effectivePreset.useQuarterKelly ? 'quarter-kelly' : 'fixed',
    fixedStakePct: Math.max(0.5, Math.min(25, effectivePreset.strategy.positionSize)),
    maxStakePct: Math.max(1, Math.min(25, effectivePreset.strategy.positionSize)),
    minEdgePct: effectivePreset.minEdgePct ?? 3,
    allowNo: true,
    minConfluence: 1,
    useCooldown: true,
    trainRatio: clampedTrainRatio,
    costs: {
      spreadCents: Math.max(0, round2(config.assumptions.slippagePct * 100)),
      feePct: Math.max(0, config.assumptions.commissionPct),
    },
    monteCarloRuns: 500,
    seed: 42,
  }

  hooks?.onProgress?.({
    phase: 'fitting',
    foldIndex: 0,
    foldCount: 1,
    barIndex: Math.floor(totalBars * clampedTrainRatio),
    barCount: totalBars,
  })

  const sim = simulatePredictionStrategy(candles, rules, simConfig)
  if (sim.insufficientData) {
    throw new Error(
      `Insufficient candles (${candles.length}) for prediction-market train/test split.`,
    )
  }

  checkCancelled(hooks)
  hooks?.onProgress?.({
    phase: 'finalizing',
    foldIndex: 1,
    foldCount: 1,
    barIndex: totalBars,
    barCount: totalBars,
  })

  let runningBal = initBankroll
  const trades: TrainingTradeRecord[] = sim.tickets.map((tk, idx) => {
    const pnl = round2(tk.pnl)
    runningBal = Math.max(0, round2(runningBal + pnl))
    return {
      id: idx + 1,
      time: new Date(tk.resolveTime).toISOString(),
      pair: config.pair,
      side: tk.side === 'YES' ? 'buy' : 'sell',
      entryPrice: round4(tk.price),
      exitPrice: tk.won ? 1 : 0,
      size: round2(tk.stake),
      pnl,
      grossPnl: pnl,
      fees: 0,
      entryTime: tk.entryTime,
      exitTime: tk.resolveTime,
      exitReason: tk.won ? 'target' : 'stop',
      balanceAfter: runningBal,
      presetId: effectivePreset.id,
      presetName: effectivePreset.name,
      foldIndex: 0,
      rMultiple: tk.stake > 0 ? round2(pnl / tk.stake) : null,
    }
  })

  let peak = initBankroll
  const equity: TrainingEquityPoint[] = sim.equity.map((pt) => {
    if (pt.value > peak) peak = pt.value
    const ddPct = peak > 0 ? round2(((peak - pt.value) / peak) * 100) : 0
    return {
      time: pt.time,
      equity: pt.value,
      drawdownPct: ddPct,
    }
  })

  const predictionSummary: PredictionMarketRunSummary = {
    priceSource: sim.priceSource,
    trainFromTime: sim.trainFromTime ?? candles[0].time,
    testFromTime: sim.testFromTime ?? candles[0].time,
    testToTime: sim.testToTime ?? candles[candles.length - 1].time,
    calibration: sim.calibration,
    simulationMetrics: sim.metrics,
    monteCarlo: sim.monteCarlo,
  }

  const metrics = computeCanonicalTrainingMetrics(trades, initBankroll)
  metrics.predictionSummary = predictionSummary

  const trainFrom = sim.trainFromTime ?? candles[0].time
  const testFrom = sim.testFromTime ?? candles[0].time
  const testTo = sim.testToTime ?? candles[candles.length - 1].time
  const trainBars = candles.filter(
    (c) => c.time >= trainFrom && c.time < testFrom,
  ).length
  const testBars = candles.filter(
    (c) => c.time >= testFrom && c.time <= testTo,
  ).length

  const fold: TrainingFoldResult = {
    foldIndex: 0,
    trainFromMs: trainFrom,
    trainToMs: testFrom,
    valFromMs: testFrom,
    valToMs: testFrom,
    testFromMs: testFrom,
    testToMs: testTo,
    trainBars,
    valBars: 0,
    testBars,
    selectedParams: {
      trainRatio: round2(clampedTrainRatio),
      minEdgePct: simConfig.minEdgePct,
      sizing: simConfig.sizing,
    },
    valTrades: 0,
    valProfitFactor: null,
    valMaxDrawdownPct: 0,
    testTrades: metrics.totalTrades,
    testWins: metrics.wins,
    testWinRatePct: metrics.winRate,
    testProfitFactor: metrics.profitFactor,
    testMaxDrawdownPct: metrics.maxDrawdownPct,
    testNetPnlUsd: metrics.netPnl,
  }

  return {
    metrics,
    folds: [fold],
    equity,
    trades,
    selectedPreset: effectivePreset,
  }
}

export function runTrainingPipeline(
  request: TrainingPipelineRequest,
  hooks?: TrainingRunHooks,
): TrainingRunOutput {
  const { candles, preset, config } = request
  if (config.kind === 'prediction-market') {
    return runPredictionMarketTraining(candles, preset, config, hooks)
  }
  if (config.kind === 'meta-filter') {
    return runMetaFilterTraining(candles, preset, config, hooks)
  }
  return runWalkForwardTraining(candles, preset, config, hooks)
}
