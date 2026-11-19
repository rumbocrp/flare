import { afterEach, describe, expect, it } from 'vitest'
import { syntheticSource } from '../../market/synthetic'
import { DEFAULT_SIMULATION_CONFIG } from '../../predictionMarket'
import { defaultSignalParams } from '../../signals'
import {
  runBacktestOffloaded,
  runPredictionSimOffloaded,
} from '../../workers/backtestClient'
import {
  SharedMarketDataGateway,
  type MarketGatewayEvent,
  type WebSocketLike,
} from './marketGateway'

class FakeWebSocket implements WebSocketLike {
  readyState = 0
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  closed = false
  readonly url: string

  constructor(url: string) {
    this.url = url
  }

  emitOpen(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  emitKline(bar: {
    t: number
    o: number
    h: number
    l: number
    c: number
    v: number
    x: boolean
  }): void {
    this.onmessage?.({
      data: JSON.stringify({
        k: {
          t: bar.t,
          o: String(bar.o),
          h: String(bar.h),
          l: String(bar.l),
          c: String(bar.c),
          v: String(bar.v),
          x: bar.x,
        },
      }),
    })
  }

  close(): void {
    this.closed = true
    this.readyState = 3
  }
}

describe('P1-1 Shared Market-Data Gateway & Web Worker Backtest Offload', () => {
  const gateways: SharedMarketDataGateway[] = []

  afterEach(() => {
    for (const gw of gateways) gw.closeAll()
    gateways.length = 0
  })

  it('multiplexes multiple subscribers onto a single upstream WebSocket and tears down cleanly when idle', () => {
    const sockets: FakeWebSocket[] = []
    const gw = new SharedMarketDataGateway((url) => {
      const ws = new FakeWebSocket(url)
      sockets.push(ws)
      return ws
    })
    gateways.push(gw)

    const seenA: MarketGatewayEvent[] = []
    const seenB: MarketGatewayEvent[] = []
    const seenC: MarketGatewayEvent[] = []

    const unsubA = gw.subscribe('BTC/USDT', '15m', (e) => seenA.push(e))
    const unsubB = gw.subscribe('BTC/USDT', '15m', (e) => seenB.push(e))
    const unsubC = gw.subscribe('BTC/USDT', '15m', (e) => seenC.push(e))

    expect(sockets).toHaveLength(1)
    expect(sockets[0].url).toContain('btcusdt@kline_15m')
    expect(gw.getMetrics()).toMatchObject({
      activeChannels: 1,
      totalSubscribers: 3,
      upstreamConnects: 1,
    })

    sockets[0].emitOpen()
    sockets[0].emitKline({
      t: 1_700_000_000_000,
      o: 80_000,
      h: 80_500,
      l: 79_900,
      c: 80_400,
      v: 42,
      x: true,
    })

    expect(seenA.some((e) => e.type === 'candle' && e.candle.close === 80_400)).toBe(true)
    expect(seenB.some((e) => e.type === 'candle' && e.candle.close === 80_400)).toBe(true)
    expect(seenC.some((e) => e.type === 'candle' && e.candle.close === 80_400)).toBe(true)

    // Detecting a multi-bar timestamp gap flags gapRecovered on event
    sockets[0].emitKline({
      t: 1_700_000_000_000 + 3 * 15 * 60_000,
      o: 80_400,
      h: 80_800,
      l: 80_300,
      c: 80_750,
      v: 50,
      x: false,
    })
    expect(
      seenA.some((e) => e.type === 'candle' && e.gapRecovered === true),
    ).toBe(true)

    unsubA()
    unsubB()
    expect(sockets[0].closed).toBe(false)
    unsubC()
    expect(sockets[0].closed).toBe(true)
    expect(gw.getMetrics().activeChannels).toBe(0)
  })

  it('runs backtests and prediction simulations through the async offload client with abort support', async () => {
    const candles = await syntheticSource.getCandles({
      pair: 'BTC/USDT',
      interval: '1h',
      limit: 240,
    })

    const bt = await runBacktestOffloaded(candles, {
      pair: 'BTC/USDT',
      params: defaultSignalParams,
      strategy: {
        positionSize: 10,
        stopLoss: 2,
        takeProfit: 4,
        maxDailyRisk: 5,
      },
      settings: {
        initialBalance: 10_000,
        commissionPct: 0.1,
        slippagePct: 0,
        allowShort: false,
      },
    })
    expect(bt.result.initialBalance).toBe(10_000)
    expect(bt.result.equity.length).toBeGreaterThan(0)
    expect(bt.durationMs).toBeGreaterThanOrEqual(0)

    const sim = await runPredictionSimOffloaded({
      candles,
      ruleFamily: 'bitcoin20',
      timeframe: '1h',
      config: DEFAULT_SIMULATION_CONFIG,
    })
    expect(sim.result.metrics.finalBankroll).toBeGreaterThanOrEqual(0)

    const aborted = new AbortController()
    aborted.abort()
    await expect(
      runBacktestOffloaded(
        candles,
        {
          pair: 'BTC/USDT',
          params: defaultSignalParams,
          strategy: {
            positionSize: 10,
            stopLoss: 2,
            takeProfit: 4,
            maxDailyRisk: 5,
          },
          settings: {
            initialBalance: 10_000,
            commissionPct: 0.1,
            slippagePct: 0,
            allowShort: false,
          },
        },
        aborted.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
