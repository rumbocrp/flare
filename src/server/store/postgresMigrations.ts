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
        start_time_ms BIGINT NOT NULL,
        end_time_ms BIGINT NOT NULL,
        open_twap DOUBLE PRECISION,
        close_twap DOUBLE PRECISION,
        resolved_up BOOLEAN,
        tick_size DOUBLE PRECISION,
        neg_risk BOOLEAN NOT NULL DEFAULT FALSE,
        volume_usd DOUBLE PRECISION,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pred_windows_tf_start
        ON prediction_windows (timeframe, start_time_ms DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_pred_windows_resolved_end
        ON prediction_windows (resolved_up, end_time_ms DESC)`,
      `CREATE TABLE IF NOT EXISTS prediction_window_snapshots (
        id BIGSERIAL PRIMARY KEY,
        slug TEXT NOT NULL,
        captured_at_ms BIGINT NOT NULL,
        seconds_remaining DOUBLE PRECISION NOT NULL,
        twap_price DOUBLE PRECISION,
        binance_price DOUBLE PRECISION,
        sigma_1m DOUBLE PRECISION,
        basis_bps DOUBLE PRECISION,
        yes_bid DOUBLE PRECISION,
        yes_ask DOUBLE PRECISION,
        yes_depth_usd DOUBLE PRECISION,
        no_bid DOUBLE PRECISION,
        no_ask DOUBLE PRECISION,
        no_depth_usd DOUBLE PRECISION,
        p_model_yes DOUBLE PRECISION,
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
        entry_time_ms BIGINT NOT NULL,
        entry_price DOUBLE PRECISION NOT NULL,
        fee_usd DOUBLE PRECISION NOT NULL,
        stake_usd DOUBLE PRECISION NOT NULL,
        shares DOUBLE PRECISION NOT NULL,
        p_model DOUBLE PRECISION NOT NULL,
        p_calibrated DOUBLE PRECISION NOT NULL,
        markout_30s DOUBLE PRECISION,
        resolved_up BOOLEAN,
        won BOOLEAN,
        net_pnl_usd DOUBLE PRECISION,
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
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (tenant_id, strategy_id)
      )`,
    ],
  },
  {
    version: 4,
    name: 'runtime_events_strategy_audits_and_order_fills',
    statements: [
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS filled_qty DOUBLE PRECISION`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS avg_price DOUBLE PRECISION`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee DOUBLE PRECISION`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_asset TEXT`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`,
      `CREATE TABLE IF NOT EXISTS runtime_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json JSONB,
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
        created_at TIMESTAMPTZ NOT NULL,
        preset_id TEXT NOT NULL,
        preset_name TEXT NOT NULL,
        domain TEXT NOT NULL,
        pair TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        from_time_ms BIGINT NOT NULL,
        to_time_ms BIGINT NOT NULL,
        candles INTEGER NOT NULL,
        metrics_json JSONB NOT NULL,
        assumptions_json JSONB NOT NULL,
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
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS preset_id TEXT`,
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
        from_time_ms BIGINT NOT NULL,
        to_time_ms BIGINT NOT NULL,
        candle_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        config_json JSONB NOT NULL,
        progress_json JSONB,
        metrics_json JSONB,
        folds_json JSONB,
        equity_json JSONB,
        trades_json JSONB,
        assumptions_json JSONB NOT NULL,
        data_source TEXT NOT NULL,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ
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
        entry_qty DOUBLE PRECISION NOT NULL,
        exit_qty DOUBLE PRECISION,
        entry_avg_price DOUBLE PRECISION NOT NULL,
        exit_avg_price DOUBLE PRECISION,
        entry_fee_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        exit_fee_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        stop_price DOUBLE PRECISION,
        target_price DOUBLE PRECISION,
        protection_order_id TEXT,
        realized_pnl_usd DOUBLE PRECISION,
        r_multiple DOUBLE PRECISION,
        exit_reason TEXT,
        opened_at TIMESTAMPTZ NOT NULL,
        closed_at TIMESTAMPTZ
      )`,
      `CREATE INDEX IF NOT EXISTS idx_exchange_positions_tenant_mode_status
        ON exchange_positions (tenant_id, mode, status, opened_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_exchange_positions_tenant_preset_closed
        ON exchange_positions (tenant_id, preset_id, closed_at DESC)`,
    ],
  },
]
