# FLARE — Whole-App Performance, Weight & Data-Accuracy Optimization

> **Status:** proposed. No application code has been changed.
> **Use:** paste this file into a fresh agent session, or execute it phase by phase.
> **Rule:** one phase per change set. Stop and report after each phase.

---

## 0. Mission

You are a senior frontend and backend performance engineer working on FLARE, a local-first trading console (React 19 + Vite 8 + TypeScript + Tailwind 4 on the client, Node + SQLite/Postgres on the server).

Make the whole app **lighter, faster, and more accurate** without changing how it looks or what it does.

The four outcomes, in priority order:

1. **Less work at first paint.** Ship fewer bytes, parse less JavaScript, block on fewer third-party requests.
2. **Less work per update.** A price tick must not re-render the app shell, and a 15-second bot poll must not re-render a 3,000-line page.
3. **One source of truth per data type.** No duplicate candle fetches, no divergent live streams, no silently stale presets, no `NaN` or `$0.21` where the real price is `$0.2134`.
4. **Provable visual parity.** Every change is verified against before/after screenshots and computed styles.

Do **not** interpret "lighter" as "remove features", "hide content", or "show skeletons longer". The user must see the same product, only faster and more trustworthy.

---

## 1. Non-negotiables

1. **No visual redesign.** Do not change design tokens, CSS variables, font families, font sizes, spacing, radii, shadows, colours, icon sets, layout structure, or component class strings. The only allowed visual changes are:
   - more accurate numbers (per-asset decimals, `—` instead of `NaN`/`Infinity`),
   - a stale-data badge using existing muted/warning tokens,
   - a neutral boot splash while a locale chunk loads (same background, no layout shift).
2. **No fabricated data.** Never seed, mock, hardcode, or placeholder a price, trade, P&L, audit, or status. If a source is missing, show the existing "Not connected" / "No data yet" state.
3. **No new runtime dependencies.** Do not add React Query, SWR, Zustand, TanStack Virtual, Framer Motion, a charting library, a compression plugin, or a font package. Use React 19, `useSyncExternalStore`, `AbortController`, `IntersectionObserver`, and Node built-ins.
4. **No trading-logic changes.** Do not alter engine decisions, risk checks, order routing, kill-switch behaviour, or backtest math. This is a delivery and data-plumbing task.
5. **No API contract breaks.** Additive fields only. If a response shape must change, version it and keep the old path working for one release.
6. **No cache TTL increases that trade freshness for hit rate.** A faster stale number is a regression, not an optimization.
7. **Windows gate is sequential.** Run `npm run build`, then `npm run lint`, then `npm test`. Never run them concurrently in separate shells (Vitest/Rolldown `EPERM` lock errors).
8. **Measure first, then change.** Every phase starts from a recorded baseline and ends with a before/after table. If you cannot measure an improvement, do not claim one.

---

## 2. Measured baseline

Source: the current `dist/` build in the working tree, measured on 22 Nov 2026. Rebuild in Phase 0 to confirm; source may have moved since this snapshot.

### 2.1 Bundle

| Surface | Raw | Gzip | Notes |
|---|---:|---:|---|
| Entry `index-*.js` | 348.9 KB | 107.2 KB | Includes `Dashboard` (eager import), `i18n` EN+ES, app shell |
| Preloaded `button-*.js` | 209.9 KB | 67.9 KB | Radix barrel import; loaded before first paint |
| Preloaded `signals-*.js` | 5.0 KB | 2.1 KB | |
| **Initial JS total** | **563.8 KB** | **177.2 KB** | Entry + preloaded chunks |
| Initial CSS `index-*.css` | 60.4 KB | 11.1 KB | |
| **Initial transfer** | **624.2 KB** | **188.3 KB** | JS + CSS, before fonts |
| All JS (31 chunks) | 1,074.0 KB | 310.1 KB | |
| All CSS (2 chunks) | 72.9 KB | 13.6 KB | |
| `Predictions-*.js` | 89.5 KB | 22.3 KB | 2,950-line page |
| `BotRun-*.js` | 101.5 KB | 21.4 KB | |
| `ChartTerminal-*.js` | 97.1 KB | 25.0 KB | |
| `CandleChart-*.js` | 50.6 KB | 15.6 KB | |
| `Settings-*.js` | 42.9 KB | 9.1 KB | |
| `favicon.svg` | 9.3 KB | — | Large for an icon |

