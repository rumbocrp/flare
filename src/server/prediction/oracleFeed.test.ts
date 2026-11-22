import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OracleFeedService,
  getOracleFeed,
  resetOracleFeed,
  type FetchLike,
  type WebSocketLike,
} from './oracleFeed'

class FakeWebSocket implements WebSocketLike {
  readyState = 0
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  readonly url: string
  readonly sentFrames: string[] = []
  closed = false

  constructor(url: string) {
    this.url = url
  }

  send(data: string): void {
    this.sentFrames.push(data)
  }

  close(): void {
    this.closed = true
    this.readyState = 3
  }

  emitOpen(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  emitMessage(payload: unknown): void {
    const data =
      typeof payload === 'string' ? payload : JSON.stringify(payload)
    this.onmessage?.({ data })
  }

  emitClose(): void {
    this.readyState = 3
    this.onclose?.({})
  }

  emitError(): void {
    this.onerror?.(new Error('ws error'))
  }
}

const noopFetch: FetchLike = async () => ({
  ok: true,
  status: 200,
  json: async () => [],
})

describe('OracleFeedService', () => {
  const services: OracleFeedService[] = []

  afterEach(() => {
    for (const svc of services) {
      svc.stop()
    }
    services.length = 0
    vi.useRealTimers()
  })

  it('returns null prices and Infinity staleness when unconnected/empty (no simulated fallback)', () => {
    const now = 1_700_000_000_000
    const service = new OracleFeedService({
      nowMs: () => now,
      fetchImpl: noopFetch,
    })
    services.push(service)

    const snapshot = service.getSnapshot()
    expect(snapshot).toEqual({
      nowMs: now,
      chainlinkPrice: null,
      chainlinkTwap60s: null,
      chainlinkUpdatedAtMs: null,
      chainlinkStaleMs: Number.POSITIVE_INFINITY,
      binancePrice: null,
      binanceUpdatedAtMs: null,
      binanceStaleMs: Number.POSITIVE_INFINITY,
      basisBps: null,
      sigma1m: null,
      median24hSigma1m: null,
      connectedRtds: false,
      connectedBinance: false,
    })
    expect(service.getTwapAt(now)).toBeNull()
    expect(service.getWindowOpenTwap(now)).toBeNull()
  })

  it('sends RTDS Chainlink subscribe handshake on open and 5s PING keepalives', async () => {
    vi.useFakeTimers()
    const baseNow = 1_700_000_000_000
    vi.setSystemTime(baseNow)

    const sockets: FakeWebSocket[] = []
    const service = new OracleFeedService({
      nowMs: () => Date.now(),
      random: () => 0.5,
      fetchImpl: noopFetch,
      wsFactory: (url) => {
        const ws = new FakeWebSocket(url)
        sockets.push(ws)
        return ws
      },
    })
    services.push(service)

    await service.start()

    expect(sockets).toHaveLength(2)
    const rtdsSocket = sockets.find((s) =>
      s.url.includes('ws-live-data.polymarket.com'),
    )
    const binanceSocket = sockets.find((s) =>
      s.url.includes('btcusdt@aggTrade'),
    )
    expect(rtdsSocket).toBeDefined()
    expect(binanceSocket).toBeDefined()

    rtdsSocket!.emitOpen()
    binanceSocket!.emitOpen()

    expect(service.getSnapshot().connectedRtds).toBe(true)
    expect(service.getSnapshot().connectedBinance).toBe(true)
    expect(rtdsSocket!.sentFrames).toHaveLength(1)
    expect(JSON.parse(rtdsSocket!.sentFrames[0])).toEqual({
      action: 'subscribe',
      subscriptions: [
        {
          topic: 'crypto_prices_chainlink',
          type: '*',
          filters: '{"symbol":"btc/usd"}',
        },
      ],
    })

    // Emit ticks within silent timeout so watchdog does not disconnect during PING check
    await vi.advanceTimersByTimeAsync(5_000)
    rtdsSocket!.emitMessage({
      topic: 'crypto_prices_chainlink',
      payload: { symbol: 'btc/usd', value: 95_100, timestamp: Date.now() },
    })
    rtdsSocket!.emitMessage('PONG')

    await vi.advanceTimersByTimeAsync(5_000)
    rtdsSocket!.emitMessage({
      topic: 'crypto_prices_chainlink',
      payload: { symbol: 'btc/usd', value: 95_105, timestamp: Date.now() },
    })

    await vi.advanceTimersByTimeAsync(5_000)

    const pings = rtdsSocket!.sentFrames.filter((frame) => frame === 'PING')
    expect(pings).toHaveLength(3)
    expect(service.getSnapshot().chainlinkPrice).toBe(95_105)
  })

  it('parses RTDS snapshot & live updates (sec/ms) and computes 60s TWAP for S0 and live St', async () => {
    let clock = 1_700_000_000_000
    const sockets: FakeWebSocket[] = []

    const service = new OracleFeedService({
      nowMs: () => clock,
      fetchImpl: noopFetch,
      wsFactory: (url) => {
        const ws = new FakeWebSocket(url)
        sockets.push(ws)
        return ws
      },
    })
    services.push(service)

    await service.start()
    const rtdsSocket = sockets[0]
    rtdsSocket.emitOpen()

    const windowStartMs = 1_700_000_060_000

    // Snapshot array with 60 ticks [windowStartMs - 60s .. windowStartMs - 1s], avg = 95_029.5
    const snapshotItems = Array.from({ length: 60 }, (_, idx) => ({
      symbol: 'btc/usd',
      value: 95_000 + idx,
      // Mix second-precision and ms-precision timestamps
      timestamp:
        idx % 2 === 0
          ? Math.floor((windowStartMs - 60_000 + idx * 1_000) / 1_000)
          : windowStartMs - 60_000 + idx * 1_000,
    }))
    rtdsSocket.emitMessage({
      topic: 'crypto_prices_chainlink',
      payload: {
        symbol: 'btc/usd',
        data: snapshotItems,
      },
    })

    // Non-BTC symbol and non-chainlink topic must be ignored
    rtdsSocket.emitMessage({
      topic: 'crypto_prices_chainlink',
      payload: { symbol: 'eth/usd', value: 3_500, timestamp: windowStartMs },
    })
    rtdsSocket.emitMessage({
      topic: 'comments',
      payload: { symbol: 'btc/usd', value: 1, timestamp: windowStartMs },
    })

    const expectedS0 = 95_029.5
    expect(service.getWindowOpenTwap(windowStartMs)).toBeCloseTo(expectedS0, 9)

    // Ingest 60 live ticks [windowStartMs + 1s .. windowStartMs + 60s] at 96_000..96_059
    const liveMs = windowStartMs + 61_000
    for (let i = 1; i <= 60; i += 1) {
      const ts = windowStartMs + i * 1_000
      clock = ts
      rtdsSocket.emitMessage({
        topic: 'crypto_prices_chainlink',
        payload: {
          symbol: 'BTC/USD',
          price: 96_000 + (i - 1),
          timestamp: ts,
        },
      })
    }

    const expectedSt = 96_029.5
    const liveTwap = service.getTwapAt(liveMs, 60_000)
    expect(liveTwap).not.toBeNull()
    expect(liveTwap!.sampleCount).toBe(60)
    expect(liveTwap!.ageMs).toBe(1_000)
    expect(liveTwap!.twap).toBeCloseTo(expectedSt, 9)

    const snapshot = service.getSnapshot(liveMs)
    expect(snapshot.chainlinkPrice).toBe(96_059)
    expect(snapshot.chainlinkTwap60s).toBeCloseTo(expectedSt, 9)
    expect(snapshot.chainlinkStaleMs).toBe(1_000)
    // S0 remains pinned cleanly from the 24h buffer
    expect(service.getWindowOpenTwap(windowStartMs)).toBeCloseTo(expectedS0, 9)
  })

  it('retains >= 24h of Chainlink ticks and prunes ticks older than 24h + 2m', () => {
    const startMs = 1_700_000_000_000
    const service = new OracleFeedService({
      nowMs: () => startMs,
      fetchImpl: noopFetch,
    })
    services.push(service)

    // Feed 25 hours of ticks at 30s spacing (3,001 ticks)
    const totalMinutes = 25 * 60
    for (let m = 0; m <= totalMinutes; m += 0.5) {
      const ts = startMs + m * 60_000
      expect(service.ingestChainlinkTick(90_000 + m, ts)).toBe(true)
    }

    const latestMs = startMs + totalMinutes * 60_000
    // 23h ago must still be available
    const twap23hAgo = service.getTwapAt(latestMs - 23 * 3_600_000, 60_000)
    expect(twap23hAgo).not.toBeNull()
    expect(twap23hAgo!.sampleCount).toBeGreaterThanOrEqual(2)

    // 24h + 5m ago must have been pruned
    const twapExpired = service.getTwapAt(
      latestMs - (24 * 3_600_000 + 5 * 60_000),
      60_000,
    )
    expect(twapExpired).toBeNull()
  })

  it('tolerates 2s upstream gaps, reconnects on >12s silent RTDS without losing buffer, and rejects >15s stale open TWAP', async () => {
    vi.useFakeTimers()
    const baseMs = 1_700_000_000_000
    vi.setSystemTime(baseMs)

    const sockets: FakeWebSocket[] = []
    const service = new OracleFeedService({
      nowMs: () => Date.now(),
      random: () => 0.5, // zero jitter skew -> exact 1_000ms first backoff
      fetchImpl: noopFetch,
      wsFactory: (url) => {
        const ws = new FakeWebSocket(url)
        sockets.push(ws)
        return ws
      },
    })
    services.push(service)

    await service.start()
    const rtds1 = sockets.find((s) =>
      s.url.includes('ws-live-data.polymarket.com'),
    )!
    rtds1.emitOpen()

    // Ingest ticks with a 2s gap: 57s, 58s, 60s
    vi.setSystemTime(baseMs + 57_000)
    rtds1.emitMessage({
      topic: 'crypto_prices_chainlink',
      payload: { symbol: 'btc/usd', value: 94_000, timestamp: baseMs + 57_000 },
    })
    vi.setSystemTime(baseMs + 58_000)
    rtds1.emitMessage({
      topic: 'crypto_prices_chainlink',
      payload: { symbol: 'btc/usd', value: 94_100, timestamp: baseMs + 58_000 },
    })
    vi.setSystemTime(baseMs + 60_000)
    rtds1.emitMessage({
      topic: 'crypto_prices_chainlink',
      payload: { symbol: 'btc/usd', value: 94_300, timestamp: baseMs + 60_000 },
    })

    // 2s gap after 58_000 gives weight 2s to 94_100; 1s to 94_000; 1s terminal to 94_300
    const twapAt60 = service.getTwapAt(baseMs + 60_000, 60_000)
    expect(twapAt60).not.toBeNull()
    expect(twapAt60!.twap).toBeCloseTo(
      (94_000 * 1_000 + 94_100 * 2_000 + 94_300 * 1_000) / 4_000,
      9,
    )
    expect(service.getSnapshot(baseMs + 60_000).chainlinkStaleMs).toBe(0)
    expect(service.getSnapshot(baseMs + 62_000).chainlinkStaleMs).toBe(2_000)

    // Advance 13_000ms silently (> 12s RTDS silent timeout)
    await vi.advanceTimersByTimeAsync(13_000)
    expect(rtds1.closed).toBe(true)
    expect(service.getSnapshot().connectedRtds).toBe(false)

    // Advance 1_000ms for bounded reconnect backoff
    await vi.advanceTimersByTimeAsync(1_000)
    const rtdsSockets = sockets.filter((s) =>
      s.url.includes('ws-live-data.polymarket.com'),
    )
    expect(rtdsSockets).toHaveLength(2)
    const rtds2 = rtdsSockets[1]
    rtds2.emitOpen()

    expect(service.getSnapshot().connectedRtds).toBe(true)
    expect(rtds2.sentFrames).toHaveLength(1)
    expect(JSON.parse(rtds2.sentFrames[0])).toMatchObject({
      action: 'subscribe',
    })
    // Prior ticks remain buffered across reconnect
    expect(service.getChainlinkTickCount()).toBe(3)

    // > 15s since last tick -> stale oracle must fail closed for getWindowOpenTwap
    const staleNow = baseMs + 76_000
    const staleSnap = service.getSnapshot(staleNow)
    expect(staleSnap.chainlinkStaleMs).toBe(16_000)
    expect(staleSnap.binanceStaleMs).toBe(Number.POSITIVE_INFINITY)
    expect(service.getWindowOpenTwap(staleNow)).toBeNull()
  })

  it('downsamples Binance aggTrade to 1s bars, bootstraps closed 1m klines, and degrades gracefully on REST failure', async () => {
    const baseMin = Math.floor(1_700_000_000_000 / 60_000) * 60_000
    const now = baseMin + 499 * 60_000 + 15_000 // 15s into minute 499
    const sockets: FakeWebSocket[] = []

    const klineRows = Array.from({ length: 500 }, (_, idx) => {
      const openTime = baseMin + idx * 60_000
      const closeTime = openTime + 59_999
      const close = 95_000 + Math.sin(idx / 5) * 40
      return [
        openTime,
        String(close - 5),
        String(close + 10),
        String(close - 10),
        String(close),
        '12.5',
        closeTime,
      ]
    })

    const fetchMock: FetchLike = async (url) => {
      expect(url).toContain('/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=500')
      return {
        ok: true,
        status: 200,
        json: async () => klineRows,
      }
    }

    const service = new OracleFeedService({
      nowMs: () => now,
      fetchImpl: fetchMock,
      wsFactory: (url) => {
        const ws = new FakeWebSocket(url)
        sockets.push(ws)
        return ws
      },
    })
    services.push(service)

    await service.start()

    // 499 closed bars + 1 forming bar skipped
    expect(service.getOneMinuteBarCount()).toBe(499)
    expect(service.getSnapshot(now).sigma1m).not.toBeNull()
    expect(service.getSnapshot(now).median24hSigma1m).not.toBeNull()

    const binanceWs = sockets.find((s) => s.url.includes('btcusdt@aggTrade'))!
    binanceWs.emitOpen()

    // Multiple trades inside the same 1s bucket overwrite the 1s bar
    const bucketBase = baseMin + 499 * 60_000
    binanceWs.emitMessage({ p: '95100.5', T: bucketBase + 100 })
    binanceWs.emitMessage({ p: '95120.0', T: bucketBase + 400 })
    binanceWs.emitMessage({ p: '95135.25', T: bucketBase + 900 })

    expect(service.getOneSecondBarCount()).toBe(1)
    expect(service.getSnapshot(now).binancePrice).toBe(95_135.25)

    // Verify failed REST bootstrap degrades cleanly to null sigma without throwing
    const failingService = new OracleFeedService({
      nowMs: () => now,
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      }),
      wsFactory: (url) => new FakeWebSocket(url),
    })
    services.push(failingService)

    await expect(failingService.start()).resolves.toBeUndefined()
    expect(failingService.getOneMinuteBarCount()).toBe(0)
    expect(failingService.getSnapshot(now).sigma1m).toBeNull()
  })

