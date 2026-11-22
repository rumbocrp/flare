import fs from 'node:fs'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STRATEGY_PRESETS } from '../botEngine'
import { intervalMs } from '../market/intervals'
import {
  handleBotApiRequest,
  resetAllTenantRuntimes,
  stopBackgroundWorker,
} from '../server/botRuntime'
import {
  clearCandleCache,
  resetCandleMarketSource,
  setCandleMarketSource,
} from '../server/candleCache'
import {
  clearAllTenantExchangeStates,
  fundPaperAccount,
  submitExchangeOrder,
} from '../server/exchangeAdapter'
import { getStateStore, resetStateStore } from '../server/store'
import type { Candle, Interval, MarketDataSource } from '../types'
import { runTrainingOffloaded } from '../workers/trainingClient'
import {
  buildWalkForwardFolds,
  MAX_COORDINATE_EVALUATIONS,
  runTrainingPipeline,
  TrainingCancelledError,
} from './runner'
import type {
  HistoricalCandlesResponse,
  TrainingConfig,
  TrainingLiveShadowResponse,
  TrainingProgress,
  TrainingRunRecord,
} from './types'

function buildFixtureCandles(
  count: number,
  interval: Interval = '15m',
  endTimeMs = Date.UTC(2026, 10, 1, 0, 0, 0),
): Candle[] {
  const step = intervalMs[interval]
  const start = endTimeMs - (count - 1) * step
  const candles: Candle[] = []
  let price = 60_000

  for (let i = 0; i < count; i += 1) {
    // Realistic multi-regime waves (~0.4%–1.4% bars) with alternating trends, breakouts, and pullbacks
    const trendWave = Math.sin(i / 36) * 520
    const swingWave = Math.sin(i / 9) * 380
    const pullback = (i % 7 === 3 || i % 7 === 4 ? -1 : 1) * Math.sign(trendWave || 1) * 180
    const delta = trendWave * 0.55 + swingWave * 0.45 + pullback * 0.6
    const open = price
    const close = Math.max(15_000, open + delta)
    const wick = Math.abs(delta) * 0.18 + 30 + (i % 4) * 10
    const high = Math.max(open, close) + wick
    const low = Math.max(5_000, Math.min(open, close) - wick)
    candles.push({
      time: start + i * step,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume: 120 + (i % 9) * 35,
    })
    price = close
  }

  return candles
}

async function invokeApi(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = body !== undefined ? JSON.stringify(body) : ''
  const req = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : []) as unknown as http.IncomingMessage
  req.method = method
  req.url = url
  req.headers = {
    'content-type': 'application/json',
    ...headers,
  }

  let statusCode = 200
  let rawBody = ''
  const res = {
    writeHead(status: number) {
      statusCode = status
      return res
    },
    end(chunk?: string | Buffer) {
      if (chunk) rawBody += chunk.toString()
      return res
    },
  } as unknown as http.ServerResponse

  await handleBotApiRequest(req, res)
  return {
    status: statusCode,
    json: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
  }
}

