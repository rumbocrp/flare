import {
  mergePresetPatch,
  STRATEGY_PRESETS,
  type StrategyPreset,
} from './botEngine'
import type { SavedBotProfile } from './botProfiles'
import { normalizeAppSettings } from './settings'
import { availablePairs, isStrategy } from './strategy'
import type {
  AccentPreset,
  AppSettings,
  DensitySetting,
  Interval,
  Language,
  Strategy,
  ThemeSetting,
  TimezoneSetting,
} from './types'

const MAX_CUSTOM_PROFILES = 24
const MAX_PROFILE_ID_LENGTH = 90

const VALID_THEMES: readonly ThemeSetting[] = ['dark', 'light', 'system']
const VALID_LANGUAGES: readonly Language[] = ['en', 'es']
const VALID_DENSITIES: readonly DensitySetting[] = ['comfortable', 'compact']
const VALID_ACCENTS: readonly AccentPreset[] = [
  'amber',
  'emerald',
  'violet',
  'cyan',
]
const VALID_INTERVALS: readonly Interval[] = ['5m', '15m', '1h', '4h', '1d']
const VALID_TIMEZONES: readonly TimezoneSetting[] = ['UTC', 'local']

const SETTINGS_KEYS = [
  'theme',
  'language',
  'density',
  'accentPreset',
  'defaultPair',
  'defaultInterval',
  'timezone',
  'confirmDestructive',
  'soundAlerts',
  'reducedMotion',
  'apiBaseUrl',
] as const

export type ConfigBundleData = {
  settings?: AppSettings
  strategy?: Strategy
  customProfiles?: SavedBotProfile[]
}

export type ConfigBundleParseResult =
  | { ok: true; data: ConfigBundleData }
  | { ok: false; error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function isFiniteInRange(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  )
}

