import { STRATEGY_PRESETS, type StrategyPreset } from '../botEngine'
import type { SavedBotProfile } from '../botProfiles'
import { defaultSignalParams } from '../signals'
import { defaultStrategy } from '../strategy'
import type { StrategyFamily, TrainingCatalogItem } from './types'

export const ORIGINAL_8_PRESET_IDS = [
  'btc-ema-scalp-5m',
  'btc-intraday-trend-15m',
  'eth-swing-breakout-1h',
  'sol-volatility-surfer-4h',
  'btc-macro-institutional-1d',
  'pred-btc-sma20-bear-cap-15m',
  'pred-btc-inside-bar-4h',
  'pred-btc-bollinger-reversion-1d',
] as const

export const STRATEGY_FAMILIES: readonly {
  id: StrategyFamily
  label: string
}[] = [
  { id: 'trend-momentum', label: 'Trend / Momentum' },
  { id: 'mean-reversion', label: 'Mean Reversion' },
  { id: 'support-resistance', label: 'Support & Resistance' },
  { id: 'break-of-structure', label: 'Break of Structure' },
  { id: 'donchian-breakout', label: 'Donchian Breakout' },
  { id: 'prediction-market', label: 'Prediction Market' },
]

/**
 * Engine templates derived cleanly alongside `STRATEGY_PRESETS` so the operator
 * can train and save `crossover` and `rsi-reversion` strategies as custom presets
 * without creating a disconnected strategy catalog.
 */
export const ENGINE_TEMPLATES: readonly StrategyPreset[] = [
  {
    id: 'template-crossover-ema',
    name: 'EMA/SMA Crossover Template',
    domain: 'crypto-spot',
    description:
      'Trend-following moving average crossover template with RSI extreme guard and EMA 50 alignment.',
    timeframe: '15m',
    strategy: {
      ...defaultStrategy,
      pair: 'BTC/USDT',
      positionSize: 15,
      stopLoss: 1.5,
      takeProfit: 3.0,
      maxDailyRisk: 3.0,
    },
    signalParams: { ...defaultSignalParams, fastPeriod: 9, slowPeriod: 26, average: 'ema' },
    execution: {
      initialBalance: 10_000,
      commissionPct: 0.05,
      slippagePct: 0.02,
      allowShort: true,
    },
    filters: {
      signalEngine: 'crossover',
      avoidRsiExtremes: true,
      maxBuyRsi: 68,
      minSellRsi: 32,
      requireEma50Alignment: true,
      breakevenAtOneR: true,
      flipOnOppositeSignal: true,
    },
  },
  {
    id: 'template-rsi-reversion',
    name: 'RSI Mean Reversion Template',
    domain: 'crypto-spot',
    description:
      'Mean-reversion template entering after oversold/overbought RSI exhaustion with reversal candle confirmation.',
    timeframe: '15m',
    strategy: {
      ...defaultStrategy,
      pair: 'ETH/USDT',
      positionSize: 15,
      stopLoss: 1.4,
      takeProfit: 2.6,
      maxDailyRisk: 3.0,
    },
    signalParams: { ...defaultSignalParams, fastPeriod: 9, slowPeriod: 21, average: 'ema' },
    execution: {
      initialBalance: 10_000,
      commissionPct: 0.05,
      slippagePct: 0.02,
      allowShort: true,
    },
    filters: {
      signalEngine: 'rsi-reversion',
      avoidRsiExtremes: false,
      oversoldRsi: 32,
      overboughtRsi: 68,
      requireEma50Alignment: false,
      breakevenAtOneR: true,
      flipOnOppositeSignal: false,
    },
  },
]

export function getStrategyFamily(preset: StrategyPreset): StrategyFamily {
  if (preset.domain === 'prediction-market') {
    return 'prediction-market'
  }
  const engine = preset.filters?.signalEngine ?? 'momentum-structure'
  if (engine === 'rsi-reversion') return 'mean-reversion'
  if (engine === 'support-resistance') return 'support-resistance'
  if (engine === 'break-of-structure') return 'break-of-structure'
  if (engine === 'donchian-breakout') return 'donchian-breakout'
  return 'trend-momentum'
}

/**
 * Builds the unified Training strategy catalog directly from `STRATEGY_PRESETS`,
 * the two runnable engine templates (`crossover`, `rsi-reversion`), and optional
 * saved custom profiles (`src/botProfiles.ts`).
 */
export function buildTrainingCatalog(
  customProfiles: readonly SavedBotProfile[] = [],
): TrainingCatalogItem[] {
  const fromPresets: TrainingCatalogItem[] = STRATEGY_PRESETS.map((preset) => ({
    id: preset.id,
    presetId: preset.id,
    family: getStrategyFamily(preset),
    kind: 'catalog-preset',
    runnable: true,
    promotableAsCatalog: true,
    preset,
  }))

  const fromTemplates: TrainingCatalogItem[] = ENGINE_TEMPLATES.map(
    (preset) => ({
      id: preset.id,
      presetId: preset.id,
      family: getStrategyFamily(preset),
      kind: 'engine-template',
      runnable: true,
      promotableAsCatalog: false,
      preset,
    }),
  )

  const fromCustom: TrainingCatalogItem[] = customProfiles.map((profile) => ({
    id: profile.id,
    presetId: profile.preset.id || profile.id,
    family: getStrategyFamily(profile.preset),
    kind: 'custom-profile',
    runnable: true,
    promotableAsCatalog: false,
    savedAt: profile.savedAt,
    preset: profile.preset,
  }))

  return [...fromPresets, ...fromTemplates, ...fromCustom]
}

export function getCatalogItemById(
  id: string,
  customProfiles: readonly SavedBotProfile[] = [],
): TrainingCatalogItem | null {
  const catalog = buildTrainingCatalog(customProfiles)
  return catalog.find((item) => item.id === id) ?? null
}
