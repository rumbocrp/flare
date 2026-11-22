/**
 * Continuous 1,500ms intra-window execution runner (`src/server/prediction/predictionRunner.ts`)
 * driving the 8-strategy Polymarket BTC Up/Down portfolio (`5m`, `15m`, `1h`) across:
 *   Backtest -> Paper (shadow CLOB fills) -> Canary ($5/trade, 3-4 losses, $15 BTC cap) -> Scale
 *
 * Responsibilities per tick:
 * 1. Hydrate strategy states, open/settled trades, UTC daily loss counters, and kill-switch on startup.
 * 2. Drive `PredictionWindowCollector.runPollCycle(nowMs)` & supplement open TWAP / CLOB hydration.
 * 3. Refresh closed `1h` BTC candles (`consecutiveRedHours`, `rsi14`), resilient to REST outages.
 * 4. Fit & cache out-of-sample PAV `CalibrationCurve` per timeframe every 25 settled windows.
 * 5. Cross pending resting paper quotes & capture `+30s` markouts on `OPEN` trades.
 * 6. Sweep resting GTC maker orders when `cancelAtSecondsRemaining` elapses (`T-20s`/`T-90s`/`T-30s`/`T+10m`).
 * 7. Settle closed windows (`resolvedUp !== null`), post balanced ledger entries (live only), and check auto kill-switches.
 * 8. Evaluate active strategies with `G1`/`G2` gates, `avoid` exclusions, promotion gates, and canary risk budget.
 */
import { rsi } from '../../indicators'
import {
  POLYMARKET_FEES,
  polymarketFeePerShare,
  type LiquidityRole,
} from '../../predictionMarket'
import {
  applyCalibrator,
  fitIsotonicCalibrator,
  type CalibrationCurve,
  type CalibrationSample,
} from '../../prediction/calibration'
import { evaluateSafetyGates } from '../../prediction/engine/gates'
import {
  checkCanaryRiskBudget,
  evaluatePromotionTransition,
  normalizeCanaryRiskConfig,
} from '../../prediction/engine/promotion'
import {
  STRATEGY_REGISTRY,
  getStrategyDefinition,
} from '../../prediction/engine/strategies'
import type {
  CanaryOpenPosition,
  CanaryRiskConfig,
  EngineOrderBookSnapshot,
  EngineTimeframe,
  GateFailureCode,
  HourlyExhaustionIndicators,
  MacroBlackoutWindow,
  NestedParentContext,
  PredictionEngineStrategyId,
  PromotionTransitionResult,
  SafetyGateConfig,
  SafetyGateResult,
  StrategyContext,
  StrategyIntent,
  StrategyLifecycleMode,
} from '../../prediction/engine/types'
import { computeNowcast } from '../../prediction/nowcast'
import {
  runWindowReplay,
  type CollectedWindowReplayInput,
  type PromotionReport,
  type ReplayIntent,
  type ReplaySnapshotPoint,
} from '../../prediction/replayHarness'
import type { Candle } from '../../types'
import {
  appendTenantLedgerEntry,
  getExchangeStatusSnapshot,
  registerKillSwitchHandler,
} from '../exchangeAdapter'
import { buildPredictionSettlementEntry } from '../ledger/doubleEntryLedger'
import { getMarketGateway } from '../marketData/marketGateway'
import type {
  PolymarketWindow,
  ResolutionSource,
} from '../polymarketAdapter'
import {
  cancelAllPolymarketOrders,
  cancelOrdersForWindow,
  getPolymarketExecutorStatus,
  submitPolymarketMakerQuote,
  submitPolymarketOrder,
  syncPolymarketOrderStatuses,
  type CancelOrdersForWindowResult,
  type PolymarketOrderRecord,
} from '../polymarketExecutor'
import { getStateStore } from '../store'
import type {
  CollectedWindowRecord,
  StateStore,
  StoredPredictionTrade,
  StoredStrategyState,
  WindowSnapshotPoint,
} from '../store/types'
import {
  ClobBookFeedService,
  DEFAULT_BOOK_STALE_MS,
  getClobBookFeed,
  isBookSideStale,
  toExecutableQuote,
} from './clobBookFeed'
import {
  OracleFeedService,
  getOracleFeed,
  type OracleSnapshot,
} from './oracleFeed'
import {
  PredictionWindowCollector,
  type CollectorStats,
} from './windowCollector'

const DEFAULT_TENANT_ID = 'default'
const DEFAULT_TICK_INTERVAL_MS = 1_500
const DEFAULT_RECALIBRATE_EVERY_SETTLED = 25
const DEFAULT_HOURLY_CANDLE_REFRESH_MS = 15_000
const DEFAULT_BOOK_HYDRATE_COOLDOWN_MS = 2_000
const DEFAULT_OPEN_TWAP_MAX_AGE_MS = 15_000
const ONE_HOUR_MS = 3_600_000
const ONE_DAY_MS = 86_400_000
const HIGH_ERROR_THRESHOLD = 0.15
const CONSECUTIVE_HIGH_ERROR_LIMIT = 5
const MARKOUT_WINDOW_TRADES = 30
const MARKOUT_HALT_THRESHOLD = -0.04
const MIN_CALIBRATION_SAMPLES = 30
const TARGET_PROMOTION_SAMPLES = 500

export type PredictionCalibratorSummary = {
  mode: 'pav' | 'identity'
  sampleCount: number
  lastSettledCount: number
}

export type PredictionGateTelemetry = {
  g1Passed: boolean
  g2Passed: boolean
  avoidPassed: boolean
  failureCodes: GateFailureCode[]
  reasons: string[]
  byTimeframe: Record<EngineTimeframe, SafetyGateResult | null>
}

export type PredictionStrategyLiveStats = {
  openCount: number
  settledCount: number
  canceledCount: number
  wins: number
  winRatePct: number
  netPnlUsd: number
  meanMarkout30s: number | null
  markoutSampleCount: number
  consecutiveHighErrorCount: number
}

export type PredictionStrategyStatusView = {
  id: PredictionEngineStrategyId
  name: string
  lane: 'high-hit-rate' | 'edge'
  timeframes: readonly EngineTimeframe[]
  description: string
  defaultRole: LiquidityRole
  defaultMode: StrategyLifecycleMode
  mode: StrategyLifecycleMode
  haltedReason: string | null
  updatedAt: number | null
  settledSamplesForTimeframe: number
  targetSamples: number
  forcedOverride: boolean
  liveStats: PredictionStrategyLiveStats
  latestReplay: PromotionReport | null
}

export type PredictionEngineStatus = {
  running: boolean
  tenantId: string
  lastTickAtMs: number | null
  tickCount: number
  lastError: string | null
  oracle: OracleSnapshot
  collector: CollectorStats
  hourlyIndicators: HourlyExhaustionIndicators | null
  gates: PredictionGateTelemetry
  canaryRisk: {
    config: CanaryRiskConfig
    todayLossesCount: number
    todayLossUsd: number
    openBtcExposureUsd: number
    remainingBtcExposureUsd: number
    killSwitchActive: boolean
  }
  macroBlackoutWindows: MacroBlackoutWindow[]
  calibrators: Record<EngineTimeframe, PredictionCalibratorSummary>
  strategies: PredictionStrategyStatusView[]
  openTrades: StoredPredictionTrade[]
  recentSettledTrades: StoredPredictionTrade[]
}

export type PredictionRunnerOptions = {
  store?: StateStore
  oracleFeed?: OracleFeedService
  clobBookFeed?: ClobBookFeedService
  collector?: PredictionWindowCollector
  getHourlyCandles?: (nowMs: number) => Promise<Candle[]>
  submitTakerOrder?: typeof submitPolymarketOrder
  submitMakerQuote?: typeof submitPolymarketMakerQuote
  cancelOrdersForWindow?: typeof cancelOrdersForWindow
  cancelAllOrders?: typeof cancelAllPolymarketOrders
  syncOrderStatuses?: typeof syncPolymarketOrderStatuses
  appendLedgerEntry?: typeof appendTenantLedgerEntry
  nowMs?: () => number
  tickIntervalMs?: number
  tenantId?: string
  recalibrateEverySettled?: number
  hourlyCandleRefreshMs?: number
  bookHydrateCooldownMs?: number
  openTwapMaxAgeMs?: number
  macroBlackoutWindows?: readonly MacroBlackoutWindow[]
  canaryRiskConfig?: Partial<CanaryRiskConfig>
  safetyGateConfig?: Partial<SafetyGateConfig>
  onError?: (context: string, err: unknown) => void
}

type CalibratorCacheEntry = {
  curve: CalibrationCurve
  lastSettledCount: number
}

type RestingOrderMeta = {
  tradeId: string
  strategyId: PredictionEngineStrategyId
  slug: string
  timeframe: EngineTimeframe
  outcome: 'YES' | 'NO'
  mode: 'paper' | 'canary' | 'scale'
  orderType: 'GTC' | 'FOK'
  liquidityRole: LiquidityRole
  limitPrice: number
  endTimeMs: number
  cancelAtSecondsRemaining: number
  clientOrderId: string
  venueOrderId: string | null
  filled: boolean
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function utcDayKey(tsMs: number): number {
  return Math.floor(tsMs / ONE_DAY_MS)
}

function makeTradeKey(
  strategyId: string,
  slug: string,
  outcome: 'YES' | 'NO',
): string {
  return `${strategyId}|${slug}|${outcome}`
}

function makeClientOrderId(
  strategyId: string,
  slug: string,
  outcome: 'YES' | 'NO',
): string {
  return `pe-${strategyId}-${slug}-${outcome}`
}

function indexOrdersByClientId(
  orders: readonly PolymarketOrderRecord[],
): Map<string, PolymarketOrderRecord> {
  // `recentOrders` is ordered newest-first; keep the first (newest) record per clientOrderId.
  const execByClientId = new Map<string, PolymarketOrderRecord>()
  for (const order of orders) {
    if (!execByClientId.has(order.clientOrderId)) {
      execByClientId.set(order.clientOrderId, order)
    }
  }
  return execByClientId
}

function defaultCancelThresholdForStrategy(
  strategyId: string,
  liquidityRole: LiquidityRole,
  isExplicitResting = false,
): number | null {
  if (strategyId === 'c5-nowcast-maker' && liquidityRole === 'maker') {
    return 20
  }
  if (
    strategyId === 'c1h-exhaustion-limit' &&
    (liquidityRole === 'maker' || isExplicitResting)
  ) {
    return 3000
  }
  if (strategyId === 'c1h-late-nowcast' && liquidityRole === 'maker') {
    return 30
  }
  if (strategyId === 'cx-nested-coherence' && liquidityRole === 'maker') {
    return 30
  }
  return null
}

function computeClosedHourlyIndicators(
  rawCandles: readonly Candle[],
  nowMs: number,
): HourlyExhaustionIndicators {
  const dedup = new Map<number, Candle>()
  for (const c of rawCandles) {
    if (
      !Number.isFinite(c.time) ||
      !Number.isFinite(c.open) ||
      !Number.isFinite(c.close) ||
      c.time + ONE_HOUR_MS > nowMs
    ) {
      continue
    }
    dedup.set(c.time, c)
  }

  const closed = Array.from(dedup.values()).sort((a, b) => a.time - b.time)
  let consecutiveRedHours = 0
  for (let i = closed.length - 1; i >= 0; i--) {
    const cur = closed[i]
    if (i < closed.length - 1) {
      const next = closed[i + 1]
      if (next.time - cur.time !== ONE_HOUR_MS) {
        break
      }
    }
    if (cur.close < cur.open) {
      consecutiveRedHours += 1
    } else {
      break
    }
  }

  const closes = closed.map((c) => c.close)
  const rsiSeries = rsi(closes, 14)
  const lastRsi =
    rsiSeries.length > 0 ? (rsiSeries[rsiSeries.length - 1] ?? null) : null

  return {
    consecutiveRedHours,
    rsi14: lastRsi !== null && Number.isFinite(lastRsi) ? lastRsi : null,
  }
}

function computeOutcomeMidFromBook(
  book: EngineOrderBookSnapshot,
  outcome: 'YES' | 'NO',
): number | null {
  const side = outcome === 'YES' ? book.yes : book.no
  if (!side) return null
  if (
    side.bestBid !== null &&
    side.bestAsk !== null &&
    Number.isFinite(side.bestBid) &&
    Number.isFinite(side.bestAsk) &&
    side.bestAsk >= side.bestBid
  ) {
    return (side.bestBid + side.bestAsk) / 2
  }
  if (side.bestAsk !== null && Number.isFinite(side.bestAsk)) {
    return side.bestAsk
  }
  if (side.bestBid !== null && Number.isFinite(side.bestBid)) {
    return side.bestBid
  }
  return null
}

function computeOutcomeMidFromSnapshot(
  snap: WindowSnapshotPoint,
  outcome: 'YES' | 'NO',
): number | null {
  const bid = outcome === 'YES' ? snap.yesBid : snap.noBid
  const ask = outcome === 'YES' ? snap.yesAsk : snap.noAsk
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

function computeMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) {
    return sorted[mid]
  }
  return (sorted[mid - 1] + sorted[mid]) / 2
}

