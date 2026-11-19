import { Side } from '@polymarket/clob-client'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExecutablePredictionQuote } from '../market/quoteService'
import { clearRegisteredApiTokens, registerApiToken } from './auth'
import {
  flushStatePersistence,
  handleBotApiRequest,
  resetAllTenantRuntimes,
  stopBackgroundWorker,
} from './botRuntime'
import { resetSharedStateAdapter } from './cache/sharedState'
import {
  clearAllTenantExchangeStates,
  getExchangeStatusSnapshot,
  getTenantLedgerSnapshot,
  resetExchangeDemoVault,
  triggerEmergencyKillSwitch,
  updateHardRiskLimits,
} from './exchangeAdapter'
import { parseGammaMarket } from './polymarketAdapter'
import {
  cancelAllPolymarketOrders,
  getPolymarketExecutorStatus,
  reconcilePolymarketAccount,
  resetPolymarketExecutorState,
  roundPriceToTick,
  setPolymarketClobClient,
  submitPolymarketOrder,
  type PolymarketClobClientLike,
} from './polymarketExecutor'
import { resetStateStore } from './store'

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
        transactionsHashes: ['0xabc123'],
      }
    },
    async createAndPostOrder(order, opts, orderType) {
      calls.limitOrders.push({ order, opts, orderType })
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
      return [
        {
          id: 'open-1',
          status: 'LIVE',
          owner: '0xowner',
          maker_address: '0xmaker',
          market: '0xcond',
          asset_id: 'tok-up-1',
          side: 'BUY',
          original_size: '50',
          size_matched: '10',
          price: '0.54',
          associate_trades: [],
          outcome: 'Up',
          created_at: 1_700_000_000,
          expiration: '0',
          order_type: 'GTC',
        },
      ]
    },
    async getTrades() {
      return [
        {
          id: 'trd-1',
          taker_order_id: 'clob-mkt-1',
          market: '0xcond',
          asset_id: 'tok-up-1',
          side: Side.BUY,
          size: '40',
          fee_rate_bps: '2500',
          price: '0.55',
          status: 'MATCHED',
          match_time: '1700000100',
          last_update: '1700000105',
          outcome: 'Up',
          bucket_index: 0,
          owner: '0xowner',
          maker_address: '0xmaker',
          maker_orders: [],
          transaction_hash: '0xdeadbeef',
          trader_side: 'TAKER',
        },
      ]
    },
    async getBalanceAllowance() {
      return {
        balance: '250500000', // $250.50 USDC.e (6 decimals)
        allowance: '1000000000', // $1000.00 USDC.e
      }
    },
    ...overrides,
  }
  return { client, calls }
}

function makeFreshQuote(nowMs: number): ExecutablePredictionQuote {
  return {
    instrumentId: 'btc-updown-15m-1700000000',
    outcome: 'YES',
    bid: 0.53,
    ask: 0.554,
    mid: 0.542,
    spread: 0.024,
    asOfMs: nowMs - 2_000,
    source: 'polymarket-clob',
    category: 'crypto',
    tokenId: '111222333444',
    conditionId: '0xcond123',
    tickSize: 0.01,
    negRisk: false,
  }
}

