import type {
  BacktestSettings,
  BacktestTrade,
} from './backtest'
import { resolveExit } from './backtest'
import { ema, rsi, sma } from './indicators'
import { intervalMs } from './market/intervals'
import {
  validateExecutableQuote,
  type ExecutablePredictionQuote,
} from './market/quoteService'
import { binaryKellyFraction } from './predictionMarket'
import {
  BITCOIN_20_PREDICTIONS,
  buildMarketContext,
  computeWilsonLowerBoundPct,
  evaluatePredictionRule,
  type PredictionOutcome,
} from './predictions'
import { crossoverSignals, defaultSignalParams } from './signals'
import {
  clampBreakOfStructureParams,
  clampDonchianParams,
  clampSupportResistanceParams,
  evaluateDonchianExit,
  isNewSpotEngine,
  signalAt as evaluateNewSpotEngineAt,
  type NewSpotEngineId,
  type SpotEngineSignal,
} from './spotEngines'
import { availablePairs, defaultStrategy } from './strategy'
import type {
  Candle,
  ExitReason,
  Interval,
  SignalParams,
  Strategy,
  TradeSide,
} from './types'

type BotExecutionMode = 'paper' | 'live-webhook'
export type BotDomain = 'crypto-spot' | 'prediction-market'
export type SpotSignalEngine =
  | 'crossover'
  | 'rsi-reversion'
  | 'momentum-structure'
  | NewSpotEngineId

export type SignalFilterConfig = {
  /** Signal engine for Crypto Spot/Perps */
  signalEngine?: SpotSignalEngine
  /** Skip buying in overbought conditions (RSI > maxBuyRsi) or selling in oversold (RSI < minSellRsi) */
  avoidRsiExtremes?: boolean
  maxBuyRsi?: number
  minSellRsi?: number
  /** Thresholds for the rsi-reversion engine */
  oversoldRsi?: number
  overboughtRsi?: number
  /** Require close alignment with institutional EMA 50 */
  requireEma50Alignment?: boolean
  /** Lock in breakeven + fees when price advances >= 50% toward Take Profit */
  breakevenAtOneR?: boolean
  /** When false, avoid premature exits on opposite signals before target or stop */
  flipOnOppositeSignal?: boolean
  /** Donchian Breakout parameters */
  channelPeriod?: number
  exitPeriod?: number
  atrPeriod?: number
  atrStopMult?: number
  trendFilter?: 'ema200' | 'none'
  minAtrPct?: number
  /** Support & Resistance parameters */
  pivotLookback?: number
  clusterAtrMult?: number
  minTouches?: number
  maxLevelAgeBars?: number
  touchToleranceAtr?: number
  minLongRsi?: number
  maxShortRsi?: number
  /** Break of Structure parameters */
  swingLookback?: number
  retestWindowBars?: number
  retestToleranceAtr?: number
  stopBufferAtr?: number
  targetRMultiple?: number
  requireRetest?: boolean
}

export type StrategyPreset = {
  id: string
  name: string
  domain: BotDomain
  description: string
  timeframe: Interval
  strategy: Strategy
  signalParams: SignalParams
  execution: BacktestSettings
  filters?: SignalFilterConfig
  predictionRuleId?: string
  minEdgePct?: number
  minTriggers?: number
  useQuarterKelly?: boolean
}

export type StrategyPresetPatch = {
  name?: string
  description?: string
  domain?: BotDomain
  timeframe?: Interval
  strategy?: Partial<Strategy>
  signalParams?: Partial<SignalParams>
  execution?: Partial<BacktestSettings>
  filters?: Partial<SignalFilterConfig>
  predictionRuleId?: string
  minEdgePct?: number
  minTriggers?: number
  useQuarterKelly?: boolean
}

type ActivePaperPosition = {
  side: TradeSide
  pair: string
  entryPrice: number
  entryTime: number
  quantity: number
  notional: number
  entryFee: number
  stopPrice: number
  initialStopPrice?: number
  targetPrice: number
  breakevenArmed?: boolean
  presetId?: string
  presetName?: string
}

type ActivePredictionTicket = {
  id: number
  ruleId: string
  title: string
  timeframe: Interval
  outcome: PredictionOutcome
  entryBarTime: number
  entryReferencePrice: number
  stakeUsd: number
  fairPricePaid: number
  bid?: number
  ask?: number
  quoteAsOf?: string
  quoteSource?: string
  instrumentId?: string
  feeUsd?: number
  horizonBars: number
  barsElapsed: number
}

type ResolvedPredictionTicket = ActivePredictionTicket & {
  resolvedTime: number
  won: boolean
  payoutUsd: number
  netPnlUsd: number
}

export type BotEngineLog = {
  id: number
  timestamp: string
  level: 'info' | 'signal' | 'trade' | 'risk' | 'prediction'
  message: string
}

export type BotEngineState = {
  mode: BotExecutionMode
  domain: BotDomain
  pair: string
  timeframe: Interval
  balance: number
  initialBalance: number
  dayStartBalance: number
  currentDayKey: number | null
  dayHalted: boolean
  lastProcessedCandleTime: number | null
  openPosition: ActivePaperPosition | null
  closedTrades: BacktestTrade[]
  activeTickets: ActivePredictionTicket[]
  resolvedTickets: ResolvedPredictionTicket[]
  nextTicketId: number
  nextTradeId: number
  logs: BotEngineLog[]
}

export type BotPresetAccuracyReport = {
  presetId: string
  name: string
  domain: BotDomain
  timeframe: Interval
  totalOperations: number
  wins: number
  losses: number
  winRatePct: number
  wilsonLowerBoundPct: number
  netPnlUsd: number
  returnPct: number
  profitFactor: number | null
  maxDrawdownPct: number
}

type StepBotOptions = {
  /**
   * When `nowMs` is supplied (e.g., `Date.now()` in the live backend), `stepBotEngine`
   * checks whether the latest candle is still open (`nowMs < candle.time + intervalMs`).
   * If open, it monitors intra-candle Stop Loss / Take Profit only and evaluates new
   * signals strictly on the latest closed candle to prevent repainting.
   */
  nowMs?: number
  /** Fresh executable prediction quote injected by `tickBot` / quote service (`P0-1`). */
  predictionQuote?: ExecutablePredictionQuote | null
  /** Enforce executable quote freshness/bounds (`default: true` unless benchmark replay). */
  requireExecutableQuote?: boolean
  /** Maximum quote staleness allowed on live prediction entries (default: 30_000 ms). */
  quoteMaxAgeMs?: number
  /**
   * Explicit 50c mid assumption strictly for offline historical candle benchmarks
   * (`evaluateBotPresetAccuracy`) when historical CLOB orderbooks are unavailable.
   */
  benchmarkFixedMidPrice?: number
  /**
   * Control-plane flag: when `false` (paused state), open positions and active
   * prediction tickets continue to be managed/closed, while new entries are blocked.
   */
  allowNewEntries?: boolean
}

export function resolvePresetPredictionRule(preset: StrategyPreset) {
  return (
    BITCOIN_20_PREDICTIONS.find((r) => r.id === preset.predictionRuleId) ??
    BITCOIN_20_PREDICTIONS.find((r) => r.timeframe === preset.timeframe) ??
    null
  )
}

