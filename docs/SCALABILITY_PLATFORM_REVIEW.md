# FLARE Platform Scalability Review

**Scope:** the trading surface (instruments, venues, contract types), intervals, strategy runtime, and the prediction-market plan — reviewed as one system, with scalability as an explicit design goal.
**Date:** 2026-11-15
**Companion:** [`docs/PREDICTION_MARKET_PLAYBOOK.md`](./PREDICTION_MARKET_PLAYBOOK.md)
**Status:** architecture review + target design + phased plan. Not financial advice.

Evidence labels used throughout:

| Label | Meaning |
|---|---|
| **Measured** | Counted in the repository or computed from raw market data. |
| **Structural** | Follows from the current architecture or market mechanism; not a benchmark. |
| **Target** | A proposed SLO, capacity, or design goal; not achieved today. |
| **Hypothesis** | A reasoned expectation that still needs validation. |

---

## 0. Executive verdict

FLARE today is a **single-operator research terminal with unusually good evidence discipline and unusually thin runtime truth**. The research layer — the playbook, the fee model, the calibration work, the 19-strategy catalog — is ahead of the runtime that is supposed to execute it. The platform can run one bot, on one preset, for one pair, against one JSON state file, and render a very good chart. That is a legitimate product. It is not yet a platform.

The good news is that the hardest part is already done: knowing which edges are real. The playbook correctly rejects the easy story (Binance indicators transfer to Polymarket), prices the fee curve properly, and labels evidence. Scaling should preserve that epistemic rigor while removing the single-operator assumptions.

**Verdict:** scale is the right ambition, but the order matters. Build **shared truth** first, then **shared execution**, then **breadth**. Adding pairs, intervals, strategies, or tenants before those primitives will multiply inconsistencies rather than capacity.

- **Strong:** pure deterministic engine, typed prediction catalog, fee-aware math, evidence labels, 85 passing tests, atomic state writes, anti-repainting and kill-switch reflexes.
- **Weak:** one global bot, one JSON state file, full-snapshot SSE, in-memory risk counters, no auth, no order reconciliation, and a hardcoded 50¢ prediction price.
- **First bottleneck:** truth, not throughput. `marketImpliedPrice = 0.5` (`src/botEngine.ts:749`) means the prediction branch's edge and P&L are not tied to an executable market.
- **Best scalable advantage:** a server-side market-data gateway plus an event-sourced strategy/OMS core that makes every new instrument, interval, venue, and strategy a configuration change rather than a fork.
- **Score:** **2.3 / 5 today; 4.3 / 5 target.** The evidence layer is already at target; the runtime is the gap.
- **Time:** roughly 45–60 engineer-weeks to the end of Phase 3, plus ongoing Phase 4. That is a realistic 6–10 month platform build for one to two engineers.

**The one decision:** build a server-side market-data gateway and an event-sourced order/ledger core before adding instruments, intervals, or tenants. Everything else follows from those two.

---

## 1. Why scalability is a plus

Scalability is not vanity. For FLARE it changes the quality of the product in seven concrete ways:

1. **One shared market truth.** Today every browser opens its own Binance WebSocket and backfills its own REST history. Two users can see different candles, different gaps, and different latencies. A server-side gateway makes the bar, timestamp, source, and freshness identical for every strategy and every screen. That is a correctness gain before it is a cost gain.
2. **Strategy inventory instead of strategy demos.** A runtime that can host many strategy instances turns the 19-strategy catalog into paper/shadow/live inventory. Research compounds: every paper trade is evidence, and every strategy version is comparable.
3. **Diversification across uncorrelated games.** Crypto 5m maker, politics favorite carry, sports consensus, and daily ladders have different payoff drivers. Running them together, with correlation-aware capital allocation, reduces path dependence and improves risk-adjusted return per unit of infrastructure.
4. **Best execution and venue resilience.** A venue abstraction lets FLARE route between Polymarket and Kalshi, fail over when one venue degrades, and compare fees and settlement before trading. Single-venue concentration is both a risk and a hidden cost.
5. **Auditability and replay.** Event-sourced orders, fills, quotes, and resolutions make live capital defensible. They also make debugging and research faster: every decision can be replayed against the exact data that produced it.
6. **A multi-tenant revenue and evidence flywheel.** More seats produce more paper evidence, more calibration data, and more strategy variants — provided execution and data are isolated correctly. Scale is how a research terminal becomes a business.
7. **Research velocity.** Horizontal backtest workers and a columnar store turn a 1,000-config grid from an afternoon into minutes. Research velocity is a durable advantage in a market where edges decay.

**Guardrails.** Scale only what has evidence; scale only what has liquidity; scale only behind isolation; scale only with unit economics; scale only after the truth layer is fixed. A bigger platform that reports fictional 50¢ edges is worse than a small one that reports one real edge.

---

## 2. Scope, definitions, and method

**"Trading options"** in this review means the product surface a user can choose to trade: instruments, venues, contract types, and execution modes. It is not limited to exchange-listed options contracts. Listed options are treated as one row in the instrument matrix (§6.2), with their own requirements. If the intended meaning was listed options specifically, §6.5 addresses that case directly.

**Scale** is measured on five axes:

- **Seats:** concurrent operators and tenants.
- **Instruments:** pairs, contracts, venues, and contract types.
- **Strategies:** definitions, versions, and concurrently running instances.
- **Markets:** prediction-market families, events, and outcomes.
- **Data:** events per day, retention, and replay depth.

**Method.** I inspected the current runtime and catalog, counted the actual surface, and worked through the first-order capacity limits. The review is deliberately code-specific: every structural claim points to a file. Forward-looking numbers are labeled **Target** or **Hypothesis**, not measured.

**Non-goals.** This is not a rewrite proposal, not a trading recommendation, and not a promise that more markets produce more return. It is a plan for making the existing design survive more users, instruments, and venues without losing the evidence discipline that makes FLARE interesting.

---

## 3. Current platform inventory

### 3.1 Measured inventory

| Surface | Current implementation | Measured count |
|---|---|---|
| Frontend | React 19 + Vite, 8 pages, custom SVG charts, Tailwind/shadcn | 8 pages |
| Backend | `node:http` single process, 15s background timer, SSE | 1 process |
| API | Hand-rolled router in `src/server/botRuntime.ts` | 18 route handlers |
| Market data (client) | Per-tab Binance WebSocket + REST backfill (`src/market/liveStream.ts`, `src/hooks/useCandles.ts`) | 1 socket per tab |
| Market data (server) | In-memory candle cache, 5–60s TTL, in-flight coalescing, synthetic fallback (`src/server/candleCache.ts`) | 1 cache per process |
| Pairs | `availablePairs` in `src/strategy.ts` | 5 |
| Intervals | `Interval` union + `intervalMs` | 5 |
| Bot presets | `STRATEGY_PRESETS` in `src/botEngine.ts` | 8 |
| BTC prediction rules | `BITCOIN_20_PREDICTIONS` | 20 |
| Directional rules | `src/directionalRules.ts` | 8 |
| Prediction strategies | `src/predictionStrategies.ts` | 19 across 7 families |
| Execution | Demo vault + optional Binance Spot Testnet (`src/server/exchangeAdapter.ts`) | 1 adapter |
| Prediction venue | Read-only Polymarket BTC 5m/15m (`src/server/polymarketAdapter.ts`) | 1 venue, 1 asset, 2 intervals |
| State | Atomic JSON file at `src/server/bot-state.json` | 1 file |
| Tests | Vitest | 11 files, 85 tests |

### 3.2 What is genuinely strong

- **Pure, testable core.** `stepBotEngine`, `runBacktest`, the prediction calculators, and the fee/Kelly functions are deterministic and unit-tested. That is the right foundation for a runtime.
- **Evidence labels and calibration discipline.** The playbook distinguishes measured, published, structural, and hypothesis claims. This is rarer than the code and more valuable.
- **Fee-aware prediction math.** `POLYMARKET_FEES`, `polymarketFeePerShare`, `polymarketFeePctOfStake`, and `effectiveEntryPrice` model the real `C × rate × p × (1-p)` curve instead of a flat percentage.
- **A typed strategy catalog.** `predictionStrategies.ts` gives every strategy a family, status, edge, capacity, risks, and kill switches. It is a good schema waiting for a runtime.
- **Atomic state writes.** The `.tmp` + rename pattern in `botRuntime.ts` prevents partial JSON corruption. It is a good instinct, even though the storage choice is wrong at scale.
- **Anti-repainting and risk guards.** Closed-bar checks, Profit-Lock, hard limits, and a global kill switch show the right safety reflexes.

### 3.3 The single-operator assumptions

The current design is internally coherent because it assumes one trusted operator. That assumption is embedded in ten places:

| # | Assumption | Where it lives | What breaks at scale |
|---|---|---|---|
| 1 | One user | No auth; `Access-Control-Allow-Origin: *`; `server.listen(PORT)` on all interfaces | Anyone on the network can start/stop the bot, change limits, read positions |
| 2 | One bot | Module-level `isRunning`, `activePreset`, `engineState` in `botRuntime.ts` | A second user's preset change mutates the first user's bot |
| 3 | One preset | `activePreset` is a single global | No per-user or per-sleeve strategy selection |
| 4 | One pair/timeframe | `engineState.pair`, `engineState.timeframe` | No concurrent multi-asset execution |
| 5 | One process | In-memory cache, SSE client set, order history | Restart loses state; no horizontal scale |
| 6 | One state file | `STATE_FILE` under `process.cwd()` | Deployment cwd changes lose state; no migrations; synchronous writes |
| 7 | One execution venue | Demo vault + one testnet adapter | No routing, failover, or best execution |
| 8 | One prediction venue | Read-only Polymarket adapter | No cross-venue relative value or resilience |
| 9 | Trusted network | No RBAC, no rate limits, no audit | Not safe for remote users or live capital |
| 10 | Memory is enough | `closedTrades`, `resolvedTickets`, `orderHistory` in RAM | Unbounded growth or silent history loss |

### 3.4 Current runtime in one diagram

```text
┌──────────────┐        wss://stream.binance.com         ┌──────────────┐
│ Browser tab  │ ──────────────────────────────────────▶ │   Binance    │
│ (per user)   │ ◀────────────────────────────────────── │   public WS  │
└──────┬───────┘                                         └──────────────┘
       │  REST /api/*  (no auth, CORS *)
       ▼
┌───────────────────────────────────────────────────────────────────────┐
│  Single Node process (`src/server/index.ts`)                          │
│                                                                       │
│  botRuntime.ts                                                        │
│   ├─ module-level: isRunning, activePreset, engineState               │
│   ├─ 15s setInterval → fetchOptimizedCandles → stepBotEngine          │
│   ├─ SSE: full JSON snapshot to every client                          │
│   └─ JSON state file: src/server/bot-state.json (sync write)          │
│                                                                       │
│  exchangeAdapter.ts   candleCache.ts   polymarketAdapter.ts           │
│  (in-memory limits)   (5–60s TTL)      (read-only BTC 5m/15m)         │
└───────────────────────────────────────────────────────────────────────┘
```

The important structural fact: **the browser talks to Binance directly, while the bot talks to Binance through the server cache.** There are two data planes, with different timestamps and failure modes. At one user this is an inconvenience. At many users it is a correctness problem.

---

## 4. Capacity envelope: what breaks first

### 4.1 Worked ceilings

These are first-order estimates, not benchmarks. They are useful because they identify the order of failure.

| Dimension | Current design | First bottleneck | Rough ceiling before redesign |
|---|---|---|---|
| Concurrent operators | One global engine | Shared mutable state | 1 |
| Concurrent dashboards | Full-snapshot SSE | Bandwidth + slow-client buffering | ~100–300 |
| Charted instruments | 5 pairs, per-tab WS | Browser sockets, vendor limits, inconsistency | ~5–10 per tab |
| Executable instruments | 3 in default hard limits | Hardcoded allowlist | 3 by default |
| Strategy instances | One global bot | Singleton state | 1 |
| Prediction markets | BTC 5m/15m, read-only | Adapter coverage | 2 |
| Orders/day | Hard cap 12 | In-memory counters | 12 |
| Trade/ticket history | Unbounded arrays in JSON | Sync serialization | ~10k–50k records |
| Backtests | One config per browser run | Single-threaded loop | 1 at a time |

