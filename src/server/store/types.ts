/**
 * Storage contract (`StateStore`) shared across SQLite (`node:sqlite` WAL default)
 * and PostgreSQL / TimescaleDB adapters (`P0-4`).
 */
import type { BotEngineState, StrategyPreset } from '../../botEngine'
import type { LiquidityRole } from '../../predictionMarket'
import type { PredictionOutcome } from '../../predictions'
import type {
  TrainingProgress,
  TrainingRunMetrics,
  TrainingRunRecord,
  TrainingRunStatus,
  TrainingFoldResult,
  TrainingEquityPoint,
  TrainingTradeRecord,
} from '../../training/types'
import type { Candle, Interval, Strategy } from '../../types'
import type {
  ExchangeOrderRecord,
  PersistedExchangeState,
} from '../exchangeAdapter'
import type { LedgerEntry } from '../ledger/doubleEntryLedger'
import type { PolymarketTimeframe, ResolutionSource } from '../polymarketAdapter'

export type StoreDriver = 'sqlite' | 'postgres'

export type PersistedTenantEnvelope = {
  schemaVersion: number
  savedAt: string
  tenantId: string
  presetId: string
  customStrategy?: Strategy
  customPreset?: StrategyPreset
  isRunning: boolean
  isPaused?: boolean
  state: BotEngineState
  exchange?: PersistedExchangeState
}

export type RuntimeEventType =
  | 'SIGNAL'
  | 'TRADE'
  | 'RISK'
  | 'INFO'
  | 'ERROR'
  | 'OPERATOR'

export type RuntimeEventSeverity = 'info' | 'warn' | 'error' | 'critical'

export type RuntimeEventRecord = {
  id: string
  tenantId: string
  timestamp: string
  type: RuntimeEventType
  severity: RuntimeEventSeverity
  message: string
  payload?: Record<string, unknown> | null
  source: string
  correlationId?: string | null
}

export type RuntimeEventQueryOptions = {
  types?: RuntimeEventType[]
  q?: string
  limit?: number
  before?: string
}

export type OrderQueryOptions = {
  status?: string
  pair?: string
  side?: 'BUY' | 'SELL'
  source?: 'manual' | 'bot-auto'
  presetId?: string
  mode?: string
  limit?: number
  before?: string
}

export type TrainingRunQueryOptions = {
  presetId?: string
  limit?: number
}

export type UpdateTrainingRunPatch = {
  status?: TrainingRunStatus
  candleCount?: number
  progress?: TrainingProgress | null
  metrics?: TrainingRunMetrics | null
  folds?: TrainingFoldResult[] | null
  equity?: TrainingEquityPoint[] | null
  trades?: TrainingTradeRecord[] | null
  dataSource?: string
  error?: string | null
  completedAt?: string | null
}

export type StrategyAuditAssumptions = {
  commissionPct: number
  slippagePct: number
  initialBalance: number
  allowShort: boolean
}