const VALID_BOT_DOMAINS: readonly BotDomain[] = [
  'crypto-spot',
  'prediction-market',
]
const VALID_BOT_INTERVALS: readonly Interval[] = ['5m', '15m', '1h', '4h', '1d']
const VALID_SIGNAL_ENGINES: readonly SpotSignalEngine[] = [
  'momentum-structure',
  'crossover',
  'rsi-reversion',
  'donchian-breakout',
  'support-resistance',
  'break-of-structure',
]

function clampRange(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  roundInt = false,
): number {
  const num = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(num)) return fallback
  const bounded = Math.min(max, Math.max(min, num))
  return roundInt ? Math.round(bounded) : bounded
}

/**
 * Safely merges a user-supplied parameter patch into a `StrategyPreset`,
 * clamping every numeric bound and keeping signal/RSI inequalities coherent.
 */
export function mergePresetPatch(
  base: StrategyPreset,
  patch?: StrategyPresetPatch | null,
): StrategyPreset {
  if (!patch || typeof patch !== 'object') return base

  const domain: BotDomain =
    patch.domain && VALID_BOT_DOMAINS.includes(patch.domain)
      ? patch.domain
      : base.domain
  const timeframe: Interval =
    patch.timeframe && VALID_BOT_INTERVALS.includes(patch.timeframe)
      ? patch.timeframe
      : base.timeframe

  const rawPair = patch.strategy?.pair
  const pair =
    typeof rawPair === 'string' && availablePairs.includes(rawPair)
      ? rawPair
      : base.strategy.pair

  const nextStrategy: Strategy = {
    pair,
    positionSize: clampRange(
      patch.strategy?.positionSize,
      base.strategy.positionSize,
      0.1,
      100,
    ),
    stopLoss: clampRange(
      patch.strategy?.stopLoss,
      base.strategy.stopLoss,
      0.1,
      50,
    ),
    takeProfit: clampRange(
      patch.strategy?.takeProfit,
      base.strategy.takeProfit,
      0.1,
      100,
    ),
    maxDailyRisk: clampRange(
      patch.strategy?.maxDailyRisk,
      base.strategy.maxDailyRisk,
      0.1,
      100,
    ),
  }

  let fastPeriod = clampRange(
    patch.signalParams?.fastPeriod,
    base.signalParams.fastPeriod,
    2,
    150,
    true,
  )
  let slowPeriod = clampRange(
    patch.signalParams?.slowPeriod,
    base.signalParams.slowPeriod,
    3,
    300,
    true,
  )
  if (fastPeriod >= slowPeriod) {
    slowPeriod = Math.min(300, fastPeriod + 1)
    if (fastPeriod >= slowPeriod) {
      fastPeriod = Math.max(2, slowPeriod - 1)
    }
  }

  const nextSignalParams: SignalParams = {
    fastPeriod,
    slowPeriod,
    average:
      patch.signalParams?.average === 'sma' ||
      patch.signalParams?.average === 'ema'
        ? patch.signalParams.average
        : base.signalParams.average,
  }

  const nextExecution: BacktestSettings = {
    initialBalance: clampRange(
      patch.execution?.initialBalance,
      base.execution.initialBalance,
      100,
      10_000_000,
    ),
    commissionPct: clampRange(
      patch.execution?.commissionPct,
      base.execution.commissionPct,
      0,
      5,
    ),
    slippagePct: clampRange(
      patch.execution?.slippagePct,
      base.execution.slippagePct,
      0,
      5,
    ),
    allowShort:
      typeof patch.execution?.allowShort === 'boolean'
        ? patch.execution.allowShort
        : base.execution.allowShort,
  }

  const baseFilters = base.filters ?? {}
  const patchFilters = patch.filters ?? {}
  const signalEngine: SpotSignalEngine =
    patchFilters.signalEngine &&
    VALID_SIGNAL_ENGINES.includes(patchFilters.signalEngine)
      ? patchFilters.signalEngine
      : (baseFilters.signalEngine ?? 'momentum-structure')

  const maxBuyRsi = clampRange(
    patchFilters.maxBuyRsi,
    baseFilters.maxBuyRsi ?? 68,
    45,
    95,
    true,
  )
  const minSellRsi = Math.min(
    maxBuyRsi - 5,
    clampRange(
      patchFilters.minSellRsi,
      baseFilters.minSellRsi ?? 32,
      5,
      55,
      true,
    ),
  )
  const overboughtRsi = clampRange(
    patchFilters.overboughtRsi,
    baseFilters.overboughtRsi ?? 70,
    50,
    95,
    true,
  )
  const oversoldRsi = Math.min(
    overboughtRsi - 5,
    clampRange(
      patchFilters.oversoldRsi,
      baseFilters.oversoldRsi ?? 30,
      5,
      50,
      true,
    ),
  )

  const nextFilters: SignalFilterConfig = {
    signalEngine,
    avoidRsiExtremes:
      typeof patchFilters.avoidRsiExtremes === 'boolean'
        ? patchFilters.avoidRsiExtremes
        : (baseFilters.avoidRsiExtremes ?? true),
    maxBuyRsi,
    minSellRsi,
    oversoldRsi,
    overboughtRsi,
    requireEma50Alignment:
      typeof patchFilters.requireEma50Alignment === 'boolean'
        ? patchFilters.requireEma50Alignment
        : (baseFilters.requireEma50Alignment ?? false),
    breakevenAtOneR:
      typeof patchFilters.breakevenAtOneR === 'boolean'
        ? patchFilters.breakevenAtOneR
        : (baseFilters.breakevenAtOneR ?? true),
    flipOnOppositeSignal:
      typeof patchFilters.flipOnOppositeSignal === 'boolean'
        ? patchFilters.flipOnOppositeSignal
        : (baseFilters.flipOnOppositeSignal ?? false),
  }

  if (signalEngine === 'donchian-breakout') {
    const mergedDonchian = clampDonchianParams({
      channelPeriod: patchFilters.channelPeriod ?? baseFilters.channelPeriod,
      exitPeriod: patchFilters.exitPeriod ?? baseFilters.exitPeriod,
      atrPeriod: patchFilters.atrPeriod ?? baseFilters.atrPeriod,
      atrStopMult: patchFilters.atrStopMult ?? baseFilters.atrStopMult,
      trendFilter: patchFilters.trendFilter ?? baseFilters.trendFilter,
      minAtrPct: patchFilters.minAtrPct ?? baseFilters.minAtrPct,
    })
    Object.assign(nextFilters, mergedDonchian)
  } else if (signalEngine === 'support-resistance') {
    const mergedSr = clampSupportResistanceParams({
      pivotLookback: patchFilters.pivotLookback ?? baseFilters.pivotLookback,
      clusterAtrMult: patchFilters.clusterAtrMult ?? baseFilters.clusterAtrMult,
      minTouches: patchFilters.minTouches ?? baseFilters.minTouches,
      maxLevelAgeBars:
        patchFilters.maxLevelAgeBars ?? baseFilters.maxLevelAgeBars,
      touchToleranceAtr:
        patchFilters.touchToleranceAtr ?? baseFilters.touchToleranceAtr,
      atrStopMult: patchFilters.atrStopMult ?? baseFilters.atrStopMult,
      minLongRsi: patchFilters.minLongRsi ?? baseFilters.minLongRsi,
      maxShortRsi: patchFilters.maxShortRsi ?? baseFilters.maxShortRsi,
      atrPeriod: patchFilters.atrPeriod ?? baseFilters.atrPeriod,
    })
    Object.assign(nextFilters, mergedSr)
  } else if (signalEngine === 'break-of-structure') {
    const mergedBos = clampBreakOfStructureParams({
      swingLookback: patchFilters.swingLookback ?? baseFilters.swingLookback,
      retestWindowBars:
        patchFilters.retestWindowBars ?? baseFilters.retestWindowBars,
      retestToleranceAtr:
        patchFilters.retestToleranceAtr ?? baseFilters.retestToleranceAtr,
      stopBufferAtr: patchFilters.stopBufferAtr ?? baseFilters.stopBufferAtr,
      targetRMultiple:
        patchFilters.targetRMultiple ?? baseFilters.targetRMultiple,
      atrPeriod: patchFilters.atrPeriod ?? baseFilters.atrPeriod,
      requireRetest: patchFilters.requireRetest ?? baseFilters.requireRetest,
    })
    Object.assign(nextFilters, mergedBos)
  }

  const validRule =
    typeof patch.predictionRuleId === 'string' &&
    BITCOIN_20_PREDICTIONS.some((r) => r.id === patch.predictionRuleId)
      ? patch.predictionRuleId
      : base.predictionRuleId

  return {
    ...base,
    name:
      typeof patch.name === 'string' && patch.name.trim().length > 0
        ? patch.name.trim().slice(0, 90)
        : base.name,
    description:
      typeof patch.description === 'string'
        ? patch.description.trim().slice(0, 280)
        : base.description,
    domain,
    timeframe,
    strategy: nextStrategy,
    signalParams: nextSignalParams,
    execution: nextExecution,
    filters: nextFilters,
    predictionRuleId: validRule,
    minEdgePct: clampRange(
      patch.minEdgePct,
      base.minEdgePct ?? 15,
      0,
      50,
    ),
    minTriggers: clampRange(
      patch.minTriggers,
      base.minTriggers ?? 5,
      1,
      100,
      true,
    ),
    useQuarterKelly:
      typeof patch.useQuarterKelly === 'boolean'
        ? patch.useQuarterKelly
        : (base.useQuarterKelly ?? true),
  }
}