### 4.2 Formulas

**SSE bandwidth.** A full snapshot is sent to every client on every tick:

```text
egress_bytes/s = clients × snapshot_bytes / tick_interval_s
```

At a 40 KB snapshot and a 15 s tick:

| Clients | Egress | Per day |
|---:|---:|---:|
| 100 | 0.27 MB/s | 23 GB |
| 1,000 | 2.67 MB/s | 230 GB |
| 10,000 | 26.7 MB/s | 2.3 TB |

This is not fatal at 1,000 clients, but it is wasteful and it grows linearly with state size. A delta feed with a sequence number changes the exponent.

**JSON write amplification.** The state file contains `closedTrades` and `resolvedTickets`:

```text
write_bytes/day = state_bytes × writes/day
state_bytes ≈ fixed_state + records × bytes_per_record
```

At ~400 bytes per pretty-printed record:

- 10,000 records ≈ 4 MB per write; a 5m bot writes on new candles ≈ 288 times/day → ~1.15 GB/day.
- 100,000 records ≈ 40 MB per write → ~11.5 GB/day, and each write blocks the event loop.

**Tick compute.** `stepBotEngine` is O(candles) with a 500-candle lookback. A single tick is milliseconds. The compute is not the bottleneck; the **data fetch and state I/O** are. With a shared bar cache, 10,000 strategy instances at a 15 s cadence is ~667 evaluations/s, which is feasible on a few cores. Without shared data, it is 10,000 vendor requests per 15 s, which is not.

**Prediction quote throughput.**

```text
quote_ops/s = active_markets × sides × (1 / refresh_s)
book_msgs/s = active_markets × updates_per_s × depth_levels
```

At 500 markets, 2 sides, 5 s refresh: 200 quote ops/s. At 20 book updates/s and 10 levels: 100k msgs/s before conflation. Top-5 conflation and batching cut this by 2–4×. The binding constraint is usually the venue's rate limit, not CPU.

**Backtest compute.**

```text
bar_steps = configs × instruments × bars
```

1,000 configs × 1 instrument × 100,000 bars = 10^8 bar-steps. At ~10^6 simple bar-steps/s in a single Node thread, that is ~100 seconds of pure compute, before indicator work and I/O. 100,000 configs is ~3 hours single-threaded. Workers and columnar data are the difference between a research tool and a research platform.

### 4.3 What breaks first

In order:

1. **Truth.** `marketImpliedPrice = 0.5` (`src/botEngine.ts:749`) means the prediction branch's edge and P&L are not tied to an executable market. Scaling this produces more fictional tickets, faster.
2. **Risk state.** Kill switch, daily counters, hard limits, demo balances, and order IDs are module-level (`src/server/exchangeAdapter.ts:72–85`). A restart re-arms the kill switch, resets the daily loss counter, and can reuse order IDs.
3. **Persistence.** Synchronous JSON writes on the event loop, unbounded arrays, no schema version, no retention, and a path tied to `process.cwd()`.
4. **Realtime fanout.** Full snapshots, no delta, no sequence, no backpressure, no heartbeat. A slow client can buffer without bound because `client.write()`'s return value is ignored.
5. **Market data.** Per-tab Binance sockets and REST backfills. This is cheap for one user and inconsistent for many.
6. **Execution reconciliation.** The testnet branch checks `response.ok` but does not parse the exchange order ID, fill quantity, or status; the local vault then records a `FILLED` order independently (`exchangeAdapter.ts:261–334`). There are two truths.
7. **Security.** No auth, wildcard CORS, all-interface bind. This is not a scale limit; it is a stop sign.

---

## 5. Layer-by-layer assessment

| Layer | Today | Ceiling | Verdict | Target |
|---|---|---|---|---|
| Market data ingestion | Browser WS + server cache | Per-tab duplication, no gap recovery | **Replace** | Server-side gateway, normalized bus, shared fanout |
| Bar/interval model | 5-value union + hardcoded TTL map | Adding an interval touches 7+ files | **Refactor** | Interval registry + bar builder |
| Strategy engine | Pure `stepBotEngine`, 8 presets | One global instance, domain branches | **Refactor** | Plugin registry + versioned instances |
| Backtesting | Single-threaded browser loop | One config at a time | **Refactor** | Event-driven sim + worker pool |
| Execution/OMS | Demo vault + testnet POST | In-memory, no reconciliation | **Replace** | OMS state machine + ledger |
| Portfolio/risk | Per-order limits, global kill switch | In-memory, single account | **Replace** | Pre-trade risk + portfolio exposure |
| Prediction market | Read-only BTC 5m/15m | 2 of 12 crypto combos, 0 non-crypto | **Refactor** | Venue abstraction + book/resolution services |
| Persistence | JSON file | Sync writes, unbounded, no migrations | **Replace** | Postgres + event log + retention |
| API/realtime | Hand-rolled router + full SSE | No auth, no pagination, no delta | **Refactor** | Gateway + typed API + delta stream |
| Security/ops | None / console logs | No boundary, no metrics | **Replace** | OIDC/RBAC, OTel, SLOs, audit |

### 5.1 Six structural findings

**1. Market data is client-local and duplicated.** `useCandles` and `liveStream.ts` open a Binance WebSocket per tab and backfill via REST. The server has a separate cache (`candleCache.ts`). There is no single sequence number, no gap detection, and no shared snapshot. At scale, the platform cannot answer "what bar did strategy X see at time T?" without reconstructing it per browser.

**2. The bot is a singleton, not a runtime.** `isRunning`, `activePreset`, and `engineState` are module-level (`botRuntime.ts:62–64`). `stepBotEngine` branches on `domain` and hardcodes `BITCOIN_20_PREDICTIONS` (`botEngine.ts:719–721`). There is no concept of a strategy instance, a tenant, a sleeve, or a version. The eight presets are a static array, not a registry.

**3. Execution is a simulation with a risk façade.** The demo vault updates local balances and marks every accepted order `FILLED` (`exchangeAdapter.ts:320–334`). The testnet branch posts a market order but does not reconcile the response. `resolveExecutionPrice` falls back to hardcoded BTC $85,000 / ETH $2,800 / SOL $175 (`exchangeAdapter.ts:190–193`). There is no order state machine, no partial fill, no cancel/replace, no client order ID, and no startup reconciliation.

**4. Persistence is a file, not a system of record.** `saveStateToDisk` stringifies the entire state synchronously and writes a temp file (`botRuntime.ts:106–122`). `closedTrades` and `resolvedTickets` are unbounded. There is no schema version, migration path, retention policy, or query surface. `loadStateFromDisk` silently starts clean on parse failure (`botRuntime.ts:97–99`), which is the wrong failure mode for a trading system.

**5. The prediction catalog is disconnected from execution and UI.** `predictionStrategies.ts` is imported only by `src/predictionStrategies.test.ts` — neither `botEngine.ts` nor `Predictions.tsx` imports it. The engine's prediction branch uses the rules in `src/predictions.ts` and a fixed 50¢ price (`marketImpliedPrice = 0.5`). The catalog's "deploy / paper / research / avoid" status gates nothing: it is not read by the runtime or surfaced in `Predictions.tsx` (which currently exposes `'rules' | 'simulator' | 'polymarket'` tabs), and no catalog strategy can be instantiated. A strategy marked `avoid` is still a catalog entry; a strategy marked `deploy` cannot be executed through the catalog. The catalog is a research artifact, not an executable or UI inventory.

**6. There is no security boundary.** The server binds all interfaces (`src/server/index.ts:36`), sends `Access-Control-Allow-Origin: *`, and has no authentication, authorization, tenant scoping, rate limiting, or audit log. The only secret handling is `BINANCE_TESTNET_KEY`/`SECRET` from the environment. This is acceptable for a localhost research tool; it is disqualifying for a platform.

---

## 6. Trading surface review

### 6.1 What a user can actually trade today

| Surface | Venue | Mode | Instruments | Intervals | Constraint |
|---|---|---|---|---|---|
| Crypto spot | Binance public data + demo vault | Paper | 5 pairs charted, 3 executable by default | 5m/15m/1h/4h/1d | Demo balances, no real fills |
| Crypto spot | Binance Spot Testnet | Testnet | 3 default pairs | 5m/15m/1h/4h/1d | Requires env credentials; response not reconciled |
| Binary prediction | Polymarket (read-only) | Paper tickets | BTC 5m/15m | 5m/15m | No orders, no positions, no books |
| MT5 bridge | External MT5 EA | Signal packet | Preset pair | Preset timeframe | Polling bridge; execution external |
| Backtest | Local browser | Simulation | 5 pairs | 5 intervals | Single config per run |
| Chart/analysis | Binance public data | Read-only | 5 pairs | 5 intervals | Per-tab data plane |

The mismatch is visible in one line: the UI offers five pairs (`src/strategy.ts:3`), while the demo broker's default hard limits authorize three (`src/server/exchangeAdapter.ts:62`). XRP/DOGE can be charted and backtested but are rejected by the adapter's default limits; the UI does not surface that mismatch. The limit setter also accepts any string array (`exchangeAdapter.ts:428–430`), so the allowlist can drift from the charted instruments. The prediction adapter goes further: BTC only, 5m/15m only.

### 6.2 Instrument matrix

| Contract type | Today | Data | Execution | Risk | Settlement | Scale priority |
|---|---|---|---|---|---|---|
| Spot | Paper + testnet | Binance | Demo/testnet | Simple | Immediate | **P0: make current path truthful** |
| Perpetual future | Absent | Binance futures | Absent | Funding, leverage, liquidation | Continuous | **P2: hedging/inventory** |
| Dated future | Absent | Venue-specific | Absent | Basis, expiry, margin | Expiry | P3 |
| Listed option | Absent | Options chain | Absent | Greeks, IV, margin, assignment | Exercise/settlement | P4: research only |
| Binary prediction | Read-only Polymarket | Gamma/CLOB | Absent | Resolution, oracle, event correlation | $1/$0 at resolution | **P1: venue abstraction** |

The strategic point: **FLARE's native edge is in binary/event markets, not in vanilla options market-making.** Listed options add a large, specialized risk surface (Greeks, vol surface, margin, exercise/assignment, pin risk) that would distract from the prediction-market thesis. Add them only if a specific user demand and a dedicated risk owner exist.

### 6.3 Target: instrument registry + venue adapter

The first new domain object should be an instrument, not another pair constant.

```ts
type InstrumentId = string // e.g. "binance:spot:BTCUSDT", "polymarket:binary:btc-updown-5m"

type Instrument = {
  id: InstrumentId
  venue: VenueId
  symbol: string
  assetClass: 'spot' | 'perp' | 'future' | 'option' | 'binary'
  base: string
  quote: string
  settle: string
  tickSize: number
  lotSize: number
  minNotional: number
  contractMultiplier: number
  tradingHours: '24/7' | SessionCalendar
  capabilities: {
    short: boolean
    leverage: number
    fractional: boolean
    postOnly: boolean
    reduceOnly: boolean
  }
  fees: FeeScheduleRef
}

interface VenueAdapter {
  id: VenueId
  capabilities(): VenueCapabilities
  listInstruments(): Promise<Instrument[]>
  subscribeBook(ids: InstrumentId[], cb: (book: BookSnapshot) => void): Unsubscribe
  getBars(id: InstrumentId, interval: IntervalId, range: BarRange): Promise<Bar[]>
  placeOrder(intent: OrderIntent): Promise<OrderAck>
  cancelOrder(venueOrderId: string): Promise<void>
  getOrder(venueOrderId: string): Promise<OrderState>
  getFills(since: number): Promise<Fill[]>
  getPositions(): Promise<Position[]>
}
```

With this in place, adding XRP/DOGE to execution is a registry entry plus a capability check, not a new branch. Adding a venue is an adapter, not a fork of the engine. The UI reads the registry instead of a constant.

### 6.4 Expansion sequence

