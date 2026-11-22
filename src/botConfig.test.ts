import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STRATEGY_PRESETS,
  mergePresetPatch,
  type StrategyPreset,
} from './botEngine'
import { BITCOIN_20_PREDICTIONS } from './predictions'
import { availablePairs } from './strategy'

function createMemoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
    getItem(key: string) {
      return store.get(key) ?? null
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null
    },
    removeItem(key: string) {
      store.delete(key)
    },
    setItem(key: string, value: string) {
      store.set(key, String(value))
    },
  }
}

const ORIGINAL_8_PRESET_IDS = [
  'btc-ema-scalp-5m',
  'btc-intraday-trend-15m',
  'eth-swing-breakout-1h',
  'sol-volatility-surfer-4h',
  'btc-macro-institutional-1d',
  'pred-btc-sma20-bear-cap-15m',
  'pred-btc-inside-bar-4h',
  'pred-btc-bollinger-reversion-1d',
] as const

describe('STRATEGY_PRESETS catalog integrity', () => {
  it('preserves all 8 original presets plus additive engines with valid invariants', () => {
    expect(STRATEGY_PRESETS.length).toBeGreaterThanOrEqual(
      ORIGINAL_8_PRESET_IDS.length,
    )
    const ids = new Set(STRATEGY_PRESETS.map((p) => p.id))
    expect(ids.size).toBe(STRATEGY_PRESETS.length)

    for (const originalId of ORIGINAL_8_PRESET_IDS) {
      expect(ids.has(originalId)).toBe(true)
    }

    const spot = STRATEGY_PRESETS.filter((p) => p.domain === 'crypto-spot')
    const pred = STRATEGY_PRESETS.filter(
      (p) => p.domain === 'prediction-market',
    )
    expect(spot.length + pred.length).toBe(STRATEGY_PRESETS.length)
    expect(spot.length).toBeGreaterThanOrEqual(8)
    expect(pred).toHaveLength(3)

    for (const preset of STRATEGY_PRESETS) {
      expect(availablePairs).toContain(preset.strategy.pair)
      expect(preset.signalParams.fastPeriod).toBeLessThan(
        preset.signalParams.slowPeriod,
      )
      if (
        preset.filters?.minSellRsi !== undefined &&
        preset.filters.maxBuyRsi !== undefined
      ) {
        expect(preset.filters.minSellRsi).toBeLessThan(preset.filters.maxBuyRsi)
      }
      if (preset.domain === 'prediction-market') {
        expect(
          BITCOIN_20_PREDICTIONS.some((r) => r.id === preset.predictionRuleId),
        ).toBe(true)
      }
    }
  })
})