function buildEngineBookFromSnapshot(
  slug: string,
  snap: ReplaySnapshotPoint,
  upTokenId = 'replay-up',
  downTokenId = 'replay-down',
): EngineOrderBookSnapshot {
  const yesValid =
    snap.yesBid !== null &&
    snap.yesAsk !== null &&
    Number.isFinite(snap.yesBid) &&
    Number.isFinite(snap.yesAsk) &&
    snap.yesAsk >= snap.yesBid
  const noValid =
    snap.noBid !== null &&
    snap.noAsk !== null &&
    Number.isFinite(snap.noBid) &&
    Number.isFinite(snap.noAsk) &&
    snap.noAsk >= snap.noBid

  const yesDepth = snap.yesDepthUsd ?? 0
  const noDepth = snap.noDepthUsd ?? 0

  return {
    slug,
    upTokenId,
    downTokenId,
    yes: yesValid
      ? {
          tokenId: upTokenId,
          bestBid: snap.yesBid,
          bestAsk: snap.yesAsk,
          mid: (snap.yesBid! + snap.yesAsk!) / 2,
          spread: snap.yesAsk! - snap.yesBid!,
          bidDepthUsd: yesDepth / 2,
          askDepthUsd: yesDepth / 2,
          top5DepthUsd: yesDepth,
          asOfMs: snap.capturedAtMs,
          source: 'clob-rest',
        }
      : null,
    no: noValid
      ? {
          tokenId: downTokenId,
          bestBid: snap.noBid,
          bestAsk: snap.noAsk,
          mid: (snap.noBid! + snap.noAsk!) / 2,
          spread: snap.noAsk! - snap.noBid!,
          bidDepthUsd: noDepth / 2,
          askDepthUsd: noDepth / 2,
          top5DepthUsd: noDepth,
          asOfMs: snap.capturedAtMs,
          source: 'clob-rest',
        }
      : null,
    minTop5DepthUsd: yesValid && noValid ? Math.min(yesDepth, noDepth) : 0,
    capturedAtMs: snap.capturedAtMs,
  }
}

export class PredictionRunner {
  private readonly store: StateStore
  private readonly oracleFeed: OracleFeedService
  private readonly clobBookFeed: ClobBookFeedService
  private readonly collector: PredictionWindowCollector
  private readonly getHourlyCandlesFn: (nowMs: number) => Promise<Candle[]>
  private readonly submitTakerOrderFn: typeof submitPolymarketOrder
  private readonly submitMakerQuoteFn: typeof submitPolymarketMakerQuote
  private readonly cancelOrdersForWindowFn: typeof cancelOrdersForWindow
  private readonly cancelAllOrdersFn: typeof cancelAllPolymarketOrders
  private readonly syncOrderStatusesFn: typeof syncPolymarketOrderStatuses
  private readonly appendLedgerEntryFn: typeof appendTenantLedgerEntry
  private readonly nowMs: () => number
  private readonly tickIntervalMs: number
  private readonly tenantId: string
  private readonly recalibrateEverySettled: number
  private readonly hourlyCandleRefreshMs: number
  private readonly bookHydrateCooldownMs: number
  private readonly openTwapMaxAgeMs: number
  private readonly safetyGateConfig: Partial<SafetyGateConfig> | undefined
  private readonly onError: ((context: string, err: unknown) => void) | undefined

  private running = false
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private tickInFlight: Promise<void> | null = null
  private hydrated = false
  private lastTickAtMs: number | null = null
  private tickCount = 0
  private lastError: string | null = null

  private canaryRiskConfig: CanaryRiskConfig
  private macroBlackoutWindows: MacroBlackoutWindow[]
  private hourlyIndicators: HourlyExhaustionIndicators | null = null
  private lastHourlyCandleFetchMs: number | null = null
  private readonly lastBookHydrateMsBySlug = new Map<string, number>()

  private calibratorsInitialized = false
  private lastCalibratedTotalSettled = 0
  private readonly calibrators: Record<EngineTimeframe, CalibratorCacheEntry> = {
    '5m': {
      curve: fitIsotonicCalibrator([], MIN_CALIBRATION_SAMPLES),
      lastSettledCount: 0,
    },
    '15m': {
      curve: fitIsotonicCalibrator([], MIN_CALIBRATION_SAMPLES),
      lastSettledCount: 0,
    },
    '1h': {
      curve: fitIsotonicCalibrator([], MIN_CALIBRATION_SAMPLES),
      lastSettledCount: 0,
    },
  }

  private readonly strategyStates = new Map<
    PredictionEngineStrategyId,
    StoredStrategyState
  >()
  private readonly forcedOverrideStrategies =
    new Set<PredictionEngineStrategyId>()
  private readonly latestReplayByStrategy = new Map<
    PredictionEngineStrategyId,
    PromotionReport
  >()
  private readonly tradesById = new Map<string, StoredPredictionTrade>()
  private readonly openTradesById = new Map<string, StoredPredictionTrade>()
  private readonly existingTradeKeys = new Set<string>()
  private readonly restingOrders = new Map<string, RestingOrderMeta>()

  private readonly markoutHistoryByStrategy = new Map<
    PredictionEngineStrategyId,
    number[]
  >()
  private readonly consecutiveHighErrorByStrategy = new Map<
    PredictionEngineStrategyId,
    number
  >()
  private readonly latestGatesByTimeframe: Record<
    EngineTimeframe,
    SafetyGateResult | null
  > = {
    '5m': null,
    '15m': null,
    '1h': null,
  }

  private todayUtcDayKey: number
  private todayLossesCount = 0
  private todayLossUsd = 0
  private killSwitchSwept = false

  constructor(options: PredictionRunnerOptions = {}) {
    this.store = options.store ?? getStateStore()
    this.oracleFeed = options.oracleFeed ?? getOracleFeed()
    this.clobBookFeed = options.clobBookFeed ?? getClobBookFeed()
    this.collector =
      options.collector ??
      new PredictionWindowCollector({
        store: this.store,
        oracleFeed: this.oracleFeed,
        clobBookFeed: this.clobBookFeed,
        nowMs: options.nowMs,
      })
    this.getHourlyCandlesFn =
      options.getHourlyCandles ??
      (async () => {
        const res = await getMarketGateway().getCandles('BTC/USDT', '1h', 100)
        return res.candles
      })
    this.submitTakerOrderFn = options.submitTakerOrder ?? submitPolymarketOrder
    this.submitMakerQuoteFn =
      options.submitMakerQuote ?? submitPolymarketMakerQuote
    this.cancelOrdersForWindowFn =
      options.cancelOrdersForWindow ?? cancelOrdersForWindow
    this.cancelAllOrdersFn =
      options.cancelAllOrders ?? cancelAllPolymarketOrders
    this.syncOrderStatusesFn =
      options.syncOrderStatuses ?? syncPolymarketOrderStatuses
    this.appendLedgerEntryFn =
      options.appendLedgerEntry ?? appendTenantLedgerEntry
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.tickIntervalMs = Math.max(
      100,
      Math.round(options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS),
    )
    this.tenantId = options.tenantId?.trim() || DEFAULT_TENANT_ID
    this.recalibrateEverySettled = Math.max(
      1,
      Math.round(
        options.recalibrateEverySettled ?? DEFAULT_RECALIBRATE_EVERY_SETTLED,
      ),
    )
    this.hourlyCandleRefreshMs = Math.max(
      1_000,
      Math.round(
        options.hourlyCandleRefreshMs ?? DEFAULT_HOURLY_CANDLE_REFRESH_MS,
      ),
    )
    this.bookHydrateCooldownMs = Math.max(
      250,
      Math.round(
        options.bookHydrateCooldownMs ?? DEFAULT_BOOK_HYDRATE_COOLDOWN_MS,
      ),
    )
    this.openTwapMaxAgeMs = Math.max(
      1_000,
      Math.round(options.openTwapMaxAgeMs ?? DEFAULT_OPEN_TWAP_MAX_AGE_MS),
    )
    this.canaryRiskConfig = normalizeCanaryRiskConfig(options.canaryRiskConfig)
    this.macroBlackoutWindows = (options.macroBlackoutWindows ?? []).map(
      (w) => ({ ...w }),
    )
    this.safetyGateConfig = options.safetyGateConfig
    this.onError = options.onError
    this.todayUtcDayKey = utcDayKey(this.nowMs())

    for (const def of STRATEGY_REGISTRY) {
      this.strategyStates.set(def.id, {
        tenantId: this.tenantId,
        strategyId: def.id,
        mode: def.defaultMode,
        haltedReason: null,
        updatedAt: 0,
      })
      this.markoutHistoryByStrategy.set(def.id, [])
      this.consecutiveHighErrorByStrategy.set(def.id, 0)
    }

    registerKillSwitchHandler('prediction-runner', async (tenantId, reason) => {
      if (tenantId === this.tenantId) {
        this.killSwitchSwept = true
        if (this.cancelAllOrdersFn !== cancelAllPolymarketOrders) {
          await this.cancelAllOrdersFn(tenantId, reason)
        }
      }
    })
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.tickTimer = setInterval(() => {
      if (this.running) {
        void this.runTick()
      }
    }, this.tickIntervalMs)
    this.tickTimer.unref?.()
    void this.runTick()
  }