1. **Make the current five pairs consistent.** One registry; one allowlist; UI, backtest, demo broker, and testnet all read it. Resolve the XRP/DOGE mismatch.
2. **Add perps only after OMS.** Perps are useful for hedging prediction inventory and for testing short/leverage logic, but they introduce funding, liquidation, and margin. Do not bolt them onto the spot paper engine.
3. **Add a second prediction venue.** Kalshi is the natural second adapter: public market data is reachable without a key at the time of writing, and trading requires authenticated, funded access. The abstraction must expose venue differences, not hide them.
4. **Add sports/politics data feeds.** These are data problems before they are execution problems: odds, fixtures, lineups, resolution rules, calendars.
5. **Listed options last.** Only with a dedicated vol/Greeks/margin model and a clear user. The binary engine is not an options engine.

### 6.5 If "options" means listed options

Listed options require, at minimum: contract specifications and expiry calendar; a volatility surface; Greeks and scenario risk; margin and buying-power checks; exercise/assignment and pin risk; settlement and corporate actions; a chain/data vendor; and an execution adapter that understands multi-leg orders. None of that exists today, and none of it is on the critical path to scaling the prediction-market thesis. The honest recommendation is **research only, after Phase 3**, with a separate risk case.

### 6.6 Verdict

The trading surface is broad enough to be interesting and narrow enough to be honest. Its scalability problem is not the number of pairs; it is that **instrument knowledge is scattered across constants, adapters, and UI**. Fix the registry, and breadth becomes cheap. Skip the registry, and every new instrument is another special case.

---

## 7. Interval review

### 7.1 Current plumbing

An interval is not a single constant. It touches:

- `src/types.ts:60` — the `Interval` union.
- `src/market/intervals.ts` — `intervalMs`.
- `src/server/candleCache.ts:32` — `TTL_BY_INTERVAL`.
- `src/market/synthetic.ts:10` — volatility per interval.
- `src/botEngine.ts` — eight preset timeframes.
- `src/predictions.ts` — 20 BTC rules, four per timeframe.
- `src/predictionStrategies.ts:44` — `StrategyTimeframe` (`5m|15m|1h|1d`, no 4h).
- `src/pages/Predictions.tsx` — Polymarket timeframes (`5m|15m`).
- Chart/backtest controls and tests.

Adding one interval therefore means editing at least seven files and remembering the exceptions. That is the definition of a missing abstraction.

### 7.2 The 4h orphan

`4h` exists in charts, backtests, and the 20 BTC rules, and two of the eight presets use it. But the prediction-strategy catalog excludes it (`StrategyTimeframe` has no `4h`), and Polymarket has no native 4h UP/DOWN market in the adapter. So 4h is a **crypto swing/backtest interval**, not a prediction-market interval. Treating all intervals as interchangeable would create strategies that cannot be executed.

### 7.3 Liquidity-ranked expansion

Interval expansion should follow liquidity and evidence, not symmetry. Measured BTC prediction-market volume:

| Interval | Measured BTC volume | Native prediction market? | Current support | Recommendation |
|---|---:|---|---|---|
| 5m | ~$48.2k/window → ~$13.8M/day | Yes | Adapter + rules + presets | **Keep and deepen** |
| 15m | ~$34.3k/window → ~$3.29M/day | Yes | Adapter + rules + presets | **Keep and deepen** |
| 1h | ~$458k/day (24 windows, avg ~$19.1k) | Yes | Rules + preset; no adapter | **Research; adapter later** |
| 4h | No native UP/DOWN | No | Chart/backtest/preset only | **Keep as swing interval; no prediction strategy** |
| 1d | ~$15.3k/day UP/DOWN; ~$355k/day across ~11 ladder strikes | Yes, ladder | Rules + preset; no adapter | **Ladder relative value, not directional** |
| 1m | Not measured/native | No | None | **Only with maker engine and server gateway** |
| 30m/2h/6h/12h/1w | Derived / no dedicated market | No | None | **Derive for charts, not strategies** |

ETH and SOL are thinner: hourly ETH is ~$106k/day and SOL ~$23k/day in the measured snapshot. Do not assume BTC's 5m depth transfers to other assets or intervals. The interval/asset matrix is not uniform, and the strategy catalog should say so.

### 7.4 Target: interval registry + bar builder

```ts
type IntervalSpec = {
  id: IntervalId
  ms: number
  label: string
  alignment: 'utc' | 'session'
  base?: IntervalId          // e.g. 5m aggregates from 1m
  maxLookback: number
  retentionDays: number
  venues: VenueId[]
  strategySupport: StrategyFamily[]
}
```

The bar builder should:

- Consume normalized trades/quotes from the market-data gateway.
- Emit **closed** bars only, with `openTime`, `closeTime`, `isClosed`, `revision`, `source`, and `ingestedAt`.
- Handle late events with a watermark; reject or revise bars deterministically.
- Dedupe by `(venue, instrument, interval, openTime)`.
- Derive higher intervals from 1m where the venue permits, to reduce vendor calls and align boundaries.
- Never feed `synthetic-fallback` bars into live execution. Synthetic data is a UI convenience, not a trading input.

### 7.5 What to add, and what not to

**Add:** a server-side 1m base feed for crypto if maker strategies need it; 1h/1d adapters after the prediction venue abstraction; derived 30m/2h/6h/12h/1w for charts and research; session-aware calendars for sports/politics event time.

**Do not add:** new intervals merely to fill a dropdown; 4h prediction strategies without a market; 1m live strategies before the data gateway and OMS exist; interval-specific code branches.

### 7.6 Verdict

Intervals should be a **registry plus a bar builder**, not a union plus seven maps. Expand where liquidity and evidence justify it: 5m/15m first, 1h/1d as research, 4h as swing-only, 1m only when the maker stack is ready.

---

## 8. Strategy review

### 8.1 Current catalog

| Layer | Count | Where | Executable? |
|---|---:|---|---|
| Bot presets | 8 | `src/botEngine.ts` | Yes (paper/testnet), one at a time |
| BTC prediction rules | 20 | `src/predictions.ts` | Yes, inside the prediction branch |
| Directional rules | 8 | `src/directionalRules.ts` | Scored in the prediction UI; not a runtime |
| Prediction strategies | 19 | `src/predictionStrategies.ts` | **No** — catalog & unit test only (`src/predictionStrategies.test.ts`; not wired to runtime or UI) |
| Prediction families | 7 | `src/predictionStrategies.ts` | Metadata only |

Status split: **1 deploy, 8 paper, 7 research, 3 avoid**. The status is descriptive, not enforced.

### 8.2 The catalog-runtime gap

This is the most important strategy finding:

- `predictionStrategies.ts` is not imported by `botEngine.ts`. The runtime does not know the catalog exists.
- `StrategyPreset` is a static array, not a plugin contract. Adding a strategy means editing `botEngine.ts`, not registering a definition.
- The prediction branch selects `BITCOIN_20_PREDICTIONS` by `predictionRuleId` or timeframe (`botEngine.ts:719–721`). It cannot run the 19 catalog strategies.
- `MarketContext` is single-asset (`predictions.ts:19–32`). The catalog's `c5-cross-asset` strategy cannot be evaluated because there is no cross-asset context.
- The catalog's "deploy" status does not gate a preset, a mode, or a capital allocation. The only executable prediction path ignores the catalog entirely.
- The 19 strategies have rich metadata (entry, exit, risks, kill switches, capacity), but none of it is machine-enforced.

The catalog is a **research artifact**, not an **executable inventory**. That is fine as a first step; it is fatal if mistaken for a runtime.

### 8.3 Target: strategy definition and instance

```ts
type EvidenceStatus = 'research' | 'paper' | 'canary' | 'live' | 'probation' | 'retired'

type StrategyDefinition = {
  id: string
  version: string
  family: StrategyFamily
  market: MarketSelector        // venue, asset class, instruments, intervals
  data: DataRequirement[]       // bars, book, trades, odds, calendar
  params: JSONSchema
  evaluate(ctx: StrategyContext): Signal[]
  size(ctx: SizingContext): SizingDecision
  risk: RiskProfile
  evidence: EvidenceStatus
  capacity: CapacityModel       // max notional, participation, quote lifetime
  kill: KillCriterion[]
}

type StrategyInstance = {
  id: string
  tenantId: string
  strategyId: string
  version: string             // pinned; upgrades are explicit
  instrumentIds: InstrumentId[]
  params: unknown
  sleeveId: string
  mode: 'backtest' | 'paper' | 'shadow' | 'canary' | 'live'
  status: 'active' | 'paused' | 'halted' | 'retired'
}
```

The separation matters:

- **Signal** answers "what is the edge?"
- **Sizing** answers "how much?"
- **Execution policy** answers "maker or taker, how aggressive, how long?"
- **Portfolio** answers "does it fit with everything else?"
- **Risk** answers "what can go wrong, and what is the limit?"

Today `stepBotEngine` mixes all five. A runtime should keep them separable and testable.

### 8.4 Portfolio construction and conflict resolution

A platform with 100 strategy instances needs a portfolio layer, not 100 independent bots:

- **Sleeves.** Each strategy instance draws from a capital sleeve with a hard cap. Sleeves are per tenant, per family, or per mandate.
- **Risk budgets.** Per-strategy, per-family, per-venue, per-event, and portfolio-level limits. Correlated positions consume the same budget.
- **Netting.** Opposite exposures in the same instrument/event should net before increasing gross exposure, where the contracts are truly equivalent.
- **Conflict resolution.** If two strategies want opposite sides of the same market, the portfolio layer decides: net, prioritize by confidence/capacity, or let both run in separate sleeves if the risk is intentionally diversified.
- **Correlation haircuts.** Fractional Kelly is not enough when strategies share a factor. Apply a correlation haircut and stress the joint distribution.
- **Capacity.** Each strategy declares max notional, participation rate, and quote lifetime. The allocator respects the smallest constraint.

### 8.5 Backtesting at platform scale

`runBacktest` is a single-threaded loop over one config (`src/backtest.ts:220`). At platform scale, the backtester must be:

- **Event-driven**, not vectorized-only, so maker fills, queue position, cancel/replace, and latency can be modeled.
- **Point-in-time**, with the exact data available at decision time; no look-ahead from revised bars or later resolutions.
- **Cost-aware**, with per-venue fees, spread, slippage, maker rebates, and adverse selection.
- **Walk-forward**, with purged/embargoed cross-validation; no tuning on the test window.
- **Multiple-testing aware**, reporting deflated Sharpe or a comparable correction when many variants are tried.
- **Reproducible**, with a data snapshot ID, code version, parameters, and random seed.
- **Parallel**, with a worker pool and columnar data. A 10,000-config grid should be a job, not a browser tab.

Metrics should include net Sharpe, deflated Sharpe, calibration, turnover, capacity, fill rate, quote age, max drawdown, and tail loss. A strategy that looks good only before costs is a research lead, not a deployment candidate.

### 8.6 Lifecycle and evidence gates

Proposed state machine:

```text
draft → research → paper → canary → live → probation → retired
```

Gates:

- **Research → paper:** data sufficiency, out-of-sample evidence, cost model, written thesis, kill criteria.
- **Paper → canary:** N paper trades or N days, calibration within tolerance, operational readiness (alerts, runbook, reconciliation).
- **Canary → live:** small capital, SLOs met, no unresolved reconciliation breaks, risk sign-off.
- **Live → probation:** drawdown, Brier/calibration degradation, fill-rate collapse, fee/rule change, or venue incident.
- **Any → retired:** edge decay, capacity exhaustion, or repeated operational failure.

Demotion triggers should be automatic: rolling Brier score, calibration slope, realized vs expected edge, quote age, fill rate, drawdown, and fee-schedule changes. The catalog's status counts (1/8/7/3) are a good starting inventory; they should become enforced states, not labels.

### 8.7 Verdict

FLARE does not have a strategy shortage. It has a **runtime shortage**. The 19-strategy catalog is a strong schema; the next step is to make it executable, versioned, and gated. Do not add strategy #20 until #1–#19 have a runtime and an evidence pipeline.

---

## 9. Prediction-market plan review

### 9.1 What the playbook gets right

The playbook is the best part of the project. It does five things that most trading docs do not:

