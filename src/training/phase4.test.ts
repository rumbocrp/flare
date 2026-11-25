import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STRATEGY_PRESETS } from '../botEngine'
import {
  handleBotApiRequest,
  resetAllTenantRuntimes,
  stopBackgroundWorker,
} from '../server/botRuntime'
import { clearAllTenantExchangeStates } from '../server/exchangeAdapter'
import { resetStateStore } from '../server/store'
import type { PageId } from '../types'
import {
  applyDocumentMetadata,
  getRouteMetadata,
  resolvePageFromPathname,
} from './pageMeta'
import {
  applyPresetPatchWithClamps,
  bestParamsToPresetPatch,
  buildPromotionPlan,
  computePresetCatalogDiff,
  evaluateShadowDrift,
  findCatalogBasePreset,
  MIN_DRIFT_SAMPLE_SIZE,
} from './shadowAndCustomize'
import { buildTrainingCatalog } from './strategyRegistry'
import type { TrainingLiveShadowResponse } from './types'

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
  req.headers = {
    host: 'localhost:3001',
    'content-type': 'application/json',
  }

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

describe('Phase 4 — Shadow Drift Sample-Size Gate', () => {
  it('refuses to output a numeric drift when either OOS or Shadow has fewer than 30 trades', () => {
    const cases = [
      { oos: 0, shadow: 0 },
      { oos: 29, shadow: 40 },
      { oos: 50, shadow: 29 },
      { oos: 15, shadow: 10 },
    ]
    for (const c of cases) {
      const res = evaluateShadowDrift({
        oosTrades: c.oos,
        oosWins: Math.floor(c.oos * 0.55),
        oosWinRatePct: c.oos > 0 ? 55 : null,
        shadowTrades: c.shadow,
        shadowWins: Math.floor(c.shadow * 0.5),
        shadowWinRatePct: c.shadow > 0 ? 50 : null,
      })
      expect(res.sufficient).toBe(false)
      expect(res.status).toBe('insufficient-sample')
      expect(res.driftPp).toBeNull()
      expect(res.withinWilsonInterval).toBeNull()
      expect(res.minSampleRequired).toBe(MIN_DRIFT_SAMPLE_SIZE)
    }
  })

  it('computes signed drift and Wilson 95% interval membership when both samples >= 30', () => {
    const aligned = evaluateShadowDrift({
      oosTrades: 60,
      oosWins: 33,
      oosWinRatePct: 55.0,
      shadowTrades: 35,
      shadowWins: 18,
      shadowWinRatePct: 51.4,
    })
    expect(aligned.sufficient).toBe(true)
    expect(aligned.status).toBe('aligned')
    expect(aligned.driftPp).toBeCloseTo(-3.6, 1)
    expect(aligned.withinWilsonInterval).toBe(true)
    expect(aligned.oosWilsonInterval).not.toBeNull()
    expect(aligned.oosWilsonInterval!.lowerPct).toBeLessThan(55)
    expect(aligned.oosWilsonInterval!.upperPct).toBeGreaterThan(55)

    const divergent = evaluateShadowDrift({
      oosTrades: 100,
      oosWins: 60,
      oosWinRatePct: 60.0,
      shadowTrades: 40,
      shadowWins: 14,
      shadowWinRatePct: 35.0,
    })
    expect(divergent.sufficient).toBe(true)
    expect(divergent.status).toBe('divergent')
    expect(divergent.driftPp).toBeCloseTo(-25.0, 1)
    expect(divergent.withinWilsonInterval).toBe(false)
  })
})