  stop(): void {
    this.running = false
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  isRunning(): boolean {
    return this.running
  }

  async runTick(nowMs = this.nowMs()): Promise<void> {
    if (this.tickInFlight) {
      return this.tickInFlight
    }
    this.tickInFlight = this.executeTick(nowMs)
      .catch((err) => {
        this.recordError('runTick', err)
      })
      .finally(() => {
        this.tickInFlight = null
      })
    return this.tickInFlight
  }

  private recordError(context: string, err: unknown): void {
    this.lastError = `${context}: ${toErrorMessage(err)}`
    this.onError?.(context, err)
  }

  private syncUtcDayRollover(nowMs: number): void {
    const dayKey = utcDayKey(nowMs)
    if (dayKey !== this.todayUtcDayKey) {
      this.todayUtcDayKey = dayKey
      this.todayLossesCount = 0
      this.todayLossUsd = 0
    }
  }

  private async hydrateFromStore(nowMs: number): Promise<void> {
    if (this.hydrated) return
    await this.store.migrate()

    const savedStates = await this.store.getStrategyModeStates(this.tenantId)
    const savedById = new Map(savedStates.map((s) => [s.strategyId, s]))

    for (const def of STRATEGY_REGISTRY) {
      const existing = savedById.get(def.id)
      if (existing) {
        this.strategyStates.set(def.id, { ...existing })
      } else {
        const initial: StoredStrategyState = {
          tenantId: this.tenantId,
          strategyId: def.id,
          mode: def.defaultMode,
          haltedReason: null,
          updatedAt: nowMs,
        }
        this.strategyStates.set(def.id, initial)
        await this.store.setStrategyModeState(initial)
      }
    }

    // Restore audited force-override promotions from audit log
    try {
      const auditEvents = await this.store.getAuditEvents(this.tenantId, 2_000)
      const chronologicalAudit = [...auditEvents].sort((a, b) =>
        a.timestamp.localeCompare(b.timestamp),
      )
      for (const ev of chronologicalAudit) {
        if (
          ev.action === 'prediction.strategy.promote' ||
          ev.action === 'prediction.strategy.mode_change'
        ) {
          const stratId = ev.resource as PredictionEngineStrategyId
          if (ev.details?.forcedOverride === true) {
            this.forcedOverrideStrategies.add(stratId)
          } else if (ev.action === 'prediction.strategy.mode_change') {
            this.forcedOverrideStrategies.delete(stratId)
          }
        }
      }
    } catch {
      // Optional audit restoration failure should not block startup
    }

    // Load up to 5,000 trades explicitly (never rely on default 200 limit)
    const allTrades = await this.store.getPredictionTrades(this.tenantId, {
      limit: 5_000,
    })
    const chronological = [...allTrades].sort((a, b) => {
      if (a.entryTimeMs !== b.entryTimeMs) return a.entryTimeMs - b.entryTimeMs
      return a.id.localeCompare(b.id)
    })

    const todayKey = utcDayKey(nowMs)
    this.todayUtcDayKey = todayKey
    this.todayLossesCount = 0
    this.todayLossUsd = 0

    const windowEndBySlug = new Map<string, number>()
    const openSlugs = new Set<string>()
    let hasOpenLiveTrades = false
    for (const t of chronological) {
      this.tradesById.set(t.id, t)
      this.existingTradeKeys.add(makeTradeKey(t.strategyId, t.slug, t.outcome))

      if (t.status === 'OPEN') {
        this.openTradesById.set(t.id, t)
        openSlugs.add(t.slug)
        if (t.mode === 'canary' || t.mode === 'scale') {
          hasOpenLiveTrades = true
        }
      } else if (t.status === 'SETTLED') {
        const stratId = t.strategyId as PredictionEngineStrategyId
        if (t.markout30s !== null && Number.isFinite(t.markout30s)) {
          this.pushMarkoutSample(stratId, t.markout30s)
        }
        const wonNum = t.won ? 1 : 0
        const err = Math.abs(t.pModel - wonNum)
        const prevStreak = this.consecutiveHighErrorByStrategy.get(stratId) ?? 0
        this.consecutiveHighErrorByStrategy.set(
          stratId,
          err > HIGH_ERROR_THRESHOLD ? prevStreak + 1 : 0,
        )

        if (
          (t.mode === 'canary' || t.mode === 'scale') &&
          (!t.won || (t.netPnlUsd ?? 0) < 0) &&
          utcDayKey(t.entryTimeMs) >= todayKey - 1
        ) {
          let endTimeMs = windowEndBySlug.get(t.slug)
          if (endTimeMs === undefined) {
            const wins = await this.store.getPredictionWindows({
              slug: t.slug,
              limit: 1,
            })
            if (wins[0]) {
              endTimeMs = wins[0].endTimeMs
              windowEndBySlug.set(t.slug, endTimeMs)
            }
          }
          if (utcDayKey(endTimeMs ?? t.entryTimeMs) === todayKey) {
            this.todayLossesCount += 1
            this.todayLossUsd = Number(
              (this.todayLossUsd + Math.max(0, -(t.netPnlUsd ?? 0))).toFixed(
                4,
              ),
            )
          }
        }
      }
    }

    // Reconstruct resting GTC orders for any hydrated OPEN trades
    if (openSlugs.size > 0) {
      for (const slug of openSlugs) {
        if (!windowEndBySlug.has(slug)) {
          const wins = await this.store.getPredictionWindows({ slug, limit: 1 })
          if (wins[0]) {
            windowEndBySlug.set(slug, wins[0].endTimeMs)
          }
        }
      }
      if (hasOpenLiveTrades) {
        try {
          await this.syncOrderStatusesFn(this.tenantId)
        } catch (err) {
          this.recordError('hydrateSyncOrderStatuses', err)
        }
      }

      const execOrders = getPolymarketExecutorStatus(this.tenantId).recentOrders
      const execByClientId = indexOrdersByClientId(execOrders)

      for (const t of this.openTradesById.values()) {
        const endTimeMs = windowEndBySlug.get(t.slug)
        if (endTimeMs === undefined) continue

        if (t.mode === 'paper') {
          const isExplicitRestingPaper = t.venueOrderId === 'paper-resting'
          const cancelThreshold = defaultCancelThresholdForStrategy(
            t.strategyId,
            t.liquidityRole,
            isExplicitRestingPaper,
          )
          if (!isExplicitRestingPaper || cancelThreshold === null) continue
          this.restingOrders.set(t.id, {
            tradeId: t.id,
            strategyId: t.strategyId as PredictionEngineStrategyId,
            slug: t.slug,
            timeframe: t.timeframe,
            outcome: t.outcome,
            mode: t.mode,
            orderType: 'GTC',
            liquidityRole: t.liquidityRole,
            limitPrice: t.entryPrice,
            endTimeMs,
            cancelAtSecondsRemaining: cancelThreshold,
            clientOrderId: makeClientOrderId(t.strategyId, t.slug, t.outcome),
            venueOrderId: t.venueOrderId,
            filled: false,
          })
          continue
        }

        const clientOrderId = makeClientOrderId(t.strategyId, t.slug, t.outcome)
        const execOrder = execByClientId.get(clientOrderId)
        const sqlOrder = execOrder
          ? null
          : await this.store.findOrderByClientOrderId(
              this.tenantId,
              clientOrderId,
            )

        const isKnownFilledOrClosed =
          execOrder?.status === 'MATCHED' ||
          sqlOrder?.status === 'FILLED' ||
          execOrder?.status === 'CANCELED' ||
          sqlOrder?.status === 'CANCELED_KILLSWITCH' ||
          execOrder?.status === 'REJECTED' ||
          sqlOrder?.status === 'REJECTED_RISK'
        if (isKnownFilledOrClosed) continue

        const isExplicitLive =
          execOrder?.status === 'LIVE' ||
          sqlOrder?.status === 'LIVE' ||
          (!execOrder &&
            !sqlOrder &&
            t.liquidityRole === 'maker' &&
            t.venueOrderId !== null)
        const cancelThreshold = defaultCancelThresholdForStrategy(
          t.strategyId,
          t.liquidityRole,
          isExplicitLive,
        )
        if (!isExplicitLive || cancelThreshold === null) continue

        this.restingOrders.set(t.id, {
          tradeId: t.id,
          strategyId: t.strategyId as PredictionEngineStrategyId,
          slug: t.slug,
          timeframe: t.timeframe,
          outcome: t.outcome,
          mode: t.mode,
          orderType: 'GTC',
          liquidityRole: t.liquidityRole,
          limitPrice: t.entryPrice,
          endTimeMs,
          cancelAtSecondsRemaining: cancelThreshold,
          clientOrderId,
          venueOrderId:
            t.venueOrderId ??
            execOrder?.venueOrderId ??
            sqlOrder?.venueOrderId ??
            null,
          filled: false,
        })
      }
    }

    this.hydrated = true
  }

  private pushMarkoutSample(
    strategyId: PredictionEngineStrategyId,
    markout30s: number,
  ): void {
    const arr = this.markoutHistoryByStrategy.get(strategyId) ?? []
    arr.push(markout30s)
    if (arr.length > MARKOUT_WINDOW_TRADES) {
      arr.splice(0, arr.length - MARKOUT_WINDOW_TRADES)
    }
    this.markoutHistoryByStrategy.set(strategyId, arr)
  }

  private async maybeRecalibrate(force = false): Promise<void> {
    const totalSettled = await this.store.getSettledWindowCount()
    if (
      !force &&
      this.calibratorsInitialized &&
      totalSettled - this.lastCalibratedTotalSettled <
        this.recalibrateEverySettled
    ) {
      return
    }

    const settledWindowsDesc = await this.store.getPredictionWindows({
      settledOnly: true,
      order: 'desc',
      limit: 2_000,
    })
    const settledWindows = [...settledWindowsDesc].reverse()

    const byTf: Record<EngineTimeframe, CollectedWindowRecord[]> = {
      '5m': [],
      '15m': [],
      '1h': [],
    }
    for (const w of settledWindows) {
      byTf[w.timeframe].push(w)
    }

    for (const tf of ['5m', '15m', '1h'] as const) {
      const windowsForTf = byTf[tf]
      const samples: CalibrationSample[] = []
      for (const w of windowsForTf) {
        if (w.resolvedUp === null) continue
        const outcome: 0 | 1 = w.resolvedUp ? 1 : 0
        const snaps = await this.store.getPredictionSnapshots(w.slug)
        for (const snap of snaps) {
          let pRaw: number | null = null
          if (
            snap.pModelYes !== null &&
            Number.isFinite(snap.pModelYes) &&
            snap.pModelYes > 0 &&
            snap.pModelYes < 1
          ) {
            pRaw = snap.pModelYes
          } else if (
            w.openTwap !== null &&
            snap.twapPrice !== null &&
            snap.sigma1m !== null
          ) {
            const est = computeNowcast({
              openTwap: w.openTwap,
              currentTwap: snap.twapPrice,
              secondsRemaining: snap.secondsRemaining,
              sigma1m: snap.sigma1m,
            })
            if (est.valid) {
              pRaw = est.pRawYes
            }
          }
          if (pRaw !== null) {
            samples.push({ pRaw, outcome })
          }
        }
      }
      this.calibrators[tf] = {
        curve: fitIsotonicCalibrator(samples, MIN_CALIBRATION_SAMPLES),
        lastSettledCount: windowsForTf.length,
      }
    }

    this.calibratorsInitialized = true
    this.lastCalibratedTotalSettled = totalSettled
  }

  private async maybeRefreshHourlyIndicators(nowMs: number): Promise<void> {
    if (
      this.lastHourlyCandleFetchMs !== null &&
      nowMs - this.lastHourlyCandleFetchMs < this.hourlyCandleRefreshMs
    ) {
      return
    }
    try {
      const candles = await this.getHourlyCandlesFn(nowMs)
      this.hourlyIndicators = computeClosedHourlyIndicators(candles, nowMs)
      this.lastHourlyCandleFetchMs = nowMs
    } catch (err) {
      // Non-fatal: 5m and 15m strategies stay active even during Binance REST outages
      this.recordError('hourlyCandles', err)
    }
  }

  private async supplementActiveWindows(
    nowMs: number,
    activeWindows: readonly PolymarketWindow[],
    trackedBySlug: Map<string, CollectedWindowRecord>,
  ): Promise<void> {
    for (const win of activeWindows) {
      const record = trackedBySlug.get(win.slug)
      if ((!record || record.openTwap === null) && win.startTime <= nowMs) {
        const pinned = this.oracleFeed.getWindowOpenTwap(
          win.startTime,
          this.openTwapMaxAgeMs,
        )
        if (pinned !== null) {
          const updatedRecord: CollectedWindowRecord = record
            ? { ...record, openTwap: pinned, updatedAt: nowMs }
            : {
                slug: win.slug,
                timeframe: win.timeframe,
                conditionId: win.conditionId ?? null,
                upTokenId: win.upTokenId ?? null,
                downTokenId: win.downTokenId ?? null,
                resolutionSource: win.resolutionSource ?? 'unknown',
                startTimeMs: win.startTime,
                endTimeMs: win.endTime,
                openTwap: pinned,
                closeTwap: null,
                resolvedUp: null,
                tickSize: win.tickSize ?? null,
                negRisk: Boolean(win.negRisk),
                volumeUsd: Number.isFinite(win.volume) ? win.volume : null,
                updatedAt: nowMs,
              }
          await this.store.upsertPredictionWindow(updatedRecord)
          trackedBySlug.set(win.slug, updatedRecord)
        }
      }

      const book = this.clobBookFeed.getWindowSnapshot(win)
      const yesStale = isBookSideStale(book.yes, nowMs, DEFAULT_BOOK_STALE_MS)
      const noStale = isBookSideStale(book.no, nowMs, DEFAULT_BOOK_STALE_MS)
      if ((yesStale || noStale) && (win.upTokenId || win.downTokenId)) {
        const lastHydrate = this.lastBookHydrateMsBySlug.get(win.slug)
        if (
          lastHydrate === undefined ||
          nowMs - lastHydrate >= this.bookHydrateCooldownMs
        ) {
          this.lastBookHydrateMsBySlug.set(win.slug, nowMs)
          try {
            await this.clobBookFeed.hydrateWindow(win)
          } catch (err) {
            this.recordError(`hydrateBook:${win.slug}`, err)
          }
        }
      }
    }
  }

  private async processRestingOrders(
    nowMs: number,
    activeBySlug: ReadonlyMap<string, PolymarketWindow>,
    trackedBySlug: ReadonlyMap<string, CollectedWindowRecord>,
  ): Promise<void> {
    const hasUnfilledLiveResting = Array.from(this.restingOrders.values()).some(
      (r) => r.mode !== 'paper' && !r.filled,
    )
    if (hasUnfilledLiveResting) {
      try {
        await this.syncOrderStatusesFn(this.tenantId)
      } catch (err) {
        this.recordError('syncOrderStatuses', err)
      }
    }

    const execOrders = getPolymarketExecutorStatus(this.tenantId).recentOrders
    const execByClientId = indexOrdersByClientId(execOrders)
    const sweepResultsBySlug = new Map<string, CancelOrdersForWindowResult>()

    for (const [tradeId, resting] of this.restingOrders.entries()) {
      const trade = this.openTradesById.get(tradeId)
      if (!trade || trade.status !== 'OPEN') {
        this.restingOrders.delete(tradeId)
        continue
      }

      // 1. Check whether resting paper quote crossed live bestAsk, or live order matched
      if (!resting.filled) {
        if (resting.mode === 'paper') {
          const win = activeBySlug.get(resting.slug)
          if (win) {
            const book = this.clobBookFeed.getWindowSnapshot(win)
            const sideBook = resting.outcome === 'YES' ? book.yes : book.no
            if (
              sideBook &&
              !isBookSideStale(sideBook, nowMs, DEFAULT_BOOK_STALE_MS) &&
              sideBook.bestAsk !== null &&
              sideBook.bestAsk <= resting.limitPrice
            ) {
              resting.filled = true
              const filledTrade: StoredPredictionTrade = {
                ...trade,
                entryTimeMs: nowMs,
                venueOrderId: 'paper-filled',
              }
              await this.store.upsertPredictionTrade(filledTrade)
              this.openTradesById.set(tradeId, filledTrade)
              this.tradesById.set(tradeId, filledTrade)
              this.restingOrders.delete(tradeId)
              continue
            }
          }
        } else {
          const execOrder = execByClientId.get(resting.clientOrderId)
          const sqlOrder = execOrder
            ? null
            : await this.store.findOrderByClientOrderId(
                this.tenantId,
                resting.clientOrderId,
              )
          if (
            execOrder?.status === 'MATCHED' ||
            sqlOrder?.status === 'FILLED'
          ) {
            resting.filled = true
            this.restingOrders.delete(tradeId)
            continue
          }
        }
      } else {
        this.restingOrders.delete(tradeId)
        continue
      }

      // 2. Sweep unfilled resting quotes once cancelAtSecondsRemaining elapsed or window ended
      const cancelAtMs =
        resting.endTimeMs - resting.cancelAtSecondsRemaining * 1_000
      const tracked = trackedBySlug.get(resting.slug)
      const windowEnded =
        nowMs >= resting.endTimeMs ||
        (tracked !== undefined && tracked.resolvedUp !== null)
      if (nowMs < cancelAtMs && !windowEnded) {
        continue
      }

      if (resting.mode !== 'paper') {
        let cancelRes = sweepResultsBySlug.get(resting.slug)
        if (!cancelRes) {
          const trackedWin = trackedBySlug.get(resting.slug)
          const tokenIds = [
            trackedWin?.upTokenId,
            trackedWin?.downTokenId,
          ].filter((id): id is string => Boolean(id))
          try {
            cancelRes = await this.cancelOrdersForWindowFn(
              this.tenantId,
              resting.slug,
              {
                reason: `Timed sweep (<= ${resting.cancelAtSecondsRemaining}s remaining)`,
                conditionId: trackedWin?.conditionId ?? undefined,
                tokenIds,
              },
            )
          } catch (err) {
            cancelRes = {
              ok: false,
              canceledCount: 0,
              canceledOrderIds: [],
              failedOrderIds: resting.venueOrderId
                ? [resting.venueOrderId]
                : [],
              error: toErrorMessage(err),
            }
          }
          sweepResultsBySlug.set(resting.slug, cancelRes)
        }

        const orderFailed =
          (resting.venueOrderId !== null &&
            cancelRes.failedOrderIds.includes(resting.venueOrderId)) ||
          (!cancelRes.ok &&
            (resting.venueOrderId === null ||
              !cancelRes.canceledOrderIds.includes(resting.venueOrderId)))

        if (orderFailed) {
          this.recordError(
            `cancelOrdersForWindow:${resting.slug}`,
            cancelRes.error ?? 'Failed to cancel resting order',
          )
          continue
        }
      }

      const canceledTrade: StoredPredictionTrade = {
        ...trade,
        status: 'CANCELED',
      }
      await this.store.upsertPredictionTrade(canceledTrade)
      this.openTradesById.delete(tradeId)
      this.tradesById.set(tradeId, canceledTrade)
      this.restingOrders.delete(tradeId)
    }
  }

  private async captureMarkouts(
    nowMs: number,
    activeBySlug: ReadonlyMap<string, PolymarketWindow>,
    trackedBySlug: ReadonlyMap<string, CollectedWindowRecord>,
  ): Promise<void> {
    for (const [tradeId, trade] of this.openTradesById.entries()) {
      if (trade.markout30s !== null) continue
      const resting = this.restingOrders.get(tradeId)
      if (resting && !resting.filled) continue
      if (nowMs < trade.entryTimeMs + 30_000) continue

      let outcomeMid: number | null = null
      const activeWin = activeBySlug.get(trade.slug)
      if (activeWin) {
        const book = this.clobBookFeed.getWindowSnapshot(activeWin)
        outcomeMid = computeOutcomeMidFromBook(book, trade.outcome)
      } else {
        const rec = trackedBySlug.get(trade.slug)
        if (rec) {
          const synthWin: PolymarketWindow = {
            slug: rec.slug,
            timeframe: rec.timeframe,
            startTime: rec.startTimeMs,
            endTime: rec.endTimeMs,
            status: 'open',
            question: null,
            upPriceAtOpen: null,
            upPriceNow: null,
            bestBid: null,
            bestAsk: null,
            resolvedUp: rec.resolvedUp,
            volume: rec.volumeUsd ?? 0,
            resolutionSource: rec.resolutionSource,
            conditionId: rec.conditionId,
            upTokenId: rec.upTokenId,
            downTokenId: rec.downTokenId,
            tickSize: rec.tickSize,
            negRisk: rec.negRisk,
          }
          const book = this.clobBookFeed.getWindowSnapshot(synthWin)
          outcomeMid = computeOutcomeMidFromBook(book, trade.outcome)
        }
        if (outcomeMid === null) {
          const snaps = await this.store.getPredictionSnapshots(trade.slug)
          const latest = snaps[snaps.length - 1]
          if (latest) {
            outcomeMid = computeOutcomeMidFromSnapshot(latest, trade.outcome)
          }
        }
      }

      if (outcomeMid === null || !Number.isFinite(outcomeMid)) continue

      const markout30s = Number((outcomeMid - trade.entryPrice).toFixed(6))
      const updated: StoredPredictionTrade = {
        ...trade,
        markout30s,
      }
      await this.store.upsertPredictionTrade(updated)
      this.openTradesById.set(tradeId, updated)
      this.tradesById.set(tradeId, updated)
      this.pushMarkoutSample(
        trade.strategyId as PredictionEngineStrategyId,
        markout30s,
      )
    }
  }

  private async settleClosedWindows(
    trackedBySlug: ReadonlyMap<string, CollectedWindowRecord>,
  ): Promise<void> {
    for (const [tradeId, trade] of this.openTradesById.entries()) {
      let rec = trackedBySlug.get(trade.slug)
      if (!rec || rec.resolvedUp === null) {
        const rows = await this.store.getPredictionWindows({
          slug: trade.slug,
          limit: 1,
        })
        if (rows[0]) {
          rec = rows[0]
        }
      }
      if (!rec || rec.resolvedUp === null) continue

      // If an unfilled resting quote never filled before settlement, cancel instead of settling
      const resting = this.restingOrders.get(tradeId)
      if (resting && !resting.filled) {
        if (resting.mode !== 'paper') {
          continue
        }
        const canceled: StoredPredictionTrade = {
          ...trade,
          status: 'CANCELED',
        }
        await this.store.upsertPredictionTrade(canceled)
        this.openTradesById.delete(tradeId)
        this.tradesById.set(tradeId, canceled)
        this.restingOrders.delete(tradeId)
        continue
      }

      const resolvedUp = rec.resolvedUp
      const won =
        (trade.outcome === 'YES' && resolvedUp) ||
        (trade.outcome === 'NO' && !resolvedUp)
      const payoutUsd = won ? trade.shares : 0
      const netPnlUsd = Number(
        (payoutUsd - trade.stakeUsd - trade.feeUsd).toFixed(4),
      )

      const settledTrade: StoredPredictionTrade = {
        ...trade,
        resolvedUp,
        won,
        netPnlUsd,
        status: 'SETTLED',
      }
      await this.store.upsertPredictionTrade(settledTrade)
      this.openTradesById.delete(tradeId)
      this.tradesById.set(tradeId, settledTrade)
      this.restingOrders.delete(tradeId)

      const stratId = trade.strategyId as PredictionEngineStrategyId
      const wonNum = won ? 1 : 0
      const absErr = Math.abs(trade.pModel - wonNum)
      const prevStreak = this.consecutiveHighErrorByStrategy.get(stratId) ?? 0
      this.consecutiveHighErrorByStrategy.set(
        stratId,
        absErr > HIGH_ERROR_THRESHOLD ? prevStreak + 1 : 0,
      )

      if (trade.mode === 'canary' || trade.mode === 'scale') {
        this.appendLedgerEntryFn(
          this.tenantId,
          buildPredictionSettlementEntry({
            tenantId: this.tenantId,
            ticketId: trade.id,
            stakeUsd: trade.stakeUsd,
            payoutUsd,
            won,
          }),
        )

        if (
          (!won || netPnlUsd < 0) &&
          utcDayKey(rec.endTimeMs) === this.todayUtcDayKey
        ) {
          this.todayLossesCount += 1
          this.todayLossUsd = Number(
            (this.todayLossUsd + Math.max(0, -netPnlUsd)).toFixed(4),
          )
        }
      }
    }
  }

  private async evaluateAutoKillSwitches(nowMs: number): Promise<void> {
    const dailyLimitHit =
      this.todayLossesCount >= this.canaryRiskConfig.maxDailyLosses ||
      this.todayLossUsd >= this.canaryRiskConfig.maxDailyLossUsd

    for (const def of STRATEGY_REGISTRY) {
      const state = this.strategyStates.get(def.id)
      if (!state || state.mode === 'disabled' || state.haltedReason !== null) {
        continue
      }

      let haltReason: string | null = null
      const streak = this.consecutiveHighErrorByStrategy.get(def.id) ?? 0
      if (streak >= CONSECUTIVE_HIGH_ERROR_LIMIT) {
        haltReason = `Auto kill-switch: ${streak} consecutive settled trades with |P_model - outcome| > ${HIGH_ERROR_THRESHOLD}`
      }

      if (!haltReason) {
        const markouts = this.markoutHistoryByStrategy.get(def.id) ?? []
        if (markouts.length >= MARKOUT_WINDOW_TRADES) {
          const mean =
            markouts.reduce((sum, v) => sum + v, 0) / markouts.length
          if (mean < MARKOUT_HALT_THRESHOLD) {
            haltReason = `Auto kill-switch: 30-fill mean +30s markout (${mean.toFixed(4)}) < ${MARKOUT_HALT_THRESHOLD}`
          }
        }
      }

      if (
        !haltReason &&
        dailyLimitHit &&
        (state.mode === 'canary' || state.mode === 'scale')
      ) {
        haltReason = `Auto kill-switch: UTC daily loss circuit breaker (${this.todayLossesCount}/${this.canaryRiskConfig.maxDailyLosses} losses, $${this.todayLossUsd.toFixed(2)}/$${this.canaryRiskConfig.maxDailyLossUsd.toFixed(2)})`
      }

      if (haltReason) {
        await this.haltStrategy(this.tenantId, def.id, haltReason, nowMs)
      }
    }
  }

  private resolveOpenTwapForWindow(
    win: PolymarketWindow,
    trackedBySlug: ReadonlyMap<string, CollectedWindowRecord>,
  ): number | null {
    return (
      trackedBySlug.get(win.slug)?.openTwap ??
      this.oracleFeed.getWindowOpenTwap(win.startTime, this.openTwapMaxAgeMs)
    )
  }

  private buildNestedParentContext(
    childWin: PolymarketWindow,
    nowMs: number,
    activeWindows: readonly PolymarketWindow[],
    trackedBySlug: ReadonlyMap<string, CollectedWindowRecord>,
  ): NestedParentContext | undefined {
    const childRemaining = Math.max(0, (childWin.endTime - nowMs) / 1_000)
    const preferredOrder: readonly EngineTimeframe[] =
      childWin.timeframe === '5m'
        ? ['15m', '1h']
        : childWin.timeframe === '15m'
          ? ['1h']
          : []

    for (const parentTf of preferredOrder) {
      const parent = activeWindows.find(
        (p) =>
          p.timeframe === parentTf &&
          p.slug !== childWin.slug &&
          p.startTime <= nowMs &&
          nowMs < p.endTime &&
          p.endTime > childWin.endTime,
      )
      if (!parent) continue
      const parentOpenTwap = this.resolveOpenTwapForWindow(
        parent,
        trackedBySlug,
      )
      if (parentOpenTwap === null || parentOpenTwap <= 0) continue
      const parentRemaining = Math.max(0, (parent.endTime - nowMs) / 1_000)
      if (parentRemaining <= childRemaining) continue

      const parentResolutionSource: ResolutionSource =
        parent.resolutionSource ??
        trackedBySlug.get(parent.slug)?.resolutionSource ??
        'unknown'
      const parentBook = this.clobBookFeed.getWindowSnapshot(parent)

      return {
        slug: parent.slug,
        timeframe: parent.timeframe,
        resolutionSource: parentResolutionSource,
        openTwap: parentOpenTwap,
        secondsRemaining: parentRemaining,
        secondsElapsed: Math.max(0, (nowMs - parent.startTime) / 1_000),
        book: parentBook,
      }
    }

    return undefined
  }

  private async evaluateActiveStrategies(
    nowMs: number,
    oracle: OracleSnapshot,
    activeWindows: readonly PolymarketWindow[],
    activeBySlug: ReadonlyMap<string, PolymarketWindow>,
    trackedBySlug: ReadonlyMap<string, CollectedWindowRecord>,
  ): Promise<void> {
    const exchangeSnap = getExchangeStatusSnapshot(this.tenantId)
    if (exchangeSnap.killSwitchActive && !this.killSwitchSwept) {
      this.killSwitchSwept = true
      await this.cancelAllOrdersFn(
        this.tenantId,
        exchangeSnap.killSwitchReason ?? 'Kill-switch active',
      )
    } else if (!exchangeSnap.killSwitchActive) {
      this.killSwitchSwept = false
    }

    const openLivePositions: CanaryOpenPosition[] = []
    for (const t of this.openTradesById.values()) {
      if (t.mode === 'canary' || t.mode === 'scale') {
        openLivePositions.push({
          slug: t.slug,
          timeframe: t.timeframe,
          stakeUsd: t.stakeUsd,
          asset: 'BTC',
        })
      }
    }

    for (const win of activeWindows) {
      if (win.startTime > nowMs || win.endTime <= nowMs) continue

      const resolutionSource: ResolutionSource =
        win.resolutionSource ??
        trackedBySlug.get(win.slug)?.resolutionSource ??
        'unknown'
      const openTwap = this.resolveOpenTwapForWindow(win, trackedBySlug)
      const secondsRemaining = Math.max(0, (win.endTime - nowMs) / 1_000)
      const secondsElapsed = Math.max(0, (nowMs - win.startTime) / 1_000)
      const book = this.clobBookFeed.getWindowSnapshot(win)

      const activeSpot =
        resolutionSource === 'binance-1h-candle'
          ? oracle.binancePrice
          : oracle.chainlinkTwap60s

      const nowcast =
        openTwap !== null &&
        openTwap > 0 &&
        activeSpot !== null &&
        activeSpot > 0 &&
        oracle.sigma1m !== null &&
        oracle.sigma1m > 0
          ? computeNowcast({
              openTwap,
              currentTwap: activeSpot,
              secondsRemaining,
              sigma1m: oracle.sigma1m,
            })
          : {
              z: 0,
              pRawYes: 0.5,
              pBlendedYes: 0.5,
              remainingMinutes: Math.max(1 / 60, secondsRemaining / 60),
              valid: false,
            }

      const calibratedPYes = nowcast.valid
        ? applyCalibrator(this.calibrators[win.timeframe].curve, nowcast.pRawYes)
        : null

      const nestedParent = this.buildNestedParentContext(
        win,
        nowMs,
        activeWindows,
        trackedBySlug,
      )

      const ctx: StrategyContext = {
        slug: win.slug,
        timeframe: win.timeframe,
        resolutionSource,
        startTimeMs: win.startTime,
        endTimeMs: win.endTime,
        openTwap,
        secondsRemaining,
        secondsElapsed,
        oracle,
        book,
        nowcast,
        calibratedPYes,
        hourlyIndicators: this.hourlyIndicators ?? undefined,
        nestedParent,
        macroBlackoutWindows: this.macroBlackoutWindows,
        nowMs,
        stakeUsd: this.canaryRiskConfig.stakeUsd,
      }

      this.latestGatesByTimeframe[win.timeframe] = evaluateSafetyGates(ctx, {
        liquidityRole: 'taker',
        config: this.safetyGateConfig,
      })

      for (const def of STRATEGY_REGISTRY) {
        const state = this.strategyStates.get(def.id)
        if (
          !state ||
          state.haltedReason !== null ||
          (state.mode !== 'paper' &&
            state.mode !== 'canary' &&
            state.mode !== 'scale')
        ) {
          continue
        }

        const intents = def.evaluate(ctx)
        for (const intent of intents) {
          const tradeKey = makeTradeKey(
            intent.strategyId,
            intent.slug,
            intent.outcome,
          )
          if (this.existingTradeKeys.has(tradeKey)) continue

          const targetWin = activeBySlug.get(intent.slug)
          if (!targetWin) continue
          const targetBook = this.clobBookFeed.getWindowSnapshot(targetWin)

          const pCalibrated =
            intent.strategyId === 'c1h-exhaustion-limit' ||
            !ctx.nowcast.valid ||
            ctx.calibratedPYes === null ||
            ctx.calibratedPYes === undefined ||
            intent.slug !== ctx.slug
              ? intent.pModel
              : intent.outcome === 'YES'
                ? ctx.calibratedPYes
                : 1 - ctx.calibratedPYes

          if (state.mode === 'paper') {
            await this.executePaperIntent(
              intent,
              targetWin,
              targetBook,
              pCalibrated,
              nowMs,
            )
          } else {
            if (exchangeSnap.killSwitchActive) continue
            await this.executeLiveIntent(
              intent,
              state.mode,
              targetWin,
              targetBook,
              pCalibrated,
              openLivePositions,
              nowMs,
            )
          }
        }
      }
    }
  }

  private async executePaperIntent(
    intent: StrategyIntent,
    targetWin: PolymarketWindow,
    targetBook: EngineOrderBookSnapshot,
    pCalibrated: number,
    nowMs: number,
  ): Promise<void> {
    const sideBook = intent.outcome === 'YES' ? targetBook.yes : targetBook.no
    const entryPrice = intent.limitPrice
    if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) {
      return
    }

    const filledNow =
      intent.liquidityRole === 'taker' ||
      (sideBook?.bestAsk !== null &&
        sideBook?.bestAsk !== undefined &&
        sideBook.bestAsk <= intent.limitPrice)

    const shares = Number((intent.stakeUsd / entryPrice).toFixed(4))
    if (shares <= 0) return

    const feePerShare = polymarketFeePerShare(entryPrice, {
      spreadCents: 0,
      feePct: 0,
      takerFeeRate: POLYMARKET_FEES.crypto.takerFeeRate,
      makerRebateShare: POLYMARKET_FEES.crypto.makerRebateShare,
      liquidityRole: intent.liquidityRole,
    })
    const feeUsd = Number((shares * feePerShare).toFixed(6))

    const trade: StoredPredictionTrade = {
      id: `pt-${intent.strategyId}-${intent.slug}-${intent.outcome}-${nowMs}`,
      tenantId: this.tenantId,
      strategyId: intent.strategyId,
      lane: intent.lane,
      mode: 'paper',
      slug: intent.slug,
      timeframe: intent.timeframe,
      outcome: intent.outcome,
      liquidityRole: intent.liquidityRole,
      entryTimeMs: nowMs,
      entryPrice,
      feeUsd,
      stakeUsd: intent.stakeUsd,
      shares,
      pModel: intent.pModel,
      pCalibrated,
      markout30s: null,
      resolvedUp: null,
      won: null,
      netPnlUsd: null,
      venueOrderId:
        intent.orderType === 'GTC' &&
        !filledNow &&
        intent.cancelAtSecondsRemaining !== undefined
          ? 'paper-resting'
          : 'paper-filled',
      status: 'OPEN',
    }

    await this.store.upsertPredictionTrade(trade)
    this.tradesById.set(trade.id, trade)
    this.openTradesById.set(trade.id, trade)
    this.existingTradeKeys.add(
      makeTradeKey(intent.strategyId, intent.slug, intent.outcome),
    )

    if (
      intent.orderType === 'GTC' &&
      !filledNow &&
      intent.cancelAtSecondsRemaining !== undefined
    ) {
      this.restingOrders.set(trade.id, {
        tradeId: trade.id,
        strategyId: intent.strategyId,
        slug: intent.slug,
        timeframe: intent.timeframe,
        outcome: intent.outcome,
        mode: 'paper',
        orderType: 'GTC',
        liquidityRole: intent.liquidityRole,
        limitPrice: entryPrice,
        endTimeMs: targetWin.endTime,
        cancelAtSecondsRemaining: intent.cancelAtSecondsRemaining,
        clientOrderId: makeClientOrderId(
          intent.strategyId,
          intent.slug,
          intent.outcome,
        ),
        venueOrderId: 'paper-resting',
        filled: false,
      })
    }
  }

