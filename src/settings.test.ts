import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STRATEGY_PRESETS, mergePresetPatch } from './botEngine'
import {
  CUSTOM_PROFILES_STORAGE_KEY,
  clearCustomBotProfiles,
  deleteCustomBotProfile,
  loadCustomBotProfiles,
  saveCustomBotProfiles,
  upsertCustomBotProfile,
} from './botProfiles'
import {
  defaultSettings,
  isAppSettings,
  normalizeAppSettings,
} from './settings'
import { parseConfigBundle } from './settingsBundle'
import { availablePairs } from './strategy'
import type { AppSettings } from './types'

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

describe('normalizeAppSettings', () => {
  it('returns defaultSettings clone for null, undefined, or non-object input', () => {
    expect(normalizeAppSettings()).toEqual(defaultSettings)
    expect(normalizeAppSettings(null)).toEqual(defaultSettings)
    expect(
      normalizeAppSettings('invalid' as unknown as Partial<AppSettings>),
    ).toEqual(defaultSettings)
  })

  it('preserves all valid settings values across enums, pairs, intervals, and toggles', () => {
    const valid: AppSettings = {
      theme: 'light',
      language: 'es',
      density: 'compact',
      accentPreset: 'cyan',
      defaultPair: availablePairs[2],
      defaultInterval: '4h',
      timezone: 'local',
      confirmDestructive: false,
      soundAlerts: true,
      reducedMotion: true,
      apiBaseUrl: 'https://flare.internal/api',
    }
    expect(normalizeAppSettings(valid)).toEqual(valid)
  })

  it('falls back invalid enum/pair/boolean fields to defaults while keeping valid siblings', () => {
    const normalized = normalizeAppSettings({
      theme: 'neon' as AppSettings['theme'],
      language: 'fr' as AppSettings['language'],
      density: 'dense' as AppSettings['density'],
      accentPreset: 'magenta' as AppSettings['accentPreset'],
      defaultPair: 'INVALID/PAIR',
      defaultInterval: '2h' as AppSettings['defaultInterval'],
      timezone: 'PST' as AppSettings['timezone'],
      confirmDestructive: 'yes' as unknown as boolean,
      soundAlerts: true,
      reducedMotion: 1 as unknown as boolean,
      apiBaseUrl: '  https://custom.node/api  ',
    })

    expect(normalized).toEqual({
      theme: defaultSettings.theme,
      language: defaultSettings.language,
      density: defaultSettings.density,
      accentPreset: defaultSettings.accentPreset,
      defaultPair: defaultSettings.defaultPair,
      defaultInterval: defaultSettings.defaultInterval,
      timezone: defaultSettings.timezone,
      confirmDestructive: defaultSettings.confirmDestructive,
      soundAlerts: true,
      reducedMotion: defaultSettings.reducedMotion,
      apiBaseUrl: 'https://custom.node/api',
    })
  })

  it('truncates apiBaseUrl at 256 characters and rejects non-string apiBaseUrl', () => {
    const longUrl = `https://example.com/${'a'.repeat(300)}`
    const truncated = normalizeAppSettings({ apiBaseUrl: `  ${longUrl}  ` })
    expect(truncated.apiBaseUrl.length).toBe(256)

    const nonString = normalizeAppSettings({
      apiBaseUrl: 12345 as unknown as string,
    })
    expect(nonString.apiBaseUrl).toBe('')
  })
})

describe('isAppSettings', () => {
  it('accepts defaultSettings and minimal valid theme object', () => {
    expect(isAppSettings(defaultSettings)).toBe(true)
    expect(isAppSettings({ theme: 'dark' })).toBe(true)
    expect(isAppSettings({ theme: 'system', accentPreset: 'violet' })).toBe(true)
  })

  it('rejects null, primitives, missing theme, and invalid fields', () => {
    expect(isAppSettings(null)).toBe(false)
    expect(isAppSettings(undefined)).toBe(false)
    expect(isAppSettings('dark')).toBe(false)
    expect(isAppSettings({})).toBe(false)
    expect(isAppSettings({ theme: 'midnight' })).toBe(false)
    expect(isAppSettings({ theme: 'dark', language: 'de' })).toBe(false)
    expect(isAppSettings({ theme: 'dark', density: 'tight' })).toBe(false)
    expect(isAppSettings({ theme: 'dark', accentPreset: 'red' })).toBe(false)
    expect(isAppSettings({ theme: 'dark', defaultPair: 'SHIB/USDT' })).toBe(
      false,
    )
    expect(isAppSettings({ theme: 'dark', defaultInterval: '1m' })).toBe(false)
    expect(isAppSettings({ theme: 'dark', timezone: 'EST' })).toBe(false)
    expect(
      isAppSettings({ theme: 'dark', confirmDestructive: 'true' }),
    ).toBe(false)
    expect(isAppSettings({ theme: 'dark', apiBaseUrl: 42 })).toBe(false)
  })
})

