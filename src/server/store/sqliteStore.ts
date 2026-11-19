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
import type { Candle, Interval } from '../../types'
import type { ExchangeOrderRecord } from '../exchangeAdapter'
import {
  validateEntryBalance,
  LedgerImbalanceError,
  type LedgerEntry,
  type LedgerPosting,
} from '../ledger/doubleEntryLedger'
import type {
  AuditEventRecord,
  PersistedTenantEnvelope,
  RetentionPruneReport,
  StateStore,
} from './types'

const DEFAULT_RETENTION_DAYS = 90

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
]

function mapOrderRow(row: Record<string, unknown>): ExchangeOrderRecord {
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
        `INSERT OR REPLACE INTO orders (
          id, tenant_id, client_order_id, venue_order_id, timestamp,
          pair, side, notional_usd, price, quantity, status, mode, source, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    const safeLimit = Math.max(1, Math.min(1_000, Math.round(limit)))
    const rows = this.db
      .prepare(
        `SELECT * FROM orders
         WHERE tenant_id = ?
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(tenantId, safeLimit) as Record<string, unknown>[]
    return rows.map(mapOrderRow)
  }

  async findOrderByClientOrderId(
    tenantId: string,
    clientOrderId: string,
  ): Promise<ExchangeOrderRecord | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM orders
         WHERE tenant_id = ? AND client_order_id = ?
         LIMIT 1`,
      )
      .get(tenantId, clientOrderId) as Record<string, unknown> | undefined
    return row ? mapOrderRow(row) : null
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

  async pruneRetention(
    retentionDays = DEFAULT_RETENTION_DAYS,
    nowMs = Date.now(),
  ): Promise<RetentionPruneReport> {
    const safeDays = Math.max(1, Math.round(retentionDays))
    const cutoffMs = nowMs - safeDays * 86_400_000
    const cutoffIso = new Date(cutoffMs).toISOString()

    const delOrders = this.db
      .prepare('DELETE FROM orders WHERE timestamp < ?')
      .run(cutoffIso)
    const delAudit = this.db
      .prepare('DELETE FROM audit_events WHERE timestamp < ?')
      .run(cutoffIso)
    const delCandles = this.db
      .prepare('DELETE FROM candles_archive WHERE open_time_ms < ?')
      .run(cutoffMs)

    return {
      retentionDays: safeDays,
      cutoffIso,
      deletedOrders: Number(delOrders.changes ?? 0),
      deletedAuditEvents: Number(delAudit.changes ?? 0),
      deletedCandles: Number(delCandles.changes ?? 0),
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}
