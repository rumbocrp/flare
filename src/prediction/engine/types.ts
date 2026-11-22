/**
 * Core type contracts for the pure-TypeScript 8-strategy Polymarket BTC Up/Down
 * prediction engine (`5m`, `15m`, `1h`), safety gates, promotion, and canary risk.
 *
 * Browser-and-server-safe (zero Node-only or `src/server/*` imports).
 */
import type { LiquidityRole } from '../../predictionMarket'
import type { NowcastEstimate } from '../nowcast'

export type EngineTimeframe = '5m' | '15m' | '1h'

export type EngineResolutionSource =
  | 'chainlink-twap-60s'
  | 'binance-1h-candle'
  | 'unknown'

export const PREDICTION_ENGINE_STRATEGY_IDS = [
  'c5-late-favorite',
  'c5-nowcast-maker',
  'c15-favorite-carry',
  'c15-late-favorite-guarded',
  'c1h-late-nowcast',
  'c1h-exhaustion-limit',
  'cx-nested-coherence',
  'c5-15-longshot-fade',
] as const

export type PredictionEngineStrategyId =
  (typeof PREDICTION_ENGINE_STRATEGY_IDS)[number]

export type StrategyLane = 'high-hit-rate' | 'edge'

export type StrategyLifecycleMode =
  | 'disabled'
  | 'research'
  | 'paper'
  | 'canary'
  | 'scale'

/** Structural twin of `OracleSnapshot` (`src/server/prediction/oracleFeed.ts`). */
export type EngineOracleSnapshot = {
  nowMs: number
  chainlinkPrice: number | null
  chainlinkTwap60s: number | null
  chainlinkUpdatedAtMs: number | null
  chainlinkStaleMs: number
  binancePrice: number | null
  binanceUpdatedAtMs: number | null
  binanceStaleMs: number
  basisBps: number | null
  sigma1m: number | null
  median24hSigma1m: number | null
  connectedRtds: boolean
  connectedBinance: boolean
}

/** Structural twin of `ClobBookSideSnapshot` (`src/server/prediction/clobBookFeed.ts`). */
export type EngineBookSideSnapshot = {
  tokenId: string
  bestBid: number | null
  bestAsk: number | null
  mid: number | null
  spread: number | null
  bidDepthUsd: number
  askDepthUsd: number
  top5DepthUsd: number
  asOfMs: number
  source: 'clob-ws' | 'clob-rest'
}

/** Structural twin of `WindowOrderBookSnapshot` (`src/server/prediction/clobBookFeed.ts`). */
export type EngineOrderBookSnapshot = {
  slug: string
  upTokenId: string
  downTokenId: string
  yes: EngineBookSideSnapshot | null
  no: EngineBookSideSnapshot | null
  minTop5DepthUsd: number
  capturedAtMs: number
}

export type MacroBlackoutWindow = {
  timestampMs: number
  label?: string
  /** Half-window before event timestamp in ms (defaults to 30 * 60_000). */
  beforeMs?: number
  /** Half-window after event timestamp in ms (defaults to 30 * 60_000). */
  afterMs?: number
}

export type HourlyExhaustionIndicators = {
  consecutiveRedHours: number
  rsi14: number | null
}

export type NestedParentContext = {
  slug: string
  timeframe: EngineTimeframe
  resolutionSource: EngineResolutionSource
  openTwap: number
  secondsRemaining: number
  secondsElapsed?: number
  book?: EngineOrderBookSnapshot
  marketMidYes?: number | null
}

export type StrategyContext = {
  slug: string
  timeframe: EngineTimeframe
  resolutionSource: EngineResolutionSource
  startTimeMs: number
  endTimeMs: number
  openTwap: number | null
  secondsRemaining: number
  secondsElapsed: number
  oracle: EngineOracleSnapshot
  book: EngineOrderBookSnapshot
  nowcast: NowcastEstimate
  calibratedPYes?: number | null
  hourlyIndicators?: HourlyExhaustionIndicators
  nestedParent?: NestedParentContext
  macroBlackoutWindows: readonly MacroBlackoutWindow[]
  nowMs: number
  stakeUsd?: number
  candidateRuleId?: string
}

export type StrategyIntent = {
  strategyId: PredictionEngineStrategyId
  lane: StrategyLane
  slug: string
  timeframe: EngineTimeframe
  outcome: 'YES' | 'NO'
  side: 'BUY' | 'SELL'
  liquidityRole: LiquidityRole
  orderType: 'FOK' | 'GTC'
  limitPrice: number
  stakeUsd: number
  pModel: number
  expectedEdgePerShare: number
  cancelAtSecondsRemaining?: number
  reason: string
}

export type StrategyDefinition = {
  id: PredictionEngineStrategyId
  name: string
  lane: StrategyLane
  timeframes: readonly EngineTimeframe[]
  defaultMode: StrategyLifecycleMode
  defaultRole: LiquidityRole
  description: string
  evaluate: (ctx: StrategyContext) => StrategyIntent[]
}

export type GateFailureCode =
  | 'AVOID_EXCLUDED_RULE'
  | 'AVOID_FIRST_60S'
  | 'G1_MACRO_BLACKOUT'
  | 'G1_MISSING_VOLATILITY'
  | 'G1_VOLATILITY_SPIKE'
  | 'G1_LOW_DEPTH'
  | 'G1_EXCESSIVE_SPREAD'
  | 'G1_STALE_BOOK'
  | 'G2_UNKNOWN_RESOLUTION_SOURCE'
  | 'G2_STALE_ORACLE'
  | 'G2_MISSING_BASIS'
  | 'G2_BASIS_DIVERGENCE'

export type SafetyGateConfig = {
  macroHalfWindowMs: number
  maxVolatilityMultiplier: number
  minTop5DepthUsd: number
  maxSpread: number
  maxBookAgeMs: number
  maxFutureSkewMs: number
  maxOracleStaleMs: number
  maxBasisBps: number
  first60sBlockSec: number
}

export type SafetyGateResult = {
  allowed: boolean
  avoidPassed: boolean
  g1Passed: boolean
  g2Passed: boolean
  codes: GateFailureCode[]
  reasons: string[]
}

export type CanaryRiskConfig = {
  stakeUsd: number
  maxDailyLosses: 3 | 4
  maxDailyLossUsd: number
  maxConcurrentBtcExposureUsd: number
}

export type CanaryOpenPosition = {
  slug: string
  timeframe: EngineTimeframe
  stakeUsd: number
  asset?: string
}

export type CanaryBudgetDecision = {
  allowed: boolean
  approvedStakeUsd: number
  openBtcExposureUsd: number
  remainingBtcExposureUsd: number
  todayLossesCount: number
  todayLossUsd: number
  reasons: string[]
}

export type PromotionAuditDetails = {
  action: 'prediction.strategy.promote' | 'prediction.strategy.mode_change'
  forcedOverride: boolean
  overrideReason?: string
  settledWindowCount: number
  wilsonLowerBoundPct: number
  avgBreakEvenPct: number
  netPnlUsd: number
  meanMarkout30s: number
}

export type PromotionTransitionResult = {
  allowed: boolean
  fromMode: StrategyLifecycleMode
  toMode: StrategyLifecycleMode
  forcedOverride: boolean
  requiresAudit: boolean
  failures: string[]
  auditDetails?: PromotionAuditDetails
}
