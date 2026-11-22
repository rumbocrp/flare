# Ticket 03: Polymarket 1h Discovery, Resolution Parser & Live CLOB Order Book Feed (Wave 1)

- **Status:** `ready-for-agent`
- **Blocked by:** `01`
- **Wave:** `1` (Parallel with Tickets `02` and `05`)
- **Owned Files (Modify / Create only — zero overlap with other Wave 1 workers):**
  - Modify: `src/server/polymarketAdapter.ts`, `src/server/polymarketAdapter.test.ts`
  - Create: `src/server/prediction/clobBookFeed.ts`, `src/server/prediction/clobBookFeed.test.ts`

---

## Goal

Extend `src/server/polymarketAdapter.ts` to discover **1-hour (`1h`)** BTC Up/Down windows alongside `5m` and `15m`, parse each contract's verified `resolutionSource` (`chainlink-twap-60s` vs `binance-1h-candle` vs `unknown`), and build `src/server/prediction/clobBookFeed.ts` to stream real-time top-of-book bid/ask, USD depth, spread, and quote age directly from Polymarket's CLOB.

---

## Technical Requirements

1. **Extend `src/server/polymarketAdapter.ts`:**
   - Extend `PolymarketTimeframe = '5m' | '15m' | '1h'` and `STEP_SECONDS = { '5m': 300, '15m': 900, '1h': 3600 }`.
   - **Backward compatibility check:** verify `src/server/botRuntime.ts` (`?tf=...`) and `src/pages/Predictions.tsx` continue compiling cleanly when `PolymarketTimeframe` adds `'1h'`.
   - **1h Slug & Gamma Discovery:**
     - Polymarket 1h BTC Up/Down markets use ET date/hour slugs such as `bitcoin-up-or-down-<month>-<day>-<year>-<hour><am|pm>-et` (plus Gamma active event/market query fallback by `tag_slug` / `slug` prefix or `btc-updown-1h-<ts>` when present). Implement deterministic `buildHourlySlug(startTsSeconds)` using `Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ... })` AND Gamma query fallback so DST (`EST`/`EDT`) never shifts by 1 hour.
   - **Resolution Source Parser:**
     - Extend `GammaMarketFields` and `PolymarketWindow` with:
       `resolutionSource?: 'chainlink-twap-60s' | 'binance-1h-candle' | 'unknown'`
     - Inspect raw Gamma `resolutionSource` and `description` text:
       - If text mentions `chainlink` (or `data.chain.link` / `twap`), return `'chainlink-twap-60s'`.
       - Else if text mentions `binance` (`btcusdt` / `1h candle` / `1 hour`), return `'binance-1h-candle'`.
       - Else return `'unknown'`.
   - Update existing unit test expectations in `src/server/polymarketAdapter.test.ts` cleanly and add tests for `1h` discovery + DST-safe ET slug formatting + `resolutionSource` classification.

2. **Create `src/server/prediction/clobBookFeed.ts`:**
   - Connects to Polymarket CLOB REST `GET https://clob.polymarket.com/book?token_id=<tokenId>` for cold hydration and subscribes to CLOB Market WebSocket (`wss://ws-subscriptions-clob.polymarket.com/ws/market`, payload `{ assets_ids: [...tokenIds], type: 'market' }`) for real-time book updates. Both `fetchImpl` and `WebSocketLike` are injectable for deterministic tests.
   - Computes top-5 cumulative USD depth on bid & ask (`depth = sum(price * size)`), best bid, best ask, spread, mid, and `asOfMs` for both YES (`upTokenId`) and NO (`downTokenId`) tokens of a window:
     ```ts
     export type ClobBookSideSnapshot = {
       tokenId: string
       bestBid: number | null
       bestAsk: number | null
       mid: number | null
       spread: number | null
       bidDepthUsd: number
       askDepthUsd: number
       top5DepthUsd: number
       asOfMs: number
       source: 'clob-ws' | 'clob-rest'
     }

     export type WindowOrderBookSnapshot = {
       slug: string
       upTokenId: string
       downTokenId: string
       yes: ClobBookSideSnapshot | null
       no: ClobBookSideSnapshot | null
       minTop5DepthUsd: number
       capturedAtMs: number
     }
     ```
   - Export `toExecutableQuote(window, outcome, bookSnapshot, nowMs)` producing a standard `ExecutablePredictionQuote` compatible with `src/market/quoteService.ts` and `src/server/polymarketExecutor.ts`.

---

## Verification & Acceptance Criteria

1. Tests in `src/server/polymarketAdapter.test.ts` and `src/server/prediction/clobBookFeed.test.ts` pass covering 5m/15m/1h slug generation (including EST & EDT dates), `resolutionSource` classification, top-5 USD depth aggregation, WS book delta updates, and stale-book detection.
2. Run sequentially: `npm run build`, `npm run lint`, `npm test` — all must exit `0`.

## Comments