1. **Names the game.** It separates informed flow, liquidity provision, resolution, attention, and venue games, and explains why the counterparty matters.
2. **Prices the fee curve.** It uses the real `C × rate × p × (1-p)` formula, shows that the same strategy can be dead at 50¢ and alive at 90¢, and distinguishes maker from taker.
3. **Refuses the easy story.** It measures that Binance indicator edges do not transfer to Chainlink-resolved Polymarket windows.
4. **Labels evidence.** Measured, published, structural, hypothesis — every claim has a status.
5. **Defines an anti-playbook.** It says what not to do, which is more useful than another entry rule.

That discipline should be the template for every new market family. The scalability question is whether the platform can **operationalize** this rigor, not whether the research is good enough.

### 9.2 Coverage today

| Family | Required markets | Data today | Execution today | Strongest evidence | Scale priority |
|---|---|---|---|---|---|
| Crypto 5m | BTC/ETH/SOL UP/DOWN | BTC only, read-only | None | Nowcast Brier 0.124 vs market 0.181 (T−1m: 0.064 vs 0.118) | **P1: maker paper** |
| Crypto 15m | BTC/ETH/SOL UP/DOWN | BTC only, read-only | None | Brier 0.144 vs 0.152; 70–80¢ bucket +12.6pp | **P1: maker paper** |
| Crypto 1h | BTC/ETH/SOL UP/DOWN | None | None | Thin volume; research | P3 |
| Crypto 1d | BTC/ETH/SOL UP/DOWN + ladder | None | None | Ladder ~$355k/day vs $15.3k UP/DOWN | P3: ladder relative value |
| Non-popular sports | Event markets | None | None | Consensus-anchor hypothesis; no FLB | P3 after odds feed |
| Popular sports, unpopular leagues | Event markets | None | None | Brand-fade hypothesis | P4 |
| Politics | Event/nested markets | None | None | Favorite carry: −16.34% longshots, +1.044% favorites | **P1: first venue expansion** |

Coverage count: **2 of 12** crypto asset-interval combinations have any adapter data (BTC 5m/15m), and **0 of 3** non-crypto families have a data feed. The catalog covers 19 strategies, but the adapter covers 2 markets. That is the gap between research and platform.

### 9.3 Seven truth gaps

1. **The 50¢ fiction.** `marketImpliedPrice = 0.5` (`botEngine.ts:749`) means every prediction ticket is priced at 50¢ regardless of the actual market. The edge, stake, and P&L are not executable. This is the single most important fix in the codebase.
2. **Static fees.** `POLYMARKET_FEES` is a constant. Real fees vary by category, can change, and have maker rebates and rounding rules. A static table silently misprices edge after a fee change. Fees need effective dates and versions.
3. **No resolution ingestion.** The playbook knows resolution is part of the game; the runtime does not ingest rules text, oracle source, deadlines, disputes, or settlement evidence. Chainlink BTC/USD 60-second TWAP is not the Binance candle, and the basis can flip a close window.
4. **No executable quote.** The adapter exposes midpoint/last data, not a depth-aware executable price. Measured median quote age is ~44s (p90 58–74s), and the median next trade is 60–64s away. Last trade is not a price you can hit.
5. **No order/position ledger.** Paper tickets are internal records, not venue positions. There is no order state, fill, fee, settlement, or reconciliation against Polymarket.
6. **No event calendar or odds.** Sports and politics strategies require fixtures, deadlines, lineups, polling/odds, and resolution rules. None of that is ingested.
7. **No venue abstraction.** One read-only Polymarket adapter means no cross-venue comparison, no failover, and no best execution. Kalshi public data is reachable, but there is no adapter.

### 9.4 Target: market model + venue abstraction

```ts
type PredictionMarket = {
  venue: 'polymarket' | 'kalshi'
  id: string
  slug: string
  question: string
  family: PredictionFamily
  eventId: string
  outcomes: [Outcome, Outcome]
  resolution: {
    source: string          // e.g. "Chainlink BTC/USD 60s TWAP"
    rules: string
    deadline: string
    disputeWindow?: string
  }
  fees: FeeScheduleRef
  status: 'open' | 'closed' | 'resolved' | 'disputed'
  tickSize: number
  minSize: number
}

type QuoteSnapshot = {
  marketId: string
  outcome: OutcomeId
  bid: number | null
  ask: number | null
  bidSize: number | null
  askSize: number | null
  last: number | null
  asOf: number
  source: string
  stale: boolean
}
```

The venue adapter should expose **capabilities**, not pretend all venues are identical:

| Dimension | Polymarket | Kalshi |
|---|---|---|
| Collateral | USDC | USD (venue-dependent) |
| Fee model | `rate × p × (1-p)`, maker rebates | Venue-specific formula and rounding |
| Categories | Crypto, sports, politics, geopolitics | Regulated event contracts |
| Resolution | Rules text + oracle | Rules text + venue determination |
| Access | Wallet/CLOB | Account/KYC, jurisdiction-dependent |
| Data | Gamma + CLOB | Public market data + authenticated trading |

The abstraction should normalize the **market lifecycle and order interface**, while preserving venue-specific fee, resolution, and access differences. Hiding those differences is how cross-venue "arbitrage" becomes a loss.

### 9.5 Pricing, fees, and resolution as versioned services

- **Quote service.** Produces `QuoteSnapshot` with bid/ask/depth/last/asOf/source/stale. Every strategy reads the same snapshot. A stale quote is a hard reject for live execution.
- **Probability service.** Hosts per-family models, calibration curves, shrinkage, and uncertainty. Model output is `p_model` with a version and a timestamp. No model, no trade.
- **Fee service.** Versioned fee schedules per venue/category/date, including maker/taker, rebates, rounding, and geopolitics zero-fee. The simulation and the live router read the same service.
- **Resolution service.** Stores rules text, oracle, deadline, dispute window, outcome, settlement, and evidence. Resolution risk becomes a first-class risk factor.
- **Risk service.** Aggregates exposure by market, event, family, venue, and resolution source. Enforces inventory and correlation limits.

Edge formulas:

```text
taker_edge_per_share = p_model - ask - fee_per_share
maker_edge_per_share = p_model - bid - adverse_selection - inventory_cost + rebate
```

At 50¢ with a 7% crypto taker fee, the fee is 1.75¢/share = 3.5% of stake. At 90¢, it is 0.63¢/share = 0.7% of stake. The same `p_model` can be profitable on one side of the book and dead on the other. The platform must compute edge **after** fees and **at the executable price**, not at the midpoint.

### 9.6 Game theory at scale

The playbook's agentic game theory section becomes more important as FLARE grows, not less:

- **Maker edge compresses.** More bots quoting the same stale book means faster cancellation and thinner spreads. The early maker rent disappears.
- **Rebate races.** If the venue pays maker rebates, the marginal quoter will accept a worse price to earn them. Your effective edge must include the rebate and the adverse selection it attracts.
- **Adverse selection.** The counterparty who hits your quote knows something or is hedging something. A high fill rate on a narrow spread is often a warning, not a victory.
- **Queue position.** At scale, being at the top of the book matters more than being right by a fraction of a cent. The OMS and quote engine must model queue priority, not just price.
- **Market impact.** The platform's own orders move small books. Capacity is not optional; it is part of the strategy definition.
- **Resolution is the ultimate game.** In the last minutes, the informed trader is trading the oracle, not the chart. If you do not know the resolution source and the basis, you are the exit liquidity.

### 9.7 Scale sequence by family

The correct sequence is evidence-first, latency-second, breadth-last:

1. **Politics favorite carry (P1).** Strongest measured edge (favorite +1.044%, longshot −16.34%), no latency race, and a clear structural thesis. Local partitions show 2–16% overround but wide two-sided books, and nested-deadline monotonicity was already arbitraged (0 violations across 8 event families). It needs a general Polymarket adapter, event/nested-market modeling, resolution rules, and paper/canary execution — not a new prediction model.
2. **Crypto 5m/15m maker (P1).** Measured nowcast edge and calibration, but it needs a real book, quote engine, staleness guards, and fee-aware maker simulation. Start in paper/shadow; do not take taker liquidity at 50¢. The 5m 90–100¢ bucket realized 98.9% (+3.6pp, n=89), while the 20–30¢ bucket realized 17.2% (−7.9pp, n=87); the 15m 70–80¢ bucket realized 87.2% (+12.6pp, n=78), while 20–30¢ realized 16.9% (−8.2pp, n=118). These are favorite/longshot signals, not a license to buy every favorite.
3. **Crypto 1d ladder relative value (P3).** The ladder has ~23× the daily volume of the single UP/DOWN market. It is a relative-value/term-structure game, not a directional candle bet. It needs multi-strike market modeling and book depth.
4. **Crypto 1h (P3).** Thin ($458k/day). Research only until the 5m/15m maker engine proves it can quote profitably.
5. **Non-popular sports (P3/P4).** The measured FLB is absent (+2.43% longshots, CI includes zero; favorites −0.230%). The consensus-anchor strategy is a hypothesis. It needs a sharp odds feed and a resolution-rules database before it deserves capital.
6. **Popular sports in unpopular leagues (P4).** Brand-fade is the weakest evidence and the highest data cost. Keep it in research.

### 9.8 Capacity model for prediction markets

```text
quote_ops/s   = active_markets × sides × (1 / refresh_s)
book_msgs/s   = active_markets × updates_per_s × depth_levels
model_evals/s = active_markets × model_updates_per_s
```

At 500 markets, 2 sides, and a 5 s refresh: 200 quote ops/s. At 20 updates/s and 10 levels: 100k book messages/s. Conflate to top 5 levels and batch cancellations; use token-bucket rate limiting per venue. The binding constraint will be the venue's order-entry rate limit and the quality of the book data, not the model.

Inventory limits should be hierarchical: per market, per event, per family, per venue, and per resolution source. A politics event with 20 nested markets is one risk, not 20 independent bets.

### 9.9 Verdict

The prediction-market **plan** is ready to scale; the prediction-market **plumbing** is not. The sequence is politics first, crypto maker second, sports after data, 1h/1d after book depth. The 50¢ fiction must be removed before any of it is called live.

---

## 10. Target architecture

### 10.1 Principles

1. **Modular monolith first.** Keep one deployable API + worker set until load and team size justify extraction. Microservices are an organizational solution, not a scalability trophy.
2. **Server-side truth.** Clients never talk to venues directly. One market-data gateway, one bar builder, one quote service.
3. **Event-driven and replayable.** Every order, fill, quote, resolution, and config change is an event with a sequence and a timestamp.
4. **Idempotent by construction.** Every order intent has a client-generated idempotency key. Every consumer is idempotent. Every write is retry-safe.
5. **Shared market data, isolated execution.** Tenants share the expensive normalized feed; they do not share orders, positions, keys, or risk limits.
6. **Every input has provenance.** Source, timestamp, freshness, quality flag, and revision. Synthetic or stale data is never a live input.
7. **Every strategy has a contract.** Version, params schema, data requirements, evidence status, capacity, kill criteria.
8. **Buy infrastructure, build edge.** Use managed Postgres/Redis/Kafka/ClickHouse/observability. Build the strategy runtime, risk engine, OMS, and prediction pricing.

### 10.2 Target diagram

```text
                    ┌────────────────────────────────────┐
   Browsers / API ─▶│ Edge: OIDC, tenant, quotas, WAF    │
                    └───────────────┬────────────────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          ▼                         ▼                         ▼
 ┌─────────────────┐      ┌──────────────────┐      ┌──────────────────┐
 │ Control plane   │      │ Query API        │      │ Realtime gateway │
 │ registry, flags │      │ portfolios,      │      │ WS/SSE, deltas,  │
 │ approvals       │      │ trades, charts   │      │ replay, presence │
 └────────┬────────┘      └────────┬─────────┘      └────────┬─────────┘
          │                        │                         │
          └────────────┬───────────┴─────────────┬───────────┘
                       ▼                         ▼
              ┌──────────────────┐      ┌──────────────────┐
              │ Event bus        │      │ Redis            │
              │ Kafka/Redpanda   │      │ cache, locks,    │
              │ or NATS          │      │ rate limits      │
              └───┬──────────┬───┘      └──────────────────┘
                  │          │
     ┌────────────▼───┐  ┌───▼────────────────┐
     │ Market data    │  │ Strategy runtime   │
     │ gateway        │  │ plugin host,       │
     │ venue adapters │  │ deterministic,     │
     │ normalize/bars │  │ sandboxed          │
     └───────┬────────┘  └─────────┬──────────┘
             │                     │ intents
             ▼                     ▼
     ┌──────────────────┐  ┌──────────────────┐
     │ ClickHouse /     │  │ Portfolio & risk │
     │ Timescale        │  │ exposure, limits │
     │ bars, quotes     │  │ correlation, VaR │
     └──────────────────┘  └─────────┬────────┘
                                     ▼
                           ┌──────────────────┐
                           │ OMS / EMS        │
                           │ idempotency,     │
                           │ state machine,   │
                           │ reconciliation   │
                           └─────────┬────────┘
                                     ▼
                           ┌──────────────────┐
                           │ Venue order APIs │
                           │ Binance, Poly,   │
                           │ Kalshi, MT5      │
                           └──────────────────┘

     Postgres: tenants, configs, orders, fills, positions, ledger, audit
     Object storage: raw payloads, backtest artifacts, compliance archive
```