### 2.2 Source hotspots

| File | Size | Why it matters |
|---|---:|---|
| `src/pages/Predictions.tsx` | 118.5 KB / 2,950 lines | ~30 `useState` in one component; 3 s poll updates top-level state |
| `src/server/botRuntime.ts` | 106.6 KB / 3,412 lines | SSE broadcast, snapshot/delta payloads, most API routes |
| `src/i18n.tsx` | 103.5 KB / 2,025 lines | EN and ES dictionaries in one module |
| `src/components/CandleChart.tsx` | 88.8 KB / 2,533 lines | Full SVG re-render on candle updates |
| `src/components/MarketAnalysis.tsx` | 77.5 KB / 2,282 lines | Heavy derived analysis and pane layout |
| `src/pages/Dashboard.tsx` | eager import | Pulled into the entry chunk |
| `src/server/flare.db` | 12.2 MB | Plus ~4.2 MB WAL |
| `src/server/flare.db.pre-truth.bak` | 9.4 MB | Local backup; keep out of the repo and build context |

### 2.3 Runtime and network facts

- `index.html` loads Google Fonts (Atkinson Hyperlegible + Lekton, 7 variants) as a render-blocking third-party stylesheet.
- 13 UI files import from the `radix-ui` **barrel** (`import { Slot } from 'radix-ui'`). The package exposes tree-shakeable subpaths (`radix-ui/slot`, `radix-ui/alert-dialog`, …).
- `Dashboard` is the only eagerly imported page; every other page is `lazy()`.
- `useCandles` fetches independently per hook instance. `useLiveCandles` opens one SSE subscription per hook instance. The server dedupes upstream requests, but the client still issues duplicate requests and parses duplicate payloads.
- `subscribeToBotStream` opens one SSE connection per caller. Four call sites exist (`Dashboard`, `BotRun`, `Settings`, `MarketAnalysis`); usually one page is mounted at a time, but the connection is not shared.
- `getBotDeltaSnapshot` includes the full `engineState`, which can hold up to 500 closed trades and 500 resolved tickets, every 15 s. It omits `presets`; the client falls back to `cachedPresets`, so a preset change made elsewhere can remain invisible until reconnect.
- `Predictions` polls every 3 s. The poll is not visibility-aware and has no request-race guard.
- `checkBackendHealth` probes two endpoints sequentially with a 3.5 s timeout each, so a dead backend can block for ~7 s.
- `formatPrice` always uses 2 decimals. `availablePairs` includes `XRP/USDT` and `DOGE/USDT`, so sub-dollar precision is lost.
- `formatPercent` and `formatMoney` do not guard `NaN`/`Infinity`.
- SQLite enables WAL and `synchronous = NORMAL`, but sets no `busy_timeout`, no `wal_autocheckpoint`, and performs no checkpoint/optimize on shutdown.
- `vite.config.ts` has no `manualChunks`, no compression, and no bundle budget.

---

## 3. Budgets

Set these as hard gates. Adjust only with a written reason and a measured baseline.

