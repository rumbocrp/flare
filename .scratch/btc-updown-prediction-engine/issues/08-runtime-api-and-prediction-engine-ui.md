# Ticket 08: Runtime HTTP API, Client Bindings & Prediction Engine Operator UI (Wave 4)

- **Status:** `ready-for-agent`
- **Blocked by:** `07`
- **Wave:** `4` (Final integration wave)
- **Owned Files:**
  - Modify: `src/server/botRuntime.ts`, `src/api/botClient.ts`, `src/pages/Predictions.tsx`, `src/i18n.tsx`
  - Create: `src/server/prediction/predictionApi.test.ts`

---

## Goal

Expose the Prediction Engine runtime over authenticated, RBAC-scoped, rate-limited HTTP routes in `botRuntime.ts`, wire typed client wrappers in `botClient.ts`, and add an **Engine Orchestrator** tab to `src/pages/Predictions.tsx` so operators can track collector progress (`n / 500`), compare the High-Hit-Rate and Edge lanes, run out-of-sample replays, and manage `Paper -> Canary ($5, 3-4 losses/day) -> Scale` promotions safely.

---

## Technical Requirements

1. **HTTP Endpoints in `src/server/botRuntime.ts`:**
   - `GET /api/prediction-engine/status` (`read:state`): returns live `PredictionEngineStatus` (collector window counts for `5m`/`15m`/`1h`, live Oracle Chainlink TWAP + Binance spot + `sigma1m` + `basisBps`, gate statuses `G1`/`G2`, all 8 strategy states/modes/KPIs, canary risk budget usage, open & recent settled prediction trades).
   - `GET /api/prediction-engine/windows?tf=5m&limit=50` (`read:state`): returns stored SQL `prediction_windows` and recent `prediction_shadow_trades`.
   - `POST /api/prediction-engine/mode` (`risk:manage` when promoting to `canary`/`scale` or overriding gates; `trade:execute` for `paper`/`disabled`):
     - Updates strategy lifecycle mode, updates `CanaryRiskConfig` (`stakeUsd`, `maxDailyLosses: 3 | 4`, `maxConcurrentBtcExposureUsd`), updates macro blackout timestamps, or trips manual halt; records immutable `audit_events` row.
   - `POST /api/prediction-engine/replay` (`run:research`):
     - Executes `runStrategyReplay(strategyId)` across collected SQL `5m`/`15m`/`1h` windows and returns `PromotionReport` (`n`, train/test split, hit rate, Wilson 95% LB, break-even win rate, edge in pp, `Brier_model` vs `Brier_market`, `+30s` markout, net PnL, `eligibleForCanary`).
   - Start/stop collector & intra-window runner cleanly inside `ensureBackgroundWorker()` / `shutdownRuntime()` in `botRuntime.ts` (never auto-start loops during `VITEST` unless explicitly invoked in tests).

2. **Typed Client Helpers in `src/api/botClient.ts`:**
   - Export `getPredictionEngineStatus()`, `getPredictionEngineWindows(tf, limit)`, `updatePredictionStrategyMode(...)`, `updatePredictionCanaryConfig(...)`, `runPredictionReplay(strategyId)`.

3. **Operator UI in `src/pages/Predictions.tsx` + `src/i18n.tsx`:**
   - Add an `'engine'` (`Engine` / `Motor`) tab alongside `'rules' | 'simulator' | 'polymarket'` (supporting `'5m' | '15m' | '1h'` in Polymarket Market tab as well).
   - **Engine Tab Layout (Operate mode, clean shadcn/ui tables & controls):**
     - **Top Telemetry Strip:** Live Chainlink RTDS TWAP vs Binance spot (`basisBps`), `sigma1m`, `G1` & `G2` gate health badges, Collector sample counter (`5m: n`, `15m: n`, `1h: n` toward `500` target), Daily Canary Budget (`lossesToday / 3-4`, `$exposure / $15`).
     - **Canary Controls Bar:** configure ticket size (`$5`), daily loss limit (`3` or `4` losses -> `$15` or `$20`), BTC concurrent factor cap (`$15`), and macro blackout timestamps.
     - **Two-Lane Strategy Matrix:**
       - *Lane A — High-Hit-Rate (`>90%` Target)* (`c5-late-favorite`, `c15-late-favorite-guarded`, `c1h-late-nowcast`)
       - *Lane B — Edge & Maker (`50-87%` Hit Rate)* (`c5-nowcast-maker`, `c15-favorite-carry`, `c1h-exhaustion-limit`, `cx-nested-coherence`, `c5-15-longshot-fade`)
       - Each row shows TF, mode badge (`Research / Paper / Canary / Scale`), collected `n/500`, out-of-sample Hit Rate vs Break-Even (`pp`), Wilson 95% LB, `Brier` delta, `+30s` markout, Replay button, and Mode switcher (with `AlertDialog` warning if operator attempts to force-promote before `n >= 500` or failed gate).
     - **Live Open & Recent Settled Tickets Table.**
   - **Clarify Legacy 20 Rules Tab:** rename header/badge on the `'rules'` tab to explicitly state `Research / Custom Signal Rules (Non-Polymarket Binary Contracts)` so operators never confuse Binance custom rule win rates with live Polymarket Up/Down contract win rates.

---

## Verification & Acceptance Criteria

1. `src/server/prediction/predictionApi.test.ts` verifies RBAC (`viewer` gets `403` on `/mode`, `trader`/`risk_manager` get `200`, promotion rejection when `< 500` windows without override), `/status`, `/windows`, and `/replay`.
2. Run `\.agent\skills\impeccable\scripts\impeccable.cmd detect --json src/pages/Predictions.tsx` — zero critical/high craft violations.
3. Run sequentially: `npm run build`, `npm run lint`, `npm test` — all must exit `0`.

## Comments
