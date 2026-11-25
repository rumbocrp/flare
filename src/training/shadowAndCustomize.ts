import {
  mergePresetPatch,
  STRATEGY_PRESETS,
  type SignalFilterConfig,
  type StrategyPreset,
  type StrategyPresetPatch,
} from '../botEngine'
import { computeWilsonLowerBoundPct } from '../predictions'
import { ENGINE_TEMPLATES } from './strategyRegistry'
import type { TrainingCatalogItem } from './types'

export const MIN_DRIFT_SAMPLE_SIZE = 30

export type WilsonIntervalPct = {
  lowerPct: number
  upperPct: number
}

export type ShadowDriftStatus =
  | 'insufficient-sample'
  | 'aligned'
  | 'warning'
  | 'divergent'

export type ShadowDriftAssessment = {
  status: ShadowDriftStatus
  sufficient: boolean
  minSampleRequired: number
  oosSampleCount: number
  shadowSampleCount: number
  oosWinRatePct: number | null
  shadowWinRatePct: number | null
  oosWilsonInterval: WilsonIntervalPct | null
  shadowWilsonInterval: WilsonIntervalPct | null
  /** Signed difference (shadow - OOS) in percentage points. Strictly null when either sample < 30. */
  driftPp: number | null
  withinWilsonInterval: boolean | null
}

/**
 * Computes the two-sided Wilson 95% confidence interval for a binomial proportion (in %).
 * Lower bound aligns with `computeWilsonLowerBoundPct` (z = 1.96).
 */
export function computeWilsonIntervalPct(
  wins: number,
  total: number,
  z = 1.96,
): WilsonIntervalPct | null {
  if (!Number.isFinite(total) || total <= 0) return null
  const clampedWins = Math.max(0, Math.min(total, wins))
  const lowerPct = computeWilsonLowerBoundPct(clampedWins, total, z)
  const p = clampedWins / total
  const z2 = z * z
  const denom = 1 + z2 / total
  const center = p + z2 / (2 * total)
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)
  const upperPct = Math.round(Math.min(1, (center + margin) / denom) * 1000) / 10
  return { lowerPct, upperPct }
}

/**
 * Compares held-out OOS win rate (with 95% Wilson interval) against real paper shadow
 * operations. Refuses to produce a numeric drift when either sample has fewer than 30 trades.
 */
export function evaluateShadowDrift(params: {
  oosTrades: number
  oosWins: number
  oosWinRatePct: number | null
  shadowTrades: number
  shadowWins: number
  shadowWinRatePct: number | null
}): ShadowDriftAssessment {
  const oosSampleCount = Math.max(0, Math.trunc(params.oosTrades))
  const shadowSampleCount = Math.max(0, Math.trunc(params.shadowTrades))
  const oosWilsonInterval =
    oosSampleCount > 0
      ? computeWilsonIntervalPct(params.oosWins, oosSampleCount)
      : null
  const shadowWilsonInterval =
    shadowSampleCount > 0
      ? computeWilsonIntervalPct(params.shadowWins, shadowSampleCount)
      : null

  const sufficient =
    oosSampleCount >= MIN_DRIFT_SAMPLE_SIZE &&
    shadowSampleCount >= MIN_DRIFT_SAMPLE_SIZE &&
    params.oosWinRatePct !== null &&
    params.shadowWinRatePct !== null

  if (!sufficient) {
    return {
      status: 'insufficient-sample',
      sufficient: false,
      minSampleRequired: MIN_DRIFT_SAMPLE_SIZE,
      oosSampleCount,
      shadowSampleCount,
      oosWinRatePct: params.oosWinRatePct,
      shadowWinRatePct: params.shadowWinRatePct,
      oosWilsonInterval,
      shadowWilsonInterval,
      driftPp: null,
      withinWilsonInterval: null,
    }
  }

  const oosWr = params.oosWinRatePct as number
  const shadowWr = params.shadowWinRatePct as number
  const driftPp = Math.round((shadowWr - oosWr) * 10) / 10
  const withinWilsonInterval = oosWilsonInterval
    ? shadowWr >= oosWilsonInterval.lowerPct &&
      shadowWr <= oosWilsonInterval.upperPct
    : Math.abs(driftPp) <= 5

  let status: ShadowDriftStatus = 'aligned'
  if (!withinWilsonInterval) {
    status = Math.abs(driftPp) > 12 ? 'divergent' : 'warning'
  }

  return {
    status,
    sufficient: true,
    minSampleRequired: MIN_DRIFT_SAMPLE_SIZE,
    oosSampleCount,
    shadowSampleCount,
    oosWinRatePct: oosWr,
    shadowWinRatePct: shadowWr,
    oosWilsonInterval,
    shadowWilsonInterval,
    driftPp,
    withinWilsonInterval,
  }
}