| Metric | Current | Target | How to measure |
|---|---:|---:|---|
| Initial JS (gzip) | 177.2 KB | **≤ 120 KB** | `node scripts/perf/bundle-budget.mjs`; counts entry + preloaded chunks + the default route chunk needed for first paint |
| Initial CSS (gzip) | 11.1 KB | **≤ 13 KB** | same |
| Total JS (gzip) | 310.1 KB | **≤ 280 KB** | same |
| Any route chunk (gzip) | 25.0 KB max | **≤ current + 5%** | same |
| Fonts | 7 variants, third-party CSS | **≤ 4 woff2 files, ≤ 120 KB total, self-hosted** | build output |
| LCP (local prod preview, desktop) | baseline in Phase 0 | **≥ 20% faster and ≤ 1.8 s** | DevTools Performance |
| TBT | baseline | **≤ 200 ms** | DevTools Performance |
| CLS | baseline | **≤ 0.02** | DevTools Performance |
| Long task during a candle tick | baseline | **≤ 50 ms** | Performance panel |
| Chart commit on tick | baseline | **≤ 16 ms** | React Profiler |
| SSE delta frame | baseline | **p95 ≤ 8 KB** | DevTools Network / server log |
| Bot snapshot frame | baseline | **p95 ≤ 250 KB** | same |
| Cached API latency | baseline | **p95 ≤ 150 ms** | server timing |
| Upstream API latency | baseline | **p95 ≤ 1.2 s** | server timing |
| Duplicate in-flight candle requests | unknown | **0 per key** | network panel |
| JS heap after 10 min on Terminal | baseline | **≤ 150 MB** | Memory panel |
| Stale data shown as live | unknown | **0** | manual + tests |

---

## 4. Audit backlog

Severity: **P0** = first paint or correctness, **P1** = hot path or trust, **P2** = polish.

### P0 — first paint and correctness

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| P0-1 | Radix barrel import pulls a 209.9 KB chunk into first paint | `src/components/ui/*.tsx` import from `'radix-ui'`; `dist/index.html` preloads `button-*.js` | Import subpaths: `radix-ui/slot`, `radix-ui/alert-dialog`, `radix-ui/select`, etc. No new dependency. |
| P0-2 | Both locales ship in the entry chunk | `src/i18n.tsx` defines `en` and `es` in one module | Split to `src/i18n/en.ts` + `src/i18n/es.ts`; static-import EN, dynamically import ES on demand. Keep `t()` synchronous after load. |
| P0-3 | Google Fonts is render-blocking and third-party | `index.html` `<link href="https://fonts.googleapis.com/...">` | Vendor the exact woff2 files under `public/fonts/`, add `@font-face` with `font-display: swap`, preload the two regular weights, keep family names and metrics identical. Include Latin-ext for Spanish accents. |
| P0-4 | Per-hook candle fetch and stream duplication | `src/hooks/useCandles.ts` | Add `src/market/marketDataStore.ts`: keyed cache, in-flight dedupe, TTL, ref-counted SSE, `useSyncExternalStore`. |
| P0-5 | SSE delta carries full engine state and omits preset changes | `getBotDeltaSnapshot` in `src/server/botRuntime.ts` | Send a compact delta: counts and version hashes instead of `closedTrades`/`resolvedTickets`; add `presetsVersion`/`stateVersion`; client refetches the full snapshot only when a version changes. |
| P0-6 | 3 s poll re-renders the whole Predictions page | `src/pages/Predictions.tsx` poll at ~3,000 ms | Isolate poll state in a leaf store/component; memoize tables and rows; pause when `document.hidden`. |
| P0-7 | Prices lose precision for XRP/DOGE; `NaN` can reach the UI | `src/format.ts`; `availablePairs` in `src/strategy.ts` | Add `formatAssetPrice(pair, value)` with per-asset decimals; guard non-finite values with `—`; add tests. |
| P0-8 | SQLite lacks busy timeout and WAL maintenance | `src/server/store/sqliteStore.ts` | Add `PRAGMA busy_timeout = 5000`, `PRAGMA wal_autocheckpoint = 1000`, `PRAGMA optimize` on close, `wal_checkpoint(TRUNCATE)` on shutdown. |