export type StrategyAuditMetrics = {
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

export type StrategyAuditRecord = {
  id: string
  tenantId: string
  runId: string
  createdAt: string
  presetId: string
  presetName: string
  domain: 'crypto-spot' | 'prediction-market'
  pair: string
  timeframe: Interval
  fromTimeMs: number
  toTimeMs: number
  candles: number
  metrics: StrategyAuditMetrics
  assumptions: StrategyAuditAssumptions
  dataSource: string
}

export type AuditEventRecord = {
  id: string
  tenantId: string
  timestamp: string
  actor: string
  role: string
  action: string
  resource: string
  outcome: 'allowed' | 'denied' | 'error'
  details?: Record<string, string | number | boolean | null>
}

export type PredictionStrategyLane = 'high-hit-rate' | 'edge'

export type PredictionStrategyMode =
  | 'disabled'
  | 'research'
  | 'paper'
  | 'canary'
  | 'scale'

export type PredictionTradeMode = 'paper' | 'canary' | 'scale'

export type PredictionTradeStatus = 'OPEN' | 'SETTLED' | 'CANCELED'

export type CollectedWindowRecord = {
  slug: string
  timeframe: PolymarketTimeframe
  conditionId: string | null
  upTokenId: string | null
  downTokenId: string | null
  resolutionSource: ResolutionSource
  startTimeMs: number
  endTimeMs: number
  openTwap: number | null
  closeTwap: number | null
  resolvedUp: boolean | null
  tickSize: number | null
  negRisk: boolean
  volumeUsd: number | null
  updatedAt: number
}

export type WindowSnapshotPoint = {
  slug: string
  capturedAtMs: number
  secondsRemaining: number
  twapPrice: number | null
  binancePrice: number | null
  sigma1m: number | null
  basisBps: number | null
  yesBid: number | null
  yesAsk: number | null
  yesDepthUsd: number | null
  noBid: number | null
  noAsk: number | null
  noDepthUsd: number | null
  pModelYes: number | null
}

export type StoredPredictionTrade = {
  id: string
  tenantId: string
  strategyId: string
  lane: PredictionStrategyLane
  mode: PredictionTradeMode
  slug: string
  timeframe: PolymarketTimeframe
  outcome: PredictionOutcome
  liquidityRole: LiquidityRole
  entryTimeMs: number
  entryPrice: number
  feeUsd: number
  stakeUsd: number
  shares: number
  pModel: number
  pCalibrated: number
  markout30s: number | null
  resolvedUp: boolean | null
  won: boolean | null
  netPnlUsd: number | null
  venueOrderId: string | null
  status: PredictionTradeStatus
}

export type StoredStrategyState = {
  tenantId: string
  strategyId: string
  mode: PredictionStrategyMode
  haltedReason: string | null
  updatedAt: number
}

export type PredictionWindowQueryOptions = {
  timeframe?: PolymarketTimeframe
  slug?: string
  settledOnly?: boolean
  unsettledOnly?: boolean
  sinceMs?: number
  untilMs?: number
  order?: 'asc' | 'desc'
  limit?: number
}

export type PredictionTradeQueryOptions = {
  strategyId?: string
  slug?: string
  timeframe?: PolymarketTimeframe
  mode?: PredictionTradeMode
  status?: PredictionTradeStatus
  sinceEntryTimeMs?: number
  limit?: number
}

export type RetentionPruneReport = {
  retentionDays: number
  cutoffIso: string
  deletedOrders: number
  deletedAuditEvents: number
  deletedCandles: number
  windowRetentionDays: number
  windowCutoffIso: string
  deletedPredictionWindows: number
  deletedPredictionSnapshots: number
  deletedPredictionTrades: number
}

export interface StateStore {
  readonly driver: StoreDriver
  readonly location: string
  migrate(): Promise<number>
  getSchemaVersion(): Promise<number>

  saveTenantSnapshot(envelope: PersistedTenantEnvelope): Promise<void>
  loadTenantSnapshot(tenantId: string): Promise<PersistedTenantEnvelope | null>
  listTenantIds(): Promise<string[]>

  appendOrder(tenantId: string, order: ExchangeOrderRecord): Promise<void>
  getOrders(tenantId: string, limit?: number): Promise<ExchangeOrderRecord[]>
  queryOrders(
    tenantId: string,
    options?: OrderQueryOptions,
  ): Promise<ExchangeOrderRecord[]>
  findOrderById(
    tenantId: string,
    orderId: string,
  ): Promise<ExchangeOrderRecord | null>
  findOrderByClientOrderId(
    tenantId: string,
    clientOrderId: string,
  ): Promise<ExchangeOrderRecord | null>

  appendLedgerEntry(entry: LedgerEntry): Promise<void>
  getLedgerEntries(tenantId: string, limit?: number): Promise<LedgerEntry[]>

  appendAuditEvent(event: AuditEventRecord): Promise<void>
  getAuditEvents(tenantId: string, limit?: number): Promise<AuditEventRecord[]>

  appendRuntimeEvent(event: RuntimeEventRecord): Promise<void>
  getRuntimeEvents(
    tenantId: string,
    options?: RuntimeEventQueryOptions,
  ): Promise<RuntimeEventRecord[]>

  appendStrategyAudit(record: StrategyAuditRecord): Promise<void>
  getLatestStrategyAudits(
    tenantId: string,
    limit?: number,
  ): Promise<StrategyAuditRecord[]>

  upsertCandles(
    pair: string,
    interval: Interval,
    candles: readonly Candle[],
  ): Promise<number>
  getCandles(
    pair: string,
    interval: Interval,
    limit: number,
  ): Promise<Candle[]>
  getCandlesRange(
    pair: string,
    interval: Interval,
    fromTimeMs: number,
    toTimeMs: number,
    limit?: number,
  ): Promise<Candle[]>

  createTrainingRun(
    record: TrainingRunRecord,
  ): Promise<{ record: TrainingRunRecord; deduplicated: boolean }>
  updateTrainingRun(
    tenantId: string,
    id: string,
    patch: UpdateTrainingRunPatch,
  ): Promise<TrainingRunRecord | null>
  getTrainingRunById(
    tenantId: string,
    id: string,
  ): Promise<TrainingRunRecord | null>
  listTrainingRuns(
    tenantId: string,
    options?: TrainingRunQueryOptions,
  ): Promise<TrainingRunRecord[]>
  markRunningTrainingRunsInterrupted(tenantId?: string): Promise<number>

  upsertPredictionWindow(window: CollectedWindowRecord): Promise<void>
  getPredictionWindows(
    options?: PredictionWindowQueryOptions,
  ): Promise<CollectedWindowRecord[]>
  getSettledWindowCount(timeframe?: PolymarketTimeframe): Promise<number>

  appendPredictionSnapshot(snapshot: WindowSnapshotPoint): Promise<void>
  getPredictionSnapshots(slug: string): Promise<WindowSnapshotPoint[]>

  upsertPredictionTrade(trade: StoredPredictionTrade): Promise<void>
  getPredictionTrades(
    tenantId: string,
    options?: PredictionTradeQueryOptions,
  ): Promise<StoredPredictionTrade[]>

  setStrategyModeState(state: StoredStrategyState): Promise<void>
  getStrategyModeStates(tenantId: string): Promise<StoredStrategyState[]>

  pruneRetention(
    retentionDays?: number,
    nowMs?: number,
    windowRetentionDays?: number,
  ): Promise<RetentionPruneReport>
  close(): Promise<void>
}