const DAY_MS = 86_400_000
const MAX_LOGS = 100

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function directionOf(side: TradeSide): number {
  return side === 'buy' ? 1 : -1
}

function fillPrice(
  price: number,
  side: TradeSide,
  slippagePct: number,
): number {
  return price * (1 + directionOf(side) * (slippagePct / 100))
}

export function isCandleClosed(
  candle: Candle,
  timeframe: Interval,
  nowMs: number,
): boolean {
  return nowMs >= candle.time + intervalMs[timeframe]
}

/**
 * Catalog of 8 verified strategy presets spanning Crypto Spot and Prediction Markets.
 */
export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: 'btc-ema-scalp-5m',
    name: '1. BTC 5m Scalp',
    domain: 'crypto-spot',
    description:
      '5m trend continuation aligned with EMA 50 and breakeven stop lock.',
    timeframe: '5m',
    strategy: {
      pair: 'BTC/USDT',
      positionSize: 15,
      stopLoss: 0.55,
      takeProfit: 0.95,
      maxDailyRisk: 2.5,
    },
    signalParams: { fastPeriod: 5, slowPeriod: 20, average: 'ema' },
    execution: {
      initialBalance: 10_000,
      commissionPct: 0.04,
      slippagePct: 0.01,
      allowShort: true,
    },
    filters: {
      signalEngine: 'momentum-structure',
      avoidRsiExtremes: true,
      maxBuyRsi: 64,
      minSellRsi: 36,
      requireEma50Alignment: true,
      breakevenAtOneR: true,
      flipOnOppositeSignal: false,
    },
  },
  {
    id: 'btc-intraday-trend-15m',
    name: '2. BTC 15m Pullback',
    domain: 'crypto-spot',
    description:
      'Intraday 15m pullbacks along EMA 50 with 1:1.7 R:R and breakeven lock.',
    timeframe: '15m',
    strategy: {
      pair: 'BTC/USDT',
      positionSize: 15,
      stopLoss: 0.85,
      takeProfit: 1.52,
      maxDailyRisk: 3.0,
    },
    signalParams: { fastPeriod: 9, slowPeriod: 26, average: 'ema' },
    execution: {
      initialBalance: 10_000,
      commissionPct: 0.05,
      slippagePct: 0.02,
      allowShort: true,
    },
    filters: {
      signalEngine: 'momentum-structure',
      avoidRsiExtremes: true,
      maxBuyRsi: 65,
      minSellRsi: 35,
      requireEma50Alignment: true,
      breakevenAtOneR: true,
      flipOnOppositeSignal: false,
    },
  },
  {
    id: 'eth-swing-breakout-1h',
    name: '3. ETH 1h Swing',
    domain: 'crypto-spot',
    description:
      'Hourly pullbacks along EMA 50 on ETH with breakeven stop lock.',
    timeframe: '1h',
    strategy: {
      pair: 'ETH/USDT',
      positionSize: 20,
      stopLoss: 1.8,
      takeProfit: 1.9,
      maxDailyRisk: 4.0,
    },
    signalParams: { fastPeriod: 9, slowPeriod: 20, average: 'sma' },
    execution: {
      initialBalance: 10_000,
      commissionPct: 0.06,
      slippagePct: 0.03,
      allowShort: true,
    },
    filters: {
      signalEngine: 'momentum-structure',
      avoidRsiExtremes: true,
      maxBuyRsi: 66,
      minSellRsi: 34,
      breakevenAtOneR: true,
      flipOnOppositeSignal: false,
    },
  },
  {
    id: 'sol-volatility-surfer-4h',
    name: '4. SOL 4h Trend (EMA 12/26)',
    domain: 'crypto-spot',
    description:
      '4h SOL trend entries with RSI filtering and breakeven stop lock.',
    timeframe: '4h',
    strategy: {
      pair: 'SOL/USDT',
      positionSize: 15,
      stopLoss: 3.2,
      takeProfit: 3.4,
      maxDailyRisk: 4.5,
    },
    signalParams: { fastPeriod: 12, slowPeriod: 26, average: 'ema' },
    execution: {
      initialBalance: 10_000,
      commissionPct: 0.08,
      slippagePct: 0.04,
      allowShort: true,
    },
    filters: {
      signalEngine: 'momentum-structure',
      avoidRsiExtremes: true,
      maxBuyRsi: 68,
      minSellRsi: 32,
      breakevenAtOneR: true,
      flipOnOppositeSignal: false,
    },
  },
  {
    id: 'btc-macro-institutional-1d',
    name: '5. BTC 1d Swing (SMA 12/50)',
    domain: 'crypto-spot',
    description:
      'Long-only daily swing entries on BTC pullbacks.',
    timeframe: '1d',
    strategy: {
      pair: 'BTC/USDT',
      positionSize: 25,
      stopLoss: 4.2,
      takeProfit: 4.5,
      maxDailyRisk: 5.0,
    },
    signalParams: { fastPeriod: 12, slowPeriod: 50, average: 'sma' },
    execution: {
      initialBalance: 10_000,
      commissionPct: 0.08,
      slippagePct: 0.04,
      allowShort: false,
    },
    filters: {
      signalEngine: 'momentum-structure',
      avoidRsiExtremes: true,
      maxBuyRsi: 70,
      minSellRsi: 30,
      breakevenAtOneR: true,
      flipOnOppositeSignal: false,
    },
  },
  {
    id: 'pred-btc-sma20-bear-cap-15m',
    name: '6. BTC Below SMA 20 (15m)',
    domain: 'prediction-market',
    description:
      'Buys YES contracts when BTC trades below 15m SMA 20 with RSI < 45.',
    timeframe: '15m',
    strategy: { ...defaultStrategy, pair: 'BTC/USDT', positionSize: 5 },
    signalParams: defaultSignalParams,
    execution: {
      initialBalance: 1_000,
      commissionPct: 0,
      slippagePct: 0,
      allowShort: false,
    },
    predictionRuleId: 'm15-sma20-bear-hold',
    minEdgePct: 15,
    minTriggers: 5,
    useQuarterKelly: true,
  },
  {
    id: 'pred-btc-inside-bar-4h',
    name: '7. BTC Inside Bar Breakout (4h)',
    domain: 'prediction-market',
    description:
      'Trades range breakouts after 4h inside-bar compression.',
    timeframe: '4h',
    strategy: { ...defaultStrategy, pair: 'BTC/USDT', positionSize: 5 },
    signalParams: defaultSignalParams,
    execution: {
      initialBalance: 1_000,
      commissionPct: 0,
      slippagePct: 0,
      allowShort: false,
    },
    predictionRuleId: 'h4-inside-bar-breakout',
    minEdgePct: 20,
    minTriggers: 5,
    useQuarterKelly: true,
  },
  {
    id: 'pred-btc-bollinger-reversion-1d',
    name: '8. BTC 3-Day Rebound (1d)',
    domain: 'prediction-market',
    description:
      'Opens YES bounce contracts within 48h after 3 red daily candles.',
    timeframe: '1d',
    strategy: { ...defaultStrategy, pair: 'BTC/USDT', positionSize: 5 },
    signalParams: defaultSignalParams,
    execution: {
      initialBalance: 1_000,
      commissionPct: 0,
      slippagePct: 0,
      allowShort: false,
    },
    predictionRuleId: 'd1-3red-days-relief',
    minEdgePct: 15,
    minTriggers: 5,
    useQuarterKelly: true,
  },
  {
    id: 'btc-donchian-breakout-1h',
    name: '9. BTC 1h Donchian Breakout',
    domain: 'crypto-spot',
    description:
      '20-bar Donchian channel breakout filtered by EMA 200 and ATR volatility with 10-bar channel exit and 2x ATR stop.',
    timeframe: '1h',
    strategy: {
      pair: 'BTC/USDT',
      positionSize: 15,
      stopLoss: 2.5,
      takeProfit: 5.0,
      maxDailyRisk: 4.0,
    },
    signalParams: { fastPeriod: 20, slowPeriod: 50, average: 'ema' },
    execution: {
      initialBalance: 10_000,
      commissionPct: 0.06,
      slippagePct: 0.03,
      allowShort: true,
    },
    filters: {
      signalEngine: 'donchian-breakout',
      channelPeriod: 20,
      exitPeriod: 10,
      atrPeriod: 14,
      atrStopMult: 2,
      trendFilter: 'ema200',
      minAtrPct: 0.15,
      breakevenAtOneR: true,
      flipOnOppositeSignal: false,
    },
  },
  {
    id: 'eth-support-resistance-1h',
    name: '10. ETH 1h Support & Resistance',
    domain: 'crypto-spot',
    description:
      'Confirmed pivot-cluster support/resistance rejections with ATR stops and nearest-level or 2R targets.',
    timeframe: '1h',
    strategy: {
      pair: 'ETH/USDT',
      positionSize: 15,
      stopLoss: 2.0,
      takeProfit: 4.0,
      maxDailyRisk: 4.0,
    },
    signalParams: { fastPeriod: 9, slowPeriod: 26, average: 'ema' },
    execution: {
      initialBalance: 10_000,
      commissionPct: 0.06,
      slippagePct: 0.03,
      allowShort: true,
    },
    filters: {
      signalEngine: 'support-resistance',
      pivotLookback: 2,
      clusterAtrMult: 0.35,
      minTouches: 2,
      maxLevelAgeBars: 300,
      touchToleranceAtr: 0.25,
      atrStopMult: 1.0,
      minLongRsi: 40,
      maxShortRsi: 60,
      atrPeriod: 14,
      breakevenAtOneR: true,
      flipOnOppositeSignal: false,
    },
  },
  {
    id: 'sol-bos-structure-15m',
    name: '11. SOL 15m Break of Structure',
    domain: 'crypto-spot',
    description:
      'Higher-low / lower-high confirmed swing Break of Structure entries (close or retest) with protected swing stops and 2R targets.',
    timeframe: '15m',
    strategy: {
      pair: 'SOL/USDT',
      positionSize: 15,
      stopLoss: 1.8,
      takeProfit: 3.6,
      maxDailyRisk: 3.5,
    },
    signalParams: { fastPeriod: 9, slowPeriod: 21, average: 'ema' },
    execution: {
      initialBalance: 10_000,
      commissionPct: 0.06,
      slippagePct: 0.03,
      allowShort: true,
    },
    filters: {
      signalEngine: 'break-of-structure',
      swingLookback: 2,
      retestWindowBars: 3,
      retestToleranceAtr: 0.5,
      stopBufferAtr: 0.25,
      targetRMultiple: 2.0,
      atrPeriod: 14,
      requireRetest: false,
      breakevenAtOneR: true,
      flipOnOppositeSignal: false,
    },
  },
]