### P1 — hot paths and trust

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| P1-1 | `Dashboard` is eager | `src/App.tsx` | Try `lazy()`; keep it only if it reduces first-paint bytes or improves cache isolation. A default route that still loads before paint must be counted in the initial budget. Prefetch on idle if lazy adds a request. |
| P1-2 | No vendor chunking | `vite.config.ts` | Add `manualChunks` for stable vendors (`react`, `radix`, `icons`). Avoid a chunk explosion; target 3–5 vendor chunks. |
| P1-3 | Candle chart re-renders all SVG layers on tick | `src/components/CandleChart.tsx` | Split static series, overlays, axes, hover, drawings; `React.memo` each layer; keep the existing rAF hover path. |
| P1-4 | Polling is not visibility-aware; races possible | `Predictions`, `useCandles`, `checkBackendHealth` | Pause hidden tabs; abort stale requests; add `inFlight` guards; probe health endpoints in parallel with a single 4 s budget and cache the result for 30 s. |
| P1-5 | API payloads are trusted with `as` casts | `src/api/botClient.ts` | Add narrow guards for candles, bot snapshot, gateway events, accuracy reports. On failure keep the last good data, show a stale/error state, log once. |
| P1-6 | No bundle budget in CI | — | Add `scripts/perf/bundle-budget.mjs` (Node built-ins only) and `npm run perf:budget`. Fail on budget breach. |
| P1-7 | No compression/cache guidance | `vite.config.ts`, deploy config | Configure the static host for Brotli/gzip and `Cache-Control: public, max-age=31536000, immutable` on hashed assets; `no-cache` on `index.html`. Do not add a Vite compression plugin. |
| P1-8 | Stale data has no explicit state | `useCandles`, bot stream | Add `updatedAt`/`staleAfterMs` and an existing-token "Stale" badge. Never present old data as live. |

### P2 — polish

| ID | Finding | Fix |
|---|---|---|
| P2-1 | `favicon.svg` is 9.3 KB | Simplify to < 2 KB without changing the mark. |
| P2-2 | No route prefetch | Prefetch the likely next route on idle/hover using the existing `lazy()` imports. |
| P2-3 | Below-fold cards render eagerly | Use `content-visibility: auto` with `contain-intrinsic-size` on long lists/cards, only where it does not change scroll height. |
| P2-4 | No DB maintenance/backup routine | Add a documented offline `VACUUM`/backup procedure; keep `.bak` files out of `src/`. |
| P2-5 | CSS is 60.4 KB raw | Verify Tailwind content scanning does not include server-only strings; do not purge dynamic classes. |

---

## 5. Execution phases

### Phase 0 — Baseline and guardrails (no behaviour change)

**Goal:** make every later claim measurable.

Tasks:

1. Run the production build and record raw/gzip sizes per asset.
2. Capture the screenshot matrix in §6.1 and store it under `.scratch/app-optimization/baseline/`.
3. Record DevTools Performance traces for: Dashboard load, Chart Terminal 60 s, Predictions 60 s, Bot Run 60 s.
4. Record network counts and SSE frame sizes for the same sessions.
5. Add `scripts/perf/bundle-budget.mjs` with budgets from §3. It must parse `dist/index.html` for the entry script, modulepreloads, and stylesheets, resolve the default route chunk, compute raw and gzip sizes with `node:zlib`, print a table, and exit non-zero on breach. Count the default route chunk in the initial budget.
6. Add `npm run perf:budget` to `package.json`.
7. Write `.scratch/app-optimization/baseline.md` with the numbers and the machine/browser used.

**Acceptance**

- Baseline report exists and matches a fresh build.
- Budget script runs and passes with Phase 0 limits set to current values (tighten in later phases).
- No application behaviour changed.

---

### Phase 1 — First-paint diet (P0-1, P0-2, P0-3, P1-1, P1-2, P1-7, P2-1)

**Goal:** cut initial JS from ~177 KB gzip to ≤ 120 KB gzip with zero visual change.

Tasks:

1. **Radix subpaths.** Replace every `from 'radix-ui'` with the exact subpath:
   - `radix-ui/slot`, `radix-ui/alert-dialog`, `radix-ui/checkbox`, `radix-ui/label`, `radix-ui/popover`, `radix-ui/scroll-area`, `radix-ui/select`, `radix-ui/separator`, `radix-ui/slider`, `radix-ui/switch`, `radix-ui/tabs`, `radix-ui/tooltip`.
   - Keep named exports identical. Verify types still resolve.
