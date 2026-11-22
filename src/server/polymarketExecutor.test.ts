import { OrderType, Side } from '@polymarket/clob-client'
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
  resetExchangeStateForTests,
  triggerEmergencyKillSwitch,
  updateHardRiskLimits,
} from './exchangeAdapter'
import { parseGammaMarket } from './polymarketAdapter'
import {
  cancelAllPolymarketOrders,
  cancelOrdersForWindow,
  cancelPolymarketOrder,
  getPolymarketExecutorStatus,
  reconcilePolymarketAccount,
  resetPolymarketExecutorState,
  roundPriceToTick,
  setPolymarketClobClient,
  submitPolymarketMakerQuote,
  submitPolymarketOrder,
  syncPolymarketOrderStatuses,
  type PolymarketClobClientLike,
} from './polymarketExecutor'
import {
  PostgresStateStore,
  getStateStore,
  resetStateStore,
  setStateStore,
  type PgPoolLike,
} from './store'

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
    resetExchangeStateForTests('default', { fundPaperUsd: 10_000 })
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

  it('submits post-only GTC maker quotes with tick rounding, $5 canary default, non-crossing guard, and $0 fee', async () => {
    const { client, calls } = makeFakeClobClient()
    setPolymarketClobClient(client)
    const nowMs = 1_700_000_500_000
    const quote = makeFreshQuote(nowMs)

    // 1. Disarmed fails closed
    const disarmed = await submitPolymarketMakerQuote({
      quote,
      limitPrice: 0.534,
      clientOrderId: 'maker-disarmed-1',
      nowMs,
    })
    expect(disarmed.ok).toBe(false)
    expect(calls.limitOrders).toHaveLength(0)

    process.env.FLARE_POLYMARKET_LIVE = 'true'

    // 2. Explicit invalid stakeUsd rejected even though default is $5
    const badStake = await submitPolymarketMakerQuote({
      quote,
      limitPrice: 0.534,
      stakeUsd: 0,
      clientOrderId: 'maker-bad-stake-1',
      nowMs,
    })
    expect(badStake.ok).toBe(false)
    expect(badStake.error).toContain('stakeUsd')

    // 3. Respects HardRiskLimits.maxOrderNotionalUsd (updateHardRiskLimits enforces >= $10 floor)
    updateHardRiskLimits({ maxOrderNotionalUsd: 10 })
    const overLimit = await submitPolymarketMakerQuote({
      quote,
      limitPrice: 0.534,
      stakeUsd: 15,
      clientOrderId: 'maker-over-limit-1',
      nowMs,
    })
    expect(overLimit.ok).toBe(false)
    expect(overLimit.error).toContain('HardRiskLimits')
    updateHardRiskLimits({ maxOrderNotionalUsd: 500 })

    // 4. Rejects crossing BUY limitPrice >= ask without calling CLOB
    const crossing = await submitPolymarketMakerQuote({
      quote,
      limitPrice: quote.ask,
      clientOrderId: 'maker-cross-1',
      nowMs,
    })
    expect(crossing.ok).toBe(false)
    expect(crossing.error).toContain('Post-only BUY')
    expect(calls.limitOrders).toHaveLength(0)

    // 5. Defaults to $5 canary stake, rounds 0.534 -> 0.53 on 0.01 tick, postOnly=true, feeUsd=0
    const accepted = await submitPolymarketMakerQuote({
      quote,
      limitPrice: 0.534,
      clientOrderId: 'maker-ok-1',
      nowMs,
    })
    expect(accepted.ok).toBe(true)
    expect(accepted.order.orderType).toBe('GTC')
    expect(accepted.order.status).toBe('LIVE')
    expect(accepted.order.stakeUsd).toBe(5)
    expect(accepted.order.limitPrice).toBe(0.53)
    expect(accepted.order.feeUsd).toBe(0)
    expect(accepted.order.shares).toBe(Number((5 / 0.53).toFixed(4)))
    expect(calls.limitOrders).toHaveLength(1)
    expect(calls.limitOrders[0]).toMatchObject({
      order: {
        tokenID: quote.tokenId,
        price: 0.53,
        size: Number((5 / 0.53).toFixed(4)),
        side: Side.BUY,
      },
      opts: { tickSize: '0.01', negRisk: false },
      orderType: OrderType.GTC,
      deferExec: false,
      postOnly: true,
    })

    // 6. Steps down 1 tick if raw limitPrice < ask but rounding collides with ask
    const roundedQuote: ExecutablePredictionQuote = {
      ...quote,
      bid: 0.53,
      ask: 0.55,
      mid: 0.54,
      spread: 0.02,
      tickSize: 0.01,
    }
    const stepped = await submitPolymarketMakerQuote({
      quote: roundedQuote,
      limitPrice: 0.5499,
      stakeUsd: 10,
      clientOrderId: 'maker-stepdown-1',
      nowMs,
    })
    expect(stepped.ok).toBe(true)
    expect(stepped.order.limitPrice).toBe(0.54)
    expect(stepped.order.stakeUsd).toBe(10)

    // 7. Symmetric SELL guard against bid
    const badSell = await submitPolymarketMakerQuote({
      quote: roundedQuote,
      side: 'SELL',
      limitPrice: 0.53,
      clientOrderId: 'maker-sell-cross-1',
      nowMs,
    })
    expect(badSell.ok).toBe(false)
    expect(badSell.error).toContain('Post-only SELL')

    // 8. Balanced double-entry ledger & idempotency
    const dup = await submitPolymarketMakerQuote({
      quote,
      limitPrice: 0.534,
      clientOrderId: 'maker-ok-1',
      nowMs,
    })
    expect(dup.order.id).toBe(accepted.order.id)
    expect(calls.limitOrders).toHaveLength(2)

    const ledger = getTenantLedgerSnapshot('default')
    expect(ledger.verification.balanced).toBe(true)
    const stakeEntry = ledger.entries.find(
      (e) => e.kind === 'PREDICTION_STAKE' && e.referenceId === accepted.order.id,
    )
    expect(stakeEntry).toBeDefined()
    expect(
      stakeEntry?.postings.some((p) => p.account.startsWith('expense:fees:')),
    ).toBe(false)

    // 9. submitPolymarketOrder respects stakeUsdOverride while preserving fail-closed stakeUsd <= 0
    const overrideRes = await submitPolymarketOrder({
      quote,
      stakeUsd: 25,
      stakeUsdOverride: 5,
      orderType: 'FOK',
      clientOrderId: 'taker-override-1',
      nowMs,
    })
    expect(overrideRes.ok).toBe(true)
    expect(overrideRes.order.stakeUsd).toBe(5)
  })

  it('cancelOrdersForWindow cancels only LIVE orders for the target window and preserves unrelated windows & MATCHED orders', async () => {
    const { client, calls } = makeFakeClobClient()
    setPolymarketClobClient(client)
    process.env.FLARE_POLYMARKET_LIVE = 'true'
    const nowMs = 1_700_000_500_000

    const win5mYes: ExecutablePredictionQuote = {
      ...makeFreshQuote(nowMs),
      instrumentId: 'btc-updown-5m-100',
      outcome: 'YES',
      tokenId: 'tok-5m-yes',
      bid: 0.50,
      ask: 0.54,
    }
    const win5mNo: ExecutablePredictionQuote = {
      ...makeFreshQuote(nowMs),
      instrumentId: 'btc-updown-5m-100',
      outcome: 'NO',
      tokenId: 'tok-5m-no',
      bid: 0.44,
      ask: 0.48,
    }
    const win15mYes: ExecutablePredictionQuote = {
      ...makeFreshQuote(nowMs),
      instrumentId: 'btc-updown-15m-200',
      outcome: 'YES',
      tokenId: 'tok-15m-yes',
      bid: 0.60,
      ask: 0.64,
    }

    const live5mYes = await submitPolymarketMakerQuote({
      quote: win5mYes,
      limitPrice: 0.52,
      clientOrderId: 'sweep-5m-yes',
      nowMs,
    })
    const live5mNo = await submitPolymarketMakerQuote({
      quote: win5mNo,
      limitPrice: 0.46,
      clientOrderId: 'sweep-5m-no',
      nowMs,
    })
    const matched5m = await submitPolymarketOrder({
      quote: win5mYes,
      stakeUsd: 5,
      orderType: 'FOK',
      clientOrderId: 'sweep-5m-matched',
      nowMs,
    })
    const live15m = await submitPolymarketMakerQuote({
      quote: win15mYes,
      limitPrice: 0.62,
      clientOrderId: 'sweep-15m-yes',
      nowMs,
    })

    expect(live5mYes.order.status).toBe('LIVE')
    expect(live5mNo.order.status).toBe('LIVE')
    expect(matched5m.order.status).toBe('MATCHED')
    expect(live15m.order.status).toBe('LIVE')

    const sweep = await cancelOrdersForWindow('default', 'btc-updown-5m-100', {
      reason: 'T-20s maker sweep',
    })
    expect(sweep.ok).toBe(true)
    expect(sweep.canceledCount).toBe(2)
    expect(sweep.failedOrderIds).toEqual([])
    expect(sweep.canceledOrderIds).toHaveLength(2)
    expect(sweep.canceledOrderIds).toEqual(
      expect.arrayContaining([
        live5mYes.order.venueOrderId,
        live5mNo.order.venueOrderId,
      ]),
    )
    expect(calls.canceledIds).toHaveLength(2)
    expect(calls.canceledIds).toEqual(
      expect.arrayContaining([
        live5mYes.order.venueOrderId,
        live5mNo.order.venueOrderId,
      ]),
    )

    // In-memory recentOrders updated in-place (still 4 orders, no duplicates)
    const status = getPolymarketExecutorStatus('default')
    expect(status.orderCount).toBe(4)
    const byClientId = new Map(
      status.recentOrders.map((o) => [o.clientOrderId, o]),
    )
    expect(byClientId.get('sweep-5m-yes')?.status).toBe('CANCELED')
    expect(byClientId.get('sweep-5m-no')?.status).toBe('CANCELED')
    expect(byClientId.get('sweep-5m-matched')?.status).toBe('MATCHED')
    expect(byClientId.get('sweep-15m-yes')?.status).toBe('LIVE')

    // SQL orders table also reflects the in-place update without client_order_id collision
    const sqlOrders = await getStateStore().getOrders('default', 20)
    const sqlByClient = new Map(sqlOrders.map((o) => [o.clientOrderId, o]))
    expect(sqlByClient.get('sweep-5m-yes')?.status).toBe('CANCELED_KILLSWITCH')
    expect(sqlByClient.get('sweep-5m-no')?.status).toBe('CANCELED_KILLSWITCH')
    expect(sqlByClient.get('sweep-5m-matched')?.status).toBe('FILLED')
    expect(sqlByClient.get('sweep-15m-yes')?.status).toBe('LIVE')

    // Partial failure test on remaining 15m window
    const { client: partialClient } = makeFakeClobClient({
      async cancelOrder(payload) {
        if (payload.orderID === live15m.order.venueOrderId) {
          throw new Error('CLOB cancel timeout')
        }
        return { canceled: [payload.orderID] }
      },
    })
    setPolymarketClobClient(partialClient)
    const failedSweep = await cancelOrdersForWindow(
      'default',
      'btc-updown-15m-200',
    )
    expect(failedSweep.ok).toBe(false)
    expect(failedSweep.canceledCount).toBe(0)
    expect(failedSweep.failedOrderIds).toEqual([live15m.order.venueOrderId])
    expect(failedSweep.error).toContain('CLOB cancel timeout')
    expect(
      getPolymarketExecutorStatus('default').recentOrders.find(
        (o) => o.clientOrderId === 'sweep-15m-yes',
      )?.status,
    ).toBe('LIVE')
  })

  it('preserves concurrency safety during cancelOrdersForWindow when orders prepend concurrently', async () => {
    let releaseCancel: () => void = () => {}
    let lmtSeq = 0
    const { client } = makeFakeClobClient({
      async createAndPostOrder() {
        lmtSeq += 1
        return {
          success: true,
          orderID: `clob-conc-${lmtSeq}`,
          status: 'LIVE',
        }
      },
      async cancelOrder() {
        await new Promise<void>((resolve) => {
          releaseCancel = resolve
        })
        return { canceled: ['clob-conc-1'] }
      },
    })
    setPolymarketClobClient(client)
    process.env.FLARE_POLYMARKET_LIVE = 'true'
    const nowMs = 1_700_000_500_000

    const q5m: ExecutablePredictionQuote = {
      ...makeFreshQuote(nowMs),
      instrumentId: 'win-5m',
      tokenId: 'tok-5m',
      bid: 0.50,
      ask: 0.54,
    }
    const q15m: ExecutablePredictionQuote = {
      ...makeFreshQuote(nowMs),
      instrumentId: 'win-15m',
      tokenId: 'tok-15m',
      bid: 0.50,
      ask: 0.54,
    }
    const q1h: ExecutablePredictionQuote = {
      ...makeFreshQuote(nowMs),
      instrumentId: 'win-1h',
      tokenId: 'tok-1h',
      bid: 0.50,
      ask: 0.54,
    }

    await submitPolymarketMakerQuote({
      quote: q5m,
      limitPrice: 0.52,
      clientOrderId: 'conc-5m',
      nowMs,
    })
    await submitPolymarketMakerQuote({
      quote: q15m,
      limitPrice: 0.52,
      clientOrderId: 'conc-15m',
      nowMs,
    })

    // Start canceling win-5m; while cancelOrder is awaiting, prepend a win-1h order
    const cancelPromise = cancelOrdersForWindow('default', 'win-5m', {
      reason: 'T-20s 5m sweep',
    })
    await Promise.resolve()
    await submitPolymarketMakerQuote({
      quote: q1h,
      limitPrice: 0.52,
      clientOrderId: 'conc-1h',
      nowMs,
    })
    releaseCancel()

    const cancelRes = await cancelPromise
    expect(cancelRes.ok).toBe(true)
    expect(cancelRes.canceledOrderIds).toEqual(['clob-conc-1'])

    const memByClient = new Map(
      getPolymarketExecutorStatus('default').recentOrders.map((o) => [
        o.clientOrderId,
        o,
      ]),
    )
    expect(memByClient.get('conc-5m')?.status).toBe('CANCELED')
    expect(memByClient.get('conc-15m')?.status).toBe('LIVE')
    expect(memByClient.get('conc-1h')?.status).toBe('LIVE')

    const sqlByClient = new Map(
      (await getStateStore().getOrders('default', 20)).map((o) => [
        o.clientOrderId,
        o,
      ]),
    )
    expect(sqlByClient.get('conc-5m')?.status).toBe('CANCELED_KILLSWITCH')
    expect(sqlByClient.get('conc-15m')?.status).toBe('LIVE')
    expect(sqlByClient.get('conc-1h')?.status).toBe('LIVE')
  })

  it('updates SQLite orders on >100 rollover remote cancel, rejects sub-cent stakeUsd, avoids restart ID collision, syncs LIVE->MATCHED fills, and releases BUY escrow on cancel', async () => {
    let lmtSeq = 0
    let fakeTrades: Awaited<ReturnType<PolymarketClobClientLike['getTrades']>> = []
    let fakeOpenOrders: Awaited<
      ReturnType<PolymarketClobClientLike['getOpenOrders']>
    > = []

    const { client, calls } = makeFakeClobClient({
      async createAndPostOrder(order, opts, orderType, deferExec, postOnly) {
        calls.limitOrders.push({ order, opts, orderType, deferExec, postOnly })
        lmtSeq += 1
        return {
          success: true,
          orderID: `clob-r-${lmtSeq}`,
          status: 'LIVE',
        }
      },
      async getOpenOrders() {
        return fakeOpenOrders
      },
      async getTrades() {
        return fakeTrades
      },
    })
    setPolymarketClobClient(client)
    process.env.FLARE_POLYMARKET_LIVE = 'true'
    const nowMs = 1_700_000_500_000
    const quote = makeFreshQuote(nowMs)

    // 1. Sub-cent stakeUsd (< $0.01) rejected before CLOB submission and ledger posting
    const subCentMaker = await submitPolymarketMakerQuote({
      quote,
      limitPrice: 0.5,
      stakeUsd: 0.004,
      clientOrderId: 'subcent-maker-1',
      nowMs,
    })
    expect(subCentMaker.ok).toBe(false)
    expect(subCentMaker.error).toContain('$0.01')

    const subCentTaker = await submitPolymarketOrder({
      quote,
      stakeUsd: 0.004,
      clientOrderId: 'subcent-taker-1',
      nowMs,
    })
    expect(subCentTaker.ok).toBe(false)
    expect(subCentTaker.error).toContain('$0.01')
    expect(calls.limitOrders).toHaveLength(0)
    expect(calls.marketOrders).toHaveLength(0)
    expect(
      getTenantLedgerSnapshot('default').entries.filter(
        (e) => e.kind === 'PREDICTION_STAKE',
      ),
    ).toHaveLength(0)

    // 2. Canceled LIVE BUY maker quote releases escrow back to wallet:USDT
    const buyQuoteRes = await submitPolymarketMakerQuote({
      quote: { ...quote, instrumentId: 'escrow-win-1', tokenId: 'tok-esc-1' },
      limitPrice: 0.52,
      stakeUsd: 5,
      clientOrderId: 'escrow-buy-1',
      nowMs,
    })
    expect(buyQuoteRes.ok).toBe(true)
    let ledger = getTenantLedgerSnapshot('default')
    expect(ledger.walletBalances.USDT).toBe(9_995)
    expect(ledger.accountBalances['escrow:prediction:USDT']?.balance).toBe(5)

    const sweepEscrow = await cancelOrdersForWindow('default', 'escrow-win-1', {
      reason: 'T-20s release escrow',
    })
    expect(sweepEscrow.ok).toBe(true)
    ledger = getTenantLedgerSnapshot('default')
    expect(ledger.walletBalances.USDT).toBe(10_000)
    expect(ledger.accountBalances['escrow:prediction:USDT']?.balance).toBe(0)
    expect(ledger.verification.balanced).toBe(true)

    // Also verify cancelPolymarketOrder & cancelAllPolymarketOrders release BUY escrow
    const buyForSingleCancel = await submitPolymarketMakerQuote({
      quote: { ...quote, instrumentId: 'escrow-win-2', tokenId: 'tok-esc-2' },
      limitPrice: 0.52,
      stakeUsd: 5,
      clientOrderId: 'escrow-buy-2',
      nowMs,
    })
    expect(buyForSingleCancel.ok).toBe(true)
    const singleCancel = await cancelPolymarketOrder(
      buyForSingleCancel.order.venueOrderId!,
      'default',
    )
    expect(singleCancel.ok).toBe(true)
    ledger = getTenantLedgerSnapshot('default')
    expect(ledger.walletBalances.USDT).toBe(10_000)
    expect(ledger.accountBalances['escrow:prediction:USDT']?.balance).toBe(0)

    const buyForCancelAll = await submitPolymarketMakerQuote({
      quote: { ...quote, instrumentId: 'escrow-win-3', tokenId: 'tok-esc-3' },
      limitPrice: 0.52,
      stakeUsd: 5,
      clientOrderId: 'escrow-buy-3',
      nowMs,
    })
    expect(buyForCancelAll.ok).toBe(true)
    await cancelAllPolymarketOrders('default', 'Manual cancel all')
    ledger = getTenantLedgerSnapshot('default')
    expect(ledger.walletBalances.USDT).toBe(10_000)
    expect(ledger.accountBalances['escrow:prediction:USDT']?.balance).toBe(0)
    expect(ledger.verification.balanced).toBe(true)

    // 3. syncPolymarketOrderStatuses transitions LIVE -> MATCHED in memory & FILLED in SQL
    const syncOrder = await submitPolymarketMakerQuote({
      quote: { ...quote, instrumentId: 'sync-win-1', tokenId: 'tok-sync-1' },
      limitPrice: 0.52,
      stakeUsd: 5,
      clientOrderId: 'sync-maker-1',
      nowMs,
    })
    expect(syncOrder.order.status).toBe('LIVE')
    const syncVenueId = syncOrder.order.venueOrderId!
    fakeTrades = [
      {
        id: 'trd-sync-1',
        taker_order_id: 'other-taker',
        market: '0xcond123',
        asset_id: 'tok-sync-1',
        side: Side.SELL,
        size: '9.6154',
        fee_rate_bps: '0',
        price: '0.52',
        status: 'MATCHED',
        match_time: '1700000510',
        last_update: '1700000510',
        outcome: 'Up',
        bucket_index: 0,
        owner: '0xowner',
        maker_address: '0xmaker',
        maker_orders: [
          {
            order_id: syncVenueId,
            owner: '0xowner',
            maker_address: '0xmaker',
            matched_amount: '9.6154',
            price: '0.52',
            fee_rate_bps: '0',
            asset_id: 'tok-sync-1',
            outcome: 'Up',
            side: Side.BUY,
          },
        ],
        transaction_hash: '0xsyncedtx',
        trader_side: 'MAKER',
      },
    ]

    const syncRes = await syncPolymarketOrderStatuses('default')
    expect(syncRes.syncedCount).toBe(1)
    expect(syncRes.matchedOrderIds).toEqual([syncVenueId])
    const syncedMem = getPolymarketExecutorStatus('default').recentOrders.find(
      (o) => o.clientOrderId === 'sync-maker-1',
    )
    expect(syncedMem?.status).toBe('MATCHED')
    expect(syncedMem?.transactionHashes).toContain('0xsyncedtx')
    const syncedSql = await getStateStore().findOrderByClientOrderId(
      'default',
      'sync-maker-1',
    )
    expect(syncedSql?.status).toBe('FILLED')

    // 4. Restart non-collision (POLY-UUID never overwrites prior SQLite order row)
    resetPolymarketExecutorState()
    const afterRestart = await submitPolymarketMakerQuote({
      quote: { ...quote, instrumentId: 'restart-win-1', tokenId: 'tok-rst-1' },
      limitPrice: 0.52,
      stakeUsd: 5,
      clientOrderId: 'after-restart-1',
      nowMs: nowMs + 1_000,
    })
    expect(afterRestart.ok).toBe(true)
    expect(afterRestart.order.id).not.toBe(syncOrder.order.id)
    expect(
      await getStateStore().findOrderByClientOrderId('default', 'sync-maker-1'),
    ).not.toBeNull()
    expect(
      await getStateStore().findOrderByClientOrderId(
        'default',
        'after-restart-1',
      ),
    ).not.toBeNull()

    // 5. >100 rollover SQLite status update when discovered via getOpenOrders()
    updateHardRiskLimits({ maxDailyOrders: 500 })
    const evictedRes = await submitPolymarketMakerQuote({
      quote: {
        ...quote,
        instrumentId: 'btc-updown-5m-evicted',
        conditionId: '0xcond-evicted',
        tokenId: 'tok-evicted',
      },
      limitPrice: 0.52,
      stakeUsd: 5,
      clientOrderId: 'evicted-5m-1',
      nowMs: nowMs + 2_000,
    })
    expect(evictedRes.ok).toBe(true)
    const evictedVenueId = evictedRes.order.venueOrderId!

    for (let i = 0; i < 105; i += 1) {
      await submitPolymarketMakerQuote({
        quote: {
          ...quote,
          instrumentId: `filler-win-${i}`,
          tokenId: `tok-fill-${i}`,
        },
        limitPrice: 0.52,
        stakeUsd: 5,
        clientOrderId: `filler-${i}`,
        nowMs: nowMs + 3_000 + i,
      })
    }

    fakeOpenOrders = [
      {
        id: evictedVenueId,
        status: 'LIVE',
        owner: '0xowner',
        maker_address: '0xmaker',
        market: '0xcond-evicted',
        asset_id: 'tok-evicted',
        side: 'BUY',
        original_size: '9.6154',
        size_matched: '0',
        price: '0.52',
        associate_trades: [],
        outcome: 'Up',
        created_at: 1_700_000_502,
        expiration: '0',
        order_type: 'GTC',
      },
    ]

    const rolloverSweep = await cancelOrdersForWindow(
      'default',
      'btc-updown-5m-evicted',
      {
        reason: 'Rollover sweep',
        conditionId: '0xcond-evicted',
        tokenIds: ['tok-evicted'],
      },
    )
    expect(rolloverSweep.ok).toBe(true)
    expect(rolloverSweep.canceledCount).toBe(1)
    expect(rolloverSweep.canceledOrderIds).toEqual([evictedVenueId])

    const sqlEvicted = await getStateStore().findOrderByClientOrderId(
      'default',
      'evicted-5m-1',
    )
    expect(sqlEvicted?.status).toBe('CANCELED_KILLSWITCH')
  })

  it('deduplicates state.orders and avoids Postgres 23505 when retrying REJECTED orders through LIVE and MATCHED', async () => {
    type PgOrderRow = {
      id: string
      tenant_id: string
      client_order_id: string | null
      venue_order_id: string | null
      timestamp: string
      pair: string
      side: string
      notional_usd: number
      price: number
      quantity: number
      status: string
      mode: string
      source: string
      reason: string | null
    }
    const orderRows: PgOrderRow[] = []
    const pgConstraintErrors: unknown[] = []

    const pgPool: PgPoolLike = {
      async query<T = Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = [],
      ): Promise<{ rows: T[]; rowCount?: number | null }> {
        const normalized = sql.trim().replace(/\s+/g, ' ')
        if (normalized.startsWith('INSERT INTO orders')) {
          const [
            id,
            tenantId,
            clientOrderId,
            venueOrderId,
            timestamp,
            pair,
            side,
            notionalUsd,
            price,
            quantity,
            status,
            mode,
            source,
            reason,
          ] = params as [
            string,
            string,
            string | null,
            string | null,
            string,
            string,
            string,
            number,
            number,
            number,
            string,
            string,
            string,
            string | null,
          ]

          const existingById = orderRows.find(
            (r) => r.tenant_id === tenantId && r.id === id,
          )
          if (existingById) {
            existingById.venue_order_id = venueOrderId
            existingById.status = status
            existingById.reason = reason
            return { rows: [], rowCount: 1 }
          }

          if (clientOrderId !== null) {
            const dupClient = orderRows.find(
              (r) =>
                r.tenant_id === tenantId &&
                r.client_order_id === clientOrderId,
            )
            if (dupClient) {
              const err = Object.assign(
                new Error(
                  'duplicate key value violates unique constraint "idx_orders_tenant_client_order_id"',
                ),
                { code: '23505' },
              )
              pgConstraintErrors.push(err)
              throw err
            }
          }

          orderRows.push({
            id,
            tenant_id: tenantId,
            client_order_id: clientOrderId,
            venue_order_id: venueOrderId,
            timestamp,
            pair,
            side,
            notional_usd: notionalUsd,
            price,
            quantity,
            status,
            mode,
            source,
            reason,
          })
          return { rows: [], rowCount: 1 }
        }

        if (
          normalized.startsWith(
            'SELECT * FROM orders WHERE tenant_id = $1 AND client_order_id = $2',
          )
        ) {
          const [tenantId, clientOrderId] = params as [string, string]
          const found = orderRows.find(
            (r) =>
              r.tenant_id === tenantId && r.client_order_id === clientOrderId,
          )
          return {
            rows: found ? ([{ ...found }] as unknown as T[]) : [],
            rowCount: found ? 1 : 0,
          }
        }

        if (
          normalized.startsWith('SELECT * FROM orders WHERE tenant_id = $1')
        ) {
          const [tenantId, limit] = params as [string, number]
          const matched = orderRows
            .filter((r) => r.tenant_id === tenantId)
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .slice(0, limit)
          return {
            rows: matched.map((r) => ({ ...r })) as unknown as T[],
            rowCount: matched.length,
          }
        }

        return { rows: [], rowCount: 0 }
      },
    }

    setStateStore(new PostgresStateStore(pgPool, 'pg-test'))

    let failLimitOnce = true
    let fakeTrades: Awaited<ReturnType<PolymarketClobClientLike['getTrades']>> =
      []
    const { client } = makeFakeClobClient({
      async createAndPostOrder() {
        if (failLimitOnce) {
          failLimitOnce = false
          return { success: false, errorMsg: 'Transient CLOB 503' }
        }
        return {
          success: true,
          orderID: 'clob-retry-lmt-1',
          status: 'LIVE',
        }
      },
      async getOpenOrders() {
        return []
      },
      async getTrades() {
        return fakeTrades
      },
    })
    setPolymarketClobClient(client)
    process.env.FLARE_POLYMARKET_LIVE = 'true'

    const nowMs = 1_700_000_500_000
    const quote = makeFreshQuote(nowMs)
    const makerCid = 'pe-c5-nowcast-maker-retry-YES'

    // 1. First attempt fails pre-flight / CLOB -> REJECTED (client_order_id omitted in SQL)
    const rejected1 = await submitPolymarketMakerQuote({
      quote,
      limitPrice: 0.52,
      stakeUsd: 5,
      clientOrderId: makerCid,
      nowMs,
    })
    expect(rejected1.ok).toBe(false)
    expect(rejected1.order.status).toBe('REJECTED')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(orderRows).toHaveLength(1)
    expect(orderRows[0].status).toBe('REJECTED_RISK')
    expect(orderRows[0].client_order_id).toBeNull()

    // 2. Retry succeeds -> LIVE, zero duplicate clientOrderId in state.orders, zero Postgres 23505
    const retried = await submitPolymarketMakerQuote({
      quote,
      limitPrice: 0.52,
      stakeUsd: 5,
      clientOrderId: makerCid,
      nowMs: nowMs + 1_500,
    })
    expect(retried.ok).toBe(true)
    expect(retried.order.status).toBe('LIVE')
    expect(retried.order.venueOrderId).toBe('clob-retry-lmt-1')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(pgConstraintErrors).toHaveLength(0)
    const statusAfterRetry = getPolymarketExecutorStatus('default')
    expect(statusAfterRetry.orderCount).toBe(1)
    expect(
      statusAfterRetry.recentOrders.filter(
        (o) => o.clientOrderId === makerCid,
      ),
    ).toHaveLength(1)
    expect(statusAfterRetry.recentOrders[0].status).toBe('LIVE')

    const sqlLive = await getStateStore().findOrderByClientOrderId(
      'default',
      makerCid,
    )
    expect(sqlLive?.status).toBe('LIVE')
    expect(sqlLive?.venueOrderId).toBe('clob-retry-lmt-1')

    // 3. Sync LIVE -> MATCHED via getTrades -> updates SQL to FILLED cleanly
    fakeTrades = [
      {
        id: 'trd-retry-1',
        taker_order_id: 'counterparty',
        market: '0xcond123',
        asset_id: quote.tokenId!,
        side: Side.SELL,
        size: '9.6154',
        fee_rate_bps: '0',
        price: '0.52',
        status: 'MATCHED',
        match_time: '1700000510',
        last_update: '1700000510',
        outcome: 'Up',
        bucket_index: 0,
        owner: '0xowner',
        maker_address: '0xmaker',
        maker_orders: [
          {
            order_id: 'clob-retry-lmt-1',
            owner: '0xowner',
            maker_address: '0xmaker',
            matched_amount: '9.6154',
            price: '0.52',
            fee_rate_bps: '0',
            asset_id: quote.tokenId!,
            outcome: 'Up',
            side: Side.BUY,
          },
        ],
        transaction_hash: '0xretryfill',
        trader_side: 'MAKER',
      },
    ]

    const syncRes = await syncPolymarketOrderStatuses('default')
    expect(syncRes.syncedCount).toBe(1)
    expect(pgConstraintErrors).toHaveLength(0)

    const sqlFilled = await getStateStore().findOrderByClientOrderId(
      'default',
      makerCid,
    )
    expect(sqlFilled?.status).toBe('FILLED')
    expect(
      getPolymarketExecutorStatus('default').recentOrders.find(
        (o) => o.clientOrderId === makerCid,
      )?.status,
    ).toBe('MATCHED')

    // 4. Also verify submitPolymarketOrder REJECTED -> retry -> MATCHED deduplicates cleanly
    const takerCid = 'pe-taker-retry-YES'
    const badTaker = await submitPolymarketOrder({
      quote: { ...quote, asOfMs: nowMs - 60_000 },
      stakeUsd: 5,
      orderType: 'FOK',
      clientOrderId: takerCid,
      nowMs,
    })
    expect(badTaker.ok).toBe(false)
    expect(badTaker.order.status).toBe('REJECTED')

    const okTaker = await submitPolymarketOrder({
      quote,
      stakeUsd: 5,
      orderType: 'FOK',
      clientOrderId: takerCid,
      nowMs: nowMs + 1_500,
    })
    expect(okTaker.ok).toBe(true)
    expect(okTaker.order.status).toBe('MATCHED')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(pgConstraintErrors).toHaveLength(0)
    expect(
      getPolymarketExecutorStatus('default').recentOrders.filter(
        (o) => o.clientOrderId === takerCid,
      ),
    ).toHaveLength(1)
    expect(
      (await getStateStore().findOrderByClientOrderId('default', takerCid))
        ?.status,
    ).toBe('FILLED')
  })

  it('releases BUY escrow strictly once under concurrent cancelOrdersForWindow and cancelPolymarketOrder after >100 order eviction', async () => {
    let lmtSeq = 0
    let fakeOpenOrders: Awaited<
      ReturnType<PolymarketClobClientLike['getOpenOrders']>
    > = []
    const { client } = makeFakeClobClient({
      async createAndPostOrder() {
        lmtSeq += 1
        return {
          success: true,
          orderID: `clob-ev-conc-${lmtSeq}`,
          status: 'LIVE',
        }
      },
      async getOpenOrders() {
        return fakeOpenOrders
      },
    })
    setPolymarketClobClient(client)
    process.env.FLARE_POLYMARKET_LIVE = 'true'
    updateHardRiskLimits({ maxDailyOrders: 500 })

    const nowMs = 1_700_000_500_000
    const quote = makeFreshQuote(nowMs)

    const targetRes = await submitPolymarketMakerQuote({
      quote: {
        ...quote,
        instrumentId: 'btc-updown-5m-conc-evicted',
        conditionId: '0xcond-conc-ev',
        tokenId: 'tok-conc-ev',
      },
      limitPrice: 0.52,
      stakeUsd: 5,
      clientOrderId: 'evicted-conc-1',
      nowMs,
    })
    expect(targetRes.ok).toBe(true)
    const evictedVenueId = targetRes.order.venueOrderId!

    for (let i = 0; i < 105; i += 1) {
      const filler = await submitPolymarketMakerQuote({
        quote: {
          ...quote,
          instrumentId: `filler-conc-win-${i}`,
          tokenId: `tok-conc-fill-${i}`,
        },
        limitPrice: 0.52,
        stakeUsd: 1,
        clientOrderId: `filler-conc-${i}`,
        nowMs: nowMs + i + 1,
      })
      expect(filler.ok).toBe(true)
    }

    // 10,000 - 5 - 105 = 9,890 USDT in wallet; 110 USDT in escrow
    let ledger = getTenantLedgerSnapshot('default')
    expect(ledger.walletBalances.USDT).toBe(9_890)
    expect(ledger.accountBalances['escrow:prediction:USDT']?.balance).toBe(110)

    fakeOpenOrders = [
      {
        id: evictedVenueId,
        status: 'LIVE',
        owner: '0xowner',
        maker_address: '0xmaker',
        market: '0xcond-conc-ev',
        asset_id: 'tok-conc-ev',
        side: 'BUY',
        original_size: '9.6154',
        size_matched: '0',
        price: '0.52',
        associate_trades: [],
        outcome: 'Up',
        created_at: 1_700_000_500,
        expiration: '0',
        order_type: 'GTC',
      },
    ]

    const [sweepRes, singleRes] = await Promise.all([
      cancelOrdersForWindow('default', 'btc-updown-5m-conc-evicted', {
        reason: 'Concurrent rollover sweep',
        conditionId: '0xcond-conc-ev',
        tokenIds: ['tok-conc-ev'],
      }),
      cancelPolymarketOrder(evictedVenueId, 'default'),
    ])

    expect(sweepRes.ok).toBe(true)
    expect(singleRes.ok).toBe(true)

    ledger = getTenantLedgerSnapshot('default')
    const settlements = ledger.entries.filter(
      (e) => e.kind === 'PREDICTION_SETTLEMENT',
    )
    expect(settlements).toHaveLength(1)
    expect(ledger.walletBalances.USDT).toBe(9_895)
    expect(ledger.accountBalances['escrow:prediction:USDT']?.balance).toBe(105)
    expect(ledger.verification.balanced).toBe(true)

    const sqlOrder = await getStateStore().findOrderByClientOrderId(
      'default',
      'evicted-conc-1',
    )
    expect(sqlOrder?.status).toBe('CANCELED_KILLSWITCH')
  })
})