### 10.3 Service responsibilities

| Service | Responsibility | Scale unit | Durable state | Failure mode |
|---|---|---|---|---|
| Edge/API gateway | Auth, tenant resolution, rate limits, TLS, WAF | Request | None | Reject, degrade reads |
| Market data gateway | Venue WS/REST, normalize, gap recover, publish | Venue/instrument partition | Raw payload archive | Stale feed alarm; failover |
| Bar/feature service | Build closed bars, derive intervals, features | Instrument+interval | ClickHouse/Timescale | Recompute from raw events |
| Strategy runtime | Evaluate definitions, emit signals/intents | Tenant+sleeve partition | Checkpoints | Pause instance; no orders |
| Portfolio/risk | Pre-trade limits, exposure, correlation, stress | Tenant/portfolio | Postgres/Redis | Fail closed |
| OMS/EMS | Order state machine, routing, cancel/replace, reconciliation | Account/venue partition | Postgres event log | Halt venue; reconcile |
| Ledger | Double-entry fills, fees, positions, PnL, settlement | Account | Postgres | Rebuild from events |
| Prediction service | Market discovery, books, pricing, resolution | Venue/family partition | Postgres/ClickHouse | Read-only mode |
| Query API | Read models, pagination, charts, reports | Stateless | Read replicas | Serve stale read |
| Realtime gateway | Subscriptions, deltas, replay, presence | Connection | Redis presence | Disconnect + resume |
| Control plane | Strategy registry, config versions, flags, approvals | Stateless | Postgres + audit | Freeze changes |
| Observability | Metrics, traces, logs, alerts, SLOs | Stateless | TSDB/object store | Alert; don't block trading |

### 10.4 Data contracts

At minimum, standardize these:

```ts
type Bar = {
  instrumentId: string
  interval: string
  openTime: number
  closeTime: number
  open: number; high: number; low: number; close: number; volume: number
  isClosed: boolean
  revision: number
  source: string
  ingestedAt: number
}

type OrderIntent = {
  idempotencyKey: string
  tenantId: string
  strategyInstanceId: string
  instrumentId: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit' | 'post-only'
  quantity: number
  limitPrice?: number
  timeInForce: 'GTC' | 'IOC' | 'FOK'
  reduceOnly?: boolean
  createdAt: number
}

type OrderState =
  | 'NEW' | 'PENDING_NEW' | 'ACKED' | 'PARTIAL'
  | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED'

type Fill = {
  orderId: string
  venueOrderId: string
  instrumentId: string
  price: number
  quantity: number
  fee: number
  feeAsset: string
  executedAt: number
}
```

The ledger should be double-entry: every fill creates a debit and credit; positions and PnL are derived, not independently mutated. This is the difference between a demo and a system you can audit.

### 10.5 Storage choices

| Store | Use | Why |
|---|---|---|
| Postgres | Tenants, configs, strategy registry, orders, fills, positions, ledger, audit | Transactions, constraints, mature tooling |
| Redis | Latest quotes, cache, locks, rate limits, presence | Low-latency shared state |
| Kafka/Redpanda/NATS | Market data, order events, fills, risk signals | Replay, decoupling, backpressure |
| ClickHouse/Timescale | Bars, ticks, quotes, backtest results | Columnar time-series queries |
| Object storage | Raw venue payloads, backtest artifacts, compliance archive | Cheap, immutable, replayable |

Do not put time series in Postgres just because it is already there. Do not put orders in Redis just because it is fast.

### 10.6 Multi-tenancy

- **Tenant ID everywhere.** Every config, order, fill, position, strategy instance, and audit row is tenant-scoped.
- **Shared market data, isolated execution.** The gateway and bar builder are shared; order routing, balances, keys, and risk limits are not.
- **RBAC.** Roles: viewer, researcher, trader, risk manager, admin. Live trading requires an explicit permission and, ideally, a second approver.
- **Quotas.** Per-tenant API rate, SSE connections, strategy instances, backtest minutes, and market subscriptions.
- **Key management.** Per-tenant venue credentials in a secrets manager; encryption at rest; rotation; no secrets in logs.
- **Audit.** Every config change, order, cancel, kill-switch action, and permission change is immutable.
- **Data isolation.** Row-level security or schema-per-tenant for sensitive tables; separate object-storage prefixes; no cross-tenant joins in application code.

### 10.7 Deployment topology

- **Start single-region, multi-AZ.** Stateless API and realtime pods; worker pool; managed Postgres with a standby; Redis with replica; Kafka/Redpanda with replication.
- **Partition workers** by tenant/sleeve or venue/instrument. Use consistent hashing or a queue with sticky assignment.
- **Leader election** for singleton tasks: one quote engine per market, one reconciliation job per venue, one scheduler per tenant.
- **Blue/green or canary** for strategy runtime changes. A strategy version change is a deployment.
- **Disaster recovery:** RPO 0 for orders (synchronous WAL), RPO < 1 min for market data, RTO < 15 min. Test restore quarterly.
- **Kubernetes only when justified.** ECS/Cloud Run/Fly.io is enough for a small team. The architecture, not the orchestrator, is the scale lever.

### 10.8 Build vs buy

**Buy:** Postgres, Redis, Kafka/Redpanda, ClickHouse/Timescale, OIDC, secrets manager, observability, CDN/WAF.

**Build:** strategy runtime, portfolio/risk, OMS/ledger, prediction pricing/quoting, venue adapters, bar builder.

**Never build:** a matching engine, a general-purpose TSDB, an auth system, or a Kubernetes distribution. Those are commodity infrastructure with high operational cost.

---

## 11. SLOs and scale targets

### 11.1 Envelope

| Dimension | Today | 12-month target | 3-year target |
|---|---:|---:|---:|
| Tenants | 1 | 25 | 1,000 |
| Concurrent dashboards | ~1 | 250 | 5,000 |
| Instruments | 5 | 50 | 500 |
| Strategy instances | 1 | 50 | 1,000 |
| Venues | 1 execution + 1 read-only | 3 | 8 |
| Prediction markets | 2 | 1,000 | 10,000 |
| Orders/day | 12 (hard cap) | 10,000 | 500,000 |
| Market events/day | <1M | 10M | 100M |
| Hot history | In-memory | 90 days | 90 days hot / 7 years cold |

These are planning targets, not commitments. The point is to size the first architecture for 10–100× current load, not 1,000×.

### 11.2 SLO table

| SLI | Target | Measurement |
|---|---|---|
| Market data freshness (crypto bars) | p99 < 1s venue→bus | Gateway timestamp vs venue timestamp |
| Bar close availability | p99 < 2s after close | Bar builder emit time |
| Prediction book freshness | p99 < 3s | Quote `asOf` vs now |
| API read latency | p99 < 200ms | Gateway histogram |
| API write latency | p99 < 500ms | Gateway histogram |
| Order ack latency | p99 < 300ms | Intent→venue ack |
| Cancel latency | p99 < 200ms | Intent→venue cancel |
| Realtime fanout | p99 < 1s; delta < 8KB | Gateway histogram |
| Control-plane availability | 99.9% monthly | Synthetic probes |
| Execution availability | 99.5% monthly | Order-path probes |
| Order durability | RPO 0 | Sync WAL + reconciliation |
| Recovery time | RTO < 15 min | DR drill |
| Reconciliation | 100% open orders every 30s | Recon job |
| Duplicate fills | 0 | Ledger invariant |
| Missing bars | < 0.01% | Data quality job |
| Stale quotes used live | 0 | Pre-trade guard |

### 11.3 Correctness invariants

These are non-negotiable, even at small scale:

1. No order without a fresh, executable quote (or an explicit market order with a slippage bound).
2. No live order derived from synthetic or stale data.
3. No order ID reuse across restarts; idempotency keys are durable.
4. No fill without a ledger entry; no position without a fill.
5. No daily limit reset on restart; no kill-switch reset on restart.
6. No cross-tenant read or write; tenant ID is enforced at the data layer.
7. No strategy in `live` without its evidence gate and risk sign-off.
8. No resolution without stored rules, source, and evidence.
9. No silent fallback: every degraded source is visible in the UI and blocked for live.
10. No "FILLED" status without a venue acknowledgment or an explicit paper-mode label.

### 11.4 Load and chaos tests

Before Phase 2 exit, run:

- **1,000 concurrent SSE/WS clients** with a 40 KB initial snapshot and 2 KB deltas, for 1 hour; verify p99 < 1s fanout and bounded memory.
- **100 strategy instances** on 50 instruments with shared bars; verify CPU, queue lag, and no duplicate intents.
- **10,000 orders/day** in paper mode; verify idempotency, rate limits, and reconciliation.
- **1M book updates/minute** for prediction markets; verify conflation and top-N degradation.
- **Kill -9 during order submission**; verify no duplicate order after restart, and reconciliation finds the orphan.
- **Venue timeout / 429 / partial fill / duplicate fill / stale quote**; verify fail-closed behavior.
- **Restart during a daily loss breach**; verify the limit is still enforced.

CI should include unit tests, integration tests against a fake venue, contract tests for adapters, migration tests, and a load smoke test. The current 85 tests are a good start; they are not a platform test suite yet.

---

## 12. Phased roadmap

Estimates assume 1–2 engineers and a bias toward shipping. They are not deadlines; they are sequencing.

| Phase | Duration | Scope | Exit criteria | Unlocks |
|---|---|---|---|---|
| **0. Truth & safety** | 2–3 weeks | Quote service; remove 50¢; persist risk state; auth/tenant stub; state schema + retention; metrics/tracing; load harness | Restart-safe limits; no order without quote; two users isolated; 100 SSE clients stable | A platform that does not lie or lose risk state |
| **1. Single-node scale** | 4–6 weeks | Server-side market data gateway; bar builder; Redis + Postgres; delta realtime; interval registry; strategy registry (read-only) | 50 instruments; 1,000 streams at p99 < 1s; no per-user vendor sockets; add interval via config | Shared truth and 10× seat/instrument capacity |
| **2. Multi-strategy runtime** | 6–10 weeks | Event bus; strategy workers; portfolio/risk; OMS + ledger; backtest workers | 100 instances; 10k paper orders/day; zero duplicate IDs; reconciliation < 5 min; risk survives restart | Strategy inventory and real execution discipline |
| **3. Prediction venue** | 8–12 weeks | Polymarket full adapter (books, trades, resolution); Kalshi read + order adapter; quote engine; event calendar; politics + crypto maker paper | 500 markets; 2 venues; 400 quote ops/s; resolution ledger; fee versions | The prediction thesis becomes executable |
| **4. HA & breadth** | Continuous | Multi-region/DR; ClickHouse; sports odds feed; listed-options research; cost/chargeback | 99.9% control plane; RTO 15 min; unit cost down 30% per doubling | A durable platform business |

**Sequencing rule:** do not start a phase until the prior exit criteria are met. The temptation to add pairs or strategies during Phase 0 is exactly how the truth gaps get locked in.

**What not to do:**

