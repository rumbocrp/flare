import type { BacktestTrade } from '../backtest'
import type { StrategyPreset } from '../botEngine'
import type {
  FeatureImportanceEntry,
  HardVetoRule,
  PerformanceSummary,
} from '../prediction/mlMetaFilter'
import type { SimulationResult } from '../predictionMarket'
import type { Candle, Interval } from '../types'

type RuleCalibration = SimulationResult['calibration'][number]
type SimulationMetrics = SimulationResult['metrics']
type MonteCarloSummary = NonNullable<SimulationResult['monteCarlo']>

export type StrategyFamily =
  | 'trend-momentum'
  | 'mean-reversion'
  | 'support-resistance'
  | 'break-of-structure'
  | 'donchian-breakout'
  | 'prediction-market'

export type CatalogItemKind =
  | 'catalog-preset'
  | 'engine-template'
  | 'custom-profile'

export type TrainingCatalogItem = {
  id: string
  presetId: string
  family: StrategyFamily
  kind: CatalogItemKind
  runnable: boolean
  promotableAsCatalog: boolean
  savedAt?: string
  preset: StrategyPreset
}

export type TrainingRunKind =
  | 'walk-forward'
  | 'meta-filter'
  | 'prediction-market'

export type TrainingRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type TrainingProgressPhase =
  | 'preparing'
  | 'fitting'
  | 'validating'
  | 'testing'
  | 'finalizing'

export type TrainingProgress = {
  phase: TrainingProgressPhase
  foldIndex: number
  foldCount: number
  barIndex: number
  barCount: number
}

export type TrainingVerdict =
  | 'eligible'
  | 'insufficient'
  | 'below-threshold'
  | 'override'

export type TrainingAssumptions = {
  commissionPct: number
  slippagePct: number
  initialBalance: number
  allowShort: boolean
}

export type TrainingFoldResult = {
  foldIndex: number
  trainFromMs: number
  trainToMs: number
  valFromMs: number
  valToMs: number
  testFromMs: number
  testToMs: number
  trainBars: number
  valBars: number
  testBars: number
  selectedParams: Record<string, string | number | boolean>
  valTrades: number
  valProfitFactor: number | null
  valMaxDrawdownPct: number
  testTrades: number
  testWins: number
  testWinRatePct: number | null
  testProfitFactor: number | null
  testMaxDrawdownPct: number
  testNetPnlUsd: number
}

export type TrainingCandidateResult = {
  candidateIndex: number
  params: Record<string, string | number | boolean>
  valTrades: number
  valWinRatePct: number | null
  valProfitFactor: number | null
  valMaxDrawdownPct: number
  valNetPnlUsd: number
  selected: boolean
}

export type TrainingParamDiff = {
  param: string
  defaultValue: string | number | boolean
  selectedValue: string | number | boolean
}

export type MetaFilterRunSummary = {
  totalSamples: number
  trainSamples: number
  valSamples: number
  testSamples: number
  purgeGapUsed: number
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
  hardVetoRules: HardVetoRule[]
  featureImportanceRanking: FeatureImportanceEntry[]
}

export type PredictionMarketRunSummary = {
  priceSource: 'real' | 'modeled'
  trainFromTime: number
  testFromTime: number
  testToTime: number
  calibration: RuleCalibration[]
  simulationMetrics: SimulationMetrics
  monteCarlo: MonteCarloSummary | null
}

export type TrainingRunMetrics = {
  totalTrades: number
  wins: number
  losses: number
  winRate: number | null
  wilsonLowerBoundPct: number | null
  profitFactor: number | null
  maxDrawdown: number
  maxDrawdownPct: number
  netPnl: number
  returnPct: number
  expectancy: number | null
  averageR: number | null
  feesPaid: number
  verdict: TrainingVerdict
  verdictReason: string
  overrideReason?: string | null
  candidatesEvaluated?: number
  bestSelectedParams?: Record<string, string | number | boolean>
  paramDiffs?: TrainingParamDiff[]
  candidates?: TrainingCandidateResult[]
  metaComparison?: MetaFilterRunSummary | null
  predictionSummary?: PredictionMarketRunSummary | null
}

export type TrainingEquityPoint = {
  time: number
  equity: number
  drawdownPct: number
  baselineEquity?: number
}

export type TrainingTradeRecord = BacktestTrade & {
  foldIndex?: number
  rMultiple?: number | null
}

export type TrainingConfig = {
  kind: TrainingRunKind
  presetId: string
  pair: string
  timeframe: Interval
  fromTimeMs: number
  toTimeMs: number
  foldCount: number
  foldMode: 'anchored' | 'rolling'
  trainRatio: number
  valRatio: number
  testRatio: number
  purgeGapBars: number
  assumptions: TrainingAssumptions
  isResearchVariant?: boolean
}

export type TrainingRunOutput = {
  metrics: TrainingRunMetrics
  folds: TrainingFoldResult[]
  equity: TrainingEquityPoint[]
  trades: TrainingTradeRecord[]
  selectedPreset: StrategyPreset
}

export type TrainingRunRecord = {
  id: string
  tenantId: string
  clientRunId: string
  kind: TrainingRunKind
  presetId: string
  strategyFamily: StrategyFamily
  pair: string
  timeframe: Interval
  fromTimeMs: number
  toTimeMs: number
  candleCount: number
  status: TrainingRunStatus
  config: TrainingConfig
  progress: TrainingProgress | null
  metrics: TrainingRunMetrics | null
  folds: TrainingFoldResult[] | null
  equity: TrainingEquityPoint[] | null
  trades: TrainingTradeRecord[] | null
  assumptions: TrainingAssumptions
  dataSource: string
  error: string | null
  createdAt: string
  completedAt: string | null
}

export type HistoricalCandlesMissingSpan = {
  fromTimeMs: number
  toTimeMs: number
  reason: string
}

export type HistoricalCandlesResponse = {
  pair: string
  interval: Interval
  fromTimeMs: number
  toTimeMs: number
  candles: Candle[]
  complete: boolean
  missingSpans: HistoricalCandlesMissingSpan[]
  source: 'candles-archive' | 'binance' | 'binance+archive'
  fetchedBars: number
  cachedBars: number
}

export type TrainingLiveShadowResponse = {
  presetId: string
  fromTimeMs: number | null
  toTimeMs: number | null
  paper: {
    trades: BacktestTrade[]
    count: number
    wins: number
    losses: number
    winRatePct: number | null
    wilsonLowerBoundPct: number | null
    profitFactor: number | null
    netPnlUsd: number
    averageR: number | null
    totalFeesUsd: number
  }
  testnet: {
    orderCount: number
    filledOrderCount: number
    totalNotionalUsd: number
    totalFeesUsd: number
    pnlAttributionAvailable: false
    note: string
    orders: {
      id: string
      timestamp: string
      pair: string
      side: 'BUY' | 'SELL'
      notionalUsd: number
      filledQty: number | null
      avgPrice: number | null
      fee: number | null
      feeAsset: string | null
      status: string
      venueOrderId: string | null
    }[]
  }
  mt5: {
    executionState: string
    signalOnly: true
    note: string
    pollCount: number
    lastPollAt: string | null
  }
}
