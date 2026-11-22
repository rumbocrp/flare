import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  runWindowReplay,
  type CollectedWindowReplayInput,
} from '../../prediction/replayHarness'
import type { PolymarketSnapshot, PolymarketTimeframe, PolymarketWindow } from '../polymarketAdapter'
import { SqliteStateStore } from '../store/sqliteStore'
import type { CollectedWindowRecord } from '../store/types'
import {
  ClobBookFeedService,
  type WebSocketLike as ClobWsLike,
} from './clobBookFeed'
import { OracleFeedService } from './oracleFeed'
import {
  PredictionWindowCollector,
  type FetchPolymarketUpDownFn,
} from './windowCollector'

function createFakeClobWs(): ClobWsLike {
  return {
    readyState: 1,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send() {},
    close() {},
  }
}

function seedBinanceHistory(
  oracle: OracleFeedService,
  baseTimeMs: number,
  basePrice = 90_000,
  minutes = 10,
): void {
  for (let i = minutes; i >= 1; i -= 1) {
    const t = baseTimeMs - i * 60_000
    const delta = (i % 2 === 0 ? 1 : -1) * 35
    oracle.ingestBinanceTrade(basePrice + delta, t)
  }
}

function pushBookMessage(
  clob: ClobBookFeedService,
  assetId: string,
  bestBid: number,
  bestAsk: number,
  size: number,
  nowMs: number,
): void {
  clob.ingestWsMessage(
    JSON.stringify({
      event_type: 'book',
      asset_id: assetId,
      bids: [{ price: String(bestBid), size: String(size) }],
      asks: [{ price: String(bestAsk), size: String(size) }],
    }),
    nowMs,
  )
}

function toReplayInput(
  win: CollectedWindowRecord,
  snapshots: CollectedWindowReplayInput['snapshots'],
): CollectedWindowReplayInput {
  return {
    slug: win.slug,
    timeframe: win.timeframe,
    conditionId: win.conditionId ?? undefined,
    upTokenId: win.upTokenId ?? undefined,
    downTokenId: win.downTokenId ?? undefined,
    resolutionSource: win.resolutionSource,
    startTimeMs: win.startTimeMs,
    endTimeMs: win.endTimeMs,
    openTwap: win.openTwap,
    closeTwap: win.closeTwap,
    resolvedUp: win.resolvedUp,
    tickSize: win.tickSize ?? undefined,
    negRisk: win.negRisk,
    volumeUsd: win.volumeUsd,
    updatedAt: win.updatedAt,
    snapshots,
  }
}