export type ClampedFieldNotice = {
  field: string
  requested: number
  clamped: number
}

function recordNumericClamp(
  notices: ClampedFieldNotice[],
  field: string,
  requested: unknown,
  actual: number | undefined,
): void {
  if (
    typeof requested !== 'number' ||
    !Number.isFinite(requested) ||
    typeof actual !== 'number' ||
    !Number.isFinite(actual)
  ) {
    return
  }
  if (Math.abs(requested - actual) > 1e-9) {
    notices.push({ field, requested, clamped: actual })
  }
}

/**
 * Applies a parameter patch strictly through `mergePresetPatch` (single source of truth)
 * and detects every numeric field whose value was adjusted/clamped by `mergePresetPatch`.
 */
export function applyPresetPatchWithClamps(
  base: StrategyPreset,
  patch: StrategyPresetPatch,
): { preset: StrategyPreset; clamps: ClampedFieldNotice[] } {
  const preset = mergePresetPatch(base, patch)
  const clamps: ClampedFieldNotice[] = []

  if (patch.strategy) {
    recordNumericClamp(
      clamps,
      'strategy.positionSize',
      patch.strategy.positionSize,
      preset.strategy.positionSize,
    )
    recordNumericClamp(
      clamps,
      'strategy.stopLoss',
      patch.strategy.stopLoss,
      preset.strategy.stopLoss,
    )
    recordNumericClamp(
      clamps,
      'strategy.takeProfit',
      patch.strategy.takeProfit,
      preset.strategy.takeProfit,
    )
    recordNumericClamp(
      clamps,
      'strategy.maxDailyRisk',
      patch.strategy.maxDailyRisk,
      preset.strategy.maxDailyRisk,
    )
  }

  if (patch.signalParams) {
    recordNumericClamp(
      clamps,
      'signalParams.fastPeriod',
      patch.signalParams.fastPeriod,
      preset.signalParams.fastPeriod,
    )
    recordNumericClamp(
      clamps,
      'signalParams.slowPeriod',
      patch.signalParams.slowPeriod,
      preset.signalParams.slowPeriod,
    )
  }

  if (patch.execution) {
    recordNumericClamp(
      clamps,
      'execution.initialBalance',
      patch.execution.initialBalance,
      preset.execution.initialBalance,
    )
    recordNumericClamp(
      clamps,
      'execution.commissionPct',
      patch.execution.commissionPct,
      preset.execution.commissionPct,
    )
    recordNumericClamp(
      clamps,
      'execution.slippagePct',
      patch.execution.slippagePct,
      preset.execution.slippagePct,
    )
  }

  const pf = patch.filters
  const nf = preset.filters
  if (pf && nf) {
    const numericFilterFields: readonly (keyof SignalFilterConfig)[] = [
      'maxBuyRsi',
      'minSellRsi',
      'oversoldRsi',
      'overboughtRsi',
      'channelPeriod',
      'exitPeriod',
      'atrPeriod',
      'atrStopMult',
      'minAtrPct',
      'pivotLookback',
      'clusterAtrMult',
      'minTouches',
      'maxLevelAgeBars',
      'touchToleranceAtr',
      'minLongRsi',
      'maxShortRsi',
      'swingLookback',
      'retestWindowBars',
      'retestToleranceAtr',
      'stopBufferAtr',
      'targetRMultiple',
    ]
    for (const key of numericFilterFields) {
      recordNumericClamp(
        clamps,
        `filters.${key}`,
        pf[key],
        nf[key] as number | undefined,
      )
    }
  }

  recordNumericClamp(clamps, 'minEdgePct', patch.minEdgePct, preset.minEdgePct)
  recordNumericClamp(
    clamps,
    'minTriggers',
    patch.minTriggers,
    preset.minTriggers,
  )

  return { preset, clamps }
}

