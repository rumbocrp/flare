/**
 * PostgreSQL + TimescaleDB `StateStore` adapter (`P0-4`).
 *
 * Accepts any `PgPoolLike` driver (`pg.Pool`, PGlite, or test double) and runs
 * idempotent versioned SQL migrations from `POSTGRES_MIGRATIONS`.
 */
import type { Candle, Interval } from '../../types'
import type { ExchangeOrderRecord } from '../exchangeAdapter'
import {
  LedgerImbalanceError,
  validateEntryBalance,
  type LedgerEntry,
  type LedgerPosting,
} from '../ledger/doubleEntryLedger'
import { POSTGRES_MIGRATIONS } from './postgresMigrations'
import type {
  AuditEventRecord,
  PersistedTenantEnvelope,
  RetentionPruneReport,
  StateStore,
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

function parseJsonField<T>(value: unknown): T {
  if (typeof value === 'string') {
    return JSON.parse(value) as T
  }
  return value as T
}

function mapPgOrder(row: Record<string, unknown>): ExchangeOrderRecord {
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
    pair: String(row.pair),
    side: row.side === 'SELL' ? 'SELL' : 'BUY',
    notionalUsd: Number(row.notional_usd),
    price: Number(row.price),
    quantity: Number(row.quantity),
    status: String(row.status) as ExchangeOrderRecord['status'],
    mode: String(row.mode) as ExchangeOrderRecord['mode'],
    source: row.source === 'bot-auto' ? 'bot-auto' : 'manual',
    reason:
      row.reason !== null && row.reason !== undefined
        ? String(row.reason)
        : undefined,
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
        pair, side, notional_usd, price, quantity, status, mode, source, reason
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT(tenant_id, id) DO UPDATE SET
        venue_order_id = EXCLUDED.venue_order_id,
        status = EXCLUDED.status,
        reason = EXCLUDED.reason`,
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
      ],
    )
  }

  async getOrders(
    tenantId: string,
    limit = 100,
  ): Promise<ExchangeOrderRecord[]> {
    const safeLimit = Math.max(1, Math.min(1_000, Math.round(limit)))
    const res = await this.pool.query(
      `SELECT * FROM orders
       WHERE tenant_id = $1
       ORDER BY timestamp DESC
       LIMIT $2`,
      [tenantId, safeLimit],
    )
    return res.rows.map(mapPgOrder)
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

  async pruneRetention(
    retentionDays = DEFAULT_RETENTION_DAYS,
    nowMs = Date.now(),
  ): Promise<RetentionPruneReport> {
    const safeDays = Math.max(1, Math.round(retentionDays))
    const cutoffMs = nowMs - safeDays * 86_400_000
    const cutoffIso = new Date(cutoffMs).toISOString()

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

    return {
      retentionDays: safeDays,
      cutoffIso,
      deletedOrders: Number(delOrders.rowCount ?? 0),
      deletedAuditEvents: Number(delAudit.rowCount ?? 0),
      deletedCandles: Number(delCandles.rowCount ?? 0),
    }
  }

  async close(): Promise<void> {
    if (this.pool.end) {
      await this.pool.end()
    }
  }
}