  private async executeLiveIntent(
    intent: StrategyIntent,
    mode: 'canary' | 'scale',
    targetWin: PolymarketWindow,
    targetBook: EngineOrderBookSnapshot,
    pCalibrated: number,
    openLivePositions: CanaryOpenPosition[],
    nowMs: number,
  ): Promise<void> {
    // Enforce PromotionReport eligibility unless audited forceOverride was granted
    if (!this.forcedOverrideStrategies.has(intent.strategyId)) {
      let report = this.latestReplayByStrategy.get(intent.strategyId) ?? null
      if (!report) {
        report = await this.runStrategyReplay(intent.strategyId)
      }
      if (!report.eligibleForCanary) {
        return
      }
    }

    const budget = checkCanaryRiskBudget(
      openLivePositions,
      this.todayLossesCount,
      this.todayLossUsd,
      this.canaryRiskConfig,
      intent.stakeUsd,
    )
    if (!budget.allowed) {
      return
    }

    const quote = toExecutableQuote(
      targetWin,
      intent.outcome,
      {
        slug: targetBook.slug,
        upTokenId: targetBook.upTokenId,
        downTokenId: targetBook.downTokenId,
        yes: targetBook.yes,
        no: targetBook.no,
        minTop5DepthUsd: targetBook.minTop5DepthUsd,
        capturedAtMs: targetBook.capturedAtMs,
      },
      nowMs,
    )
    if (!quote) return

    const clientOrderId = makeClientOrderId(
      intent.strategyId,
      intent.slug,
      intent.outcome,
    )

    const res =
      intent.orderType === 'GTC' && intent.liquidityRole === 'maker'
        ? await this.submitMakerQuoteFn({
            tenantId: this.tenantId,
            quote,
            side: intent.side,
            limitPrice: intent.limitPrice,
            stakeUsd: budget.approvedStakeUsd,
            postOnly: true,
            clientOrderId,
            nowMs,
            source: 'bot-auto',
          })
        : await this.submitTakerOrderFn({
            tenantId: this.tenantId,
            quote,
            side: intent.side,
            stakeUsd: budget.approvedStakeUsd,
            stakeUsdOverride: budget.approvedStakeUsd,
            orderType: intent.orderType,
            clientOrderId,
            nowMs,
            source: 'bot-auto',
          })

    if (!res.ok) {
      this.recordError(
        `liveOrder:${intent.strategyId}:${intent.slug}`,
        res.error ?? 'Order rejected',
      )
      return
    }

    const trade: StoredPredictionTrade = {
      id: `pt-${intent.strategyId}-${intent.slug}-${intent.outcome}-${nowMs}`,
      tenantId: this.tenantId,
      strategyId: intent.strategyId,
      lane: intent.lane,
      mode,
      slug: intent.slug,
      timeframe: intent.timeframe,
      outcome: intent.outcome,
      liquidityRole: intent.liquidityRole,
      entryTimeMs: nowMs,
      entryPrice: res.order.limitPrice,
      feeUsd: res.order.feeUsd,
      stakeUsd: res.order.stakeUsd,
      shares: res.order.shares,
      pModel: intent.pModel,
      pCalibrated,
      markout30s: null,
      resolvedUp: null,
      won: null,
      netPnlUsd: null,
      venueOrderId: res.order.venueOrderId ?? null,
      status: 'OPEN',
    }

    await this.store.upsertPredictionTrade(trade)
    this.tradesById.set(trade.id, trade)
    this.openTradesById.set(trade.id, trade)
    this.existingTradeKeys.add(
      makeTradeKey(intent.strategyId, intent.slug, intent.outcome),
    )
    openLivePositions.push({
      slug: trade.slug,
      timeframe: trade.timeframe,
      stakeUsd: trade.stakeUsd,
      asset: 'BTC',
    })

    if (
      intent.orderType === 'GTC' &&
      res.order.status === 'LIVE' &&
      intent.cancelAtSecondsRemaining !== undefined
    ) {
      this.restingOrders.set(trade.id, {
        tradeId: trade.id,
        strategyId: intent.strategyId,
        slug: intent.slug,
        timeframe: intent.timeframe,
        outcome: intent.outcome,
        mode,
        orderType: 'GTC',
        liquidityRole: intent.liquidityRole,
        limitPrice: res.order.limitPrice,
        endTimeMs: targetWin.endTime,
        cancelAtSecondsRemaining: intent.cancelAtSecondsRemaining,
        clientOrderId,
        venueOrderId: res.order.venueOrderId ?? null,
        filled: false,
      })
    }
  }