export function createInitialBotState(
  preset: StrategyPreset = STRATEGY_PRESETS[1],
  options?: { initialBalance?: number; seedLog?: boolean },
): BotEngineState {
  const initialBalance =
    typeof options?.initialBalance === 'number' &&
    Number.isFinite(options.initialBalance) &&
    options.initialBalance >= 0
      ? options.initialBalance
      : preset.execution.initialBalance
  const seedLog = options?.seedLog !== false
  return {
    mode: 'paper',
    domain: preset.domain,
    pair: preset.strategy.pair,
    timeframe: preset.timeframe,
    balance: initialBalance,
    initialBalance,
    dayStartBalance: initialBalance,
    currentDayKey: null,
    dayHalted: false,
    lastProcessedCandleTime: null,
    openPosition: null,
    closedTrades: [],
    activeTickets: [],
    resolvedTickets: [],
    nextTicketId: 1,
    nextTradeId: 1,
    logs: seedLog
      ? [
          {
            id: 1,
            timestamp: new Date().toISOString(),
            level: 'info',
            message: `Engine initialized in ${preset.domain} mode (${preset.name}).`,
          },
        ]
      : [],
  }
}

/**
 * Ensures monotonic ticket/trade ID counters are initialized and remain strictly
 * above any IDs already present in persisted or trimmed history arrays.
 */
export function normalizeBotEngineState(state: BotEngineState): BotEngineState {
  let maxTradeId = 0
  for (const trade of state.closedTrades) {
    if (Number.isFinite(trade.id) && trade.id > maxTradeId) {
      maxTradeId = trade.id
    }
  }

  let maxTicketId = 0
  for (const ticket of state.activeTickets) {
    if (Number.isFinite(ticket.id) && ticket.id > maxTicketId) {
      maxTicketId = ticket.id
    }
  }
  for (const ticket of state.resolvedTickets) {
    if (Number.isFinite(ticket.id) && ticket.id > maxTicketId) {
      maxTicketId = ticket.id
    }
  }

  const nextTradeId = Math.max(
    Number.isFinite(state.nextTradeId) ? state.nextTradeId : 0,
    maxTradeId + 1,
    1,
  )
  const nextTicketId = Math.max(
    Number.isFinite(state.nextTicketId) ? state.nextTicketId : 0,
    maxTicketId + 1,
    1,
  )

  if (
    state.nextTradeId === nextTradeId &&
    state.nextTicketId === nextTicketId
  ) {
    return state
  }

  return {
    ...state,
    nextTradeId,
    nextTicketId,
  }
}

