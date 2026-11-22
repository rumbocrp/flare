import { Side } from '@polymarket/clob-client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UpstreamMarketDataError } from '../candleCache'
import {
  clearAllTenantExchangeStates,
  getTenantLedgerSnapshot,
  resetExchangeStateForTests,
  triggerEmergencyKillSwitch,
} from '../exchangeAdapter'
import type { PolymarketTimeframe, PolymarketWindow } from '../polymarketAdapter'
import {
  getPolymarketExecutorStatus,
  resetPolymarketExecutorState,
  setPolymarketClobClient,
  type PolymarketClobClientLike,
} from '../polymarketExecutor'
import { getStateStore, resetStateStore } from '../store'
import { ClobBookFeedService } from './clobBookFeed'
import { OracleFeedService } from './oracleFeed'
import {
  PredictionRunner,
  resetPredictionRunner,
} from './predictionRunner'
import { PredictionWindowCollector } from './windowCollector'

type MutableBookLevels = {
  bids: { price: string; size: string }[]
  asks: { price: string; size: string }[]
}

function makeFakeClobClient(overrides?: Partial<PolymarketClobClientLike>) {
  const calls = {
    marketOrders: [] as unknown[],
    limitOrders: [] as unknown[],
    canceledIds: [] as string[],
    cancelAllCount: 0,
  }
  const client: PolymarketClobClientLike = {
    async createOrDeriveApiKey() {
      return { key: 'k', secret: 's', passphrase: 'p' }
    },
    async createAndPostMarketOrder(order, opts, orderType) {
      calls.marketOrders.push({ order, opts, orderType })
      return {
        success: true,
        orderID: `clob-mkt-${calls.marketOrders.length}`,
        status: 'MATCHED',
        transactionsHashes: ['0xabc'],
      }
    },
    async createAndPostOrder(order, opts, orderType, deferExec, postOnly) {
      calls.limitOrders.push({ order, opts, orderType, deferExec, postOnly })
      return {
        success: true,
        orderID: `clob-lmt-${calls.limitOrders.length}`,
        status: 'LIVE',
      }
    },
    async cancelOrder(payload) {
      calls.canceledIds.push(payload.orderID)
      return { canceled: [payload.orderID] }
    },
    async cancelAll() {
      calls.cancelAllCount += 1
      return { canceled: 'all' }
    },
    async getOpenOrders() {
      return []
    },
    async getTrades() {
      return []
    },
    async getBalanceAllowance() {
      return { balance: '100000000', allowance: '1000000000' }
    },
    ...overrides,
  }
  return { client, calls }
}

function seedOracleBaseline(
  oracle: OracleFeedService,
  baseTimeMs: number,
  basePrice = 90_000,
) {
  // Seed 20 closed 1m Binance bars with realistic ~5 bps/min log-return volatility
  for (let m = 20; m >= 1; m -= 1) {
    const t = baseTimeMs - m * 60_000
    const delta = (m % 2 === 0 ? 1 : -1) * 45
    oracle.ingestBinanceTrade(basePrice + delta, t + 10_000)
  }
  // Seed Chainlink ticks covering [baseTimeMs - 60s, baseTimeMs]
  for (let s = 60; s >= 0; s -= 15) {
    oracle.ingestChainlinkTick(basePrice, baseTimeMs - s * 1_000)
  }
}

function pushOraclePrices(
  oracle: OracleFeedService,
  nowMs: number,
  chainlinkPrice: number,
  binancePrice = chainlinkPrice,
) {
  for (let s = 45; s >= 0; s -= 15) {
    oracle.ingestChainlinkTick(chainlinkPrice, nowMs - s * 1_000)
  }
  oracle.ingestBinanceTrade(binancePrice, nowMs)
}

function createMockHarness(initialNowMs: number) {
  let clockMs = initialNowMs
  const nowMs = () => clockMs
  const setNowMs = (t: number) => {
    clockMs = t
  }

  const oracleFeed = new OracleFeedService({ nowMs })
  const booksByToken = new Map<string, MutableBookLevels>()

  const setTokenBook = (
    tokenId: string,
    bid: number,
    ask: number,
    depthShares = 1_000,
  ) => {
    booksByToken.set(tokenId, {
      bids: [{ price: bid.toFixed(2), size: String(depthShares) }],
      asks: [{ price: ask.toFixed(2), size: String(depthShares) }],
    })
  }

  const clobBookFeed = new ClobBookFeedService({
    nowMs,
    fetchImpl: async (url: string) => {
      const parsed = new URL(url)
      const tokenId = parsed.searchParams.get('token_id') ?? ''
      const book = booksByToken.get(tokenId) ?? { bids: [], asks: [] }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            market: '0xcond',
            asset_id: tokenId,
            bids: book.bids,
            asks: book.asks,
          }
        },
      }
    },
  })

  const windowsByTf: Record<PolymarketTimeframe, PolymarketWindow[]> = {
    '5m': [],
    '15m': [],
    '1h': [],
  }

  const collector = new PredictionWindowCollector({
    store: getStateStore(),
    oracleFeed,
    clobBookFeed,
    nowMs,
    discoveryIntervalMs: 500,
    normalSnapshotIntervalMs: 1_000,
    finalSnapshotIntervalMs: 500,
    hydrateCooldownMs: 250,
    fetchPolymarketUpDown: async (tf) => ({
      source: 'polymarket',
      timeframe: tf,
      fetchedAt: new Date(clockMs).toISOString(),
      windows: windowsByTf[tf].map((w) => ({ ...w })),
      errors: [],
    }),
  })

  return {
    nowMs,
    setNowMs,
    oracleFeed,
    clobBookFeed,
    collector,
    windowsByTf,
    setTokenBook,
  }
}