function validateAndNormalizeSettings(
  raw: unknown,
): { ok: true; value: AppSettings } | { ok: false; error: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'Bundle settings must be a plain JSON object' }
  }

  let hasKnownKey = false
  for (const key of SETTINGS_KEYS) {
    if (hasOwn(raw, key) && raw[key] !== undefined) {
      hasKnownKey = true
      break
    }
  }
  if (!hasKnownKey) {
    return {
      ok: false,
      error: 'Bundle settings object contains no recognized AppSettings fields',
    }
  }

  const cleanPartial: Partial<AppSettings> = {}

  if (hasOwn(raw, 'theme') && raw.theme !== undefined) {
    if (
      typeof raw.theme !== 'string' ||
      !VALID_THEMES.includes(raw.theme as ThemeSetting)
    ) {
      return { ok: false, error: 'Invalid settings.theme' }
    }
    cleanPartial.theme = raw.theme as ThemeSetting
  }

  if (hasOwn(raw, 'language') && raw.language !== undefined) {
    if (
      typeof raw.language !== 'string' ||
      !VALID_LANGUAGES.includes(raw.language as Language)
    ) {
      return { ok: false, error: 'Invalid settings.language' }
    }
    cleanPartial.language = raw.language as Language
  }

  if (hasOwn(raw, 'density') && raw.density !== undefined) {
    if (
      typeof raw.density !== 'string' ||
      !VALID_DENSITIES.includes(raw.density as DensitySetting)
    ) {
      return { ok: false, error: 'Invalid settings.density' }
    }
    cleanPartial.density = raw.density as DensitySetting
  }

  if (hasOwn(raw, 'accentPreset') && raw.accentPreset !== undefined) {
    if (
      typeof raw.accentPreset !== 'string' ||
      !VALID_ACCENTS.includes(raw.accentPreset as AccentPreset)
    ) {
      return { ok: false, error: 'Invalid settings.accentPreset' }
    }
    cleanPartial.accentPreset = raw.accentPreset as AccentPreset
  }

  if (hasOwn(raw, 'defaultPair') && raw.defaultPair !== undefined) {
    if (
      typeof raw.defaultPair !== 'string' ||
      !availablePairs.includes(raw.defaultPair)
    ) {
      return { ok: false, error: 'Invalid settings.defaultPair' }
    }
    cleanPartial.defaultPair = raw.defaultPair
  }

  if (hasOwn(raw, 'defaultInterval') && raw.defaultInterval !== undefined) {
    if (
      typeof raw.defaultInterval !== 'string' ||
      !VALID_INTERVALS.includes(raw.defaultInterval as Interval)
    ) {
      return { ok: false, error: 'Invalid settings.defaultInterval' }
    }
    cleanPartial.defaultInterval = raw.defaultInterval as Interval
  }

  if (hasOwn(raw, 'timezone') && raw.timezone !== undefined) {
    if (
      typeof raw.timezone !== 'string' ||
      !VALID_TIMEZONES.includes(raw.timezone as TimezoneSetting)
    ) {
      return { ok: false, error: 'Invalid settings.timezone' }
    }
    cleanPartial.timezone = raw.timezone as TimezoneSetting
  }

  if (
    hasOwn(raw, 'confirmDestructive') &&
    raw.confirmDestructive !== undefined
  ) {
    if (typeof raw.confirmDestructive !== 'boolean') {
      return { ok: false, error: 'Invalid settings.confirmDestructive' }
    }
    cleanPartial.confirmDestructive = raw.confirmDestructive
  }

  if (hasOwn(raw, 'soundAlerts') && raw.soundAlerts !== undefined) {
    if (typeof raw.soundAlerts !== 'boolean') {
      return { ok: false, error: 'Invalid settings.soundAlerts' }
    }
    cleanPartial.soundAlerts = raw.soundAlerts
  }

  if (hasOwn(raw, 'reducedMotion') && raw.reducedMotion !== undefined) {
    if (typeof raw.reducedMotion !== 'boolean') {
      return { ok: false, error: 'Invalid settings.reducedMotion' }
    }
    cleanPartial.reducedMotion = raw.reducedMotion
  }

  if (hasOwn(raw, 'apiBaseUrl') && raw.apiBaseUrl !== undefined) {
    if (typeof raw.apiBaseUrl !== 'string') {
      return { ok: false, error: 'Invalid settings.apiBaseUrl' }
    }
    cleanPartial.apiBaseUrl = raw.apiBaseUrl
  }

  return { ok: true, value: normalizeAppSettings(cleanPartial) }
}

function validateAndSanitizeStrategy(
  raw: unknown,
): { ok: true; value: Strategy } | { ok: false; error: string } {
  if (!isPlainObject(raw) || !isStrategy(raw)) {
    return {
      ok: false,
      error: 'Bundle strategy must be a valid Strategy object with a known pair',
    }
  }

  if (!isFiniteInRange(raw.positionSize, 0.1, 100)) {
    return {
      ok: false,
      error: 'Invalid strategy.positionSize (must be 0.1–100)',
    }
  }
  if (!isFiniteInRange(raw.stopLoss, 0.1, 50)) {
    return {
      ok: false,
      error: 'Invalid strategy.stopLoss (must be 0.1–50)',
    }
  }
  if (!isFiniteInRange(raw.takeProfit, 0.1, 100)) {
    return {
      ok: false,
      error: 'Invalid strategy.takeProfit (must be 0.1–100)',
    }
  }
  if (!isFiniteInRange(raw.maxDailyRisk, 0.1, 100)) {
    return {
      ok: false,
      error: 'Invalid strategy.maxDailyRisk (must be 0.1–100)',
    }
  }

  return {
    ok: true,
    value: {
      pair: raw.pair,
      positionSize: raw.positionSize,
      stopLoss: raw.stopLoss,
      takeProfit: raw.takeProfit,
      maxDailyRisk: raw.maxDailyRisk,
    },
  }
}

