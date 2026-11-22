# Ticket 06: 8-Strategy Engine Registry, G1/G2 Safety Gates & Canary Risk Controller (Wave 2)

- **Status:** `ready-for-agent`
- **Blocked by:** `01, 05`
- **Wave:** `2` (Parallel with Ticket `04`)
- **Owned Files (Create only — zero overlap with Ticket `04`):**
  - `src/prediction/engine/types.ts`
  - `src/prediction/engine/gates.ts`
  - `src/prediction/engine/strategies.ts`
  - `src/prediction/engine/promotion.ts`
  - `src/prediction/engine/strategies.test.ts`

---

## Goal

Implement the executable **8-strategy engine** (`src/prediction/engine/*`), always-on safety gates **`G1` (regime/microstructure)** and **`G2` (oracle/basis/resolution-source)**, explicit **`avoid` exclusions**, **Promotion Gate Enforcer**, and **Canary Risk Controller** (`$5` fixed trade size, `3-4` losing trades/day circuit breaker, `$15` BTC single-factor open exposure cap).

---

## Technical Requirements

1. **`src/prediction/engine/types.ts`:**
   - Canonical IDs (`PredictionEngineStrategyId`):
     `'c5-late-favorite' | 'c5-nowcast-maker' | 'c15-favorite-carry' | 'c15-late-favorite-guarded' | 'c1h-late-nowcast' | 'c1h-exhaustion-limit' | 'cx-nested-coherence' | 'c5-15-longshot-fade'`
   - `StrategyLane = 'high-hit-rate' | 'edge'`
   - `StrategyLifecycleMode = 'disabled' | 'research' | 'paper' | 'canary' | 'scale'`
   - `StrategyContext` (active window metadata + `secondsRemaining` + `secondsElapsed` + `OracleSnapshot` + `WindowOrderBookSnapshot` + `NowcastEstimate` + `hourlyIndicators?: { consecutiveRedHours: number; rsi14: number | null }` + `nestedParentQuote?` + `macroBlackoutWindows` + `nowMs`)
   - `StrategyIntent` (`strategyId`, `lane`, `slug`, `timeframe`, `outcome: 'YES' | 'NO'`, `side: 'BUY' | 'SELL'`, `liquidityRole: 'taker' | 'maker'`, `orderType: 'FOK' | 'GTC'`, `limitPrice`, `stakeUsd`, `pModel`, `expectedEdgePerShare`, `cancelAtSecondsRemaining?: number`, `reason`)
   - `CanaryRiskConfig`:
     - `stakeUsd: 5` (default `$5`)
     - `maxDailyLosses: 3 | 4` (default `3`, configurable up to `4`)
     - `maxDailyLossUsd: 15 | 20` (default `maxDailyLosses * stakeUsd`)
     - `maxConcurrentBtcExposureUsd: 15` (BTC single-factor cap across 5m/15m/1h)

2. **`src/prediction/engine/gates.ts` (`evaluateSafetyGates`):**
   - **Global Exclusion Rule (`avoid`):**
     - Block taker entries during `[T, T+60s]` (`secondsElapsed < 60`) on `5m` and `15m`.
     - Explicitly mark `BITCOIN_20_PREDICTIONS` custom FLARE rules as rejected if mistakenly passed to Polymarket Up/Down execution.
   - **`G1` Regime & Microstructure Gate:**
     - Block inside macro blackout (`+-30m` around operator-configured FOMC/CPI/NFP timestamps).
     - Block when `sigma1m > 3 * median24hSigma1m`.
     - Block when `book.minTop5DepthUsd < 200`, `spread > 0.03`, or quote age `> 10_000ms`.
   - **`G2` Oracle & Basis Integrity Gate:**
     - Block when `resolutionSource === 'unknown'`.
     - Block when active oracle feed (`chainlink` for `'chainlink-twap-60s'`, `binance` for `'binance-1h-candle'`) is stale (`> 15_000ms`).
     - Block when `basisBps > 25` (`|oracle - binance| / binance > 0.25%`).

3. **`src/prediction/engine/strategies.ts` (All 8 Strategies):**
   Implement pure `evaluate(ctx: StrategyContext): StrategyIntent[]` evaluators for:
   1. `c5-late-favorite` (`5m`, `high-hit-rate`, default `paper`): remaining `30..120s`, `pModel >= 0.94`, `ask <= pModel - 0.02`, `ask <= 0.97`, FOK taker.
   2. `c5-nowcast-maker` (`5m`, `edge`, default `paper`): remaining `90..240s`, `|z| <= 2.5`, quotes YES & NO bids around `0.75*pModel + 0.25*mid - buffer - spread/2` with `buffer = max(0.015, 0.35*feePerShare)` (`cancelAtSecondsRemaining: 20`); emits taker override if `|pModel - ask| >= 0.10` and `depth >= 3 * stakeUsd`.
   3. `c15-favorite-carry` (`15m`, `edge`, default `paper`): remaining `>= 300s`, best side ask in `[0.70, 0.88]`, `ask <= pModel - 0.04`.
   4. `c15-late-favorite-guarded` (`15m`, `high-hit-rate`, default `research`): remaining `45..180s`, `pModel >= 0.94`, `ask <= 0.96`, strict `pModel - ask >= 0.04` floor.
   5. `c1h-late-nowcast` (`1h`, `high-hit-rate`, default `research`): remaining `60..600s`, `|z| >= 2.0`, `pModel >= 0.93`, `ask <= pModel - 0.02`, `ask <= 0.97`.
   6. `c1h-exhaustion-limit` (`1h`, `edge`, default `paper`): `consecutiveRedHours >= 3 || (rsi14 !== null && rsi14 < 35)`, GTC limit BUY UP at `min(0.52, ask)`, rejects if `ask > 0.54`, `cancelAtSecondsRemaining: 3000` (cancels if unfilled at T+10m).
   7. `cx-nested-coherence` (`5m`/`15m`/`1h`, `edge`, default `research`): compares parent & child `pModel` joint probability using `computeNestedConditionalYes` from `Ticket 05`; emits trade on whichever leg is mispriced by `>= 0.04`.
   8. `c5-15-longshot-fade` (`5m`/`15m`, `edge`, default `paper`): detects overpriced `[0.20, 0.30]` opposite side (`sideBid >= pSide + 0.05`) and buys favorite side in `[0.70, 0.80]` with `ask <= pFav - 0.03`.

4. **`src/prediction/engine/promotion.ts`:**
   - Validates transitions (`research -> paper -> canary -> scale`):
     - Refuses transition to `canary` or `scale` unless `PromotionReport.eligibleForCanary` is `true` (`n >= 500`, `wilsonLowerBoundPct >= avgBreakEvenPct + 1.0`, `netPnlUsd > 0`, `meanMarkout30s >= -0.02`), OR explicit operator force override flagged in audit log.
   - Implements `checkCanaryRiskBudget(openPositions, todayLossesCount, todayLossUsd, config)` enforcing `$5`/trade, `3-4` daily losses limit (`$15-$20`/day), and `$15` BTC single-factor exposure cap.

---

## Verification & Acceptance Criteria

1. `src/prediction/engine/strategies.test.ts` thoroughly tests every strategy (#1-#8), `G1` blackout/vol/depth/spread/age rejections, `G2` stale/basis/unknown-resolution rejections, first-60s exclusion rule, promotion gate enforcement (`n < 500` block vs pass), and canary budget (`$5` trade, 3-loss halt, `$15` BTC factor cap).
2. Run sequentially: `npm run build`, `npm run lint`, `npm test` — all must exit `0`.

## Comments