export type CustomizeGroup = 'engine' | 'filters' | 'risk' | 'execution'

export type CatalogDiffEntry = {
  field: string
  group: CustomizeGroup
  catalogValue: string | number | boolean
  currentValue: string | number | boolean
}

export function findCatalogBasePreset(item: TrainingCatalogItem): StrategyPreset {
  const fromCatalog = STRATEGY_PRESETS.find((p) => p.id === item.presetId)
  if (fromCatalog) return fromCatalog
  const fromTemplates = ENGINE_TEMPLATES.find((p) => p.id === item.id)
  if (fromTemplates) return fromTemplates
  return item.preset
}

function pushDiff(
  diffs: CatalogDiffEntry[],
  field: string,
  group: CustomizeGroup,
  catalogValue: string | number | boolean | undefined,
  currentValue: string | number | boolean | undefined,
): void {
  if (catalogValue === undefined && currentValue === undefined) return
  if (
    typeof catalogValue === 'number' &&
    typeof currentValue === 'number' &&
    Math.abs(catalogValue - currentValue) <= 1e-9
  ) {
    return
  }
  if (catalogValue === currentValue) return
  diffs.push({
    field,
    group,
    catalogValue: catalogValue ?? '—',
    currentValue: currentValue ?? '—',
  })
}