- Do not start with microservices. A modular monolith with clear module boundaries is faster and cheaper.
- Do not add tenants before auth and row-level isolation.
- Do not add live prediction execution before the quote service and reconciliation.
- Do not add listed options before perps/OMS/risk.
- Do not build a custom matching engine or TSDB.
- Do not scale sports before a sharp odds feed and a resolution-rules database.

---

## 13. Prioritized backlog

Effort is approximate engineer-weeks. P0 is truth/safety; P1 is scale foundation; P2 is breadth/HA.

### P0 — Truth and safety

| ID | Change | Files | Effort | Acceptance |
|---|---|---|---:|---|
| P0-1 | Replace `marketImpliedPrice = 0.5` with a fresh executable quote service; reject stale/missing quotes | `src/botEngine.ts:749`, new `src/market/quoteService.ts`, `src/server/polymarketAdapter.ts` | 1–2 | Every ticket stores bid/ask/asOf/source; live path rejects stale quotes; tests cover missing/stale |
| P0-2 | Persist kill switch, daily counters, hard limits, demo balances, order IDs; add startup reconciliation | `src/server/exchangeAdapter.ts:72–85`, `200–334` | 1–2 | Restart preserves limits; no order ID reuse; orphan orders reconciled or halted |
| P0-3 | Add auth, tenant scoping, RBAC, rate limits, CORS allowlist | `src/server/index.ts:36`, `src/server/botRuntime.ts:295`, new `src/server/auth.ts` | 2–3 | 401/403 tests; tenant cannot read another's state; wildcard CORS gone in prod |
| P0-4 | Move state to Postgres with schema version, migrations, retention, bounded arrays | `src/server/botRuntime.ts:39–122`, new `src/server/store/*` | 2–3 | 90-day retention; no full-state sync writes; migration test; parse failure does not silently reset |
| P0-5 | Delta realtime with sequence numbers, heartbeats, slow-client eviction, subscriptions | `src/server/botRuntime.ts:150–160`, `332–346` | 1–2 | 1,000 clients at p99 < 1s; slow client evicted; resume from sequence |

### P1 — Scale foundation

| ID | Change | Files | Effort | Acceptance |
|---|---|---|---:|---|
| P1-1 | Server-side market-data gateway; one upstream subscription per instrument; shared fanout; gap recovery | `src/server/candleCache.ts`, `src/market/liveStream.ts`, `src/hooks/useCandles.ts`, new `src/server/marketData/*` | 3–4 | No per-user vendor sockets; shared bars; gap detection; synthetic never live |
| P1-2 | Interval registry + bar builder + derived bars | `src/types.ts:60`, `src/market/intervals.ts`, `src/server/candleCache.ts:32`, `src/market/synthetic.ts:10` | 2 | Add interval via config; derived 5m/15m/1h/4h/1d; retention per interval |
| P1-3 | Strategy definition/instance registry; params schema; evidence gates | `src/botEngine.ts:182`, `src/predictionStrategies.ts:183`, new `src/strategies/*` | 3–4 | Versioned definitions; validation; UI reads registry; `avoid` cannot run live |
| P1-4 | OMS state machine + idempotency + fills + double-entry ledger + reconciliation | `src/server/exchangeAdapter.ts:200`, new `src/server/oms/*`, `src/server/ledger/*` | 4–6 | No duplicate orders; partial fills; ledger balances; recon every 30s |
| P1-5 | Portfolio/risk engine: pre-trade limits, exposure, correlation, stress, restart-safe | new `src/server/risk/*` | 4–6 | Limits enforced across restarts; per-family/event/venue caps; fail closed |
| P1-6 | Prediction venue abstraction (Polymarket + Kalshi), books, trades, resolution, fee versions | `src/server/polymarketAdapter.ts`, new `src/prediction/venues/*` | 6–8 | 2 venues; book/depth; resolution ledger; fee schedule by date |
| P1-7 | Observability: OTel traces, Prometheus metrics, dashboards, alerts, load tests | new `src/server/telemetry/*`, CI | 2 | SLO dashboards; alert on stale feed/recon break; load test in CI |

### P2 — Breadth and HA

| ID | Change | Files | Effort | Acceptance |
|---|---|---|---:|---|
| P2-1 | Event bus + worker pool; partition by tenant/sleeve and venue/instrument | new `src/server/bus/*`, `src/server/workers/*` | 4–6 | 100 instances; queue lag < 1s; replay works |
| P2-2 | ClickHouse/Timescale for bars, quotes, features, backtests | new `src/server/analytics/*` | 3–4 | 100M events/day; p99 query < 2s |
| P2-3 | Event-driven backtester + grid workers + experiment registry | `src/backtest.ts:220`, new `src/backtest/*` | 3–4 | 10k configs in < 1 hour; point-in-time; reproducible |
| P2-4 | Multi-region/DR, backups, restore drills, failover | infra | 4–6 | RPO 0 orders; RTO < 15 min; quarterly drill |
| P2-5 | Cost/chargeback and unit economics | billing/telemetry | 2 | Cost per 1k seats and per $1M notional tracked |
| P2-6 | Sports odds/event/resolution feeds | new `src/sports/*` | 4–8 | Sharp odds + fixtures + rules; paper consensus strategy |
| P2-7 | Listed options research spike (only if demand) | new `src/options/*` | 6–8 | Contract specs, Greeks, margin, exercise model; no live |

Total: roughly **45–60 engineer-weeks** to the end of Phase 3, plus ongoing Phase 4. That is a realistic 6–10 month platform build for one to two engineers.

---

## 14. Scorecard

### 14.1 Capability scorecard

| Dimension | Today | Target | Notes |
|---|---:|---:|---|
| Correctness / truth | 2.0 | 4.5 | Strong math, but 50¢ fiction, no reconciliation, in-memory risk |
| Scalability | 1.5 | 4.5 | Single global bot, JSON state, full SSE |
| Resilience | 2.0 | 4.0 | Atomic writes and kill switch, but restart resets |
| Security | 1.0 | 4.5 | No auth, wildcard CORS, all-interface bind |
| Observability | 2.0 | 4.5 | Health/telemetry, no metrics/traces/alerts |
| Developer velocity | 3.5 | 4.0 | Pure functions and tests, monolithic runtime; lint toolchain issue |
| Evidence rigor | 4.5 | 4.5 | The playbook is excellent; keep it |
| Cost efficiency | 3.0 | 4.0 | Cheap today; per-user data fanout will not stay cheap |
| Product breadth | 2.5 | 4.0 | 5 pairs, 5 intervals, 2 prediction markets |

**Overall: 2.3 / 5 today; 4.3 / 5 target.** The evidence layer is already at target. The runtime is the gap.

One developer-velocity footnote: `npm run lint` is currently blocked because `typescript-eslint` 8.72 does not support TypeScript 7.0. This is a toolchain tax, not a runtime defect, but a platform needs a working lint gate before it needs a second region.

### 14.2 Domain readiness

| Domain | Research | Data | Execution | Risk | Scale readiness |
|---|---|---|---|---|---|
| Crypto 5m/15m | High | Partial (BTC) | Low | Medium | **2/5** |
| Crypto 1h/1d | Medium | None | Low | Medium | **1/5** |
| Politics | High | None | None | Low | **1.5/5** |
| Non-popular sports | Low/medium | None | None | Low | **1/5** |
| Popular sports | Low | None | None | Low | **0.5/5** |
| Spot/backtest | Medium | High | Low | Medium | **2.5/5** |
| Listed options | None | None | None | None | **0/5** |

### 14.3 90-day definition of done

By the end of Phase 0 + Phase 1, FLARE should be able to say:

- Every displayed and executed price has a source, a timestamp, and a freshness flag.
- Restarting the process does not reset the kill switch, daily loss limit, order IDs, or balances.
- Two users can log in and cannot see or mutate each other's bot, orders, or positions.
- 1,000 dashboards can connect without duplicating vendor sockets or unbounded memory.
- Adding an interval or an instrument is a registry change, not a seven-file edit.
- The 19-strategy catalog is readable by the runtime, and `avoid` strategies cannot run live.
- A prediction ticket cannot be created without an executable quote.
- There is a dashboard for feed freshness, order latency, reconciliation breaks, and SLO burn.

That is the minimum bar for calling FLARE a platform.

---

## 15. Risks and anti-patterns

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Scaling the 50¢ fiction | High if unaddressed | Critical | P0-1; no quote, no ticket |
| Restart resets risk state | High | Critical | Persist limits/counters; startup reconciliation |
| Cross-tenant leakage | Medium at 1 user, high at many | Critical | Tenant ID everywhere; RLS; audit; tests |
| Per-user data fanout cost | High | High | Server-side gateway; shared bars; cache |
| Synchronous JSON write stalls | High at ~10k records | High | Postgres + async writes + retention |
| Phantom positions / orphan orders | High without OMS | Critical | Idempotency, state machine, recon |
| Fee/rule drift | Medium | High | Versioned fee schedules; effective dates; alerts |
| Venue concentration | High today | High | Second venue adapter; failover; exposure caps |
| Oracle/resolution surprise | Medium | High | Resolution service; rules text; dispute tracking |
| Sports data cost | High | Medium | Don't scale until unit economics proven |
| Overfitting 19 strategies | Medium | High | Walk-forward, deflated Sharpe, paper gates |
| Premature microservices | Medium | Medium | Modular monolith; extract on triggers |
| Regulatory/licensing | Medium | Critical | Jurisdiction gating; legal review; KYC/AML if needed |
| Key/secret compromise | Low/medium | Critical | Secrets manager; rotation; least privilege; no withdrawals |
| Operational complexity | Medium | Medium | Buy infrastructure; runbooks; SLOs; on-call |

**Anti-patterns to avoid:**

- "Let's add 50 pairs" before the instrument registry and market-data gateway.
- "Let's run one bot per user" instead of strategy instances on shared workers.
- "Let's put everything in Redis" instead of Postgres for durable state.
- "Let's build our own matching engine" instead of using venue APIs.
- "Let's add options for breadth" before the OMS/risk layer can handle assignment.
- "Let's optimize the model" before the fill model is honest.
- "Let's scale sports" before a sharp odds feed and resolution database.

---

## 16. Decisions and open questions

### 16.1 Proposed decisions

| ID | Decision | Rationale |
|---|---|---|
| D1 | Modular monolith first; extract services on measured triggers | Small team, tight coupling, avoid distributed-systems tax |
| D2 | Postgres is the system of record; ClickHouse/Timescale for time series; Redis for cache/locks | Correct tool per access pattern |
| D3 | Server-side market data; clients never talk to venues | Shared truth, lower cost, deterministic replay |
| D4 | Event-sourced orders/fills + double-entry ledger | Audit, replay, reconciliation, live-capital readiness |
| D5 | Strategy catalog becomes an executable registry; evidence status gates deployment | Close the catalog-runtime gap |
| D6 | Prediction venue abstraction; Polymarket first, Kalshi second | Best execution, resilience, cross-venue comparison |
| D7 | Instrument registry before any new asset class | Breadth without special cases |
| D8 | Multi-tenant from the first auth release, even with one tenant | Retrofitting isolation is expensive and risky |
| D9 | No listed options before perps/OMS/risk are stable | Options add a specialized risk surface with no current edge thesis |
| D10 | Scale triggers, not dates, for Phase 4 | Avoid infrastructure vanity |

### 16.2 Open questions

1. **Who is the customer?** Solo desk, fund, or retail? This changes tenancy, compliance, and UX.
2. **Is FLARE a signal terminal, an execution platform, or a market-maker?** The answer changes the latency budget and the OMS design.
3. **Which second venue?** Kalshi (US regulated) vs another crypto-native venue. Jurisdiction and access matter.
4. **Paper-first or live-first?** Live capital raises the SLO bar and the reconciliation requirements.
5. **Build or buy sports odds?** Sharp odds feeds are expensive; the unit economics must be proven before scaling sports.
6. **Data licensing.** Can FLARE redistribute venue data to tenants? This affects product and contracts.
7. **Revenue model.** Seats, AUM, performance fee, or data? Each implies a different cost and compliance model.
8. **Risk appetite.** What is the maximum drawdown, per-tenant loss, and venue exposure? These become hard limits.
9. **Team size and timeline.** The roadmap assumes 1–2 engineers; more parallelism changes the sequence.
10. **Regulatory posture.** Prediction markets are restricted in some jurisdictions; KYC/AML and licensing may be required.

