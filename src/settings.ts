import { availablePairs } from './strategy'
import type {
  AccentPreset,
  AppSettings,
  DensitySetting,
  Interval,
  Language,
  ThemeSetting,
  TimezoneSetting,
} from './types'

export const defaultSettings: AppSettings = {
  theme: 'dark',
  language: 'en',
  density: 'comfortable',
  accentPreset: 'amber',
  defaultPair: 'BTC/USDT',
  defaultInterval: '15m',
  timezone: 'UTC',
  confirmDestructive: true,
  soundAlerts: false,
  reducedMotion: false,
  apiBaseUrl: '',
}

const themes: readonly ThemeSetting[] = ['dark', 'light', 'system']
const languages: readonly Language[] = ['en', 'es']
const densities: readonly DensitySetting[] = ['comfortable', 'compact']
const accents: readonly AccentPreset[] = ['amber', 'emerald', 'violet', 'cyan']
const intervals: readonly Interval[] = ['5m', '15m', '1h', '4h', '1d']
const timezones: readonly TimezoneSetting[] = ['UTC', 'local']

export function normalizeAppSettings(
  raw?: Partial<AppSettings> | null,
): AppSettings {
  if (!raw || typeof raw !== 'object') return { ...defaultSettings }

  return {
    theme:
      typeof raw.theme === 'string' &&
      themes.includes(raw.theme as ThemeSetting)
        ? (raw.theme as ThemeSetting)
        : defaultSettings.theme,
    language:
      typeof raw.language === 'string' &&
      languages.includes(raw.language as Language)
        ? (raw.language as Language)
        : defaultSettings.language,
    density:
      typeof raw.density === 'string' &&
      densities.includes(raw.density as DensitySetting)
        ? (raw.density as DensitySetting)
        : defaultSettings.density,
    accentPreset:
      typeof raw.accentPreset === 'string' &&
      accents.includes(raw.accentPreset as AccentPreset)
        ? (raw.accentPreset as AccentPreset)
        : defaultSettings.accentPreset,
    defaultPair:
      typeof raw.defaultPair === 'string' &&
      availablePairs.includes(raw.defaultPair)
        ? raw.defaultPair
        : defaultSettings.defaultPair,
    defaultInterval:
      typeof raw.defaultInterval === 'string' &&
      intervals.includes(raw.defaultInterval as Interval)
        ? (raw.defaultInterval as Interval)
        : defaultSettings.defaultInterval,
    timezone:
      typeof raw.timezone === 'string' &&
      timezones.includes(raw.timezone as TimezoneSetting)
        ? (raw.timezone as TimezoneSetting)
        : defaultSettings.timezone,
    confirmDestructive:
      typeof raw.confirmDestructive === 'boolean'
        ? raw.confirmDestructive
        : defaultSettings.confirmDestructive,
    soundAlerts:
      typeof raw.soundAlerts === 'boolean'
        ? raw.soundAlerts
        : defaultSettings.soundAlerts,
    reducedMotion:
      typeof raw.reducedMotion === 'boolean'
        ? raw.reducedMotion
        : defaultSettings.reducedMotion,
    apiBaseUrl:
      typeof raw.apiBaseUrl === 'string'
        ? raw.apiBaseUrl.trim().slice(0, 256)
        : defaultSettings.apiBaseUrl,
  }
}

export function isAppSettings(value: unknown): value is AppSettings {
  if (typeof value !== 'object' || value === null) return false

  const candidate = value as Record<string, unknown>

  return (
    typeof candidate.theme === 'string' &&
    themes.includes(candidate.theme as ThemeSetting) &&
    (candidate.language === undefined ||
      languages.includes(candidate.language as Language)) &&
    (candidate.density === undefined ||
      densities.includes(candidate.density as DensitySetting)) &&
    (candidate.accentPreset === undefined ||
      accents.includes(candidate.accentPreset as AccentPreset)) &&
    (candidate.defaultPair === undefined ||
      (typeof candidate.defaultPair === 'string' &&
        availablePairs.includes(candidate.defaultPair))) &&
    (candidate.defaultInterval === undefined ||
      intervals.includes(candidate.defaultInterval as Interval)) &&
    (candidate.timezone === undefined ||
      timezones.includes(candidate.timezone as TimezoneSetting)) &&
    (candidate.confirmDestructive === undefined ||
      typeof candidate.confirmDestructive === 'boolean') &&
    (candidate.soundAlerts === undefined ||
      typeof candidate.soundAlerts === 'boolean') &&
    (candidate.reducedMotion === undefined ||
      typeof candidate.reducedMotion === 'boolean') &&
    (candidate.apiBaseUrl === undefined ||
      typeof candidate.apiBaseUrl === 'string')
  )
}