export function computePresetCatalogDiff(
  catalogBase: StrategyPreset,
  current: StrategyPreset,
): CatalogDiffEntry[] {
  const diffs: CatalogDiffEntry[] = []

  // Engine group
  pushDiff(diffs, 'name', 'engine', catalogBase.name, current.name)
  pushDiff(
    diffs,
    'strategy.pair',
    'engine',
    catalogBase.strategy.pair,
    current.strategy.pair,
  )
  pushDiff(diffs, 'timeframe', 'engine', catalogBase.timeframe, current.timeframe)

  if (current.domain === 'prediction-market') {
    pushDiff(
      diffs,
      'predictionRuleId',
      'engine',
      catalogBase.predictionRuleId,
      current.predictionRuleId,
    )
    pushDiff(
      diffs,
      'minEdgePct',
      'filters',
      catalogBase.minEdgePct ?? 15,
      current.minEdgePct ?? 15,
    )
    pushDiff(
      diffs,
      'minTriggers',
      'filters',
      catalogBase.minTriggers ?? 5,
      current.minTriggers ?? 5,
    )
    pushDiff(
      diffs,
      'useQuarterKelly',
      'risk',
      catalogBase.useQuarterKelly ?? true,
      current.useQuarterKelly ?? true,
    )
  } else {
    const baseEngine = catalogBase.filters?.signalEngine ?? 'momentum-structure'
    const currEngine = current.filters?.signalEngine ?? 'momentum-structure'
    pushDiff(diffs, 'filters.signalEngine', 'engine', baseEngine, currEngine)
    pushDiff(
      diffs,
      'signalParams.fastPeriod',
      'engine',
      catalogBase.signalParams.fastPeriod,
      current.signalParams.fastPeriod,
    )
    pushDiff(
      diffs,
      'signalParams.slowPeriod',
      'engine',
      catalogBase.signalParams.slowPeriod,
      current.signalParams.slowPeriod,
    )
    pushDiff(
      diffs,
      'signalParams.average',
      'engine',
      catalogBase.signalParams.average,
      current.signalParams.average,
    )

    // Signal filters group
    const bf = catalogBase.filters ?? {}
    const cf = current.filters ?? {}
    pushDiff(
      diffs,
      'filters.breakevenAtOneR',
      'filters',
      bf.breakevenAtOneR ?? true,
      cf.breakevenAtOneR ?? true,
    )
    pushDiff(
      diffs,
      'filters.flipOnOppositeSignal',
      'filters',
      bf.flipOnOppositeSignal ?? false,
      cf.flipOnOppositeSignal ?? false,
    )

    if (currEngine === 'momentum-structure' || currEngine === 'crossover') {
      pushDiff(
        diffs,
        'filters.avoidRsiExtremes',
        'filters',
        bf.avoidRsiExtremes ?? true,
        cf.avoidRsiExtremes ?? true,
      )
      pushDiff(
        diffs,
        'filters.maxBuyRsi',
        'filters',
        bf.maxBuyRsi ?? 68,
        cf.maxBuyRsi ?? 68,
      )
      pushDiff(
        diffs,
        'filters.minSellRsi',
        'filters',
        bf.minSellRsi ?? 32,
        cf.minSellRsi ?? 32,
      )
      pushDiff(
        diffs,
        'filters.requireEma50Alignment',
        'filters',
        bf.requireEma50Alignment ?? false,
        cf.requireEma50Alignment ?? false,
      )
    } else if (currEngine === 'rsi-reversion') {
      pushDiff(
        diffs,
        'filters.oversoldRsi',
        'filters',
        bf.oversoldRsi ?? 30,
        cf.oversoldRsi ?? 30,
      )
      pushDiff(
        diffs,
        'filters.overboughtRsi',
        'filters',
        bf.overboughtRsi ?? 70,
        cf.overboughtRsi ?? 70,
      )
      pushDiff(
        diffs,
        'filters.requireEma50Alignment',
        'filters',
        bf.requireEma50Alignment ?? false,
        cf.requireEma50Alignment ?? false,
      )
    } else if (currEngine === 'donchian-breakout') {
      pushDiff(diffs, 'filters.channelPeriod', 'filters', bf.channelPeriod, cf.channelPeriod)
      pushDiff(diffs, 'filters.exitPeriod', 'filters', bf.exitPeriod, cf.exitPeriod)
      pushDiff(diffs, 'filters.atrPeriod', 'filters', bf.atrPeriod, cf.atrPeriod)
      pushDiff(diffs, 'filters.atrStopMult', 'filters', bf.atrStopMult, cf.atrStopMult)
      pushDiff(diffs, 'filters.trendFilter', 'filters', bf.trendFilter, cf.trendFilter)
      pushDiff(diffs, 'filters.minAtrPct', 'filters', bf.minAtrPct, cf.minAtrPct)
    } else if (currEngine === 'support-resistance') {
      pushDiff(diffs, 'filters.pivotLookback', 'filters', bf.pivotLookback, cf.pivotLookback)
      pushDiff(diffs, 'filters.clusterAtrMult', 'filters', bf.clusterAtrMult, cf.clusterAtrMult)
      pushDiff(diffs, 'filters.minTouches', 'filters', bf.minTouches, cf.minTouches)
      pushDiff(diffs, 'filters.maxLevelAgeBars', 'filters', bf.maxLevelAgeBars, cf.maxLevelAgeBars)
      pushDiff(diffs, 'filters.touchToleranceAtr', 'filters', bf.touchToleranceAtr, cf.touchToleranceAtr)
      pushDiff(diffs, 'filters.atrStopMult', 'filters', bf.atrStopMult, cf.atrStopMult)
      pushDiff(diffs, 'filters.minLongRsi', 'filters', bf.minLongRsi, cf.minLongRsi)
      pushDiff(diffs, 'filters.maxShortRsi', 'filters', bf.maxShortRsi, cf.maxShortRsi)
      pushDiff(diffs, 'filters.atrPeriod', 'filters', bf.atrPeriod, cf.atrPeriod)
    } else if (currEngine === 'break-of-structure') {
      pushDiff(diffs, 'filters.swingLookback', 'filters', bf.swingLookback, cf.swingLookback)
      pushDiff(diffs, 'filters.retestWindowBars', 'filters', bf.retestWindowBars, cf.retestWindowBars)
      pushDiff(diffs, 'filters.retestToleranceAtr', 'filters', bf.retestToleranceAtr, cf.retestToleranceAtr)
      pushDiff(diffs, 'filters.stopBufferAtr', 'filters', bf.stopBufferAtr, cf.stopBufferAtr)
      pushDiff(diffs, 'filters.targetRMultiple', 'filters', bf.targetRMultiple, cf.targetRMultiple)
      pushDiff(diffs, 'filters.atrPeriod', 'filters', bf.atrPeriod, cf.atrPeriod)
      pushDiff(diffs, 'filters.requireRetest', 'filters', bf.requireRetest, cf.requireRetest)
    }
  }

  // Risk group
  pushDiff(
    diffs,
    'strategy.positionSize',
    'risk',
    catalogBase.strategy.positionSize,
    current.strategy.positionSize,
  )
  pushDiff(
    diffs,
    'strategy.stopLoss',
    'risk',
    catalogBase.strategy.stopLoss,
    current.strategy.stopLoss,
  )
  pushDiff(
    diffs,
    'strategy.takeProfit',
    'risk',
    catalogBase.strategy.takeProfit,
    current.strategy.takeProfit,
  )
  pushDiff(
    diffs,
    'strategy.maxDailyRisk',
    'risk',
    catalogBase.strategy.maxDailyRisk,
    current.strategy.maxDailyRisk,
  )

  // Execution group
  pushDiff(
    diffs,
    'execution.initialBalance',
    'execution',
    catalogBase.execution.initialBalance,
    current.execution.initialBalance,
  )
  pushDiff(
    diffs,
    'execution.commissionPct',
    'execution',
    catalogBase.execution.commissionPct,
    current.execution.commissionPct,
  )
  pushDiff(
    diffs,
    'execution.slippagePct',
    'execution',
    catalogBase.execution.slippagePct,
    current.execution.slippagePct,
  )
  pushDiff(
    diffs,
    'execution.allowShort',
    'execution',
    catalogBase.execution.allowShort,
    current.execution.allowShort,
  )

  return diffs
}