  private async executeTick(nowMs: number): Promise<void> {
    await this.hydrateFromStore(nowMs)
    this.syncUtcDayRollover(nowMs)

    await this.collector.runPollCycle(nowMs)
    const trackedRecords = this.collector.getTrackedWindows()
    const trackedBySlug = new Map(trackedRecords.map((w) => [w.slug, w]))
    const activeWindows = this.collector.getActiveWindows(nowMs)
    const activeBySlug = new Map(activeWindows.map((w) => [w.slug, w]))
    const oracle = this.oracleFeed.getSnapshot(nowMs)

    await this.supplementActiveWindows(nowMs, activeWindows, trackedBySlug)
    await this.maybeRefreshHourlyIndicators(nowMs)
    await this.maybeRecalibrate()

    await this.processRestingOrders(nowMs, activeBySlug, trackedBySlug)
    await this.captureMarkouts(nowMs, activeBySlug, trackedBySlug)
    await this.settleClosedWindows(trackedBySlug)
    await this.evaluateAutoKillSwitches(nowMs)

    await this.evaluateActiveStrategies(
      nowMs,
      oracle,
      activeWindows,
      activeBySlug,
      trackedBySlug,
    )

    this.lastTickAtMs = nowMs
    this.tickCount += 1
  }

  // -------------------------------------------------------------------------
  // Typed Facade for Ticket 08 (`botRuntime.ts` / `Predictions.tsx`)
  // -------------------------------------------------------------------------

