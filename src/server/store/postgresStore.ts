/**
 * PostgreSQL + TimescaleDB `StateStore` adapter (`P0-4`).
 *
 * Accepts any `PgPoolLike` driver (`pg.Pool`, PGlite, or test double) and runs
 * idempotent versioned SQL migrations from `POSTGRES_MIGRATIONS`.
 */
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
  LedgerImbalanceError,
  validateEntryBalance,
  type LedgerEntry,
  type LedgerPosting,
} from '../ledger/doubleEntryLedger'
import type { PolymarketTimeframe, ResolutionSource } from '../polymarketAdapter'
import { POSTGRES_MIGRATIONS } from './postgresMigrations'
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

export interface PgQueryResult<Row = Record<string, unknown>> {
  rows: Row[]
  rowCount?: number | null
}

export interface PgPoolLike {
  query<Row = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<PgQueryResult<Row>>
  end?(): Promise<void>
}

const DEFAULT_RETENTION_DAYS = 90
const DEFAULT_WINDOW_RETENTION_DAYS = 365

function parseJsonField<T>(value: unknown): T {
  if (typeof value === 'string') {
    return JSON.parse(value) as T
  }
  return value as T
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

function mapPgPredictionWindow(
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
    negRisk: Boolean(row.neg_risk),
    volumeUsd: toNullableNumber(row.volume_usd),
    updatedAt: Number(row.updated_at),
  }
}

function mapPgWindowSnapshot(
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

function mapPgPredictionTrade(
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

function mapPgStrategyState(
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

function mapPgOrder(row: Record<string, unknown>): ExchangeOrderRecord {
  const filledQty = toNullableNumber(row.filled_qty)
  const avgPrice = toNullableNumber(row.avg_price)
  const fee = toNullableNumber(row.fee)
  const feeAsset = toNullableString(row.fee_asset)
  const presetId = toNullableString(row.preset_id)
  const updatedAt =
    row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : toNullableString(row.updated_at)

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
    timestamp:
      row.timestamp instanceof Date
        ? row.timestamp.toISOString()
        : String(row.timestamp),
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

function mapPgTrainingRun(row: Record<string, unknown>): TrainingRunRecord {
  const createdAt =
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at)
  const completedAt =
    row.completed_at instanceof Date
      ? row.completed_at.toISOString()
      : toNullableString(row.completed_at)

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
    config: parseJsonField<TrainingConfig>(row.config_json),
    progress:
      row.progress_json !== null && row.progress_json !== undefined
        ? parseJsonField<TrainingProgress>(row.progress_json)
        : null,
    metrics:
      row.metrics_json !== null && row.metrics_json !== undefined
        ? parseJsonField<TrainingRunMetrics>(row.metrics_json)
        : null,
    folds:
      row.folds_json !== null && row.folds_json !== undefined
        ? parseJsonField<TrainingFoldResult[]>(row.folds_json)
        : null,
    equity:
      row.equity_json !== null && row.equity_json !== undefined
        ? parseJsonField<TrainingEquityPoint[]>(row.equity_json)
        : null,
    trades:
      row.trades_json !== null && row.trades_json !== undefined
        ? parseJsonField<TrainingTradeRecord[]>(row.trades_json)
        : null,
    assumptions: parseJsonField<TrainingAssumptions>(row.assumptions_json),
    dataSource: String(row.data_source),
    error: toNullableString(row.error),
    createdAt,
    completedAt,
  }
}

function mapPgRuntimeEvent(row: Record<string, unknown>): RuntimeEventRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    timestamp:
      row.timestamp instanceof Date
        ? row.timestamp.toISOString()
        : String(row.timestamp),
    type: String(row.type) as RuntimeEventType,
    severity: String(row.severity) as RuntimeEventSeverity,
    message: String(row.message),
    payload:
      row.payload_json !== null && row.payload_json !== undefined
        ? parseJsonField<Record<string, unknown>>(row.payload_json)
        : null,
    source: String(row.source),
    correlationId: toNullableString(row.correlation_id),
  }
}

function mapPgStrategyAudit(row: Record<string, unknown>): StrategyAuditRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    runId: String(row.run_id),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    presetId: String(row.preset_id),
    presetName: String(row.preset_name),
    domain:
      row.domain === 'prediction-market' ? 'prediction-market' : 'crypto-spot',
    pair: String(row.pair),
    timeframe: String(row.timeframe) as Interval,
    fromTimeMs: Number(row.from_time_ms),
    toTimeMs: Number(row.to_time_ms),
    candles: Number(row.candles),
    metrics: parseJsonField<StrategyAuditMetrics>(row.metrics_json),
    assumptions: parseJsonField<StrategyAuditAssumptions>(row.assumptions_json),
    dataSource: String(row.data_source),
  }
}

export class PostgresStateStore implements StateStore {
  readonly driver = 'postgres' as const
  readonly location: string
  private readonly pool: PgPoolLike

  constructor(pool: PgPoolLike, location = 'postgres://configured') {
    this.pool = pool
    this.location = location
  }