export function presetToFullPatch(preset: StrategyPreset): StrategyPresetPatch {
  return {
    name: preset.name,
    description: preset.description,
    domain: preset.domain,
    timeframe: preset.timeframe,
    strategy: { ...preset.strategy },
    signalParams: { ...preset.signalParams },
    execution: { ...preset.execution },
    filters: preset.filters ? { ...preset.filters } : undefined,
    predictionRuleId: preset.predictionRuleId,
    minEdgePct: preset.minEdgePct,
    minTriggers: preset.minTriggers,
    useQuarterKelly: preset.useQuarterKelly,
  }
}

export type PromotionPlan =
  | { allowed: false; reason: 'research-variant' }
  | {
      allowed: true
      mode: 'catalog' | 'custom'
      payload: {
        presetId?: string
        customPreset?: StrategyPresetPatch
      }
      diffCount: number
    }

/**
 * Builds the exact `selectBotPresetOnServer` payload for promoting a strategy:
 * - Unmodified catalog preset -> `{ presetId }`
 * - Modified catalog preset -> `{ presetId, customPreset }`
 * - Custom profile / engine template -> `{ customPreset }`
 * - Research variant (pair/timeframe mismatch on run config) -> disallowed.
 */
export function buildPromotionPlan(
  item: TrainingCatalogItem,
  currentPreset: StrategyPreset,
  isResearchVariant: boolean,
): PromotionPlan {
  if (isResearchVariant) {
    return { allowed: false, reason: 'research-variant' }
  }

  const catalogBase = findCatalogBasePreset(item)
  const diffs = computePresetCatalogDiff(catalogBase, currentPreset)
  const isOfficialCatalogId = STRATEGY_PRESETS.some(
    (p) => p.id === item.presetId,
  )

  if (item.promotableAsCatalog && isOfficialCatalogId && diffs.length === 0) {
    return {
      allowed: true,
      mode: 'catalog',
      payload: { presetId: item.presetId },
      diffCount: 0,
    }
  }

  const customPreset = presetToFullPatch(currentPreset)
  return {
    allowed: true,
    mode: 'custom',
    payload:
      item.promotableAsCatalog && isOfficialCatalogId
        ? { presetId: item.presetId, customPreset }
        : { customPreset },
    diffCount: diffs.length,
  }
}