/**
 * Applies bounded sliding retention to live runtime history while preserving
 * monotonic ID counters so newly generated trades/tickets never collide.
 */
export function trimBotEngineHistory(
  state: BotEngineState,
  limits?: { maxClosedTrades?: number; maxResolvedTickets?: number },
): BotEngineState {
  const normalized = normalizeBotEngineState(state)
  const maxClosedTrades = Math.max(1, limits?.maxClosedTrades ?? 500)
  const maxResolvedTickets = Math.max(1, limits?.maxResolvedTickets ?? 500)

  const trimmedTrades =
    normalized.closedTrades.length > maxClosedTrades
      ? normalized.closedTrades.slice(0, maxClosedTrades)
      : normalized.closedTrades

  const trimmedTickets =
    normalized.resolvedTickets.length > maxResolvedTickets
      ? normalized.resolvedTickets.slice(0, maxResolvedTickets)
      : normalized.resolvedTickets

  if (
    trimmedTrades === normalized.closedTrades &&
    trimmedTickets === normalized.resolvedTickets
  ) {
    return normalized
  }

  return {
    ...normalized,
    closedTrades: trimmedTrades,
    resolvedTickets: trimmedTickets,
  }
}

function appendLog(
  logs: BotEngineLog[],
  level: BotEngineLog['level'],
  message: string,
  timeMs: number,
): BotEngineLog[] {
  const next: BotEngineLog = {
    id: (logs[0]?.id ?? 0) + 1,
    timestamp: new Date(timeMs).toISOString(),
    level,
    message,
  }
  return [next, ...logs].slice(0, MAX_LOGS)
}

function checkAndApplyBreakeven(
  pos: ActivePaperPosition,
  candle: Candle,
  strategy: Strategy,
  execution: BacktestSettings,
  filters?: SignalFilterConfig,
): ActivePaperPosition {
  if (!filters?.breakevenAtOneR || pos.breakevenArmed) return pos

  const tpDistance = pos.entryPrice * (strategy.takeProfit / 100)
  const triggerDistance = tpDistance * 0.50
  const roundTripCostPct =
    execution.commissionPct * 2 + execution.slippagePct * 2 + 0.04
  const profitLockOffset =
    pos.entryPrice * (roundTripCostPct / 100) + tpDistance * 0.22

  if (pos.side === 'buy' && candle.high >= pos.entryPrice + triggerDistance) {
    const newStop = roundMoney(pos.entryPrice + profitLockOffset)
    if (newStop > pos.stopPrice && newStop < candle.close) {
      return { ...pos, stopPrice: newStop, breakevenArmed: true }
    }
  } else if (
    pos.side === 'sell' &&
    candle.low <= pos.entryPrice - triggerDistance
  ) {
    const newStop = roundMoney(pos.entryPrice - profitLockOffset)
    if (newStop < pos.stopPrice && newStop > candle.close) {
      return { ...pos, stopPrice: newStop, breakevenArmed: true }
    }
  }

  return pos
}

function detectSpotSignalDetail(
  candles: Candle[],
  signalParams: SignalParams,
  filters?: SignalFilterConfig,
): { side: TradeSide; detail?: SpotEngineSignal } | null {
  const engine = filters?.signalEngine ?? 'crossover'
  const lastIdx = candles.length - 1
  if (lastIdx < 25) return null

  if (isNewSpotEngine(engine)) {
    const detail = evaluateNewSpotEngineAt(engine, candles, lastIdx, filters)
    return detail ? { side: detail.side, detail } : null
  }

  const side = detectSpotSignal(candles, signalParams, filters)
  return side ? { side } : null
}

/**
 * Evaluates a trading signal on the latest closed candle according to the configured engine:
 * - 'rsi-reversion': Mean reversion after RSI exhaustion with reversal or trend confirmation.
 * - 'momentum-structure': Pullbacks aligned with EMA 50 or rebounds after 3-candle exhaustion.
 * - 'crossover': Classic moving-average crossover (SMA/EMA).
 * - 'donchian-breakout' | 'support-resistance' | 'break-of-structure': Delegated to `src/spotEngines.ts`.
 */
function detectSpotSignal(
  candles: Candle[],
  signalParams: SignalParams,
  filters?: SignalFilterConfig,
): TradeSide | null {
  const engine = filters?.signalEngine ?? 'crossover'
  const lastIdx = candles.length - 1
  if (lastIdx < 25) return null

  if (isNewSpotEngine(engine)) {
    return evaluateNewSpotEngineAt(engine, candles, lastIdx, filters)?.side ?? null
  }

  const closes = candles.map((c) => c.close)
  const rsiSeries = rsi(closes, 14)
  const sma20Series = sma(closes, 20)
  const ema50Series = ema(closes, 50)

  const cur = candles[lastIdx]
  const prev = candles[lastIdx - 1]
  const prev2 = candles[lastIdx - 2]
  const curRsi = rsiSeries[lastIdx]
  const prevRsi = rsiSeries[lastIdx - 1]
  const curSma20 = sma20Series[lastIdx]
  const curEma50 = ema50Series[lastIdx]

  if (engine === 'rsi-reversion') {
    const oversold = filters?.oversoldRsi ?? 35
    const overbought = filters?.overboughtRsi ?? 65

    const bullishReversal =
      cur.close > cur.open &&
      cur.close > (prev.open + prev.close) / 2 &&
      ((prevRsi !== null && prevRsi < oversold) ||
        (curRsi !== null && curRsi < oversold) ||
        (prev.close < prev.open &&
          prev2.close < prev2.open &&
          curRsi !== null &&
          curRsi < 42 &&
          curEma50 !== null &&
          cur.close > curEma50 * 0.992))

    if (bullishReversal) return 'buy'

    const bearishReversal =
      cur.close < cur.open &&
      cur.close < (prev.open + prev.close) / 2 &&
      ((prevRsi !== null && prevRsi > overbought) ||
        (curRsi !== null && curRsi > overbought) ||
        (prev.close > prev.open &&
          prev2.close > prev2.open &&
          curRsi !== null &&
          curRsi > 58 &&
          curEma50 !== null &&
          cur.close < curEma50 * 1.008))

    if (bearishReversal) return 'sell'
    return null
  }

  if (engine === 'momentum-structure') {
    if (cur.close > cur.open) {
      const alignedLong =
        !filters?.requireEma50Alignment ||
        (curEma50 !== null && cur.close > curEma50)

      const inUptrendPullback =
        curEma50 !== null &&
        curSma20 !== null &&
        cur.close > curEma50 &&
        prev.close < prev.open &&
        cur.low <= curSma20 * 1.004 &&
        cur.close >= curSma20 &&
        curRsi !== null &&
        curRsi >= 44 &&
        curRsi <= (filters?.maxBuyRsi ?? 66)

      const threeRedExhaustion =
        alignedLong &&
        prev.close < prev.open &&
        prev2.close < prev2.open &&
        cur.close > prev.high &&
        curRsi !== null &&
        curRsi < 45

      if (inUptrendPullback || threeRedExhaustion) return 'buy'
    }

    if (cur.close < cur.open) {
      const alignedShort =
        !filters?.requireEma50Alignment ||
        (curEma50 !== null && cur.close < curEma50)

      const inDowntrendRally =
        curEma50 !== null &&
        curSma20 !== null &&
        cur.close < curEma50 &&
        prev.close > prev.open &&
        cur.high >= curSma20 * 0.996 &&
        cur.close <= curSma20 &&
        curRsi !== null &&
        curRsi <= 56 &&
        curRsi >= (filters?.minSellRsi ?? 34)

      const threeGreenExhaustion =
        alignedShort &&
        prev.close > prev.open &&
        prev2.close > prev2.open &&
        cur.close < prev.low &&
        curRsi !== null &&
        curRsi > 55

      if (inDowntrendRally || threeGreenExhaustion) return 'sell'
    }

    return null
  }

  // Default signal engine: 'crossover'
  const signals = crossoverSignals(candles, signalParams)
  const latest = signals.find((s) => s.index === lastIdx)
  if (!latest) return null

  if (filters?.avoidRsiExtremes && curRsi !== null) {
    const maxBuy = filters.maxBuyRsi ?? 70
    const minSell = filters.minSellRsi ?? 30
    if (latest.side === 'buy' && curRsi > maxBuy) return null
    if (latest.side === 'sell' && curRsi < minSell) return null
  }

  if (filters?.requireEma50Alignment && curEma50 !== null) {
    if (latest.side === 'buy' && cur.close < curEma50) return null
    if (latest.side === 'sell' && cur.close > curEma50) return null
  }

  return latest.side
}