2. **i18n split.** Move dictionaries to `src/i18n/en.ts` and `src/i18n/es.ts`.
   - EN is static.
   - ES loads via `import('./i18n/es')` when `language === 'es'`.
   - Until the dictionary is ready, render a neutral splash (`background: var(--background)`, no text layout) so there is no English flash.
   - Keep `useI18n()` and `t()` signatures unchanged.
3. **Fonts.** Vendor the exact woff2 files, add `@font-face` rules in `src/index.css`, remove the Google Fonts `<link>`, keep the preconnect hints only if still useful.
   - Preload Atkinson regular + bold and Lekton regular.
   - Include Latin-ext.
   - Verify computed `font-family`, weight, and line height are unchanged.
4. **Dashboard lazy.** Convert to `lazy()` and prefetch on idle. Ensure the default route does not show a longer spinner than today.
5. **Vendor chunks.** Add `manualChunks` for `react`/`react-dom`, Radix primitives, and `lucide-react`. Do not split per icon.
6. **Deploy headers.** Document Brotli/gzip and immutable caching for hashed assets. If the repo owns a static server, implement it there; otherwise add a `docs/deploy/caching.md` note.
7. **Favicon.** Simplify without changing the visual mark.

**Acceptance**

- Initial JS gzip ≤ 120 KB; initial CSS gzip ≤ 13 KB.
- `dist/index.html` no longer preloads a > 50 KB Radix chunk.
- No request to `fonts.googleapis.com` or `fonts.gstatic.com`.
- Screenshot diff clean in both themes.
- `npm run perf:budget` passes.

---

### Phase 2 — One market-data path (P0-4, P0-5, P1-4, P1-5, P1-8)

**Goal:** one fetch and one stream per `(pair, interval, limit)`, one bot stream per tab, and no silent staleness.

Tasks:

1. **`src/market/marketDataStore.ts`**
   - `Map<key, Entry>` where `key = source|pair|interval|limit`.
   - `Entry = { candles, status, source, updatedAt, error, subscribers, unsubscribeStream, inFlight }`.
   - `subscribe(key, listener)` increments refcount and starts the gateway SSE on the first subscriber; decrements and closes on the last.
   - `getSnapshot(key)` returns a stable object; `useSyncExternalStore` in `useCandles`/`useLiveCandles`.
   - TTL by interval; stale-while-revalidate; `forceRefresh` bypasses TTL.
   - One `fetch` per key; late responses are ignored by request id.
2. **Candle normalization.** Before storing, validate and normalize:
   - finite `time/open/high/low/close/volume`, positive prices, non-negative volume,
   - `low <= min(open, close) <= max(open, close) <= high`,
   - `time` aligned to the interval,
   - dedupe by `time`, sort ascending, replace only the matching bar, never mutate history.
   - Add fixtures for out-of-order, duplicate, gap, and invalid OHLC.
3. **Bot stream store.** `src/api/botStreamStore.ts`
   - One connection per tab, fanout to subscribers.
   - Merge delta frames by `seq`; ignore duplicates.
   - Track `presetsVersion` and `stateVersion`; when either changes, fetch the full snapshot once and update all subscribers.
   - Keep the last good snapshot on parse/validation failure; expose `error` and `updatedAt`.
4. **SSE delta compaction.** In `getBotDeltaSnapshot`:
   - omit `closedTrades`, `resolvedTickets`, and log arrays; send counts and version hashes,
   - add `presetsVersion` and `stateVersion`,
   - keep `preset`, `state` summary, `telemetry`, `exchange`, `mt5`.
   - Add a server test that asserts the delta stays under 8 KB with 500 closed trades in state.