/**
 * Converts a walk-forward run's `bestSelectedParams` map into a `StrategyPresetPatch`
 * so the operator can inspect and apply validated parameters directly inside CustomizePanel.
 */
export function bestParamsToPresetPatch(
  base: StrategyPreset,
  bestParams: Record<string, string | number | boolean>,
): StrategyPresetPatch {
  const strategy: Partial<StrategyPreset['strategy']> = {}
  const signalParams: Partial<StrategyPreset['signalParams']> = {}
  const filters: Partial<SignalFilterConfig> = {}

  for (const [key, value] of Object.entries(bestParams)) {
    if (key === 'stopLoss' && typeof value === 'number') {
      strategy.stopLoss = value
    } else if (key === 'takeProfit' && typeof value === 'number') {
      strategy.takeProfit = value
    } else if (key === 'stopLossMult' && typeof value === 'number') {
      strategy.stopLoss = Math.round(base.strategy.stopLoss * value * 100) / 100
    } else if (key === 'takeProfitMult' && typeof value === 'number') {
      strategy.takeProfit =
        Math.round(base.strategy.takeProfit * value * 100) / 100
    } else if (key === 'fastPeriod' && typeof value === 'number') {
      signalParams.fastPeriod = value
    } else if (key === 'slowPeriod' && typeof value === 'number') {
      signalParams.slowPeriod = value
    } else if (
      key === 'maxBuyRsi' ||
      key === 'minSellRsi' ||
      key === 'oversoldRsi' ||
      key === 'overboughtRsi' ||
      key === 'channelPeriod' ||
      key === 'exitPeriod' ||
      key === 'atrPeriod' ||
      key === 'atrStopMult' ||
      key === 'minAtrPct' ||
      key === 'pivotLookback' ||
      key === 'clusterAtrMult' ||
      key === 'minTouches' ||
      key === 'maxLevelAgeBars' ||
      key === 'touchToleranceAtr' ||
      key === 'minLongRsi' ||
      key === 'maxShortRsi' ||
      key === 'swingLookback' ||
      key === 'retestWindowBars' ||
      key === 'retestToleranceAtr' ||
      key === 'stopBufferAtr' ||
      key === 'targetRMultiple'
    ) {
      if (typeof value === 'number') {
        ;(filters as Record<string, unknown>)[key] = value
      }
    } else if (key === 'requireRetest' && typeof value === 'boolean') {
      filters.requireRetest = value
    } else if (
      key === 'trendFilter' &&
      (value === 'ema200' || value === 'none')
    ) {
      filters.trendFilter = value
    }
  }

  return {
    ...(Object.keys(strategy).length > 0 ? { strategy } : {}),
    ...(Object.keys(signalParams).length > 0 ? { signalParams } : {}),
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
  }
}