export function stepBotEngine(
  state: BotEngineState,
  candles: Candle[],
  preset: StrategyPreset,
  options?: StepBotOptions,
): BotEngineState {
  if (candles.length < 55) return state

  const rawLastCandle = candles[candles.length - 1]
  const lastIsUnclosed =
    options?.nowMs !== undefined &&
    !isCandleClosed(rawLastCandle, preset.timeframe, options.nowMs)

  let workingState = normalizeBotEngineState(state)
  if (
    lastIsUnclosed &&
    preset.domain === 'crypto-spot' &&
    workingState.openPosition
  ) {
    const exit = resolveExit(
      {
        side: workingState.openPosition.side,
        stopPrice: workingState.openPosition.stopPrice,
        targetPrice: workingState.openPosition.targetPrice,
      },
      rawLastCandle,
    )
    if (exit) {
      workingState = closePaperPosition(
        workingState,
        exit.price,
        rawLastCandle.time,
        exit.reason,
        preset.strategy,
        preset.execution,
      )
    }
  }

  const confirmedCandles = lastIsUnclosed ? candles.slice(0, -1) : candles
  if (confirmedCandles.length < 55) return workingState

  const latestCandle = confirmedCandles[confirmedCandles.length - 1]
  if (
    workingState.lastProcessedCandleTime !== null &&
    latestCandle.time <= workingState.lastProcessedCandleTime
  ) {
    return workingState
  }

  let next: BotEngineState = {
    ...workingState,
    lastProcessedCandleTime: latestCandle.time,
  }

  const dayKey = Math.floor(latestCandle.time / DAY_MS)
  if (next.currentDayKey === null || dayKey !== next.currentDayKey) {
    next.currentDayKey = dayKey
    next.dayStartBalance = next.balance
    next.dayHalted = false
  }

  // ==================== BRANCH 1: PREDICTION MARKETS ====================
  if (preset.domain === 'prediction-market') {
    const ctx = buildMarketContext(confirmedCandles)
    const lastIdx = confirmedCandles.length - 1

    const stillActive: ActivePredictionTicket[] = []
    for (const ticket of next.activeTickets) {
      const elapsed = ticket.barsElapsed + 1
      if (elapsed >= ticket.horizonBars) {
        const rule = BITCOIN_20_PREDICTIONS.find((r) => r.id === ticket.ruleId)
        const entryIndex = lastIdx - elapsed
        const won =
          rule && entryIndex >= 0 ? rule.resolve(ctx, entryIndex) : false
        const payoutUsd = won
          ? roundMoney(ticket.stakeUsd / Math.max(0.05, ticket.fairPricePaid))
          : 0
        const netPnlUsd = roundMoney(payoutUsd - ticket.stakeUsd)
        const newBalance = Math.max(0, roundMoney(next.balance + payoutUsd))
        next.balance = newBalance

        const resolved: ResolvedPredictionTicket = {
          ...ticket,
          barsElapsed: elapsed,
          resolvedTime: latestCandle.time,
          won,
          payoutUsd,
          netPnlUsd,
        }
        next.resolvedTickets = [resolved, ...next.resolvedTickets]
        next.logs = appendLog(
          next.logs,
          'prediction',
          `Contract #${ticket.id} (${ticket.ruleId}) settled: ${won ? 'WON' : 'LOST'} (${netPnlUsd >= 0 ? '+' : ''}$${netPnlUsd.toFixed(2)})`,
          latestCandle.time,
        )
      } else {
        stillActive.push({ ...ticket, barsElapsed: elapsed })
      }
    }
    next.activeTickets = stillActive

    const targetRule = resolvePresetPredictionRule(preset)

    if (
      options?.allowNewEntries !== false &&
      targetRule &&
      !next.dayHalted &&
      next.balance > 0
    ) {
      const stats = evaluatePredictionRule(targetRule, confirmedCandles)
      const minEdge = preset.minEdgePct ?? 10
      const minTriggers = preset.minTriggers ?? 5
      const alreadyOpen = next.activeTickets.some(
        (t) => t.ruleId === targetRule.id,
      )

      if (
        stats.currentlyActive &&
        stats.triggers >= minTriggers &&
        stats.wilsonLowerBoundPct > 50 &&
        !alreadyOpen
      ) {
        const winProb = stats.winRatePct / 100
        const useBenchmarkPrice =
          options?.benchmarkFixedMidPrice !== undefined &&
          options?.requireExecutableQuote !== true

        let entryPrice: number | null = null
        let bid: number | undefined
        let ask: number | undefined
        let quoteAsOf: string | undefined
        let quoteSource: string | undefined
        let instrumentId: string | undefined
        let feePctOfStake = 0
        let effectivePct = preset.strategy.positionSize

        if (useBenchmarkPrice) {
          const benchPrice = Math.max(
            0.05,
            Math.min(0.95, options.benchmarkFixedMidPrice!),
          )
          const benchEdgePct = (winProb - benchPrice) * 100
          if (benchEdgePct >= minEdge) {
            entryPrice = benchPrice
            quoteSource = 'benchmark-fixed-50c'
            quoteAsOf = new Date(latestCandle.time).toISOString()
            effectivePct =
              preset.useQuarterKelly && stats.quarterKellyPct > 0
                ? Math.min(preset.strategy.positionSize, stats.quarterKellyPct)
                : preset.strategy.positionSize
          }
        } else {
          const nowMs = options?.nowMs ?? Date.now()
          const quoteCheck = validateExecutableQuote(
            options?.predictionQuote,
            nowMs,
            { maxAgeMs: options?.quoteMaxAgeMs },
          )
          if (!quoteCheck.ok) {
            next.logs = appendLog(
              next.logs,
              'risk',
              `[QUOTE GUARD] Skipped ${targetRule.id}: ${quoteCheck.reason}`,
              latestCandle.time,
            )
          } else if (quoteCheck.quote.outcome !== targetRule.predictedOutcome) {
            next.logs = appendLog(
              next.logs,
              'risk',
              `[QUOTE GUARD] Skipped ${targetRule.id}: quote outcome (${quoteCheck.quote.outcome}) does not match rule (${targetRule.predictedOutcome}).`,
              latestCandle.time,
            )
          } else {
            const netEdgePct = (winProb - quoteCheck.effectiveAsk) * 100
            if (netEdgePct < minEdge) {
              next.logs = appendLog(
                next.logs,
                'risk',
                `[QUOTE GUARD] Skipped ${targetRule.id}: net edge ${netEdgePct.toFixed(1)}% at ${(quoteCheck.effectiveAsk * 100).toFixed(1)}c < ${minEdge}% min.`,
                latestCandle.time,
              )
            } else {
              entryPrice = quoteCheck.effectiveAsk
              bid = quoteCheck.quote.bid
              ask = quoteCheck.quote.ask
              quoteAsOf = new Date(quoteCheck.quote.asOfMs).toISOString()
              quoteSource = quoteCheck.quote.source
              instrumentId = quoteCheck.quote.instrumentId
              feePctOfStake = quoteCheck.feePctOfStake
              const kellyAtAskPct =
                binaryKellyFraction(winProb, quoteCheck.effectiveAsk) * 25
              effectivePct = preset.useQuarterKelly
                ? Math.min(preset.strategy.positionSize, Math.max(0, kellyAtAskPct))
                : preset.strategy.positionSize
            }
          }
        }

        if (entryPrice !== null && effectivePct > 0) {
          // Per-ticket liquidity cap (max 25% of initial capital per binary contract)
          const maxTicketCap = next.initialBalance * 0.25
          const stakeUsd = roundMoney(
            Math.min(maxTicketCap, next.balance * (effectivePct / 100)),
          )
          if (stakeUsd > 0 && stakeUsd <= next.balance) {
            next.balance = roundMoney(next.balance - stakeUsd)
            const ticketId = next.nextTicketId
            next.nextTicketId = ticketId + 1
            const feeUsd = roundMoney(stakeUsd * (feePctOfStake / 100))

            const ticket: ActivePredictionTicket = {
              id: ticketId,
              ruleId: targetRule.id,
              title: targetRule.title,
              timeframe: targetRule.timeframe,
              outcome: targetRule.predictedOutcome,
              entryBarTime: latestCandle.time,
              entryReferencePrice: latestCandle.close,
              stakeUsd,
              fairPricePaid: entryPrice,
              bid,
              ask,
              quoteAsOf,
              quoteSource,
              instrumentId,
              feeUsd,
              horizonBars: targetRule.horizonBars,
              barsElapsed: 0,
            }
            next.activeTickets = [...next.activeTickets, ticket]
            next.logs = appendLog(
              next.logs,
              'prediction',
              `Opened ${ticket.outcome} binary contract: "${targetRule.title}" · Stake $${stakeUsd.toFixed(2)} @ ${(entryPrice * 100).toFixed(1)}c (${quoteSource}, WR ${stats.winRatePct.toFixed(1)}%, Wilson95% ${stats.wilsonLowerBoundPct.toFixed(1)}%)`,
              latestCandle.time,
            )
          }
        }
      }
    }

    return next
  }

  // ==================== BRANCH 2: CRYPTO SPOT / PERPS ====================
  const { strategy, signalParams, execution, filters } = preset

  if (next.openPosition) {
    const pos = next.openPosition
    const exit = resolveExit(
      {
        side: pos.side,
        stopPrice: pos.stopPrice,
        targetPrice: pos.targetPrice,
      },
      latestCandle,
    )

    if (exit) {
      next = closePaperPosition(
        next,
        exit.price,
        latestCandle.time,
        exit.reason,
        strategy,
        execution,
      )
    } else if (
      filters?.signalEngine === 'donchian-breakout' &&
      evaluateDonchianExit(
        confirmedCandles,
        confirmedCandles.length - 1,
        pos.side,
        filters,
      )
    ) {
      next = closePaperPosition(
        next,
        latestCandle.close,
        latestCandle.time,
        'signal',
        strategy,
        execution,
      )
    } else {
      next.openPosition = checkAndApplyBreakeven(
        pos,
        latestCandle,
        strategy,
        execution,
        filters,
      )
    }
  }

  const detected = detectSpotSignalDetail(confirmedCandles, signalParams, filters)
  const signalSide = detected?.side ?? null

  if (signalSide) {
    const shouldFlip = filters?.flipOnOppositeSignal ?? true
    if (
      next.openPosition &&
      next.openPosition.side !== signalSide &&
      shouldFlip
    ) {
      next = closePaperPosition(
        next,
        latestCandle.close,
        latestCandle.time,
        'signal',
        strategy,
        execution,
      )
    }

    if (
      options?.allowNewEntries !== false &&
      !next.openPosition &&
      !next.dayHalted &&
      next.balance > 0
    ) {
      if (signalSide === 'sell' && !execution.allowShort) {
        next.logs = appendLog(
          next.logs,
          'info',
          `SELL signal ignored (allowShort = false).`,
          latestCandle.time,
        )
      } else {
        const entryPrice = fillPrice(
          latestCandle.close,
          signalSide,
          execution.slippagePct,
        )
        const notional = roundMoney(
          Math.min(
            next.balance,
            next.balance * (strategy.positionSize / 100),
          ),
        )
        const quantity = notional / entryPrice
        const direction = directionOf(signalSide)
        const entryFee = roundMoney(notional * (execution.commissionPct / 100))

        const defaultStopPrice = roundMoney(
          entryPrice * (1 - direction * (strategy.stopLoss / 100)),
        )
        const defaultTargetPrice = roundMoney(
          entryPrice * (1 + direction * (strategy.takeProfit / 100)),
        )

        const detailStop = detected?.detail?.stopPrice
        const hasValidDetailStop =
          typeof detailStop === 'number' &&
          Number.isFinite(detailStop) &&
          detailStop > 0 &&
          (signalSide === 'buy'
            ? detailStop < entryPrice
            : detailStop > entryPrice)
        const initialStopPrice = hasValidDetailStop
          ? roundMoney(detailStop)
          : defaultStopPrice

        const detailTarget = detected?.detail?.targetPrice
        const hasValidDetailTarget =
          typeof detailTarget === 'number' &&
          Number.isFinite(detailTarget) &&
          detailTarget > 0 &&
          (signalSide === 'buy'
            ? detailTarget > entryPrice
            : detailTarget < entryPrice)

        let targetPrice = hasValidDetailTarget
          ? roundMoney(detailTarget)
          : defaultTargetPrice

        // Break of Structure spec: target is 2R capped by the preset TP
        if (
          filters?.signalEngine === 'break-of-structure' &&
          hasValidDetailTarget
        ) {
          targetPrice =
            signalSide === 'buy'
              ? Math.min(targetPrice, defaultTargetPrice)
              : Math.max(targetPrice, defaultTargetPrice)
        }

        next.openPosition = {
          side: signalSide,
          pair: strategy.pair,
          entryPrice: roundMoney(entryPrice),
          entryTime: latestCandle.time,
          quantity,
          notional,
          entryFee,
          stopPrice: initialStopPrice,
          initialStopPrice,
          targetPrice,
          breakevenArmed: false,
          presetId: preset.id,
          presetName: preset.name,
        }

        next.logs = appendLog(
          next.logs,
          'signal',
          `Opened ${signalSide.toUpperCase()} position on ${strategy.pair} at $${next.openPosition.entryPrice} (SL $${next.openPosition.stopPrice} / TP $${next.openPosition.targetPrice}).`,
          latestCandle.time,
        )
      }
    }
  }

  return next
}