describe('PredictionWindowCollector (Ticket 04)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('captures S0, enforces 10s -> 2s (final 180s) snapshot cadence, waits for closed resolution, and updates settlement', async () => {
    const startMs = 1_760_000_100_000 // exact multiple of 300s
    const endMs = startMs + 300_000 // 5m window
    let now = startMs

    const store = new SqliteStateStore(':memory:')
    await store.migrate()
    const oracle = new OracleFeedService({ nowMs: () => now })
    const clob = new ClobBookFeedService({
      nowMs: () => now,
      wsFactory: () => createFakeClobWs(),
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
      }),
    })

    try {
      seedBinanceHistory(oracle, startMs, 90_000, 12)
      oracle.ingestChainlinkTick(90_000, startMs - 20_000)
      oracle.ingestChainlinkTick(90_000, startMs)

      let marketStatus: 'open' | 'closed' = 'open'
      let resolvedUp: boolean | null = null

      const mockDiscovery: FetchPolymarketUpDownFn = async (tf) => ({
        source: 'polymarket',
        timeframe: tf,
        fetchedAt: new Date(now).toISOString(),
        windows:
          tf === '5m'
            ? [
                {
                  slug: 'btc-updown-5m-1',
                  timeframe: '5m',
                  startTime: startMs,
                  endTime: endMs,
                  status: marketStatus,
                  question: 'BTC Up or Down?',
                  upPriceAtOpen: 0.5,
                  upPriceNow: 0.55,
                  bestBid: 0.54,
                  bestAsk: 0.56,
                  resolvedUp,
                  volume: 2_500,
                  resolutionSource: 'chainlink-twap-60s',
                  conditionId: 'cond-5m-1',
                  upTokenId: 'tok-up-5m-1',
                  downTokenId: 'tok-down-5m-1',
                  tickSize: 0.01,
                  negRisk: false,
                },
              ]
            : [],
        errors: [],
      })

      const collector = new PredictionWindowCollector({
        store,
        oracleFeed: oracle,
        clobBookFeed: clob,
        fetchPolymarketUpDown: mockDiscovery,
        timeframes: ['5m'],
        nowMs: () => now,
      })

      // T = startMs (300s remaining): initial discovery + S0 pin + snapshot #1
      pushBookMessage(clob, 'tok-up-5m-1', 0.52, 0.54, 500, now)
      pushBookMessage(clob, 'tok-down-5m-1', 0.46, 0.48, 500, now)
      const s1 = await collector.runPollCycle(now)
      expect(s1.activeSlugs).toEqual(['btc-updown-5m-1'])
      expect(s1.lastCaptureAtMs).toBe(now)

      // T + 5s (295s remaining): <10s interval -> skipped
      now = startMs + 5_000
      oracle.ingestChainlinkTick(90_040, now)
      pushBookMessage(clob, 'tok-up-5m-1', 0.54, 0.56, 500, now)
      pushBookMessage(clob, 'tok-down-5m-1', 0.44, 0.46, 500, now)
      const s2 = await collector.runPollCycle(now)
      expect(s2.lastCaptureAtMs).toBe(startMs)
      expect(await store.getPredictionSnapshots('btc-updown-5m-1')).toHaveLength(1)

      // T + 10s (290s remaining): >=10s -> snapshot #2
      now = startMs + 10_000
      oracle.ingestChainlinkTick(90_060, now)
      oracle.ingestBinanceTrade(90_070, now)
      pushBookMessage(clob, 'tok-up-5m-1', 0.56, 0.58, 600, now)
      pushBookMessage(clob, 'tok-down-5m-1', 0.42, 0.44, 600, now)
      await collector.runPollCycle(now)
      expect(await store.getPredictionSnapshots('btc-updown-5m-1')).toHaveLength(2)

      // Enter final 180s: T = endMs - 180_000 -> snapshot #3, then T + 2s -> snapshot #4
      now = endMs - 180_000
      oracle.ingestChainlinkTick(90_090, now)
      oracle.ingestBinanceTrade(90_095, now)
      pushBookMessage(clob, 'tok-up-5m-1', 0.64, 0.66, 700, now)
      pushBookMessage(clob, 'tok-down-5m-1', 0.34, 0.36, 700, now)
      await collector.runPollCycle(now)

      now = endMs - 178_000
      oracle.ingestChainlinkTick(90_100, now)
      pushBookMessage(clob, 'tok-up-5m-1', 0.65, 0.67, 700, now)
      pushBookMessage(clob, 'tok-down-5m-1', 0.33, 0.35, 700, now)
      await collector.runPollCycle(now)

      const snaps = await store.getPredictionSnapshots('btc-updown-5m-1')
      expect(snaps).toHaveLength(4)
      expect(snaps[3].secondsRemaining).toBe(178)
      expect(snaps[3].yesBid).toBe(0.65)
      expect(snaps[3].yesAsk).toBe(0.67)
      expect(snaps[3].yesDepthUsd).toBeGreaterThan(0)
      expect(snaps[3].pModelYes).not.toBeNull()
      expect(snaps[3].pModelYes!).toBeGreaterThan(0.5)

      // Window ends: Gamma marks closed=true but resolvedUp=null initially -> stays unsettled
      now = endMs + 2_000
      oracle.ingestChainlinkTick(90_150, endMs)
      marketStatus = 'closed'
      resolvedUp = null
      const pendingStats = await collector.runPollCycle(now)
      expect(pendingStats.settledCountsByTimeframe['5m']).toBe(0)
      expect(pendingStats.activeSlugs).toEqual([])

      // Gamma finalizes resolvedUp=true
      now = endMs + 10_000
      resolvedUp = true
      const settledStats = await collector.runPollCycle(now)
      expect(settledStats.settledCountsByTimeframe['5m']).toBe(1)

      const persisted = await store.getPredictionWindows({
        slug: 'btc-updown-5m-1',
      })
      expect(persisted).toHaveLength(1)
      expect(persisted[0].openTwap).toBe(90_000)
      expect(persisted[0].closeTwap).not.toBeNull()
      expect(persisted[0].resolvedUp).toBe(true)
    } finally {
      clob.close()
      await store.close()
    }
  })

  it('handles 5m/15m/1h timeframes, resolutionSource mapping, null fields, and skips missing placeholders', async () => {
    const now = 1_760_000_000_000
    const store = new SqliteStateStore(':memory:')
    await store.migrate()
    const oracle = new OracleFeedService({ nowMs: () => now })
    const clob = new ClobBookFeedService({
      nowMs: () => now,
      wsFactory: () => createFakeClobWs(),
    })

    try {
      const windowsByTf: Record<PolymarketTimeframe, PolymarketWindow[]> = {
        '5m': [
          {
            slug: 'btc-5m-missing',
            timeframe: '5m',
            startTime: now - 60_000,
            endTime: now + 240_000,
            status: 'missing',
            question: null,
            upPriceAtOpen: null,
            upPriceNow: null,
            bestBid: null,
            bestAsk: null,
            resolvedUp: null,
            volume: 0,
          },
          {
            slug: 'btc-5m-ok',
            timeframe: '5m',
            startTime: now - 60_000,
            endTime: now + 240_000,
            status: 'open',
            question: '5m',
            upPriceAtOpen: 0.5,
            upPriceNow: 0.5,
            bestBid: 0.49,
            bestAsk: 0.51,
            resolvedUp: null,
            volume: 100,
            resolutionSource: 'chainlink-twap-60s',
            conditionId: null,
            tickSize: null,
          },
        ],
        '15m': [
          {
            slug: 'btc-15m-unknown',
            timeframe: '15m',
            startTime: now - 60_000,
            endTime: now + 840_000,
            status: 'open',
            question: '15m',
            upPriceAtOpen: 0.5,
            upPriceNow: 0.5,
            bestBid: null,
            bestAsk: null,
            resolvedUp: null,
            volume: Number.NaN,
          },
        ],
        '1h': [
          {
            slug: 'btc-1h-binance',
            timeframe: '1h',
            startTime: now - 60_000,
            endTime: now + 3_540_000,
            status: 'open',
            question: '1h',
            upPriceAtOpen: 0.5,
            upPriceNow: 0.5,
            bestBid: 0.48,
            bestAsk: 0.52,
            resolvedUp: null,
            volume: 5_000,
            resolutionSource: 'binance-1h-candle',
            conditionId: 'cond-1h',
            upTokenId: 'up-1h',
            downTokenId: 'down-1h',
            tickSize: 0.01,
            negRisk: true,
          },
        ],
      }

      const collector = new PredictionWindowCollector({
        store,
        oracleFeed: oracle,
        clobBookFeed: clob,
        fetchPolymarketUpDown: async (tf) => ({
          source: 'polymarket',
          timeframe: tf,
          fetchedAt: new Date(now).toISOString(),
          windows: windowsByTf[tf],
          errors: [],
        }),
        nowMs: () => now,
      })

      const stats = await collector.runPollCycle(now)
      expect(stats.activeSlugs).toEqual([
        'btc-15m-unknown',
        'btc-1h-binance',
        'btc-5m-ok',
      ])

      const all = await store.getPredictionWindows({ order: 'asc' })
      expect(all).toHaveLength(3)
      expect(all.find((w) => w.slug === 'btc-5m-missing')).toBeUndefined()

      const w15 = all.find((w) => w.slug === 'btc-15m-unknown')!
      expect(w15.resolutionSource).toBe('unknown')
      expect(w15.conditionId).toBeNull()
      expect(w15.tickSize).toBeNull()
      expect(w15.volumeUsd).toBeNull()

      const w1h = all.find((w) => w.slug === 'btc-1h-binance')!
      expect(w1h.resolutionSource).toBe('binance-1h-candle')
      expect(w1h.negRisk).toBe(true)
    } finally {
      clob.close()
      await store.close()
    }
  })

  it('deduplicates snapshots at identical timestamps and preserves pinned S0 & settled counts across restart', async () => {
    const startMs = 1_760_000_000_000
    const endMs = startMs + 300_000
    let now = startMs

    const store = new SqliteStateStore(':memory:')
    await store.migrate()
    const oracle1 = new OracleFeedService({ nowMs: () => now })
    const clob1 = new ClobBookFeedService({
      nowMs: () => now,
      wsFactory: () => createFakeClobWs(),
    })

    try {
      oracle1.ingestChainlinkTick(91_000, startMs)
      await store.upsertPredictionWindow({
        slug: 'btc-5m-prev-settled',
        timeframe: '5m',
        conditionId: null,
        upTokenId: null,
        downTokenId: null,
        resolutionSource: 'chainlink-twap-60s',
        startTimeMs: startMs - 300_000,
        endTimeMs: startMs,
        openTwap: 90_900,
        closeTwap: 91_000,
        resolvedUp: true,
        tickSize: 0.01,
        negRisk: false,
        volumeUsd: 1_000,
        updatedAt: startMs,
      })

      const openWin: PolymarketWindow = {
        slug: 'btc-5m-live',
        timeframe: '5m',
        startTime: startMs,
        endTime: endMs,
        status: 'open',
        question: 'Live',
        upPriceAtOpen: 0.5,
        upPriceNow: 0.5,
        bestBid: 0.49,
        bestAsk: 0.51,
        resolvedUp: null,
        volume: 1_200,
        resolutionSource: 'chainlink-twap-60s',
      }

      const collector1 = new PredictionWindowCollector({
        store,
        oracleFeed: oracle1,
        clobBookFeed: clob1,
        timeframes: ['5m'],
        fetchPolymarketUpDown: async (tf) => ({
          source: 'polymarket',
          timeframe: tf,
          fetchedAt: new Date(now).toISOString(),
          windows: tf === '5m' ? [openWin] : [],
          errors: [],
        }),
        nowMs: () => now,
      })

      await collector1.runPollCycle(now)
      // Repeated poll at identical timestamp must not throw or duplicate snapshot
      await collector1.runPollCycle(now)
      expect(await store.getPredictionSnapshots('btc-5m-live')).toHaveLength(1)

      // Simulated process restart: fresh OracleFeedService with NO T_open ticks!
      now = startMs + 60_000
      const oracle2 = new OracleFeedService({ nowMs: () => now })
      const clob2 = new ClobBookFeedService({
        nowMs: () => now,
        wsFactory: () => createFakeClobWs(),
      })
      try {
        const collector2 = new PredictionWindowCollector({
          store,
          oracleFeed: oracle2,
          clobBookFeed: clob2,
          timeframes: ['5m'],
          fetchPolymarketUpDown: async (tf) => ({
            source: 'polymarket',
            timeframe: tf,
            fetchedAt: new Date(now).toISOString(),
            windows: tf === '5m' ? [openWin] : [],
            errors: [],
          }),
          nowMs: () => now,
        })

        const stats2 = await collector2.runPollCycle(now)
        expect(stats2.settledCountsByTimeframe['5m']).toBe(1)

        const records = await store.getPredictionWindows({ slug: 'btc-5m-live' })
        expect(records[0].openTwap).toBe(91_000)
      } finally {
        clob2.close()
      }
    } finally {
      clob1.close()
      await store.close()
    }
  })

  it('persists null instead of synthetic fallback prices when oracle or CLOB book is missing or stale', async () => {
    const startMs = 1_760_000_000_000
    const endMs = startMs + 300_000
    let now = startMs

    const store = new SqliteStateStore(':memory:')
    await store.migrate()
    const oracle = new OracleFeedService({ nowMs: () => now })
    const clob = new ClobBookFeedService({
      nowMs: () => now,
      wsFactory: () => createFakeClobWs(),
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
      }),
    })

    try {
      // Seed stale CLOB book at T - 20s (> 10s stale threshold)
      pushBookMessage(clob, 'tok-up-stale', 0.45, 0.47, 300, startMs - 20_000)
      pushBookMessage(clob, 'tok-down-stale', 0.53, 0.55, 300, startMs - 20_000)

      const collector = new PredictionWindowCollector({
        store,
        oracleFeed: oracle,
        clobBookFeed: clob,
        timeframes: ['5m'],
        fetchPolymarketUpDown: async (tf) => ({
          source: 'polymarket',
          timeframe: tf,
          fetchedAt: new Date(now).toISOString(),
          windows:
            tf === '5m'
              ? [
                  {
                    slug: 'btc-5m-no-feeds',
                    timeframe: '5m',
                    startTime: startMs,
                    endTime: endMs,
                    status: 'open',
                    question: 'No feeds',
                    upPriceAtOpen: 0.5,
                    upPriceNow: 0.5,
                    bestBid: 0.49,
                    bestAsk: 0.51,
                    resolvedUp: null,
                    volume: 100,
                    upTokenId: 'tok-up-stale',
                    downTokenId: 'tok-down-stale',
                  },
                ]
              : [],
          errors: [],
        }),
        nowMs: () => now,
      })

      now = startMs + 5_000
      await collector.runPollCycle(now)

      const snaps = await store.getPredictionSnapshots('btc-5m-no-feeds')
      expect(snaps).toHaveLength(1)
      expect(snaps[0].twapPrice).toBeNull()
      expect(snaps[0].binancePrice).toBeNull()
      expect(snaps[0].sigma1m).toBeNull()
      expect(snaps[0].yesBid).toBeNull()
      expect(snaps[0].yesAsk).toBeNull()
      expect(snaps[0].yesDepthUsd).toBeNull()
      expect(snaps[0].noBid).toBeNull()
      expect(snaps[0].noAsk).toBeNull()
      expect(snaps[0].noDepthUsd).toBeNull()
      expect(snaps[0].pModelYes).toBeNull()
    } finally {
      clob.close()
      await store.close()
    }
  })

  it('tracks discovery exceptions and snapshot.errors while keeping other timeframes operational', async () => {
    const now = 1_760_000_000_000
    const store = new SqliteStateStore(':memory:')
    await store.migrate()
    const oracle = new OracleFeedService({ nowMs: () => now })
    const clob = new ClobBookFeedService({
      nowMs: () => now,
      wsFactory: () => createFakeClobWs(),
    })

    try {
      const collector = new PredictionWindowCollector({
        store,
        oracleFeed: oracle,
        clobBookFeed: clob,
        fetchPolymarketUpDown: async (tf): Promise<PolymarketSnapshot> => {
          if (tf === '5m') {
            throw new Error('5m network timeout')
          }
          if (tf === '15m') {
            return {
              source: 'polymarket',
              timeframe: '15m',
              fetchedAt: new Date(now).toISOString(),
              windows: [],
              errors: ['HTTP 503 on gamma'],
            }
          }
          return {
            source: 'polymarket',
            timeframe: '1h',
            fetchedAt: new Date(now).toISOString(),
            windows: [
              {
                slug: 'btc-1h-healthy',
                timeframe: '1h',
                startTime: now - 60_000,
                endTime: now + 3_540_000,
                status: 'open',
                question: '1h healthy',
                upPriceAtOpen: 0.5,
                upPriceNow: 0.52,
                bestBid: 0.51,
                bestAsk: 0.53,
                resolvedUp: null,
                volume: 500,
                resolutionSource: 'binance-1h-candle',
              },
            ],
            errors: [],
          }
        },
        nowMs: () => now,
      })

      const stats = await collector.runPollCycle(now)
      expect(stats.errorCount).toBe(2)
      expect(stats.lastError).toContain('HTTP 503 on gamma')
      expect(stats.activeSlugs).toEqual(['btc-1h-healthy'])
    } finally {
      clob.close()
      await store.close()
    }
  })

  it('manages start()/stop() timer lifecycle cleanly without closing injected dependencies', async () => {
    vi.useFakeTimers()
    const now = 1_760_000_000_000
    vi.setSystemTime(now)

    const store = new SqliteStateStore(':memory:')
    await store.migrate()
    const oracle = new OracleFeedService({ nowMs: () => Date.now() })
    const clob = new ClobBookFeedService({
      nowMs: () => Date.now(),
      wsFactory: () => createFakeClobWs(),
    })

    let pollCount = 0
    try {
      const collector = new PredictionWindowCollector({
        store,
        oracleFeed: oracle,
        clobBookFeed: clob,
        pollIntervalMs: 2_000,
        discoveryIntervalMs: 2_000,
        timeframes: ['5m'],
        fetchPolymarketUpDown: async (tf) => {
          pollCount += 1
          return {
            source: 'polymarket',
            timeframe: tf,
            fetchedAt: new Date(Date.now()).toISOString(),
            windows: [],
            errors: [],
          }
        },
      })

      collector.start()
      expect(collector.isRunning()).toBe(true)
      await vi.advanceTimersByTimeAsync(10)
      expect(pollCount).toBe(1)

      await vi.advanceTimersByTimeAsync(2_000)
      expect(pollCount).toBe(2)

      collector.stop()
      expect(collector.isRunning()).toBe(false)

      await vi.advanceTimersByTimeAsync(6_000)
      expect(pollCount).toBe(2)

      // Injected store remains open and usable after collector.stop()
      expect(await store.getSchemaVersion()).toBe(5)
    } finally {
      clob.close()
      await store.close()
    }
  })

  it('produces persisted settled windows & snapshots directly compatible with runWindowReplay', async () => {
    const baseStart = 1_760_000_000_000
    let now = baseStart

    const store = new SqliteStateStore(':memory:')
    await store.migrate()
    const oracle = new OracleFeedService({ nowMs: () => now })
    const clob = new ClobBookFeedService({
      nowMs: () => now,
      wsFactory: () => createFakeClobWs(),
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
      }),
    })

    try {
      seedBinanceHistory(oracle, baseStart, 90_000, 10)

      for (let i = 0; i < 4; i += 1) {
        const wStart = baseStart + i * 300_000
        const wEnd = wStart + 300_000
        const slug = `btc-updown-5m-r-${i}`
        const resolvedUp = i % 2 === 0

        let status: 'open' | 'closed' = 'open'
        let resolved: boolean | null = null

        const collector = new PredictionWindowCollector({
          store,
          oracleFeed: oracle,
          clobBookFeed: clob,
          timeframes: ['5m'],
          fetchPolymarketUpDown: async (tf) => ({
            source: 'polymarket',
            timeframe: tf,
            fetchedAt: new Date(now).toISOString(),
            windows:
              tf === '5m'
                ? [
                    {
                      slug,
                      timeframe: '5m',
                      startTime: wStart,
                      endTime: wEnd,
                      status,
                      question: slug,
                      upPriceAtOpen: 0.5,
                      upPriceNow: resolvedUp ? 0.72 : 0.28,
                      bestBid: resolvedUp ? 0.71 : 0.27,
                      bestAsk: resolvedUp ? 0.73 : 0.29,
                      resolvedUp: resolved,
                      volume: 1_500,
                      resolutionSource: 'chainlink-twap-60s',
                      upTokenId: `up-${i}`,
                      downTokenId: `down-${i}`,
                      tickSize: 0.01,
                    },
                  ]
                : [],
            errors: [],
          }),
          nowMs: () => now,
        })

        now = wStart
        oracle.ingestChainlinkTick(90_000, wStart)
        pushBookMessage(clob, `up-${i}`, 0.5, 0.52, 500, now)
        pushBookMessage(clob, `down-${i}`, 0.48, 0.5, 500, now)
        await collector.runPollCycle(now)

        // Capture a late-window snapshot inside final 180s
        now = wEnd - 60_000
        oracle.ingestChainlinkTick(resolvedUp ? 90_120 : 89_880, now)
        oracle.ingestBinanceTrade(resolvedUp ? 90_125 : 89_875, now)
        pushBookMessage(
          clob,
          `up-${i}`,
          resolvedUp ? 0.68 : 0.3,
          resolvedUp ? 0.7 : 0.32,
          500,
          now,
        )
        pushBookMessage(
          clob,
          `down-${i}`,
          resolvedUp ? 0.3 : 0.68,
          resolvedUp ? 0.32 : 0.7,
          500,
          now,
        )
        await collector.runPollCycle(now)

        // Settle
        now = wEnd + 2_000
        oracle.ingestChainlinkTick(resolvedUp ? 90_140 : 89_860, wEnd)
        status = 'closed'
        resolved = resolvedUp
        await collector.runPollCycle(now)
      }

      const settled = await store.getPredictionWindows({
        settledOnly: true,
        order: 'asc',
      })
      expect(settled).toHaveLength(4)

      const replayInputs: CollectedWindowReplayInput[] = []
      for (const win of settled) {
        const snaps = await store.getPredictionSnapshots(win.slug)
        replayInputs.push(toReplayInput(win, snaps))
      }

      const report = runWindowReplay(
        replayInputs,
        (snapshot, calibratedPYes) => {
          if (snapshot.secondsRemaining > 120) return null
          if (calibratedPYes >= 0.6 && snapshot.yesAsk !== null) {
            return {
              outcome: 'YES',
              liquidityRole: 'taker',
              stakeUsd: 5,
            }
          }
          if (calibratedPYes <= 0.4 && snapshot.noAsk !== null) {
            return {
              outcome: 'NO',
              liquidityRole: 'taker',
              stakeUsd: 5,
            }
          }
          return null
        },
        {
          strategyId: 'collector-replay-smoke',
          trainRatio: 0.5,
        },
      )

      expect(report.totalInputWindows).toBe(4)
      expect(report.settledWindowCount).toBe(4)
      expect(report.trainWindowCount).toBe(2)
      expect(report.testWindowCount).toBe(2)
      expect(report.tradeCount).toBeGreaterThanOrEqual(1)
      expect(report.eligibleForCanary).toBe(false)
    } finally {
      clob.close()
      await store.close()
    }
  })

  it('evicts expired openWindows on status=missing or omitted slug and preserves discoveryIntervalMs', async () => {
    const startMs = 1_760_000_100_000
    const endMs = startMs + 300_000
    let now = startMs

    const store = new SqliteStateStore(':memory:')
    await store.migrate()
    const oracle = new OracleFeedService({ nowMs: () => now })
    const clob = new ClobBookFeedService({
      nowMs: () => now,
      wsFactory: () => createFakeClobWs(),
    })

    try {
      let phase: 'initial' | 'aged-out' = 'initial'
      let discoveryCalls = 0

      const collector = new PredictionWindowCollector({
        store,
        oracleFeed: oracle,
        clobBookFeed: clob,
        timeframes: ['5m'],
        discoveryIntervalMs: 10_000,
        nowMs: () => now,
        fetchPolymarketUpDown: async (tf) => {
          discoveryCalls += 1
          if (phase === 'initial') {
            return {
              source: 'polymarket',
              timeframe: tf,
              fetchedAt: new Date(now).toISOString(),
              windows: [
                {
                  slug: 'btc-5m-expired-missing',
                  timeframe: '5m',
                  startTime: startMs,
                  endTime: endMs,
                  status: 'open',
                  question: 'Missing later',
                  upPriceAtOpen: 0.5,
                  upPriceNow: 0.5,
                  bestBid: 0.49,
                  bestAsk: 0.51,
                  resolvedUp: null,
                  volume: 500,
                  resolutionSource: 'chainlink-twap-60s',
                },
                {
                  slug: 'btc-5m-expired-omitted',
                  timeframe: '5m',
                  startTime: startMs,
                  endTime: endMs,
                  status: 'open',
                  question: 'Omitted later',
                  upPriceAtOpen: 0.5,
                  upPriceNow: 0.5,
                  bestBid: 0.49,
                  bestAsk: 0.51,
                  resolvedUp: null,
                  volume: 500,
                  resolutionSource: 'chainlink-twap-60s',
                },
              ],
              errors: [],
            }
          }

          return {
            source: 'polymarket',
            timeframe: tf,
            fetchedAt: new Date(now).toISOString(),
            windows: [
              // btc-5m-expired-missing returns status: 'missing'; btc-5m-expired-omitted is dropped completely
              {
                slug: 'btc-5m-expired-missing',
                timeframe: '5m',
                startTime: startMs,
                endTime: endMs,
                status: 'missing',
                question: null,
                upPriceAtOpen: null,
                upPriceNow: null,
                bestBid: null,
                bestAsk: null,
                resolvedUp: null,
                volume: 0,
              },
              {
                slug: 'btc-5m-current-active',
                timeframe: '5m',
                startTime: now - 30_000,
                endTime: now + 270_000,
                status: 'open',
                question: 'Current active',
                upPriceAtOpen: 0.5,
                upPriceNow: 0.52,
                bestBid: 0.51,
                bestAsk: 0.53,
                resolvedUp: null,
                volume: 900,
                resolutionSource: 'chainlink-twap-60s',
              },
            ],
            errors: [],
          }
        },
      })

      const s1 = await collector.runPollCycle(now)
      expect(s1.activeSlugs).toEqual([
        'btc-5m-expired-missing',
        'btc-5m-expired-omitted',
      ])
      expect(discoveryCalls).toBe(1)

      // Advance 2 hours past expiry: getCollectorStats() immediately hides expired slugs even before discovery
      now = endMs + 2 * 3_600_000
      expect(collector.getCollectorStats().activeSlugs).toEqual([])

      phase = 'aged-out'
      const s2 = await collector.runPollCycle(now)
      expect(s2.activeSlugs).toEqual(['btc-5m-current-active'])
      expect(collector.getActiveWindows(now).map((w) => w.slug)).toEqual([
        'btc-5m-current-active',
      ])
      expect(discoveryCalls).toBe(2)

      // Next 3 polls at +2s, +4s, +6s (< discoveryIntervalMs=10s) must NOT spam discovery
      for (const offsetMs of [2_000, 4_000, 6_000]) {
        now = endMs + 2 * 3_600_000 + offsetMs
        const stats = await collector.runPollCycle(now)
        expect(stats.activeSlugs).toEqual(['btc-5m-current-active'])
      }
      expect(discoveryCalls).toBe(2)

      // Once discoveryIntervalMs (10s) elapses, discovery runs normally
      now = endMs + 2 * 3_600_000 + 10_000
      await collector.runPollCycle(now)
      expect(discoveryCalls).toBe(3)
    } finally {
      clob.close()
      await store.close()
    }
  })

  it('hydrates only the stale CLOB side on asymmetric staleness, preserving fresh clob-ws books and enforcing hydrateCooldownMs', async () => {
    const startMs = 1_760_000_000_000
    const endMs = startMs + 300_000
    let now = startMs + 30_000

    const store = new SqliteStateStore(':memory:')
    await store.migrate()
    const oracle = new OracleFeedService({ nowMs: () => now })

    const hydratedUrls: string[] = []
    let failNoRest = false
    const clob = new ClobBookFeedService({
      nowMs: () => now,
      wsFactory: () => createFakeClobWs(),
      fetchImpl: async (input) => {
        const url = String(input)
        hydratedUrls.push(url)
        if (url.includes('tok-up')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              bids: [{ price: '0.51', size: '200' }],
              asks: [{ price: '0.53', size: '200' }],
            }),
          }
        }
        if (failNoRest) {
          return {
            ok: false,
            status: 404,
            json: async () => ({}),
          }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            bids: [{ price: '0.36', size: '300' }],
            asks: [{ price: '0.38', size: '300' }],
          }),
        }
      },
    })

    try {
      oracle.ingestChainlinkTick(90_000, startMs)
      oracle.ingestChainlinkTick(90_050, now)

      // YES has fresh 1s-old clob-ws book (0.60/0.62); NO is stale at 11s ago
      pushBookMessage(clob, 'tok-up', 0.6, 0.62, 500, now - 1_000)
      pushBookMessage(clob, 'tok-down', 0.38, 0.4, 500, now - 11_000)

      const collector = new PredictionWindowCollector({
        store,
        oracleFeed: oracle,
        clobBookFeed: clob,
        timeframes: ['5m'],
        bookStaleMs: 10_000,
        hydrateCooldownMs: 5_000,
        normalSnapshotIntervalMs: 2_000,
        nowMs: () => now,
        fetchPolymarketUpDown: async (tf) => ({
          source: 'polymarket',
          timeframe: tf,
          fetchedAt: new Date(now).toISOString(),
          windows:
            tf === '5m'
              ? [
                  {
                    slug: 'btc-5m-asym-clob',
                    timeframe: '5m',
                    startTime: startMs,
                    endTime: endMs,
                    status: 'open',
                    question: 'Asym',
                    upPriceAtOpen: 0.5,
                    upPriceNow: 0.61,
                    bestBid: 0.6,
                    bestAsk: 0.62,
                    resolvedUp: null,
                    volume: 1_000,
                    resolutionSource: 'chainlink-twap-60s',
                    upTokenId: 'tok-up',
                    downTokenId: 'tok-down',
                  },
                ]
              : [],
          errors: [],
        }),
      })

      await collector.runPollCycle(now)
      expect(hydratedUrls).toHaveLength(1)
      expect(hydratedUrls[0]).toContain('tok-down')
      expect(hydratedUrls[0]).not.toContain('tok-up')

      let snaps = await store.getPredictionSnapshots('btc-5m-asym-clob')
      expect(snaps).toHaveLength(1)
      expect(snaps[0].yesBid).toBe(0.6)
      expect(snaps[0].yesAsk).toBe(0.62)
      expect(snaps[0].noBid).toBe(0.36)
      expect(snaps[0].noAsk).toBe(0.38)

      // Make NO stale again and return 404 from REST to verify hydrateCooldownMs throttling
      failNoRest = true
      now += 11_000
      pushBookMessage(clob, 'tok-up', 0.61, 0.63, 500, now - 500)
      await collector.runPollCycle(now)
      expect(hydratedUrls).toHaveLength(2)

      // Within 5s cooldown (+2s): must NOT call REST /book again
      now += 2_000
      pushBookMessage(clob, 'tok-up', 0.61, 0.63, 500, now - 500)
      await collector.runPollCycle(now)
      expect(hydratedUrls).toHaveLength(2)

      // After 5s cooldown (+3s more => +5s total): calls REST /book once for tok-down
      now += 3_000
      pushBookMessage(clob, 'tok-up', 0.61, 0.63, 500, now - 500)
      await collector.runPollCycle(now)
      expect(hydratedUrls).toHaveLength(3)
      expect(hydratedUrls.every((u) => u.includes('tok-down'))).toBe(true)

      snaps = await store.getPredictionSnapshots('btc-5m-asym-clob')
      expect(snaps.at(-1)?.yesBid).toBe(0.61)
      expect(snaps.at(-1)?.noBid).toBeNull()
    } finally {
      clob.close()
      await store.close()
    }
  })

  it('coalesces concurrent runPollCycle calls and settles resolvedUp=false cleanly', async () => {
    const startMs = 1_760_000_000_000
    const endMs = startMs + 300_000
    let now = startMs

    const store = new SqliteStateStore(':memory:')
    await store.migrate()
    const oracle = new OracleFeedService({ nowMs: () => now })
    const clob = new ClobBookFeedService({
      nowMs: () => now,
      wsFactory: () => createFakeClobWs(),
    })

    try {
      oracle.ingestChainlinkTick(90_000, startMs)
      let discoveryCalls = 0
      let markDiscoveryStarted: (() => void) | null = null
      const discoveryStarted = new Promise<void>((resolve) => {
        markDiscoveryStarted = resolve
      })
      let releaseDiscovery: (() => void) | null = null
      let status: 'open' | 'closed' = 'open'
      let resolvedUp: boolean | null = null

      const collector = new PredictionWindowCollector({
        store,
        oracleFeed: oracle,
        clobBookFeed: clob,
        timeframes: ['5m'],
        nowMs: () => now,
        fetchPolymarketUpDown: async (tf) => {
          discoveryCalls += 1
          if (discoveryCalls === 1) {
            markDiscoveryStarted?.()
            await new Promise<void>((resolve) => {
              releaseDiscovery = resolve
            })
          }
          return {
            source: 'polymarket',
            timeframe: tf,
            fetchedAt: new Date(now).toISOString(),
            windows:
              tf === '5m'
                ? [
                    {
                      slug: 'btc-5m-concurrent-down',
                      timeframe: '5m',
                      startTime: startMs,
                      endTime: endMs,
                      status,
                      question: 'Concurrent & DOWN settle',
                      upPriceAtOpen: 0.5,
                      upPriceNow: 0.25,
                      bestBid: 0.24,
                      bestAsk: 0.26,
                      resolvedUp,
                      volume: 1_200,
                      resolutionSource: 'chainlink-twap-60s',
                    },
                  ]
                : [],
            errors: [],
          }
        },
      })

      const concurrentPromises = Array.from({ length: 5 }, () =>
        collector.runPollCycle(now),
      )
      await discoveryStarted
      expect(discoveryCalls).toBe(1)
      expect(releaseDiscovery).not.toBeNull()
      releaseDiscovery!()

      const results = await Promise.all(concurrentPromises)
      for (const res of results) {
        expect(res).toEqual(results[0])
      }
      expect(await store.getPredictionSnapshots('btc-5m-concurrent-down')).toHaveLength(1)

      // Close with resolvedUp=null, then settle with resolvedUp=false
      now = endMs + 2_000
      oracle.ingestChainlinkTick(89_850, endMs)
      status = 'closed'
      resolvedUp = null
      const pending = await collector.runPollCycle(now)
      expect(pending.settledCountsByTimeframe['5m']).toBe(0)

      now = endMs + 6_000
      resolvedUp = false
      const settled = await collector.runPollCycle(now)
      expect(settled.settledCountsByTimeframe['5m']).toBe(1)

      const rows = await store.getPredictionWindows({
        slug: 'btc-5m-concurrent-down',
      })
      expect(rows).toHaveLength(1)
      expect(rows[0].resolvedUp).toBe(false)
      expect(rows[0].closeTwap).toBe(89_850)
    } finally {
      clob.close()
      await store.close()
    }
  })
})
