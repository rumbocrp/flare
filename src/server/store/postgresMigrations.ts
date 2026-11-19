/**
 * Versioned DDL migrations for PostgreSQL + TimescaleDB (`P0-4`).
 *
 * Designed for idempotent startup execution via `PostgresStateStore.migrate()`
 * and compatible with standard PostgreSQL 15+ (TimescaleDB hypertable
 * promotion runs conditionally when the `timescaledb` extension is installed).
 */

export type SqlMigration = {
  version: number
  name: string
  statements: readonly string[]
}

export const POSTGRES_MIGRATIONS: readonly SqlMigration[] = [
  {
    version: 1,
    name: 'initial_tenant_state_orders_ledger_audit',
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS tenant_runtime_state (
        tenant_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        preset_id TEXT NOT NULL,
        is_running BOOLEAN NOT NULL DEFAULT FALSE,
        payload_json JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS orders (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        client_order_id TEXT,
        venue_order_id TEXT,
        timestamp TIMESTAMPTZ NOT NULL,
        pair TEXT NOT NULL,
        side TEXT NOT NULL,
        notional_usd DOUBLE PRECISION NOT NULL,
        price DOUBLE PRECISION NOT NULL,
        quantity DOUBLE PRECISION NOT NULL,
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
        timestamp TIMESTAMPTZ NOT NULL,
        kind TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        description TEXT NOT NULL,
        postings_json JSONB NOT NULL,
        metadata_json JSONB
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_tenant_timestamp
        ON ledger_entries (tenant_id, timestamp ASC)`,
      `CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL,
        actor TEXT NOT NULL,
        role TEXT NOT NULL,
        action TEXT NOT NULL,
        resource TEXT NOT NULL,
        outcome TEXT NOT NULL,
        details_json JSONB
      )`,
      `CREATE INDEX IF NOT EXISTS idx_audit_tenant_timestamp
        ON audit_events (tenant_id, timestamp DESC)`,
    ],
  },
  {
    version: 2,
    name: 'candles_timeseries_archive_and_timescale',
    statements: [
      `CREATE TABLE IF NOT EXISTS candles_archive (
        pair TEXT NOT NULL,
        interval TEXT NOT NULL,
        open_time_ms BIGINT NOT NULL,
        open DOUBLE PRECISION NOT NULL,
        high DOUBLE PRECISION NOT NULL,
        low DOUBLE PRECISION NOT NULL,
        close DOUBLE PRECISION NOT NULL,
        volume DOUBLE PRECISION NOT NULL,
        ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (pair, interval, open_time_ms)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_candles_pair_interval_time
        ON candles_archive (pair, interval, open_time_ms DESC)`,
      `DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
          PERFORM create_hypertable(
            'candles_archive',
            'open_time_ms',
            chunk_time_interval => 604800000,
            if_not_exists => TRUE
          );
        END IF;
      END
      $$`,
    ],
  },
]
