import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { STRATEGY_PRESETS, createInitialBotState } from '../botEngine'
import { syntheticSource } from '../market/synthetic'
import {
  clearCandleCache,
  fetchOptimizedCandles,
  getCacheMetrics,
  resetCandleMarketSource,
  setCandleMarketSource,
  UpstreamMarketDataError,
} from './candleCache'
import {
  flushStatePersistence,
  flushStateToDiskSync,
  getBotStatusSnapshot,
  getTelemetry,
  handleBotApiRequest,
  loadStateFromDisk,
  resetAllTenantRuntimes,
  stopBackgroundWorker,
} from './botRuntime'
import {
  cancelExchangeOrder,
  clearAllTenantExchangeStates,
  fetchExchangeAccount,
  fundPaperAccount,
  getExchangeStatusSnapshot,
  resetEmergencyKillSwitch,
  resetExchangeStateForTests,
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
import { closeStateStore, getStateStore, resetStateStore } from './store'

async function invokeApi(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(payload) as unknown as http.IncomingMessage
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/json' }

  let status = 0
  let raw = ''
  const res = {
    writeHead(code: number) {
      status = code
    },
    end(chunk?: string) {
      raw = chunk ?? ''
    },
  } as unknown as http.ServerResponse

  await handleBotApiRequest(req, res)
  return {
    status,
    json: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
  }
}

describe('Backend Server Optimization & Runtime (candleCache + botRuntime + exchangeAdapter + mt5Bridge)', () => {
  const previousStateFileEnv = process.env.FLARE_STATE_FILE
  const previousDbPathEnv = process.env.FLARE_DB_PATH
  let tempTestDir = ''

  beforeAll(async () => {
    tempTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-server-test-'))
    process.env.FLARE_STATE_FILE = path.join(tempTestDir, 'bot-state.json')
    process.env.FLARE_DB_PATH = path.join(tempTestDir, 'flare.db')
    await resetStateStore(process.env.FLARE_DB_PATH)
    setCandleMarketSource(syntheticSource)
    resetAllTenantRuntimes()
    resetExchangeStateForTests('default')
    resetMt5BridgeTelemetry()
  })

  it('caches candles with TTL and deduplicates concurrent calls to raise hit rate', async () => {
    clearCandleCache()

    const [res1, res2] = await Promise.all([
      fetchOptimizedCandles('BTC/USDT', '15m', 120),
      fetchOptimizedCandles('BTC/USDT', '15m', 120),
    ])

    expect(res1.candles.length).toBeGreaterThanOrEqual(60)
    expect(res2.candles.length).toBe(res1.candles.length)

    const res3 = await fetchOptimizedCandles('BTC/USDT', '15m', 120)
    expect(res3.latencyMs).toBe(0)

    const metrics = getCacheMetrics()
    expect(metrics.hits).toBeGreaterThanOrEqual(1)
    expect(metrics.coalescedRequests).toBeGreaterThanOrEqual(1)
    expect(metrics.hitRatePct).toBeGreaterThan(0)
  })

  it('starts fresh runtime truthfully unfunded ($0 paper, no seeded balances, no fake MT5 packet)', () => {
    resetAllTenantRuntimes()
    resetExchangeStateForTests('default')
    resetMt5BridgeTelemetry()

    const snap = getBotStatusSnapshot()
    expect(snap.presets.length).toBe(STRATEGY_PRESETS.length)
    expect(snap.preset.id).toBeTruthy()
    expect(snap.state.balance).toBe(0)
    expect(snap.state.logs).toHaveLength(0)
    expect(snap.exchange.paperFunded).toBe(false)
    expect(snap.exchange.balances).toEqual([])
    expect(snap.mt5.pollCount).toBe(0)
    expect(snap.mt5.lastPacket).toBeNull()
    expect(snap.mt5.executionState).toBe('waiting-for-ea')

    const telemetry = getTelemetry()
    expect(telemetry.uptimeSec).toBeGreaterThanOrEqual(0)
    expect(telemetry.cache.activeCacheEntries).toBeGreaterThanOrEqual(0)
  })

  it('executes compliant orders in operator-funded Paper mode and rejects unfunded or over-cap orders', async () => {
    resetExchangeStateForTests('default')
    updateHardRiskLimits({ maxOrderNotionalUsd: 500 })

    // 0. Unfunded paper account rejects orders truthfully
    const unfundedRes = await submitExchangeOrder({
      pair: 'BTC/USDT',
      side: 'BUY',
      notionalUsd: 150,
      referencePrice: 85000,
    })
    expect(unfundedRes.ok).toBe(false)
    expect(unfundedRes.error).toContain('not funded')

    // 1. Explicitly fund PAPER account, then execute within cap ($150 <= $500) -> FILLED
    const fundRes = fundPaperAccount(10_000)
    expect(fundRes.ok).toBe(true)

    const okRes = await submitExchangeOrder({
      pair: 'BTC/USDT',
      side: 'BUY',
      notionalUsd: 150,
      referencePrice: 85000,
    })
    expect(okRes.ok).toBe(true)
    expect(okRes.order.status).toBe('FILLED')
    expect(okRes.order.mode).toBe('paper')
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
    resetExchangeStateForTests('default', { fundPaperUsd: 10_000 })

    let haltedCalled = false
    const killRes = await triggerEmergencyKillSwitch(
      'Emergency integration test',
      () => {
        haltedCalled = true
      },
    )
    expect(haltedCalled).toBe(true)
    expect(killRes.snapshot.killSwitchActive).toBe(true)

    const blockedRes = await submitExchangeOrder({
      pair: 'ETH/USDT',
      side: 'BUY',
      notionalUsd: 50,
      referencePrice: 2800,
    })
    expect(blockedRes.ok).toBe(false)
    expect(blockedRes.order.status).toBe('REJECTED_RISK')
    expect(blockedRes.error).toContain('Kill-Switch')

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

  it('builds MQL5 signal payloads, stores last-served packet, and processes POST /api/mt5/ack', async () => {
    resetExchangeStateForTests('default', { fundPaperUsd: 10_000 })
    resetMt5BridgeTelemetry()

    expect(toMt5Symbol('BTC/USDT')).toBe('BTCUSD')
    expect(toMt5Symbol('ETH/USDT')).toBe('ETHUSD')

    const preset = STRATEGY_PRESETS[0]
    const initialState = createInitialBotState(preset)

    // Before any poll, snapshot must NOT fabricate a packet
    const emptySnap = getMt5BridgeSnapshot(
      initialState,
      preset,
      getExchangeStatusSnapshot(),
    )
    expect(emptySnap.lastPacket).toBeNull()
    expect(emptySnap.executionState).toBe('waiting-for-ea')

    // Poll registers terminal + stores exact last-served packet
    const holdPacket = registerMt5Poll(
      initialState,
      preset,
      getExchangeStatusSnapshot(),
      {
        terminal: 'MT5-Test',
        symbol: 'BTCUSD',
        eaVersion: '2.00',
        broker: 'DemoBroker',
      },
    )
    expect(holdPacket.action).toBe('HOLD')
    expect(holdPacket.symbol).toBe('BTCUSD')
    expect(holdPacket.magicNumber).toBe(202615)

    const servedSnap = getMt5BridgeSnapshot(
      initialState,
      preset,
      getExchangeStatusSnapshot(),
    )
    expect(servedSnap.lastPacket?.signalId).toBe(holdPacket.signalId)
    expect(servedSnap.lastEaVersion).toBe('2.00')
    expect(servedSnap.lastBroker).toBe('DemoBroker')
    expect(servedSnap.executionState).toBe('unconfirmed')

    // Open position packet check
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

    // POST /api/mt5/ack confirms execution
    const ackRes = await invokeApi('POST', '/api/mt5/ack', {
      signalId: holdPacket.signalId,
      terminal: 'MT5-Test',
      eaVersion: '2.00',
      action: 'HOLD',
      status: 'NOOP',
    })
    expect(ackRes.status).toBe(200)
    expect(
      (ackRes.json.mt5 as { executionState: string }).executionState,
    ).toBe('confirmed')

    // With Kill-Switch active -> immediate CLOSE_ALL packet
    await triggerEmergencyKillSwitch('MT5 Emergency Close Test')
    const killPacket = buildMt5SignalPacket(
      buyState,
      preset,
      getExchangeStatusSnapshot(),
    )
    expect(killPacket.action).toBe('CLOSE_ALL')
    expect(killPacket.killSwitchActive).toBe(true)

    resetExchangeStateForTests('default')
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

  it('enforces durable SQL idempotency for clientOrderId even across simulated server restart', async () => {
    resetExchangeStateForTests('default', { fundPaperUsd: 10_000 })

    const first = await submitExchangeOrder({
      pair: 'BTC/USDT',
      side: 'BUY',
      notionalUsd: 50,
      referencePrice: 50_000,
      clientOrderId: 'cid-durable-restart-1',
    })
    expect(first.ok).toBe(true)
    expect(first.deduplicated).toBeUndefined()

    // Simulate process restart by wiping in-memory exchange state (SQLite stays intact)
    clearAllTenantExchangeStates()
    resetExchangeStateForTests('default', { fundPaperUsd: 10_000 })

    const second = await submitExchangeOrder({
      pair: 'BTC/USDT',
      side: 'BUY',
      notionalUsd: 50,
      referencePrice: 50_000,
      clientOrderId: 'cid-durable-restart-1',
    })
    expect(second.ok).toBe(true)
    expect(second.deduplicated).toBe(true)
    expect(second.order.id).toBe(first.order.id)

    const persisted = await getStateStore().findOrderByClientOrderId(
      'default',
      'cid-durable-restart-1',
    )
    expect(persisted?.id).toBe(first.order.id)
  })

  it('returns real Binance Testnet /api/v3/account balances when keys exist and explicit disconnected status without keys', async () => {
    resetExchangeStateForTests('default')
    const prevKey = process.env.BINANCE_TESTNET_KEY
    const prevSecret = process.env.BINANCE_TESTNET_SECRET
    delete process.env.BINANCE_TESTNET_KEY
    delete process.env.BINANCE_TESTNET_SECRET

    try {
      const disconnected = await fetchExchangeAccount('default')
      expect(disconnected.connected).toBe(false)
      if (!disconnected.connected) {
        expect(disconnected.requiredEnv).toEqual([
          'BINANCE_TESTNET_KEY',
          'BINANCE_TESTNET_SECRET',
        ])
        expect(disconnected.paperFunded).toBe(false)
        expect(disconnected.paperBalances).toEqual([])
      }

      process.env.BINANCE_TESTNET_KEY = 'testnet-key-123456'
      process.env.BINANCE_TESTNET_SECRET = 'testnet-secret-123456'

      const connected = await fetchExchangeAccount('default', {
        fetchImpl: (async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            accountType: 'SPOT',
            canTrade: true,
            canWithdraw: false,
            balances: [
              { asset: 'USDT', free: '4250.50', locked: '0.00' },
              { asset: 'BTC', free: '0.015000', locked: '0.00' },
            ],
          }),
        })) as unknown as typeof fetch,
      })
      expect(connected.connected).toBe(true)
      if (connected.connected) {
        expect(connected.mode).toBe('binance-testnet')
        expect(connected.canTrade).toBe(true)
        expect(connected.canWithdraw).toBe(false)
        expect(
          connected.balances.find((b) => b.asset === 'USDT')?.free,
        ).toBeCloseTo(4250.5, 2)
      }
    } finally {
      if (prevKey === undefined) delete process.env.BINANCE_TESTNET_KEY
      else process.env.BINANCE_TESTNET_KEY = prevKey
      if (prevSecret === undefined) delete process.env.BINANCE_TESTNET_SECRET
      else process.env.BINANCE_TESTNET_SECRET = prevSecret
    }
  })

  it('reconciles Binance Spot Testnet fills, extracts venue fees, and supports venue cancellation', async () => {
    resetExchangeStateForTests('default')
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
        clientOrderId: 'cid-testnet-fail-p1',
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

      const reconciled = await submitExchangeOrder({
        pair: 'BTC/USDT',
        side: 'BUY',
        notionalUsd: 100,
        referencePrice: 49_500,
        clientOrderId: 'cid-testnet-fill-p1',
        fetchImpl: (async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            orderId: 987654,
            status: 'FILLED',
            origQty: '0.002000',
            executedQty: '0.002000',
            cummulativeQuoteQty: '100.00',
            fills: [{ commission: '0.000002', commissionAsset: 'BTC' }],
          }),
        })) as unknown as typeof fetch,
      })
      expect(reconciled.ok).toBe(true)
      expect(reconciled.order.status).toBe('FILLED')
      expect(reconciled.order.mode).toBe('binance-testnet')
      expect(reconciled.order.venueOrderId).toBe('987654')
      expect(reconciled.order.quantity).toBe(0.002)
      expect(reconciled.order.filledQty).toBe(0.002)
      expect(reconciled.order.price).toBe(50_000)
      expect(reconciled.order.fee).toBeCloseTo(0.000002, 8)
      expect(reconciled.order.feeAsset).toBe('BTC')

      // Open order cancellation returns 200 and updates SQL status to CANCELED
      const openOrder = await submitExchangeOrder({
        pair: 'BTC/USDT',
        side: 'BUY',
        notionalUsd: 100,
        referencePrice: 50_000,
        clientOrderId: 'cid-testnet-new-p1',
        fetchImpl: (async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            orderId: 987655,
            status: 'NEW',
            origQty: '0.002000',
            executedQty: '0.000000',
          }),
        })) as unknown as typeof fetch,
      })
      expect(openOrder.ok).toBe(true)
      expect(openOrder.order.status).toBe('NEW')

      const canceled = await cancelExchangeOrder(openOrder.order.id, 'default', {
        fetchImpl: (async () => ({
          ok: true,
          status: 200,
          json: async () => ({ status: 'CANCELED', executedQty: '0' }),
        })) as unknown as typeof fetch,
      })
      expect(canceled.ok).toBe(true)
      expect(canceled.statusCode).toBe(200)
      expect(canceled.order?.status).toBe('CANCELED')
    } finally {
      if (prevKey === undefined) delete process.env.BINANCE_TESTNET_KEY
      else process.env.BINANCE_TESTNET_KEY = prevKey
      if (prevSecret === undefined) delete process.env.BINANCE_TESTNET_SECRET
      else process.env.BINANCE_TESTNET_SECRET = prevSecret
      resetExchangeStateForTests('default')
    }
  })

  it('validates limits/orders server-side, reconciles SQL orders with runtime_events, supports pause/resume, and removes fake endpoints', async () => {
    resetAllTenantRuntimes()
    resetExchangeStateForTests('default')

    // Removed fake endpoints must return 404
    expect((await invokeApi('POST', '/api/mt5/simulate-ping')).status).toBe(404)
    expect((await invokeApi('POST', '/api/exchange/reset')).status).toBe(404)

    // Out-of-range limits rejected with 400
    const badLimit = await invokeApi('POST', '/api/exchange/limits', {
      maxOrderNotionalUsd: 9_999_999,
    })
    expect(badLimit.status).toBe(400)
    expect(String(badLimit.json.error)).toContain('maxOrderNotionalUsd')

    // Missing order fields rejected with 400 (no silent `?? 100`)
    const badOrder = await invokeApi('POST', '/api/exchange/order', {
      pair: 'BTC/USDT',
      side: 'BUY',
    })
    expect(badOrder.status).toBe(400)

    // Fund paper account via audited API
    const fund = await invokeApi('POST', '/api/paper/fund', { amountUsd: 2500 })
    expect(fund.status).toBe(200)

    // Submit valid order and verify SQL orders <-> runtime_events reconciliation
    const ord = await invokeApi('POST', '/api/exchange/order', {
      pair: 'BTC/USDT',
      side: 'BUY',
      notionalUsd: 100,
      clientOrderId: 'cid-reconcile-1',
    })
    expect(ord.status).toBe(200)
    const orderId = (ord.json.order as { id: string }).id

    const ordersList = await invokeApi('GET', '/api/exchange/orders?limit=20')
    expect(ordersList.status).toBe(200)
    const sqlOrderIds = (ordersList.json.orders as { id: string }[]).map(
      (o) => o.id,
    )
    expect(sqlOrderIds).toContain(orderId)

    const eventsList = await invokeApi('GET', '/api/events?types=TRADE&limit=20')
    expect(eventsList.status).toBe(200)
    const matchingEvent = (
      eventsList.json.events as { correlationId?: string; message: string }[]
    ).find((e) => e.correlationId === orderId)
    expect(matchingEvent).toBeDefined()
    expect(matchingEvent?.message).not.toContain('[DEMO BROKER]')

    // Paper cancel returns 501
    const cancelPaper = await invokeApi(
      'POST',
      `/api/exchange/orders/${encodeURIComponent(orderId)}/cancel`,
    )
    expect(cancelPaper.status).toBe(501)

    // Start -> Pause -> Resume -> Stop lifecycle
    const started = await invokeApi('POST', '/api/bot/start', {})
    expect(started.status).toBe(200)
    expect(started.json.running).toBe(true)
    expect(started.json.paused).toBe(false)

    const paused = await invokeApi('POST', '/api/bot/pause', {})
    expect(paused.status).toBe(200)
    expect(paused.json.running).toBe(false)
    expect(paused.json.paused).toBe(true)

    const resumed = await invokeApi('POST', '/api/bot/resume', {})
    expect(resumed.status).toBe(200)
    expect(resumed.json.running).toBe(true)
    expect(resumed.json.paused).toBe(false)

    const stopped = await invokeApi('POST', '/api/bot/stop', {})
    expect(stopped.status).toBe(200)
    expect(stopped.json.running).toBe(false)
    expect(stopped.json.paused).toBe(false)
  })

  it('persists exchange limits/kill-switch/orderCounter fail-closed and quarantines corrupt state files', async () => {
    resetExchangeStateForTests('default', { fundPaperUsd: 10_000 })
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

    resetExchangeStateForTests('default')
    expect(getExchangeStatusSnapshot().killSwitchActive).toBe(false)

    const loaded = loadStateFromDisk(persistedPath)
    expect(loaded.loaded).toBe(true)

    const restoredExchange = getExchangeStatusSnapshot()
    expect(restoredExchange.killSwitchActive).toBe(true)
    expect(restoredExchange.hardLimits.maxOrderNotionalUsd).toBe(1_234)
    expect(getBotStatusSnapshot().running).toBe(false)

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

    const corruptPath = path.join(tempTestDir, 'corrupt-state.json')
    fs.writeFileSync(corruptPath, '{corrupted json', 'utf8')
    const corruptRes = loadStateFromDisk(corruptPath)
    expect(corruptRes.loaded).toBe(false)
    expect(corruptRes.quarantinedFile).toContain('.corrupt.')
    expect(fs.existsSync(corruptRes.quarantinedFile!)).toBe(true)
    resetExchangeStateForTests('default')
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
    expect(snapshotFrame.presets).toHaveLength(STRATEGY_PRESETS.length)

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
    resetExchangeStateForTests('default')
  })

  it('refuses simulated fallback candles and hardcoded order fill prices when upstream fails', async () => {
    clearCandleCache()
    setCandleMarketSource({
      name: 'Failing Upstream',
      description: 'Simulated upstream outage for fail-closed verification',
      async getCandles() {
        throw new Error('Upstream exchange unreachable')
      },
    })
    try {
      await expect(
        fetchOptimizedCandles('BTC/USDT', '15m', 60),
      ).rejects.toThrow(UpstreamMarketDataError)

      resetExchangeStateForTests('default', { fundPaperUsd: 10_000 })
      const res = await submitExchangeOrder({
        pair: 'BTC/USDT',
        side: 'BUY',
        notionalUsd: 100,
        clientOrderId: 'cid-no-live-price',
      })
      expect(res.ok).toBe(false)
      expect(res.order.status).toBe('REJECTED_RISK')
      expect(res.order.price).toBe(0)
      expect(res.error).toContain('live upstream market price unavailable')
    } finally {
      setCandleMarketSource(syntheticSource)
      clearCandleCache()
      resetExchangeStateForTests('default')
    }
  })

  it('supports single-preset sequential accuracy audit persistence and rejects unknown presetId', async () => {
    const targetPreset = STRATEGY_PRESETS[0]
    const runId = 'audit-run-phase2-test'

    const unknownRes = await invokeApi(
      'GET',
      `/api/bot/accuracy?presetId=nonexistent-preset&runId=${runId}`,
    )
    expect(unknownRes.status).toBe(400)

    const singleRes = await invokeApi(
      'GET',
      `/api/bot/accuracy?presetId=${encodeURIComponent(targetPreset.id)}&runId=${runId}`,
    )
    expect(singleRes.status).toBe(200)
    expect(singleRes.json.runId).toBe(runId)
    const reports = singleRes.json.reports as Array<{
      presetId: string
      pair?: string
      candles?: number
      fromTimeMs?: number
      toTimeMs?: number
      assumptions?: { commissionPct: number; slippagePct: number }
    }>
    expect(reports).toHaveLength(1)
    expect(reports[0].presetId).toBe(targetPreset.id)
    expect(reports[0].pair).toBe(targetPreset.strategy.pair)
    expect(reports[0].candles).toBeGreaterThan(0)
    expect(reports[0].fromTimeMs).toBeGreaterThan(0)
    expect(reports[0].toTimeMs).toBeGreaterThan(reports[0].fromTimeMs ?? 0)
    expect(reports[0].assumptions?.commissionPct).toBe(
      targetPreset.execution.commissionPct,
    )

    const latestRes = await invokeApi('GET', '/api/bot/accuracy/latest')
    expect(latestRes.status).toBe(200)
    const latestAudits = latestRes.json.audits as Array<{
      runId: string
      presetId: string
      pair: string
    }>
    expect(
      latestAudits.some(
        (a) =>
          a.runId === runId &&
          a.presetId === targetPreset.id &&
          a.pair === targetPreset.strategy.pair,
      ),
    ).toBe(true)
  })

  it('§7 Safety Verification: enforces full 10-step Kill-Switch across paper, Binance Testnet, MT5, SQL audit/events, and guarantees zero secret leakage', async () => {
    const prevKey = process.env.BINANCE_TESTNET_KEY
    const prevSecret = process.env.BINANCE_TESTNET_SECRET
    const prevFetch = globalThis.fetch
    const TEST_KEY = 'TESTNET_SECRET_API_KEY_DO_NOT_LEAK_991'
    const TEST_SECRET = 'TESTNET_SECRET_HMAC_KEY_DO_NOT_LEAK_992'
    process.env.BINANCE_TESTNET_KEY = TEST_KEY
    process.env.BINANCE_TESTNET_SECRET = TEST_SECRET

    const canceledOpenOrderSymbols: string[] = []
    const marketSellQuantities: number[] = []

    const mockFetch: typeof fetch = async (input, init) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      const parsedUrl = new URL(urlStr)
      const method = (init?.method ?? 'GET').toUpperCase()

      if (
        parsedUrl.pathname === '/api/v3/account' &&
        method === 'GET'
      ) {
        return new Response(
          JSON.stringify({
            accountType: 'SPOT',
            canTrade: true,
            canWithdraw: false,
            balances: [
              { asset: 'USDT', free: '2500.00', locked: '0.00' },
              { asset: 'BTC', free: '0.500000', locked: '0.000000' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      if (
        parsedUrl.pathname === '/api/v3/openOrders' &&
        method === 'DELETE'
      ) {
        const symbol = parsedUrl.searchParams.get('symbol') ?? ''
        canceledOpenOrderSymbols.push(symbol)
        const payload =
          symbol === 'BTCUSDT'
            ? [{ orderId: 888001, symbol: 'BTCUSDT', status: 'CANCELED' }]
            : []
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (parsedUrl.pathname === '/api/v3/order' && method === 'POST') {
        const side = parsedUrl.searchParams.get('side')
        if (side === 'BUY') {
          return new Response(
            JSON.stringify({
              orderId: 991001,
              status: 'FILLED',
              executedQty: '0.002000',
              cummulativeQuoteQty: '120.00',
              fills: [
                {
                  price: '60000.00',
                  qty: '0.002000',
                  commission: '0.12',
                  commissionAsset: 'USDT',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        const qty = Number(parsedUrl.searchParams.get('quantity') ?? '0')
        marketSellQuantities.push(qty)
        return new Response(
          JSON.stringify({
            orderId: 991999,
            status: 'FILLED',
            executedQty: qty.toFixed(6),
            cummulativeQuoteQty: (qty * 60500).toFixed(2),
            fills: [
              {
                price: '60500.00',
                qty: qty.toFixed(6),
                commission: '0.12',
                commissionAsset: 'USDT',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      return new Response(JSON.stringify({ msg: 'Unhandled mock route' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }

    globalThis.fetch = mockFetch
    resetExchangeStateForTests('default')
    resetMt5BridgeTelemetry()

    try {
      // 1. Seed a running bot with an active paper position + active prediction ticket
      const preset = STRATEGY_PRESETS[0]
      const seededState = createInitialBotState(preset, {
        initialBalance: 1000,
        seedLog: false,
      })
      seededState.openPosition = {
        side: 'buy',
        pair: 'BTC/USDT',
        entryPrice: 60_000,
        entryTime: Date.now() - 120_000,
        quantity: 0.005,
        notional: 300,
        entryFee: 0.3,
        stopPrice: 58_800,
        initialStopPrice: 58_800,
        targetPrice: 62_400,
        presetId: preset.id,
        presetName: preset.name,
      }
      seededState.activeTickets = [
        {
          id: 1,
          ruleId: 'btc-up-5m',
          title: 'BTC 5m Up',
          timeframe: '5m',
          outcome: 'YES',
          entryBarTime: Date.now() - 60_000,
          entryReferencePrice: 60_000,
          stakeUsd: 25,
          fairPricePaid: 0.52,
          horizonBars: 1,
          barsElapsed: 0,
        },
      ]

      const seedFile = path.join(tempTestDir, 's7-safety-seed.json')
      fs.writeFileSync(
        seedFile,
        JSON.stringify({
          schemaVersion: 2,
          savedAt: new Date().toISOString(),
          presetId: preset.id,
          isRunning: true,
          isPaused: false,
          state: seededState,
        }),
        'utf8',
      )
      expect(loadStateFromDisk(seedFile).loaded).toBe(true)
      expect(getBotStatusSnapshot().running).toBe(true)

      // 2. Open a bot-owned Binance Testnet spot holding (0.002 BTC, while account holds 0.500 BTC)
      const botEntry = await submitExchangeOrder({
        pair: 'BTC/USDT',
        side: 'BUY',
        notionalUsd: 120,
        referencePrice: 60_000,
        source: 'bot-auto',
        clientOrderId: 'cid-s7-bot-testnet-entry',
      })
      expect(botEntry.ok).toBe(true)
      expect(getExchangeStatusSnapshot().botOwnedPosition?.quantity).toBeCloseTo(
        0.002,
        6,
      )

      // 3. Persist an open resting Testnet venue order in SQL
      await getStateStore().appendOrder('default', {
        id: 'ORD-S7-OPEN-1',
        venueOrderId: '888001',
        clientOrderId: 'cid-s7-open-limit',
        timestamp: new Date().toISOString(),
        pair: 'BTC/USDT',
        side: 'BUY',
        notionalUsd: 100,
        price: 59_000,
        quantity: 0.001694,
        filledQty: 0,
        status: 'NEW',
        mode: 'binance-testnet',
        source: 'manual',
      })

      // 4. Register an MT5 EA poll before engaging kill-switch
      const pollRes = await invokeApi(
        'GET',
        '/api/mt5/signal?terminal=MT5-S7&version=1.2&symbol=BTCUSD',
      )
      expect(pollRes.status).toBe(200)

      // 5. Engage Kill-Switch via HTTP API
      const killRes = await invokeApi('POST', '/api/exchange/kill-switch', {
        action: 'engage',
        reason: 'S7 emergency verification',
      })
      expect(killRes.status).toBe(200)

      const postKill = killRes.json as {
        running: boolean
        paused: boolean
        state: {
          openPosition: unknown
          activeTickets: unknown[]
          closedTrades: Array<{ exitReason: string; pair: string }>
        }
        exchange: {
          killSwitchActive: boolean
          killSwitchReason: string | null
          killSwitchActivatedAt: string | null
          botOwnedPosition: unknown
        }
        mt5: {
          executionState: string
          pendingCloseCommand: boolean
        }
      }

      // Assert Step 1–2: bot stopped, paper position closed as BacktestTrade('kill-switch'), tickets cleared
      expect(postKill.running).toBe(false)
      expect(postKill.paused).toBe(false)
      expect(postKill.state.openPosition).toBeNull()
      expect(postKill.state.activeTickets).toHaveLength(0)
      expect(postKill.state.closedTrades[0]?.exitReason).toBe('kill-switch')
      expect(postKill.state.closedTrades[0]?.pair).toBe('BTC/USDT')

      // Assert Step 3–4: open venue orders canceled & SQL open order reconciled to CANCELED_KILLSWITCH
      expect(canceledOpenOrderSymbols).toContain('BTCUSDT')
      const sqlOpenAfter = await getStateStore().findOrderById(
        'default',
        'ORD-S7-OPEN-1',
      )
      expect(sqlOpenAfter?.status).toBe('CANCELED_KILLSWITCH')

      // Assert Step 5: ONLY bot-owned Testnet quantity (0.002 BTC, NOT 0.500 BTC account balance) sold
      expect(marketSellQuantities).toEqual([0.002])
      expect(postKill.exchange.botOwnedPosition).toBeNull()
      expect(postKill.exchange.killSwitchActive).toBe(true)
      expect(postKill.exchange.killSwitchActivatedAt).toBeTruthy()
      expect(postKill.exchange.killSwitchReason).toBe(
        'S7 emergency verification',
      )

      // Assert Step 6–7: New orders rejected (`ok: false`, `REJECTED_RISK`) & bot start/resume blocked with HTTP 423
      const blockedOrder = await invokeApi('POST', '/api/exchange/order', {
        pair: 'BTC/USDT',
        side: 'BUY',
        notionalUsd: 50,
        clientOrderId: 'cid-s7-blocked',
      })
      expect(blockedOrder.status).toBe(200)
      expect(blockedOrder.json.ok).toBe(false)
      expect((blockedOrder.json.order as { status: string }).status).toBe(
        'REJECTED_RISK',
      )
      expect(String(blockedOrder.json.error ?? '')).toMatch(/kill-switch/i)

      const blockedStart = await invokeApi('POST', '/api/bot/start', {})
      expect(blockedStart.status).toBe(423)
      const blockedResume = await invokeApi('POST', '/api/bot/resume', {})
      expect(blockedResume.status).toBe(423)

      // Assert Step 8: runtime_events + audit_events contain kill-switch action with actor & timestamp
      const eventsRes = await invokeApi('GET', '/api/events?types=RISK&limit=20')
      expect(eventsRes.status).toBe(200)
      const riskEvents = eventsRes.json.events as Array<{
        type: string
        severity: string
        source: string
        timestamp: string
        message: string
      }>
      expect(
        riskEvents.some(
          (e) =>
            e.type === 'RISK' &&
            e.severity === 'critical' &&
            e.source === 'kill-switch' &&
            Boolean(e.timestamp) &&
            e.message.includes('S7 emergency verification'),
        ),
      ).toBe(true)

      const auditEvents = await getStateStore().getAuditEvents('default', 30)
      expect(
        auditEvents.some(
          (a) =>
            a.action === 'risk:killswitch_engage' &&
            Boolean(a.actor) &&
            Boolean(a.timestamp),
        ),
      ).toBe(true)

      // Assert Step 9: MT5 shows pending-ea until EA posts CLOSE_ALL ACK -> confirmed
      expect(postKill.mt5.executionState).toBe('pending-ea')
      expect(postKill.mt5.pendingCloseCommand).toBe(true)

      const closeSig = await invokeApi(
        'GET',
        '/api/mt5/signal?terminal=MT5-S7&version=1.2&symbol=BTCUSD',
      )
      expect(closeSig.status).toBe(200)
      expect(closeSig.json.action).toBe('CLOSE_ALL')

      const ackRes = await invokeApi('POST', '/api/mt5/ack', {
        signalId: closeSig.json.signalId,
        terminal: 'MT5-S7',
        action: 'CLOSE_ALL',
        status: 'CLOSED',
      })
      expect(ackRes.status).toBe(200)
      const afterAckSnap = getBotStatusSnapshot()
      expect(afterAckSnap.mt5?.executionState).toBe('confirmed')
      expect(afterAckSnap.mt5?.pendingCloseCommand).toBe(false)

      // Assert Step 10: Secrets Hygiene — Testnet API key/secret NEVER appear in any API response or SSE
      const statusRes = await invokeApi('GET', '/api/bot/status')
      const acctRes = await invokeApi('GET', '/api/exchange/account')
      const ordersRes = await invokeApi('GET', '/api/exchange/orders?limit=50')
      const allEventsRes = await invokeApi('GET', '/api/events?limit=50')
      const auditApiRes = await invokeApi('GET', '/api/audit?limit=50')

      const combinedSerialized = JSON.stringify([
        statusRes.json,
        acctRes.json,
        ordersRes.json,
        allEventsRes.json,
        auditApiRes.json,
        killRes.json,
      ])
      expect(combinedSerialized).not.toContain(TEST_KEY)
      expect(combinedSerialized).not.toContain(TEST_SECRET)
    } finally {
      globalThis.fetch = prevFetch
      if (prevKey === undefined) delete process.env.BINANCE_TESTNET_KEY
      else process.env.BINANCE_TESTNET_KEY = prevKey
      if (prevSecret === undefined) delete process.env.BINANCE_TESTNET_SECRET
      else process.env.BINANCE_TESTNET_SECRET = prevSecret
      resetEmergencyKillSwitch('default')
      resetExchangeStateForTests('default')
      resetMt5BridgeTelemetry()
    }
  })

  afterAll(async () => {
    resetCandleMarketSource()
    await flushStatePersistence()
    stopBackgroundWorker()
    await flushStatePersistence()
    await closeStateStore()
    if (previousStateFileEnv === undefined) delete process.env.FLARE_STATE_FILE
    else process.env.FLARE_STATE_FILE = previousStateFileEnv
    if (previousDbPathEnv === undefined) delete process.env.FLARE_DB_PATH
    else process.env.FLARE_DB_PATH = previousDbPathEnv
    if (tempTestDir) {
      fs.rmSync(tempTestDir, { recursive: true, force: true })
    }
  })
})
