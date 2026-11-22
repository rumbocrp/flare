# Ticket 05: Nowcast Math, Isotonic Calibration & Out-of-Sample Replay Harness (Wave 1)

- **Status:** `ready-for-agent`
- **Blocked by:** `01`
- **Wave:** `1` (Parallel with Tickets `02` and `03`)
- **Owned Files (Create only — zero overlap with other Wave 1 workers):**
  - `src/prediction/nowcast.ts`
  - `src/prediction/calibration.ts`
  - `src/prediction/replayHarness.ts`
  - `src/prediction/nowcast.test.ts`
  - `src/prediction/replayHarness.test.ts`

---

## Goal

Build the pure, browser-and-server-safe quantitative core of the prediction engine:
1. Log-space diffusion **nowcast probability model** (`normalCdf(z)`) + nested `5m`/`15m`/`1h` joint path coherence math.
2. Out-of-sample **Pool Adjacent Violators (PAV) isotonic calibration** and **Brier score** comparison (`Brier_model` vs `Brier_market`).
3. Deterministic **Replay & Promotion Backtester** (`runWindowReplay`) over collected real `5m`/`15m`/`1h` windows with zero future data leakage (`train/test` chronological split), fee-aware edge math (`polymarketFeePerShare` from `src/predictionMarket.ts`), Wilson 95% lower bound, and `+30s` markout.

---

## Technical Requirements

1. **`src/prediction/nowcast.ts`:**
   - `normalCdf(z: number): number` — accurate Abramowitz & Stegun / erf approximation (max error `< 1e-7`), handling extreme `|z| > 8` safely in `(0.0001, 0.9999)`.
   - `computeNowcast(input)`:
     - Inputs: `openTwap` (`S0`), `currentTwap` (`St`), `secondsRemaining`, `sigma1m` (effective, already floored by `0.35 * median24h`), `marketMidYes?`.
     - Math:
       - `remainingMinutes = Math.max(1 / 60, secondsRemaining / 60)`
       - `z = Math.log(St / S0) / (sigma1m * Math.sqrt(remainingMinutes))`
       - `pRawYes = normalCdf(z)`
       - `pBlendedYes = marketMidYes !== undefined ? 0.75 * pRawYes + 0.25 * marketMidYes : pRawYes` (configurable blend weight)
     - Outputs: `{ z, pRawYes, pBlendedYes, remainingMinutes, valid: boolean }`.
   - `computeNestedConditionalYes(parentOpen, childOpen, currentTwap, parentRemainingSec, childRemainingSec, sigma1m)`:
     - Prices child vs parent path consistency when `5m` tiles inside `15m` or `15m` tiles inside `1h`, flagging arbitrage/dislocation between parent leg and child leg when `|P_joint - marketMid| >= 0.04`.

2. **`src/prediction/calibration.ts`:**
   - `fitIsotonicCalibrator(samples: readonly { pRaw: number; outcome: 0 | 1 }[])`: Pool Adjacent Violators (PAV) monotone step calibration fitted strictly on training windows (`trainRatio = 0.7`), falling back linearly/identity when `< 30` training samples.
   - `applyCalibrator(calibrator, pRaw): number` clamped safely to `[0.01, 0.99]`.
   - `computeBrierScore(predictions: readonly { p: number; outcome: 0 | 1 }[]): number` and `brierSkillScore(modelBrier, marketBrier): number`.

3. **`src/prediction/replayHarness.ts`:**
   - Pure evaluator taking chronological `CollectedWindowReplayInput[]` (windows + their intrawindow snapshot series) and a `StrategyReplayEvaluator` callback `(snapshot, calibratedPYes, window) -> ReplayIntent | null`.
   - Enforces chronological `train/test` split (`trainRatio = 0.7`): calibrator fits ONLY on train windows; equity curve, fees (`polymarketFeePerShare`), spread drag, hit rate, Wilson 95% lower bound (`computeWilsonLowerBoundPct`), mean break-even win rate (`mean(entryPrice + feePerShare)`), edge vs break-even in pp, `Brier_model` vs `Brier_market`, `+30s` markout, max drawdown, and pass/fail `PromotionReport` compute ONLY on out-of-sample test windows.
   - Enforces minimum `n >= 500` windows gate inside `PromotionReport.eligibleForPaperLive` (separate informational warning when `n < 500` so operators see progress e.g. `142 / 500`).

---

## Verification & Acceptance Criteria

1. `src/prediction/nowcast.test.ts` checks `normalCdf(0) === 0.5`, `normalCdf(1.96) ≈ 0.975`, `z=0 -> p=0.5`, monotonic response to `St > S0`, zero-division / NaN safety on invalid `S0`/`sigma1m`, and nested parent/child coherence math.
2. `src/prediction/replayHarness.test.ts` checks PAV monotonicity, out-of-sample train/test isolation (zero leakage), exact fee & break-even calculation using `POLYMARKET_FEES.crypto`, and rejection of promotion when `n < 500`, `wilsonLB < breakEven + 1pp`, or negative markout.
3. Run sequentially: `npm run build`, `npm run lint`, `npm test` — all must exit `0`.

## Comments