  async haltStrategy(
    tenantId: string,
    strategyId: PredictionEngineStrategyId,
    reason: string,
    nowMs = this.nowMs(),
  ): Promise<StoredStrategyState> {
    await this.hydrateFromStore(nowMs)
    const cleanTenant = tenantId.trim() || this.tenantId
    const nextState: StoredStrategyState = {
      tenantId: cleanTenant,
      strategyId,
      mode: 'disabled',
      haltedReason: reason,
      updatedAt: nowMs,
    }
    await this.store.setStrategyModeState(nextState)
    if (cleanTenant === this.tenantId) {
      this.strategyStates.set(strategyId, nextState)
    }
    return nextState
  }

  async setPredictionStrategyMode(
    tenantId: string,
    strategyId: PredictionEngineStrategyId,
    mode: StrategyLifecycleMode,
    forceOverride = false,
    overrideReason?: string,
  ): Promise<PromotionTransitionResult & { state: StoredStrategyState }> {
    const nowMs = this.nowMs()
    await this.hydrateFromStore(nowMs)
    const cleanTenant = tenantId.trim() || this.tenantId

    const existingStates =
      cleanTenant === this.tenantId
        ? Array.from(this.strategyStates.values())
        : await this.store.getStrategyModeStates(cleanTenant)
    const def = getStrategyDefinition(strategyId)
    const currentState: StoredStrategyState = existingStates.find(
      (s) => s.strategyId === strategyId,
    ) ?? {
      tenantId: cleanTenant,
      strategyId,
      mode: def.defaultMode,
      haltedReason: null,
      updatedAt: nowMs,
    }

    const report =
      mode === 'canary' || mode === 'scale'
        ? await this.runStrategyReplay(strategyId)
        : (this.latestReplayByStrategy.get(strategyId) ?? null)

    const transition = evaluatePromotionTransition(
      currentState.mode,
      mode,
      report,
      {
        forceOverride,
        overrideReason,
      },
    )

    if (!transition.allowed) {
      return {
        ...transition,
        state: currentState,
      }
    }

    const nextState: StoredStrategyState = {
      tenantId: cleanTenant,
      strategyId,
      mode,
      haltedReason: null,
      updatedAt: nowMs,
    }
    await this.store.setStrategyModeState(nextState)
    if (cleanTenant === this.tenantId) {
      this.strategyStates.set(strategyId, nextState)
      if (transition.forcedOverride) {
        this.forcedOverrideStrategies.add(strategyId)
      } else {
        this.forcedOverrideStrategies.delete(strategyId)
      }
    }

    if (transition.requiresAudit && transition.auditDetails) {
      await this.store.appendAuditEvent({
        id: `AUD-${strategyId}-${nowMs}`,
        tenantId: cleanTenant,
        timestamp: new Date(nowMs).toISOString(),
        actor: 'operator',
        role: 'trader',
        action: transition.auditDetails.action,
        resource: strategyId,
        outcome: 'allowed',
        details: {
          fromMode: currentState.mode,
          toMode: mode,
          forcedOverride: transition.forcedOverride,
          overrideReason: transition.auditDetails.overrideReason ?? null,
          settledWindowCount: transition.auditDetails.settledWindowCount,
          wilsonLowerBoundPct: transition.auditDetails.wilsonLowerBoundPct,
          avgBreakEvenPct: transition.auditDetails.avgBreakEvenPct,
          netPnlUsd: transition.auditDetails.netPnlUsd,
          meanMarkout30s: transition.auditDetails.meanMarkout30s,
        },
      })
    }

    return {
      ...transition,
      state: nextState,
    }
  }