  async migrate(): Promise<number> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    const appliedRes = await this.pool.query<{ version: number }>(
      'SELECT version FROM schema_migrations',
    )
    const applied = new Set(appliedRes.rows.map((r) => Number(r.version)))
    let latest = 0
    for (const v of applied) {
      if (v > latest) latest = v
    }

    for (const migration of POSTGRES_MIGRATIONS) {
      if (applied.has(migration.version)) continue
      await this.pool.query('BEGIN')
      try {
        for (const stmt of migration.statements) {
          await this.pool.query(stmt)
        }
        await this.pool.query(
          'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
          [migration.version, migration.name],
        )
        await this.pool.query('COMMIT')
        if (migration.version > latest) latest = migration.version
      } catch (err) {
        await this.pool.query('ROLLBACK')
        throw err
      }
    }
    return latest
  }

  async getSchemaVersion(): Promise<number> {
    const res = await this.pool.query<{ v: number | null }>(
      'SELECT MAX(version) AS v FROM schema_migrations',
    )
    return Number(res.rows[0]?.v ?? 0)
  }

  async saveTenantSnapshot(envelope: PersistedTenantEnvelope): Promise<void> {
    await this.pool.query(
      `INSERT INTO tenant_runtime_state
        (tenant_id, schema_version, preset_id, is_running, payload_json, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT(tenant_id) DO UPDATE SET
        schema_version = EXCLUDED.schema_version,
        preset_id = EXCLUDED.preset_id,
        is_running = EXCLUDED.is_running,
        payload_json = EXCLUDED.payload_json,
        updated_at = EXCLUDED.updated_at`,
      [
        envelope.tenantId,
        envelope.schemaVersion,
        envelope.presetId,
        envelope.isRunning,
        JSON.stringify(envelope),
        envelope.savedAt,
      ],
    )
  }

  async loadTenantSnapshot(
    tenantId: string,
  ): Promise<PersistedTenantEnvelope | null> {
    const res = await this.pool.query<{ payload_json: unknown }>(
      'SELECT payload_json FROM tenant_runtime_state WHERE tenant_id = $1',
      [tenantId],
    )
    if (res.rows.length === 0) return null
    return parseJsonField<PersistedTenantEnvelope>(res.rows[0].payload_json)
  }

  async listTenantIds(): Promise<string[]> {
    const res = await this.pool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM tenant_runtime_state ORDER BY tenant_id ASC',
    )
    return res.rows.map((r) => String(r.tenant_id))
  }

  async appendOrder(
    tenantId: string,
    order: ExchangeOrderRecord,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO orders (
        id, tenant_id, client_order_id, venue_order_id, timestamp,
        pair, side, notional_usd, price, quantity, status, mode, source, reason,
        filled_qty, avg_price, fee, fee_asset, updated_at, preset_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT(tenant_id, id) DO UPDATE SET
        venue_order_id = EXCLUDED.venue_order_id,
        status = EXCLUDED.status,
        reason = EXCLUDED.reason,
        filled_qty = EXCLUDED.filled_qty,
        avg_price = EXCLUDED.avg_price,
        fee = EXCLUDED.fee,
        fee_asset = EXCLUDED.fee_asset,
        updated_at = EXCLUDED.updated_at,
        preset_id = COALESCE(EXCLUDED.preset_id, orders.preset_id)`,
      [
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
      ],
    )
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
    const clauses: string[] = ['tenant_id = $1']
    const params: unknown[] = [tenantId]
    const pushParam = (val: unknown): string => {
      params.push(val)
      return `$${params.length}`
    }

    if (options.status) {
      clauses.push(`status = ${pushParam(options.status)}`)
    }
    if (options.pair) {
      clauses.push(`pair = ${pushParam(options.pair)}`)
    }
    if (options.side) {
      clauses.push(`side = ${pushParam(options.side)}`)
    }
    if (options.source) {
      clauses.push(`source = ${pushParam(options.source)}`)
    }
    if (options.presetId) {
      clauses.push(`preset_id = ${pushParam(options.presetId)}`)
    }
    if (options.mode) {
      clauses.push(`mode = ${pushParam(options.mode)}`)
    }
    if (options.before) {
      clauses.push(`timestamp < ${pushParam(options.before)}`)
    }

    const rawLimit =
      options.limit !== undefined && Number.isFinite(options.limit)
        ? options.limit
        : 100
    const safeLimit = Math.max(1, Math.min(1_000, Math.round(rawLimit)))
    const limitParam = pushParam(safeLimit)

    const res = await this.pool.query(
      `SELECT * FROM orders
       WHERE ${clauses.join(' AND ')}
       ORDER BY timestamp DESC, id DESC
       LIMIT ${limitParam}`,
      params,
    )
    return res.rows.map(mapPgOrder)
  }

  async findOrderById(
    tenantId: string,
    orderId: string,
  ): Promise<ExchangeOrderRecord | null> {
    const res = await this.pool.query(
      `SELECT * FROM orders
       WHERE tenant_id = $1 AND id = $2
       LIMIT 1`,
      [tenantId, orderId],
    )
    return res.rows[0] ? mapPgOrder(res.rows[0]) : null
  }

  async findOrderByClientOrderId(
    tenantId: string,
    clientOrderId: string,
  ): Promise<ExchangeOrderRecord | null> {
    const res = await this.pool.query(
      `SELECT * FROM orders
       WHERE tenant_id = $1 AND client_order_id = $2
       LIMIT 1`,
      [tenantId, clientOrderId],
    )
    return res.rows[0] ? mapPgOrder(res.rows[0]) : null
  }

  async appendLedgerEntry(entry: LedgerEntry): Promise<void> {
    const imbalances = validateEntryBalance(entry)
    if (imbalances.length > 0) {
      throw new LedgerImbalanceError(imbalances)
    }
    await this.pool.query(
      `INSERT INTO ledger_entries (
        id, tenant_id, timestamp, kind, reference_id,
        description, postings_json, metadata_json
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
      ON CONFLICT(id) DO NOTHING`,
      [
        entry.id,
        entry.tenantId,
        entry.timestamp,
        entry.kind,
        entry.referenceId,
        entry.description,
        JSON.stringify(entry.postings),
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ],
    )
  }

  async getLedgerEntries(
    tenantId: string,
    limit = 500,
  ): Promise<LedgerEntry[]> {
    const safeLimit = Math.max(1, Math.min(5_000, Math.round(limit)))
    const res = await this.pool.query(
      `SELECT * FROM ledger_entries
       WHERE tenant_id = $1
       ORDER BY timestamp ASC
       LIMIT $2`,
      [tenantId, safeLimit],
    )
    return res.rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      timestamp:
        row.timestamp instanceof Date
          ? row.timestamp.toISOString()
          : String(row.timestamp),
      kind: String(row.kind) as LedgerEntry['kind'],
      referenceId: String(row.reference_id),
      description: String(row.description),
      postings: parseJsonField<LedgerPosting[]>(row.postings_json),
      metadata:
        row.metadata_json !== null && row.metadata_json !== undefined
          ? parseJsonField<Record<string, string | number | boolean | null>>(
              row.metadata_json,
            )
          : undefined,
    }))
  }

  async appendAuditEvent(event: AuditEventRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events (
        id, tenant_id, timestamp, actor, role, action, resource, outcome, details_json
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
      ON CONFLICT(id) DO NOTHING`,
      [
        event.id,
        event.tenantId,
        event.timestamp,
        event.actor,
        event.role,
        event.action,
        event.resource,
        event.outcome,
        event.details ? JSON.stringify(event.details) : null,
      ],
    )
  }

  async getAuditEvents(
    tenantId: string,
    limit = 200,
  ): Promise<AuditEventRecord[]> {
    const safeLimit = Math.max(1, Math.min(2_000, Math.round(limit)))
    const res = await this.pool.query(
      `SELECT * FROM audit_events
       WHERE tenant_id = $1
       ORDER BY timestamp DESC
       LIMIT $2`,
      [tenantId, safeLimit],
    )
    return res.rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      timestamp:
        row.timestamp instanceof Date
          ? row.timestamp.toISOString()
          : String(row.timestamp),
      actor: String(row.actor),
      role: String(row.role),
      action: String(row.action),
      resource: String(row.resource),
      outcome: String(row.outcome) as AuditEventRecord['outcome'],
      details:
        row.details_json !== null && row.details_json !== undefined
          ? parseJsonField<Record<string, string | number | boolean | null>>(
              row.details_json,
            )
          : undefined,
    }))
  }

  async appendRuntimeEvent(event: RuntimeEventRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO runtime_events (
        id, tenant_id, timestamp, type, severity, message, payload_json, source, correlation_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
      ON CONFLICT(id) DO NOTHING`,
      [
        event.id,
        event.tenantId,
        event.timestamp,
        event.type,
        event.severity,
        event.message,
        event.payload ? JSON.stringify(event.payload) : null,
        event.source,
        event.correlationId ?? null,
      ],
    )
  }

  async getRuntimeEvents(
    tenantId: string,
    options: RuntimeEventQueryOptions = {},
  ): Promise<RuntimeEventRecord[]> {
    const clauses: string[] = ['tenant_id = $1']
    const params: unknown[] = [tenantId]
    const pushParam = (val: unknown): string => {
      params.push(val)
      return `$${params.length}`
    }

    if (Array.isArray(options.types) && options.types.length > 0) {
      const placeholders = options.types.map((t) => pushParam(t)).join(', ')
      clauses.push(`type IN (${placeholders})`)
    }
    if (options.q && options.q.trim().length > 0) {
      const needle = `%${options.q.trim().toLowerCase()}%`
      const p1 = pushParam(needle)
      const p2 = pushParam(needle)
      const p3 = pushParam(needle)
      clauses.push(
        `(LOWER(message) LIKE ${p1} OR LOWER(source) LIKE ${p2} OR LOWER(COALESCE(correlation_id, '')) LIKE ${p3})`,
      )
    }
    if (options.before) {
      clauses.push(`timestamp < ${pushParam(options.before)}`)
    }

    const rawLimit =
      options.limit !== undefined && Number.isFinite(options.limit)
        ? options.limit
        : 200
    const safeLimit = Math.max(1, Math.min(2_000, Math.round(rawLimit)))
    const limitParam = pushParam(safeLimit)

    const res = await this.pool.query(
      `SELECT * FROM runtime_events
       WHERE ${clauses.join(' AND ')}
       ORDER BY timestamp DESC, id DESC
       LIMIT ${limitParam}`,
      params,
    )
    return res.rows.map(mapPgRuntimeEvent)
  }

  async appendStrategyAudit(record: StrategyAuditRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO strategy_audits (
        id, tenant_id, run_id, created_at, preset_id, preset_name, domain,
        pair, timeframe, from_time_ms, to_time_ms, candles, metrics_json,
        assumptions_json, data_source
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)
      ON CONFLICT(id) DO UPDATE SET
        metrics_json = EXCLUDED.metrics_json,
        assumptions_json = EXCLUDED.assumptions_json`,
      [
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
      ],
    )
  }

  async getLatestStrategyAudits(
    tenantId: string,
    limit = 64,
  ): Promise<StrategyAuditRecord[]> {
    const safeLimit = Math.max(1, Math.min(256, Math.round(limit)))
    const res = await this.pool.query(
      `SELECT * FROM strategy_audits
       WHERE tenant_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [tenantId, safeLimit],
    )
    return res.rows.map(mapPgStrategyAudit)
  }

  async upsertCandles(
    pair: string,
    interval: Interval,
    candles: readonly Candle[],
  ): Promise<number> {
    if (candles.length === 0) return 0
    for (const c of candles) {
      await this.pool.query(
        `INSERT INTO candles_archive (
          pair, interval, open_time_ms, open, high, low, close, volume
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(pair, interval, open_time_ms) DO UPDATE SET
          open = EXCLUDED.open,
          high = EXCLUDED.high,
          low = EXCLUDED.low,
          close = EXCLUDED.close,
          volume = EXCLUDED.volume,
          ingested_at = NOW()`,
        [pair, interval, c.time, c.open, c.high, c.low, c.close, c.volume],
      )
    }
    return candles.length
  }

  async getCandles(
    pair: string,
    interval: Interval,
    limit: number,
  ): Promise<Candle[]> {
    const safeLimit = Math.max(1, Math.min(2_000, Math.round(limit)))
    const res = await this.pool.query(
      `SELECT open_time_ms, open, high, low, close, volume
       FROM candles_archive
       WHERE pair = $1 AND interval = $2
       ORDER BY open_time_ms DESC
       LIMIT $3`,
      [pair, interval, safeLimit],
    )
    return res.rows.reverse().map((r) => ({
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
    const safeLimit = Math.max(1, Math.min(5_000, Math.round(limit)))
    const res = await this.pool.query(
      `SELECT open_time_ms, open, high, low, close, volume
       FROM candles_archive
       WHERE pair = $1 AND interval = $2 AND open_time_ms >= $3 AND open_time_ms <= $4
       ORDER BY open_time_ms ASC
       LIMIT $5`,
      [pair, interval, fromTimeMs, toTimeMs, safeLimit],
    )
    return res.rows.map((r) => ({
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
    const inserted = await this.pool.query(
      `INSERT INTO training_runs (
        id, tenant_id, client_run_id, kind, preset_id, strategy_family,
        pair, timeframe, from_time_ms, to_time_ms, candle_count, status,
        config_json, progress_json, metrics_json, folds_json, equity_json,
        trades_json, assumptions_json, data_source, error, created_at, completed_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
        $13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,
        $20,$21,$22,$23
      )
      ON CONFLICT(tenant_id, client_run_id) DO NOTHING
      RETURNING *`,
      [
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
      ],
    )
    if (inserted.rows.length > 0) {
      return { record: mapPgTrainingRun(inserted.rows[0]), deduplicated: false }
    }
    const existing = await this.pool.query(
      `SELECT * FROM training_runs
       WHERE tenant_id = $1 AND client_run_id = $2
       LIMIT 1`,
      [record.tenantId, record.clientRunId],
    )
    if (existing.rows.length > 0) {
      return { record: mapPgTrainingRun(existing.rows[0]), deduplicated: true }
    }
    return { record, deduplicated: false }
  }

  async updateTrainingRun(
    tenantId: string,
    id: string,
    patch: UpdateTrainingRunPatch,
  ): Promise<TrainingRunRecord | null> {
    const sets: string[] = []
    const params: unknown[] = []
    const pushParam = (val: unknown): string => {
      params.push(val)
      return `$${params.length}`
    }

    if (patch.status !== undefined) {
      sets.push(`status = ${pushParam(patch.status)}`)
    }
    if (patch.candleCount !== undefined) {
      sets.push(`candle_count = ${pushParam(patch.candleCount)}`)
    }
    if (patch.progress !== undefined) {
      sets.push(
        `progress_json = ${pushParam(patch.progress ? JSON.stringify(patch.progress) : null)}::jsonb`,
      )
    }
    if (patch.metrics !== undefined) {
      sets.push(
        `metrics_json = ${pushParam(patch.metrics ? JSON.stringify(patch.metrics) : null)}::jsonb`,
      )
    }
    if (patch.folds !== undefined) {
      sets.push(
        `folds_json = ${pushParam(patch.folds ? JSON.stringify(patch.folds) : null)}::jsonb`,
      )
    }
    if (patch.equity !== undefined) {
      sets.push(
        `equity_json = ${pushParam(patch.equity ? JSON.stringify(patch.equity) : null)}::jsonb`,
      )
    }
    if (patch.trades !== undefined) {
      sets.push(
        `trades_json = ${pushParam(patch.trades ? JSON.stringify(patch.trades) : null)}::jsonb`,
      )
    }
    if (patch.dataSource !== undefined) {
      sets.push(`data_source = ${pushParam(patch.dataSource)}`)
    }
    if (patch.error !== undefined) {
      sets.push(`error = ${pushParam(patch.error)}`)
    }
    if (patch.completedAt !== undefined) {
      sets.push(`completed_at = ${pushParam(patch.completedAt)}`)
    }

    if (sets.length === 0) {
      return this.getTrainingRunById(tenantId, id)
    }

    const tenantParam = pushParam(tenantId)
    const idParam = pushParam(id)
    const res = await this.pool.query(
      `UPDATE training_runs
       SET ${sets.join(', ')}
       WHERE tenant_id = ${tenantParam} AND id = ${idParam}
       RETURNING *`,
      params,
    )
    return res.rows[0] ? mapPgTrainingRun(res.rows[0]) : null
  }

  async getTrainingRunById(
    tenantId: string,
    id: string,
  ): Promise<TrainingRunRecord | null> {
    const res = await this.pool.query(
      `SELECT * FROM training_runs
       WHERE tenant_id = $1 AND id = $2
       LIMIT 1`,
      [tenantId, id],
    )
    return res.rows[0] ? mapPgTrainingRun(res.rows[0]) : null
  }

  async listTrainingRuns(
    tenantId: string,
    options: TrainingRunQueryOptions = {},
  ): Promise<TrainingRunRecord[]> {
    const clauses: string[] = ['tenant_id = $1']
    const params: unknown[] = [tenantId]
    const pushParam = (val: unknown): string => {
      params.push(val)
      return `$${params.length}`
    }
    if (options.presetId) {
      clauses.push(`preset_id = ${pushParam(options.presetId)}`)
    }
    const rawLimit =
      options.limit !== undefined && Number.isFinite(options.limit)
        ? options.limit
        : 50
    const safeLimit = Math.max(1, Math.min(500, Math.round(rawLimit)))
    const limitParam = pushParam(safeLimit)

    const res = await this.pool.query(
      `SELECT * FROM training_runs
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limitParam}`,
      params,
    )
    return res.rows.map(mapPgTrainingRun)
  }

  async markRunningTrainingRunsInterrupted(tenantId?: string): Promise<number> {
    const nowIso = new Date().toISOString()
    const res = tenantId
      ? await this.pool.query(
          `UPDATE training_runs
           SET status = 'interrupted',
               error = COALESCE(error, 'Run interrupted before completion'),
               completed_at = COALESCE(completed_at, $1)
           WHERE status = 'running' AND tenant_id = $2`,
          [nowIso, tenantId],
        )
      : await this.pool.query(
          `UPDATE training_runs
           SET status = 'interrupted',
               error = COALESCE(error, 'Run interrupted before completion'),
               completed_at = COALESCE(completed_at, $1)
           WHERE status = 'running'`,
          [nowIso],
        )
    return Number(res.rowCount ?? 0)
  }

  async upsertPredictionWindow(window: CollectedWindowRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO prediction_windows (
        slug, timeframe, condition_id, up_token_id, down_token_id,
        resolution_source, start_time_ms, end_time_ms, open_twap, close_twap,
        resolved_up, tick_size, neg_risk, volume_usd, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT(slug) DO UPDATE SET
        timeframe = EXCLUDED.timeframe,
        condition_id = COALESCE(EXCLUDED.condition_id, prediction_windows.condition_id),
        up_token_id = COALESCE(EXCLUDED.up_token_id, prediction_windows.up_token_id),
        down_token_id = COALESCE(EXCLUDED.down_token_id, prediction_windows.down_token_id),
        resolution_source = CASE
          WHEN EXCLUDED.resolution_source = 'unknown' THEN prediction_windows.resolution_source
          ELSE EXCLUDED.resolution_source
        END,
        start_time_ms = EXCLUDED.start_time_ms,
        end_time_ms = EXCLUDED.end_time_ms,
        open_twap = COALESCE(EXCLUDED.open_twap, prediction_windows.open_twap),
        close_twap = COALESCE(EXCLUDED.close_twap, prediction_windows.close_twap),
        resolved_up = COALESCE(EXCLUDED.resolved_up, prediction_windows.resolved_up),
        tick_size = COALESCE(EXCLUDED.tick_size, prediction_windows.tick_size),
        neg_risk = EXCLUDED.neg_risk,
        volume_usd = COALESCE(EXCLUDED.volume_usd, prediction_windows.volume_usd),
        updated_at = EXCLUDED.updated_at`,
      [
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
        window.resolvedUp ?? null,
        window.tickSize ?? null,
        Boolean(window.negRisk),
        window.volumeUsd ?? null,
        window.updatedAt,
      ],
    )
  }

  async getPredictionWindows(
    options: PredictionWindowQueryOptions = {},
  ): Promise<CollectedWindowRecord[]> {
    if (options.settledOnly && options.unsettledOnly) return []

    const clauses: string[] = []
    const params: unknown[] = []

    const pushParam = (val: unknown): string => {
      params.push(val)
      return `$${params.length}`
    }

    if (options.timeframe) {
      clauses.push(`timeframe = ${pushParam(options.timeframe)}`)
    }
    if (options.slug) {
      clauses.push(`slug = ${pushParam(options.slug)}`)
    }
    if (options.settledOnly) {
      clauses.push('resolved_up IS NOT NULL')
    }
    if (options.unsettledOnly) {
      clauses.push('resolved_up IS NULL')
    }
    if (options.sinceMs !== undefined && Number.isFinite(options.sinceMs)) {
      clauses.push(`start_time_ms >= ${pushParam(options.sinceMs)}`)
    }
    if (options.untilMs !== undefined && Number.isFinite(options.untilMs)) {
      clauses.push(`start_time_ms <= ${pushParam(options.untilMs)}`)
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const dir = options.order === 'asc' ? 'ASC' : 'DESC'
    const rawLimit =
      options.limit !== undefined && Number.isFinite(options.limit)
        ? options.limit
        : 2_000
    const safeLimit = Math.max(1, Math.min(10_000, Math.round(rawLimit)))
    const limitParam = pushParam(safeLimit)

    const res = await this.pool.query(
      `SELECT * FROM prediction_windows
       ${whereSql}
       ORDER BY start_time_ms ${dir}, slug ${dir}
       LIMIT ${limitParam}`,
      params,
    )
    return res.rows.map(mapPgPredictionWindow)
  }

  async getSettledWindowCount(
    timeframe?: PolymarketTimeframe,
  ): Promise<number> {
    const res = timeframe
      ? await this.pool.query<{ cnt: number | string }>(
          `SELECT COUNT(*) AS cnt FROM prediction_windows
           WHERE resolved_up IS NOT NULL AND timeframe = $1`,
          [timeframe],
        )
      : await this.pool.query<{ cnt: number | string }>(
          `SELECT COUNT(*) AS cnt FROM prediction_windows
           WHERE resolved_up IS NOT NULL`,
        )
    return Number(res.rows[0]?.cnt ?? 0)
  }

  async appendPredictionSnapshot(snapshot: WindowSnapshotPoint): Promise<void> {
    await this.pool.query(
      `INSERT INTO prediction_window_snapshots (
        slug, captured_at_ms, seconds_remaining, twap_price, binance_price,
        sigma_1m, basis_bps, yes_bid, yes_ask, yes_depth_usd,
        no_bid, no_ask, no_depth_usd, p_model_yes
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT(slug, captured_at_ms) DO UPDATE SET
        seconds_remaining = EXCLUDED.seconds_remaining,
        twap_price = EXCLUDED.twap_price,
        binance_price = EXCLUDED.binance_price,
        sigma_1m = EXCLUDED.sigma_1m,
        basis_bps = EXCLUDED.basis_bps,
        yes_bid = EXCLUDED.yes_bid,
        yes_ask = EXCLUDED.yes_ask,
        yes_depth_usd = EXCLUDED.yes_depth_usd,
        no_bid = EXCLUDED.no_bid,
        no_ask = EXCLUDED.no_ask,
        no_depth_usd = EXCLUDED.no_depth_usd,
        p_model_yes = EXCLUDED.p_model_yes`,
      [
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
      ],
    )
  }

  async getPredictionSnapshots(slug: string): Promise<WindowSnapshotPoint[]> {
    const res = await this.pool.query(
      `SELECT * FROM prediction_window_snapshots
       WHERE slug = $1
       ORDER BY captured_at_ms ASC`,
      [slug],
    )
    return res.rows.map(mapPgWindowSnapshot)
  }

  async upsertPredictionTrade(trade: StoredPredictionTrade): Promise<void> {
    await this.pool.query(
      `INSERT INTO prediction_shadow_trades (
        id, tenant_id, strategy_id, lane, mode, slug, timeframe, outcome,
        liquidity_role, entry_time_ms, entry_price, fee_usd, stake_usd,
        shares, p_model, p_calibrated, markout_30s, resolved_up, won,
        net_pnl_usd, venue_order_id, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      ON CONFLICT(id) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        strategy_id = EXCLUDED.strategy_id,
        lane = EXCLUDED.lane,
        mode = EXCLUDED.mode,
        slug = EXCLUDED.slug,
        timeframe = EXCLUDED.timeframe,
        outcome = EXCLUDED.outcome,
        liquidity_role = EXCLUDED.liquidity_role,
        entry_time_ms = EXCLUDED.entry_time_ms,
        entry_price = EXCLUDED.entry_price,
        fee_usd = EXCLUDED.fee_usd,
        stake_usd = EXCLUDED.stake_usd,
        shares = EXCLUDED.shares,
        p_model = EXCLUDED.p_model,
        p_calibrated = EXCLUDED.p_calibrated,
        markout_30s = EXCLUDED.markout_30s,
        resolved_up = EXCLUDED.resolved_up,
        won = EXCLUDED.won,
        net_pnl_usd = EXCLUDED.net_pnl_usd,
        venue_order_id = EXCLUDED.venue_order_id,
        status = EXCLUDED.status`,
      [
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
        trade.resolvedUp ?? null,
        trade.won ?? null,
        trade.netPnlUsd ?? null,
        trade.venueOrderId ?? null,
        trade.status,
      ],
    )
  }

  async getPredictionTrades(
    tenantId: string,
    options: PredictionTradeQueryOptions = {},
  ): Promise<StoredPredictionTrade[]> {
    const clauses: string[] = ['tenant_id = $1']
    const params: unknown[] = [tenantId]

    const pushParam = (val: unknown): string => {
      params.push(val)
      return `$${params.length}`
    }

    if (options.strategyId) {
      clauses.push(`strategy_id = ${pushParam(options.strategyId)}`)
    }
    if (options.slug) {
      clauses.push(`slug = ${pushParam(options.slug)}`)
    }
    if (options.timeframe) {
      clauses.push(`timeframe = ${pushParam(options.timeframe)}`)
    }
    if (options.mode) {
      clauses.push(`mode = ${pushParam(options.mode)}`)
    }
    if (options.status) {
      clauses.push(`status = ${pushParam(options.status)}`)
    }
    if (
      options.sinceEntryTimeMs !== undefined &&
      Number.isFinite(options.sinceEntryTimeMs)
    ) {
      clauses.push(`entry_time_ms >= ${pushParam(options.sinceEntryTimeMs)}`)
    }

    const rawLimit =
      options.limit !== undefined && Number.isFinite(options.limit)
        ? options.limit
        : 200
    const safeLimit = Math.max(1, Math.min(5_000, Math.round(rawLimit)))
    const limitParam = pushParam(safeLimit)

    const res = await this.pool.query(
      `SELECT * FROM prediction_shadow_trades
       WHERE ${clauses.join(' AND ')}
       ORDER BY entry_time_ms DESC, id DESC
       LIMIT ${limitParam}`,
      params,
    )
    return res.rows.map(mapPgPredictionTrade)
  }

  async setStrategyModeState(state: StoredStrategyState): Promise<void> {
    await this.pool.query(
      `INSERT INTO prediction_strategy_states (
        tenant_id, strategy_id, mode, halted_reason, updated_at
      ) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT(tenant_id, strategy_id) DO UPDATE SET
        mode = EXCLUDED.mode,
        halted_reason = EXCLUDED.halted_reason,
        updated_at = EXCLUDED.updated_at`,
      [
        state.tenantId,
        state.strategyId,
        state.mode,
        state.haltedReason ?? null,
        state.updatedAt,
      ],
    )
  }

  async getStrategyModeStates(
    tenantId: string,
  ): Promise<StoredStrategyState[]> {
    const res = await this.pool.query(
      `SELECT * FROM prediction_strategy_states
       WHERE tenant_id = $1
       ORDER BY strategy_id ASC`,
      [tenantId],
    )
    return res.rows.map(mapPgStrategyState)
  }

  async upsertExchangePosition(position: ExchangePositionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO exchange_positions (
        id, tenant_id, mode, preset_id, pair, side, status,
        entry_order_id, entry_venue_order_id, exit_order_id, exit_venue_order_id,
        entry_qty, exit_qty, entry_avg_price, exit_avg_price,
        entry_fee_usd, exit_fee_usd, stop_price, target_price,
        protection_order_id, realized_pnl_usd, r_multiple, exit_reason,
        opened_at, closed_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25
      )
      ON CONFLICT(id) DO UPDATE SET
        status = EXCLUDED.status,
        exit_order_id = COALESCE(EXCLUDED.exit_order_id, exchange_positions.exit_order_id),
        exit_venue_order_id = COALESCE(EXCLUDED.exit_venue_order_id, exchange_positions.exit_venue_order_id),
        exit_qty = COALESCE(EXCLUDED.exit_qty, exchange_positions.exit_qty),
        exit_avg_price = COALESCE(EXCLUDED.exit_avg_price, exchange_positions.exit_avg_price),
        exit_fee_usd = EXCLUDED.exit_fee_usd,
        stop_price = COALESCE(EXCLUDED.stop_price, exchange_positions.stop_price),
        target_price = COALESCE(EXCLUDED.target_price, exchange_positions.target_price),
        protection_order_id = COALESCE(EXCLUDED.protection_order_id, exchange_positions.protection_order_id),
        realized_pnl_usd = COALESCE(EXCLUDED.realized_pnl_usd, exchange_positions.realized_pnl_usd),
        r_multiple = COALESCE(EXCLUDED.r_multiple, exchange_positions.r_multiple),
        exit_reason = COALESCE(EXCLUDED.exit_reason, exchange_positions.exit_reason),
        closed_at = COALESCE(EXCLUDED.closed_at, exchange_positions.closed_at)`,
      [
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
      ],
    )
  }

  async queryExchangePositions(
    tenantId: string,
    options: ExchangePositionQueryOptions = {},
  ): Promise<ExchangePositionRecord[]> {
    const clauses: string[] = ['tenant_id = $1']
    const params: unknown[] = [tenantId]
    const pushParam = (val: unknown): string => {
      params.push(val)
      return `$${params.length}`
    }
    if (options.mode) clauses.push(`mode = ${pushParam(options.mode)}`)
    if (options.presetId) clauses.push(`preset_id = ${pushParam(options.presetId)}`)
    if (options.pair) clauses.push(`pair = ${pushParam(options.pair)}`)
    if (options.status) clauses.push(`status = ${pushParam(options.status)}`)
    const safeLimit = Math.max(
      1,
      Math.min(1_000, Math.round(options.limit ?? 200)),
    )
    const limitParam = pushParam(safeLimit)
    const res = await this.pool.query(
      `SELECT * FROM exchange_positions
       WHERE ${clauses.join(' AND ')}
       ORDER BY COALESCE(closed_at, opened_at) DESC, id DESC
       LIMIT ${limitParam}`,
      params,
    )
    return res.rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      mode: String(row.mode) as ExchangePositionMode,
      presetId: row.preset_id === null || row.preset_id === undefined ? null : String(row.preset_id),
      pair: String(row.pair),
      side: String(row.side) === 'SHORT' ? 'SHORT' : 'LONG',
      status: String(row.status) as ExchangePositionStatus,
      entryOrderId: String(row.entry_order_id),
      entryVenueOrderId: row.entry_venue_order_id == null ? null : String(row.entry_venue_order_id),
      exitOrderId: row.exit_order_id == null ? null : String(row.exit_order_id),
      exitVenueOrderId: row.exit_venue_order_id == null ? null : String(row.exit_venue_order_id),
      entryQty: Number(row.entry_qty),
      exitQty: row.exit_qty == null ? null : Number(row.exit_qty),
      entryAvgPrice: Number(row.entry_avg_price),
      exitAvgPrice: row.exit_avg_price == null ? null : Number(row.exit_avg_price),
      entryFeeUsd: Number(row.entry_fee_usd ?? 0),
      exitFeeUsd: Number(row.exit_fee_usd ?? 0),
      stopPrice: row.stop_price == null ? null : Number(row.stop_price),
      targetPrice: row.target_price == null ? null : Number(row.target_price),
      protectionOrderId: row.protection_order_id == null ? null : String(row.protection_order_id),
      realizedPnlUsd: row.realized_pnl_usd == null ? null : Number(row.realized_pnl_usd),
      rMultiple: row.r_multiple == null ? null : Number(row.r_multiple),
      exitReason: row.exit_reason == null ? null : String(row.exit_reason),
      openedAt: row.opened_at instanceof Date ? row.opened_at.toISOString() : String(row.opened_at),
      closedAt:
        row.closed_at == null
          ? null
          : row.closed_at instanceof Date
            ? row.closed_at.toISOString()
            : String(row.closed_at),
    }))
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

    const delOrders = await this.pool.query(
      'DELETE FROM orders WHERE timestamp < $1',
      [cutoffIso],
    )
    const delAudit = await this.pool.query(
      'DELETE FROM audit_events WHERE timestamp < $1',
      [cutoffIso],
    )
    const delCandles = await this.pool.query(
      'DELETE FROM candles_archive WHERE open_time_ms < $1',
      [cutoffMs],
    )
    const delSnapshots = await this.pool.query(
      `DELETE FROM prediction_window_snapshots
       WHERE captured_at_ms < $1
          OR slug IN (SELECT slug FROM prediction_windows WHERE end_time_ms < $2)`,
      [windowCutoffMs, windowCutoffMs],
    )
    const delWindows = await this.pool.query(
      'DELETE FROM prediction_windows WHERE end_time_ms < $1',
      [windowCutoffMs],
    )
    const delPredTrades = await this.pool.query(
      `DELETE FROM prediction_shadow_trades
       WHERE entry_time_ms < $1 AND status != 'OPEN'`,
      [windowCutoffMs],
    )

    return {
      retentionDays: safeDays,
      cutoffIso,
      deletedOrders: Number(delOrders.rowCount ?? 0),
      deletedAuditEvents: Number(delAudit.rowCount ?? 0),
      deletedCandles: Number(delCandles.rowCount ?? 0),
      windowRetentionDays: safeWindowDays,
      windowCutoffIso,
      deletedPredictionWindows: Number(delWindows.rowCount ?? 0),
      deletedPredictionSnapshots: Number(delSnapshots.rowCount ?? 0),
      deletedPredictionTrades: Number(delPredTrades.rowCount ?? 0),
    }
  }

  async close(): Promise<void> {
    if (this.pool.end) {
      await this.pool.end()
    }
  }
}