async function callApi(params: {
  method: string
  url: string
  headers?: Record<string, string>
  body?: unknown
}) {
  const chunks =
    params.body !== undefined ? [Buffer.from(JSON.stringify(params.body))] : []
  const req = Readable.from(chunks) as unknown as http.IncomingMessage
  req.method = params.method
  req.url = params.url
  req.headers = Object.fromEntries(
    Object.entries(params.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  )

  let status = 0
  let body = ''
  const res = {
    writeHead(code: number) {
      status = code
    },
    end(chunk?: string) {
      if (chunk) body += chunk
    },
  } as unknown as http.ServerResponse

  await handleBotApiRequest(req, res)
  return {
    status,
    json: <T = Record<string, unknown>>() => JSON.parse(body) as T,
  }
}

describe('Polymarket CLOB Live Execution Connector', () => {
  const prevLive = process.env.FLARE_POLYMARKET_LIVE
  const prevAuth = process.env.FLARE_AUTH_REQUIRED

  beforeEach(async () => {
    resetPolymarketExecutorState()
    clearAllTenantExchangeStates()
    resetAllTenantRuntimes()
    clearRegisteredApiTokens()
    resetSharedStateAdapter()
    await resetStateStore(':memory:')
    resetExchangeDemoVault('default')
    delete process.env.FLARE_POLYMARKET_LIVE
    delete process.env.FLARE_AUTH_REQUIRED
  })

  afterEach(async () => {
    stopBackgroundWorker()
    await flushStatePersistence()
    setPolymarketClobClient(null)
    resetPolymarketExecutorState()
    clearRegisteredApiTokens()
    if (prevLive === undefined) delete process.env.FLARE_POLYMARKET_LIVE
    else process.env.FLARE_POLYMARKET_LIVE = prevLive
    if (prevAuth === undefined) delete process.env.FLARE_AUTH_REQUIRED
    else process.env.FLARE_AUTH_REQUIRED = prevAuth
  })

  it('extracts upTokenId, downTokenId, conditionId, tickSize and negRisk from Gamma markets', () => {
    const parsed = parseGammaMarket({
      question: 'Bitcoin Up or Down?',
      closed: false,
      conditionId: '0xcond999',
      outcomes: '["Up","Down"]',
      clobTokenIds: '["tok-up","tok-down"]',
      outcomePrices: '["0.52","0.48"]',
      bestBid: '0.51',
      bestAsk: '0.53',
      volume: '42000',
      orderPriceMinTickSize: 0.01,
      negRisk: true,
    })
    expect(parsed).toMatchObject({
      conditionId: '0xcond999',
      upTokenId: 'tok-up',
      downTokenId: 'tok-down',
      tickSize: 0.01,
      negRisk: true,
    })
    expect(roundPriceToTick(0.554, '0.01')).toBe(0.55)
    expect(roundPriceToTick(0.00001, '0.01')).toBe(0.01)
  })

  it('stays fail-closed when FLARE_POLYMARKET_LIVE is not armed and enforces quote, risk, and idempotency guards when armed', async () => {
    const { client, calls } = makeFakeClobClient()
    setPolymarketClobClient(client)
    const nowMs = 1_700_000_500_000
    const quote = makeFreshQuote(nowMs)

    // 1. Disarmed by default -> refuses without calling CLOB
    const disarmed = await submitPolymarketOrder({
      quote,
      stakeUsd: 50,
      clientOrderId: 'poly-disarmed-1',
      nowMs,
    })
    expect(disarmed.ok).toBe(false)
    expect(disarmed.error).toContain('disarmed')
    expect(calls.marketOrders).toHaveLength(0)

    // Arm live execution
    process.env.FLARE_POLYMARKET_LIVE = 'true'
    expect(getPolymarketExecutorStatus().liveArmed).toBe(true)

    // 2. Stale quote rejected before hitting CLOB
    const stale = await submitPolymarketOrder({
      quote: { ...quote, asOfMs: nowMs - 60_000 },
      stakeUsd: 50,
      clientOrderId: 'poly-stale-1',
      nowMs,
    })
    expect(stale.ok).toBe(false)
    expect(stale.error).toContain('[QUOTE GUARD]')
    expect(calls.marketOrders).toHaveLength(0)

    // 3. Missing tokenId rejected before hitting CLOB
    const noToken = await submitPolymarketOrder({
      quote: { ...quote, tokenId: undefined },
      stakeUsd: 50,
      clientOrderId: 'poly-notoken-1',
      nowMs,
    })
    expect(noToken.ok).toBe(false)
    expect(noToken.error).toContain('tokenId')

    // 4. Exceeding HardRiskLimits rejected before hitting CLOB
    updateHardRiskLimits({ maxOrderNotionalUsd: 40 })
    const overLimit = await submitPolymarketOrder({
      quote,
      stakeUsd: 50,
      clientOrderId: 'poly-limit-1',
      nowMs,
    })
    expect(overLimit.ok).toBe(false)
    expect(overLimit.error).toContain('HardRiskLimits')
    updateHardRiskLimits({ maxOrderNotionalUsd: 500 })

    // 5. Valid FOK order submits to CLOB, rounds to tick, posts balanced double-entry ledger, and deduplicates clientOrderId
    const placed = await submitPolymarketOrder({
      quote,
      stakeUsd: 50,
      orderType: 'FOK',
      clientOrderId: 'poly-ok-1',
      nowMs,
    })
    expect(placed.ok).toBe(true)
    expect(placed.order.status).toBe('MATCHED')
    expect(placed.order.venueOrderId).toBe('clob-mkt-1')
    expect(placed.order.limitPrice).toBe(0.55)
    expect(calls.marketOrders).toHaveLength(1)

    const dup = await submitPolymarketOrder({
      quote,
      stakeUsd: 50,
      orderType: 'FOK',
      clientOrderId: 'poly-ok-1',
      nowMs,
    })
    expect(dup.order.id).toBe(placed.order.id)
    expect(calls.marketOrders).toHaveLength(1)

    // Verify balanced double-entry ledger recorded the stake
    const ledger = getTenantLedgerSnapshot('default')
    expect(ledger.verification.balanced).toBe(true)
    expect(
      ledger.entries.some(
        (e) =>
          e.kind === 'PREDICTION_STAKE' && e.referenceId === placed.order.id,
      ),
    ).toBe(true)

    // 6. GTC limit order routes through createAndPostOrder & increments dailyOrderCount
    const gtc = await submitPolymarketOrder({
      quote,
      stakeUsd: 25,
      orderType: 'GTC',
      clientOrderId: 'poly-gtc-1',
      nowMs,
    })
    expect(gtc.ok).toBe(true)
    expect(gtc.order.status).toBe('LIVE')
    expect(calls.limitOrders).toHaveLength(1)
    expect(getExchangeStatusSnapshot('default').dailyOrderCount).toBe(2)

    // 7. Reaching HardRiskLimits.maxDailyOrders blocks further Polymarket orders
    updateHardRiskLimits({ maxDailyOrders: 2 })
    const overDaily = await submitPolymarketOrder({
      quote,
      stakeUsd: 10,
      orderType: 'FOK',
      clientOrderId: 'poly-over-daily-1',
      nowMs,
    })
    expect(overDaily.ok).toBe(false)
    expect(overDaily.error).toContain('Daily hard order count reached')
  })

  it('cancels all Polymarket open orders automatically on Emergency Kill-Switch and reconciles live account state', async () => {
    const { client, calls } = makeFakeClobClient()
    setPolymarketClobClient(client)
    process.env.FLARE_POLYMARKET_LIVE = 'true'

    const nowMs = Date.now()
    await submitPolymarketOrder({
      quote: makeFreshQuote(nowMs),
      stakeUsd: 25,
      orderType: 'GTC',
      clientOrderId: 'poly-live-before-kill',
      nowMs,
    })

    // Trigger shared Emergency Kill-Switch -> automatically invokes registered Polymarket cancelAll
    await triggerEmergencyKillSwitch('Global Risk Lock')
    expect(calls.cancelAllCount).toBe(1)
    expect(getPolymarketExecutorStatus().recentOrders[0].status).toBe(
      'CANCELED',
    )

    // Subsequent Polymarket order blocked while Kill-Switch is active
    const blocked = await submitPolymarketOrder({
      quote: makeFreshQuote(nowMs),
      stakeUsd: 25,
      clientOrderId: 'poly-after-kill',
      nowMs,
    })
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toContain('Kill-Switch ACTIVE')

    // Reconcile collateral, open orders, and trades from CLOB
    const recon = await reconcilePolymarketAccount('default')
    expect(recon.collateralUsd).toBe(250.5)
    expect(recon.allowanceUsd).toBe(1_000)
    expect(recon.openOrdersCount).toBe(1)
    expect(recon.recentTradesCount).toBe(1)

    const directCancel = await cancelAllPolymarketOrders('default', 'Manual')
    expect(directCancel.ok).toBe(true)
    expect(calls.cancelAllCount).toBe(2)
  })

  it('enforces RBAC on /api/polymarket/* HTTP endpoints', async () => {
    const { client } = makeFakeClobClient()
    setPolymarketClobClient(client)
    process.env.FLARE_POLYMARKET_LIVE = 'true'
    process.env.FLARE_AUTH_REQUIRED = 'true'

    registerApiToken({
      token: 'poly-viewer-token-123',
      tenantId: 'desk-1',
      role: 'viewer',
      subject: 'viewer@desk1',
    })
    registerApiToken({
      token: 'poly-trader-token-456',
      tenantId: 'desk-1',
      role: 'trader',
      subject: 'trader@desk1',
    })

    const statusRes = await callApi({
      method: 'GET',
      url: '/api/polymarket/status',
      headers: { Authorization: 'Bearer poly-viewer-token-123' },
    })
    expect(statusRes.status).toBe(200)
    expect(statusRes.json().liveArmed).toBe(true)

    // Viewer cannot submit live orders (403)
    const viewerOrder = await callApi({
      method: 'POST',
      url: '/api/polymarket/order',
      headers: { Authorization: 'Bearer poly-viewer-token-123' },
      body: {
        clientOrderId: 'http-poly-v1',
        stakeUsd: 25,
        quote: makeFreshQuote(Date.now()),
      },
    })
    expect(viewerOrder.status).toBe(403)

    // Trader can submit live order, reconcile, and cancel
    const traderOrder = await callApi({
      method: 'POST',
      url: '/api/polymarket/order',
      headers: { Authorization: 'Bearer poly-trader-token-456' },
      body: {
        clientOrderId: 'http-poly-t1',
        stakeUsd: 25,
        orderType: 'FOK',
        quote: makeFreshQuote(Date.now()),
      },
    })
    expect(traderOrder.status).toBe(200)
    expect(traderOrder.json().ok).toBe(true)

    const reconRes = await callApi({
      method: 'POST',
      url: '/api/polymarket/reconcile',
      headers: { Authorization: 'Bearer poly-trader-token-456' },
    })
    expect(reconRes.status).toBe(200)
    expect(reconRes.json().collateralUsd).toBe(250.5)

    const cancelRes = await callApi({
      method: 'POST',
      url: '/api/polymarket/cancel',
      headers: { Authorization: 'Bearer poly-trader-token-456' },
      body: { cancelAll: true },
    })
    expect(cancelRes.status).toBe(200)
    expect(cancelRes.json().ok).toBe(true)
  })
})