5. **Visibility and races.**
   - Pause polling and SSE reconnection backoff when `document.hidden`; refresh immediately on `visibilitychange`.
   - `Predictions` poll: `inFlight` guard + `AbortController`; ignore out-of-order responses.
   - `checkBackendHealth`: probe candidates in parallel with one 4 s budget; cache the result for 30 s.
6. **Boundary guards.** Add `src/api/guards.ts` with `isCandleSeries`, `isBotSnapshot`, `isGatewayEvent`, `isAccuracyReport`. Use them at the fetch boundary. On failure: keep last good data, set `error`, log once per key per minute.
7. **Freshness.** Add `staleAfterMs` (e.g. `max(2.5 × interval, 90 s)`) and a "Stale" badge using existing warning/muted tokens. Show the server `updatedAt`, not the client receipt time.

**Acceptance**

- Two components using the same `(pair, interval, limit)` produce exactly one network request and one SSE connection.
- Network panel shows no duplicate in-flight candle requests.
- SSE delta p95 ≤ 8 KB; snapshot p95 ≤ 250 KB.
- Preset changes propagate without reconnect.
- Hidden tab stops polling; visible tab refreshes immediately.
- Malformed payload test keeps the last good data and shows the stale state.
- No `NaN`, `Infinity`, or `undefined` reaches the DOM.

---

### Phase 3 — Render hot paths (P0-6, P1-3, P2-2, P2-3)

**Goal:** a tick updates only the pixels that changed.

Tasks:

1. **Predictions split.**
   - Extract the poll into a small external store or a leaf component.
   - Split the page into `RulesPanel`, `TicketsPanel`, `CanaryPanel`, `AuditPanel`, `ReplayPanel` under `src/components/predictions/`.
   - Memoize rows and derived arrays; pass primitives, not freshly created objects.
   - Keep the existing DOM structure and class names.
2. **CandleChart layers.**
   - Separate `SeriesLayer`, `OverlayLayer`, `AxisLayer`, `DrawingLayer`, `HoverLayer`, `SignalLayer`.
   - `React.memo` each; only the last-bar layer and hover layer update on tick.
   - Keep the current rAF hover/measure path.
   - Do not rewrite to canvas.
3. **MarketAnalysis memo audit.**
   - Verify every `useMemo` dependency is stable; replace inline arrays/objects with module constants or `useMemo`.
   - Add `performance.mark`/`measure` behind `import.meta.env.DEV` only.
4. **Route prefetch.** On idle or dock hover, `import()` the next likely page. Do not prefetch all pages.
5. **`content-visibility`.** Apply only to long below-fold lists/cards, with `contain-intrinsic-size` matching current heights. Verify scroll height and screenshot parity.

**Acceptance**

- React Profiler: a candle tick commits ≤ 16 ms and does not re-render the page shell.
- Predictions poll commit ≤ 16 ms.
- No layout shift or scroll-height change.
- Screenshot diff clean.

---

### Phase 4 — Data accuracy and storage (P0-7, P0-8, P2-4)

**Goal:** numbers are correct and the local store stays healthy.

Tasks:

1. **Per-asset price precision.** In `src/format.ts`:
   - `formatAssetPrice(pair, value)`: BTC/ETH 2, SOL 3, XRP 4, DOGE 5; fallback 2 for unknown.
   - Use it wherever the pair is known. Keep `formatPrice` as the fallback for pair-less contexts.
   - Add tests for `0.2134`, `2.1534`, `1234.5`, `0`, `NaN`, `Infinity`.
2. **Non-finite guards.** `formatMoney`, `formatSignedMoney`, `formatPercent`, `formatOrDash` return `—` for non-finite input. No `NaN%`, no `-$0.00`.
3. **SQLite pragmas.**
   - `PRAGMA busy_timeout = 5000`
   - `PRAGMA wal_autocheckpoint = 1000`
   - `PRAGMA optimize` on close
   - `PRAGMA wal_checkpoint(TRUNCATE)` on graceful shutdown
   - Keep `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`.