describe('mergePresetPatch clamping & sanitization', () => {
  const base = STRATEGY_PRESETS[1]

  it('returns base unchanged for null or undefined patches', () => {
    expect(mergePresetPatch(base, null)).toEqual(base)
    expect(mergePresetPatch(base, undefined)).toEqual(base)
  })

  it('enforces fastPeriod < slowPeriod even when inverted or out of bounds', () => {
    const inverted = mergePresetPatch(base, {
      signalParams: { fastPeriod: 50, slowPeriod: 20 },
    })
    expect(inverted.signalParams.fastPeriod).toBe(50)
    expect(inverted.signalParams.slowPeriod).toBe(51)
    expect(inverted.signalParams.fastPeriod).toBeLessThan(
      inverted.signalParams.slowPeriod,
    )

    const maxedFast = mergePresetPatch(base, {
      signalParams: { fastPeriod: 300, slowPeriod: 3 },
    })
    expect(maxedFast.signalParams.fastPeriod).toBe(150)
    expect(maxedFast.signalParams.slowPeriod).toBe(151)
    expect(maxedFast.signalParams.fastPeriod).toBeLessThan(
      maxedFast.signalParams.slowPeriod,
    )
  })

  it('enforces minSellRsi < maxBuyRsi and oversoldRsi < overboughtRsi', () => {
    const rsiPatched = mergePresetPatch(base, {
      filters: {
        maxBuyRsi: 45,
        minSellRsi: 55,
        overboughtRsi: 50,
        oversoldRsi: 50,
      },
    })
    expect(rsiPatched.filters?.maxBuyRsi).toBe(45)
    expect(rsiPatched.filters?.minSellRsi).toBe(40)
    expect(rsiPatched.filters?.minSellRsi).toBeLessThan(
      rsiPatched.filters?.maxBuyRsi ?? 0,
    )

    expect(rsiPatched.filters?.overboughtRsi).toBe(50)
    expect(rsiPatched.filters?.oversoldRsi).toBe(45)
    expect(rsiPatched.filters?.oversoldRsi).toBeLessThan(
      rsiPatched.filters?.overboughtRsi ?? 0,
    )
  })

  it('ignores invalid pair, domain, timeframe, signalEngine, average, and predictionRuleId', () => {
    const patched = mergePresetPatch(base, {
      domain: 'forex' as StrategyPreset['domain'],
      timeframe: '2m' as StrategyPreset['timeframe'],
      strategy: { pair: 'INVALID/USDT' },
      signalParams: {
        average: 'wma' as StrategyPreset['signalParams']['average'],
      },
      filters: {
        signalEngine: 'magic-ai' as NonNullable<
          StrategyPreset['filters']
        >['signalEngine'],
      },
      predictionRuleId: 'non-existent-rule',
    })

    expect(patched.domain).toBe(base.domain)
    expect(patched.timeframe).toBe(base.timeframe)
    expect(patched.strategy.pair).toBe(base.strategy.pair)
    expect(patched.signalParams.average).toBe(base.signalParams.average)
    expect(patched.filters?.signalEngine).toBe(base.filters?.signalEngine)
    expect(patched.predictionRuleId).toBe(base.predictionRuleId)
  })

  it('clamps strategy, execution, and prediction numeric ranges safely', () => {
    const clamped = mergePresetPatch(STRATEGY_PRESETS[5], {
      name: '   ',
      description: `Note ${'Z'.repeat(350)}`,
      strategy: {
        pair: 'ETH/USDT',
        positionSize: 500,
        stopLoss: -5,
        takeProfit: Number.NaN,
        maxDailyRisk: 0,
      },
      execution: {
        initialBalance: 10,
        commissionPct: 15,
        slippagePct: -1,
        allowShort: true,
      },
      predictionRuleId: 'm15-oversold-relief',
      minEdgePct: 120,
      minTriggers: 0,
      useQuarterKelly: false,
    })

    expect(clamped.name).toBe(STRATEGY_PRESETS[5].name)
    expect(clamped.description.length).toBe(280)
    expect(clamped.strategy.pair).toBe('ETH/USDT')
    expect(clamped.strategy.positionSize).toBe(100)
    expect(clamped.strategy.stopLoss).toBe(0.1)
    expect(clamped.strategy.takeProfit).toBe(STRATEGY_PRESETS[5].strategy.takeProfit)
    expect(clamped.strategy.maxDailyRisk).toBe(0.1)
    expect(clamped.execution.initialBalance).toBe(100)
    expect(clamped.execution.commissionPct).toBe(5)
    expect(clamped.execution.slippagePct).toBe(0)
    expect(clamped.execution.allowShort).toBe(true)
    expect(clamped.predictionRuleId).toBe('m15-oversold-relief')
    expect(clamped.minEdgePct).toBe(50)
    expect(clamped.minTriggers).toBe(1)
    expect(clamped.useQuarterKelly).toBe(false)
  })
})

