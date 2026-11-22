# Ticket 02: Oracle RTDS Chainlink Stream & Binance 1s Volatility Feed (Wave 1)

- **Status:** `ready-for-agent`
- **Blocked by:** `01`
- **Wave:** `1` (Parallel with Tickets `03` and `05`)
- **Owned Files (Create only — zero overlap with other Wave 1 workers):**
  - `src/server/prediction/oracleFeed.ts`
  - `src/server/prediction/oracleFeed.test.ts`

---

## Goal

Build the server-side dual price oracle & volatility service needed by both the Window Collector (`Ticket 04`) and the Intra-Window Prediction Runner (`Ticket 07`), using **Polymarket's public unauthenticated RTDS WebSocket** for Chainlink BTC/USD `60s` TWAP alongside **Binance's public `aggTrade` WebSocket** for `1s` pricing, realized volatility (`sigma`), and oracle-basis divergence (`G2`).

---

## Technical Requirements

1. **Polymarket RTDS Chainlink Client (No Chainlink credentials required):**
   - Connect to `wss://ws-live-data.polymarket.com` (injectable WebSocket factory `WebSocketLike` for clean tests — use Node 24/26 built-in `globalThis.WebSocket` in runtime so zero extra WS package is needed).
   - Immediately on `open`, send:
     ```json
     {
       "action": "subscribe",
       "subscriptions": [
         {
           "topic": "crypto_prices_chainlink",
           "type": "*",
           "filters": "{\"symbol\":\"btc/usd\"}"
         }
       ]
     }
     ```
   - Send text keepalive `PING` every `5,000ms`; reconnect automatically on close/error or silent tick timeout (`> 12,000ms`) with bounded exponential backoff (`1s..30s`) + jitter.
   - Tolerate upstream 1-3s tick gaps gracefully without resetting buffered samples.
   - Maintain a ring buffer of at least `24h` (`86,400` 1s samples or timestamped ticks) for computing exact **`60s` time-weighted / sample-weighted TWAP (`twap60s`)**:
     - `getTwapAt(targetMs, windowMs = 60_000)` -> returns `{ twap: number; sampleCount: number; ageMs: number } | null` so each window can pin `S0` (at window `startTime`) and `St` (live).

2. **Binance Public 1s Reference & Realized Volatility (`btcusdt@aggTrade`):**
   - Connect to `wss://stream.binance.com:9443/ws/btcusdt@aggTrade` (also injectable `WebSocketLike`), aggregating trades into 1-second closes and retaining rolling `60m` + `24h` 1-minute closes.
   - Compute:
     - `sigma1m`: standard deviation of 1-minute log returns `ln(C_t / C_{t-1})` over the prior `60` minutes.
     - `median24hSigma1m`: rolling median of 1-minute `sigma1m` across up to 24 hours (derived cleanly from closed 1m bars fetched on startup via `fetchOptimizedCandles('BTC/USDT', '1m', 1000)` or accumulated live). Note: check `candleCache.ts` valid `Interval` list (`5m` minimum in `types.ts`? **Check carefully!** `src/types.ts` line 60 defines `Interval = '5m' | '15m' | '1h' | '4h' | '1d'`! Do NOT pass `'1m'` to `Interval`-typed APIs unless calling public Binance REST `/api/v3/klines?symbol=BTCUSDT&interval=1m` via injectable `fetchImpl` or deriving from `5m` + live `1s` stream!). Using direct Binance REST `/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=500` inside `oracleFeed.ts` avoids mutating `src/types.ts` (keeping `oracleFeed.ts` 100% file-isolated!).
     - Floor `sigma1mEffective = Math.max(sigma1mRaw, 0.35 * median24hSigma1m)`.

3. **Exports (`src/server/prediction/oracleFeed.ts`):**
   ```ts
   export type OracleSnapshot = {
     nowMs: number
     chainlinkPrice: number | null
     chainlinkTwap60s: number | null
     chainlinkUpdatedAtMs: number | null
     chainlinkStaleMs: number
     binancePrice: number | null
     binanceUpdatedAtMs: number | null
     binanceStaleMs: number
     basisBps: number | null // abs(twap - binance) / binance * 10_000
     sigma1m: number | null
     median24hSigma1m: number | null
     connectedRtds: boolean
     connectedBinance: boolean
   }
   ```
   - Class / service `OracleFeedService` (and singleton accessor `getOracleFeed()` / `resetOracleFeed()`).
   - Pure helper methods testable without network: `ingestChainlinkTick(price, timestampMs)`, `ingestBinanceTrade(price, timestampMs)`, `getSnapshot(nowMs)`, `getWindowOpenTwap(startTimeMs)`.
   - TypeScript 7 strictness: no `enum`s (`erasableSyntaxOnly`), `import type` for type-only imports (`verbatimModuleSyntax`), zero simulated fallback prices (return `null` when upstream is unconnected/stale).

---

## Verification & Acceptance Criteria

1. Unit tests in `src/server/prediction/oracleFeed.test.ts` cover:
   - RTDS subscription handshake & 5s `PING` heartbeat via mocked WebSocket
   - `60s` TWAP calculation for both `S0` at window start and `St` live
   - Upstream 2s gap tolerance vs `> 15s` staleness detection
   - `sigma1m` computation + `0.35 * median24hSigma1m` volatility floor
   - `basisBps` computation between Chainlink TWAP and Binance price
   - Zero simulated fallback values when no ticks have arrived
2. Run sequentially in workspace: `npm run build`, `npm run lint`, `npm test` — all must exit `0`.

## Comments
