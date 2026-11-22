import { EventEmitter } from 'node:events'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearRegisteredApiTokens,
  registerApiToken,
} from './auth'
import {
  flushStatePersistence,
  handleBotApiRequest,
  resetAllTenantRuntimes,
  stopBackgroundWorker,
} from './botRuntime'
import { resetSharedStateAdapter } from './cache/sharedState'
import { clearAllTenantExchangeStates } from './exchangeAdapter'
import { resetStateStore } from './store'

type MockHttpResponse = {
  status: number
  headers: Record<string, string>
  bodyText: string
  json: <T = Record<string, unknown>>() => T
}

async function invokeApi(params: {
  method: string
  url: string
  headers?: Record<string, string>
  body?: unknown
}): Promise<MockHttpResponse> {
  const payload =
    params.body !== undefined ? [Buffer.from(JSON.stringify(params.body))] : []
  const req = Readable.from(payload) as unknown as http.IncomingMessage
  req.method = params.method
  req.url = params.url
  req.headers = Object.fromEntries(
    Object.entries(params.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  )

  let status = 0
  let headers: Record<string, string> = {}
  let bodyText = ''
  const res = {
    writeHead(code: number, hdrs?: Record<string, string>) {
      status = code
      headers = Object.fromEntries(
        Object.entries(hdrs ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
      )
    },
    end(chunk?: string) {
      if (chunk) bodyText += chunk
    },
  } as unknown as http.ServerResponse

  await handleBotApiRequest(req, res)
  return {
    status,
    headers,
    bodyText,
    json: <T = Record<string, unknown>>() => JSON.parse(bodyText) as T,
  }
}

describe('P0-3 Security: Auth, RBAC, Multi-Tenant Isolation, Rate Limits & Strict CORS', () => {
  const savedEnv = {
    NODE_ENV: process.env.NODE_ENV,
    FLARE_AUTH_REQUIRED: process.env.FLARE_AUTH_REQUIRED,
    FLARE_CORS_ORIGINS: process.env.FLARE_CORS_ORIGINS,
    FLARE_RATE_LIMIT_READ_RPM: process.env.FLARE_RATE_LIMIT_READ_RPM,
    FLARE_RATE_LIMIT_WRITE_RPM: process.env.FLARE_RATE_LIMIT_WRITE_RPM,
  }

  beforeEach(async () => {
    clearRegisteredApiTokens()
    resetSharedStateAdapter()
    resetAllTenantRuntimes()
    clearAllTenantExchangeStates()
    await resetStateStore(':memory:')
    process.env.FLARE_AUTH_REQUIRED = 'true'
    registerApiToken({
      token: 'tok-alpha-viewer-111',
      tenantId: 'tenant-alpha',
      role: 'viewer',
      subject: 'alice@alpha',
    })
    registerApiToken({
      token: 'tok-alpha-trader-222',
      tenantId: 'tenant-alpha',
      role: 'trader',
      subject: 'todd@alpha',
    })
    registerApiToken({
      token: 'tok-alpha-risk-333',
      tenantId: 'tenant-alpha',
      role: 'risk_manager',
      subject: 'rachel@alpha',
    })
    registerApiToken({
      token: 'tok-alpha-admin-444',
      tenantId: 'tenant-alpha',
      role: 'admin',
      subject: 'ada@alpha',
    })
    registerApiToken({
      token: 'tok-beta-trader-555',
      tenantId: 'tenant-beta',
      role: 'trader',
      subject: 'bob@beta',
    })
  })

  afterEach(async () => {
    stopBackgroundWorker()
    await flushStatePersistence()
    clearRegisteredApiTokens()
    resetAllTenantRuntimes()
    clearAllTenantExchangeStates()
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('rejects missing or invalid credentials with 401 while keeping /api/health safe', async () => {
    const health = await invokeApi({ method: 'GET', url: '/api/health' })
    expect(health.status).toBe(200)
    expect(health.json()).toMatchObject({ status: 'ok', storeDriver: 'sqlite' })
    expect(health.json().exchange).toBeUndefined()

    const noAuth = await invokeApi({ method: 'GET', url: '/api/bot/status' })
    expect(noAuth.status).toBe(401)

    const badAuth = await invokeApi({
      method: 'GET',
      url: '/api/bot/status',
      headers: { Authorization: 'Bearer wrong-token-999' },
    })
    expect(badAuth.status).toBe(401)
  })

  it('enforces RBAC role permissions across viewer, trader, risk_manager and admin', async () => {
    // Viewer can read status, cannot trade or read audit
    const viewerStatus = await invokeApi({
      method: 'GET',
      url: '/api/bot/status',
      headers: { Authorization: 'Bearer tok-alpha-viewer-111' },
    })
    expect(viewerStatus.status).toBe(200)

    const viewerOrder = await invokeApi({
      method: 'POST',
      url: '/api/exchange/order',
      headers: { Authorization: 'Bearer tok-alpha-viewer-111' },
      body: { pair: 'BTC/USDT', side: 'BUY', notionalUsd: 50, referencePrice: 50_000 },
    })
    expect(viewerOrder.status).toBe(403)

    // Trader can place orders and engage kill-switch, cannot update limits or reset kill-switch
    const traderOrder = await invokeApi({
      method: 'POST',
      url: '/api/exchange/order',
      headers: { Authorization: 'Bearer tok-alpha-trader-222' },
      body: { pair: 'BTC/USDT', side: 'BUY', notionalUsd: 50, referencePrice: 50_000 },
    })
    expect(traderOrder.status).toBe(200)

    const traderLimits = await invokeApi({
      method: 'POST',
      url: '/api/exchange/limits',
      headers: { Authorization: 'Bearer tok-alpha-trader-222' },
      body: { maxOrderNotionalUsd: 900 },
    })
    expect(traderLimits.status).toBe(403)

    const traderEngage = await invokeApi({
      method: 'POST',
      url: '/api/exchange/kill-switch',
      headers: { Authorization: 'Bearer tok-alpha-trader-222' },
      body: { action: 'engage', reason: 'Emergency trader stop' },
    })
    expect(traderEngage.status).toBe(200)

    const traderReset = await invokeApi({
      method: 'POST',
      url: '/api/exchange/kill-switch',
      headers: { Authorization: 'Bearer tok-alpha-trader-222' },
      body: { action: 'reset' },
    })
    expect(traderReset.status).toBe(403)

    // Risk manager CAN reset kill-switch & read audit, cannot run admin retention
    const riskReset = await invokeApi({
      method: 'POST',
      url: '/api/exchange/kill-switch',
      headers: { Authorization: 'Bearer tok-alpha-risk-333' },
      body: { action: 'reset' },
    })
    expect(riskReset.status).toBe(200)

    const riskAudit = await invokeApi({
      method: 'GET',
      url: '/api/audit',
      headers: { Authorization: 'Bearer tok-alpha-risk-333' },
    })
    expect(riskAudit.status).toBe(200)
    expect((riskAudit.json().events as unknown[]).length).toBeGreaterThanOrEqual(3)

    const riskRetention = await invokeApi({
      method: 'POST',
      url: '/api/admin/retention',
      headers: { Authorization: 'Bearer tok-alpha-risk-333' },
      body: { retentionDays: 90 },
    })
    expect(riskRetention.status).toBe(403)

    // Admin CAN run retention
    const adminRetention = await invokeApi({
      method: 'POST',
      url: '/api/admin/retention',
      headers: { Authorization: 'Bearer tok-alpha-admin-444' },
      body: { retentionDays: 90 },
    })
    expect(adminRetention.status).toBe(200)
  })

  it('strictly isolates state, ledger and SSE streams between tenants', async () => {
    // Cross-tenant header spoofing is rejected with 403
    const spoof = await invokeApi({
      method: 'GET',
      url: '/api/bot/status',
      headers: {
        Authorization: 'Bearer tok-alpha-trader-222',
        'X-Tenant-Id': 'tenant-beta',
      },
    })
    expect(spoof.status).toBe(403)

    // Subscribe SSE client for tenant-beta
    const betaChunks: string[] = []
    const betaReq = Object.assign(new EventEmitter(), {
      method: 'GET',
      url: '/api/bot/stream?token=tok-beta-trader-555',
      headers: {},
    }) as unknown as http.IncomingMessage
    const betaRes = Object.assign(new EventEmitter(), {
      writableEnded: false,
      destroyed: false,
      writableNeedDrain: false,
      writeHead: () => {},
      write: (chunk: string | Buffer) => {
        betaChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
        return true
      },
      end: () => {},
    }) as unknown as http.ServerResponse
    await handleBotApiRequest(betaReq, betaRes)
    expect(betaChunks).toHaveLength(1)

    // Tenant Alpha explicitly funds its PAPER account, places an order, and triggers kill-switch
    const alphaFund = await invokeApi({
      method: 'POST',
      url: '/api/paper/fund',
      headers: { Authorization: 'Bearer tok-alpha-admin-444' },
      body: { amountUsd: 10_000 },
    })
    expect(alphaFund.status).toBe(200)

    const alphaOrder = await invokeApi({
      method: 'POST',
      url: '/api/exchange/order',
      headers: { Authorization: 'Bearer tok-alpha-trader-222' },
      body: { pair: 'BTC/USDT', side: 'BUY', notionalUsd: 200, referencePrice: 50_000 },
    })
    expect(alphaOrder.status).toBe(200)

    await invokeApi({
      method: 'POST',
      url: '/api/exchange/kill-switch',
      headers: { Authorization: 'Bearer tok-alpha-trader-222' },
      body: { action: 'engage', reason: 'Alpha lock' },
    })

    // Tenant Beta SSE received ZERO cross-tenant broadcasts
    expect(betaChunks).toHaveLength(1)
    betaReq.emit('close')

    // Tenant Beta's status & ledger remain untouched
    const betaStatus = await invokeApi({
      method: 'GET',
      url: '/api/bot/status',
      headers: { Authorization: 'Bearer tok-beta-trader-555' },
    })
    const betaSnap = betaStatus.json<{
      tenantId: string
      exchange: { killSwitchActive: boolean; dailyOrderCount: number }
    }>()
    expect(betaSnap.tenantId).toBe('tenant-beta')
    expect(betaSnap.exchange.killSwitchActive).toBe(false)
    expect(betaSnap.exchange.dailyOrderCount).toBe(0)

    const alphaLedger = await invokeApi({
      method: 'GET',
      url: '/api/ledger',
      headers: { Authorization: 'Bearer tok-alpha-trader-222' },
    })
    expect(alphaLedger.status).toBe(200)
    expect(
      (alphaLedger.json().walletBalances as Record<string, number>).USDT,
    ).toBeCloseTo(9_800, 2)
  })

  it('enforces per-principal rate limits (429) and strict production CORS allowlist', async () => {
    process.env.FLARE_RATE_LIMIT_READ_RPM = '2'
    const r1 = await invokeApi({
      method: 'GET',
      url: '/api/bot/status',
      headers: { Authorization: 'Bearer tok-alpha-viewer-111' },
    })
    const r2 = await invokeApi({
      method: 'GET',
      url: '/api/bot/status',
      headers: { Authorization: 'Bearer tok-alpha-viewer-111' },
    })
    const r3 = await invokeApi({
      method: 'GET',
      url: '/api/bot/status',
      headers: { Authorization: 'Bearer tok-alpha-viewer-111' },
    })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(r3.status).toBe(429)
    expect(r3.headers['retry-after']).toBeDefined()
    expect(r3.headers['x-ratelimit-remaining']).toBe('0')

    // Production CORS: no wildcard *, only allowlisted origins permitted
    process.env.NODE_ENV = 'production'
    process.env.FLARE_CORS_ORIGINS = 'https://app.flare.trade'

    const blockedPreflight = await invokeApi({
      method: 'OPTIONS',
      url: '/api/bot/status',
      headers: { Origin: 'https://evil.example.com' },
    })
    expect(blockedPreflight.status).toBe(403)
    expect(blockedPreflight.headers['access-control-allow-origin']).toBeUndefined()

    const allowedPreflight = await invokeApi({
      method: 'OPTIONS',
      url: '/api/bot/status',
      headers: { Origin: 'https://app.flare.trade' },
    })
    expect(allowedPreflight.status).toBe(204)
    expect(allowedPreflight.headers['access-control-allow-origin']).toBe(
      'https://app.flare.trade',
    )
    expect(allowedPreflight.headers['access-control-allow-origin']).not.toBe('*')
  })
})
