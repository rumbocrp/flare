import fs from 'node:fs'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TrainingLiveShadowResponse } from '../training/types'
import {
  dispatchRuntimeAlert,
  getAlertDispatcherStatus,
  resetAlertDispatcherForTests,
  sanitizeAlertText,
  setAlertFetchForTests,
} from './alertDispatcher'
import {
  BINANCE_LIVE_BASE_URL,
  clearSymbolFilterCacheForTests,
  getBinanceLiveArmStatus,
  quantizeToStep,
  resolveBinanceVenueCredentials,
  validateAndQuantizeBinanceOrder,
} from './binanceLiveProtection'
import {
  handleBotApiRequest,
  resetAllTenantRuntimes,
  stopBackgroundWorker,
} from './botRuntime'
import {
  clearAllTenantExchangeStates,
  getExchangeStatusSnapshot,
  reconcileExchangeVenue,
  submitExchangeOrder,
  triggerEmergencyKillSwitch,
} from './exchangeAdapter'
import { tryServeStaticAsset } from './staticFiles'
import { getStateStore, resetStateStore } from './store'

const ENV_KEYS = [
  'FLARE_SQLITE_PATH',
  'FLARE_DB_PATH',
  'FLARE_SERVE_STATIC',
  'FLARE_ALERT_WEBHOOK_URL',
  'FLARE_TELEGRAM_BOT_TOKEN',
  'FLARE_TELEGRAM_CHAT_ID',
  'FLARE_ALERT_MIN_SEVERITY',
  'FLARE_ALERT_COOLDOWN_MS',
  'BINANCE_TESTNET_KEY',
  'BINANCE_TESTNET_SECRET',
  'BINANCE_LIVE_KEY',
  'BINANCE_LIVE_SECRET',
  'FLARE_BINANCE_LIVE',
  'FLARE_BINANCE_PROTECTIVE_EXITS',
] as const

const MOCK_EXCHANGE_INFO = {
  symbols: [
    {
      symbol: 'BTCUSDT',
      filters: [
        { filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '1000000', tickSize: '0.01' },
        { filterType: 'LOT_SIZE', minQty: '0.00010000', maxQty: '9000', stepSize: '0.00010000' },
        { filterType: 'NOTIONAL', minNotional: '10.00' },
      ],
    },
  ],
}

async function invokeApi(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const payload = body !== undefined ? JSON.stringify(body) : ''
  const req = Readable.from(
    payload ? [Buffer.from(payload, 'utf8')] : [],
  ) as unknown as http.IncomingMessage
  req.method = method
  req.url = urlPath
  req.headers = { host: 'localhost:3001', 'content-type': 'application/json' }

  let statusCode = 200
  let rawBody = ''
  const res = {
    setHeader() {},
    writeHead(code: number) {
      statusCode = code
      return this
    },
    end(chunk?: string | Buffer) {
      if (chunk) rawBody += chunk.toString()
      return this
    },
  } as unknown as http.ServerResponse

  await handleBotApiRequest(req, res)
  return {
    status: statusCode,
    json: rawBody ? JSON.parse(rawBody) : null,
  }
}