---

## Appendix A: current file map

| File | Role | Scale note |
|---|---|---|
| `src/server/index.ts` | Standalone HTTP server; keep-alive; listen | Binds all interfaces; no auth |
| `src/server/botRuntime.ts` | Global bot loop, API routes, SSE, JSON state | Single-operator core; first refactor target |
| `src/server/exchangeAdapter.ts` | Demo vault + testnet order POST; hard limits; kill switch | In-memory, no reconciliation |
| `src/server/candleCache.ts` | In-memory candle cache; TTL; coalescing; synthetic fallback | No shared gateway; synthetic can feed live |
| `src/server/polymarketAdapter.ts` | Read-only BTC 5m/15m Gamma/CLOB adapter | 2 of 12 crypto combos; no books/orders |
| `src/server/mt5Bridge.ts` | MT5 signal packet bridge | External execution; no reconciliation |
| `src/botEngine.ts` | 8 presets; `stepBotEngine`; prediction branch | Static presets; 50¢ hardcode; one global state |
| `src/predictions.ts` | 20 BTC rules; `MarketContext`; Wilson | Single-asset; BTC-specific |
| `src/directionalRules.ts` | 8 next-candle rules for 5m/15m | Not a runtime |
| `src/predictionStrategies.ts` | 19-strategy catalog; 7 families; metadata | Catalog only; not imported by engine |
| `src/predictionMarket.ts` | Fees, Kelly, simulation, Wilson | Strong math; static fee schedule |
| `src/backtest.ts` | Single-config backtest loop | Single-threaded; no queue/event model |
| `src/hooks/useCandles.ts` | Per-tab Binance REST/WS usage | Duplicated data plane |
| `src/market/liveStream.ts` | Per-tab Binance WebSocket + backoff | Duplicated data plane |
| `src/pages/Predictions.tsx` | Prediction UI (`'rules' \| 'simulator' \| 'polymarket'` tabs + fee calculator) | Catalog/Playbook not wired to UI or engine |
| `src/api/botClient.ts` | API client | No auth; full snapshots |

## Appendix B: capacity formulas

```text
SSE egress (bytes/s)      = clients × snapshot_bytes / tick_interval_s
JSON write (bytes/day)    = state_bytes × writes_per_day
state_bytes               ≈ fixed + records × bytes_per_record
Tick compute (ops/s)      = instances / tick_interval_s
Quote ops/s               = markets × sides / refresh_s
Book msgs/s               = markets × updates_per_s × depth_levels
Backtest bar-steps        = configs × instruments × bars
Storage (rows/year)       = instruments × bars_per_day × 365
```

Examples:

- 1,000 clients × 40 KB / 15 s = 2.67 MB/s ≈ 230 GB/day.
- 10,000 records × 400 B = 4 MB/write; 288 writes/day ≈ 1.15 GB/day.
- 500 markets × 2 sides / 5 s = 200 quote ops/s.
- 500 markets × 20 updates/s × 10 levels = 100k book msgs/s.
- 100 instruments × 1,440 1m bars/day × 365 = 52.6M rows/year.

## Appendix C: glossary

- **OMS/EMS:** Order/Execution Management System; the state machine that turns intents into venue orders and tracks fills.
- **SLO/SLI:** Service Level Objective/Indicator; the target and the measurement.
- **RPO/RTO:** Recovery Point/Time Objective; acceptable data loss and downtime.
- **CLOB:** Central Limit Order Book.
- **TWAP:** Time-Weighted Average Price.
- **FLB:** Favorite-Longshot Bias; longshots overpriced, favorites underpriced.
- **Kelly:** Optimal fraction of capital for a binary bet given edge and odds.
- **Brier score:** Mean squared error of probability forecasts; lower is better.
- **Deflated Sharpe:** A Sharpe ratio corrected for multiple testing and non-normality.
- **Maker/taker:** Providing liquidity vs consuming it.
- **Adverse selection:** The risk that your fill is against better-informed flow.
- **Purged walk-forward:** Time-series validation that removes leakage between train and test.
- **Double-entry ledger:** Every fill has balanced debits and credits; positions/PnL derive from postings.

---

## 17. Continuation Addendum: Code-Level Bugs, Memory Leaks, Frontend & Bundle Scalability

Sections 0–16 focused on institutional trading architecture and macro bottlenecks. A line-by-line continuation pass across the server, engine, client API, hooks, and UI surfaced concrete reliability bugs, unbounded memory/payload paths, and client/toolchain scalability gaps omitted from the initial draft.

### 17.1 Verified Correctness Bugs & Leaks in Current Runtime