  updateCanaryRiskConfig(
    tenantId: string,
    config: Partial<CanaryRiskConfig>,
  ): CanaryRiskConfig {
    void tenantId
    this.canaryRiskConfig = normalizeCanaryRiskConfig({
      ...this.canaryRiskConfig,
      ...config,
    })
    return { ...this.canaryRiskConfig }
  }

  getCanaryRiskConfig(): CanaryRiskConfig {
    return { ...this.canaryRiskConfig }
  }

  getMacroBlackoutWindows(): MacroBlackoutWindow[] {
    return this.macroBlackoutWindows.map((w) => ({ ...w }))
  }

  setMacroBlackoutWindows(
    windows: readonly MacroBlackoutWindow[],
  ): MacroBlackoutWindow[] {
    this.macroBlackoutWindows = windows
      .filter((w) => Number.isFinite(w.timestampMs))
      .map((w) => ({ ...w }))
      .sort((a, b) => a.timestampMs - b.timestampMs)
    return this.getMacroBlackoutWindows()
  }

  addMacroBlackoutWindow(window: MacroBlackoutWindow): MacroBlackoutWindow[] {
    if (Number.isFinite(window.timestampMs)) {
      this.macroBlackoutWindows = [
        ...this.macroBlackoutWindows.filter(
          (w) =>
            !(
              w.timestampMs === window.timestampMs &&
              w.label === window.label
            ),
        ),
        { ...window },
      ].sort((a, b) => a.timestampMs - b.timestampMs)
    }
    return this.getMacroBlackoutWindows()
  }

  removeMacroBlackoutWindow(
    timestampMs: number,
    label?: string,
  ): MacroBlackoutWindow[] {
    this.macroBlackoutWindows = this.macroBlackoutWindows.filter((w) => {
      if (w.timestampMs !== timestampMs) return true
      if (label !== undefined && w.label !== label) return true
      return false
    })
    return this.getMacroBlackoutWindows()
  }

  async runStrategyReplay(
    strategyId: PredictionEngineStrategyId,
  ): Promise<PromotionReport> {
    const def = getStrategyDefinition(strategyId)
    const allSettled = await this.store.getPredictionWindows({
      settledOnly: true,
      order: 'asc',
      limit: 10_000,
    })

    const snapshotsBySlug = new Map<string, WindowSnapshotPoint[]>()
    for (const w of allSettled) {
      snapshotsBySlug.set(
        w.slug,
        await this.store.getPredictionSnapshots(w.slug),
      )
    }

    // Reconstruct chronological rolling 24h median sigma1m baseline
    type SigmaObservation = { ts: number; sigma: number }
    const allObs: {
      slug: string
      ts: number
      sigma: number | null
    }[] = []
    for (const w of allSettled) {
      for (const s of snapshotsBySlug.get(w.slug) ?? []) {
        allObs.push({ slug: w.slug, ts: s.capturedAtMs, sigma: s.sigma1m })
      }
    }
    allObs.sort((a, b) => a.ts - b.ts)

    const rollingWindow: SigmaObservation[] = []
    const medianSigmaBySnapKey = new Map<string, number | null>()
    for (const obs of allObs) {
      if (obs.sigma !== null && Number.isFinite(obs.sigma) && obs.sigma > 0) {
        rollingWindow.push({ ts: obs.ts, sigma: obs.sigma })
      }
      const cutoff = obs.ts - ONE_DAY_MS
      while (rollingWindow.length > 0 && rollingWindow[0].ts < cutoff) {
        rollingWindow.shift()
      }
      const med =
        rollingWindow.length >= 2
          ? computeMedian(rollingWindow.map((x) => x.sigma))
          : obs.sigma
      medianSigmaBySnapKey.set(`${obs.slug}|${obs.ts}`, med)
    }

    // Index potential parent windows for cx-nested-coherence
    const parentWindowsByTf: Record<'15m' | '1h', CollectedWindowRecord[]> = {
      '15m': [],
      '1h': [],
    }
    for (const w of allSettled) {
      if (w.timeframe === '15m' || w.timeframe === '1h') {
        parentWindowsByTf[w.timeframe].push(w)
      }
    }

    let rawHourlyCandles: Candle[] = []
    if (strategyId === 'c1h-exhaustion-limit') {
      try {
        rawHourlyCandles = await this.getHourlyCandlesFn(this.nowMs())
      } catch {
        rawHourlyCandles = []
      }
    }

    const replayInputs: CollectedWindowReplayInput[] = allSettled
      .filter((w) => def.timeframes.includes(w.timeframe))
      .map((w) => ({
        slug: w.slug,
        timeframe: w.timeframe,
        conditionId: w.conditionId ?? undefined,
        upTokenId: w.upTokenId ?? undefined,
        downTokenId: w.downTokenId ?? undefined,
        resolutionSource: w.resolutionSource,
        startTimeMs: w.startTimeMs,
        endTimeMs: w.endTimeMs,
        openTwap: w.openTwap,
        closeTwap: w.closeTwap,
        resolvedUp: w.resolvedUp,
        tickSize: w.tickSize ?? undefined,
        negRisk: w.negRisk,
        volumeUsd: w.volumeUsd,
        updatedAt: w.updatedAt,
        snapshots: (snapshotsBySlug.get(w.slug) ?? []).map((s) => ({
          slug: s.slug,
          capturedAtMs: s.capturedAtMs,
          secondsRemaining: s.secondsRemaining,
          twapPrice: s.twapPrice,
          binancePrice: s.binancePrice,
          sigma1m: s.sigma1m,
          basisBps: s.basisBps,
          yesBid: s.yesBid,
          yesAsk: s.yesAsk,
          yesDepthUsd: s.yesDepthUsd,
          noBid: s.noBid,
          noAsk: s.noAsk,
          noDepthUsd: s.noDepthUsd,
          pModelYes: s.pModelYes,
        })),
      }))

    const findNestedParent = (
      childWin: CollectedWindowReplayInput,
      snap: ReplaySnapshotPoint,
    ): NestedParentContext | undefined => {
      if (strategyId !== 'cx-nested-coherence') return undefined
      const tfs: readonly ('15m' | '1h')[] =
        childWin.timeframe === '5m'
          ? ['15m', '1h']
          : childWin.timeframe === '15m'
            ? ['1h']
            : []
      for (const pTf of tfs) {
        const parent = parentWindowsByTf[pTf].find(
          (p) =>
            p.slug !== childWin.slug &&
            p.startTimeMs <= snap.capturedAtMs &&
            snap.capturedAtMs < p.endTimeMs &&
            p.endTimeMs > childWin.endTimeMs &&
            p.openTwap !== null &&
            p.openTwap > 0,
        )
        if (!parent || parent.openTwap === null) continue
        const pSnaps = snapshotsBySlug.get(parent.slug) ?? []
        let bestSnap: WindowSnapshotPoint | null = null
        for (const ps of pSnaps) {
          if (ps.capturedAtMs <= snap.capturedAtMs) {
            bestSnap = ps
          } else {
            break
          }
        }
        if (!bestSnap || snap.capturedAtMs - bestSnap.capturedAtMs > 10_000) {
          continue
        }
        const parentBook = buildEngineBookFromSnapshot(
          parent.slug,
          bestSnap,
          parent.upTokenId ?? 'parent-up',
          parent.downTokenId ?? 'parent-down',
        )
        return {
          slug: parent.slug,
          timeframe: parent.timeframe,
          resolutionSource: parent.resolutionSource,
          openTwap: parent.openTwap,
          secondsRemaining: Math.max(
            0,
            (parent.endTimeMs - snap.capturedAtMs) / 1_000,
          ),
          secondsElapsed: Math.max(
            0,
            (snap.capturedAtMs - parent.startTimeMs) / 1_000,
          ),
          book: parentBook,
        }
      }
      return undefined
    }

    const buildReplayContext = (
      win: CollectedWindowReplayInput,
      snap: ReplaySnapshotPoint,
      calibratedPYes: number | null,
      nestedParentOverride?: NestedParentContext,
    ): StrategyContext => {
      const activeSpot =
        win.resolutionSource === 'binance-1h-candle'
          ? (snap.binancePrice ?? snap.twapPrice ?? 0)
          : (snap.twapPrice ?? 0)
      const nowcast =
        win.openTwap !== null &&
        win.openTwap > 0 &&
        activeSpot > 0 &&
        snap.sigma1m !== null &&
        snap.sigma1m > 0
          ? computeNowcast({
              openTwap: win.openTwap,
              currentTwap: activeSpot,
              secondsRemaining: snap.secondsRemaining,
              sigma1m: snap.sigma1m,
            })
          : {
              z: 0,
              pRawYes: 0.5,
              pBlendedYes: 0.5,
              remainingMinutes: Math.max(1 / 60, snap.secondsRemaining / 60),
              valid: false,
            }

      const median24h =
        medianSigmaBySnapKey.get(`${win.slug}|${snap.capturedAtMs}`) ??
        snap.sigma1m

      const oracle: OracleSnapshot = {
        nowMs: snap.capturedAtMs,
        chainlinkPrice: snap.twapPrice,
        chainlinkTwap60s: snap.twapPrice,
        chainlinkUpdatedAtMs: snap.capturedAtMs,
        chainlinkStaleMs: 0,
        binancePrice: snap.binancePrice ?? snap.twapPrice,
        binanceUpdatedAtMs: snap.capturedAtMs,
        binanceStaleMs: 0,
        basisBps: snap.basisBps ?? 0,
        sigma1m: snap.sigma1m,
        median24hSigma1m: median24h,
        connectedRtds: true,
        connectedBinance: true,
      }

      const book = buildEngineBookFromSnapshot(
        win.slug,
        snap,
        win.upTokenId ?? 'replay-up',
        win.downTokenId ?? 'replay-down',
      )

      const hourlyInd =
        strategyId === 'c1h-exhaustion-limit' && rawHourlyCandles.length > 0
          ? computeClosedHourlyIndicators(
              rawHourlyCandles,
              snap.capturedAtMs,
            )
          : undefined

      return {
        slug: win.slug,
        timeframe: win.timeframe,
        resolutionSource: win.resolutionSource,
        startTimeMs: win.startTimeMs,
        endTimeMs: win.endTimeMs,
        openTwap: win.openTwap,
        secondsRemaining: snap.secondsRemaining,
        secondsElapsed: Math.max(
          0,
          (snap.capturedAtMs - win.startTimeMs) / 1_000,
        ),
        oracle,
        book,
        nowcast,
        calibratedPYes,
        hourlyIndicators: hourlyInd,
        nestedParent:
          nestedParentOverride !== undefined
            ? nestedParentOverride
            : findNestedParent(win, snap),
        macroBlackoutWindows: this.macroBlackoutWindows,
        nowMs: snap.capturedAtMs,
        stakeUsd: this.canaryRiskConfig.stakeUsd,
      }
    }

    const childReplayInputs =
      strategyId === 'cx-nested-coherence'
        ? replayInputs.filter(
            (w) => w.timeframe === '5m' || w.timeframe === '15m',
          )
        : []

    const report = runWindowReplay(
      replayInputs,
      (snap, calibratedPYes, win): ReplayIntent | null => {
        const directIntents = def
          .evaluate(buildReplayContext(win, snap, calibratedPYes))
          .filter((intent) => intent.slug === win.slug)

        const candidateIntents: StrategyIntent[] = [...directIntents]

        if (
          strategyId === 'cx-nested-coherence' &&
          (win.timeframe === '15m' || win.timeframe === '1h')
        ) {
          const parentSnapIdx = win.snapshots.findIndex(
            (s) => s.capturedAtMs === snap.capturedAtMs,
          )
          const nextParentSnapTs =
            parentSnapIdx >= 0 && parentSnapIdx + 1 < win.snapshots.length
              ? win.snapshots[parentSnapIdx + 1].capturedAtMs
              : Number.POSITIVE_INFINITY

          for (const child of childReplayInputs) {
            if (child.slug === win.slug || child.endTimeMs >= win.endTimeMs) {
              continue
            }
            if (win.timeframe === '15m' && child.timeframe !== '5m') {
              continue
            }
            if (
              child.endTimeMs <= snap.capturedAtMs ||
              child.startTimeMs >= nextParentSnapTs
            ) {
              continue
            }

            for (const cs of child.snapshots) {
              if (
                cs.capturedAtMs < snap.capturedAtMs ||
                cs.capturedAtMs >= nextParentSnapTs ||
                cs.capturedAtMs - snap.capturedAtMs > 10_000
              ) {
                continue
              }
              const nestedParent = findNestedParent(child, cs)
              if (nestedParent?.slug !== win.slug) continue

              const childIntents = def.evaluate(
                buildReplayContext(child, cs, null, nestedParent),
              )
              for (const ci of childIntents) {
                if (ci.slug === win.slug) {
                  candidateIntents.push(ci)
                }
              }
            }
          }
        }

        if (candidateIntents.length === 0) return null
        const best = candidateIntents.reduce((a, b) =>
          b.expectedEdgePerShare > a.expectedEdgePerShare ? b : a,
        )
        return {
          outcome: best.outcome,
          liquidityRole: best.liquidityRole,
          limitPrice: best.limitPrice,
          stakeUsd: best.stakeUsd,
          reason: best.reason,
        }
      },
      {
        strategyId,
        stakeUsd: this.canaryRiskConfig.stakeUsd,
      },
    )

    this.latestReplayByStrategy.set(strategyId, report)
    return report
  }