describe('Phase 4 — Customize Clamping, Diff & Promotion Plan', () => {
  it('reuses mergePresetPatch and reports exact clamped-from-X-to-Y notices', () => {
    const donchianPreset = STRATEGY_PRESETS.find(
      (p) => p.id === 'btc-donchian-breakout-1h',
    )!
    const { preset, clamps } = applyPresetPatchWithClamps(donchianPreset, {
      strategy: { stopLoss: 99, positionSize: 0.01 },
      signalParams: { fastPeriod: 40, slowPeriod: 20 },
      filters: { channelPeriod: 2, atrStopMult: 25 },
    })

    expect(preset.strategy.stopLoss).toBe(50)
    expect(preset.strategy.positionSize).toBe(0.1)
    expect(preset.signalParams.slowPeriod).toBeGreaterThan(
      preset.signalParams.fastPeriod,
    )
    expect(preset.filters?.channelPeriod).toBe(5)
    expect(preset.filters?.atrStopMult).toBe(6)

    const fields = new Map(clamps.map((c) => [c.field, c]))
    expect(fields.get('strategy.stopLoss')).toEqual({
      field: 'strategy.stopLoss',
      requested: 99,
      clamped: 50,
    })
    expect(fields.get('strategy.positionSize')).toEqual({
      field: 'strategy.positionSize',
      requested: 0.01,
      clamped: 0.1,
    })
    expect(fields.get('filters.channelPeriod')).toEqual({
      field: 'filters.channelPeriod',
      requested: 2,
      clamped: 5,
    })
    expect(fields.get('filters.atrStopMult')).toEqual({
      field: 'filters.atrStopMult',
      requested: 25,
      clamped: 6,
    })
  })

  it('computes accurate grouped diffs and respects research-variant promotion block', () => {
    const catalog = buildTrainingCatalog([])
    const catalogItem = catalog.find(
      (c) => c.id === 'btc-donchian-breakout-1h',
    )!
    const templateItem = catalog.find(
      (c) => c.id === 'template-crossover-ema',
    )!
    const base = findCatalogBasePreset(catalogItem)

    expect(computePresetCatalogDiff(base, base)).toHaveLength(0)

    const catalogPlan = buildPromotionPlan(catalogItem, base, false)
    expect(catalogPlan).toEqual({
      allowed: true,
      mode: 'catalog',
      payload: { presetId: 'btc-donchian-breakout-1h' },
      diffCount: 0,
    })

    // Research variant must block promotion
    const blockedPlan = buildPromotionPlan(catalogItem, base, true)
    expect(blockedPlan).toEqual({
      allowed: false,
      reason: 'research-variant',
    })

    // Modified catalog preset sends presetId + customPreset
    const { preset: modified } = applyPresetPatchWithClamps(base, {
      strategy: { stopLoss: 3.1 },
      filters: { channelPeriod: 28 },
    })
    const diffs = computePresetCatalogDiff(base, modified)
    expect(diffs.map((d) => d.field)).toEqual([
      'filters.channelPeriod',
      'strategy.stopLoss',
    ])
    const modPlan = buildPromotionPlan(catalogItem, modified, false)
    expect(modPlan.allowed).toBe(true)
    if (modPlan.allowed) {
      expect(modPlan.mode).toBe('custom')
      expect(modPlan.payload.presetId).toBe('btc-donchian-breakout-1h')
      expect(modPlan.payload.customPreset?.strategy?.stopLoss).toBe(3.1)
    }

    // Engine template / custom profile sends { customPreset } without catalog presetId
    const tplPlan = buildPromotionPlan(templateItem, templateItem.preset, false)
    expect(tplPlan.allowed).toBe(true)
    if (tplPlan.allowed) {
      expect(tplPlan.mode).toBe('custom')
      expect(tplPlan.payload.presetId).toBeUndefined()
      expect(tplPlan.payload.customPreset?.filters?.signalEngine).toBe(
        'crossover',
      )
    }
  })

  it('maps winning walk-forward parameters cleanly to a preset patch', () => {
    const base = STRATEGY_PRESETS.find((p) => p.id === 'btc-ema-scalp-5m')!
    const patch = bestParamsToPresetPatch(base, {
      stopLossMult: 1.2,
      takeProfitMult: 1.5,
      maxBuyRsi: 68,
    })
    expect(patch.strategy?.stopLoss).toBeCloseTo(base.strategy.stopLoss * 1.2, 2)
    expect(patch.strategy?.takeProfit).toBeCloseTo(
      base.strategy.takeProfit * 1.5,
      2,
    )
    expect(patch.filters?.maxBuyRsi).toBe(68)
  })
})