  it('enforces the 0.35 * median24hSigma1m volatility floor when recent 60m volatility collapses', () => {
    const startMin = 1_700_000_040_000 // aligned to 60_000ms
    const now = startMin + 240 * 60_000 + 10_000

    const service = new OracleFeedService({
      nowMs: () => now,
      fetchImpl: noopFetch,
    })
    services.push(service)

    // Hours 0..2 (minutes 0..179): realistic ~20 bps alternating 1m swings
    let price = 95_000
    for (let m = 0; m < 180; m += 1) {
      const factor = m % 2 === 0 ? 1.002 : 0.998
      price = price * factor
      service.ingestBinanceTrade(price, startMin + m * 60_000 + 5_000)
    }

    // Final 60 closed minutes (180..239): completely flat
    for (let m = 180; m < 240; m += 1) {
      service.ingestBinanceTrade(price, startMin + m * 60_000 + 5_000)
    }

    const snap = service.getSnapshot(now)
    expect(snap.median24hSigma1m).not.toBeNull()
    expect(snap.median24hSigma1m!).toBeGreaterThan(0.001)
    expect(snap.sigma1m).not.toBeNull()
    expect(snap.sigma1m!).toBeCloseTo(0.35 * snap.median24hSigma1m!, 12)
  })

  it('computes basisBps between Chainlink TWAP and Binance price and manages singleton lifecycle', async () => {
    const now = 1_700_000_060_000
    const service = resetOracleFeed({
      nowMs: () => now,
      fetchImpl: noopFetch,
      wsFactory: (url) => new FakeWebSocket(url),
    })
    services.push(service)

    expect(getOracleFeed()).toBe(service)

    for (let i = 0; i < 60; i += 1) {
      service.ingestChainlinkTick(95_000, now - (59 - i) * 1_000)
    }
    service.ingestBinanceTrade(95_237.5, now)

    const snap = service.getSnapshot(now)
    const expectedBasisBps =
      (Math.abs(95_000 - 95_237.5) / 95_237.5) * 10_000
    expect(snap.chainlinkTwap60s).toBeCloseTo(95_000, 9)
    expect(snap.basisBps).toBeCloseTo(expectedBasisBps, 9)

    await service.start()
    expect(getOracleFeed()).toBe(service)

    const nextService = resetOracleFeed({
      nowMs: () => now,
      fetchImpl: noopFetch,
    })
    services.push(nextService)
    expect(getOracleFeed()).toBe(nextService)
    expect(nextService).not.toBe(service)
    expect(nextService.getSnapshot(now).chainlinkPrice).toBeNull()
  })

