import type http from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PromotionReport } from '../../prediction/replayHarness'
import { clearRegisteredApiTokens, registerApiToken } from '../auth'
import {
  flushStatePersistence,
  handleBotApiRequest,
  resetAllTenantRuntimes,
  stopBackgroundWorker,
} from '../botRuntime'
import { resetSharedStateAdapter } from '../cache/sharedState'
import { clearAllTenantExchangeStates } from '../exchangeAdapter'
import { getStateStore, resetStateStore } from '../store'
import { resetClobBookFeed } from './clobBookFeed'
import { getOracleFeed, resetOracleFeed } from './oracleFeed'
import {
  getPredictionRunner,
  resetPredictionRunner,
  type PredictionEngineStatus,
} from './predictionRunner'

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

describe('Prediction Engine Runtime API (/api/prediction-engine/*)', () => {
  const savedEnv = {
    FLARE_AUTH_REQUIRED: process.env.FLARE_AUTH_REQUIRED,
  }

  beforeEach(async () => {
    stopBackgroundWorker()
    clearRegisteredApiTokens()
    resetSharedStateAdapter()
    resetAllTenantRuntimes()
    clearAllTenantExchangeStates()
    resetClobBookFeed()
    resetOracleFeed()
    const store = await resetStateStore(':memory:')
    resetPredictionRunner({
      store,
      oracleFeed: getOracleFeed(),
      tenantId: 'tenant-alpha',
    })
    process.env.FLARE_AUTH_REQUIRED = 'true'

    registerApiToken({
      token: 'tok-viewer-111',
      tenantId: 'tenant-alpha',
      role: 'viewer',
      subject: 'viewer@flare',
    })
    registerApiToken({
      token: 'tok-researcher-222',
      tenantId: 'tenant-alpha',
      role: 'researcher',
      subject: 'researcher@flare',
    })
    registerApiToken({
      token: 'tok-trader-333',
      tenantId: 'tenant-alpha',
      role: 'trader',
      subject: 'trader@flare',
    })
    registerApiToken({
      token: 'tok-risk-444',
      tenantId: 'tenant-alpha',
      role: 'risk_manager',
      subject: 'risk@flare',
    })
    registerApiToken({
      token: 'tok-admin-555',
      tenantId: 'tenant-alpha',
      role: 'admin',
      subject: 'admin@flare',
    })
  })

  afterEach(async () => {
    stopBackgroundWorker()
    resetPredictionRunner()
    resetClobBookFeed()
    resetOracleFeed()
    await flushStatePersistence()
    if (savedEnv.FLARE_AUTH_REQUIRED === undefined) {
      delete process.env.FLARE_AUTH_REQUIRED
    } else {
      process.env.FLARE_AUTH_REQUIRED = savedEnv.FLARE_AUTH_REQUIRED
    }
  })

  it('guards background prediction runner startup when process.env.VITEST is set', async () => {
    expect(process.env.VITEST).toBeTruthy()
    const res = await invokeApi({
      method: 'GET',
      url: '/api/prediction-engine/status',
      headers: { authorization: 'Bearer tok-viewer-111' },
    })
    expect(res.status).toBe(200)
    expect(getPredictionRunner().isRunning()).toBe(false)
    const status = res.json<PredictionEngineStatus>()
    expect(status.running).toBe(false)
    expect(status.strategies).toHaveLength(8)
  })

  it('requires authentication on /api/prediction-engine/status and allows viewer read:state', async () => {
    const unauth = await invokeApi({
      method: 'GET',
      url: '/api/prediction-engine/status',
    })
    expect(unauth.status).toBe(401)

    const viewerRes = await invokeApi({
      method: 'GET',
      url: '/api/prediction-engine/status',
      headers: { authorization: 'Bearer tok-viewer-111' },
    })
    expect(viewerRes.status).toBe(200)
    const payload = viewerRes.json<PredictionEngineStatus>()
    expect(payload.tenantId).toBe('tenant-alpha')
    expect(payload.collector.settledCountsByTimeframe).toEqual({
      '5m': 0,
      '15m': 0,
      '1h': 0,
    })
    expect(payload.canaryRisk.config.stakeUsd).toBe(5)
    expect(payload.canaryRisk.config.maxConcurrentBtcExposureUsd).toBe(15)
    expect(payload.strategies.map((s) => s.id)).toContain('c5-late-favorite')
  })

  it('returns filtered windows, trades, and settled counts on GET /api/prediction-engine/windows', async () => {
    const store = getStateStore()
    await store.upsertPredictionWindow({
      slug: 'btc-updown-5m-1700000000',
      timeframe: '5m',
      conditionId: 'cond-5m-1',
      upTokenId: 'tok-up-1',
      downTokenId: 'tok-dn-1',
      resolutionSource: 'chainlink-twap-60s',
      startTimeMs: 1_700_000_000_000,
      endTimeMs: 1_700_000_300_000,
      openTwap: 90_000,
      closeTwap: 90_120,
      resolvedUp: true,
      tickSize: 0.01,
      negRisk: false,
      volumeUsd: 12_500,
      updatedAt: 1_700_000_305_000,
    })
    await store.upsertPredictionWindow({
      slug: 'btc-updown-15m-1700000000',
      timeframe: '15m',
      conditionId: 'cond-15m-1',
      upTokenId: 'tok-up-2',
      downTokenId: 'tok-dn-2',
      resolutionSource: 'chainlink-twap-60s',
      startTimeMs: 1_700_000_000_000,
      endTimeMs: 1_700_000_900_000,
      openTwap: 90_000,
      closeTwap: 89_900,
      resolvedUp: false,
      tickSize: 0.01,
      negRisk: false,
      volumeUsd: 24_000,
      updatedAt: 1_700_000_905_000,
    })
    await store.upsertPredictionTrade({
      id: 'TRD-5M-1',
      tenantId: 'tenant-alpha',
      strategyId: 'c5-late-favorite',
      lane: 'high-hit-rate',
      mode: 'paper',
      slug: 'btc-updown-5m-1700000000',
      timeframe: '5m',
      outcome: 'YES',
      liquidityRole: 'taker',
      entryTimeMs: 1_700_000_250_000,
      entryPrice: 0.8,
      shares: 6.25,
      stakeUsd: 5,
      feeUsd: 0.04,
      pModel: 0.87,
      pCalibrated: 0.86,
      markout30s: 0.03,
      status: 'SETTLED',
      resolvedUp: true,
      won: true,
      netPnlUsd: 1.21,
      venueOrderId: null,
    })

    const res = await invokeApi({
      method: 'GET',
      url: '/api/prediction-engine/windows?tf=5m&limit=10',
      headers: { authorization: 'Bearer tok-viewer-111' },
    })
    expect(res.status).toBe(200)
    const body = res.json<{
      timeframe: string
      limit: number
      settledCountsByTimeframe: Record<string, number>
      windows: { slug: string }[]
      trades: { id: string }[]
    }>()
    expect(body.timeframe).toBe('5m')
    expect(body.limit).toBe(10)
    expect(body.settledCountsByTimeframe).toEqual({
      '5m': 1,
      '15m': 1,
      '1h': 0,
    })
    expect(body.windows).toHaveLength(1)
    expect(body.windows[0].slug).toBe('btc-updown-5m-1700000000')
    expect(body.trades).toHaveLength(1)
    expect(body.trades[0].id).toBe('TRD-5M-1')
  })

  it('enforces RBAC on POST /api/prediction-engine/mode across viewer, trader, and risk_manager', async () => {
    // 1. Viewer is denied (403) even for paper mode
    const viewerAttempt = await invokeApi({
      method: 'POST',
      url: '/api/prediction-engine/mode',
      headers: { authorization: 'Bearer tok-viewer-111' },
      body: { strategyId: 'c5-late-favorite', mode: 'paper' },
    })
    expect(viewerAttempt.status).toBe(403)

    // 2. Trader can switch between paper, disabled, research, and halt (200)
    const traderDisable = await invokeApi({
      method: 'POST',
      url: '/api/prediction-engine/mode',
      headers: { authorization: 'Bearer tok-trader-333' },
      body: { strategyId: 'c5-late-favorite', mode: 'disabled' },
    })
    expect(traderDisable.status).toBe(200)
    expect(traderDisable.json<{ ok: boolean }>().ok).toBe(true)

    const traderHalt = await invokeApi({
      method: 'POST',
      url: '/api/prediction-engine/mode',
      headers: { authorization: 'Bearer tok-trader-333' },
      body: {
        strategyId: 'c5-late-favorite',
        halt: true,
        haltedReason: 'Trader manual pause',
      },
    })
    expect(traderHalt.status).toBe(200)
    const haltedStrat = traderHalt
      .json<{ status: PredictionEngineStatus }>()
      .status.strategies.find((s) => s.id === 'c5-late-favorite')
    expect(haltedStrat?.mode).toBe('disabled')
    expect(haltedStrat?.haltedReason).toBe('Trader manual pause')

    // 3. Trader is denied (403) when promoting to canary, using forceOverride, or mutating canaryConfig
    const traderCanaryAttempt = await invokeApi({
      method: 'POST',
      url: '/api/prediction-engine/mode',
      headers: { authorization: 'Bearer tok-trader-333' },
      body: { strategyId: 'c5-late-favorite', mode: 'canary' },
    })
    expect(traderCanaryAttempt.status).toBe(403)

    const traderConfigAttempt = await invokeApi({
      method: 'POST',
      url: '/api/prediction-engine/mode',
      headers: { authorization: 'Bearer tok-trader-333' },
      body: { canaryConfig: { stakeUsd: 4 } },
    })
    expect(traderConfigAttempt.status).toBe(403)
  })

  it('enforces n >= 500 promotion gate (422) without override and records audit_events on risk_manager forceOverride', async () => {
    // 1. Risk manager promoting to canary with < 500 settled windows without override -> 422
    const unforced = await invokeApi({
      method: 'POST',
      url: '/api/prediction-engine/mode',
      headers: { authorization: 'Bearer tok-risk-444' },
      body: {
        strategyId: 'c5-late-favorite',
        mode: 'canary',
      },
    })
    expect(unforced.status).toBe(422)
    const unforcedBody = unforced.json<{
      ok: boolean
      error: string
      transition: { allowed: boolean; failures: string[] }
    }>()
    expect(unforcedBody.ok).toBe(false)
    expect(unforcedBody.transition.allowed).toBe(false)
    expect(unforcedBody.error).toContain('Minimum sample gate failed')

    // 2. Risk manager promoting to canary WITH forceOverride: true & overrideReason -> 200 + audit_events
    const forced = await invokeApi({
      method: 'POST',
      url: '/api/prediction-engine/mode',
      headers: { authorization: 'Bearer tok-risk-444' },
      body: {
        strategyId: 'c5-late-favorite',
        mode: 'canary',
        forceOverride: true,
        overrideReason: 'Approved $5 canary rollout after synthetic stress check',
      },
    })
    expect(forced.status).toBe(200)
    const forcedBody = forced.json<{
      ok: boolean
      transition: { allowed: boolean; forcedOverride: boolean; toMode: string }
      status: PredictionEngineStatus
    }>()
    expect(forcedBody.ok).toBe(true)
    expect(forcedBody.transition.allowed).toBe(true)
    expect(forcedBody.transition.forcedOverride).toBe(true)
    expect(forcedBody.transition.toMode).toBe('canary')
    const strat = forcedBody.status.strategies.find(
      (s) => s.id === 'c5-late-favorite',
    )
    expect(strat?.mode).toBe('canary')
    expect(strat?.forcedOverride).toBe(true)

    // 3. Risk manager updating canaryConfig and macroBlackoutWindows -> 200 + audit_events
    const blackoutTs = 1_760_000_000_000
    const cfgRes = await invokeApi({
      method: 'POST',
      url: '/api/prediction-engine/mode',
      headers: { authorization: 'Bearer tok-risk-444' },
      body: {
        canaryConfig: {
          stakeUsd: 5,
          maxDailyLosses: 4,
          maxConcurrentBtcExposureUsd: 15,
        },
        macroBlackoutWindows: [
          {
            timestampMs: blackoutTs,
            label: 'US CPI Release',
          },
        ],
      },
    })
    expect(cfgRes.status).toBe(200)
    const cfgStatus = cfgRes.json<{ status: PredictionEngineStatus }>().status
    expect(cfgStatus.canaryRisk.config.maxDailyLosses).toBe(4)
    expect(cfgStatus.macroBlackoutWindows).toHaveLength(1)
    expect(cfgStatus.macroBlackoutWindows[0].label).toBe('US CPI Release')

    const audits = await getStateStore().getAuditEvents('tenant-alpha', 50)
    const promoteAudit = audits.find(
      (a) =>
        a.action === 'prediction.strategy.promote' &&
        a.actor === 'risk@flare' &&
        a.outcome === 'allowed',
    )
    expect(promoteAudit).toBeDefined()
    expect(promoteAudit?.role).toBe('risk_manager')
    expect(promoteAudit?.details?.forcedOverride).toBe(true)

    const configAudit = audits.find(
      (a) => a.action === 'prediction.canary.config' && a.actor === 'risk@flare',
    )
    expect(configAudit).toBeDefined()
  })

  it('runs deterministic walk-forward replay on POST /api/prediction-engine/replay with run:research RBAC', async () => {
    const store = getStateStore()
    const baseMs = 1_700_100_000_000
    for (let i = 0; i < 6; i++) {
      const slug = `btc-updown-5m-${1700100000 + i * 300}`
      const startTimeMs = baseMs + i * 300_000
      const endTimeMs = startTimeMs + 300_000
      await store.upsertPredictionWindow({
        slug,
        timeframe: '5m',
        conditionId: `cond-${i}`,
        upTokenId: `up-${i}`,
        downTokenId: `dn-${i}`,
        resolutionSource: 'chainlink-twap-60s',
        startTimeMs,
        endTimeMs,
        openTwap: 90_000,
        closeTwap: 90_150,
        resolvedUp: true,
        tickSize: 0.01,
        negRisk: false,
        volumeUsd: 15_000,
        updatedAt: endTimeMs + 5_000,
      })
      await store.appendPredictionSnapshot({
        slug,
        capturedAtMs: endTimeMs - 45_000,
        secondsRemaining: 45,
        twapPrice: 90_140,
        binancePrice: 90_142,
        sigma1m: 0.0008,
        basisBps: 0.2,
        yesBid: 0.78,
        yesAsk: 0.8,
        yesDepthUsd: 800,
        noBid: 0.19,
        noAsk: 0.21,
        noDepthUsd: 800,
        pModelYes: 0.91,
      })
      await store.appendPredictionSnapshot({
        slug,
        capturedAtMs: endTimeMs - 15_000,
        secondsRemaining: 15,
        twapPrice: 90_148,
        binancePrice: 90_150,
        sigma1m: 0.0008,
        basisBps: 0.2,
        yesBid: 0.88,
        yesAsk: 0.9,
        yesDepthUsd: 900,
        noBid: 0.09,
        noAsk: 0.11,
        noDepthUsd: 900,
        pModelYes: 0.96,
      })
    }

    // Viewer gets 403
    const viewerReplay = await invokeApi({
      method: 'POST',
      url: '/api/prediction-engine/replay',
      headers: { authorization: 'Bearer tok-viewer-111' },
      body: { strategyId: 'c5-late-favorite' },
    })
    expect(viewerReplay.status).toBe(403)

    // Researcher gets 200 with PromotionReport
    const researcherReplay = await invokeApi({
      method: 'POST',
      url: '/api/prediction-engine/replay',
      headers: { authorization: 'Bearer tok-researcher-222' },
      body: { strategyId: 'c5-late-favorite' },
    })
    expect(researcherReplay.status).toBe(200)
    const body = researcherReplay.json<
      PromotionReport & { ok: boolean; report: PromotionReport }
    >()
    expect(body.ok).toBe(true)
    expect(body.report.strategyId).toBe('c5-late-favorite')
    expect(body.report.settledWindowCount).toBe(6)
    expect(body.settledWindowCount).toBe(6)
  })
})
