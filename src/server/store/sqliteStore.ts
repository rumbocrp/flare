/**
 * Persistent transactional SQL store backed by Node's built-in `node:sqlite`
 * (`DatabaseSync` in WAL mode) (`P0-4`).
 *
 * Serves as the zero-dependency ACID storage engine for local/single-node
 * deployments and CI, implementing the exact same `StateStore` contract as
 * `PostgresStateStore`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  StrategyFamily,
  TrainingAssumptions,
  TrainingConfig,
  TrainingEquityPoint,
  TrainingFoldResult,
  TrainingProgress,
  TrainingRunKind,
  TrainingRunMetrics,
  TrainingRunRecord,
  TrainingRunStatus,
  TrainingTradeRecord,
} from '../../training/types'
import type { Candle, Interval } from '../../types'
import type { ExchangeOrderRecord } from '../exchangeAdapter'
import {
  validateEntryBalance,
  LedgerImbalanceError,
  type LedgerEntry,
  type LedgerPosting,
} from '../ledger/doubleEntryLedger'
import type { PolymarketTimeframe, ResolutionSource } from '../polymarketAdapter'
import type {
  AuditEventRecord,
  CollectedWindowRecord,
  ExchangePositionMode,
  ExchangePositionQueryOptions,
  ExchangePositionRecord,
  ExchangePositionStatus,
  OrderQueryOptions,
  PersistedTenantEnvelope,
  PredictionStrategyLane,
  PredictionStrategyMode,
  PredictionTradeMode,
  PredictionTradeQueryOptions,
  PredictionTradeStatus,
  PredictionWindowQueryOptions,
  RetentionPruneReport,
  RuntimeEventQueryOptions,
  RuntimeEventRecord,
  RuntimeEventSeverity,
  RuntimeEventType,
  StateStore,
  StoredPredictionTrade,
  StoredStrategyState,
  StrategyAuditAssumptions,
  StrategyAuditMetrics,
  StrategyAuditRecord,
  TrainingRunQueryOptions,
  UpdateTrainingRunPatch,
  WindowSnapshotPoint,
} from './types'

const DEFAULT_RETENTION_DAYS = 90
const DEFAULT_WINDOW_RETENTION_DAYS = 365

const SQLITE_MIGRATIONS: readonly {
  version: number
  name: string
  statements: readonly string[]
}[] = [
  {
    version: 1,
    name: 'initial_tenant_state_orders_ledger_audit',
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tenant_runtime_state (
        tenant_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        preset_id TEXT NOT NULL,
        is_running INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS orders (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        client_order_id TEXT,
        venue_order_id TEXT,
        timestamp TEXT NOT NULL,
        pair TEXT NOT NULL,
        side TEXT NOT NULL,
        notional_usd REAL NOT NULL,
        price REAL NOT NULL,
        quantity REAL NOT NULL,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        source TEXT NOT NULL,
        reason TEXT,
        PRIMARY KEY (tenant_id, id)
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_tenant_client_order_id
        ON orders (tenant_id, client_order_id)
        WHERE client_order_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_orders_tenant_timestamp
        ON orders (tenant_id, timestamp DESC)`,
      `CREATE TABLE IF NOT EXISTS ledger_entries (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        kind TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        description TEXT NOT NULL,
        postings_json TEXT NOT NULL,
        metadata_json TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_tenant_timestamp
        ON ledger_entries (tenant_id, timestamp ASC)`,
      `CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        actor TEXT NOT NULL,
        role TEXT NOT NULL,
        action TEXT NOT NULL,
        resource TEXT NOT NULL,
        outcome TEXT NOT NULL,
        details_json TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_audit_tenant_timestamp
        ON audit_events (tenant_id, timestamp DESC)`,
    ],
  },
  {
    version: 2,
    name: 'candles_timeseries_archive',
    statements: [
      `CREATE TABLE IF NOT EXISTS candles_archive (
        pair TEXT NOT NULL,
        interval TEXT NOT NULL,
        open_time_ms INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL,
        ingested_at TEXT NOT NULL,
        PRIMARY KEY (pair, interval, open_time_ms)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_candles_pair_interval_time
        ON candles_archive (pair, interval, open_time_ms DESC)`,
    ],
  },
  {
    version: 3,
    name: 'prediction_engine_windows_snapshots_trades',
    statements: [
      `CREATE TABLE IF NOT EXISTS prediction_windows (
        slug TEXT PRIMARY KEY,
        timeframe TEXT NOT NULL,
        condition_id TEXT,
        up_token_id TEXT,
        down_token_id TEXT,
        resolution_source TEXT NOT NULL,
        start_time_ms INTEGER NOT NULL,
        end_time_ms INTEGER NOT NULL,
        open_twap REAL,
        close_twap REAL,
        resolved_up INTEGER,
        tick_size REAL,
        neg_risk INTEGER NOT NULL DEFAULT 0,
        volume_usd REAL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pred_windows_tf_start
        ON prediction_windows (timeframe, start_time_ms DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_pred_windows_resolved_end
        ON prediction_windows (resolved_up, end_time_ms DESC)`,
      `CREATE TABLE IF NOT EXISTS prediction_window_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL,
        captured_at_ms INTEGER NOT NULL,
        seconds_remaining REAL NOT NULL,
        twap_price REAL,
        binance_price REAL,
        sigma_1m REAL,
        basis_bps REAL,
        yes_bid REAL,
        yes_ask REAL,
        yes_depth_usd REAL,
        no_bid REAL,
        no_ask REAL,
        no_depth_usd REAL,
        p_model_yes REAL,
        UNIQUE(slug, captured_at_ms)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pred_snapshots_slug_time
        ON prediction_window_snapshots (slug, captured_at_ms ASC)`,
      `CREATE INDEX IF NOT EXISTS idx_pred_snapshots_captured_at
        ON prediction_window_snapshots (captured_at_ms DESC)`,
      `CREATE TABLE IF NOT EXISTS prediction_shadow_trades (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        lane TEXT NOT NULL,
        mode TEXT NOT NULL,
        slug TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        outcome TEXT NOT NULL,
        liquidity_role TEXT NOT NULL,
        entry_time_ms INTEGER NOT NULL,
        entry_price REAL NOT NULL,
        fee_usd REAL NOT NULL,
        stake_usd REAL NOT NULL,
        shares REAL NOT NULL,
        p_model REAL NOT NULL,
        p_calibrated REAL NOT NULL,
        markout_30s REAL,
        resolved_up INTEGER,
        won INTEGER,
        net_pnl_usd REAL,
        venue_order_id TEXT,
        status TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pred_trades_tenant_entry
        ON prediction_shadow_trades (tenant_id, entry_time_ms DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_pred_trades_tenant_strategy_status
        ON prediction_shadow_trades (tenant_id, strategy_id, status, entry_time_ms DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_pred_trades_slug
        ON prediction_shadow_trades (slug)`,
      `CREATE TABLE IF NOT EXISTS prediction_strategy_states (
        tenant_id TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        halted_reason TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, strategy_id)
      )`,
    ],
  },
  {
    version: 4,
    name: 'runtime_events_strategy_audits_and_order_fills',
    statements: [
      `ALTER TABLE orders ADD COLUMN filled_qty REAL`,
      `ALTER TABLE orders ADD COLUMN avg_price REAL`,
      `ALTER TABLE orders ADD COLUMN fee REAL`,
      `ALTER TABLE orders ADD COLUMN fee_asset TEXT`,
      `ALTER TABLE orders ADD COLUMN updated_at TEXT`,
      `CREATE TABLE IF NOT EXISTS runtime_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT,
        source TEXT NOT NULL,
        correlation_id TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_runtime_events_tenant_ts
        ON runtime_events (tenant_id, timestamp DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_runtime_events_tenant_type_ts
        ON runtime_events (tenant_id, type, timestamp DESC)`,
      `CREATE TABLE IF NOT EXISTS strategy_audits (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        preset_id TEXT NOT NULL,
        preset_name TEXT NOT NULL,
        domain TEXT NOT NULL,
        pair TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        from_time_ms INTEGER NOT NULL,
        to_time_ms INTEGER NOT NULL,
        candles INTEGER NOT NULL,
        metrics_json TEXT NOT NULL,
        assumptions_json TEXT NOT NULL,
        data_source TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_strategy_audits_tenant_created
        ON strategy_audits (tenant_id, created_at DESC)`,
    ],
  },
  {
    version: 5,
    name: 'training_runs_and_order_preset_attribution',
    statements: [
      `ALTER TABLE orders ADD COLUMN preset_id TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_orders_tenant_preset_ts
        ON orders (tenant_id, preset_id, timestamp DESC)`,
      `CREATE TABLE IF NOT EXISTS training_runs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        client_run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        preset_id TEXT NOT NULL,
        strategy_family TEXT NOT NULL,
        pair TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        from_time_ms INTEGER NOT NULL,
        to_time_ms INTEGER NOT NULL,
        candle_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        config_json TEXT NOT NULL,
        progress_json TEXT,
        metrics_json TEXT,
        folds_json TEXT,
        equity_json TEXT,
        trades_json TEXT,
        assumptions_json TEXT NOT NULL,
        data_source TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_training_runs_client
        ON training_runs (tenant_id, client_run_id)`,
      `CREATE INDEX IF NOT EXISTS idx_training_runs_tenant_created
        ON training_runs (tenant_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_training_runs_preset_created
        ON training_runs (tenant_id, preset_id, created_at DESC)`,
    ],
  },
  {
    version: 6,
    name: 'exchange_positions_pnl_attribution',
    statements: [
      `CREATE TABLE IF NOT EXISTS exchange_positions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        preset_id TEXT,
        pair TEXT NOT NULL,
        side TEXT NOT NULL,
        status TEXT NOT NULL,
        entry_order_id TEXT NOT NULL,
        entry_venue_order_id TEXT,
        exit_order_id TEXT,
        exit_venue_order_id TEXT,
        entry_qty REAL NOT NULL,
        exit_qty REAL,
        entry_avg_price REAL NOT NULL,
        exit_avg_price REAL,
        entry_fee_usd REAL NOT NULL DEFAULT 0,
        exit_fee_usd REAL NOT NULL DEFAULT 0,
        stop_price REAL,
        target_price REAL,
        protection_order_id TEXT,
        realized_pnl_usd REAL,
        r_multiple REAL,
        exit_reason TEXT,
        opened_at TEXT NOT NULL,
        closed_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_exchange_positions_tenant_mode_status
        ON exchange_positions (tenant_id, mode, status, opened_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_exchange_positions_tenant_preset_closed
        ON exchange_positions (tenant_id, preset_id, closed_at DESC)`,
    ],
  },
]

function mapExchangePositionRow(
  row: Record<string, unknown>,
): ExchangePositionRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    mode: String(row.mode) as ExchangePositionMode,
    presetId: toNullableString(row.preset_id),
    pair: String(row.pair),
    side: String(row.side) === 'SHORT' ? 'SHORT' : 'LONG',
    status: String(row.status) as ExchangePositionStatus,
    entryOrderId: String(row.entry_order_id),
    entryVenueOrderId: toNullableString(row.entry_venue_order_id),
    exitOrderId: toNullableString(row.exit_order_id),
    exitVenueOrderId: toNullableString(row.exit_venue_order_id),
    entryQty: Number(row.entry_qty),
    exitQty: toNullableNumber(row.exit_qty),
    entryAvgPrice: Number(row.entry_avg_price),
    exitAvgPrice: toNullableNumber(row.exit_avg_price),
    entryFeeUsd: Number(row.entry_fee_usd ?? 0),
    exitFeeUsd: Number(row.exit_fee_usd ?? 0),
    stopPrice: toNullableNumber(row.stop_price),
    targetPrice: toNullableNumber(row.target_price),
    protectionOrderId: toNullableString(row.protection_order_id),
    realizedPnlUsd: toNullableNumber(row.realized_pnl_usd),
    rMultiple: toNullableNumber(row.r_multiple),
    exitReason: toNullableString(row.exit_reason),
    openedAt: String(row.opened_at),
    closedAt: toNullableString(row.closed_at),
  }
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function toNullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value
  return Number(value) !== 0
}

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return String(value)
}

function mapPredictionWindowRow(
  row: Record<string, unknown>,
): CollectedWindowRecord {
  return {
    slug: String(row.slug),
    timeframe: String(row.timeframe) as PolymarketTimeframe,
    conditionId: toNullableString(row.condition_id),
    upTokenId: toNullableString(row.up_token_id),
    downTokenId: toNullableString(row.down_token_id),
    resolutionSource: String(row.resolution_source) as ResolutionSource,
    startTimeMs: Number(row.start_time_ms),
    endTimeMs: Number(row.end_time_ms),
    openTwap: toNullableNumber(row.open_twap),
    closeTwap: toNullableNumber(row.close_twap),
    resolvedUp: toNullableBoolean(row.resolved_up),
    tickSize: toNullableNumber(row.tick_size),
    negRisk: Number(row.neg_risk ?? 0) !== 0,
    volumeUsd: toNullableNumber(row.volume_usd),
    updatedAt: Number(row.updated_at),
  }
}

function mapWindowSnapshotRow(
  row: Record<string, unknown>,
): WindowSnapshotPoint {
  return {
    slug: String(row.slug),
    capturedAtMs: Number(row.captured_at_ms),
    secondsRemaining: Number(row.seconds_remaining),
    twapPrice: toNullableNumber(row.twap_price),
    binancePrice: toNullableNumber(row.binance_price),
    sigma1m: toNullableNumber(row.sigma_1m),
    basisBps: toNullableNumber(row.basis_bps),
    yesBid: toNullableNumber(row.yes_bid),
    yesAsk: toNullableNumber(row.yes_ask),
    yesDepthUsd: toNullableNumber(row.yes_depth_usd),
    noBid: toNullableNumber(row.no_bid),
    noAsk: toNullableNumber(row.no_ask),
    noDepthUsd: toNullableNumber(row.no_depth_usd),
    pModelYes: toNullableNumber(row.p_model_yes),
  }
}

function mapPredictionTradeRow(
  row: Record<string, unknown>,
): StoredPredictionTrade {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    strategyId: String(row.strategy_id),
    lane: String(row.lane) as PredictionStrategyLane,
    mode: String(row.mode) as PredictionTradeMode,
    slug: String(row.slug),
    timeframe: String(row.timeframe) as PolymarketTimeframe,
    outcome: row.outcome === 'NO' ? 'NO' : 'YES',
    liquidityRole: row.liquidity_role === 'maker' ? 'maker' : 'taker',
    entryTimeMs: Number(row.entry_time_ms),
    entryPrice: Number(row.entry_price),
    feeUsd: Number(row.fee_usd),
    stakeUsd: Number(row.stake_usd),
    shares: Number(row.shares),
    pModel: Number(row.p_model),
    pCalibrated: Number(row.p_calibrated),
    markout30s: toNullableNumber(row.markout_30s),
    resolvedUp: toNullableBoolean(row.resolved_up),
    won: toNullableBoolean(row.won),
    netPnlUsd: toNullableNumber(row.net_pnl_usd),
    venueOrderId: toNullableString(row.venue_order_id),
    status: String(row.status) as PredictionTradeStatus,
  }
}

function mapStrategyStateRow(
  row: Record<string, unknown>,
): StoredStrategyState {
  return {
    tenantId: String(row.tenant_id),
    strategyId: String(row.strategy_id),
    mode: String(row.mode) as PredictionStrategyMode,
    haltedReason: toNullableString(row.halted_reason),
    updatedAt: Number(row.updated_at),
  }
}

function mapOrderRow(row: Record<string, unknown>): ExchangeOrderRecord {
  const filledQty = toNullableNumber(row.filled_qty)
  const avgPrice = toNullableNumber(row.avg_price)
  const fee = toNullableNumber(row.fee)
  const feeAsset = toNullableString(row.fee_asset)
  const presetId = toNullableString(row.preset_id)
  const updatedAt = toNullableString(row.updated_at)

  return {
    id: String(row.id),
    clientOrderId:
      row.client_order_id !== null && row.client_order_id !== undefined
        ? String(row.client_order_id)
        : undefined,
    venueOrderId:
      row.venue_order_id !== null && row.venue_order_id !== undefined
        ? String(row.venue_order_id)
        : undefined,
    timestamp: String(row.timestamp),
    updatedAt: updatedAt ?? undefined,
    pair: String(row.pair),
    side: row.side === 'SELL' ? 'SELL' : 'BUY',
    notionalUsd: Number(row.notional_usd),
    price: Number(row.price),
    avgPrice: avgPrice ?? undefined,
    quantity: Number(row.quantity),
    filledQty: filledQty ?? undefined,
    fee: fee ?? undefined,
    feeAsset: feeAsset ?? undefined,
    presetId: presetId ?? undefined,
    status: String(row.status) as ExchangeOrderRecord['status'],
    mode: String(row.mode) as ExchangeOrderRecord['mode'],
    source: row.source === 'bot-auto' ? 'bot-auto' : 'manual',
    reason:
      row.reason !== null && row.reason !== undefined
        ? String(row.reason)
        : undefined,
  }
}

function mapTrainingRunRow(row: Record<string, unknown>): TrainingRunRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    clientRunId: String(row.client_run_id),
    kind: String(row.kind) as TrainingRunKind,
    presetId: String(row.preset_id),
    strategyFamily: String(row.strategy_family) as StrategyFamily,
    pair: String(row.pair),
    timeframe: String(row.timeframe) as Interval,
    fromTimeMs: Number(row.from_time_ms),
    toTimeMs: Number(row.to_time_ms),
    candleCount: Number(row.candle_count),
    status: String(row.status) as TrainingRunStatus,
    config: JSON.parse(String(row.config_json)) as TrainingConfig,
    progress:
      row.progress_json !== null && row.progress_json !== undefined
        ? (JSON.parse(String(row.progress_json)) as TrainingProgress)
        : null,
    metrics:
      row.metrics_json !== null && row.metrics_json !== undefined
        ? (JSON.parse(String(row.metrics_json)) as TrainingRunMetrics)
        : null,
    folds:
      row.folds_json !== null && row.folds_json !== undefined
        ? (JSON.parse(String(row.folds_json)) as TrainingFoldResult[])
        : null,
    equity:
      row.equity_json !== null && row.equity_json !== undefined
        ? (JSON.parse(String(row.equity_json)) as TrainingEquityPoint[])
        : null,
    trades:
      row.trades_json !== null && row.trades_json !== undefined
        ? (JSON.parse(String(row.trades_json)) as TrainingTradeRecord[])
        : null,
    assumptions: JSON.parse(String(row.assumptions_json)) as TrainingAssumptions,
    dataSource: String(row.data_source),
    error: toNullableString(row.error),
    createdAt: String(row.created_at),
    completedAt: toNullableString(row.completed_at),
  }
}

function mapRuntimeEventRow(row: Record<string, unknown>): RuntimeEventRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    timestamp: String(row.timestamp),
    type: String(row.type) as RuntimeEventType,
    severity: String(row.severity) as RuntimeEventSeverity,
    message: String(row.message),
    payload:
      row.payload_json !== null && row.payload_json !== undefined
        ? (JSON.parse(String(row.payload_json)) as Record<string, unknown>)
        : null,
    source: String(row.source),
    correlationId: toNullableString(row.correlation_id),
  }
}

function mapStrategyAuditRow(
  row: Record<string, unknown>,
): StrategyAuditRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    runId: String(row.run_id),
    createdAt: String(row.created_at),
    presetId: String(row.preset_id),
    presetName: String(row.preset_name),
    domain:
      row.domain === 'prediction-market' ? 'prediction-market' : 'crypto-spot',
    pair: String(row.pair),
    timeframe: String(row.timeframe) as Interval,
    fromTimeMs: Number(row.from_time_ms),
    toTimeMs: Number(row.to_time_ms),
    candles: Number(row.candles),
    metrics: JSON.parse(String(row.metrics_json)) as StrategyAuditMetrics,
    assumptions: JSON.parse(
      String(row.assumptions_json),
    ) as StrategyAuditAssumptions,
    dataSource: String(row.data_source),
  }
}

export class SqliteStateStore implements StateStore {
  readonly driver = 'sqlite' as const
  readonly location: string
  private readonly db: DatabaseSync
  private closed = false

  constructor(filePath: string) {
    this.location = filePath === ':memory:' ? ':memory:' : path.resolve(filePath)
    if (this.location !== ':memory:') {
      fs.mkdirSync(path.dirname(this.location), { recursive: true })
    }
    this.db = new DatabaseSync(this.location)
    if (this.location !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA synchronous = NORMAL')
    }
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrateSync()
  }

  private migrateSync(): number {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`,
    )

    const appliedRows = this.db
      .prepare('SELECT version FROM schema_migrations')
      .all() as { version: number }[]
    const applied = new Set(appliedRows.map((r) => Number(r.version)))

    let latest = 0
    for (const version of applied) {
      if (version > latest) latest = version
    }

    for (const migration of SQLITE_MIGRATIONS) {
      if (applied.has(migration.version)) continue
      this.db.exec('BEGIN')
      try {
        for (const stmt of migration.statements) {
          this.db.exec(stmt)
        }
        this.db
          .prepare(
            'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
          )
          .run(migration.version, migration.name, new Date().toISOString())
        this.db.exec('COMMIT')
        if (migration.version > latest) latest = migration.version
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    }

    return latest
  }

  async migrate(): Promise<number> {
    return this.migrateSync()
  }

  async getSchemaVersion(): Promise<number> {
    const row = this.db
      .prepare('SELECT MAX(version) AS v FROM schema_migrations')
      .get() as { v: number | null } | undefined
    return Number(row?.v ?? 0)
  }

  saveTenantSnapshotSync(envelope: PersistedTenantEnvelope): void {
    if (this.closed) return
    const payload = JSON.stringify(envelope)
    this.db
      .prepare(
        `INSERT INTO tenant_runtime_state
          (tenant_id, schema_version, preset_id, is_running, payload_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET
          schema_version = excluded.schema_version,
          preset_id = excluded.preset_id,
          is_running = excluded.is_running,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        envelope.tenantId,
        envelope.schemaVersion,
        envelope.presetId,
        envelope.isRunning ? 1 : 0,
        payload,
        envelope.savedAt,
      )
  }

  async saveTenantSnapshot(envelope: PersistedTenantEnvelope): Promise<void> {
    this.saveTenantSnapshotSync(envelope)
  }

  loadTenantSnapshotSync(tenantId: string): PersistedTenantEnvelope | null {
    if (this.closed) return null
    const row = this.db
      .prepare(
        'SELECT payload_json FROM tenant_runtime_state WHERE tenant_id = ?',
      )
      .get(tenantId) as { payload_json: string } | undefined
    if (!row) return null
    return JSON.parse(row.payload_json) as PersistedTenantEnvelope
  }

  async loadTenantSnapshot(
    tenantId: string,
  ): Promise<PersistedTenantEnvelope | null> {
    return this.loadTenantSnapshotSync(tenantId)
  }

  async listTenantIds(): Promise<string[]> {
    const rows = this.db
      .prepare(
        'SELECT tenant_id FROM tenant_runtime_state ORDER BY tenant_id ASC',
      )
      .all() as { tenant_id: string }[]
    return rows.map((r) => String(r.tenant_id))
  }

  appendOrderSync(tenantId: string, order: ExchangeOrderRecord): void {
    if (this.closed) return
    this.db
      .prepare(
        `INSERT INTO orders (
          id, tenant_id, client_order_id, venue_order_id, timestamp,
          pair, side, notional_usd, price, quantity, status, mode, source, reason,
          filled_qty, avg_price, fee, fee_asset, updated_at, preset_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, id) DO UPDATE SET
          venue_order_id = excluded.venue_order_id,
          status = excluded.status,
          reason = excluded.reason,
          filled_qty = excluded.filled_qty,
          avg_price = excluded.avg_price,
          fee = excluded.fee,
          fee_asset = excluded.fee_asset,
          updated_at = excluded.updated_at,
          preset_id = COALESCE(excluded.preset_id, orders.preset_id)`,
      )
      .run(
        order.id,
        tenantId,
        order.clientOrderId ?? null,
        order.venueOrderId ?? null,
        order.timestamp,
        order.pair,
        order.side,
        order.notionalUsd,
        order.price,
        order.quantity,
        order.status,
        order.mode,
        order.source,
        order.reason ?? null,
        order.filledQty ?? null,
        order.avgPrice ?? null,
        order.fee ?? null,
        order.feeAsset ?? null,
        order.updatedAt ?? order.timestamp,
        order.presetId ?? null,
      )
  }

  async appendOrder(
    tenantId: string,
    order: ExchangeOrderRecord,
  ): Promise<void> {
    this.appendOrderSync(tenantId, order)
  }

  async getOrders(
    tenantId: string,
    limit = 100,
  ): Promise<ExchangeOrderRecord[]> {
    return this.queryOrders(tenantId, { limit })
  }

  async queryOrders(
    tenantId: string,
    options: OrderQueryOptions = {},
  ): Promise<ExchangeOrderRecord[]> {
    if (this.closed) return []
    const clauses: string[] = ['tenant_id = ?']
    const params: (string | number)[] = [tenantId]

    if (options.status) {
      clauses.push('status = ?')
      params.push(options.status)
    }
    if (options.pair) {
      clauses.push('pair = ?')
      params.push(options.pair)
    }
    if (options.side) {
      clauses.push('side = ?')
      params.push(options.side)
    }
    if (options.source) {
      clauses.push('source = ?')
      params.push(options.source)
    }
    if (options.presetId) {
      clauses.push('preset_id = ?')
      params.push(options.presetId)
    }
    if (options.mode) {
      clauses.push('mode = ?')
      params.push(options.mode)
    }
    if (options.before) {
      clauses.push('timestamp < ?')
      params.push(options.before)
    }

    const rawLimit =
      options.limit !== undefined && Number.isFinite(options.limit)
        ? options.limit
        : 100
    const safeLimit = Math.max(1, Math.min(1_000, Math.round(rawLimit)))
    params.push(safeLimit)

    const rows = this.db
      .prepare(
        `SELECT * FROM orders
         WHERE ${clauses.join(' AND ')}
         ORDER BY timestamp DESC, id DESC
         LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[]
    return rows.map(mapOrderRow)
  }

  async findOrderById(
    tenantId: string,
    orderId: string,
  ): Promise<ExchangeOrderRecord | null> {
    if (this.closed) return null
    const row = this.db
      .prepare(
        `SELECT * FROM orders
         WHERE tenant_id = ? AND id = ?
         LIMIT 1`,
      )
      .get(tenantId, orderId) as Record<string, unknown> | undefined
    return row ? mapOrderRow(row) : null
  }

  async findOrderByClientOrderId(
    tenantId: string,
    clientOrderId: string,
  ): Promise<ExchangeOrderRecord | null> {
    if (this.closed) return null
    const row = this.db
      .prepare(
        `SELECT * FROM orders
         WHERE tenant_id = ? AND client_order_id = ?
         LIMIT 1`,
      )
      .get(tenantId, clientOrderId) as Record<string, unknown> | undefined
    return row ? mapOrderRow(row) : null
  }

  appendRuntimeEventSync(event: RuntimeEventRecord): void {
    if (this.closed) return
    this.db
      .prepare(
        `INSERT OR IGNORE INTO runtime_events (
          id, tenant_id, timestamp, type, severity, message, payload_json, source, correlation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.tenantId,
        event.timestamp,
        event.type,
        event.severity,
        event.message,
        event.payload ? JSON.stringify(event.payload) : null,
        event.source,
        event.correlationId ?? null,
      )
  }

  async appendRuntimeEvent(event: RuntimeEventRecord): Promise<void> {
    this.appendRuntimeEventSync(event)
  }

  async getRuntimeEvents(
    tenantId: string,
    options: RuntimeEventQueryOptions = {},
  ): Promise<RuntimeEventRecord[]> {
    if (this.closed) return []
    const clauses: string[] = ['tenant_id = ?']
    const params: (string | number)[] = [tenantId]

    if (Array.isArray(options.types) && options.types.length > 0) {
      const placeholders = options.types.map(() => '?').join(', ')
      clauses.push(`type IN (${placeholders})`)
      params.push(...options.types)
    }
    if (options.q && options.q.trim().length > 0) {
      const needle = `%${options.q.trim().toLowerCase()}%`
      clauses.push(
        '(LOWER(message) LIKE ? OR LOWER(source) LIKE ? OR LOWER(COALESCE(correlation_id, \'\')) LIKE ?)',
      )
      params.push(needle, needle, needle)
    }
    if (options.before) {
      clauses.push('timestamp < ?')
      params.push(options.before)
    }

    const rawLimit =
      options.limit !== undefined && Number.isFinite(options.limit)
        ? options.limit
        : 200
    const safeLimit = Math.max(1, Math.min(2_000, Math.round(rawLimit)))
    params.push(safeLimit)

    const rows = this.db
      .prepare(
        `SELECT * FROM runtime_events
         WHERE ${clauses.join(' AND ')}
         ORDER BY timestamp DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[]
    return rows.map(mapRuntimeEventRow)
  }

  async appendStrategyAudit(record: StrategyAuditRecord): Promise<void> {
    if (this.closed) return
    this.db
      .prepare(
        `INSERT OR REPLACE INTO strategy_audits (
          id, tenant_id, run_id, created_at, preset_id, preset_name, domain,
          pair, timeframe, from_time_ms, to_time_ms, candles, metrics_json,
          assumptions_json, data_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.tenantId,
        record.runId,
        record.createdAt,
        record.presetId,
        record.presetName,
        record.domain,
        record.pair,
        record.timeframe,
        record.fromTimeMs,
        record.toTimeMs,
        record.candles,
        JSON.stringify(record.metrics),
        JSON.stringify(record.assumptions),
        record.dataSource,
      )
  }

  async getLatestStrategyAudits(
    tenantId: string,
    limit = 64,
  ): Promise<StrategyAuditRecord[]> {
    if (this.closed) return []
    const safeLimit = Math.max(1, Math.min(256, Math.round(limit)))
    const rows = this.db
      .prepare(
        `SELECT * FROM strategy_audits
         WHERE tenant_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(tenantId, safeLimit) as Record<string, unknown>[]
    return rows.map(mapStrategyAuditRow)
  }

  appendLedgerEntrySync(entry: LedgerEntry): void {
    if (this.closed) return
    const imbalances = validateEntryBalance(entry)
    if (imbalances.length > 0) {
      throw new LedgerImbalanceError(imbalances)
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO ledger_entries (
          id, tenant_id, timestamp, kind, reference_id,
          description, postings_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.tenantId,
        entry.timestamp,
        entry.kind,
        entry.referenceId,
        entry.description,
        JSON.stringify(entry.postings),
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      )
  }

  async appendLedgerEntry(entry: LedgerEntry): Promise<void> {
    this.appendLedgerEntrySync(entry)
  }

  getLedgerEntriesSync(tenantId: string, limit = 500): LedgerEntry[] {
    if (this.closed) return []
    const safeLimit = Math.max(1, Math.min(5_000, Math.round(limit)))
    const rows = this.db
      .prepare(
        `SELECT * FROM ledger_entries
         WHERE tenant_id = ?
         ORDER BY timestamp ASC, rowid ASC
         LIMIT ?`,
      )
      .all(tenantId, safeLimit) as Record<string, unknown>[]
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      timestamp: String(row.timestamp),
      kind: String(row.kind) as LedgerEntry['kind'],
      referenceId: String(row.reference_id),
      description: String(row.description),
      postings: JSON.parse(String(row.postings_json)) as LedgerPosting[],
      metadata:
        row.metadata_json !== null && row.metadata_json !== undefined
          ? (JSON.parse(String(row.metadata_json)) as Record<
              string,
              string | number | boolean | null
            >)
          : undefined,
    }))
  }

  async getLedgerEntries(
    tenantId: string,
    limit = 500,
  ): Promise<LedgerEntry[]> {
    return this.getLedgerEntriesSync(tenantId, limit)
  }

  appendAuditEventSync(event: AuditEventRecord): void {
    if (this.closed) return
    this.db
      .prepare(
        `INSERT OR IGNORE INTO audit_events (
          id, tenant_id, timestamp, actor, role, action, resource, outcome, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.tenantId,
        event.timestamp,
        event.actor,
        event.role,
        event.action,
        event.resource,
        event.outcome,
        event.details ? JSON.stringify(event.details) : null,
      )
  }

  async appendAuditEvent(event: AuditEventRecord): Promise<void> {
    this.appendAuditEventSync(event)
  }

  async getAuditEvents(
    tenantId: string,
    limit = 200,
  ): Promise<AuditEventRecord[]> {
    const safeLimit = Math.max(1, Math.min(2_000, Math.round(limit)))
    const rows = this.db
      .prepare(
        `SELECT * FROM audit_events
         WHERE tenant_id = ?
         ORDER BY timestamp DESC, rowid DESC
         LIMIT ?`,
      )
      .all(tenantId, safeLimit) as Record<string, unknown>[]
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      timestamp: String(row.timestamp),
      actor: String(row.actor),
      role: String(row.role),
      action: String(row.action),
      resource: String(row.resource),
      outcome: String(row.outcome) as AuditEventRecord['outcome'],
      details:
        row.details_json !== null && row.details_json !== undefined
          ? (JSON.parse(String(row.details_json)) as Record<
              string,
              string | number | boolean | null
            >)
          : undefined,
    }))
  }

  async upsertCandles(
    pair: string,
    interval: Interval,
    candles: readonly Candle[],
  ): Promise<number> {
    if (this.closed || candles.length === 0) return 0
    const nowIso = new Date().toISOString()
    const stmt = this.db.prepare(
      `INSERT INTO candles_archive (
        pair, interval, open_time_ms, open, high, low, close, volume, ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pair, interval, open_time_ms) DO UPDATE SET
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume,
        ingested_at = excluded.ingested_at`,
    )
    this.db.exec('BEGIN')
    try {
      for (const c of candles) {
        stmt.run(
          pair,
          interval,
          c.time,
          c.open,
          c.high,
          c.low,
          c.close,
          c.volume,
          nowIso,
        )
      }
      this.db.exec('COMMIT')
      return candles.length
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async getCandles(
    pair: string,
    interval: Interval,
    limit: number,
  ): Promise<Candle[]> {
    const safeLimit = Math.max(1, Math.min(2_000, Math.round(limit)))
    const rows = this.db
      .prepare(
        `SELECT open_time_ms, open, high, low, close, volume
         FROM candles_archive
         WHERE pair = ? AND interval = ?
         ORDER BY open_time_ms DESC
         LIMIT ?`,
      )
      .all(pair, interval, safeLimit) as Record<string, unknown>[]
    return rows
      .reverse()
      .map((r) => ({
        time: Number(r.open_time_ms),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      }))
  }

  async getCandlesRange(
    pair: string,
    interval: Interval,
    fromTimeMs: number,
    toTimeMs: number,
    limit = 5_000,
  ): Promise<Candle[]> {
    if (this.closed) return []
    const safeLimit = Math.max(1, Math.min(5_000, Math.round(limit)))
    const rows = this.db
      .prepare(
        `SELECT open_time_ms, open, high, low, close, volume
         FROM candles_archive
         WHERE pair = ? AND interval = ? AND open_time_ms >= ? AND open_time_ms <= ?
         ORDER BY open_time_ms ASC
         LIMIT ?`,
      )
      .all(pair, interval, fromTimeMs, toTimeMs, safeLimit) as Record<
      string,
      unknown
    >[]
    return rows.map((r) => ({
      time: Number(r.open_time_ms),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }))
  }

  async createTrainingRun(
    record: TrainingRunRecord,
  ): Promise<{ record: TrainingRunRecord; deduplicated: boolean }> {
    if (this.closed) return { record, deduplicated: false }
    const existingRow = this.db
      .prepare(
        `SELECT * FROM training_runs
         WHERE tenant_id = ? AND client_run_id = ?
         LIMIT 1`,
      )
      .get(record.tenantId, record.clientRunId) as
      | Record<string, unknown>
      | undefined
    if (existingRow) {
      return { record: mapTrainingRunRow(existingRow), deduplicated: true }
    }

    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO training_runs (
          id, tenant_id, client_run_id, kind, preset_id, strategy_family,
          pair, timeframe, from_time_ms, to_time_ms, candle_count, status,
          config_json, progress_json, metrics_json, folds_json, equity_json,
          trades_json, assumptions_json, data_source, error, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.tenantId,
        record.clientRunId,
        record.kind,
        record.presetId,
        record.strategyFamily,
        record.pair,
        record.timeframe,
        record.fromTimeMs,
        record.toTimeMs,
        record.candleCount,
        record.status,
        JSON.stringify(record.config),
        record.progress ? JSON.stringify(record.progress) : null,
        record.metrics ? JSON.stringify(record.metrics) : null,
        record.folds ? JSON.stringify(record.folds) : null,
        record.equity ? JSON.stringify(record.equity) : null,
        record.trades ? JSON.stringify(record.trades) : null,
        JSON.stringify(record.assumptions),
        record.dataSource,
        record.error ?? null,
        record.createdAt,
        record.completedAt ?? null,
      )

    if (Number(res.changes ?? 0) === 0) {
      const winner = this.db
        .prepare(
          `SELECT * FROM training_runs
           WHERE tenant_id = ? AND client_run_id = ?
           LIMIT 1`,
        )
        .get(record.tenantId, record.clientRunId) as
        | Record<string, unknown>
        | undefined
      if (winner) {
        return { record: mapTrainingRunRow(winner), deduplicated: true }
      }
    }

    const stored = await this.getTrainingRunById(record.tenantId, record.id)
    return { record: stored ?? record, deduplicated: false }
  }

  async updateTrainingRun(
    tenantId: string,
    id: string,
    patch: UpdateTrainingRunPatch,
  ): Promise<TrainingRunRecord | null> {
    if (this.closed) return null
    const sets: string[] = []
    const params: (string | number | null)[] = []

    if (patch.status !== undefined) {
      sets.push('status = ?')
      params.push(patch.status)
    }
    if (patch.candleCount !== undefined) {
      sets.push('candle_count = ?')
      params.push(patch.candleCount)
    }
    if (patch.progress !== undefined) {
      sets.push('progress_json = ?')
      params.push(patch.progress ? JSON.stringify(patch.progress) : null)
    }
    if (patch.metrics !== undefined) {
      sets.push('metrics_json = ?')
      params.push(patch.metrics ? JSON.stringify(patch.metrics) : null)
    }
    if (patch.folds !== undefined) {
      sets.push('folds_json = ?')
      params.push(patch.folds ? JSON.stringify(patch.folds) : null)
    }
    if (patch.equity !== undefined) {
      sets.push('equity_json = ?')
      params.push(patch.equity ? JSON.stringify(patch.equity) : null)
    }
    if (patch.trades !== undefined) {
      sets.push('trades_json = ?')
      params.push(patch.trades ? JSON.stringify(patch.trades) : null)
    }
    if (patch.dataSource !== undefined) {
      sets.push('data_source = ?')
      params.push(patch.dataSource)
    }
    if (patch.error !== undefined) {
      sets.push('error = ?')
      params.push(patch.error)
    }
    if (patch.completedAt !== undefined) {
      sets.push('completed_at = ?')
      params.push(patch.completedAt)
    }

    if (sets.length === 0) {
      return this.getTrainingRunById(tenantId, id)
    }

    params.push(tenantId, id)
    this.db
      .prepare(
        `UPDATE training_runs
         SET ${sets.join(', ')}
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(...params)

    return this.getTrainingRunById(tenantId, id)
  }

  async getTrainingRunById(
    tenantId: string,
    id: string,
  ): Promise<TrainingRunRecord | null> {
    if (this.closed) return null
    const row = this.db
      .prepare(
        `SELECT * FROM training_runs
         WHERE tenant_id = ? AND id = ?
         LIMIT 1`,
      )
      .get(tenantId, id) as Record<string, unknown> | undefined
    return row ? mapTrainingRunRow(row) : null
  }

  async listTrainingRuns(
    tenantId: string,
    options: TrainingRunQueryOptions = {},
  ): Promise<TrainingRunRecord[]> {
    if (this.closed) return []
    const clauses: string[] = ['tenant_id = ?']
    const params: (string | number)[] = [tenantId]

    if (options.presetId) {
      clauses.push('preset_id = ?')
      params.push(options.presetId)
    }
    const rawLimit =
      options.limit !== undefined && Number.isFinite(options.limit)
        ? options.limit
        : 50
    const safeLimit = Math.max(1, Math.min(500, Math.round(rawLimit)))
    params.push(safeLimit)

    const rows = this.db
      .prepare(
        `SELECT * FROM training_runs
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[]
    return rows.map(mapTrainingRunRow)
  }

  async markRunningTrainingRunsInterrupted(tenantId?: string): Promise<number> {
    if (this.closed) return 0
    const nowIso = new Date().toISOString()
    const res = tenantId
      ? this.db
          .prepare(
            `UPDATE training_runs
             SET status = 'interrupted',
                 error = COALESCE(error, 'Run interrupted before completion'),
                 completed_at = COALESCE(completed_at, ?)
             WHERE status = 'running' AND tenant_id = ?`,
          )
          .run(nowIso, tenantId)
      : this.db
          .prepare(
            `UPDATE training_runs
             SET status = 'interrupted',
                 error = COALESCE(error, 'Run interrupted before completion'),
                 completed_at = COALESCE(completed_at, ?)
             WHERE status = 'running'`,
          )
          .run(nowIso)
    return Number(res.changes ?? 0)
  }

  async upsertPredictionWindow(window: CollectedWindowRecord): Promise<void> {
    if (this.closed) return
    this.db
      .prepare(
        `INSERT INTO prediction_windows (
          slug, timeframe, condition_id, up_token_id, down_token_id,
          resolution_source, start_time_ms, end_time_ms, open_twap, close_twap,
          resolved_up, tick_size, neg_risk, volume_usd, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
          timeframe = excluded.timeframe,
          condition_id = COALESCE(excluded.condition_id, prediction_windows.condition_id),
          up_token_id = COALESCE(excluded.up_token_id, prediction_windows.up_token_id),
          down_token_id = COALESCE(excluded.down_token_id, prediction_windows.down_token_id),
          resolution_source = CASE
            WHEN excluded.resolution_source = 'unknown' THEN prediction_windows.resolution_source
            ELSE excluded.resolution_source
          END,
          start_time_ms = excluded.start_time_ms,
          end_time_ms = excluded.end_time_ms,
          open_twap = COALESCE(excluded.open_twap, prediction_windows.open_twap),
          close_twap = COALESCE(excluded.close_twap, prediction_windows.close_twap),
          resolved_up = COALESCE(excluded.resolved_up, prediction_windows.resolved_up),
          tick_size = COALESCE(excluded.tick_size, prediction_windows.tick_size),
          neg_risk = excluded.neg_risk,
          volume_usd = COALESCE(excluded.volume_usd, prediction_windows.volume_usd),
          updated_at = excluded.updated_at`,
      )
      .run(
        window.slug,
        window.timeframe,
        window.conditionId ?? null,
        window.upTokenId ?? null,
        window.downTokenId ?? null,
        window.resolutionSource,
        window.startTimeMs,
        window.endTimeMs,
        window.openTwap ?? null,
        window.closeTwap ?? null,
        window.resolvedUp === null ? null : window.resolvedUp ? 1 : 0,
        window.tickSize ?? null,
        window.negRisk ? 1 : 0,
        window.volumeUsd ?? null,
        window.updatedAt,
      )
  }

  async getPredictionWindows(
    options: PredictionWindowQueryOptions = {},
  ): Promise<CollectedWindowRecord[]> {
    if (this.closed) return []
    if (options.settledOnly && options.unsettledOnly) return []

    const clauses: string[] = []
    const params: (string | number)[] = []

    if (options.timeframe) {
      clauses.push('timeframe = ?')
      params.push(options.timeframe)
    }
    if (options.slug) {
      clauses.push('slug = ?')
      params.push(options.slug)
    }
    if (options.settledOnly) {
      clauses.push('resolved_up IS NOT NULL')
    }
    if (options.unsettledOnly) {
      clauses.push('resolved_up IS NULL')
    }
    if (options.sinceMs !== undefined && Number.isFinite(options.sinceMs)) {
      clauses.push('start_time_ms >= ?')
      params.push(options.sinceMs)
    }
    if (options.untilMs !== undefined && Number.isFinite(options.untilMs)) {
      clauses.push('start_time_ms <= ?')
      params.push(options.untilMs)
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const dir = options.order === 'asc' ? 'ASC' : 'DESC'
    const rawLimit =
      options.limit !== undefined && Number.isFinite(options.limit)
        ? options.limit
        : 2_000
    const safeLimit = Math.max(1, Math.min(10_000, Math.round(rawLimit)))
    params.push(safeLimit)

    const rows = this.db
      .prepare(
        `SELECT * FROM prediction_windows
         ${whereSql}
         ORDER BY start_time_ms ${dir}, slug ${dir}
         LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[]
    return rows.map(mapPredictionWindowRow)
  }

  async getSettledWindowCount(
    timeframe?: PolymarketTimeframe,
  ): Promise<number> {
    if (this.closed) return 0
    const row = timeframe
      ? (this.db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM prediction_windows
             WHERE resolved_up IS NOT NULL AND timeframe = ?`,
          )
          .get(timeframe) as { cnt: number } | undefined)
      : (this.db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM prediction_windows
             WHERE resolved_up IS NOT NULL`,
          )
          .get() as { cnt: number } | undefined)
    return Number(row?.cnt ?? 0)
  }

  async appendPredictionSnapshot(snapshot: WindowSnapshotPoint): Promise<void> {
    if (this.closed) return
    this.db
      .prepare(
        `INSERT INTO prediction_window_snapshots (
          slug, captured_at_ms, seconds_remaining, twap_price, binance_price,
          sigma_1m, basis_bps, yes_bid, yes_ask, yes_depth_usd,
          no_bid, no_ask, no_depth_usd, p_model_yes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(slug, captured_at_ms) DO UPDATE SET
          seconds_remaining = excluded.seconds_remaining,
          twap_price = excluded.twap_price,
          binance_price = excluded.binance_price,
          sigma_1m = excluded.sigma_1m,
          basis_bps = excluded.basis_bps,
          yes_bid = excluded.yes_bid,
          yes_ask = excluded.yes_ask,
          yes_depth_usd = excluded.yes_depth_usd,
          no_bid = excluded.no_bid,
          no_ask = excluded.no_ask,
          no_depth_usd = excluded.no_depth_usd,
          p_model_yes = excluded.p_model_yes`,
      )
      .run(
        snapshot.slug,
        snapshot.capturedAtMs,
        snapshot.secondsRemaining,
        snapshot.twapPrice ?? null,
        snapshot.binancePrice ?? null,
        snapshot.sigma1m ?? null,
        snapshot.basisBps ?? null,
        snapshot.yesBid ?? null,
        snapshot.yesAsk ?? null,
        snapshot.yesDepthUsd ?? null,
        snapshot.noBid ?? null,
        snapshot.noAsk ?? null,
        snapshot.noDepthUsd ?? null,
        snapshot.pModelYes ?? null,
      )
  }

  async getPredictionSnapshots(slug: string): Promise<WindowSnapshotPoint[]> {
    if (this.closed) return []
    const rows = this.db
      .prepare(
        `SELECT * FROM prediction_window_snapshots
         WHERE slug = ?
         ORDER BY captured_at_ms ASC`,
      )
      .all(slug) as Record<string, unknown>[]
    return rows.map(mapWindowSnapshotRow)
  }

  async upsertPredictionTrade(trade: StoredPredictionTrade): Promise<void> {
    if (this.closed) return
    this.db
      .prepare(
        `INSERT INTO prediction_shadow_trades (
          id, tenant_id, strategy_id, lane, mode, slug, timeframe, outcome,
          liquidity_role, entry_time_ms, entry_price, fee_usd, stake_usd,
          shares, p_model, p_calibrated, markout_30s, resolved_up, won,
          net_pnl_usd, venue_order_id, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          tenant_id = excluded.tenant_id,
          strategy_id = excluded.strategy_id,
          lane = excluded.lane,
          mode = excluded.mode,
          slug = excluded.slug,
          timeframe = excluded.timeframe,
          outcome = excluded.outcome,
          liquidity_role = excluded.liquidity_role,
          entry_time_ms = excluded.entry_time_ms,
          entry_price = excluded.entry_price,
          fee_usd = excluded.fee_usd,
          stake_usd = excluded.stake_usd,
          shares = excluded.shares,
          p_model = excluded.p_model,
          p_calibrated = excluded.p_calibrated,
          markout_30s = excluded.markout_30s,
          resolved_up = excluded.resolved_up,
          won = excluded.won,
          net_pnl_usd = excluded.net_pnl_usd,
          venue_order_id = excluded.venue_order_id,
          status = excluded.status`,
      )
      .run(
        trade.id,
        trade.tenantId,
        trade.strategyId,
        trade.lane,
        trade.mode,
        trade.slug,
        trade.timeframe,
        trade.outcome,
        trade.liquidityRole,
        trade.entryTimeMs,
        trade.entryPrice,
        trade.feeUsd,
        trade.stakeUsd,
        trade.shares,
        trade.pModel,
        trade.pCalibrated,
        trade.markout30s ?? null,
        trade.resolvedUp === null ? null : trade.resolvedUp ? 1 : 0,
        trade.won === null ? null : trade.won ? 1 : 0,
        trade.netPnlUsd ?? null,
        trade.venueOrderId ?? null,
        trade.status,
      )
  }

  async getPredictionTrades(
    tenantId: string,
    options: PredictionTradeQueryOptions = {},
  ): Promise<StoredPredictionTrade[]> {
    if (this.closed) return []
    const clauses: string[] = ['tenant_id = ?']
    const params: (string | number)[] = [tenantId]

    if (options.strategyId) {
      clauses.push('strategy_id = ?')
      params.push(options.strategyId)
    }
    if (options.slug) {
      clauses.push('slug = ?')
      params.push(options.slug)
    }
    if (options.timeframe) {
      clauses.push('timeframe = ?')
      params.push(options.timeframe)
    }
    if (options.mode) {
      clauses.push('mode = ?')
      params.push(options.mode)
    }
    if (options.status) {
      clauses.push('status = ?')
      params.push(options.status)
    }
    if (
      options.sinceEntryTimeMs !== undefined &&
      Number.isFinite(options.sinceEntryTimeMs)
    ) {
      clauses.push('entry_time_ms >= ?')
      params.push(options.sinceEntryTimeMs)
    }

    const rawLimit =
      options.limit !== undefined && Number.isFinite(options.limit)
        ? options.limit
        : 200
    const safeLimit = Math.max(1, Math.min(5_000, Math.round(rawLimit)))
    params.push(safeLimit)

    const rows = this.db
      .prepare(
        `SELECT * FROM prediction_shadow_trades
         WHERE ${clauses.join(' AND ')}
         ORDER BY entry_time_ms DESC, id DESC
         LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[]
    return rows.map(mapPredictionTradeRow)
  }

  async setStrategyModeState(state: StoredStrategyState): Promise<void> {
    if (this.closed) return
    this.db
      .prepare(
        `INSERT INTO prediction_strategy_states (
          tenant_id, strategy_id, mode, halted_reason, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, strategy_id) DO UPDATE SET
          mode = excluded.mode,
          halted_reason = excluded.halted_reason,
          updated_at = excluded.updated_at`,
      )
      .run(
        state.tenantId,
        state.strategyId,
        state.mode,
        state.haltedReason ?? null,
        state.updatedAt,
      )
  }

  async getStrategyModeStates(
    tenantId: string,
  ): Promise<StoredStrategyState[]> {
    if (this.closed) return []
    const rows = this.db
      .prepare(
        `SELECT * FROM prediction_strategy_states
         WHERE tenant_id = ?
         ORDER BY strategy_id ASC`,
      )
      .all(tenantId) as Record<string, unknown>[]
    return rows.map(mapStrategyStateRow)
  }

  async upsertExchangePosition(position: ExchangePositionRecord): Promise<void> {
    if (this.closed) return
    this.db
      .prepare(
        `INSERT INTO exchange_positions (
          id, tenant_id, mode, preset_id, pair, side, status,
          entry_order_id, entry_venue_order_id, exit_order_id, exit_venue_order_id,
          entry_qty, exit_qty, entry_avg_price, exit_avg_price,
          entry_fee_usd, exit_fee_usd, stop_price, target_price,
          protection_order_id, realized_pnl_usd, r_multiple, exit_reason,
          opened_at, closed_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          exit_order_id = COALESCE(excluded.exit_order_id, exchange_positions.exit_order_id),
          exit_venue_order_id = COALESCE(excluded.exit_venue_order_id, exchange_positions.exit_venue_order_id),
          exit_qty = COALESCE(excluded.exit_qty, exchange_positions.exit_qty),
          exit_avg_price = COALESCE(excluded.exit_avg_price, exchange_positions.exit_avg_price),
          exit_fee_usd = excluded.exit_fee_usd,
          stop_price = COALESCE(excluded.stop_price, exchange_positions.stop_price),
          target_price = COALESCE(excluded.target_price, exchange_positions.target_price),
          protection_order_id = COALESCE(excluded.protection_order_id, exchange_positions.protection_order_id),
          realized_pnl_usd = COALESCE(excluded.realized_pnl_usd, exchange_positions.realized_pnl_usd),
          r_multiple = COALESCE(excluded.r_multiple, exchange_positions.r_multiple),
          exit_reason = COALESCE(excluded.exit_reason, exchange_positions.exit_reason),
          closed_at = COALESCE(excluded.closed_at, exchange_positions.closed_at)`,
      )
      .run(
        position.id,
        position.tenantId,
        position.mode,
        position.presetId,
        position.pair,
        position.side,
        position.status,
        position.entryOrderId,
        position.entryVenueOrderId,
        position.exitOrderId,
        position.exitVenueOrderId,
        position.entryQty,
        position.exitQty,
        position.entryAvgPrice,
        position.exitAvgPrice,
        position.entryFeeUsd,
        position.exitFeeUsd,
        position.stopPrice,
        position.targetPrice,
        position.protectionOrderId,
        position.realizedPnlUsd,
        position.rMultiple,
        position.exitReason,
        position.openedAt,
        position.closedAt,
      )
  }

  async queryExchangePositions(
    tenantId: string,
    options: ExchangePositionQueryOptions = {},
  ): Promise<ExchangePositionRecord[]> {
    if (this.closed) return []
    const clauses: string[] = ['tenant_id = ?']
    const params: (string | number)[] = [tenantId]
    if (options.mode) {
      clauses.push('mode = ?')
      params.push(options.mode)
    }
    if (options.presetId) {
      clauses.push('preset_id = ?')
      params.push(options.presetId)
    }
    if (options.pair) {
      clauses.push('pair = ?')
      params.push(options.pair)
    }
    if (options.status) {
      clauses.push('status = ?')
      params.push(options.status)
    }
    const safeLimit = Math.max(
      1,
      Math.min(1_000, Math.round(options.limit ?? 200)),
    )
    params.push(safeLimit)
    const rows = this.db
      .prepare(
        `SELECT * FROM exchange_positions
         WHERE ${clauses.join(' AND ')}
         ORDER BY COALESCE(closed_at, opened_at) DESC, id DESC
         LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[]
    return rows.map(mapExchangePositionRow)
  }

  async pruneRetention(
    retentionDays = DEFAULT_RETENTION_DAYS,
    nowMs = Date.now(),
    windowRetentionDays = DEFAULT_WINDOW_RETENTION_DAYS,
  ): Promise<RetentionPruneReport> {
    const safeDays = Math.max(1, Math.round(retentionDays))
    const safeWindowDays = Math.max(1, Math.round(windowRetentionDays))
    const cutoffMs = nowMs - safeDays * 86_400_000
    const cutoffIso = new Date(cutoffMs).toISOString()
    const windowCutoffMs = nowMs - safeWindowDays * 86_400_000
    const windowCutoffIso = new Date(windowCutoffMs).toISOString()

    const delOrders = this.db
      .prepare('DELETE FROM orders WHERE timestamp < ?')
      .run(cutoffIso)
    const delAudit = this.db
      .prepare('DELETE FROM audit_events WHERE timestamp < ?')
      .run(cutoffIso)
    const delCandles = this.db
      .prepare('DELETE FROM candles_archive WHERE open_time_ms < ?')
      .run(cutoffMs)
    const delSnapshots = this.db
      .prepare(
        `DELETE FROM prediction_window_snapshots
         WHERE captured_at_ms < ?
            OR slug IN (SELECT slug FROM prediction_windows WHERE end_time_ms < ?)`,
      )
      .run(windowCutoffMs, windowCutoffMs)
    const delWindows = this.db
      .prepare('DELETE FROM prediction_windows WHERE end_time_ms < ?')
      .run(windowCutoffMs)
    const delPredTrades = this.db
      .prepare(
        `DELETE FROM prediction_shadow_trades
         WHERE entry_time_ms < ? AND status != 'OPEN'`,
      )
      .run(windowCutoffMs)

    return {
      retentionDays: safeDays,
      cutoffIso,
      deletedOrders: Number(delOrders.changes ?? 0),
      deletedAuditEvents: Number(delAudit.changes ?? 0),
      deletedCandles: Number(delCandles.changes ?? 0),
      windowRetentionDays: safeWindowDays,
      windowCutoffIso,
      deletedPredictionWindows: Number(delWindows.changes ?? 0),
      deletedPredictionSnapshots: Number(delSnapshots.changes ?? 0),
      deletedPredictionTrades: Number(delPredTrades.changes ?? 0),
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}