describe('Production Readiness — Milestones 1, 2 & 3', () => {
  let tmpDir: string
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    savedEnv = {}
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-prod-ready-'))
    process.env.FLARE_SQLITE_PATH = path.join(tmpDir, 'prod.db')
    stopBackgroundWorker()
    resetAllTenantRuntimes()
    clearAllTenantExchangeStates()
    clearSymbolFilterCacheForTests()
    resetAlertDispatcherForTests()
    resetStateStore()
  })

  afterEach(() => {
    stopBackgroundWorker()
    resetAllTenantRuntimes()
    clearAllTenantExchangeStates()
    clearSymbolFilterCacheForTests()
    resetAlertDispatcherForTests()
    resetStateStore()
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Milestone 1: Static SPA Server & Ops Alert Dispatcher ──────────────────
  it('serves built dist/ assets, SPA fallback for /training, /robots.txt, and blocks traversal', () => {
    const distDir = path.join(tmpDir, 'dist')
    fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(distDir, 'index.html'), '<html><body>FLARE</body></html>')
    fs.writeFileSync(path.join(distDir, 'robots.txt'), 'User-agent: *\nDisallow: /api\n')
    fs.writeFileSync(path.join(distDir, 'assets', 'app-123.js'), 'console.log("ok")')
    fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=topsecret')

    const callStatic = (url: string) => {
      let status = 0
      let headers: Record<string, string> = {}
      let body = ''
      const req = { method: 'GET', url } as http.IncomingMessage
      const res = {
        writeHead(code: number, h: Record<string, string>) {
          status = code
          headers = h
          return this
        },
        end(chunk?: string | Buffer) {
          if (chunk) body += chunk.toString()
          return this
        },
      } as unknown as http.ServerResponse
      const handled = tryServeStaticAsset(req, res, { distDir })
      return { handled, status, headers, body }
    }

    const spa = callStatic('/training')
    expect(spa.handled).toBe(true)
    expect(spa.status).toBe(200)
    expect(spa.headers['X-Robots-Tag']).toBe('noindex, nofollow')
    expect(spa.body).toContain('FLARE')

    const asset = callStatic('/assets/app-123.js')
    expect(asset.handled).toBe(true)
    expect(asset.headers['Cache-Control']).toContain('immutable')

    const robots = callStatic('/robots.txt')
    expect(robots.handled).toBe(true)
    expect(robots.body).toContain('Disallow: /api')

    expect(callStatic('/api/health').handled).toBe(false)
    expect(callStatic('/../.env').handled).toBe(false)
    expect(callStatic('/.env').handled).toBe(false)
    expect(callStatic('/missing-chunk.js').handled).toBe(false)
  })

  it('dispatches Discord/Telegram alerts, enforces cooldown, bypasses cooldown on KILL_SWITCH, and redacts secrets', async () => {
    process.env.FLARE_ALERT_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/abc'
    process.env.FLARE_TELEGRAM_BOT_TOKEN = '123456789:ABCDEF_FAKE_TOKEN'
    process.env.FLARE_TELEGRAM_CHAT_ID = '-100123456'
    process.env.FLARE_ALERT_MIN_SEVERITY = 'error'
    process.env.FLARE_ALERT_COOLDOWN_MS = '60000'

    const requests: { url: string; body: string }[] = []
    setAlertFetchForTests(async (input, init) => {
      requests.push({ url: String(input), body: String(init?.body ?? '') })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    // Info below minSeverity is ignored
    const infoRes = await dispatchRuntimeAlert({
      tenantId: 'default',
      type: 'TRADE',
      severity: 'info',
      source: 'paper',
      message: 'filled',
      timestamp: new Date().toISOString(),
      correlationId: 'ORD-1',
    })
    expect(infoRes.dispatched).toBe(false)
    expect(requests).toHaveLength(0)

    // Error dispatches to BOTH Discord + Telegram and redacts secret strings
    const errRes1 = await dispatchRuntimeAlert(
      {
        tenantId: 'default',
        type: 'ERROR',
        severity: 'error',
        source: 'bot-runtime',
        message: 'Failed with apiKey=supersecret999 and 0x1234567890abcdef1234567890abcdef12345678',
        timestamp: new Date().toISOString(),
        correlationId: 'ERR-1',
      },
      { nowMs: 1_000_000 },
    )
    expect(errRes1.dispatched).toBe(true)
    expect(errRes1.results).toHaveLength(2)
    expect(requests).toHaveLength(2)
    expect(requests[0].body).not.toContain('supersecret999')
    expect(requests[0].body).toContain('[REDACTED]')
    expect(sanitizeAlertText('token=abc123')).toContain('[REDACTED]')

    // Duplicate error within cooldown is suppressed
    const errRes2 = await dispatchRuntimeAlert(
      {
        tenantId: 'default',
        type: 'ERROR',
        severity: 'error',
        source: 'bot-runtime',
        message: 'Another error within cooldown',
        timestamp: new Date().toISOString(),
        correlationId: 'ERR-2',
      },
      { nowMs: 1_005_000 },
    )
    expect(errRes2.dispatched).toBe(false)
    expect(errRes2.suppressed).toBe(true)

    // CRITICAL (Kill-Switch) ALWAYS bypasses cooldown
    const killRes = await dispatchRuntimeAlert(
      {
        tenantId: 'default',
        type: 'RISK',
        severity: 'critical',
        source: 'binance-live',
        message: '[KILL-SWITCH] Emergency stop!',
        timestamp: new Date().toISOString(),
        correlationId: 'KILL-1',
      },
      { nowMs: 1_006_000 },
    )
    expect(killRes.dispatched).toBe(true)
    expect(requests).toHaveLength(4)

    // HTTP endpoints GET /api/alerts/status and POST /api/alerts/test
    const statusApi = await invokeApi('GET', '/api/alerts/status')
    expect(statusApi.status).toBe(200)
    expect((statusApi.json as { enabled: boolean }).enabled).toBe(true)

    const testApi = await invokeApi('POST', '/api/alerts/test')
    expect(testApi.status).toBe(200)
    expect((testApi.json as { dispatched: boolean }).dispatched).toBe(true)
    expect(getAlertDispatcherStatus().sentCount).toBe(3)
  })

  // ── Milestone 2: Paired Exchange Position PnL Attribution ───────────────────
  it('pairs bot-auto Testnet BUY->SELL fills into SQL exchange_positions and surfaces realized PnL in /api/training/live', async () => {
    process.env.BINANCE_TESTNET_KEY = 'testnet_key_123456789'
    process.env.BINANCE_TESTNET_SECRET = 'testnet_secret_123456789'
    process.env.FLARE_BINANCE_PROTECTIVE_EXITS = 'false'

    let orderSeq = 5000
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes('/api/v3/exchangeInfo')) {
        return new Response(JSON.stringify(MOCK_EXCHANGE_INFO), { status: 200 })
      }
      if (url.includes('/api/v3/order')) {
        orderSeq += 1
        const isBuy = url.includes('side=BUY')
        const price = isBuy ? 60_000 : 61_500
        const qty = 0.005
        return new Response(
          JSON.stringify({
            orderId: orderSeq,
            status: 'FILLED',
            origQty: String(qty),
            executedQty: String(qty),
            cummulativeQuoteQty: String((qty * price).toFixed(2)),
            fills: [{ commission: '0.15', commissionAsset: 'USDT' }],
          }),
          { status: 200 },
        )
      }
      return new Response('not found', { status: 404 })
    }

    const buyRes = await submitExchangeOrder({
      tenantId: 'default',
      pair: 'BTC/USDT',
      side: 'BUY',
      notionalUsd: 300,
      referencePrice: 60_000,
      stopPrice: 59_000,
      targetPrice: 62_000,
      source: 'bot-auto',
      presetId: 'btc-donchian-breakout-1h',
      clientOrderId: 'pair-entry-1',
      fetchImpl: mockFetch,
    })
    expect(buyRes.ok).toBe(true)

    const openPositions = await getStateStore().queryExchangePositions('default', {
      status: 'OPEN',
    })
    expect(openPositions).toHaveLength(1)
    expect(openPositions[0].presetId).toBe('btc-donchian-breakout-1h')
    expect(openPositions[0].entryVenueOrderId).toBe('5001')

    const sellRes = await submitExchangeOrder({
      tenantId: 'default',
      pair: 'BTC/USDT',
      side: 'SELL',
      notionalUsd: 307.5,
      exactQuantity: 0.005,
      referencePrice: 61_500,
      source: 'bot-auto',
      presetId: 'btc-donchian-breakout-1h',
      exitReason: 'target',
      bypassRiskForClose: true,
      clientOrderId: 'pair-exit-1',
      fetchImpl: mockFetch,
    })
    expect(sellRes.ok).toBe(true)

    // Expected net PnL = (61500 - 60000) * 0.005 - 0.15 - 0.15 = 7.50 - 0.30 = +7.20 USD
    // Risk = (60000 - 59000) * 0.005 = 5.00 USD -> R = 7.20 / 5.00 = +1.44R
    const liveRes = await invokeApi(
      'GET',
      '/api/training/live?presetId=btc-donchian-breakout-1h',
    )
    expect(liveRes.status).toBe(200)
    const live = liveRes.json as TrainingLiveShadowResponse
    expect(live.testnet.pnlAttributionAvailable).toBe(true)
    expect(live.testnet.closedPositionCount).toBe(1)
    expect(live.testnet.realizedPnlUsd).toBeCloseTo(7.2, 2)
    expect(live.testnet.winRatePct).toBe(100)
    expect(live.testnet.averageR).toBeCloseTo(1.44, 2)
    expect(live.testnet.positions?.[0].entryVenueOrderId).toBe('5001')
    expect(live.testnet.positions?.[0].exitVenueOrderId).toBe('5002')

    const posApi = await invokeApi(
      'GET',
      '/api/exchange/positions?presetId=btc-donchian-breakout-1h',
    )
    expect(posApi.status).toBe(200)
    expect(
      (posApi.json as { positions: unknown[] }).positions,
    ).toHaveLength(1)
  })

  // ── Milestone 3: Dual-Key Binance Live, Filters, OCO Stops & Reconciliation ─
  it('enforces dual-key arming, LOT_SIZE/NOTIONAL quantization, OCO protective stops, cancellation, and offline reconciliation', async () => {
    // 1. Live keys WITHOUT FLARE_BINANCE_LIVE=true MUST NOT arm live mainnet
    process.env.BINANCE_LIVE_KEY = 'live_key_1234567890'
    process.env.BINANCE_LIVE_SECRET = 'live_secret_1234567890'
    expect(getBinanceLiveArmStatus().liveKeysPresent).toBe(true)
    expect(getBinanceLiveArmStatus().liveArmed).toBe(false)
    expect(resolveBinanceVenueCredentials()).toBeNull()
    expect(getExchangeStatusSnapshot('default').mode).toBe('paper')

    // 2. Arm live mainnet explicitly
    process.env.FLARE_BINANCE_LIVE = 'true'
    process.env.FLARE_BINANCE_PROTECTIVE_EXITS = 'true'
    const venue = resolveBinanceVenueCredentials()
    expect(venue?.mode).toBe('binance-live')
    expect(venue?.baseUrl).toBe(BINANCE_LIVE_BASE_URL)
    expect(getExchangeStatusSnapshot('default').liveArmed).toBe(true)

    // 3. Exact decimal quantization & fail-closed filter validation
    expect(quantizeToStep(0.0056789, 0.0001, 'floor')).toEqual({
      value: 0.0056,
      text: '0.0056',
    })
    const tooSmall = validateAndQuantizeBinanceOrder(
      {
        symbol: 'BTCUSDT',
        minQty: 0.0001,
        maxQty: 100,
        stepSize: 0.0001,
        minPrice: 0.01,
        maxPrice: 1_000_000,
        tickSize: 0.01,
        minNotional: 10,
      },
      { price: 60_000, quantity: 0.0001 },
    )
    expect(tooSmall.ok).toBe(false)

    // 4. Live BUY fails closed if exchangeInfo cannot be fetched
    const failingExchangeInfoFetch: typeof fetch = async () =>
      new Response('down', { status: 503 })
    const failClosedRes = await submitExchangeOrder({
      tenantId: 'default',
      pair: 'BTC/USDT',
      side: 'BUY',
      notionalUsd: 300,
      referencePrice: 60_000,
      source: 'bot-auto',
      presetId: 'btc-donchian-breakout-1h',
      clientOrderId: 'live-fail-closed-1',
      fetchImpl: failingExchangeInfoFetch,
    })
    expect(failClosedRes.ok).toBe(false)
    expect(failClosedRes.error).toContain('exchangeInfo')

    // 5. Live BUY places quantized market order on api.binance.com + automatic OCO protective exit
    const calls: { method: string; url: string }[] = []
    const liveMockFetch: typeof fetch = async (input, init) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      calls.push({ method, url })

      if (url.includes('/api/v3/exchangeInfo')) {
        return new Response(JSON.stringify(MOCK_EXCHANGE_INFO), { status: 200 })
      }
      if (url.includes('/api/v3/orderList/oco') && method === 'POST') {
        return new Response(JSON.stringify({ orderListId: 88801 }), {
          status: 200,
        })
      }
      if (url.includes('/api/v3/orderList') && method === 'DELETE') {
        return new Response(JSON.stringify({ orderListId: 88801 }), {
          status: 200,
        })
      }
      if (url.includes('/api/v3/order') && method === 'POST') {
        return new Response(
          JSON.stringify({
            orderId: 77701,
            status: 'FILLED',
            origQty: '0.0050',
            executedQty: '0.0050',
            cummulativeQuoteQty: '300.00',
            fills: [{ commission: '0.30', commissionAsset: 'USDT' }],
          }),
          { status: 200 },
        )
      }
      if (url.includes('/api/v3/openOrders') && method === 'GET') {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('/api/v3/openOrders') && method === 'DELETE') {
        return new Response(JSON.stringify([{ orderId: 88801 }]), { status: 200 })
      }
      if (url.includes('/api/v3/myTrades') && method === 'GET') {
        // Simulate protective OCO stop-loss filled while server was offline!
        return new Response(
          JSON.stringify([
            {
              orderId: 99901,
              isBuyer: false,
              price: '59000.00',
              qty: '0.0050',
              commission: '0.295',
              commissionAsset: 'USDT',
              time: Date.now(),
            },
          ]),
          { status: 200 },
        )
      }
      return new Response('not found', { status: 404 })
    }

    const liveBuy = await submitExchangeOrder({
      tenantId: 'default',
      pair: 'BTC/USDT',
      side: 'BUY',
      notionalUsd: 300,
      referencePrice: 60_000,
      stopPrice: 59_000,
      targetPrice: 62_000,
      source: 'bot-auto',
      presetId: 'btc-donchian-breakout-1h',
      clientOrderId: 'live-entry-oco-1',
      fetchImpl: liveMockFetch,
    })
    expect(liveBuy.ok).toBe(true)
    expect(liveBuy.order.mode).toBe('binance-live')
    expect(calls.some((c) => c.url.startsWith(`${BINANCE_LIVE_BASE_URL}/api/v3/order?`))).toBe(true)
    expect(calls.some((c) => c.url.startsWith(`${BINANCE_LIVE_BASE_URL}/api/v3/orderList/oco?`))).toBe(true)

    const openLivePos = await getStateStore().queryExchangePositions('default', {
      mode: 'binance-live',
      status: 'OPEN',
    })
    expect(openLivePos).toHaveLength(1)
    expect(openLivePos[0].protectionOrderId).toBe('oco:88801')

    // 6. Startup/on-demand reconciliation closes the OPEN position when protective stop filled offline
    const rec = await reconcileExchangeVenue('default', {
      fetchImpl: liveMockFetch,
    })
    expect(rec?.mode).toBe('binance-live')
    expect(rec?.reconciledClosedPositions).toHaveLength(1)
    expect(rec?.reconciledClosedPositions[0].exitReason).toBe(
      'exchange-protective-exit',
    )
    expect(rec?.reconciledClosedPositions[0].realizedPnlUsd).toBeCloseTo(
      -5.595,
      2,
    )
    expect(getExchangeStatusSnapshot('default').botOwnedPosition).toBeNull()

    // 7. Kill-switch hits api.binance.com DELETE /api/v3/openOrders and fires immediate alert
    process.env.FLARE_ALERT_WEBHOOK_URL = 'https://hooks.slack.com/services/T/B/X'
    const alertPayloads: string[] = []
    setAlertFetchForTests(async (_u, init) => {
      alertPayloads.push(String(init?.body ?? ''))
      return new Response('ok', { status: 200 })
    })
    const kill = await triggerEmergencyKillSwitch(
      'Live drill',
      undefined,
      'default',
      { fetchImpl: liveMockFetch },
    )
    expect(kill.killOrder.mode).toBe('binance-live')
    expect(kill.canceledVenueOrderIds).toContain('88801')
    expect(
      calls.some(
        (c) =>
          c.method === 'DELETE' &&
          c.url.startsWith(`${BINANCE_LIVE_BASE_URL}/api/v3/openOrders`),
      ),
    ).toBe(true)
    // Allow fire-and-forget kill-switch alert microtask to settle
    await new Promise((r) => setTimeout(r, 20))
    expect(alertPayloads.some((p) => p.includes('KILL-SWITCH'))).toBe(true)
  })
})
