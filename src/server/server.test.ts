import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { STRATEGY_PRESETS, createInitialBotState } from '../botEngine'
import {
  clearCandleCache,
  fetchOptimizedCandles,
  getCacheMetrics,
} from './candleCache'
import {
  flushStatePersistence,
  flushStateToDiskSync,
  getBotStatusSnapshot,
  getTelemetry,
  handleBotApiRequest,
  loadStateFromDisk,
  stopBackgroundWorker,
} from './botRuntime'
import {
  getExchangeStatusSnapshot,
  resetEmergencyKillSwitch,
  resetExchangeDemoVault,
  submitExchangeOrder,
  triggerEmergencyKillSwitch,
  updateHardRiskLimits,
} from './exchangeAdapter'
import {
  buildMt5SignalPacket,
  getMt5BridgeSnapshot,
  registerMt5Poll,
  resetMt5BridgeTelemetry,
  toMt5Symbol,
} from './mt5Bridge'

describe('Backend Server Optimization & Runtime (candleCache + botRuntime + exchangeAdapter + mt5Bridge)', () => {
  const previousStateFileEnv = process.env.FLARE_STATE_FILE
  let tempTestDir = ''

  beforeAll(() => {
    tempTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-server-test-'))
    process.env.FLARE_STATE_FILE = path.join(tempTestDir, 'bot-state.json')
    resetExchangeDemoVault()
    resetMt5BridgeTelemetry()
  })
  it('caches candles with TTL and deduplicates concurrent calls to raise hit rate', async () => {
    clearCandleCache()

    // Two simultaneous requests for the same pair/interval coalesce into a single fetch
    const [res1, res2] = await Promise.all([
      fetchOptimizedCandles('BTC/USDT', '15m', 120),
      fetchOptimizedCandles('BTC/USDT', '15m', 120),
    ])

    expect(res1.candles.length).toBeGreaterThanOrEqual(60)
    expect(res2.candles.length).toBe(res1.candles.length)

    // A third call within TTL must be served from memory in 0ms
    const res3 = await fetchOptimizedCandles('BTC/USDT', '15m', 120)
    expect(res3.latencyMs).toBe(0)

    const metrics = getCacheMetrics()
    expect(metrics.hits).toBeGreaterThanOrEqual(1)
    expect(metrics.coalescedRequests).toBeGreaterThanOrEqual(1)
    expect(metrics.hitRatePct).toBeGreaterThan(0)
  })

  it('exposes full bot snapshot with 8 presets, telemetry, demo exchange, and MT5 bridge', () => {
    const snap = getBotStatusSnapshot()
    expect(snap.presets.length).toBe(8)
    expect(snap.preset.id).toBeTruthy()
    expect(snap.state.balance).toBeGreaterThan(0)
    expect(snap.exchange).toBeDefined()
    expect(snap.exchange.hardLimits.maxOrderNotionalUsd).toBeGreaterThan(0)
    expect(snap.mt5).toBeDefined()
    expect(snap.mt5.magicNumber).toBe(202615)

    const telemetry = getTelemetry()
    expect(telemetry.uptimeSec).toBeGreaterThanOrEqual(0)
    expect(telemetry.cache.activeCacheEntries).toBeGreaterThanOrEqual(0)
  })

  it('executes compliant orders in Demo Vault and rejects orders exceeding Hard Risk Limits', async () => {
    resetExchangeDemoVault()
    updateHardRiskLimits({ maxOrderNotionalUsd: 500 })

    // 1. Order within cap ($150 <= $500) -> FILLED
    const okRes = await submitExchangeOrder({
      pair: 'BTC/USDT',
      side: 'BUY',
      notionalUsd: 150,
      referencePrice: 85000,
    })
    expect(okRes.ok).toBe(true)
    expect(okRes.order.status).toBe('FILLED')
    expect(okRes.snapshot.dailyOrderCount).toBe(1)

    // 2. Order exceeding hard limit ($950 > $500) -> REJECTED_RISK
    const rejectedRes = await submitExchangeOrder({
      pair: 'BTC/USDT',
      side: 'BUY',
      notionalUsd: 950,
      referencePrice: 85000,
    })
    expect(rejectedRes.ok).toBe(false)
    expect(rejectedRes.order.status).toBe('REJECTED_RISK')
    expect(rejectedRes.error).toContain('hard risk limit')
  })

  it('engages emergency Kill-Switch, blocks new orders, and allows operator reset', async () => {
    resetExchangeDemoVault()

    let haltedCalled = false
    const killSnap = await triggerEmergencyKillSwitch(
      'Emergency integration test',
      () => {
        haltedCalled = true
      },
    )
    expect(haltedCalled).toBe(true)
    expect(killSnap.killSwitchActive).toBe(true)

    // While Kill-Switch is active, even a small order ($50) is rejected
    const blockedRes = await submitExchangeOrder({
      pair: 'ETH/USDT',
      side: 'BUY',
      notionalUsd: 50,
      referencePrice: 2800,
    })
    expect(blockedRes.ok).toBe(false)
    expect(blockedRes.order.status).toBe('REJECTED_RISK')
    expect(blockedRes.error).toContain('Kill-Switch')

    // Resetting Kill-Switch unlocks trading
    const rearmedSnap = resetEmergencyKillSwitch()
    expect(rearmedSnap.killSwitchActive).toBe(false)

    const afterRearmRes = await submitExchangeOrder({
      pair: 'ETH/USDT',
      side: 'BUY',
      notionalUsd: 50,
      referencePrice: 2800,
    })
    expect(afterRearmRes.ok).toBe(true)
    expect(afterRearmRes.order.status).toBe('FILLED')
  })

  it('builds MQL5 signal payloads (BUY, HOLD, CLOSE_ALL via Kill-Switch) and records MT5 polls', async () => {
    resetExchangeDemoVault()
    resetMt5BridgeTelemetry()

    expect(toMt5Symbol('BTC/USDT')).toBe('BTCUSD')
    expect(toMt5Symbol('ETH/USDT')).toBe('ETHUSD')

    const preset = STRATEGY_PRESETS[0]
    const initialState = createInitialBotState(preset)

    // 1. No open position -> HOLD
    const holdPacket = registerMt5Poll(
      initialState,
      preset,
      getExchangeStatusSnapshot(),
      { terminal: 'MT5-Test', symbol: 'BTCUSD' },
    )
    expect(holdPacket.action).toBe('HOLD')
    expect(holdPacket.symbol).toBe('BTCUSD')
    expect(holdPacket.magicNumber).toBe(202615)

    // 2. Open position with Profit-Lock armed -> BUY + breakevenArmed
    const buyState = {
      ...initialState,
      openPosition: {
        side: 'buy' as const,
        pair: 'BTC/USDT',
        entryPrice: 84000,
        entryTime: 1700000000000,
        quantity: 0.01,
        notional: 840,
        entryFee: 0.5,
        stopPrice: 84300,
        targetPrice: 85500,
        breakevenArmed: true,
      },
    }
    const buyPacket = buildMt5SignalPacket(
      buyState,
      preset,
      getExchangeStatusSnapshot(),
    )
    expect(buyPacket.action).toBe('BUY')
    expect(buyPacket.breakevenArmed).toBe(true)
    expect(buyPacket.stopPrice).toBe(84300)

    // 3. With Kill-Switch active -> immediate CLOSE_ALL on MT5
    await triggerEmergencyKillSwitch('MT5 Emergency Close Test')
    const killPacket = buildMt5SignalPacket(
      buyState,
      preset,
      getExchangeStatusSnapshot(),
    )
    expect(killPacket.action).toBe('CLOSE_ALL')
    expect(killPacket.killSwitchActive).toBe(true)

    resetExchangeDemoVault()
  })

  it('rejects oversized JSON request bodies with HTTP 413', async () => {
    const req = Readable.from([
      Buffer.from(JSON.stringify({ padding: 'x'.repeat(70_000) })),
    ]) as unknown as http.IncomingMessage
    req.method = 'POST'
    req.url = '/api/bot/preset'

    let statusCode = 0
    let body = ''
    const res = {
      writeHead(status: number) {
        statusCode = status
      },
      end(chunk?: string) {
        body = chunk ?? ''
      },
    } as unknown as http.ServerResponse

    const handled = await handleBotApiRequest(req, res)
    expect(handled).toBe(true)
    expect(statusCode).toBe(413)
    expect(body).toContain('64 KB')
  })

  it('clamps out-of-range candle limit parameters safely', async () => {
    clearCandleCache()
    const [tiny, huge] = await Promise.all([
      fetchOptimizedCandles('BTC/USDT', '15m', -50),
      fetchOptimizedCandles('BTC/USDT', '15m', 50_000),
    ])
    expect(tiny.candles.length).toBeGreaterThanOrEqual(1)
    expect(huge.candles.length).toBeLessThanOrEqual(1_000)
  })

  it('authorizes XRP/USDT and DOGE/USDT by default and deduplicates idempotent clientOrderId orders', async () => {
    resetExchangeDemoVault()
    const initSnap = getExchangeStatusSnapshot()
    expect(initSnap.hardLimits.allowedPairs).toEqual(
      expect.arrayContaining([
        'BTC/USDT',
        'ETH/USDT',
        'SOL/USDT',
        'XRP/USDT',
        'DOGE/USDT',
      ]),
    )

    const xrpOrder = await submitExchangeOrder({
      pair: 'XRP/USDT',
      side: 'BUY',
      notionalUsd: 25,
      referencePrice: 2.5,
      clientOrderId: 'cid-xrp-1',
    })
    expect(xrpOrder.ok).toBe(true)
    expect(xrpOrder.order.status).toBe('FILLED')
    expect(
      xrpOrder.snapshot.balances.find((b) => b.asset === 'XRP')?.free,
    ).toBeCloseTo(510, 6)

    const dogeOrder = await submitExchangeOrder({
      pair: 'DOGE/USDT',
      side: 'BUY',
      notionalUsd: 25,
      referencePrice: 0.25,
      clientOrderId: 'cid-doge-1',
    })
    expect(dogeOrder.ok).toBe(true)
    expect(dogeOrder.order.status).toBe('FILLED')
    expect(
      dogeOrder.snapshot.balances.find((b) => b.asset === 'DOGE')?.free,
    ).toBeCloseTo(2_600, 6)

    const firstIdem = await submitExchangeOrder({
      pair: 'BTC/USDT',
      side: 'BUY',
      notionalUsd: 50,
      referencePrice: 50_000,
      clientOrderId: 'cid-idem-btc',
    })
    const secondIdem = await submitExchangeOrder({
      pair: 'BTC/USDT',
      side: 'BUY',
      notionalUsd: 50,
      referencePrice: 50_000,
      clientOrderId: 'cid-idem-btc',
    })
    expect(firstIdem.ok).toBe(true)
    expect(secondIdem.order.id).toBe(firstIdem.order.id)
    expect(secondIdem.snapshot.dailyOrderCount).toBe(3)
    expect(
      secondIdem.snapshot.balances.find((b) => b.asset === 'USDT')?.free,
    ).toBeCloseTo(9_900, 2)
  })

  it('reconciles Binance Spot Testnet fills and rejects unacknowledged or HTTP-error responses', async () => {
    resetExchangeDemoVault()
    const prevKey = process.env.BINANCE_TESTNET_KEY
    const prevSecret = process.env.BINANCE_TESTNET_SECRET
    process.env.BINANCE_TESTNET_KEY = 'testnet-key-123456'
    process.env.BINANCE_TESTNET_SECRET = 'testnet-secret-123456'

    try {
      const rejected = await submitExchangeOrder({
        pair: 'BTC/USDT',
        side: 'BUY',
        notionalUsd: 100,
        referencePrice: 50_000,
        clientOrderId: 'cid-testnet-fail',
        fetchImpl: (async () => ({
          ok: false,
          status: 400,
          json: async () => ({ msg: 'Insufficient balance' }),
        })) as unknown as typeof fetch,
      })
      expect(rejected.ok).toBe(false)
      expect(rejected.order.status).toBe('REJECTED_RISK')
      expect(rejected.order.mode).toBe('binance-testnet')
      expect(rejected.snapshot.dailyOrderCount).toBe(0)
      expect(
        rejected.snapshot.balances.find((b) => b.asset === 'USDT')?.free,
      ).toBe(10_000)

      const reconciled = await submitExchangeOrder({
        pair: 'BTC/USDT',
        side: 'BUY',
        notionalUsd: 100,
        referencePrice: 49_500,
        clientOrderId: 'cid-testnet-fill',
        fetchImpl: (async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            orderId: 987654,
            status: 'FILLED',
            executedQty: '0.002000',
            cummulativeQuoteQty: '100.00',
          }),
        })) as unknown as typeof fetch,
      })
      expect(reconciled.ok).toBe(true)
      expect(reconciled.order.status).toBe('FILLED')
      expect(reconciled.order.mode).toBe('binance-testnet')
      expect(reconciled.order.venueOrderId).toBe('987654')
      expect(reconciled.order.quantity).toBe(0.002)
      expect(reconciled.order.price).toBe(50_000)
    } finally {
      if (prevKey === undefined) delete process.env.BINANCE_TESTNET_KEY
      else process.env.BINANCE_TESTNET_KEY = prevKey
      if (prevSecret === undefined) delete process.env.BINANCE_TESTNET_SECRET
      else process.env.BINANCE_TESTNET_SECRET = prevSecret
      resetExchangeDemoVault()
    }
  })

  it('persists exchange limits/kill-switch/orderCounter fail-closed and quarantines corrupt state files', async () => {
    resetExchangeDemoVault()
    updateHardRiskLimits({ maxOrderNotionalUsd: 1_234 })
    const preRestartOrder = await submitExchangeOrder({
      pair: 'BTC/USDT',
      side: 'BUY',
      notionalUsd: 100,
      referencePrice: 50_000,
      clientOrderId: 'cid-persist-1',
    })
    expect(preRestartOrder.ok).toBe(true)
    const prevOrdNum = Number(preRestartOrder.order.id.replace('ORD-', ''))
    await triggerEmergencyKillSwitch('Persist Safety Lock')

    const persistedPath = path.join(tempTestDir, 'persisted-safety.json')
    flushStateToDiskSync(persistedPath)

    // Simulate process wipe before reloading disk state
    resetExchangeDemoVault()
    expect(getExchangeStatusSnapshot().killSwitchActive).toBe(false)

    const loaded = loadStateFromDisk(persistedPath)
    expect(loaded.loaded).toBe(true)

    const restoredExchange = getExchangeStatusSnapshot()
    expect(restoredExchange.killSwitchActive).toBe(true)
    expect(restoredExchange.hardLimits.maxOrderNotionalUsd).toBe(1_234)
    expect(getBotStatusSnapshot().running).toBe(false)

    // Monotonic order ID must strictly exceed pre-restart ID even after reset
    resetEmergencyKillSwitch()
    const postRestartOrder = await submitExchangeOrder({
      pair: 'BTC/USDT',
      side: 'BUY',
      notionalUsd: 100,
      referencePrice: 50_000,
      clientOrderId: 'cid-persist-2',
    })
    expect(postRestartOrder.ok).toBe(true)
    const nextOrdNum = Number(postRestartOrder.order.id.replace('ORD-', ''))
    expect(nextOrdNum).toBeGreaterThan(prevOrdNum)

    // Corrupt JSON must be quarantined instead of crashing or silently losing forensic evidence
    const corruptPath = path.join(tempTestDir, 'corrupt-state.json')
    fs.writeFileSync(corruptPath, '{corrupted json', 'utf8')
    const corruptRes = loadStateFromDisk(corruptPath)
    expect(corruptRes.loaded).toBe(false)
    expect(corruptRes.quarantinedFile).toContain('.corrupt.')
    expect(fs.existsSync(corruptRes.quarantinedFile!)).toBe(true)
    resetExchangeDemoVault()
  })

  it('tracks independent MT5 terminals on Mt5BridgeSnapshot and streams snapshot + delta SSE frames', async () => {
    resetMt5BridgeTelemetry()
    const preset = STRATEGY_PRESETS[0]
    const state = createInitialBotState(preset)
    const exchange = getExchangeStatusSnapshot()

    registerMt5Poll(state, preset, exchange, {
      terminal: 'MT5-Desk-A',
      symbol: 'BTCUSD',
    })
    registerMt5Poll(state, preset, exchange, {
      terminal: 'MT5-Desk-B',
      symbol: 'ETHUSD',
    })
    registerMt5Poll(state, preset, exchange, {
      terminal: 'MT5-Desk-A',
      symbol: 'BTCUSD',
    })

    const bridge = getMt5BridgeSnapshot(state, preset, exchange)
    expect(bridge.pollCount).toBe(3)
    expect(bridge.terminals).toHaveLength(2)
    expect(
      bridge.terminals.find((t) => t.terminalName === 'MT5-Desk-A')?.pollCount,
    ).toBe(2)

    const streamReq = Object.assign(new EventEmitter(), {
      method: 'GET',
      url: '/api/bot/stream',
    }) as unknown as http.IncomingMessage

    const chunks: string[] = []
    const streamResEmitter = new EventEmitter()
    const streamRes = Object.assign(streamResEmitter, {
      writableEnded: false,
      destroyed: false,
      writableNeedDrain: false,
      writeHead: () => {},
      write: (chunk: string | Buffer) => {
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
        return true
      },
      end: () => {},
    }) as unknown as http.ServerResponse

    const streamHandled = await handleBotApiRequest(streamReq, streamRes)
    expect(streamHandled).toBe(true)
    expect(chunks.length).toBeGreaterThanOrEqual(1)

    const firstDataLine = chunks[0]
      .split('\n')
      .find((line) => line.startsWith('data: '))!
    const snapshotFrame = JSON.parse(firstDataLine.slice(6)) as {
      seq: number
      frameType: string
      presets?: unknown[]
    }
    expect(chunks[0]).toMatch(/^id: \d+\n/)
    expect(snapshotFrame.frameType).toBe('snapshot')
    expect(snapshotFrame.presets).toHaveLength(8)

    // Mutate limits via API to emit compact delta frame (no presets duplication)
    const mutateReq = Readable.from([
      Buffer.from(JSON.stringify({ maxOrderNotionalUsd: 2_500 })),
    ]) as unknown as http.IncomingMessage
    mutateReq.method = 'POST'
    mutateReq.url = '/api/exchange/limits'
    const mutateRes = {
      writeHead: () => {},
      end: () => {},
    } as unknown as http.ServerResponse
    const mutated = await handleBotApiRequest(mutateReq, mutateRes)
    expect(mutated).toBe(true)

    expect(chunks.length).toBeGreaterThanOrEqual(2)
    const secondDataLine = chunks[chunks.length - 1]
      .split('\n')
      .find((line) => line.startsWith('data: '))!
    const deltaFrame = JSON.parse(secondDataLine.slice(6)) as {
      seq: number
      frameType: string
      presets?: unknown[]
    }
    expect(deltaFrame.frameType).toBe('delta')
    expect(deltaFrame.seq).toBeGreaterThan(snapshotFrame.seq)
    expect(deltaFrame.presets).toBeUndefined()

    const connectedBeforeClose = getTelemetry().connectedStreamClients
    streamReq.emit('close')
    expect(getTelemetry().connectedStreamClients).toBeLessThan(
      connectedBeforeClose,
    )
    resetExchangeDemoVault()
  })

  afterAll(async () => {
    await flushStatePersistence()
    stopBackgroundWorker()
    await flushStatePersistence()
    if (previousStateFileEnv === undefined) delete process.env.FLARE_STATE_FILE
    else process.env.FLARE_STATE_FILE = previousStateFileEnv
    if (tempTestDir) {
      fs.rmSync(tempTestDir, { recursive: true, force: true })
    }
  })
})