describe('Phase 4 — Server Promotion Audit & Shadow Live Endpoint', () => {
  let tmpDir: string
  let prevDbPath: string | undefined

  beforeEach(() => {
    prevDbPath = process.env.FLARE_SQLITE_PATH
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-phase4-test-'))
    process.env.FLARE_SQLITE_PATH = path.join(tmpDir, 'phase4.db')
    stopBackgroundWorker()
    resetAllTenantRuntimes()
    clearAllTenantExchangeStates()
    resetStateStore()
  })

  afterEach(() => {
    stopBackgroundWorker()
    resetAllTenantRuntimes()
    clearAllTenantExchangeStates()
    resetStateStore()
    if (prevDbPath === undefined) {
      delete process.env.FLARE_SQLITE_PATH
    } else {
      process.env.FLARE_SQLITE_PATH = prevDbPath
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('promotes catalog and custom presets via POST /api/bot/preset and audits runtime events', async () => {

    const promoteCatalog = await invokeApi('POST', '/api/bot/preset', {
      presetId: 'btc-donchian-breakout-1h',
    })
    expect(promoteCatalog.status).toBe(200)
    const snap1 = promoteCatalog.json as { preset: { id: string; timeframe: string } }
    expect(snap1.preset.id).toBe('btc-donchian-breakout-1h')
    expect(snap1.preset.timeframe).toBe('1h')

    const promoteCustom = await invokeApi('POST', '/api/bot/preset', {
      customPreset: {
        name: 'Custom Audited Donchian',
        timeframe: '4h',
        strategy: { pair: 'ETH/USDT', positionSize: 12, stopLoss: 2.2, takeProfit: 4.4, maxDailyRisk: 3.5 },
        filters: { signalEngine: 'donchian-breakout', channelPeriod: 24, exitPeriod: 12 },
      },
    })
    expect(promoteCustom.status).toBe(200)
    const snap2 = promoteCustom.json as {
      preset: { name: string; timeframe: string; strategy: { pair: string } }
    }
    expect(snap2.preset.name).toBe('Custom Audited Donchian')
    expect(snap2.preset.timeframe).toBe('4h')
    expect(snap2.preset.strategy.pair).toBe('ETH/USDT')

    // Verify runtime events recorded the operator promotion
    const eventsRes = await invokeApi('GET', '/api/events?limit=10')
    expect(eventsRes.status).toBe(200)
    const events = (eventsRes.json as { events: { type: string; message: string }[] }).events
    expect(
      events.some(
        (e) =>
          e.type === 'OPERATOR' && e.message.includes('Custom Audited Donchian'),
      ),
    ).toBe(true)

    // Verify GET /api/training/live returns truth-labeled testnet + MT5 sections
    const liveRes = await invokeApi(
      'GET',
      '/api/training/live?presetId=btc-donchian-breakout-1h',
    )
    expect(liveRes.status).toBe(200)
    const live = liveRes.json as TrainingLiveShadowResponse
    expect(live.presetId).toBe('btc-donchian-breakout-1h')
    expect(live.testnet.pnlAttributionAvailable).toBe(false)
    expect(live.testnet.note.toLowerCase()).toContain('pnl attribution not available')
    expect(live.mt5.signalOnly).toBe(true)
    expect(live.mt5.note).toContain('Signal-only')
  })
})

describe('Phase 4 — Quality Gate 100: Index Policy & Route Metadata', () => {
  const ALL_PAGES: readonly PageId[] = [
    'dashboard',
    'terminal',
    'bot-config',
    'training',
    'bot-run',
    'backtest',
    'predictions',
    'stats',
    'settings',
  ]

  it('enforces noindex, nofollow and unique title/description across all routes in EN and ES', () => {
    for (const lang of ['en', 'es'] as const) {
      const titles = new Set<string>()
      const descs = new Set<string>()
      for (const page of ALL_PAGES) {
        const meta = getRouteMetadata(page, lang)
        expect(meta.robots).toBe('noindex, nofollow')
        expect(meta.title.length).toBeGreaterThan(5)
        expect(meta.description.length).toBeGreaterThan(20)
        expect(meta.path.startsWith('/')).toBe(true)
        // Must never leak secrets or API keys in meta tags
        expect(meta.description.toLowerCase()).not.toMatch(/secret|api_key|token=/)
        titles.add(meta.title)
        descs.add(meta.description)
      }
      expect(titles.size).toBe(ALL_PAGES.length)
      expect(descs.size).toBe(ALL_PAGES.length)
    }

    expect(resolvePageFromPathname('/training')).toBe('training')
    expect(resolvePageFromPathname('/training/')).toBe('training')
    expect(resolvePageFromPathname('/')).toBe('dashboard')
    expect(resolvePageFromPathname('/unknown-route')).toBe('dashboard')
  })

  it('applies title, description, robots, lang, and canonical cleanly to a DOM document', () => {
    const attrs = new Map<string, Map<string, string>>()
    const fakeHead = {
      querySelector(selector: string) {
        if (!attrs.has(selector)) return null
        const map = attrs.get(selector)!
        return {
          setAttribute: (k: string, v: string) => map.set(k, v),
          getAttribute: (k: string) => map.get(k) ?? null,
        }
      },
      appendChild() {},
    }
    const fakeDoc = {
      title: '',
      documentElement: { lang: '' },
      head: fakeHead,
      createElement(tag: string) {
        const map = new Map<string, string>()
        return {
          setAttribute(k: string, v: string) {
            map.set(k, v)
            if (tag === 'meta' && k === 'name') {
              attrs.set(`meta[name="${v}"]`, map)
            } else if (tag === 'link' && k === 'rel') {
              attrs.set(`link[rel="${v}"]`, map)
            }
          },
          getAttribute: (k: string) => map.get(k) ?? null,
        }
      },
    } as unknown as Document

    const applied = applyDocumentMetadata(
      'training',
      'en',
      fakeDoc,
      'https://console.flare.local',
    )
    expect(applied.title).toBe('Training — FLARE')
    expect(fakeDoc.title).toBe('Training — FLARE')
    expect(fakeDoc.documentElement.lang).toBe('en')
    expect(attrs.get('meta[name="robots"]')?.get('content')).toBe(
      'noindex, nofollow',
    )
    expect(attrs.get('link[rel="canonical"]')?.get('href')).toBe(
      'https://console.flare.local/training',
    )
  })

  it('ships public/robots.txt disallowing /api and index.html with noindex, nofollow', () => {
    const root = process.cwd()
    const robots = fs.readFileSync(
      path.join(root, 'public', 'robots.txt'),
      'utf8',
    )
    expect(robots).toMatch(/Disallow:\s*\/api/i)

    const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    expect(indexHtml).toMatch(
      /<meta\s+name="robots"\s+content="noindex,\s*nofollow"\s*\/>/i,
    )
    expect(indexHtml).toMatch(/<meta\s+name="description"/i)
    expect(indexHtml).toMatch(/<html\s+lang="en">/i)
  })
})