function validateAndSanitizeCustomProfiles(
  raw: unknown,
): { ok: true; value: SavedBotProfile[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'Bundle customProfiles must be an array' }
  }

  const sanitized: SavedBotProfile[] = []

  for (let index = 0; index < raw.length; index++) {
    const item = raw[index]
    if (!isPlainObject(item)) {
      return {
        ok: false,
        error: `Invalid customProfiles[${index}]: must be an object`,
      }
    }

    if (typeof item.id !== 'string') {
      return {
        ok: false,
        error: `Invalid customProfiles[${index}].id: must be a non-empty string`,
      }
    }

    const trimmedId = item.id.trim()
    if (trimmedId.length === 0 || trimmedId.length > MAX_PROFILE_ID_LENGTH) {
      return {
        ok: false,
        error: `Invalid customProfiles[${index}].id: length must be 1–${MAX_PROFILE_ID_LENGTH}`,
      }
    }

    if (
      hasOwn(item, 'savedAt') &&
      item.savedAt !== undefined &&
      typeof item.savedAt !== 'string'
    ) {
      return {
        ok: false,
        error: `Invalid customProfiles[${index}].savedAt: must be a string`,
      }
    }

    if (!isPlainObject(item.preset)) {
      return {
        ok: false,
        error: `Invalid customProfiles[${index}].preset: must be an object`,
      }
    }

    const rawPreset = item.preset as Partial<StrategyPreset>
    if (
      hasOwn(item.preset, 'id') &&
      item.preset.id !== undefined &&
      typeof item.preset.id !== 'string'
    ) {
      return {
        ok: false,
        error: `Invalid customProfiles[${index}].preset.id: must be a string`,
      }
    }

    const base =
      (typeof rawPreset.id === 'string'
        ? STRATEGY_PRESETS.find((p) => p.id === rawPreset.id)
        : undefined) ?? STRATEGY_PRESETS[1]

    const presetId =
      typeof rawPreset.id === 'string' && rawPreset.id.trim().length > 0
        ? rawPreset.id.trim()
        : trimmedId

    sanitized.push({
      id: trimmedId,
      savedAt:
        typeof item.savedAt === 'string' && item.savedAt.trim().length > 0
          ? item.savedAt
          : new Date().toISOString(),
      preset: {
        ...mergePresetPatch(base, rawPreset),
        id: presetId,
      },
    })
  }

  return {
    ok: true,
    value: sanitized.slice(0, MAX_CUSTOM_PROFILES),
  }
}

export function validateConfigBundle(parsed: unknown): ConfigBundleParseResult {
  if (!isPlainObject(parsed)) {
    return { ok: false, error: 'Root JSON must be a plain object' }
  }

  const hasSettings = hasOwn(parsed, 'settings') && parsed.settings !== undefined
  const hasStrategy = hasOwn(parsed, 'strategy') && parsed.strategy !== undefined
  const hasProfiles =
    hasOwn(parsed, 'customProfiles') && parsed.customProfiles !== undefined

  if (!hasSettings && !hasStrategy && !hasProfiles) {
    return {
      ok: false,
      error:
        'Bundle must contain at least one of settings, strategy, or customProfiles',
    }
  }

  const data: ConfigBundleData = {}

  if (hasSettings) {
    const settingsResult = validateAndNormalizeSettings(parsed.settings)
    if (!settingsResult.ok) {
      return settingsResult
    }
    data.settings = settingsResult.value
  }

  if (hasStrategy) {
    const strategyResult = validateAndSanitizeStrategy(parsed.strategy)
    if (!strategyResult.ok) {
      return strategyResult
    }
    data.strategy = strategyResult.value
  }

  if (hasProfiles) {
    const profilesResult = validateAndSanitizeCustomProfiles(
      parsed.customProfiles,
    )
    if (!profilesResult.ok) {
      return profilesResult
    }
    data.customProfiles = profilesResult.value
  }

  return { ok: true, data }
}

export function parseConfigBundle(rawJson: string): ConfigBundleParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Parse error',
    }
  }
  return validateConfigBundle(parsed)
}