  it('rejects invalid inputs, handles out-of-order ticks, and reconnects silent Binance WS without losing bars', async () => {
    vi.useFakeTimers()
    const baseMs = 1_700_000_040_000
    vi.setSystemTime(baseMs)

    const sockets: FakeWebSocket[] = []
    const service = new OracleFeedService({
      nowMs: () => Date.now(),
      random: () => 0.5,
      fetchImpl: noopFetch,
      wsFactory: (url) => {
        const ws = new FakeWebSocket(url)
        sockets.push(ws)
        return ws
      },
    })
    services.push(service)

    expect(service.ingestChainlinkTick(0, baseMs)).toBe(false)
    expect(service.ingestChainlinkTick(Number.NaN, baseMs)).toBe(false)
    expect(service.ingestChainlinkTick(95_000, -1)).toBe(false)
    expect(service.ingestBinanceTrade(-10, baseMs)).toBe(false)

    // Out-of-order Chainlink ticks must still sort chronologically
    expect(service.ingestChainlinkTick(95_200, baseMs + 2_000)).toBe(true)
    expect(service.ingestChainlinkTick(95_000, baseMs)).toBe(true)
    expect(service.ingestChainlinkTick(95_100, baseMs + 1_000)).toBe(true)
    const twap = service.getTwapAt(baseMs + 3_000, 60_000)
    expect(twap).not.toBeNull()
    expect(twap!.sampleCount).toBe(3)
    expect(twap!.twap).toBeCloseTo((95_000 + 95_100 + 95_200) / 3, 9)

    await service.start()
    const binance1 = sockets.find((s) => s.url.includes('btcusdt@aggTrade'))!
    binance1.emitOpen()
    binance1.emitMessage({ p: '95250', T: baseMs + 3_000 })
    expect(service.getOneSecondBarCount()).toBe(1)
    expect(service.getOneMinuteBarCount()).toBe(1)

    // Advance 31s silently (> 30s Binance silent timeout) + 1s reconnect backoff
    await vi.advanceTimersByTimeAsync(31_000)
    expect(binance1.closed).toBe(true)
    expect(service.getSnapshot().connectedBinance).toBe(false)

    await vi.advanceTimersByTimeAsync(1_000)
    const binanceSockets = sockets.filter((s) =>
      s.url.includes('btcusdt@aggTrade'),
    )
    expect(binanceSockets).toHaveLength(2)
    binanceSockets[1].emitOpen()
    expect(service.getSnapshot().connectedBinance).toBe(true)
    expect(service.getOneSecondBarCount()).toBe(1)
    expect(service.getOneMinuteBarCount()).toBe(1)
  })