4. **Query plans.** Run `EXPLAIN QUERY PLAN` for the top 10 queries (orders, ledger, audit, runtime events, prediction windows/snapshots/trades, strategy audits). Add missing composite indices only where a plan shows a scan.
5. **Payload caps.** Enforce max page sizes at the API boundary (already partly done); reject unbounded `limit`.
6. **DB hygiene.** Move `flare.db.pre-truth.bak` out of `src/server/`; extend `.gitignore` to `src/server/*.db*` (covers `.bak`, `.pre-*`). Document an offline backup + `VACUUM` procedure.
7. **Idempotency.** For mutating requests that can be retried (start/stop, promote, close), accept a `clientRequestId` and dedupe for 10 minutes. Do not change trading decisions.

**Acceptance**

- DOGE shows 5 decimals, XRP 4, BTC/ETH 2; all formatting tests pass.
- No `NaN`, `Infinity`, `undefined`, or `-$0.00` in any rendered state.
- `PRAGMA busy_timeout` and `wal_autocheckpoint` are set at connection open.
- Shutdown checkpoints the WAL; `-wal` file returns to a small size after a clean stop.
- Query plans use indices for the top queries.
- No `.bak` file under `src/`.

---

### Phase 5 — Verification and report

**Goal:** prove the result and leave a repeatable gate.

Tasks:

1. Run the full sequential gate.
2. Re-run the screenshot matrix and compare to Phase 0.
3. Re-run the performance traces and fill the before/after table.
4. Run a 10-minute soak on Chart Terminal and Bot Run; record heap, SSE frame sizes, and error count.
5. Write `.scratch/app-optimization/results.md` with:
   - before/after per budget,
   - what changed and why,
   - what was intentionally not changed,
   - any remaining risk,
   - rollback notes per phase.

**Acceptance**

- All budgets in §3 met or explicitly waived with evidence.
- `npm run build`, `npm run lint`, `npm test`, `npm run perf:budget` pass sequentially.
- Screenshot diff clean.
- No new console errors or warnings.
- No visual token changes in `git diff`.

---

## 6. Visual parity protocol

### 6.1 Screenshot matrix

Capture before Phase 1 and after every phase:

| Page | Themes | Viewports |
|---|---|---|
| Dashboard | dark, light | 1440×900, 1024×768, 390×844 |
| Chart Terminal | dark, light | 1440×900, 1024×768 |
| Bot Run | dark, light | 1440×900, 1024×768 |
| Predictions | dark, light | 1440×900, 1024×768 |
| Backtest | dark, light | 1440×900 |
| Stats | dark, light | 1440×900 |
| Settings | dark, light | 1440×900 |
| Bot Config | dark, light | 1440×900 |

Use fixed data where the app allows it (same pair, interval, preset, date range). Do not compare a loading state to a loaded state.

### 6.2 What must be identical

- Design tokens and CSS variables (`src/index.css` colour/spacing blocks unchanged).
- Font family, weight, size, line height, letter spacing.
- Layout: header, dock, sidebar, card grid, chart axes, table columns.
- Component class strings in `src/components/ui/*`.
- Icons and their sizes.
- Scroll heights and sticky/fixed behaviour.

### 6.3 Allowed differences

- More accurate numeric strings (documented per case).
- `—` where the old UI showed `NaN`/`Infinity`.
- A stale badge in an existing muted/warning style.
- A neutral boot splash for the ES locale chunk (same background, no text layout).
- Fewer network requests and faster timings (not visible).

### 6.4 How to compare

1. Capture PNGs at the same viewport, theme, zoom (100%), and device pixel ratio.
2. Compare side by side and with a pixel diff if a local tool is available. Do not add a dependency for this.
3. For key elements (`header`, `dock`, `card`, `chart`, `table`), record `getComputedStyle` for colour, background, font, padding, margin, border-radius, and box-shadow before/after. They must match.
4. If a difference is intentional, add it to the results table with a screenshot and a one-line reason. If it is not intentional, stop and fix it.

---