| Severity | Location | Exact Defect | Operational / Scale Impact |
| :--- | :--- | :--- | :--- |
| **Critical** | [`src/strategy.ts`](../src/strategy.ts#L17-L30) (`L18`) | `if (typeof value !== 'object' \|\| 'value' === null) return false` compares string literal `'value'` to `null` instead of `value === null`. | Calling `isStrategy(null)` throws a `TypeError` on `candidate.pair` (`L23`) during persisted/incoming config validation instead of returning `false`. |
| **High** | [`src/server/botRuntime.ts`](../src/server/botRuntime.ts#L653-L665) (`L662`) | `GET /api/mt5/signal` triggers `broadcastSseUpdate()` on every external MetaTrader 5 EA poll (`L662`). | Every MT5 poll amplifies into a full-snapshot SSE broadcast (`getBotStatusSnapshot()` including static `STRATEGY_PRESETS`, logs, and full trade/ticket history) to all connected browser clients. |
| **High** | [`src/server/botRuntime.ts`](../src/server/botRuntime.ts#L487-L493) | `POST /api/bot/preset` unconditionally resets `engineState = createInitialBotState(activePreset)` even when `found.id === activePreset.id` (unlike `POST /api/bot/start` at `L435`). | Re-selecting the active preset silently wipes in-memory tickets, trades, and logs unless persisted/guarded. |
| **High** | [`src/server/botRuntime.ts`](../src/server/botRuntime.ts#L254-L261) + [`vite.config.ts`](../vite.config.ts#L24) | `ensureBackgroundWorker()` relies on a module-local `workerStarted` boolean (`POLL_INTERVAL_MS = 15_000`) with no dispose hook when `server.ssrLoadModule('/src/server/botRuntime.ts')` reloads during Vite dev. | Dev HMR reloads can accumulate duplicate `setInterval` background workers against the same `bot-state.json` file. |
| **High** | [`src/server/botRuntime.ts`](../src/server/botRuntime.ts#L278-L289) | `readJsonBody()` breaks when `body.length > 64_000` (`L283`) without rejecting or responding `413 Payload Too Large`. | Oversized JSON requests are silently truncated rather than rejected cleanly at HTTP ingress. |
| **High** | [`src/server/botRuntime.ts`](../src/server/botRuntime.ts#L106-L122), [`L150-L160`](../src/server/botRuntime.ts#L150-L160) | `saveStateToDisk()` performs synchronous `JSON.stringify(payload, null, 2)` + `writeFileSync` + `renameSync`; `broadcastSseUpdate()` ignores `client.write(data)` backpressure and sends no keepalive heartbeats. | As trade/ticket arrays grow, blocking disk serialization freezes the Node event loop while slow SSE consumers buffer unboundedly. |
| **High** | [`src/server/polymarketAdapter.ts`](../src/server/polymarketAdapter.ts#L52), [`L134-L138`](../src/server/polymarketAdapter.ts#L134-L138), [`L227-L269`](../src/server/polymarketAdapter.ts#L227-L269) | `cache` `Map` stores resolved windows with `expiresAt: Number.POSITIVE_INFINITY` and no max-size eviction; `getJson()` calls `fetchImpl(url)` without `AbortSignal`/timeout; `fetchPolymarketUpDown()` (`CONCURRENCY = 6`, `safeLimit <= 96`) performs up to 3 upstream fetches per window (up to 288 calls cold) with zero in-flight request coalescing. | Long-running processes leak resolved-window memory indefinitely, risk hung sockets against Gamma/CLOB, and multiply upstream fan-out on concurrent requests. |
| **High** | [`src/server/candleCache.ts`](../src/server/candleCache.ts#L42), [`L66-L71`](../src/server/candleCache.ts#L66-L71) | `cacheStore` `Map` lacks a max-size bound and periodic expired-entry eviction; `fetchOptimizedCandles()` does not clamp `limit`. | Arbitrary `(pair, interval, limit)` combinations can expand `cacheStore` and outbound Binance payload size without bound. |
| **High** | [`src/botEngine.ts`](../src/botEngine.ts#L706), [`L753-L756`](../src/botEngine.ts#L753-L756), [`L913`](../src/botEngine.ts#L913), [`L956`](../src/botEngine.ts#L956) | `resolvedTickets` and `closedTrades` grow unboundedly, and ticket/trade IDs are derived from array lengths (`next.activeTickets.length + next.resolvedTickets.length + 1`, `state.closedTrades.length + 1`). | Simply capping or archiving old array elements without first introducing monotonic ID counters will cause duplicate ID collisions and React key/state corruption. |
| **Medium** | [`src/server/mt5Bridge.ts`](../src/server/mt5Bridge.ts#L38-L45) | Tracks global scalar `pollCount`, `lastPollAt`, `lastTerminalName`, and `lastTerminalSymbol`; `toMt5Symbol` assumes `/USDT -> USD`. | Connecting multiple MT5 EAs/terminals overwrites telemetry/heartbeat state rather than keying status per terminal ID; non-USDT pairs fail symbol mapping cleanly. |
| **Medium** | [`src/api/botClient.ts`](../src/api/botClient.ts#L19), [`L142`](../src/api/botClient.ts#L142), [`L817-L860`](../src/api/botClient.ts#L817-L860) | `BackendConnectionMode` uses typo `'http-Server'`; fallback uses legacy `'lixtrd:shadow-bot-state'` localStorage key (paired with `lixtrd:*` in `App.tsx` and `MarketSection.tsx`); `subscribeToBotStream()` permanently closes `EventSource` on the first `onerror` (`L839-L841`) and stays on `8_000 ms` `setInterval` polling forever with no reconnection backoff. | A single transient proxy hiccup or Vite reload permanently downgrades live SSE clients into 8s HTTP polling until full browser refresh; shadow state diverges silently from server runtime truth. |

### 17.2 Frontend, Bundle & Client Data-Plane Scalability

1. **Monolithic Eager Route Bundle ([`src/App.tsx`](../src/App.tsx#L8-L15)):** All 8 views (`Dashboard`, `ChartTerminal`, `BotConfig`, `BotRun`, `Stats`, `Settings`, `Backtest`, `Predictions`) are statically imported at startup with no `React.lazy` / `Suspense` route splitting or Vite manual chunk boundaries. Every user pays upfront parse/eval cost for backtesting tables, chart rendering, and prediction calculators regardless of active page.
2. **Duplicated Multi-Tab Client Data Plane ([`src/hooks/useCandles.ts`](../src/hooks/useCandles.ts), [`src/hooks/useMultiPairCandles.ts`](../src/hooks/useMultiPairCandles.ts), [`src/market/liveStream.ts`](../src/market/liveStream.ts)):** Each open browser tab opens independent Binance WebSocket/REST streams rather than multiplexing through a single backend market-data relay or cross-tab `BroadcastChannel`/`SharedWorker`. Beyond 10–50 concurrent users, upstream rate limits become per-client and UI prices can drift from backend engine state.
3. **Main-Thread Compute & Unvirtualized UI Surfaces ([`src/backtest.ts`](../src/backtest.ts), [`src/predictionMarket.ts`](../src/predictionMarket.ts), [`src/components/CandleChart.tsx`](../src/components/CandleChart.tsx)):** `runBacktest()` and `simulatePredictionStrategy()` run synchronously on the browser main thread without Web Worker offloading, blocking input and chart updates during large sweeps. [`CandleChart.tsx`](../src/components/CandleChart.tsx) renders an unwindowed SVG candlestick scene (`1,115` lines), and trade/backtest/rule tables lack row virtualization once history grows beyond a few hundred records.
4. **Broken Automated Lint Gate ([`package.json`](../package.json)):** `npm run lint` currently fails (`exit code 1`) because `typescript-eslint@8.72.1` does not support `typescript@~7.0.2` (with ESLint `10.13.0`), leaving CI/PR static analysis blind to regressions like `src/strategy.ts:18`.

---

## 18. Immediate Pre-Scale Quick Wins (Low-Risk Stabilization Before Phase 0)

Before tackling full infrastructure work (database ledger, live CLOB pricing, Worker offloading), ship these self-contained hardening patches (`< 1–2` days total):

1. **Fix `isStrategy` null guard** (`src/strategy.ts:18`): Change `'value' === null` to `value === null`.
2. **Restore SSE resilience & kill broadcast storms**:
   - In `src/server/botRuntime.ts`, broadcast SSE only when MT5 terminal state actually changes (`GET /api/mt5/signal`), check `client.write()` return values + drop dead streams on error/heartbeat, move `STRATEGY_PRESETS` out of high-frequency delta pushes (or serve via bootstrap/ETag), and store worker handle on `globalThis` so Vite HMR cleans up old intervals.
   - In `src/api/botClient.ts`, replace permanent `onerror -> close()` shutdown with bounded exponential-backoff SSE reconnection, and standardize `'http-Server'` naming.
3. **Protect JSON ingress & external HTTP caches**:
   - Return `413 Payload Too Large` in `readJsonBody` when payload exceeds `64_000` bytes instead of silently breaking.
   - Guard `POST /api/bot/preset` against accidental state wipes when `found.id === activePreset.id`.
   - Add `AbortSignal.timeout(...)`, LRU/max-size bounds, and in-flight coalescing to `polymarketAdapter.ts`, plus `limit` clamping and size bounds to `candleCache.ts`.
4. **Decouple engine IDs from array length before retention caps** (`src/botEngine.ts`): Add explicit `nextTicketId` and `nextTradeId` monotonic counters to `BotEngineState` so bounded `closedTrades`/`resolvedTickets` sliding windows never collide.
5. **Split frontend routes & fix lint toolchain**: Wrap heavy secondary pages (`Backtest`, `Predictions`, `Stats`, `ChartTerminal`) in `React.lazy` + `Suspense`, and align `typescript` / `typescript-eslint` versions so `npm run lint` passes cleanly as a merge gate.

---

## 19. Implementation Status Ledger (Quick Wins, Phase 0 Complete & Phase 1 Core)

### Delivered in Codebase

- **§18 Quick Wins (1–5 complete, including Lint Gate & Route Splitting):**
  - [`src/strategy.ts`](../src/strategy.ts) fixes `isStrategy(null)` (`value === null`) and retains explicit `isStrategy` validation tests.
  - [`src/server/botRuntime.ts`](../src/server/botRuntime.ts) & [`src/api/botClient.ts`](../src/api/botClient.ts) fix `'http-server'` casing, SSE backpressure/keepalive (`SSE_KEEPALIVE_MS`), `MT5_SSE_MIN_INTERVAL_MS` broadcast throttling, `PayloadTooLargeError` (HTTP `413`), `POST /api/bot/preset` same-preset guard, and `globalThis` worker deduplication.
  - [`src/server/polymarketAdapter.ts`](../src/server/polymarketAdapter.ts) & [`src/server/candleCache.ts`](../src/server/candleCache.ts) add bounded caches, request timeouts, `limit` clamping (`1..1_000`), and in-flight coalescing.
  - [`src/botEngine.ts`](../src/botEngine.ts) adds monotonic `nextTicketId` / `nextTradeId` counters surviving bounded history trimming (`trimBotEngineHistory`).
  - [`src/App.tsx`](../src/App.tsx) wraps secondary routes with `React.lazy` + `Suspense`.
  - **Lint Gate Fixed (§17.2 #4):** [`package.json`](../package.json) runs `@typescript/native` (`npm:typescript@~7.0.2`) side-by-side with `typescript` (`npm:@typescript/typescript6@^6.0.2`) so `tsc -b` remains on native TypeScript 7 while `typescript-eslint` uses the TS 6 compiler API; [`eslint.config.js`](../eslint.config.js) and React hook/ref issues across [`src/components/CandleChart.tsx`](../src/components/CandleChart.tsx), [`src/components/StudioSidebar.tsx`](../src/components/StudioSidebar.tsx), [`src/pages/Dashboard.tsx`](../src/pages/Dashboard.tsx), and [`src/pages/Predictions.tsx`](../src/pages/Predictions.tsx) are resolved (`npm run lint` exits `0`).
- **Phase 0 Truth & Safety Complete (`P0-1` through `P0-5`):**
  - **Executable Quote Service (`P0-1`):** [`src/market/quoteService.ts`](../src/market/quoteService.ts) normalizes CLOB bid/ask & Gamma spreads (`buildQuoteFromPolymarketWindow`), enforces freshness (`DEFAULT_QUOTE_MAX_AGE_MS = 30_000`) and max spread (`DEFAULT_MAX_EXECUTABLE_SPREAD = 0.2`), and calculates fee-adjusted `effectiveAsk` via `polymarketFeePerShare`. [`src/botEngine.ts`](../src/botEngine.ts) enforces `[QUOTE GUARD]` on live/runtime ticks while restricting fixed-50¢ pricing strictly to offline `evaluateBotPresetAccuracy` (`benchmarkFixedMidPrice`). [`src/server/botRuntime.ts`](../src/server/botRuntime.ts) blocks autonomous execution on `synthetic-fallback` (`[DATA GUARD]`).
  - **Persistent Fail-Closed Risk State & Reconciliation (`P0-2`):** [`src/server/exchangeAdapter.ts`](../src/server/exchangeAdapter.ts) aligns default `allowedPairs` (`BTC/USDT`, `ETH/USDT`, `SOL/USDT`, `XRP/USDT`, `DOGE/USDT`), adds `clientOrderId` idempotency, Binance Spot Testnet timeout + fill reconciliation (`venueOrderId`, `executedQty`, `cummulativeQuoteQty`), synthetic fallback execution blocking on Testnet, and `exportExchangeState()` / `restoreExchangeState()`.
  - **Auth, Multi-Tenant Isolation, RBAC, Rate Limits & Strict CORS (`P0-3`):** [`src/server/auth.ts`](../src/server/auth.ts), [`src/server/index.ts`](../src/server/index.ts), [`src/server/botRuntime.ts`](../src/server/botRuntime.ts), and [`src/api/botClient.ts`](../src/api/botClient.ts) enforce SHA-256 timing-safe bearer/API-key auth (`401`), role-based permissions across `viewer`/`researcher`/`trader`/`risk_manager`/`admin` (`403`), strict per-tenant isolation across runtime state, exchange vaults, ledgers, audit logs, and SSE streams (`X-Tenant-Id` spoofing blocked with `403`), sliding-window rate limits (`429` + `Retry-After`), loopback host binding (`HOST ?? '127.0.0.1'`), and strict origin allowlist CORS (no `*` in production). Verified in [`src/server/auth.test.ts`](../src/server/auth.test.ts).
  - **Relational Storage, Postgres/Timescale Migrations, Retention & Double-Entry Ledger (`P0-4`):** [`src/server/store/sqliteStore.ts`](../src/server/store/sqliteStore.ts) (`node:sqlite` WAL default), [`src/server/store/postgresStore.ts`](../src/server/store/postgresStore.ts), and [`src/server/store/postgresMigrations.ts`](../src/server/store/postgresMigrations.ts) implement versioned migrations (`v1`–`v2`, including conditional TimescaleDB hypertable DDL for `candles_archive`), 90-day retention pruning (`POST /api/admin/retention`), and durable `orders`, `ledger_entries`, `audit_events`, and `tenant_runtime_state` tables. [`src/server/ledger/doubleEntryLedger.ts`](../src/server/ledger/doubleEntryLedger.ts) enforces balanced `DEBIT === CREDIT` invariants on every fill/funding/settlement (`GET /api/ledger`). [`src/server/cache/sharedState.ts`](../src/server/cache/sharedState.ts) provides `MemorySharedStateAdapter` and `RedisSharedStateAdapter` for shared TTL cache, rate-limit windows, distributed locks, and pub/sub. Verified in [`src/server/store/store.test.ts`](../src/server/store/store.test.ts).
  - **Delta SSE Framing & Multi-Terminal MT5 (`P0-5`):** [`src/server/botRuntime.ts`](../src/server/botRuntime.ts) & [`src/api/botClient.ts`](../src/api/botClient.ts) emit monotonic `sseSeq` (`id: <seq>`) with initial `frameType: 'snapshot'` and compact `frameType: 'delta'` frames omitting static `presets`, plus exponential-backoff SSE reconnection. [`src/server/mt5Bridge.ts`](../src/server/mt5Bridge.ts) tracks up to `32` independent terminals (`Mt5TerminalTelemetry`) and supports additional quote assets (`/USDT|USDC|BUSD|FDUSD`).
- **Phase 1 Core Infrastructure (`P1-1` + Web Worker Offload):**
  - **Server-Side Shared Market-Data Gateway (`P1-1`):** [`src/server/marketData/marketGateway.ts`](../src/server/marketData/marketGateway.ts) multiplexes subscribers onto a single upstream Binance WebSocket per `(pair, interval)`, detects bar gaps with automatic REST backfill, archives closed bars into `StateStore`, and exposes `/api/market/candles` & `/api/market/stream`. [`src/hooks/useCandles.ts`](../src/hooks/useCandles.ts) and [`src/hooks/useMultiPairCandles.ts`](../src/hooks/useMultiPairCandles.ts) prefer the shared backend gateway before degrading to direct Binance client feeds.
  - **Web Worker Backtesting Offload:** [`src/workers/backtest.worker.ts`](../src/workers/backtest.worker.ts) and [`src/workers/backtestClient.ts`](../src/workers/backtestClient.ts) offload `runBacktest` and `simulatePredictionStrategy` off the browser main thread with `AbortSignal` cancellation, wired into [`src/pages/Backtest.tsx`](../src/pages/Backtest.tsx) and verified in [`src/server/marketData/marketGateway.test.ts`](../src/server/marketData/marketGateway.test.ts).
  - **Live Polymarket CLOB Execution Connector (`P1-6` first live venue):** [`src/server/polymarketExecutor.ts`](../src/server/polymarketExecutor.ts) wraps `@polymarket/clob-client` + `viem` (`Chain.POLYGON` / `Chain.AMOY`, EIP-712 + L2 HMAC) behind the injectable `PolymarketClobClientLike` seam with dual-key arming (`POLY_PRIVATE_KEY` + `FLARE_POLYMARKET_LIVE=true`), `tokenId`/`tickSize`/`negRisk` extraction in [`src/server/polymarketAdapter.ts`](../src/server/polymarketAdapter.ts) & [`src/market/quoteService.ts`](../src/market/quoteService.ts), pre-trade quote/risk/idempotency guards, balanced `PREDICTION_STAKE` ledger posting, unified `registerKillSwitchHandler` cancel-all wiring in [`src/server/exchangeAdapter.ts`](../src/server/exchangeAdapter.ts), auto-mirroring + RBAC endpoints (`/api/polymarket/status`, `/order`, `/cancel`, `/reconcile`) in [`src/server/botRuntime.ts`](../src/server/botRuntime.ts) & [`src/api/botClient.ts`](../src/api/botClient.ts), verified in [`src/server/polymarketExecutor.test.ts`](../src/server/polymarketExecutor.test.ts).

### Remaining Open Roadmap Items (Phase 1+ / Phase 2–4)

- **Managed Production Infrastructure Deployment:** Provision live PostgreSQL/TimescaleDB and Redis instances (connecting `PostgresStateStore` + `RedisSharedStateAdapter`), secrets manager, OIDC/JWT identity provider, and CI load/chaos harness (`1,000` SSE clients, `100` strategy instances).
- **Multi-Strategy Runtime & Venue Expansion (`P1-2`–`P1-7`, `P2`):** Configurable interval/strategy registries, multi-venue prediction adapters (full Polymarket books/resolution + Kalshi), OpenTelemetry/Prometheus observability dashboards, and multi-region HA/DR.

