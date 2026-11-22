# Ticket 04: SQL Schema v3 Prediction Tables & Continuous Window Collector (Wave 2)

- **Status:** `ready-for-agent`
- **Blocked by:** `01, 02, 03`
- **Wave:** `2` (Parallel with Ticket `06`)
- **Owned Files (Modify / Create only — zero overlap with Ticket `06`):**
  - Modify: `src/server/store/types.ts`, `src/server/store/sqliteStore.ts`, `src/server/store/postgresMigrations.ts`, `src/server/store/postgresStore.ts`, `src/server/store/store.test.ts`
  - Create: `src/server/prediction/windowCollector.ts`, `src/server/prediction/windowCollector.test.ts`

---

## Goal

Persist every observed `5m`, `15m`, and `1h` Polymarket BTC Up/Down window, intrawindow price/book snapshots, shadow/canary execution trades, and per-strategy promotion state in both `SqliteStateStore` (`node:sqlite` WAL) and `PostgresStateStore`, and run a continuous **Window Collector** (`windowCollector.ts`) that captures real market history (`n >= 500` windows per strategy) without losing state across restarts.

---

## Technical Requirements

1. **Extend Storage Contract (`src/server/store/types.ts`):**
   Add strongly typed records and `StateStore` methods:
   - `CollectedWindowRecord` (`slug`, `timeframe`, `conditionId`, `upTokenId`, `downTokenId`, `resolutionSource`, `startTimeMs`, `endTimeMs`, `openTwap`, `closeTwap`, `resolvedUp`, `tickSize`, `negRisk`, `volumeUsd`, `updatedAt`)
   - `WindowSnapshotPoint` (`slug`, `capturedAtMs`, `secondsRemaining`, `twapPrice`, `binancePrice`, `sigma1m`, `basisBps`, `yesBid`, `yesAsk`, `yesDepthUsd`, `noBid`, `noAsk`, `noDepthUsd`, `pModelYes`)
   - `StoredPredictionTrade` (`id`, `tenantId`, `strategyId`, `lane`, `mode`, `slug`, `timeframe`, `outcome`, `liquidityRole`, `entryTimeMs`, `entryPrice`, `feeUsd`, `stakeUsd`, `shares`, `pModel`, `pCalibrated`, `markout30s`, `resolvedUp`, `won`, `netPnlUsd`, `venueOrderId`, `status`)
   - `StoredStrategyState` (`tenantId`, `strategyId`, `mode: 'disabled' | 'paper' | 'canary' | 'scale'`, `haltedReason`, `updatedAt`)
   - Add `StateStore` methods:
     - `upsertPredictionWindow(window)` / `getPredictionWindows(options)` / `getSettledWindowCount(timeframe?)`
     - `appendPredictionSnapshot(snapshot)` / `getPredictionSnapshots(slug)`
     - `upsertPredictionTrade(trade)` / `getPredictionTrades(tenantId, options?)`
     - `setStrategyModeState(state)` / `getStrategyModeStates(tenantId)`

2. **Add Migration `v3` (`sqliteStore.ts` & `postgresMigrations.ts`) + Implement in Both Drivers (`sqliteStore.ts`, `postgresStore.ts`):**
   - `version: 3`, name `'prediction_engine_windows_snapshots_trades'`.
   - Create `prediction_windows`, `prediction_window_snapshots` (with `UNIQUE(slug, captured_at_ms)` idempotent upsert), `prediction_shadow_trades`, and `prediction_strategy_states` + time/timeframe indexes in both SQLite and PostgreSQL.
   - Update `pruneRetention(retentionDays)` cleanly if appropriate (note: preserve settled `prediction_windows` longer or keep configurable `windowRetentionDays = 365` so the `500+`-window backtest dataset is not prematurely wiped at 90 days!).

3. **Create `src/server/prediction/windowCollector.ts`:**
   - Service `PredictionWindowCollector` polling active & recently closed `5m`, `15m`, `1h` windows via `fetchPolymarketUpDown` (`Ticket 03`) + `ClobBookFeed` (`Ticket 03`) + `OracleFeedService` (`Ticket 02`).
   - Captures:
     - Window open TWAP (`S0`) from `OracleFeedService.getWindowOpenTwap(startTimeMs)` when available
     - Intrawindow snapshots every `10s` (or `2s` in the final `180s` of a window!) combining Chainlink TWAP, Binance spot, `sigma1m`, `basisBps`, live CLOB YES/NO bid/ask/top-5 depth, and optional `pModelYes`
     - Final settlement (`resolvedUp`, `closeTwap`) once Gamma marks `closed === true` and outcome resolves
   - Idempotent (`UNIQUE(slug, captured_at_ms)`); handles upstream HTTP/WS errors cleanly without synthetic data; exposes `getCollectorStats()` (`settledCountsByTimeframe`, `activeSlugs`, `lastCaptureAtMs`, `errorCount`).

---

## Verification & Acceptance Criteria

1. `src/server/store/store.test.ts` verifies SQLite migration `v3` idempotency, upsert/query of windows, snapshots, shadow trades, and strategy mode states surviving close/reopen.
2. `src/server/prediction/windowCollector.test.ts` verifies full window lifecycle (`open` snapshot capture -> settlement update -> deduped replay query) using mocked fetch/book/oracle feeds.
3. Run sequentially: `npm run build`, `npm run lint`, `npm test` — all must exit `0`.

## Comments