describe('botProfiles CRUD', () => {
  let storage: Storage

  beforeEach(() => {
    storage = createMemoryStorage()
    vi.stubGlobal('window', { localStorage: storage })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('handles missing window/localStorage gracefully without throwing', () => {
    vi.stubGlobal('window', undefined)
    expect(loadCustomBotProfiles()).toEqual([])
    expect(() => saveCustomBotProfiles([])).not.toThrow()
    expect(() => clearCustomBotProfiles()).not.toThrow()
  })

  it('creates, updates in-place, loads, and deletes custom profiles', () => {
    const base = STRATEGY_PRESETS[1]
    const created = upsertCustomBotProfile(base, '  BTC 15m Pullback  ')
    expect(created).toHaveLength(1)
    expect(created[0].id).toBe('custom-btc-15m-pullback')
    expect(created[0].preset.name).toBe('BTC 15m Pullback')

    const modifiedPreset = mergePresetPatch(base, {
      strategy: { stopLoss: 1.1 },
    })
    const updated = upsertCustomBotProfile(modifiedPreset, 'BTC 15m Pullback')
    expect(updated).toHaveLength(1)
    expect(updated[0].preset.strategy.stopLoss).toBe(1.1)

    const second = upsertCustomBotProfile(
      STRATEGY_PRESETS[2],
      'ETH Hourly Swing',
    )
    expect(second).toHaveLength(2)
    expect(second[0].id).toBe('custom-eth-hourly-swing')

    const afterDelete = deleteCustomBotProfile('custom-btc-15m-pullback')
    expect(afterDelete).toHaveLength(1)
    expect(afterDelete[0].id).toBe('custom-eth-hourly-swing')

    const noopDelete = deleteCustomBotProfile('non-existent-id')
    expect(noopDelete).toHaveLength(1)

    clearCustomBotProfiles()
    expect(loadCustomBotProfiles()).toEqual([])
  })

  it('caps profile names at 90 chars, slugs at 36 chars, and max stored profiles at 24', () => {
    const base = STRATEGY_PRESETS[0]
    const longName = `Long Profile ${'X'.repeat(120)}`
    const list = upsertCustomBotProfile(base, longName)
    expect(list[0].preset.name.length).toBe(90)
    expect(list[0].id.replace('custom-', '').length).toBeLessThanOrEqual(36)

    const fallbackSlug = upsertCustomBotProfile(base, '!!!')
    expect(fallbackSlug[0].id.startsWith('custom-')).toBe(true)

    clearCustomBotProfiles()
    for (let i = 1; i <= 26; i++) {
      upsertCustomBotProfile(base, `Profile ${i}`)
    }
    const loaded = loadCustomBotProfiles()
    expect(loaded).toHaveLength(24)
    expect(loaded[0].preset.name).toBe('Profile 26')
  })

  it('ignores corrupt JSON or malformed entries and sanitizes presets on load', () => {
    storage.setItem(CUSTOM_PROFILES_STORAGE_KEY, '{corrupt json')
    expect(loadCustomBotProfiles()).toEqual([])

    storage.setItem(CUSTOM_PROFILES_STORAGE_KEY, JSON.stringify({ not: 'array' }))
    expect(loadCustomBotProfiles()).toEqual([])

    storage.setItem(
      CUSTOM_PROFILES_STORAGE_KEY,
      JSON.stringify([
        null,
        { id: 123, preset: {} },
        {
          id: 'custom-sanitized',
          preset: {
            id: 'btc-intraday-trend-15m',
            signalParams: { fastPeriod: 80, slowPeriod: 10 },
            filters: { maxBuyRsi: 45, minSellRsi: 55 },
          },
        },
      ]),
    )

    const loaded = loadCustomBotProfiles()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('custom-sanitized')
    expect(loaded[0].preset.signalParams.fastPeriod).toBeLessThan(
      loaded[0].preset.signalParams.slowPeriod,
    )
    expect(loaded[0].preset.filters?.minSellRsi).toBeLessThan(
      loaded[0].preset.filters?.maxBuyRsi ?? 0,
    )
  })
})

describe('parseConfigBundle', () => {
  let storage: Storage

  beforeEach(() => {
    storage = createMemoryStorage()
    vi.stubGlobal('window', { localStorage: storage })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects malformed JSON, non-object roots, arrays, and empty bundles', () => {
    expect(parseConfigBundle('{not valid json').ok).toBe(false)
    expect(parseConfigBundle('null').ok).toBe(false)
    expect(parseConfigBundle('"hello"').ok).toBe(false)
    expect(parseConfigBundle('123').ok).toBe(false)
    expect(parseConfigBundle('[]').ok).toBe(false)
    expect(parseConfigBundle('{}').ok).toBe(false)
    expect(parseConfigBundle(JSON.stringify({ version: 1 })).ok).toBe(false)
  })

  it('rejects non-plain-object settings and invalid AppSettings fields', () => {
    const invalidPayloads = [
      { settings: [] },
      { settings: 'invalid' },
      { settings: null },
      { settings: {} },
      { settings: { unknownKey: true } },
      { settings: { theme: 'bogus' } },
      { settings: { language: 'fr' } },
      { settings: { density: 'ultra' } },
      { settings: { accentPreset: 'crimson' } },
      { settings: { defaultPair: 'BAD/PAIR' } },
      { settings: { defaultInterval: '1m' } },
      { settings: { timezone: 'PST' } },
      { settings: { confirmDestructive: 'yes' } },
      { settings: { soundAlerts: 1 } },
      { settings: { reducedMotion: null } },
      { settings: { apiBaseUrl: 12345 } },
    ]

    for (const payload of invalidPayloads) {
      const res = parseConfigBundle(JSON.stringify(payload))
      expect(res.ok).toBe(false)
    }
  })

  it('rejects negative, zero, out-of-bounds, or unknown-pair strategy payloads', () => {
    const invalidStrategies = [
      [],
      null,
      'invalid',
      {
        pair: 'BAD/PAIR',
        positionSize: 5,
        stopLoss: 2,
        takeProfit: 4,
        maxDailyRisk: 3,
      },
      {
        pair: 'BTC/USDT',
        positionSize: -10,
        stopLoss: 2,
        takeProfit: 4,
        maxDailyRisk: 3,
      },
      {
        pair: 'BTC/USDT',
        positionSize: 0.05,
        stopLoss: 2,
        takeProfit: 4,
        maxDailyRisk: 3,
      },
      {
        pair: 'BTC/USDT',
        positionSize: 101,
        stopLoss: 2,
        takeProfit: 4,
        maxDailyRisk: 3,
      },
      {
        pair: 'BTC/USDT',
        positionSize: 5,
        stopLoss: -5,
        takeProfit: 4,
        maxDailyRisk: 3,
      },
      {
        pair: 'BTC/USDT',
        positionSize: 5,
        stopLoss: 0,
        takeProfit: 4,
        maxDailyRisk: 3,
      },
      {
        pair: 'BTC/USDT',
        positionSize: 5,
        stopLoss: 51,
        takeProfit: 4,
        maxDailyRisk: 3,
      },
      {
        pair: 'BTC/USDT',
        positionSize: 5,
        stopLoss: 2,
        takeProfit: 0,
        maxDailyRisk: 3,
      },
      {
        pair: 'BTC/USDT',
        positionSize: 5,
        stopLoss: 2,
        takeProfit: 101,
        maxDailyRisk: 3,
      },
      {
        pair: 'BTC/USDT',
        positionSize: 5,
        stopLoss: 2,
        takeProfit: 4,
        maxDailyRisk: -1,
      },
      {
        pair: 'BTC/USDT',
        positionSize: 5,
        stopLoss: 2,
        takeProfit: 4,
        maxDailyRisk: 101,
      },
    ]

    for (const strategy of invalidStrategies) {
      const res = parseConfigBundle(JSON.stringify({ strategy }))
      expect(res.ok).toBe(false)
    }
  })

  it('rejects malformed customProfiles atomically without wiping existing valid localStorage profiles', () => {
    const existing = upsertCustomBotProfile(
      STRATEGY_PRESETS[1],
      'Existing Safe Profile',
    )
    expect(existing).toHaveLength(1)

    const malformedBundles = [
      { customProfiles: 'not-an-array' },
      { customProfiles: [null, { bad: true }, 'junk'] },
      { customProfiles: [{ id: '   ', preset: { id: 'btc-intraday-trend-15m' } }] },
      {
        customProfiles: [
          { id: 'x'.repeat(91), preset: { id: 'btc-intraday-trend-15m' } },
        ],
      },
      { customProfiles: [{ id: 'custom-arr', preset: [] }] },
      {
        settings: { theme: 'light' },
        strategy: {
          pair: 'BTC/USDT',
          positionSize: 5,
          stopLoss: 2,
          takeProfit: 4,
          maxDailyRisk: 3,
        },
        customProfiles: [
          { id: 'custom-good', preset: { id: 'btc-intraday-trend-15m' } },
          null,
        ],
      },
    ]

    for (const bundle of malformedBundles) {
      const res = parseConfigBundle(JSON.stringify(bundle))
      expect(res.ok).toBe(false)
      if (res.ok && res.data.customProfiles) {
        saveCustomBotProfiles(res.data.customProfiles)
      }
      const persisted = loadCustomBotProfiles()
      expect(persisted).toHaveLength(1)
      expect(persisted[0].id).toBe(existing[0].id)
      expect(persisted[0].preset.name).toBe('Existing Safe Profile')
    }
  })

  it('validates and normalizes a full valid bundle and caps customProfiles at 24 after validation', () => {
    const profiles = Array.from({ length: 26 }, (_, idx) => ({
      id: `custom-bundle-${idx + 1}`,
      savedAt: '2026-11-20T00:00:00.000Z',
      preset: {
        id: idx === 0 ? 'btc-intraday-trend-15m' : undefined,
        name: `Bundle Profile ${idx + 1}`,
        signalParams: { fastPeriod: 80, slowPeriod: 10 },
        filters: { maxBuyRsi: 45, minSellRsi: 55 },
      },
    }))

    const rawBundle = JSON.stringify({
      version: 1,
      settings: {
        theme: 'light',
        language: 'es',
        density: 'compact',
        accentPreset: 'emerald',
        defaultPair: availablePairs[1],
        defaultInterval: '1h',
        timezone: 'local',
        confirmDestructive: false,
        soundAlerts: true,
        reducedMotion: true,
        apiBaseUrl: `  https://flare.internal/${'a'.repeat(300)}  `,
      },
      strategy: {
        pair: 'ETH/USDT',
        positionSize: 10,
        stopLoss: 1.5,
        takeProfit: 3,
        maxDailyRisk: 4,
      },
      customProfiles: profiles,
    })

    const res = parseConfigBundle(rawBundle)
    expect(res.ok).toBe(true)
    if (!res.ok) return

    expect(res.data.settings).toEqual({
      theme: 'light',
      language: 'es',
      density: 'compact',
      accentPreset: 'emerald',
      defaultPair: 'ETH/USDT',
      defaultInterval: '1h',
      timezone: 'local',
      confirmDestructive: false,
      soundAlerts: true,
      reducedMotion: true,
      apiBaseUrl: `https://flare.internal/${'a'.repeat(233)}`,
    })
    expect(res.data.strategy).toEqual({
      pair: 'ETH/USDT',
      positionSize: 10,
      stopLoss: 1.5,
      takeProfit: 3,
      maxDailyRisk: 4,
    })
    expect(res.data.customProfiles).toHaveLength(24)
    expect(res.data.customProfiles?.[0].preset.id).toBe('btc-intraday-trend-15m')
    expect(res.data.customProfiles?.[1].preset.id).toBe('custom-bundle-2')
    expect(
      res.data.customProfiles?.[0].preset.signalParams.fastPeriod,
    ).toBeLessThan(
      res.data.customProfiles?.[0].preset.signalParams.slowPeriod ?? 0,
    )
    expect(
      res.data.customProfiles?.[0].preset.filters?.minSellRsi,
    ).toBeLessThan(
      res.data.customProfiles?.[0].preset.filters?.maxBuyRsi ?? 0,
    )

    if (res.data.customProfiles) {
      saveCustomBotProfiles(res.data.customProfiles)
      expect(loadCustomBotProfiles()).toHaveLength(24)
    }

    const partialRes = parseConfigBundle(
      JSON.stringify({ settings: { theme: 'light', soundAlerts: true } }),
    )
    expect(partialRes.ok).toBe(true)
    if (partialRes.ok) {
      expect(partialRes.data.settings).toEqual({
        ...defaultSettings,
        theme: 'light',
        soundAlerts: true,
      })
    }
  })
})