describe('PredictionRunner (Wave 3 / Ticket 07)', () => {
  const prevLive = process.env.FLARE_POLYMARKET_LIVE

  beforeEach(async () => {
    resetPredictionRunner()
    resetPolymarketExecutorState()
    clearAllTenantExchangeStates()
    await resetStateStore(':memory:')
    resetExchangeStateForTests('default', { fundPaperUsd: 10_000 })
    delete process.env.FLARE_POLYMARKET_LIVE
  })

  afterEach(async () => {
    resetPredictionRunner()
    setPolymarketClobClient(null)
    resetPolymarketExecutorState()
    if (prevLive === undefined) delete process.env.FLARE_POLYMARKET_LIVE
    else process.env.FLARE_POLYMARKET_LIVE = prevLive
  })

  it('executes T-20s maker cancellation sweep on c5-nowcast-maker without canceling unrelated windows', async () => {
    const { client, calls } = makeFakeClobClient()
    setPolymarketClobClient(client)
    process.env.FLARE_POLYMARKET_LIVE = 'true'

    const startMs = 1_700_000_000_000
    const end5m = startMs + 300_000
    const end15m = startMs + 900_000
    const h = createMockHarness(startMs + 120_000) // T-180s on 5m

    seedOracleBaseline(h.oracleFeed, startMs)
    pushOraclePrices(h.oracleFeed, startMs + 120_000, 90_010)

    h.windowsByTf['5m'] = [
      {
        slug: 'btc-updown-5m-1',
        timeframe: '5m',
        startTime: startMs,
        endTime: end5m,
        status: 'open',
        question: 'BTC 5m?',
        upPriceAtOpen: 0.5,
        upPriceNow: 0.52,
        bestBid: 0.52,
        bestAsk: 0.54,
        resolvedUp: null,
        volume: 50_000,
        resolutionSource: 'chainlink-twap-60s',
        conditionId: '0xcond5m',
        upTokenId: 'tok-5m-yes',
        downTokenId: 'tok-5m-no',
        tickSize: 0.01,
        negRisk: false,
      },
    ]
    h.windowsByTf['15m'] = [
      {
        slug: 'btc-updown-15m-1',
        timeframe: '15m',
        startTime: startMs,
        endTime: end15m,
        status: 'open',
        question: 'BTC 15m?',
        upPriceAtOpen: 0.5,
        upPriceNow: 0.72,
        bestBid: 0.71,
        bestAsk: 0.73,
        resolvedUp: null,
        volume: 80_000,
        resolutionSource: 'chainlink-twap-60s',
        conditionId: '0xcond15m',
        upTokenId: 'tok-15m-yes',
        downTokenId: 'tok-15m-no',
        tickSize: 0.01,
        negRisk: false,
      },
    ]

    // Price books so c5-nowcast-maker posts resting YES & NO bids inside spread/fair value
    h.setTokenBook('tok-5m-yes', 0.51, 0.53)
    h.setTokenBook('tok-5m-no', 0.47, 0.49)
    h.setTokenBook('tok-15m-yes', 0.71, 0.73)
    h.setTokenBook('tok-15m-no', 0.27, 0.29)

    const runner = new PredictionRunner({
      store: getStateStore(),
      oracleFeed: h.oracleFeed,
      clobBookFeed: h.clobBookFeed,
      collector: h.collector,
      getHourlyCandles: async () => [],
      nowMs: h.nowMs,
    })

    // Disable paper strategies so only c5-nowcast-maker runs in canary
    await runner.setPredictionStrategyMode('default', 'c5-late-favorite', 'disabled')
    await runner.setPredictionStrategyMode('default', 'c15-favorite-carry', 'disabled')
    await runner.setPredictionStrategyMode('default', 'c1h-exhaustion-limit', 'disabled')
    await runner.setPredictionStrategyMode('default', 'c5-15-longshot-fade', 'disabled')
    await runner.setPredictionStrategyMode(
      'default',
      'c5-nowcast-maker',
      'canary',
      true,
      'Test T-20s maker sweep',
    )

    await runner.runTick()

    expect(calls.limitOrders.length).toBeGreaterThanOrEqual(1)
    expect(calls.limitOrders[0]).toMatchObject({
      postOnly: true,
      deferExec: false,
    })

    let status = await runner.getPredictionEngineStatus('default')
    expect(status.openTrades.length).toBeGreaterThanOrEqual(1)
    const initialLiveCount = status.openTrades.length

    // Advance to T-20s remaining on 5m window (end5m - 20_000)
    const tMinus20 = end5m - 20_000
    h.setNowMs(tMinus20)
    pushOraclePrices(h.oracleFeed, tMinus20, 90_010)
    await h.clobBookFeed.hydrateWindow(h.windowsByTf['5m'][0])
    await runner.runTick()

    expect(calls.canceledIds).toHaveLength(initialLiveCount)
    status = await runner.getPredictionEngineStatus('default')
    expect(status.openTrades).toHaveLength(0)
    expect(status.canaryRisk.openBtcExposureUsd).toBe(0)

    const sqlTrades = await getStateStore().getPredictionTrades('default', {
      strategyId: 'c5-nowcast-maker',
    })
    expect(sqlTrades.length).toBe(initialLiveCount)
    expect(sqlTrades.every((t) => t.status === 'CANCELED')).toBe(true)
    expect(
      getPolymarketExecutorStatus('default').recentOrders.every(
        (o) => o.status === 'CANCELED',
      ),
    ).toBe(true)
  })

  it('enforces first-60s taker exclusion and G1/G2 safety gates', async () => {
    const startMs = 1_700_000_000_000
    const end5m = startMs + 300_000
    // Start at T+30s (inside first-60s exclusion!)
    const h = createMockHarness(startMs + 30_000)
    seedOracleBaseline(h.oracleFeed, startMs)
    pushOraclePrices(h.oracleFeed, startMs + 30_000, 90_400) // strong UP move

    h.windowsByTf['5m'] = [
      {
        slug: 'btc-updown-5m-gates',
        timeframe: '5m',
        startTime: startMs,
        endTime: end5m,
        status: 'open',
        question: 'BTC 5m?',
        upPriceAtOpen: 0.5,
        upPriceNow: 0.9,
        bestBid: 0.89,
        bestAsk: 0.91,
        resolvedUp: null,
        volume: 50_000,
        resolutionSource: 'chainlink-twap-60s',
        conditionId: '0xcondg',
        upTokenId: 'tok-g-yes',
        downTokenId: 'tok-g-no',
        tickSize: 0.01,
        negRisk: false,
      },
    ]
    h.setTokenBook('tok-g-yes', 0.89, 0.91, 500)
    h.setTokenBook('tok-g-no', 0.08, 0.10, 2_000)

    const runner = new PredictionRunner({
      store: getStateStore(),
      oracleFeed: h.oracleFeed,
      clobBookFeed: h.clobBookFeed,
      collector: h.collector,
      getHourlyCandles: async () => [],
      nowMs: h.nowMs,
    })

    // 1. First-60s exclusion blocks taker entry on 5m
    await runner.runTick()
    let status = await runner.getPredictionEngineStatus('default')
    expect(status.openTrades).toHaveLength(0)
    expect(status.gates.avoidPassed).toBe(false)
    expect(status.gates.failureCodes).toContain('AVOID_FIRST_60S')

    // 2. Unknown resolution source triggers G2 block even after 60s
    h.setNowMs(end5m - 90_000)
    pushOraclePrices(h.oracleFeed, end5m - 90_000, 90_400)
    h.windowsByTf['5m'][0].resolutionSource = 'unknown'
    await h.clobBookFeed.hydrateWindow(h.windowsByTf['5m'][0])
    await runner.runTick()

    status = await runner.getPredictionEngineStatus('default')
    expect(status.openTrades).toHaveLength(0)
    expect(status.gates.g2Passed).toBe(false)
    expect(status.gates.failureCodes).toContain('G2_UNKNOWN_RESOLUTION_SOURCE')

    // 3. Macro blackout window blocks G1 even with valid chainlink resolutionSource
    h.windowsByTf['5m'][0].resolutionSource = 'chainlink-twap-60s'
    runner.setMacroBlackoutWindows([
      { timestampMs: end5m - 90_000, label: 'FOMC' },
    ])
    await runner.runTick()
    status = await runner.getPredictionEngineStatus('default')
    expect(status.openTrades).toHaveLength(0)
    expect(status.gates.g1Passed).toBe(false)
    expect(status.gates.failureCodes).toContain('G1_MACRO_BLACKOUT')

    // 4. Clearing macro blackout allows entry
    runner.setMacroBlackoutWindows([])
    await runner.runTick()
    status = await runner.getPredictionEngineStatus('default')
    expect(status.gates.g1Passed).toBe(true)
    expect(status.gates.g2Passed).toBe(true)
    expect(status.gates.avoidPassed).toBe(true)
    expect(status.openTrades.length).toBeGreaterThanOrEqual(1)
  })

  it('completes paper shadow fill -> +30s markout -> settlement PnL persistence -> restart hydration without touching wallet ledger', async () => {
    const startMs = 1_700_000_000_000
    const end5m = startMs + 300_000
    const entryTs = end5m - 90_000 // T-90s (in [30s, 120s] for c5-late-favorite)
    const h = createMockHarness(entryTs)

    seedOracleBaseline(h.oracleFeed, startMs)
    pushOraclePrices(h.oracleFeed, entryTs, 90_350) // high probability YES

    h.windowsByTf['5m'] = [
      {
        slug: 'btc-updown-5m-paper',
        timeframe: '5m',
        startTime: startMs,
        endTime: end5m,
        status: 'open',
        question: 'BTC 5m?',
        upPriceAtOpen: 0.5,
        upPriceNow: 0.91,
        bestBid: 0.9,
        bestAsk: 0.92,
        resolvedUp: null,
        volume: 60_000,
        resolutionSource: 'chainlink-twap-60s',
        conditionId: '0xcondp',
        upTokenId: 'tok-p-yes',
        downTokenId: 'tok-p-no',
        tickSize: 0.01,
        negRisk: false,
      },
    ]
    h.setTokenBook('tok-p-yes', 0.9, 0.92, 500)
    h.setTokenBook('tok-p-no', 0.08, 0.1, 3_000)

    const runner = new PredictionRunner({
      store: getStateStore(),
      oracleFeed: h.oracleFeed,
      clobBookFeed: h.clobBookFeed,
      collector: h.collector,
      getHourlyCandles: async () => [],
      nowMs: h.nowMs,
    })
    await runner.setPredictionStrategyMode('default', 'c5-nowcast-maker', 'disabled')
    await runner.setPredictionStrategyMode('default', 'c5-15-longshot-fade', 'disabled')

    // 1. Paper fill at live ask
    await runner.runTick()
    let status = await runner.getPredictionEngineStatus('default')
    expect(status.openTrades).toHaveLength(1)
    const trade = status.openTrades[0]
    expect(trade.mode).toBe('paper')
    expect(trade.entryPrice).toBe(0.92)
    expect(trade.feeUsd).toBeGreaterThan(0)
    expect(trade.markout30s).toBeNull()

    // Paper mode must not mutate wallet ledger
    const ledgerAfterEntry = getTenantLedgerSnapshot('default')
    expect(
      ledgerAfterEntry.entries.some((e) => e.kind === 'PREDICTION_STAKE'),
    ).toBe(false)

    // 2. +30s markout capture
    const markoutTs = entryTs + 31_000
    h.setNowMs(markoutTs)
    pushOraclePrices(h.oracleFeed, markoutTs, 90_400)
    h.setTokenBook('tok-p-yes', 0.95, 0.97, 500) // mid = 0.96 -> +0.04 markout
    h.setTokenBook('tok-p-no', 0.03, 0.05, 5_000)
    await h.clobBookFeed.hydrateWindow(h.windowsByTf['5m'][0])
    await runner.runTick()

    status = await runner.getPredictionEngineStatus('default')
    expect(status.openTrades[0].markout30s).toBeCloseTo(0.04, 4)

    // 3. Window settles resolvedUp = true -> settles trade & computes netPnlUsd
    const closeTs = end5m + 5_000
    h.setNowMs(closeTs)
    pushOraclePrices(h.oracleFeed, closeTs, 90_450)
    h.windowsByTf['5m'][0] = {
      ...h.windowsByTf['5m'][0],
      status: 'closed',
      upPriceNow: null,
      bestBid: null,
      bestAsk: null,
      resolvedUp: true,
    }
    await runner.runTick()

    status = await runner.getPredictionEngineStatus('default')
    expect(status.openTrades).toHaveLength(0)
    expect(status.recentSettledTrades).toHaveLength(1)
    const settled = status.recentSettledTrades[0]
    expect(settled.status).toBe('SETTLED')
    expect(settled.won).toBe(true)
    expect(settled.netPnlUsd).toBeGreaterThan(0)
    expect(settled.markout30s).toBeCloseTo(0.04, 4)

    // Still zero wallet ledger entries in paper mode
    expect(
      getTenantLedgerSnapshot('default').entries.some(
        (e) =>
          e.kind === 'PREDICTION_STAKE' ||
          e.kind === 'PREDICTION_SETTLEMENT',
      ),
    ).toBe(false)

    // 4. Restart hydration on a fresh PredictionRunner backed by the same SQLite store
    const restartedRunner = new PredictionRunner({
      store: getStateStore(),
      oracleFeed: h.oracleFeed,
      clobBookFeed: h.clobBookFeed,
      collector: h.collector,
      getHourlyCandles: async () => [],
      nowMs: h.nowMs,
    })
    const hydratedStatus =
      await restartedRunner.getPredictionEngineStatus('default')
    expect(hydratedStatus.recentSettledTrades).toHaveLength(1)
    expect(
      hydratedStatus.strategies.find((s) => s.id === 'c5-late-favorite')?.mode,
    ).toBe('paper')
    expect(
      hydratedStatus.strategies.find((s) => s.id === 'c5-nowcast-maker')?.mode,
    ).toBe('disabled')
    expect(
      hydratedStatus.strategies.find((s) => s.id === 'c5-late-favorite')
        ?.liveStats.wins,
    ).toBe(1)
  })

  it('enforces n=500 promotion gate, $5 canary sizing, $15 BTC concurrent exposure cap, 3-loss UTC daily circuit breaker, and Binance REST outage resilience', async () => {
    const { client } = makeFakeClobClient()
    setPolymarketClobClient(client)
    process.env.FLARE_POLYMARKET_LIVE = 'true'

    const startMs = 1_700_000_000_000
    const h = createMockHarness(startMs + 210_000) // T-90s on 5m, T-690s on 15m
    seedOracleBaseline(h.oracleFeed, startMs)
    pushOraclePrices(h.oracleFeed, startMs + 210_000, 90_350)

    const runner = new PredictionRunner({
      store: getStateStore(),
      oracleFeed: h.oracleFeed,
      clobBookFeed: h.clobBookFeed,
      collector: h.collector,
      // Simulate Binance 1h REST outage -> must NOT crash 5m/15m execution
      getHourlyCandles: async () => {
        throw new UpstreamMarketDataError('BTC/USDT', '1h', 'Binance 1h REST 503')
      },
      nowMs: h.nowMs,
    })

    // 1. Promotion to canary without forceOverride blocked before n=500
    const blockedPromo = await runner.setPredictionStrategyMode(
      'default',
      'c5-late-favorite',
      'canary',
    )
    expect(blockedPromo.allowed).toBe(false)
    expect(blockedPromo.failures.join(' ')).toContain('500')
    expect(blockedPromo.state.mode).toBe('paper')

    // 2. Audited forceOverride promotes to canary
    await runner.setPredictionStrategyMode(
      'default',
      'c5-late-favorite',
      'canary',
      true,
      'Operator approved canary launch',
    )
    await runner.setPredictionStrategyMode(
      'default',
      'c15-favorite-carry',
      'canary',
      true,
      'Operator approved canary launch',
    )
    await runner.setPredictionStrategyMode(
      'default',
      'c15-late-favorite-guarded',
      'canary',
      true,
      'Operator approved canary launch',
    )
    await runner.setPredictionStrategyMode('default', 'c5-nowcast-maker', 'disabled')
    await runner.setPredictionStrategyMode('default', 'c1h-exhaustion-limit', 'disabled')
    await runner.setPredictionStrategyMode('default', 'c5-15-longshot-fade', 'disabled')

    // Setup 5m and 15m windows triggering multiple concurrent $5 canary tickets
    const end5m = startMs + 300_000
    const end15m = startMs + 900_000
    h.windowsByTf['5m'] = [
      {
        slug: 'btc-updown-5m-c1',
        timeframe: '5m',
        startTime: startMs,
        endTime: end5m,
        status: 'open',
        question: 'BTC 5m c1',
        upPriceAtOpen: 0.5,
        upPriceNow: 0.92,
        bestBid: 0.91,
        bestAsk: 0.93,
        resolvedUp: null,
        volume: 50_000,
        resolutionSource: 'chainlink-twap-60s',
        conditionId: '0xc1',
        upTokenId: 'tok-c1-yes',
        downTokenId: 'tok-c1-no',
        tickSize: 0.01,
        negRisk: false,
      },
    ]
    h.windowsByTf['15m'] = [
      {
        slug: 'btc-updown-15m-c1',
        timeframe: '15m',
        startTime: startMs,
        endTime: end15m,
        status: 'open',
        question: 'BTC 15m c1',
        upPriceAtOpen: 0.5,
        upPriceNow: 0.80,
        bestBid: 0.78,
        bestAsk: 0.80,
        resolvedUp: null,
        volume: 80_000,
        resolutionSource: 'chainlink-twap-60s',
        conditionId: '0xc2',
        upTokenId: 'tok-c2-yes',
        downTokenId: 'tok-c2-no',
        tickSize: 0.01,
        negRisk: false,
      },
    ]
    h.setTokenBook('tok-c1-yes', 0.91, 0.93, 500)
    h.setTokenBook('tok-c1-no', 0.06, 0.08, 4_000)
    h.setTokenBook('tok-c2-yes', 0.78, 0.80, 500)
    h.setTokenBook('tok-c2-no', 0.19, 0.21, 2_000)

    await runner.runTick()
    let status = await runner.getPredictionEngineStatus('default')
    // 5m c5-late-favorite ($5) + 15m c15-favorite-carry ($5) = $10 open
    expect(status.openTrades).toHaveLength(2)
    expect(status.openTrades.every((t) => t.stakeUsd === 5)).toBe(true)
    expect(status.canaryRisk.openBtcExposureUsd).toBe(10)
    expect(status.canaryRisk.remainingBtcExposureUsd).toBe(5)

    // Now open a 3rd & 4th $5 window concurrently -> cap at $15 (only 1 more allowed!)
    const start2 = end5m
    const end5m2 = start2 + 300_000
    // Seed Chainlink open TWAPs at the exact open timestamps of 15m-c2 and 5m-c2/c3
    pushOraclePrices(h.oracleFeed, start2 - 600_000, 90_000)
    pushOraclePrices(h.oracleFeed, start2, 90_000)
    h.setNowMs(start2 + 210_000) // T-90s on 5m-c2, T-390s on 15m-c1, T-90s on 15m-c2
    pushOraclePrices(h.oracleFeed, start2 + 210_000, 90_500)
    h.windowsByTf['5m'] = [
      {
        ...h.windowsByTf['5m'][0],
        status: 'closed',
        resolvedUp: false, // 1st loss!
      },
      {
        slug: 'btc-updown-5m-c2',
        timeframe: '5m',
        startTime: start2,
        endTime: end5m2,
        status: 'open',
        question: 'BTC 5m c2',
        upPriceAtOpen: 0.5,
        upPriceNow: 0.92,
        bestBid: 0.91,
        bestAsk: 0.93,
        resolvedUp: null,
        volume: 50_000,
        resolutionSource: 'chainlink-twap-60s',
        conditionId: '0xc3',
        upTokenId: 'tok-c3-yes',
        downTokenId: 'tok-c3-no',
        tickSize: 0.01,
        negRisk: false,
      },
    ]
    h.windowsByTf['15m'].push({
      slug: 'btc-updown-15m-c2',
      timeframe: '15m',
      startTime: start2 - 600_000,
      endTime: start2 + 300_000,
      status: 'open',
      question: 'BTC 15m c2',
      upPriceAtOpen: 0.5,
      upPriceNow: 0.92,
      bestBid: 0.91,
      bestAsk: 0.93,
      resolvedUp: null,
      volume: 80_000,
      resolutionSource: 'chainlink-twap-60s',
      conditionId: '0xc4',
      upTokenId: 'tok-c4-yes',
      downTokenId: 'tok-c4-no',
      tickSize: 0.01,
      negRisk: false,
    })
    h.setTokenBook('tok-c3-yes', 0.91, 0.93, 500)
    h.setTokenBook('tok-c3-no', 0.06, 0.08, 4_000)
    h.setTokenBook('tok-c4-yes', 0.91, 0.93, 500)
    h.setTokenBook('tok-c4-no', 0.06, 0.08, 4_000)
    // Refresh 15m-c1 book
    h.setTokenBook('tok-c2-yes', 0.78, 0.80, 500)
    h.setTokenBook('tok-c2-no', 0.19, 0.21, 2_000)

    // Pre-seed two more open $5 positions on 15m-c1? Actually settle 1st loss, now 1 open ($5), plus c2 (5m) + c2 (15m) = 3 open ($15)
    // Add one more window to verify 4th is blocked by $15 BTC cap!
    h.windowsByTf['5m'].push({
      slug: 'btc-updown-5m-c3-cap',
      timeframe: '5m',
      startTime: start2,
      endTime: end5m2,
      status: 'open',
      question: 'BTC 5m c3',
      upPriceAtOpen: 0.5,
      upPriceNow: 0.92,
      bestBid: 0.91,
      bestAsk: 0.93,
      resolvedUp: null,
      volume: 50_000,
      resolutionSource: 'chainlink-twap-60s',
      conditionId: '0xc5',
      upTokenId: 'tok-c5-yes',
      downTokenId: 'tok-c5-no',
      tickSize: 0.01,
      negRisk: false,
    })
    h.setTokenBook('tok-c5-yes', 0.91, 0.93, 500)
    h.setTokenBook('tok-c5-no', 0.06, 0.08, 4_000)

    await runner.runTick()
    status = await runner.getPredictionEngineStatus('default')
    expect(status.canaryRisk.todayLossesCount).toBe(1)
    expect(status.canaryRisk.openBtcExposureUsd).toBe(15)
    expect(status.canaryRisk.remainingBtcExposureUsd).toBe(0)
    expect(status.openTrades).toHaveLength(3)

    // Settle the remaining 2 losing trades (plus 15m-c1) -> hits 3 UTC daily losses -> auto kill-switch!
    const settleAllTs = end15m + 5_000
    h.setNowMs(settleAllTs)
    pushOraclePrices(h.oracleFeed, settleAllTs, 90_500)
    h.windowsByTf['5m'] = h.windowsByTf['5m'].map((w) => ({
      ...w,
      status: 'closed',
      resolvedUp: false,
    }))
    h.windowsByTf['15m'] = h.windowsByTf['15m'].map((w) => ({
      ...w,
      status: 'closed',
      resolvedUp: false,
    }))

    await runner.runTick()
    status = await runner.getPredictionEngineStatus('default')
    expect(status.canaryRisk.todayLossesCount).toBeGreaterThanOrEqual(3)
    expect(status.canaryRisk.todayLossUsd).toBeGreaterThanOrEqual(15)
    // All canary strategies halted by UTC daily loss circuit breaker
    const c5Strat = status.strategies.find((s) => s.id === 'c5-late-favorite')
    expect(c5Strat?.mode).toBe('disabled')
    expect(c5Strat?.haltedReason).toContain('UTC daily loss')

    // Ledger invariant remains 100% balanced across stakes and settlements
    expect(getTenantLedgerSnapshot('default').verification.balanced).toBe(true)

    // Global emergency kill-switch immediately cancels open orders
    await triggerEmergencyKillSwitch('Operator panic')
    status = await runner.getPredictionEngineStatus('default')
    expect(status.canaryRisk.killSwitchActive).toBe(true)
  })

  it('triggers auto kill-switches on 5 consecutive high-error trades and 30-fill markout < -0.04, recalibrates every 25 settled windows, and runs SQL replay', async () => {
    const store = getStateStore()
    const baseMs = 1_700_000_000_000

    // Seed 25 settled 5m windows with snapshots -> triggers PAV recalibration & allows replay
    for (let i = 0; i < 25; i += 1) {
      const start = baseMs + i * 300_000
      const end = start + 300_000
      const slug = `btc-updown-5m-hist-${i}`
      const up = i % 2 === 0
      await store.upsertPredictionWindow({
        slug,
        timeframe: '5m',
        conditionId: `0xhist${i}`,
        upTokenId: `up-${i}`,
        downTokenId: `dn-${i}`,
        resolutionSource: 'chainlink-twap-60s',
        startTimeMs: start,
        endTimeMs: end,
        openTwap: 90_000,
        closeTwap: up ? 90_200 : 89_800,
        resolvedUp: up,
        tickSize: 0.01,
        negRisk: false,
        volumeUsd: 40_000,
        updatedAt: end,
      })
      for (const offsetSec of [180, 215, 250]) {
        const capMs = start + offsetSec * 1_000
        await store.appendPredictionSnapshot({
          slug,
          capturedAtMs: capMs,
          secondsRemaining: 300 - offsetSec,
          twapPrice: up ? 90_200 : 89_800,
          binancePrice: up ? 90_200 : 89_800,
          sigma1m: 0.0005,
          basisBps: 1,
          yesBid: up ? 0.9 : 0.08,
          yesAsk: up ? 0.92 : 0.1,
          yesDepthUsd: 400,
          noBid: up ? 0.08 : 0.9,
          noAsk: up ? 0.1 : 0.92,
          noDepthUsd: 400,
          pModelYes: up ? 0.96 : 0.04,
        })
      }
    }

    // Seed 5 consecutive high-error settled trades for c5-late-favorite (|0.96 - 0| = 0.96 > 0.15)
    for (let i = 0; i < 5; i += 1) {
      await store.upsertPredictionTrade({
        id: `err-streak-${i}`,
        tenantId: 'default',
        strategyId: 'c5-late-favorite',
        lane: 'high-hit-rate',
        mode: 'paper',
        slug: `btc-updown-5m-hist-${i}`,
        timeframe: '5m',
        outcome: 'YES',
        liquidityRole: 'taker',
        entryTimeMs: baseMs + i * 300_000 + 200_000,
        entryPrice: 0.92,
        feeUsd: 0.03,
        stakeUsd: 5,
        shares: 5.43,
        pModel: 0.96,
        pCalibrated: 0.96,
        markout30s: 0.01,
        resolvedUp: false,
        won: false,
        netPnlUsd: -5.03,
        venueOrderId: null,
        status: 'SETTLED',
      })
    }

    // Seed 30 settled fills with mean markout30s = -0.06 (< -0.04) for c15-favorite-carry
    for (let i = 0; i < 30; i += 1) {
      await store.upsertPredictionTrade({
        id: `bad-mk-${i}`,
        tenantId: 'default',
        strategyId: 'c15-favorite-carry',
        lane: 'edge',
        mode: 'paper',
        slug: `btc-updown-15m-hist-${i}`,
        timeframe: '15m',
        outcome: 'YES',
        liquidityRole: 'taker',
        entryTimeMs: baseMs + i * 900_000 + 300_000,
        entryPrice: 0.78,
        feeUsd: 0.05,
        stakeUsd: 5,
        shares: 6.41,
        pModel: 0.9,
        pCalibrated: 0.9,
        markout30s: -0.06,
        resolvedUp: true,
        won: true,
        netPnlUsd: 1.36,
        venueOrderId: null,
        status: 'SETTLED',
      })
    }

    const h = createMockHarness(baseMs + 30 * 900_000)
    const runner = new PredictionRunner({
      store,
      oracleFeed: h.oracleFeed,
      clobBookFeed: h.clobBookFeed,
      collector: h.collector,
      getHourlyCandles: async () => [],
      nowMs: h.nowMs,
      recalibrateEverySettled: 25,
    })

    await runner.runTick()
    const status = await runner.getPredictionEngineStatus('default')

    // Calibrator ran across the 25 settled 5m windows
    expect(status.calibrators['5m'].lastSettledCount).toBe(25)
    expect(status.calibrators['5m'].mode).toBe('pav')
    expect(status.calibrators['5m'].sampleCount).toBe(75)

    // Both auto kill-switches tripped and persisted
    const errHalt = status.strategies.find((s) => s.id === 'c5-late-favorite')
    expect(errHalt?.mode).toBe('disabled')
    expect(errHalt?.haltedReason).toContain('5 consecutive')

    const markoutHalt = status.strategies.find(
      (s) => s.id === 'c15-favorite-carry',
    )
    expect(markoutHalt?.mode).toBe('disabled')
    expect(markoutHalt?.haltedReason).toContain('30-fill')

    // Replay reconstructs median24hSigma1m & evaluates strategy against SQL windows
    const replay = await runner.runStrategyReplay('c5-late-favorite')
    expect(replay.settledWindowCount).toBe(25)
    expect(replay.eligibleForCanary).toBe(false)
    expect(replay.sampleProgressText).toBe('25 / 500')
  })

  it('crosses resting paper quotes on later tick and sweeps c1h-exhaustion-limit at T+10m (3000s remaining)', async () => {
    const startMs = 1_700_000_000_000
    const end1h = startMs + 3_600_000
    const entryTs = startMs + 120_000 // T+2m (3480s remaining > 3000s)
    const h = createMockHarness(entryTs)

    seedOracleBaseline(h.oracleFeed, startMs)
    pushOraclePrices(h.oracleFeed, entryTs, 90_000)

    // 3 consecutive closed red 1h candles + 1 unclosed forming green candle (must be ignored!)
    const closedHourly = [
      {
        time: startMs - 3 * 3_600_000,
        open: 91_000,
        high: 91_100,
        low: 90_600,
        close: 90_700,
        volume: 100,
      },
      {
        time: startMs - 2 * 3_600_000,
        open: 90_700,
        high: 90_800,
        low: 90_300,
        close: 90_400,
        volume: 100,
      },
      {
        time: startMs - 1 * 3_600_000,
        open: 90_400,
        high: 90_500,
        low: 90_000,
        close: 90_100,
        volume: 100,
      },
      // Forming current 1h bar (open === startMs, unclosed -> must be excluded!)
      {
        time: startMs,
        open: 90_100,
        high: 90_300,
        low: 90_000,
        close: 90_250,
        volume: 50,
      },
    ]

    h.windowsByTf['1h'] = [
      {
        slug: 'btc-updown-1h-ex',
        timeframe: '1h',
        startTime: startMs,
        endTime: end1h,
        status: 'open',
        question: 'BTC 1h?',
        upPriceAtOpen: 0.5,
        upPriceNow: 0.525,
        bestBid: 0.52,
        bestAsk: 0.53,
        resolvedUp: null,
        volume: 90_000,
        resolutionSource: 'binance-1h-candle',
        conditionId: '0xcond1h',
        upTokenId: 'tok-1h-yes',
        downTokenId: 'tok-1h-no',
        tickSize: 0.01,
        negRisk: false,
      },
    ]
    // YES ask = 0.53 -> c1h-exhaustion-limit posts resting maker limit at 0.52 (unfilled initially)
    h.setTokenBook('tok-1h-yes', 0.51, 0.53, 500)
    h.setTokenBook('tok-1h-no', 0.46, 0.48, 500)

    const runner = new PredictionRunner({
      store: getStateStore(),
      oracleFeed: h.oracleFeed,
      clobBookFeed: h.clobBookFeed,
      collector: h.collector,
      getHourlyCandles: async () => closedHourly,
      nowMs: h.nowMs,
    })

    await runner.runTick()
    let status = await runner.getPredictionEngineStatus('default')
    expect(status.hourlyIndicators?.consecutiveRedHours).toBe(3)
    expect(status.openTrades).toHaveLength(1)
    expect(status.openTrades[0].strategyId).toBe('c1h-exhaustion-limit')
    expect(status.openTrades[0].entryPrice).toBe(0.52)

    // Advance to T+10m (3000s remaining) while ask is still 0.53 -> resting paper quote swept to CANCELED
    const sweepTs = end1h - 3_000_000
    h.setNowMs(sweepTs)
    pushOraclePrices(h.oracleFeed, sweepTs, 90_000)
    await h.clobBookFeed.hydrateWindow(h.windowsByTf['1h'][0])
    await runner.runTick()

    status = await runner.getPredictionEngineStatus('default')
    expect(status.openTrades).toHaveLength(0)
    const trades = await getStateStore().getPredictionTrades('default', {
      strategyId: 'c1h-exhaustion-limit',
    })
    expect(trades[0].status).toBe('CANCELED')
  })

  it('syncs live GTC maker LIVE->MATCHED via CLOB getTrades, captures +30s markout, and settles with buildPredictionSettlementEntry', async () => {
    let fakeTrades: Awaited<ReturnType<PolymarketClobClientLike['getTrades']>> =
      []
    const { client, calls } = makeFakeClobClient({
      async getTrades() {
        return fakeTrades
      },
    })
    setPolymarketClobClient(client)
    process.env.FLARE_POLYMARKET_LIVE = 'true'

    const startMs = 1_700_000_000_000
    const end5m = startMs + 300_000
    const entryTs = startMs + 120_000 // T-180s
    const h = createMockHarness(entryTs)
    seedOracleBaseline(h.oracleFeed, startMs)
    pushOraclePrices(h.oracleFeed, entryTs, 90_010)

    h.windowsByTf['5m'] = [
      {
        slug: 'btc-updown-5m-live-match',
        timeframe: '5m',
        startTime: startMs,
        endTime: end5m,
        status: 'open',
        question: 'BTC 5m live match?',
        upPriceAtOpen: 0.5,
        upPriceNow: 0.52,
        bestBid: 0.51,
        bestAsk: 0.53,
        resolvedUp: null,
        volume: 50_000,
        resolutionSource: 'chainlink-twap-60s',
        conditionId: '0xcondlm',
        upTokenId: 'tok-lm-yes',
        downTokenId: 'tok-lm-no',
        tickSize: 0.01,
        negRisk: false,
      },
    ]
    h.setTokenBook('tok-lm-yes', 0.51, 0.53, 500)
    h.setTokenBook('tok-lm-no', 0.47, 0.49, 500)

    const runner = new PredictionRunner({
      store: getStateStore(),
      oracleFeed: h.oracleFeed,
      clobBookFeed: h.clobBookFeed,
      collector: h.collector,
      getHourlyCandles: async () => [],
      nowMs: h.nowMs,
    })

    await runner.setPredictionStrategyMode(
      'default',
      'c5-late-favorite',
      'disabled',
    )
    await runner.setPredictionStrategyMode(
      'default',
      'c15-favorite-carry',
      'disabled',
    )
    await runner.setPredictionStrategyMode(
      'default',
      'c1h-exhaustion-limit',
      'disabled',
    )
    await runner.setPredictionStrategyMode(
      'default',
      'c5-15-longshot-fade',
      'disabled',
    )
    await runner.setPredictionStrategyMode(
      'default',
      'c5-nowcast-maker',
      'canary',
      true,
      'Test live GTC match sync',
    )

    // 1. Submits resting GTC LIVE quote
    await runner.runTick()
    expect(calls.limitOrders.length).toBeGreaterThanOrEqual(1)
    let status = await runner.getPredictionEngineStatus('default')
    expect(status.openTrades.length).toBeGreaterThanOrEqual(1)
    const liveTrade = status.openTrades[0]
    expect(liveTrade.venueOrderId).toBeTruthy()
    expect(
      getPolymarketExecutorStatus('default').recentOrders.some(
        (o) =>
          o.venueOrderId === liveTrade.venueOrderId && o.status === 'LIVE',
      ),
    ).toBe(true)

    // 2. +31s later, CLOB reports our maker order matched in getTrades() and mid rises
    const markoutTs = entryTs + 31_000
    h.setNowMs(markoutTs)
    pushOraclePrices(h.oracleFeed, markoutTs, 90_060)
    h.setTokenBook('tok-lm-yes', 0.59, 0.61, 500)
    h.setTokenBook('tok-lm-no', 0.39, 0.41, 500)
    await h.clobBookFeed.hydrateWindow(h.windowsByTf['5m'][0])

    fakeTrades = status.openTrades.map((t, idx) => ({
      id: `trd-live-${idx}`,
      taker_order_id: 'counterparty-taker',
      market: '0xcondlm',
      asset_id: t.outcome === 'YES' ? 'tok-lm-yes' : 'tok-lm-no',
      side: Side.SELL,
      size: String(t.shares),
      fee_rate_bps: '0',
      price: String(t.entryPrice),
      status: 'MATCHED',
      match_time: String(Math.floor((entryTs + 5_000) / 1_000)),
      last_update: String(Math.floor((entryTs + 5_000) / 1_000)),
      outcome: t.outcome === 'YES' ? 'Up' : 'Down',
      bucket_index: 0,
      owner: '0xowner',
      maker_address: '0xmaker',
      maker_orders: [
        {
          order_id: t.venueOrderId!,
          owner: '0xowner',
          maker_address: '0xmaker',
          matched_amount: String(t.shares),
          price: String(t.entryPrice),
          fee_rate_bps: '0',
          asset_id: t.outcome === 'YES' ? 'tok-lm-yes' : 'tok-lm-no',
          outcome: t.outcome === 'YES' ? 'Up' : 'Down',
          side: Side.BUY,
        },
      ],
      transaction_hash: `0xtx-${idx}`,
      trader_side: 'MAKER',
    }))

    await runner.runTick()
    status = await runner.getPredictionEngineStatus('default')
    expect(status.openTrades.every((t) => t.markout30s !== null)).toBe(true)
    expect(calls.canceledIds).toHaveLength(0)

    // 3. Advance past T-20s and window close -> settles instead of canceling
    const closeTs = end5m + 5_000
    h.setNowMs(closeTs)
    pushOraclePrices(h.oracleFeed, closeTs, 90_200)
    h.windowsByTf['5m'][0] = {
      ...h.windowsByTf['5m'][0],
      status: 'closed',
      upPriceNow: null,
      bestBid: null,
      bestAsk: null,
      resolvedUp: true,
    }
    await runner.runTick()

    status = await runner.getPredictionEngineStatus('default')
    expect(status.openTrades).toHaveLength(0)
    expect(status.recentSettledTrades.length).toBeGreaterThanOrEqual(1)
    expect(calls.canceledIds).toHaveLength(0)
    const ledger = getTenantLedgerSnapshot('default')
    expect(ledger.verification.balanced).toBe(true)
    expect(ledger.accountBalances['escrow:prediction:USDT']?.balance).toBe(0)
    expect(
      ledger.entries.some((e) => e.kind === 'PREDICTION_SETTLEMENT'),
    ).toBe(true)
  })

  it('retains OPEN trade and $5 exposure on failed cancelOrdersForWindow and retries on next tick', async () => {
    let failCancel = true
    const { client, calls } = makeFakeClobClient({
      async cancelOrder(payload) {
        if (failCancel) {
          throw new Error('CLOB 503 cancel timeout')
        }
        calls.canceledIds.push(payload.orderID)
        return { canceled: [payload.orderID] }
      },
    })
    setPolymarketClobClient(client)
    process.env.FLARE_POLYMARKET_LIVE = 'true'

    const startMs = 1_700_000_000_000
    const end5m = startMs + 300_000
    const h = createMockHarness(startMs + 120_000)
    seedOracleBaseline(h.oracleFeed, startMs)
    // z ~ 2.43 (<= 2.5) -> pYes ~ 0.992, pNo ~ 0.008 so only YES maker quotes ($5)
    pushOraclePrices(h.oracleFeed, startMs + 120_000, 90_380)

    h.windowsByTf['5m'] = [
      {
        slug: 'btc-updown-5m-cf',
        timeframe: '5m',
        startTime: startMs,
        endTime: end5m,
        status: 'open',
        question: 'BTC 5m cancel fail?',
        upPriceAtOpen: 0.5,
        upPriceNow: 0.97,
        bestBid: 0.96,
        bestAsk: 0.98,
        resolvedUp: null,
        volume: 50_000,
        resolutionSource: 'chainlink-twap-60s',
        conditionId: '0xcondcf',
        upTokenId: 'tok-cf-yes',
        downTokenId: 'tok-cf-no',
        tickSize: 0.01,
        negRisk: false,
      },
    ]
    h.setTokenBook('tok-cf-yes', 0.96, 0.98, 500)
    h.setTokenBook('tok-cf-no', 0.02, 0.04, 20_000)

    const runner = new PredictionRunner({
      store: getStateStore(),
      oracleFeed: h.oracleFeed,
      clobBookFeed: h.clobBookFeed,
      collector: h.collector,
      getHourlyCandles: async () => [],
      nowMs: h.nowMs,
    })
    await runner.setPredictionStrategyMode(
      'default',
      'c5-late-favorite',
      'disabled',
    )
    await runner.setPredictionStrategyMode(
      'default',
      'c15-favorite-carry',
      'disabled',
    )
    await runner.setPredictionStrategyMode(
      'default',
      'c1h-exhaustion-limit',
      'disabled',
    )
    await runner.setPredictionStrategyMode(
      'default',
      'c5-15-longshot-fade',
      'disabled',
    )
    await runner.setPredictionStrategyMode(
      'default',
      'c5-nowcast-maker',
      'canary',
      true,
      'Test cancel failure retry',
    )

    await runner.runTick()
    let status = await runner.getPredictionEngineStatus('default')
    expect(status.openTrades).toHaveLength(1)
    expect(status.canaryRisk.openBtcExposureUsd).toBe(5)

    // T-20s sweep fails -> trade MUST stay OPEN with $5 BTC exposure
    const tMinus20 = end5m - 20_000
    h.setNowMs(tMinus20)
    pushOraclePrices(h.oracleFeed, tMinus20, 90_010)
    await h.clobBookFeed.hydrateWindow(h.windowsByTf['5m'][0])
    await runner.runTick()

    status = await runner.getPredictionEngineStatus('default')
    expect(status.openTrades).toHaveLength(1)
    expect(status.openTrades[0].status).toBe('OPEN')
    expect(status.canaryRisk.openBtcExposureUsd).toBe(5)
    expect(status.lastError).toContain('CLOB 503 cancel timeout')

    // Next tick succeeds -> retries cancel, clears exposure, and releases escrow
    failCancel = false
    const retryTs = tMinus20 + 2_000
    h.setNowMs(retryTs)
    pushOraclePrices(h.oracleFeed, retryTs, 90_010)
    await runner.runTick()

    status = await runner.getPredictionEngineStatus('default')
    expect(status.openTrades).toHaveLength(0)
    expect(status.canaryRisk.openBtcExposureUsd).toBe(0)
    expect(calls.canceledIds).toHaveLength(1)
    const ledger = getTenantLedgerSnapshot('default')
    expect(ledger.walletBalances.USDT).toBe(10_000)
    expect(ledger.accountBalances['escrow:prediction:USDT']?.balance).toBe(0)
  })

  it('hydrates filled <30s paper maker trades and MATCHED canary maker trades across restart without canceling them', async () => {
    const store = getStateStore()
    const startMs = 1_700_000_000_000
    const end5m = startMs + 300_000
    const entryTs = end5m - 45_000 // <30s before T-20s
    const h = createMockHarness(entryTs)
    seedOracleBaseline(h.oracleFeed, startMs)
    pushOraclePrices(h.oracleFeed, entryTs, 90_010)

    await store.upsertPredictionWindow({
      slug: 'btc-updown-5m-rst-mk',
      timeframe: '5m',
      conditionId: '0xcondrm',
      upTokenId: 'tok-rm-yes',
      downTokenId: 'tok-rm-no',
      resolutionSource: 'chainlink-twap-60s',
      startTimeMs: startMs,
      endTimeMs: end5m,
      openTwap: 90_000,
      closeTwap: null,
      resolvedUp: null,
      tickSize: 0.01,
      negRisk: false,
      volumeUsd: 50_000,
      updatedAt: entryTs,
    })

    // Seed filled paper maker trade (<30s old, markout30s === null)
    await store.upsertPredictionTrade({
      id: 'pt-paper-filled-young',
      tenantId: 'default',
      strategyId: 'c5-nowcast-maker',
      lane: 'edge',
      mode: 'paper',
      slug: 'btc-updown-5m-rst-mk',
      timeframe: '5m',
      outcome: 'YES',
      liquidityRole: 'maker',
      entryTimeMs: entryTs,
      entryPrice: 0.52,
      feeUsd: 0,
      stakeUsd: 5,
      shares: 9.6154,
      pModel: 0.56,
      pCalibrated: 0.56,
      markout30s: null,
      resolvedUp: null,
      won: null,
      netPnlUsd: null,
      venueOrderId: 'paper-filled',
      status: 'OPEN',
    })

    // Seed MATCHED canary maker trade (executor state wiped to simulate restart, SQL order is FILLED)
    await store.appendOrder('default', {
      id: 'POLY-uuid-matched',
      clientOrderId: 'pe-c5-nowcast-maker-btc-updown-5m-rst-mk-NO',
      venueOrderId: 'clob-matched-rst',
      timestamp: new Date(entryTs).toISOString(),
      pair: 'btc-updown-5m-rst-mk/NO',
      side: 'BUY',
      notionalUsd: 5,
      price: 0.46,
      quantity: 10.8696,
      status: 'FILLED',
      mode: 'polymarket-clob',
      source: 'bot-auto',
      reason: 'Polymarket CLOB MATCHED (#clob-matched-rst)',
    })
    await store.upsertPredictionTrade({
      id: 'pt-canary-matched-young',
      tenantId: 'default',
      strategyId: 'c5-nowcast-maker',
      lane: 'edge',
      mode: 'canary',
      slug: 'btc-updown-5m-rst-mk',
      timeframe: '5m',
      outcome: 'NO',
      liquidityRole: 'maker',
      entryTimeMs: entryTs,
      entryPrice: 0.46,
      feeUsd: 0,
      stakeUsd: 5,
      shares: 10.8696,
      pModel: 0.5,
      pCalibrated: 0.5,
      markout30s: null,
      resolvedUp: null,
      won: null,
      netPnlUsd: null,
      venueOrderId: 'clob-matched-rst',
      status: 'OPEN',
    })

    const { client, calls } = makeFakeClobClient()
    setPolymarketClobClient(client)
    process.env.FLARE_POLYMARKET_LIVE = 'true'

    h.windowsByTf['5m'] = [
      {
        slug: 'btc-updown-5m-rst-mk',
        timeframe: '5m',
        startTime: startMs,
        endTime: end5m,
        status: 'open',
        question: 'BTC 5m restart?',
        upPriceAtOpen: 0.5,
        upPriceNow: 0.55,
        bestBid: 0.54,
        bestAsk: 0.56,
        resolvedUp: null,
        volume: 50_000,
        resolutionSource: 'chainlink-twap-60s',
        conditionId: '0xcondrm',
        upTokenId: 'tok-rm-yes',
        downTokenId: 'tok-rm-no',
        tickSize: 0.01,
        negRisk: false,
      },
    ]
    h.setTokenBook('tok-rm-yes', 0.54, 0.56, 500)
    h.setTokenBook('tok-rm-no', 0.44, 0.46, 500)

    const restarted = new PredictionRunner({
      store,
      oracleFeed: h.oracleFeed,
      clobBookFeed: h.clobBookFeed,
      collector: h.collector,
      getHourlyCandles: async () => [],
      nowMs: h.nowMs,
    })

    // Advance past T-20s -> neither filled trade may be canceled!
    const tMinus20 = end5m - 20_000
    h.setNowMs(tMinus20)
    pushOraclePrices(h.oracleFeed, tMinus20, 90_020)
    await h.clobBookFeed.hydrateWindow(h.windowsByTf['5m'][0])
    await restarted.runTick()

    expect(calls.canceledIds).toHaveLength(0)
    let status = await restarted.getPredictionEngineStatus('default')
    expect(status.openTrades).toHaveLength(2)

    // Advance past +30s and window close -> both settle!
    const closeTs = end5m + 5_000
    h.setNowMs(closeTs)
    pushOraclePrices(h.oracleFeed, closeTs, 90_200)
    h.windowsByTf['5m'][0] = {
      ...h.windowsByTf['5m'][0],
      status: 'closed',
      upPriceNow: null,
      bestBid: null,
      bestAsk: null,
      resolvedUp: true,
    }
    await restarted.runTick()

    status = await restarted.getPredictionEngineStatus('default')
    expect(status.openTrades).toHaveLength(0)
    expect(status.recentSettledTrades).toHaveLength(2)
    expect(status.recentSettledTrades.every((t) => t.status === 'SETTLED')).toBe(
      true,
    )
  })

  it('preserves cross-midnight UTC daily loss count consistently across live settlement and restart hydration', async () => {
    const { client } = makeFakeClobClient()
    setPolymarketClobClient(client)
    process.env.FLARE_POLYMARKET_LIVE = 'true'

    const startMs = Date.UTC(2025, 0, 15, 23, 55, 30)
    const end5m = Date.UTC(2025, 0, 16, 0, 0, 30) // crosses 00:00Z!
    const entryTs = Date.UTC(2025, 0, 15, 23, 58, 30)
    const h = createMockHarness(entryTs)
    seedOracleBaseline(h.oracleFeed, startMs)
    pushOraclePrices(h.oracleFeed, entryTs, 90_350)

    h.windowsByTf['5m'] = [
      {
        slug: 'btc-updown-5m-midnight',
        timeframe: '5m',
        startTime: startMs,
        endTime: end5m,
        status: 'open',
        question: 'BTC 5m midnight?',
        upPriceAtOpen: 0.5,
        upPriceNow: 0.91,
        bestBid: 0.9,
        bestAsk: 0.92,
        resolvedUp: null,
        volume: 50_000,
        resolutionSource: 'chainlink-twap-60s',
        conditionId: '0xcondmid',
        upTokenId: 'tok-mid-yes',
        downTokenId: 'tok-mid-no',
        tickSize: 0.01,
        negRisk: false,
      },
    ]
    h.setTokenBook('tok-mid-yes', 0.9, 0.92, 500)
    h.setTokenBook('tok-mid-no', 0.08, 0.1, 3_000)

    const runner = new PredictionRunner({
      store: getStateStore(),
      oracleFeed: h.oracleFeed,
      clobBookFeed: h.clobBookFeed,
      collector: h.collector,
      getHourlyCandles: async () => [],
      nowMs: h.nowMs,
    })
    await runner.setPredictionStrategyMode(
      'default',
      'c5-nowcast-maker',
      'disabled',
    )
    await runner.setPredictionStrategyMode(
      'default',
      'c5-15-longshot-fade',
      'disabled',
    )
    await runner.setPredictionStrategyMode(
      'default',
      'c5-late-favorite',
      'canary',
      true,
      'Midnight test',
    )

    await runner.runTick()
    let status = await runner.getPredictionEngineStatus('default')
    expect(status.openTrades).toHaveLength(1)

    // Settle as loss at 00:00:35Z on Day 2
    const settleTs = end5m + 5_000
    h.setNowMs(settleTs)
    pushOraclePrices(h.oracleFeed, settleTs, 89_800)
    h.windowsByTf['5m'][0] = {
      ...h.windowsByTf['5m'][0],
      status: 'closed',
      upPriceNow: null,
      bestBid: null,
      bestAsk: null,
      resolvedUp: false,
    }
    await runner.runTick()

    status = await runner.getPredictionEngineStatus('default')
    expect(status.canaryRisk.todayLossesCount).toBe(1)
    expect(status.canaryRisk.todayLossUsd).toBeGreaterThan(0)

    // Restart on Day 2 -> must still see todayLossesCount === 1
    h.setNowMs(Date.UTC(2025, 0, 16, 0, 5, 0))
    const restarted = new PredictionRunner({
      store: getStateStore(),
      oracleFeed: h.oracleFeed,
      clobBookFeed: h.clobBookFeed,
      collector: h.collector,
      getHourlyCandles: async () => [],
      nowMs: h.nowMs,
    })
    const restartedStatus = await restarted.getPredictionEngineStatus('default')
    expect(restartedStatus.canaryRisk.todayLossesCount).toBe(1)
    expect(restartedStatus.canaryRisk.todayLossUsd).toBe(
      status.canaryRisk.todayLossUsd,
    )
  })

  it('refreshes replay inside setPredictionStrategyMode when promoting after an earlier cached <500 report', async () => {
    const store = getStateStore()
    const baseMs = 1_700_000_000_000

    const seedWinningWindows = async (fromIdx: number, toIdx: number) => {
      for (let i = fromIdx; i < toIdx; i += 1) {
        const start = baseMs + i * 300_000
        const end = start + 300_000
        const slug = `btc-updown-5m-promo-${i}`
        await store.upsertPredictionWindow({
          slug,
          timeframe: '5m',
          conditionId: `0xpromo${i}`,
          upTokenId: `p-up-${i}`,
          downTokenId: `p-dn-${i}`,
          resolutionSource: 'chainlink-twap-60s',
          startTimeMs: start,
          endTimeMs: end,
          openTwap: 90_000,
          closeTwap: 90_400,
          resolvedUp: true,
          tickSize: 0.01,
          negRisk: false,
          volumeUsd: 50_000,
          updatedAt: end,
        })
        await store.appendPredictionSnapshot({
          slug,
          capturedAtMs: end - 90_000,
          secondsRemaining: 90,
          twapPrice: 90_350,
          binancePrice: 90_350,
          sigma1m: 0.0005,
          basisBps: 1,
          yesBid: 0.88,
          yesAsk: 0.9,
          yesDepthUsd: 500,
          noBid: 0.09,
          noAsk: 0.11,
          noDepthUsd: 2_000,
          pModelYes: 0.96,
        })
        await store.appendPredictionSnapshot({
          slug,
          capturedAtMs: end - 55_000,
          secondsRemaining: 55,
          twapPrice: 90_400,
          binancePrice: 90_400,
          sigma1m: 0.0005,
          basisBps: 1,
          yesBid: 0.92,
          yesAsk: 0.94,
          yesDepthUsd: 500,
          noBid: 0.05,
          noAsk: 0.07,
          noDepthUsd: 2_000,
          pModelYes: 0.98,
        })
      }
    }

    await seedWinningWindows(0, 100)
    const h = createMockHarness(baseMs + 500 * 300_000)
    const runner = new PredictionRunner({
      store,
      oracleFeed: h.oracleFeed,
      clobBookFeed: h.clobBookFeed,
      collector: h.collector,
      getHourlyCandles: async () => [],
      nowMs: h.nowMs,
    })

    // Cache <500 replay report first
    const earlyReplay = await runner.runStrategyReplay('c5-late-favorite')
    expect(earlyReplay.settledWindowCount).toBe(100)
    expect(earlyReplay.eligibleForCanary).toBe(false)

    const earlyPromo = await runner.setPredictionStrategyMode(
      'default',
      'c5-late-favorite',
      'canary',
    )
    expect(earlyPromo.allowed).toBe(false)

    // Seed 400 more winning windows (total = 500) and promote WITHOUT calling runStrategyReplay manually
    await seedWinningWindows(100, 500)
    const promoted = await runner.setPredictionStrategyMode(
      'default',
      'c5-late-favorite',
      'canary',
    )
    expect(promoted.allowed).toBe(true)
    expect(promoted.state.mode).toBe('canary')
  })

  it('uses newest 2,000 settled windows (order: desc) in maybeRecalibrate when >2,000 windows exist', async () => {
    const store = getStateStore()
    const baseMs = 1_700_000_000_000

    // Seed 2,025 settled windows: oldest 25 have 0 snapshots, newest 2,000 have 1 snapshot each.
    // With order:'asc' (0..1999), sampleCount would be 1,975; with order:'desc' (25..2024), sampleCount is 2,000.
    for (let i = 0; i < 2_025; i += 1) {
      const start = baseMs + i * 300_000
      const end = start + 300_000
      const slug = `btc-updown-5m-cal-${i}`
      await store.upsertPredictionWindow({
        slug,
        timeframe: '5m',
        conditionId: `0xcal${i}`,
        upTokenId: `c-up-${i}`,
        downTokenId: `c-dn-${i}`,
        resolutionSource: 'chainlink-twap-60s',
        startTimeMs: start,
        endTimeMs: end,
        openTwap: 90_000,
        closeTwap: i % 2 === 0 ? 90_200 : 89_800,
        resolvedUp: i % 2 === 0,
        tickSize: 0.01,
        negRisk: false,
        volumeUsd: 40_000,
        updatedAt: end,
      })
      if (i >= 25) {
        await store.appendPredictionSnapshot({
          slug,
          capturedAtMs: start + 180_000,
          secondsRemaining: 120,
          twapPrice: i % 2 === 0 ? 90_200 : 89_800,
          binancePrice: i % 2 === 0 ? 90_200 : 89_800,
          sigma1m: 0.0005,
          basisBps: 1,
          yesBid: 0.5,
          yesAsk: 0.52,
          yesDepthUsd: 400,
          noBid: 0.48,
          noAsk: 0.5,
          noDepthUsd: 400,
          pModelYes: i % 2 === 0 ? 0.8 : 0.2,
        })
      }
    }

    const h = createMockHarness(baseMs + 2_025 * 300_000)
    const runner = new PredictionRunner({
      store,
      oracleFeed: h.oracleFeed,
      clobBookFeed: h.clobBookFeed,
      collector: h.collector,
      getHourlyCandles: async () => [],
      nowMs: h.nowMs,
    })

    await runner.runTick()
    const status = await runner.getPredictionEngineStatus('default')
    expect(status.calibrators['5m'].lastSettledCount).toBe(2_000)
    expect(status.calibrators['5m'].sampleCount).toBe(2_000)
  })

  it('scores cx-nested-coherence parent-leg replay trades against the target parent window outcome', async () => {
    const store = getStateStore()
    const baseMs = 1_700_000_000_000

    // Seed 4 pairs of (5m child resolvedUp=false, 15m parent resolvedUp=true)
    // where parent YES is severely underpriced (ask=0.26 vs pParentYes=0.50 -> parent leg BUY YES)
    for (let i = 0; i < 4; i += 1) {
      const start = baseMs + i * 900_000
      const end5m = start + 300_000
      const end15m = start + 900_000
      const snapTs = start + 120_000
      const markoutTs = start + 155_000

      const childSlug = `btc-updown-5m-nc-${i}`
      const parentSlug = `btc-updown-15m-nc-${i}`

      await store.upsertPredictionWindow({
        slug: childSlug,
        timeframe: '5m',
        conditionId: `0xnc5-${i}`,
        upTokenId: `nc5-up-${i}`,
        downTokenId: `nc5-dn-${i}`,
        resolutionSource: 'chainlink-twap-60s',
        startTimeMs: start,
        endTimeMs: end5m,
        openTwap: 90_000,
        closeTwap: 89_800,
        resolvedUp: false,
        tickSize: 0.01,
        negRisk: false,
        volumeUsd: 50_000,
        updatedAt: end5m,
      })
      await store.appendPredictionSnapshot({
        slug: childSlug,
        capturedAtMs: snapTs,
        secondsRemaining: 180,
        twapPrice: 90_000,
        binancePrice: 90_000,
        sigma1m: 0.0005,
        basisBps: 1,
        yesBid: 0.39,
        yesAsk: 0.41,
        yesDepthUsd: 500,
        noBid: 0.59,
        noAsk: 0.61,
        noDepthUsd: 500,
        pModelYes: 0.5,
      })

      await store.upsertPredictionWindow({
        slug: parentSlug,
        timeframe: '15m',
        conditionId: `0xnc15-${i}`,
        upTokenId: `nc15-up-${i}`,
        downTokenId: `nc15-dn-${i}`,
        resolutionSource: 'chainlink-twap-60s',
        startTimeMs: start,
        endTimeMs: end15m,
        openTwap: 90_000,
        closeTwap: 90_300,
        resolvedUp: true,
        tickSize: 0.01,
        negRisk: false,
        volumeUsd: 80_000,
        updatedAt: end15m,
      })
      await store.appendPredictionSnapshot({
        slug: parentSlug,
        capturedAtMs: snapTs,
        secondsRemaining: 780,
        twapPrice: 90_000,
        binancePrice: 90_000,
        sigma1m: 0.0005,
        basisBps: 1,
        yesBid: 0.24,
        yesAsk: 0.26,
        yesDepthUsd: 500,
        noBid: 0.74,
        noAsk: 0.76,
        noDepthUsd: 500,
        pModelYes: 0.5,
      })
      await store.appendPredictionSnapshot({
        slug: parentSlug,
        capturedAtMs: markoutTs,
        secondsRemaining: 745,
        twapPrice: 90_050,
        binancePrice: 90_050,
        sigma1m: 0.0005,
        basisBps: 1,
        yesBid: 0.48,
        yesAsk: 0.5,
        yesDepthUsd: 500,
        noBid: 0.5,
        noAsk: 0.52,
        noDepthUsd: 500,
        pModelYes: 0.55,
      })
    }

    const h = createMockHarness(baseMs + 4 * 900_000)
    const runner = new PredictionRunner({
      store,
      oracleFeed: h.oracleFeed,
      clobBookFeed: h.clobBookFeed,
      collector: h.collector,
      getHourlyCandles: async () => [],
      nowMs: h.nowMs,
    })

    const replay = await runner.runStrategyReplay('cx-nested-coherence')
    expect(replay.tradeCount).toBeGreaterThanOrEqual(1)
    for (const tr of replay.trades) {
      expect(tr.timeframe).toBe('15m')
      expect(tr.slug).toMatch(/^btc-updown-15m-nc-/)
      expect(tr.outcome).toBe('YES')
      expect(tr.resolvedUp).toBe(true)
      expect(tr.won).toBe(true)
      expect(tr.netPnlUsd).toBeGreaterThan(0)
      expect(tr.markout30s).toBeGreaterThan(0)
    }
  })

  it('recovers cleanly when deterministic live clientOrderId hits REJECTED then retries to LIVE, syncs to MATCHED, and settles without execByClientId overwrite', async () => {
    let failFirstOrder = true
    let fakeTrades: Awaited<ReturnType<PolymarketClobClientLike['getTrades']>> =
      []
    const { client, calls } = makeFakeClobClient({
      async createAndPostOrder(order, opts, orderType, deferExec, postOnly) {
        calls.limitOrders.push({ order, opts, orderType, deferExec, postOnly })
        if (failFirstOrder) {
          failFirstOrder = false
          return { success: false, errorMsg: 'Transient CLOB rejection' }
        }
        return {
          success: true,
          orderID: 'clob-lmt-retry-live',
          status: 'LIVE',
        }
      },
      async getTrades() {
        return fakeTrades
      },
    })
    setPolymarketClobClient(client)
    process.env.FLARE_POLYMARKET_LIVE = 'true'

    const startMs = 1_700_000_000_000
    const end5m = startMs + 300_000
    const tick1Ts = startMs + 120_000 // T-180s
    const h = createMockHarness(tick1Ts)
    seedOracleBaseline(h.oracleFeed, startMs)
    // z ~ 2.43 (<= 2.5) -> only YES maker quotes ($5)
    pushOraclePrices(h.oracleFeed, tick1Ts, 90_380)

    h.windowsByTf['5m'] = [
      {
        slug: 'btc-updown-5m-retry-flow',
        timeframe: '5m',
        startTime: startMs,
        endTime: end5m,
        status: 'open',
        question: 'BTC 5m retry flow?',
        upPriceAtOpen: 0.5,
        upPriceNow: 0.97,
        bestBid: 0.96,
        bestAsk: 0.98,
        resolvedUp: null,
        volume: 50_000,
        resolutionSource: 'chainlink-twap-60s',
        conditionId: '0xcondretry',
        upTokenId: 'tok-rt-yes',
        downTokenId: 'tok-rt-no',
        tickSize: 0.01,
        negRisk: false,
      },
    ]
    h.setTokenBook('tok-rt-yes', 0.96, 0.98, 500)
    h.setTokenBook('tok-rt-no', 0.02, 0.04, 20_000)

    const runner = new PredictionRunner({
      store: getStateStore(),
      oracleFeed: h.oracleFeed,
      clobBookFeed: h.clobBookFeed,
      collector: h.collector,
      getHourlyCandles: async () => [],
      nowMs: h.nowMs,
    })

    await runner.setPredictionStrategyMode(
      'default',
      'c5-late-favorite',
      'disabled',
    )
    await runner.setPredictionStrategyMode(
      'default',
      'c15-favorite-carry',
      'disabled',
    )
    await runner.setPredictionStrategyMode(
      'default',
      'c1h-exhaustion-limit',
      'disabled',
    )
    await runner.setPredictionStrategyMode(
      'default',
      'c5-15-longshot-fade',
      'disabled',
    )
    await runner.setPredictionStrategyMode(
      'default',
      'c5-nowcast-maker',
      'canary',
      true,
      'Test REJECTED retry recovery',
    )

    // Tick 1: pre-flight/CLOB returns REJECTED -> trade is NOT opened yet
    await runner.runTick()
    let status = await runner.getPredictionEngineStatus('default')
    expect(status.openTrades).toHaveLength(0)
    expect(
      getPolymarketExecutorStatus('default').recentOrders.find(
        (o) =>
          o.clientOrderId ===
          'pe-c5-nowcast-maker-btc-updown-5m-retry-flow-YES',
      )?.status,
    ).toBe('REJECTED')

    // Tick 2 (+1.5s): retry with same deterministic clientOrderId succeeds -> LIVE
    const tick2Ts = tick1Ts + 1_500
    h.setNowMs(tick2Ts)
    pushOraclePrices(h.oracleFeed, tick2Ts, 90_380)
    await h.clobBookFeed.hydrateWindow(h.windowsByTf['5m'][0])
    await runner.runTick()

    status = await runner.getPredictionEngineStatus('default')
    expect(status.openTrades).toHaveLength(1)
    expect(status.openTrades[0].venueOrderId).toBe('clob-lmt-retry-live')

    const matchingExecOrders = getPolymarketExecutorStatus(
      'default',
    ).recentOrders.filter(
      (o) =>
        o.clientOrderId === 'pe-c5-nowcast-maker-btc-updown-5m-retry-flow-YES',
    )
    expect(matchingExecOrders).toHaveLength(1)
    expect(matchingExecOrders[0].status).toBe('LIVE')

    // Tick 3 (+31s): CLOB matches maker order via getTrades() -> MATCHED, captures markout, skips T-20s cancel
    const markoutTs = tick2Ts + 31_000
    h.setNowMs(markoutTs)
    pushOraclePrices(h.oracleFeed, markoutTs, 90_390)
    h.setTokenBook('tok-rt-yes', 0.97, 0.99, 500)
    h.setTokenBook('tok-rt-no', 0.01, 0.03, 20_000)
    await h.clobBookFeed.hydrateWindow(h.windowsByTf['5m'][0])

    fakeTrades = [
      {
        id: 'trd-retry-flow',
        taker_order_id: 'counterparty-taker',
        market: '0xcondretry',
        asset_id: 'tok-rt-yes',
        side: Side.SELL,
        size: String(status.openTrades[0].shares),
        fee_rate_bps: '0',
        price: String(status.openTrades[0].entryPrice),
        status: 'MATCHED',
        match_time: String(Math.floor((tick2Ts + 5_000) / 1_000)),
        last_update: String(Math.floor((tick2Ts + 5_000) / 1_000)),
        outcome: 'Up',
        bucket_index: 0,
        owner: '0xowner',
        maker_address: '0xmaker',
        maker_orders: [
          {
            order_id: 'clob-lmt-retry-live',
            owner: '0xowner',
            maker_address: '0xmaker',
            matched_amount: String(status.openTrades[0].shares),
            price: String(status.openTrades[0].entryPrice),
            fee_rate_bps: '0',
            asset_id: 'tok-rt-yes',
            outcome: 'Up',
            side: Side.BUY,
          },
        ],
        transaction_hash: '0xretryflowtx',
        trader_side: 'MAKER',
      },
    ]

    // Restarted runner must hydrate MATCHED (not REJECTED), capture markout, and avoid canceling at T-20s
    const restarted = new PredictionRunner({
      store: getStateStore(),
      oracleFeed: h.oracleFeed,
      clobBookFeed: h.clobBookFeed,
      collector: h.collector,
      getHourlyCandles: async () => [],
      nowMs: h.nowMs,
    })

    await restarted.runTick()
    status = await restarted.getPredictionEngineStatus('default')
    expect(status.openTrades).toHaveLength(1)
    expect(status.openTrades[0].markout30s).not.toBeNull()
    expect(calls.canceledIds).toHaveLength(0)

    // Tick 4: advance past T-20s and close window -> settles cleanly with balanced ledger
    const closeTs = end5m + 5_000
    h.setNowMs(closeTs)
    pushOraclePrices(h.oracleFeed, closeTs, 90_420)
    h.windowsByTf['5m'][0] = {
      ...h.windowsByTf['5m'][0],
      status: 'closed',
      upPriceNow: null,
      bestBid: null,
      bestAsk: null,
      resolvedUp: true,
    }
    await restarted.runTick()

    status = await restarted.getPredictionEngineStatus('default')
    expect(status.openTrades).toHaveLength(0)
    expect(status.recentSettledTrades).toHaveLength(1)
    expect(status.recentSettledTrades[0].status).toBe('SETTLED')
    expect(status.recentSettledTrades[0].won).toBe(true)
    expect(calls.canceledIds).toHaveLength(0)

    const ledger = getTenantLedgerSnapshot('default')
    expect(ledger.verification.balanced).toBe(true)
    expect(ledger.accountBalances['escrow:prediction:USDT']?.balance).toBe(0)
    expect(
      ledger.entries.some((e) => e.kind === 'PREDICTION_SETTLEMENT'),
    ).toBe(true)
  })
})