describe('Phase 2 — Training runner, historical candles, worker & server verification', () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-training-p2-'))
    dbPath = path.join(tmpDir, 'flare.db')
    await resetStateStore(dbPath)
    resetAllTenantRuntimes()
    clearAllTenantExchangeStates()
    clearCandleCache()
    resetCandleMarketSource()
  })

  afterEach(async () => {
    stopBackgroundWorker()
    resetAllTenantRuntimes()
    clearAllTenantExchangeStates()
    clearCandleCache()
    resetCandleMarketSource()
    await resetStateStore(':memory:')
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('proves strict test-window isolation: mutating held-out test candles never alters fit, candidates, or validation selection', () => {
    const preset = STRATEGY_PRESETS.find((p) => p.id === 'btc-donchian-breakout-1h')!
    const candles = buildFixtureCandles(640, '1h')
    const config: TrainingConfig = {
      kind: 'walk-forward',
      presetId: preset.id,
      pair: preset.strategy.pair,
      timeframe: preset.timeframe,
      fromTimeMs: candles[0].time,
      toTimeMs: candles[candles.length - 1].time,
      foldCount: 5,
      foldMode: 'anchored',
      trainRatio: 0.55,
      valRatio: 0.2,
      testRatio: 0.25,
      purgeGapBars: 5,
      assumptions: {
        commissionPct: preset.execution.commissionPct,
        slippagePct: preset.execution.slippagePct,
        initialBalance: preset.execution.initialBalance,
        allowShort: preset.execution.allowShort,
      },
    }

    const foldsSpec = buildWalkForwardFolds(candles.length, config)
    expect(foldsSpec).toHaveLength(5)
    const lastFold = foldsSpec[foldsSpec.length - 1]

    const baselineRun = runTrainingPipeline({ candles, preset, config })
    expect(baselineRun.folds).toHaveLength(5)
    expect(baselineRun.metrics.candidatesEvaluated).toBeGreaterThan(0)
    expect(baselineRun.metrics.candidatesEvaluated).toBeLessThanOrEqual(
      MAX_COORDINATE_EVALUATIONS,
    )
    expect(baselineRun.metrics.candidates?.length).toBe(
      baselineRun.metrics.candidatesEvaluated,
    )

    // Violently mutate EVERY candle in the final fold's held-out test window
    const mutated = candles.map((c, idx) => {
      if (idx < lastFold.testStart) return c
      return {
        ...c,
        open: c.open * 3.5,
        high: c.high * 6.0,
        low: Math.max(1, c.low * 0.15),
        close: c.close * (idx % 2 === 0 ? 4.2 : 0.25),
        volume: c.volume * 50,
      }
    })

    const mutatedRun = runTrainingPipeline({ candles: mutated, preset, config })

    // Fit & validation across ALL folds MUST be bit-for-bit identical
    expect(mutatedRun.metrics.candidates).toEqual(baselineRun.metrics.candidates)
    expect(mutatedRun.metrics.bestSelectedParams).toEqual(
      baselineRun.metrics.bestSelectedParams,
    )
    expect(mutatedRun.metrics.paramDiffs).toEqual(baselineRun.metrics.paramDiffs)
    for (let f = 0; f < baselineRun.folds.length; f += 1) {
      expect(mutatedRun.folds[f].selectedParams).toEqual(
        baselineRun.folds[f].selectedParams,
      )
      expect(mutatedRun.folds[f].valTrades).toBe(baselineRun.folds[f].valTrades)
      expect(mutatedRun.folds[f].valProfitFactor).toBe(
        baselineRun.folds[f].valProfitFactor,
      )
      expect(mutatedRun.folds[f].valMaxDrawdownPct).toBe(
        baselineRun.folds[f].valMaxDrawdownPct,
      )
    }
    // Earlier folds (0..3) OOS test metrics must also remain untouched
    for (let f = 0; f < baselineRun.folds.length - 1; f += 1) {
      expect(mutatedRun.folds[f].testNetPnlUsd).toBe(
        baselineRun.folds[f].testNetPnlUsd,
      )
    }
  })

  it('completes a 5-fold walk-forward run, persists to SQLite, survives restart, and writes strategy_audits + runtime_events + audit_events', async () => {
    const preset = STRATEGY_PRESETS.find((p) => p.id === 'btc-intraday-trend-15m')!
    const candles = buildFixtureCandles(650, '15m')
    const config: TrainingConfig = {
      kind: 'walk-forward',
      presetId: preset.id,
      pair: preset.strategy.pair,
      timeframe: preset.timeframe,
      fromTimeMs: candles[0].time,
      toTimeMs: candles[candles.length - 1].time,
      foldCount: 5,
      foldMode: 'rolling',
      trainRatio: 0.55,
      valRatio: 0.2,
      testRatio: 0.25,
      purgeGapBars: 5,
      assumptions: {
        commissionPct: 0.05,
        slippagePct: 0.02,
        initialBalance: 10_000,
        allowShort: true,
      },
    }

    // 1. Create running record with idempotent clientRunId
    const clientRunId = 'client-wf-run-001'
    const created1 = await invokeApi('POST', '/api/training/runs', {
      clientRunId,
      config,
      candleCount: candles.length,
      dataSource: 'binance',
    })
    expect(created1.status).toBe(201)
    expect(created1.json.deduplicated).toBe(false)
    const run = created1.json.run as TrainingRunRecord
    expect(run.status).toBe('running')

    // Retry with identical clientRunId is idempotent
    const created2 = await invokeApi('POST', '/api/training/runs', {
      clientRunId,
      config,
      candleCount: candles.length,
      dataSource: 'binance',
    })
    expect(created2.status).toBe(200)
    expect(created2.json.deduplicated).toBe(true)
    expect((created2.json.run as TrainingRunRecord).id).toBe(run.id)

    // 2. Execute offloaded training with real progress checkpoints
    const progressEvents: TrainingProgress[] = []
    const job = await runTrainingOffloaded({
      candles,
      preset,
      config,
      onProgress: (p) => progressEvents.push(p),
    })
    expect(progressEvents.length).toBeGreaterThanOrEqual(5)
    expect(progressEvents[0].phase).toBe('preparing')
    expect(progressEvents[progressEvents.length - 1].phase).toBe('finalizing')
    expect(job.output.folds).toHaveLength(5)

    // 3. Submit completion -> server verifies metrics within 1e-6 and writes strategy_audits
    const completed = await invokeApi('PATCH', `/api/training/runs/${run.id}`, {
      status: 'completed',
      candleCount: candles.length,
      metrics: job.output.metrics,
      folds: job.output.folds,
      equity: job.output.equity,
      trades: job.output.trades,
      dataSource: 'binance',
    })
    expect(completed.status).toBe(200)
    const completedRun = completed.json.run as TrainingRunRecord
    expect(completedRun.status).toBe('completed')
    expect(completedRun.completedAt).toBeTruthy()
    expect(completedRun.folds).toHaveLength(5)
    expect(completedRun.metrics?.totalTrades).toBe(job.output.trades.length)

    // 4. Simulate server restart (close & reopen SQLite DB + reset in-memory runtimes)
    resetAllTenantRuntimes()
    await resetStateStore(dbPath)

    const reloaded = await invokeApi('GET', `/api/training/runs/${run.id}`)
    expect(reloaded.status).toBe(200)
    const reloadedRun = reloaded.json.run as TrainingRunRecord
    expect(reloadedRun.id).toBe(run.id)
    expect(reloadedRun.status).toBe('completed')
    expect(reloadedRun.metrics?.netPnl).toBe(job.output.metrics.netPnl)
    expect(reloadedRun.folds).toHaveLength(5)

    // 5. Verify strategy_audits, runtime_events, and audit_events were all written
    const latestAudits = await invokeApi('GET', '/api/bot/accuracy/latest?limit=10')
    expect(latestAudits.status).toBe(200)
    const audits = latestAudits.json.audits as { runId: string; presetId: string }[]
    expect(audits.some((a) => a.runId === run.id && a.presetId === preset.id)).toBe(true)

    const eventsRes = await invokeApi('GET', `/api/events?q=${encodeURIComponent(run.id)}`)
    expect(eventsRes.status).toBe(200)
    const events = eventsRes.json.events as { correlationId: string; type: string }[]
    expect(events.some((e) => e.correlationId === run.id && e.type === 'OPERATOR')).toBe(true)
    expect(events.some((e) => e.correlationId === run.id && e.type === 'INFO')).toBe(true)

    const auditLogRes = await invokeApi('GET', '/api/audit?limit=20')
    expect(auditLogRes.status).toBe(200)
    const auditItems = auditLogRes.json.events as { action: string }[]
    expect(auditItems.some((a) => a.action === 'training:create')).toBe(true)
    expect(auditItems.some((a) => a.action === 'training:complete')).toBe(true)
  })

  it('rejects tampered metrics with HTTP 422 and logs an ERROR runtime event', async () => {
    const preset = STRATEGY_PRESETS.find((p) => p.id === 'btc-intraday-trend-15m')!
    const candles = buildFixtureCandles(500, '15m')
    const config: TrainingConfig = {
      kind: 'walk-forward',
      presetId: preset.id,
      pair: preset.strategy.pair,
      timeframe: preset.timeframe,
      fromTimeMs: candles[0].time,
      toTimeMs: candles[candles.length - 1].time,
      foldCount: 3,
      foldMode: 'anchored',
      trainRatio: 0.55,
      valRatio: 0.2,
      testRatio: 0.25,
      purgeGapBars: 5,
      assumptions: {
        commissionPct: 0.05,
        slippagePct: 0.02,
        initialBalance: 10_000,
        allowShort: true,
      },
    }

    const created = await invokeApi('POST', '/api/training/runs', {
      clientRunId: 'client-tamper-001',
      config,
      candleCount: candles.length,
      dataSource: 'binance',
    })
    const run = created.json.run as TrainingRunRecord
    const output = runTrainingPipeline({ candles, preset, config })

    // Tamper netPnl and totalTrades
    const tampered = await invokeApi('PATCH', `/api/training/runs/${run.id}`, {
      status: 'completed',
      metrics: {
        ...output.metrics,
        netPnl: output.metrics.netPnl + 500,
      },
      folds: output.folds,
      equity: output.equity,
      trades: output.trades,
    })
    expect(tampered.status).toBe(422)
    expect(Array.isArray(tampered.json.mismatches)).toBe(true)
    expect((tampered.json.mismatches as string[]).some((m) => m.includes('netPnl'))).toBe(true)

    // Verify ERROR event recorded with correlationId = run.id
    const eventsRes = await invokeApi('GET', `/api/events?types=ERROR&q=${encodeURIComponent(run.id)}`)
    expect((eventsRes.json.events as unknown[]).length).toBeGreaterThanOrEqual(1)

    // Also reject override verdict when overrideReason < 10 chars
    const shortOverride = await invokeApi('PATCH', `/api/training/runs/${run.id}`, {
      status: 'completed',
      metrics: {
        ...output.metrics,
        verdict: 'override',
        overrideReason: 'too short',
      },
      folds: output.folds,
      equity: output.equity,
      trades: output.trades,
    })
    expect(shortOverride.status).toBe(422)
  })

  it('executes meta-filter and prediction-market run kinds and passes server verification', async () => {
    // 1. Meta-filter on a spot preset (Donchian breakout yields abundant deterministic breakout signals)
    const spotPreset = STRATEGY_PRESETS.find(
      (p) => p.id === 'btc-donchian-breakout-1h',
    )!
    const spotCandles = buildFixtureCandles(1_200, '1h')
    const metaConfig: TrainingConfig = {
      kind: 'meta-filter',
      presetId: spotPreset.id,
      pair: spotPreset.strategy.pair,
      timeframe: spotPreset.timeframe,
      fromTimeMs: spotCandles[0].time,
      toTimeMs: spotCandles[spotCandles.length - 1].time,
      foldCount: 5,
      foldMode: 'anchored',
      trainRatio: 0.55,
      valRatio: 0.2,
      testRatio: 0.25,
      purgeGapBars: 5,
      assumptions: {
        commissionPct: 0.05,
        slippagePct: 0.02,
        initialBalance: 10_000,
        allowShort: true,
      },
    }
    const metaOut = runTrainingPipeline({
      candles: spotCandles,
      preset: spotPreset,
      config: metaConfig,
    })
    expect(metaOut.metrics.metaComparison).toBeTruthy()
    expect(metaOut.metrics.metaComparison!.totalSamples).toBeGreaterThanOrEqual(15)
    expect(metaOut.metrics.metaComparison!.featureImportanceRanking.length).toBe(19)

    const metaCreate = await invokeApi('POST', '/api/training/runs', {
      clientRunId: 'client-meta-001',
      config: metaConfig,
      candleCount: spotCandles.length,
      dataSource: 'binance',
    })
    expect(metaCreate.status).toBe(201)
    const metaRunId = (metaCreate.json.run as TrainingRunRecord).id
    const metaPatch = await invokeApi('PATCH', `/api/training/runs/${metaRunId}`, {
      status: 'completed',
      metrics: metaOut.metrics,
      folds: metaOut.folds,
      equity: metaOut.equity,
      trades: metaOut.trades,
    })
    expect(metaPatch.status).toBe(200)

    // 2. Prediction-market on a prediction preset
    const predPreset = STRATEGY_PRESETS.find(
      (p) => p.id === 'pred-btc-sma20-bear-cap-15m',
    )!
    const predCandles = buildFixtureCandles(600, '15m')
    const predConfig: TrainingConfig = {
      kind: 'prediction-market',
      presetId: predPreset.id,
      pair: predPreset.strategy.pair,
      timeframe: predPreset.timeframe,
      fromTimeMs: predCandles[0].time,
      toTimeMs: predCandles[predCandles.length - 1].time,
      foldCount: 5,
      foldMode: 'anchored',
      trainRatio: 0.55,
      valRatio: 0.2,
      testRatio: 0.25,
      purgeGapBars: 5,
      assumptions: {
        commissionPct: 1,
        slippagePct: 0.02,
        initialBalance: 1_000,
        allowShort: false,
      },
    }
    const predOut = runTrainingPipeline({
      candles: predCandles,
      preset: predPreset,
      config: predConfig,
    })
    expect(predOut.metrics.predictionSummary).toBeTruthy()
    expect(predOut.metrics.predictionSummary!.calibration.length).toBeGreaterThan(0)

    const predCreate = await invokeApi('POST', '/api/training/runs', {
      clientRunId: 'client-pred-001',
      config: predConfig,
      candleCount: predCandles.length,
      dataSource: 'binance',
    })
    expect(predCreate.status).toBe(201)
    const predRunId = (predCreate.json.run as TrainingRunRecord).id
    const predPatch = await invokeApi('PATCH', `/api/training/runs/${predRunId}`, {
      status: 'completed',
      metrics: predOut.metrics,
      folds: predOut.folds,
      equity: predOut.equity,
      trades: predOut.trades,
    })
    expect(predPatch.status).toBe(200)
  })

  it('supports idempotent cancel, AbortSignal worker cancellation, and interrupted reconciliation on reload', async () => {
    const preset = STRATEGY_PRESETS[0]
    const candles = buildFixtureCandles(400, '5m')
    const config: TrainingConfig = {
      kind: 'walk-forward',
      presetId: preset.id,
      pair: preset.strategy.pair,
      timeframe: preset.timeframe,
      fromTimeMs: candles[0].time,
      toTimeMs: candles[candles.length - 1].time,
      foldCount: 3,
      foldMode: 'anchored',
      trainRatio: 0.55,
      valRatio: 0.2,
      testRatio: 0.25,
      purgeGapBars: 5,
      assumptions: {
        commissionPct: 0.05,
        slippagePct: 0.02,
        initialBalance: 10_000,
        allowShort: true,
      },
    }

    // AbortSignal cancellation in trainingClient
    const ac = new AbortController()
    ac.abort()
    await expect(
      runTrainingOffloaded({ candles, preset, config, signal: ac.signal }),
    ).rejects.toBeInstanceOf(TrainingCancelledError)

    // Cancel API endpoint is idempotent
    const created1 = await invokeApi('POST', '/api/training/runs', {
      clientRunId: 'client-cancel-001',
      config,
      candleCount: candles.length,
      dataSource: 'binance',
    })
    const run1Id = (created1.json.run as TrainingRunRecord).id

    const cancel1 = await invokeApi('POST', `/api/training/runs/${run1Id}/cancel`)
    expect(cancel1.status).toBe(200)
    expect(cancel1.json.alreadyCancelled).toBe(false)
    expect((cancel1.json.run as TrainingRunRecord).status).toBe('cancelled')

    const cancel2 = await invokeApi('POST', `/api/training/runs/${run1Id}/cancel`)
    expect(cancel2.status).toBe(200)
    expect(cancel2.json.alreadyCancelled).toBe(true)

    // Interrupted reconciliation on next load after tab close
    const created2 = await invokeApi('POST', '/api/training/runs', {
      clientRunId: 'client-orphan-002',
      config,
      candleCount: candles.length,
      dataSource: 'binance',
    })
    const run2Id = (created2.json.run as TrainingRunRecord).id

    const listReconciled = await invokeApi(
      'GET',
      '/api/training/runs?reconcileInterrupted=true',
    )
    expect(listReconciled.status).toBe(200)
    expect(listReconciled.json.interruptedCount).toBe(1)
    const runs = listReconciled.json.runs as TrainingRunRecord[]
    const orphan = runs.find((r) => r.id === run2Id)
    expect(orphan?.status).toBe('interrupted')
  })

  it('validates /api/training/runs inputs strictly and serves /api/market/history archive-first with partial failure reporting', async () => {
    const allCandles = buildFixtureCandles(1_400, '15m')
    let upstreamCalls = 0
    let failSecondPage = false

    const mockSource: MarketDataSource = {
      name: 'mock-binance',
      description: 'Mock historical Binance source',
      async getCandles({ from, to, limit }) {
        upstreamCalls += 1
        if (failSecondPage && upstreamCalls >= 2) {
          throw new Error('Binance 503 rate limited')
        }
        return allCandles
          .filter(
            (c) =>
              (from === undefined || c.time >= from) &&
              (to === undefined || c.time <= to),
          )
          .slice(0, limit)
      },
    }
    setCandleMarketSource(mockSource)

    const from = allCandles[0].time
    const to = allCandles[allCandles.length - 1].time

    // 1. First fetch pages across 2 chunks (<= 1,000 each) and caches in candles_archive
    const firstRes = await invokeApi(
      'GET',
      `/api/market/history?pair=BTC/USDT&interval=15m&from=${from}&to=${to}`,
    )
    expect(firstRes.status).toBe(200)
    const h1 = firstRes.json as unknown as HistoricalCandlesResponse
    expect(h1.complete).toBe(true)
    expect(h1.missingSpans).toEqual([])
    expect(h1.candles).toHaveLength(1_400)
    expect(h1.source).toBe('binance')
    expect(upstreamCalls).toBe(2)

    // 2. Second fetch reads strictly from candles_archive (0 upstream calls)
    const secondRes = await invokeApi(
      'GET',
      `/api/market/history?pair=BTC/USDT&interval=15m&from=${from}&to=${to}`,
    )
    expect(secondRes.status).toBe(200)
    const h2 = secondRes.json as unknown as HistoricalCandlesResponse
    expect(h2.complete).toBe(true)
    expect(h2.source).toBe('candles-archive')
    expect(h2.fetchedBars).toBe(0)
    expect(h2.cachedBars).toBe(1_400)
    expect(upstreamCalls).toBe(2)

    // 3. Reject > 5,000 bars and future ranges with HTTP 400
    const tooLongFrom = to - 5_500 * intervalMs['15m']
    const tooLongRes = await invokeApi(
      'GET',
      `/api/market/history?pair=BTC/USDT&interval=15m&from=${tooLongFrom}&to=${to}`,
    )
    expect(tooLongRes.status).toBe(400)

    const futureTo = Date.now() + 86_400_000
    const futureRes = await invokeApi(
      'GET',
      `/api/market/history?pair=BTC/USDT&interval=15m&from=${from}&to=${futureTo}`,
    )
    expect(futureRes.status).toBe(400)

    // 4. Partial page failure returns complete: false + missingSpans (never synthetic fill)
    upstreamCalls = 0
    failSecondPage = true
    const partialRes = await invokeApi(
      'GET',
      `/api/market/history?pair=ETH/USDT&interval=15m&from=${from}&to=${to}`,
    )
    expect(partialRes.status).toBe(200)
    const hPartial = partialRes.json as unknown as HistoricalCandlesResponse
    expect(hPartial.complete).toBe(false)
    expect(hPartial.missingSpans.length).toBeGreaterThanOrEqual(1)
    expect(hPartial.candles.length).toBeLessThan(1_400)

    // 5. Invalid POST /api/training/runs rejected with 400
    const badPreset = await invokeApi('POST', '/api/training/runs', {
      clientRunId: 'bad-1',
      config: {
        kind: 'walk-forward',
        presetId: 'nonexistent-preset',
        pair: 'BTC/USDT',
        timeframe: '15m',
        fromTimeMs: from,
        toTimeMs: to,
        foldCount: 5,
        foldMode: 'anchored',
        trainRatio: 0.55,
        valRatio: 0.2,
        testRatio: 0.25,
        purgeGapBars: 5,
        assumptions: {
          commissionPct: 0.05,
          slippagePct: 0.02,
          initialBalance: 10_000,
          allowShort: true,
        },
      },
    })
    expect(badPreset.status).toBe(400)
  })

  it('serves /api/training/live with preset-scoped paper trades, testnet order-level records (no PnL pairing), and MT5 signal-only status', async () => {
    const preset = STRATEGY_PRESETS.find((p) => p.id === 'btc-intraday-trend-15m')!
    fundPaperAccount(10_000, 'default')

    // Persist one bot-auto order with presetId and one manual order (must stay null presetId)
    const botOrder = await submitExchangeOrder({
      tenantId: 'default',
      pair: 'BTC/USDT',
      side: 'BUY',
      notionalUsd: 50,
      referencePrice: 60_000,
      source: 'bot-auto',
      presetId: preset.id,
      clientOrderId: 'live-shadow-bot-1',
    })
    expect(botOrder.order.presetId).toBe(preset.id)

    const manualOrder = await submitExchangeOrder({
      tenantId: 'default',
      pair: 'BTC/USDT',
      side: 'BUY',
      notionalUsd: 50,
      referencePrice: 60_000,
      source: 'manual',
      presetId: preset.id, // Must be ignored for manual orders!
      clientOrderId: 'live-shadow-manual-1',
    })
    expect(manualOrder.order.presetId).toBeUndefined()

    // Seed one bot-auto binance-testnet fill + one manual binance-testnet fill in SQL
    await getStateStore().appendOrder('default', {
      id: 'ORD-TESTNET-BOT-1',
      timestamp: '2026-11-22T14:00:00.000Z',
      pair: 'BTC/USDT',
      side: 'BUY',
      notionalUsd: 120,
      price: 60_000,
      avgPrice: 60_010,
      quantity: 0.002,
      filledQty: 0.002,
      fee: 0.12,
      feeAsset: 'USDT',
      status: 'FILLED',
      mode: 'binance-testnet',
      source: 'bot-auto',
      presetId: preset.id,
    })
    await getStateStore().appendOrder('default', {
      id: 'ORD-TESTNET-MANUAL-1',
      timestamp: '2026-11-22T14:05:00.000Z',
      pair: 'BTC/USDT',
      side: 'SELL',
      notionalUsd: 120,
      price: 60_100,
      quantity: 0.002,
      status: 'FILLED',
      mode: 'binance-testnet',
      source: 'manual',
    })

    const liveRes = await invokeApi(
      'GET',
      `/api/training/live?presetId=${encodeURIComponent(preset.id)}`,
    )
    expect(liveRes.status).toBe(200)
    const live = liveRes.json as unknown as TrainingLiveShadowResponse
    expect(live.presetId).toBe(preset.id)
    expect(live.paper.count).toBe(0)
    expect(live.testnet.orderCount).toBe(1)
    expect(live.testnet.filledOrderCount).toBe(1)
    expect(live.testnet.orders[0].id).toBe('ORD-TESTNET-BOT-1')
    expect(live.testnet.totalNotionalUsd).toBe(120)
    expect(live.testnet.totalFeesUsd).toBe(0.12)
    expect(live.testnet.pnlAttributionAvailable).toBe(false)
    expect(live.testnet.note.toLowerCase()).toContain('pnl attribution not available')
    expect(live.mt5.signalOnly).toBe(true)
    expect(live.mt5.note).toBe('Signal-only · execution unconfirmed')
  })
})