describe('selectBotPresetOnServer round-trip persistence', () => {
  let storage: Storage

  beforeEach(() => {
    storage = createMemoryStorage()
    vi.stubGlobal('window', { localStorage: storage })
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('persists customPreset round-trip over HTTP backend and reads back via getBotStatus', async () => {
    let serverPreset = STRATEGY_PRESETS[1]

    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'

        if (url.endsWith('/bot/preset') && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            presetId?: string
            timeframe?: StrategyPreset['timeframe']
            customPreset?: Parameters<typeof mergePresetPatch>[1]
          }
          const base =
            STRATEGY_PRESETS.find((p) => p.id === body.presetId) ?? serverPreset
          serverPreset = mergePresetPatch(base, {
            ...body.customPreset,
            timeframe: body.timeframe ?? base.timeframe,
          })

          return new Response(
            JSON.stringify({
              running: false,
              preset: serverPreset,
              presets: STRATEGY_PRESETS,
              state: {
                mode: 'paper',
                domain: serverPreset.domain,
                pair: serverPreset.strategy.pair,
                timeframe: serverPreset.timeframe,
                balance: serverPreset.execution.initialBalance,
                initialBalance: serverPreset.execution.initialBalance,
                dayStartBalance: serverPreset.execution.initialBalance,
                currentDayKey: null,
                dayHalted: false,
                lastProcessedCandleTime: null,
                openPosition: null,
                closedTrades: [],
                activeTickets: [],
                resolvedTickets: [],
                nextTicketId: 1,
                nextTradeId: 1,
                logs: [],
              },
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          )
        }

        if (url.endsWith('/bot/status') && method === 'GET') {
          return new Response(
            JSON.stringify({
              running: false,
              preset: serverPreset,
              presets: STRATEGY_PRESETS,
              state: {
                mode: 'paper',
                domain: serverPreset.domain,
                pair: serverPreset.strategy.pair,
                timeframe: serverPreset.timeframe,
                balance: serverPreset.execution.initialBalance,
                initialBalance: serverPreset.execution.initialBalance,
                dayStartBalance: serverPreset.execution.initialBalance,
                currentDayKey: null,
                dayHalted: false,
                lastProcessedCandleTime: null,
                openPosition: null,
                closedTrades: [],
                activeTickets: [],
                resolvedTickets: [],
                nextTicketId: 1,
                nextTradeId: 1,
                logs: [],
              },
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          )
        }

        return new Response('Not Found', { status: 404 })
      },
    )

    vi.stubGlobal('fetch', fetchMock)

    const { getBotStatus, selectBotPresetOnServer } = await import(
      './api/botClient'
    )

    const saved = await selectBotPresetOnServer({
      presetId: 'btc-intraday-trend-15m',
      timeframe: '1h',
      customPreset: {
        strategy: { pair: 'ETH/USDT', stopLoss: 1.25 },
        signalParams: { fastPeriod: 40, slowPeriod: 10 },
        filters: {
          signalEngine: 'rsi-reversion',
          maxBuyRsi: 45,
          minSellRsi: 55,
        },
      },
    })

    expect(saved.connectionMode).toBe('http-server')
    expect(saved.preset.strategy.pair).toBe('ETH/USDT')
    expect(saved.preset.timeframe).toBe('1h')
    expect(saved.preset.strategy.stopLoss).toBe(1.25)
    expect(saved.preset.signalParams.fastPeriod).toBe(40)
    expect(saved.preset.signalParams.slowPeriod).toBe(41)
    expect(saved.preset.filters?.minSellRsi).toBe(40)

    const roundTrip = await getBotStatus()
    expect(roundTrip).not.toBeNull()
    expect(roundTrip?.connectionMode).toBe('http-server')
    expect(roundTrip?.preset).toEqual(saved.preset)
    expect(storage.getItem('lixtrd:shadow-bot-state')).toBeNull()
  })

  it('returns null status and rejects mutations without local fallback when backend is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Network offline')
      }),
    )

    const client1 = await import('./api/botClient')
    await expect(
      client1.selectBotPresetOnServer({
        presetId: 'eth-swing-breakout-1h',
        timeframe: '4h',
        customPreset: {
          strategy: { pair: 'SOL/USDT', takeProfit: 6.5 },
          signalParams: { fastPeriod: 25, slowPeriod: 12 },
        },
      }),
    ).rejects.toThrow()

    const status = await client1.getBotStatus()
    expect(status).toBeNull()
    expect(storage.getItem('lixtrd:shadow-bot-state')).toBeNull()
  })
})