## 7. Data-accuracy protocol

Apply these rules to every data path you touch.

1. **One source of truth.** Candles: `marketDataStore`. Bot state: `botStreamStore`. Presets: the bot snapshot + `presetsVersion`. Do not keep a second copy in a component.
2. **Normalize at the boundary.** Validate shape, finiteness, OHLC invariants, timestamp alignment, sort order, and duplicates before data enters a store.
3. **Never silently fall back.** If a payload is invalid, keep the last good value, mark it stale, and surface the error once. Do not substitute `0`, `[]`, or a fabricated default.
4. **Server time wins.** Use server `updatedAt`/`fetchedAt` for freshness. If you need client time, compute and display skew; do not mix the two.
5. **Idempotent mutations.** Every retryable action carries a `clientRequestId`. The server dedupes; the client disables the button while in flight.
6. **Race guards.** Every fetch has an abort signal and a request id. A late response must never overwrite a newer one.
7. **Precision follows the asset.** Format prices with per-asset decimals. Never round DOGE to 2 decimals.
8. **Tests are fixtures, not live data.** Use recorded payloads for unit tests. Never call Binance, Polymarket, or a local model in a unit test.
9. **No hidden freshness trade-offs.** A longer TTL must be justified by a correctness fix, not by a hit-rate target.

---

## 8. Verification commands

Run sequentially on Windows:

```powershell
npm run build
npm run lint
npm test
npm run perf:budget
```

Manual checks:

- `npm run preview` and load each page with the backend both up and down.
- DevTools Network: count requests, check gzip/Brotli, confirm no Google Fonts.
- DevTools Performance: LCP, TBT, CLS, long tasks during a tick.
- DevTools Memory: 10-minute soak on Terminal and Bot Run.
- React Profiler: tick commit duration and re-render scope.
- Server: `EXPLAIN QUERY PLAN` for top queries; WAL size after clean shutdown.

---

## 9. Stop conditions

Stop and report instead of guessing when:

- A visual diff cannot be explained or would require a token/class change.
- A budget cannot be met without removing a feature or hiding content.
- A new dependency seems necessary.
- An API contract would break.
- A data source is unavailable and the only way to "fix" it is to fabricate data.
- A change would touch trading logic, risk checks, or order routing.
- A test, lint, or build failure cannot be fixed inside the current phase.
- The same data would be cached longer than its freshness window.
- SSE delta compaction would lose information the UI needs; add a versioned fetch instead.

---

## 10. Final report template

```md
# Optimization results

## Budgets

| Metric | Before | After | Target | Status |
|---|---:|---:|---:|---|
| Initial JS gzip | | | ≤ 120 KB | |
| Initial CSS gzip | | | ≤ 13 KB | |
| Total JS gzip | | | ≤ 280 KB | |
| LCP | | | ≤ 1.8 s | |
| TBT | | | ≤ 200 ms | |
| CLS | | | ≤ 0.02 | |
| SSE delta p95 | | | ≤ 8 KB | |
| Duplicate candle requests | | | 0 | |

## Changes

- Phase 1:
- Phase 2:
- Phase 3:
- Phase 4:

## Visual parity

- Screenshot matrix: pass/fail per page/theme/viewport.
- Computed-style checks: pass/fail.
- Intentional differences: list with reason.

## Data accuracy

- New guards:
- New tests:
- Known gaps:

## Risks and rollback

- Risk:
- Rollback:

## Gate

- `npm run build`:
- `npm run lint`:
- `npm test`:
- `npm run perf:budget`:
```

---

## 11. Copy-ready kickoff message

> Read `.scratch/app-optimization/optimization-prompt.md`. Execute **Phase 0 only**. Do not change application behaviour. Build the current tree, capture the baseline bundle table, screenshot matrix, and performance traces, add `scripts/perf/bundle-budget.mjs` with current-value budgets, and write `.scratch/app-optimization/baseline.md`. Stop and report the baseline numbers and any mismatch with §2 before starting Phase 1.