  async getPredictionEngineStatus(
    tenantId = this.tenantId,
  ): Promise<PredictionEngineStatus> {
    const nowMs = this.nowMs()
    await this.hydrateFromStore(nowMs)
    this.syncUtcDayRollover(nowMs)

    const cleanTenant = tenantId.trim() || this.tenantId
    const oracle = this.oracleFeed.getSnapshot(nowMs)
    const collector = this.collector.getCollectorStats()
    const exchangeSnap = getExchangeStatusSnapshot(cleanTenant)

    const trades =
      cleanTenant === this.tenantId
        ? Array.from(this.tradesById.values())
        : await this.store.getPredictionTrades(cleanTenant, { limit: 5_000 })

    const openTrades = trades
      .filter((t) => t.status === 'OPEN')
      .sort((a, b) => b.entryTimeMs - a.entryTimeMs)

    const recentSettledTrades = trades
      .filter((t) => t.status === 'SETTLED')
      .sort((a, b) => b.entryTimeMs - a.entryTimeMs)
      .slice(0, 100)

    const openLivePositions: CanaryOpenPosition[] = openTrades
      .filter((t) => t.mode === 'canary' || t.mode === 'scale')
      .map((t) => ({
        slug: t.slug,
        timeframe: t.timeframe,
        stakeUsd: t.stakeUsd,
        asset: 'BTC',
      }))

    const budgetCheck = checkCanaryRiskBudget(
      openLivePositions,
      this.todayLossesCount,
      this.todayLossUsd,
      this.canaryRiskConfig,
      0,
    )

    const [c5m, c15m, c1h] = await Promise.all([
      this.store.getSettledWindowCount('5m'),
      this.store.getSettledWindowCount('15m'),
      this.store.getSettledWindowCount('1h'),
    ])
    const settledCountsByTf: Record<EngineTimeframe, number> = {
      '5m': c5m,
      '15m': c15m,
      '1h': c1h,
    }

    const savedStates =
      cleanTenant === this.tenantId
        ? Array.from(this.strategyStates.values())
        : await this.store.getStrategyModeStates(cleanTenant)
    const savedStateMap = new Map(savedStates.map((s) => [s.strategyId, s]))

    const strategies: PredictionStrategyStatusView[] = STRATEGY_REGISTRY.map(
      (def) => {
        const st = savedStateMap.get(def.id)
        const stratTrades = trades.filter((t) => t.strategyId === def.id)
        const openCount = stratTrades.filter((t) => t.status === 'OPEN').length
        const settled = stratTrades.filter((t) => t.status === 'SETTLED')
        const canceledCount = stratTrades.filter(
          (t) => t.status === 'CANCELED',
        ).length
        const wins = settled.filter((t) => t.won === true).length
        const netPnlUsd = Number(
          settled
            .reduce((sum, t) => sum + (t.netPnlUsd ?? 0), 0)
            .toFixed(4),
        )
        const markouts = settled
          .map((t) => t.markout30s)
          .filter((m): m is number => m !== null && Number.isFinite(m))
        const recent30Markouts = markouts.slice(-MARKOUT_WINDOW_TRADES)
        const meanMarkout30s =
          recent30Markouts.length > 0
            ? Number(
                (
                  recent30Markouts.reduce((s, v) => s + v, 0) /
                  recent30Markouts.length
                ).toFixed(6),
              )
            : null

        const settledSamplesForTimeframe = Math.max(
          ...def.timeframes.map((tf) => settledCountsByTf[tf]),
        )

        return {
          id: def.id,
          name: def.name,
          lane: def.lane,
          timeframes: def.timeframes,
          description: def.description,
          defaultRole: def.defaultRole,
          defaultMode: def.defaultMode,
          mode: st?.mode ?? def.defaultMode,
          haltedReason: st?.haltedReason ?? null,
          updatedAt: st?.updatedAt ?? null,
          settledSamplesForTimeframe,
          targetSamples: TARGET_PROMOTION_SAMPLES,
          forcedOverride: this.forcedOverrideStrategies.has(def.id),
          liveStats: {
            openCount,
            settledCount: settled.length,
            canceledCount,
            wins,
            winRatePct:
              settled.length > 0
                ? Number(((wins / settled.length) * 100).toFixed(2))
                : 0,
            netPnlUsd,
            meanMarkout30s,
            markoutSampleCount: recent30Markouts.length,
            consecutiveHighErrorCount:
              this.consecutiveHighErrorByStrategy.get(def.id) ?? 0,
          },
          latestReplay: this.latestReplayByStrategy.get(def.id) ?? null,
        }
      },
    )

    // Aggregate latest safety gate status across active timeframes
    const gateResults = (['5m', '15m', '1h'] as const)
      .map((tf) => this.latestGatesByTimeframe[tf])
      .filter((g): g is SafetyGateResult => g !== null)

    let gates: PredictionGateTelemetry
    if (gateResults.length > 0) {
      const codeSet = new Set<GateFailureCode>()
      const reasonList: string[] = []
      for (const g of gateResults) {
        for (const c of g.codes) codeSet.add(c)
        for (const r of g.reasons) reasonList.push(r)
      }
      gates = {
        g1Passed: gateResults.every((g) => g.g1Passed),
        g2Passed: gateResults.every((g) => g.g2Passed),
        avoidPassed: gateResults.every((g) => g.avoidPassed),
        failureCodes: Array.from(codeSet),
        reasons: Array.from(new Set(reasonList)),
        byTimeframe: { ...this.latestGatesByTimeframe },
      }
    } else {
      // Cold-start gate telemetry directly against current oracle/macro state
      const coldCtx: StrategyContext = {
        slug: 'cold-check',
        timeframe: '5m',
        resolutionSource: 'chainlink-twap-60s',
        startTimeMs: nowMs - 60_000,
        endTimeMs: nowMs + 240_000,
        openTwap: oracle.chainlinkTwap60s,
        secondsRemaining: 240,
        secondsElapsed: 60,
        oracle,
        book: {
          slug: 'cold-check',
          upTokenId: '',
          downTokenId: '',
          yes: null,
          no: null,
          minTop5DepthUsd: 0,
          capturedAtMs: nowMs,
        },
        nowcast: {
          z: 0,
          pRawYes: 0.5,
          pBlendedYes: 0.5,
          remainingMinutes: 4,
          valid: false,
        },
        macroBlackoutWindows: this.macroBlackoutWindows,
        nowMs,
      }
      const coldGate = evaluateSafetyGates(coldCtx, {
        liquidityRole: 'taker',
        config: this.safetyGateConfig,
      })
      gates = {
        g1Passed: coldGate.g1Passed,
        g2Passed: coldGate.g2Passed,
        avoidPassed: coldGate.avoidPassed,
        failureCodes: coldGate.codes,
        reasons: coldGate.reasons,
        byTimeframe: { ...this.latestGatesByTimeframe },
      }
    }

    return {
      running: this.running,
      tenantId: cleanTenant,
      lastTickAtMs: this.lastTickAtMs,
      tickCount: this.tickCount,
      lastError: this.lastError,
      oracle,
      collector: {
        ...collector,
        settledCountsByTimeframe: settledCountsByTf,
      },
      hourlyIndicators: this.hourlyIndicators
        ? { ...this.hourlyIndicators }
        : null,
      gates,
      canaryRisk: {
        config: { ...this.canaryRiskConfig },
        todayLossesCount: this.todayLossesCount,
        todayLossUsd: this.todayLossUsd,
        openBtcExposureUsd: budgetCheck.openBtcExposureUsd,
        remainingBtcExposureUsd: budgetCheck.remainingBtcExposureUsd,
        killSwitchActive: exchangeSnap.killSwitchActive,
      },
      macroBlackoutWindows: this.getMacroBlackoutWindows(),
      calibrators: {
        '5m': {
          mode: this.calibrators['5m'].curve.mode,
          sampleCount: this.calibrators['5m'].curve.sampleCount,
          lastSettledCount: this.calibrators['5m'].lastSettledCount,
        },
        '15m': {
          mode: this.calibrators['15m'].curve.mode,
          sampleCount: this.calibrators['15m'].curve.sampleCount,
          lastSettledCount: this.calibrators['15m'].lastSettledCount,
        },
        '1h': {
          mode: this.calibrators['1h'].curve.mode,
          sampleCount: this.calibrators['1h'].curve.sampleCount,
          lastSettledCount: this.calibrators['1h'].lastSettledCount,
        },
      },
      strategies,
      openTrades,
      recentSettledTrades,
    }
  }
}

let singletonRunner: PredictionRunner | null = null

export function getPredictionRunner(
  options?: PredictionRunnerOptions,
): PredictionRunner {
  if (!singletonRunner) {
    singletonRunner = new PredictionRunner(options)
  }
  return singletonRunner
}

export function stopPredictionRunnerIfActive(): void {
  singletonRunner?.stop()
}

export function resetPredictionRunner(
  options?: PredictionRunnerOptions,
): PredictionRunner {
  if (singletonRunner) {
    singletonRunner.stop()
  }
  singletonRunner = new PredictionRunner(options)
  return singletonRunner
}
