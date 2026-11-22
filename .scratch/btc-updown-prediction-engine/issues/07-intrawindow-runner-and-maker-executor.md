# Ticket 07: Intra-Window Runner (`1-2s`) & Maker/Taker Polymarket Executor (Wave 3)

- **Status:** `ready-for-agent`
- **Blocked by:** `02, 03, 04, 06`
- **Wave:** `3` (Sequential integration wave after Wave 2 merges)
- **Owned Files:**
  - Modify: `src/server/polymarketExecutor.ts`, `src/server/polymarketExecutor.test.ts`
  - Create: `src/server/prediction/predictionRunner.ts`, `src/server/prediction/predictionRunner.test.ts`

---

## Goal

Upgrade `src/server/polymarketExecutor.ts` to support GTC maker order posting/cancellation and timed window-end sweeps (`T-20s`), and build `src/server/prediction/predictionRunner.ts` as the continuous `1-2s` intra-window execution loop driving all 8 strategies across `Backtest -> Paper -> Canary -> Scale`.

---

## Technical Requirements

1. **Extend `src/server/polymarketExecutor.ts`:**
   - Keep existing `submitPolymarketOrder`, `cancelPolymarketOrder`, `cancelAllPolymarketOrders`, `reconcilePolymarketAccount`, `HardRiskLimits`, dual-key arming (`POLY_PRIVATE_KEY` + `FLARE_POLYMARKET_LIVE=true`), and `registerKillSwitchHandler` intact.
   - Add **explicit resting GTC maker limit helper** (`submitPolymarketMakerQuote`):
     - Places post/limit bid on `tokenId` rounded to `tickSize` using `createAndPostOrder` (`OrderType.GTC`).
     - Supports `cancelOrdersForWindow(tenantId, instrumentId)` so the intra-window runner sweeps resting maker orders cleanly at `T-20s` / `T-90s` / `T+10m` without canceling unrelated timeframes.
   - Support optional `stakeUsd` fixed-dollar canary override when `maxOrderNotionalUsd` allows (`$5` default in canary).

2. **Create `src/server/prediction/predictionRunner.ts`:**
   - Coordinates `OracleFeedService` (`02`), `fetchPolymarketUpDown` + `ClobBookFeed` (`03`), `PredictionWindowCollector` & `StateStore` (`04`), `calibration`/`nowcast` (`05`), and `strategies`/`gates`/`promotion`/`canaryRisk` (`06`).
   - **Loop cadence:** `1,500ms` intra-window tick (`runTick(nowMs)`) across currently open `5m`, `15m`, and `1h` windows:
     1. Updates `S0` (open TWAP), `St` (live TWAP), `sigma1m`, `basisBps`, live CLOB books, and hourly BTC candle context (from `getMarketGateway().getCandles('BTC/USDT', '1h', 100)`).
     2. Fits / caches out-of-sample PAV `CalibrationCurve` from settled SQL windows (`recalibration` every 25 new settled windows).
     3. Sweeps/cancels any resting GTC maker orders whose `cancelAtSecondsRemaining` threshold has elapsed (`T-20s`, `T-90s`, or 1h limit expiry).
     4. Evaluates each active strategy (`mode === 'paper' | 'canary' | 'scale'`):
        - Enforces `G1` & `G2` gates and first-60s exclusion.
        - **Paper mode:** logs & persists `StoredPredictionTrade` (`mode: 'paper'`, `status: 'OPEN'`) with simulated executable fill at live book `ask` (taker) or resting limit cross (maker) + real `polymarketFeePerShare` + scheduled `+30s` markout capture. No wallet funds touched.
        - **Canary / Scale mode:** checks `checkCanaryRiskBudget` (`$5` trade, `3-4` daily losses, `$15` BTC factor cap) and `PromotionReport` eligibility; routes through `submitPolymarketOrder` or `submitPolymarketMakerQuote` with deterministic `clientOrderId` (`pe-${strategyId}-${slug}-${outcome}`).
        - **Auto Kill-Switch:** trips per-strategy halt automatically if strategy kill-switch breaches (`5` consecutive `|P_model - outcome| > 0.15`, `30-fill markout < -4c`, or daily loss limit reached).
     5. Settles open paper/canary trades once window closes (`resolvedUp !== null`), computing `won` and `netPnlUsd`, posting balanced settlement ledger entry via `buildPredictionSettlementEntry` / `appendTenantLedgerEntry` where applicable, and updating daily loss counters cleanly across restarts (hydrated from SQL `prediction_shadow_trades` + `prediction_strategy_states`).
   - Expose typed status snapshot `getPredictionEngineStatus(tenantId)` and controls `setPredictionStrategyMode(tenantId, strategyId, mode, forceOverride?)`, `updateCanaryRiskConfig(tenantId, config)`, `runStrategyReplay(strategyId)`.

---

## Verification & Acceptance Criteria

1. `src/server/polymarketExecutor.test.ts` adds tests for `submitPolymarketMakerQuote` and `cancelOrdersForWindow`.
2. `src/server/prediction/predictionRunner.test.ts` uses an in-memory SQLite store (`:memory:`), fake oracle/book feeds, and fake `PolymarketClobClientLike` to verify:
   - `T-20s` maker cancellation sweep
   - `G1`/`G2` blocking & first-60s exclusion
   - Paper shadow fill -> `+30s` markout -> settlement PnL persistence & restart hydration
   - Canary `$5` sizing, `3`-loss UTC daily circuit breaker, `$15` BTC concurrent factor cap, and promotion block before `n = 500`
3. Run sequentially: `npm run build`, `npm run lint`, `npm test` — all must exit `0`.

## Comments