export function closePaperPositionAtPrice(
  state: BotEngineState,
  rawExitPrice: number,
  timeMs: number,
  reason: ExitReason,
  preset: StrategyPreset,
): { state: BotEngineState; closedTrade: BacktestTrade | null } {
  const normalized = normalizeBotEngineState(state)
  if (!normalized.openPosition) {
    return { state: normalized, closedTrade: null }
  }
  const next = closePaperPosition(
    normalized,
    rawExitPrice,
    timeMs,
    reason,
    preset.strategy,
    preset.execution,
  )
  return {
    state: next,
    closedTrade: next.closedTrades[0] ?? null,
  }
}

function closePaperPosition(
  state: BotEngineState,
  rawExitPrice: number,
  timeMs: number,
  reason: ExitReason,
  strategy: Strategy,
  execution: BacktestSettings,
): BotEngineState {
  const pos = state.openPosition
  if (!pos) return state

  const closeSide: TradeSide = pos.side === 'buy' ? 'sell' : 'buy'
  const exitPrice = fillPrice(rawExitPrice, closeSide, execution.slippagePct)
  const exitNotional = exitPrice * pos.quantity
  const exitFee = exitNotional * (execution.commissionPct / 100)
  const rawGross =
    (exitPrice - pos.entryPrice) * pos.quantity * directionOf(pos.side)

  const fees = roundMoney(pos.entryFee + exitFee)
  const pnl = roundMoney(rawGross - fees)
  const balance = Math.max(0, roundMoney(state.balance + pnl))

  const tradeId = state.nextTradeId
  const trade: BacktestTrade = {
    id: tradeId,
    time: new Date(timeMs).toISOString(),
    pair: pos.pair,
    side: pos.side,
    entryPrice: pos.entryPrice,
    exitPrice: roundMoney(exitPrice),
    size: pos.notional,
    pnl,
    grossPnl: roundMoney(rawGross),
    fees,
    entryTime: pos.entryTime,
    exitTime: timeMs,
    exitReason: reason,
    balanceAfter: balance,
    ...(pos.presetId ? { presetId: pos.presetId } : {}),
    ...(pos.presetName ? { presetName: pos.presetName } : {}),
    ...(pos.initialStopPrice !== undefined
      ? { initialStopPrice: pos.initialStopPrice }
      : {}),
  }

  let dayHalted = state.dayHalted
  let logs = appendLog(
    state.logs,
    'trade',
    `Closed ${pos.side.toUpperCase()} position via ${reason.toUpperCase()} at $${trade.exitPrice} · PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
    timeMs,
  )

  if (state.dayStartBalance > 0) {
    const dailyLossPct =
      ((state.dayStartBalance - balance) / state.dayStartBalance) * 100
    if (dailyLossPct >= strategy.maxDailyRisk) {
      dayHalted = true
      logs = appendLog(
        logs,
        'risk',
        `Circuit Breaker triggered: daily loss (${dailyLossPct.toFixed(2)}%) reached the ${strategy.maxDailyRisk}% limit.`,
        timeMs,
      )
    }
  }

  return {
    ...state,
    balance,
    dayHalted,
    openPosition: null,
    closedTrades: [trade, ...state.closedTrades],
    nextTradeId: tradeId + 1,
    logs,
  }
}

export function evaluateBotPresetAccuracy(
  candles: Candle[],
  preset: StrategyPreset,
): BotPresetAccuracyReport {
  let state = createInitialBotState(preset)
  let peakEquity = state.initialBalance
  let maxDrawdownPct = 0

  for (let end = 55; end <= candles.length; end++) {
    state = stepBotEngine(
      state,
      candles.slice(0, end),
      preset,
      preset.domain === 'prediction-market'
        ? { benchmarkFixedMidPrice: 0.5 }
        : undefined,
    )
    const lockedInTickets = state.activeTickets.reduce(
      (sum, t) => sum + t.stakeUsd,
      0,
    )
    const currentEquity = state.balance + lockedInTickets
    if (currentEquity > peakEquity) {
      peakEquity = currentEquity
    }
    if (peakEquity > 0) {
      const ddPct = ((peakEquity - currentEquity) / peakEquity) * 100
      if (ddPct > maxDrawdownPct) {
        maxDrawdownPct = ddPct
      }
    }
  }

  if (preset.domain === 'prediction-market') {
    const total = state.resolvedTickets.length
    const wins = state.resolvedTickets.filter((t) => t.won).length
    const losses = total - wins
    const grossWin = state.resolvedTickets
      .filter((t) => t.netPnlUsd > 0)
      .reduce((acc, t) => acc + t.netPnlUsd, 0)
    const grossLoss = Math.abs(
      state.resolvedTickets
        .filter((t) => t.netPnlUsd < 0)
        .reduce((acc, t) => acc + t.netPnlUsd, 0),
    )
    const lockedInTickets = state.activeTickets.reduce(
      (sum, t) => sum + t.stakeUsd,
      0,
    )
    const effectiveBalance = roundMoney(state.balance + lockedInTickets)
    const netPnlUsd = roundMoney(effectiveBalance - state.initialBalance)
    const returnPct =
      Math.round((netPnlUsd / state.initialBalance) * 10000) / 100
    const winRatePct = total > 0 ? Math.round((wins / total) * 1000) / 10 : 0

    return {
      presetId: preset.id,
      name: preset.name,
      domain: preset.domain,
      timeframe: preset.timeframe,
      totalOperations: total,
      wins,
      losses,
      winRatePct,
      wilsonLowerBoundPct: computeWilsonLowerBoundPct(wins, total),
      netPnlUsd,
      returnPct,
      profitFactor:
        grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : null,
      maxDrawdownPct: Math.round(maxDrawdownPct * 100) / 100,
    }
  }

  const total = state.closedTrades.length
  const wins = state.closedTrades.filter((t) => (t.pnl ?? 0) > 0).length
  const losses = state.closedTrades.filter((t) => (t.pnl ?? 0) < 0).length
  const grossWin = state.closedTrades
    .filter((t) => (t.pnl ?? 0) > 0)
    .reduce((acc, t) => acc + (t.pnl ?? 0), 0)
  const grossLoss = Math.abs(
    state.closedTrades
      .filter((t) => (t.pnl ?? 0) < 0)
      .reduce((acc, t) => acc + (t.pnl ?? 0), 0),
  )
  const netPnlUsd = roundMoney(state.balance - state.initialBalance)
  const returnPct =
    Math.round((netPnlUsd / state.initialBalance) * 10000) / 100
  const winRatePct = total > 0 ? Math.round((wins / total) * 1000) / 10 : 0

  return {
    presetId: preset.id,
    name: preset.name,
    domain: preset.domain,
    timeframe: preset.timeframe,
    totalOperations: total,
    wins,
    losses,
    winRatePct,
    wilsonLowerBoundPct: computeWilsonLowerBoundPct(wins, total),
    netPnlUsd,
    returnPct,
    profitFactor:
      grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : null,
    maxDrawdownPct: Math.round(maxDrawdownPct * 100) / 100,
  }
}