  it('ignores out-of-order intra-minute and intra-second Binance trades when computing bars and sigma1m', () => {
    const min0 = Math.floor(1_700_000_040_000 / 60_000) * 60_000
    const min1 = min0 + 60_000
    const min2 = min0 + 120_000
    const now = min2 + 60_000 + 5_000

    const service = new OracleFeedService({
      nowMs: () => now,
      fetchImpl: noopFetch,
    })
    services.push(service)

    // Newer trade in min0 arrives first, then an older out-of-order trade in min0
    expect(service.ingestBinanceTrade(95_500, min0 + 20_900)).toBe(true)
    expect(service.ingestBinanceTrade(94_500, min0 + 20_100)).toBe(true)
    expect(service.ingestBinanceTrade(94_200, min0 + 10_000)).toBe(true)

    // Subsequent closed minutes also close at 95_500 -> zero realized return variance
    expect(service.ingestBinanceTrade(95_500, min1 + 5_000)).toBe(true)
    expect(service.ingestBinanceTrade(95_500, min2 + 5_000)).toBe(true)

    const snap = service.getSnapshot(now)
    expect(snap.binancePrice).toBe(95_500)
    expect(snap.sigma1m).toBe(0)
  })

  it('deduplicates concurrent start() calls so callers await the active kline bootstrap', async () => {
    const baseMin = Math.floor(1_700_000_000_000 / 60_000) * 60_000
    const now = baseMin + 3 * 60_000 + 5_000
    let fetchCalls = 0
    let resolveKlines!: (res: {
      ok: boolean
      status: number
      json: () => Promise<unknown>
    }) => void

    const sockets: FakeWebSocket[] = []
    const service = new OracleFeedService({
      nowMs: () => now,
      wsFactory: (url) => {
        const ws = new FakeWebSocket(url)
        sockets.push(ws)
        return ws
      },
      fetchImpl: () => {
        fetchCalls += 1
        return new Promise((resolve) => {
          resolveKlines = resolve
        })
      },
    })
    services.push(service)

    let firstResolved = false
    let secondResolved = false
    const p1 = service.start().then(() => {
      firstResolved = true
    })
    const p2 = service.start().then(() => {
      secondResolved = true
    })

    await Promise.resolve()
    expect(fetchCalls).toBe(1)
    expect(sockets).toHaveLength(2)
    expect(firstResolved).toBe(false)
    expect(secondResolved).toBe(false)

    resolveKlines({
      ok: true,
      status: 200,
      json: async () => [
        [baseMin, '95000', '95100', '94900', '95010', '10', baseMin + 59_999],
        [
          baseMin + 60_000,
          '95010',
          '95120',
          '94980',
          '95050',
          '10',
          baseMin + 119_999,
        ],
        [
          baseMin + 120_000,
          '95050',
          '95150',
          '95000',
          '95090',
          '10',
          baseMin + 179_999,
        ],
      ],
    })

    await Promise.all([p1, p2])
    expect(firstResolved).toBe(true)
    expect(secondResolved).toBe(true)
    expect(service.getOneMinuteBarCount()).toBe(3)
    expect(service.getSnapshot(now).sigma1m).not.toBeNull()
  })
})
