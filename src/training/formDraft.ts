import { formatDurationMs } from '@/botRunUtils'
import type { Translate } from '@/i18n'
import { intervalMs } from '@/market/intervals'
import type {
  TrainingCatalogItem,
  TrainingConfig,
  TrainingRunKind,
} from '@/training/types'
import type { Interval } from '@/types'

export const MAX_TRAINING_HISTORY_BARS = 5_000
const DAY_MS = 86_400_000

export type DateRangePreset = '30d' | '90d' | '180d' | '365d' | 'custom'

export type TrainingFormDraft = {
  kind: TrainingRunKind
  pair: string
  timeframe: Interval
  rangePreset: DateRangePreset
  fromDate: string // YYYY-MM-DD (UTC)
  toDate: string // YYYY-MM-DD (UTC)
  foldCount: number
  foldMode: 'anchored' | 'rolling'
  trainRatioPct: string
  valRatioPct: string
  testRatioPct: string
  purgeGapBars: string
  commissionPct: string
  slippagePct: string
  initialBalance: string
  allowShort: boolean
}

export type TrainingFormValidation = {
  valid: boolean
  errors: Partial<Record<keyof TrainingFormDraft | 'range' | 'ratios', string>>
  warnings: string[]
  fromTimeMs: number
  toTimeMs: number
  estimatedBars: number
  testFoldDurationMs: number
  totalRangeDays: number
  isResearchVariant: boolean
}

export function toUtcDateInput(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function parseUtcDateStart(dateStr: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return Number.NaN
  return Date.parse(`${dateStr}T00:00:00.000Z`)
}

function parseUtcDateEnd(dateStr: string, nowMs: number): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return Number.NaN
  const endOfDay = Date.parse(`${dateStr}T23:59:59.000Z`)
  return Math.min(endOfDay, nowMs)
}

function defaultRangeDaysForInterval(tf: Interval): {
  preset: DateRangePreset
  days: number
} {
  if (tf === '5m') return { preset: 'custom', days: 14 }
  if (tf === '15m') return { preset: '30d', days: 30 }
  if (tf === '1h') return { preset: '90d', days: 90 }
  if (tf === '4h') return { preset: '180d', days: 180 }
  return { preset: '365d', days: 365 }
}

export function buildDefaultDraft(
  item: TrainingCatalogItem,
  nowMs: number,
): TrainingFormDraft {
  const preset = item.preset
  const rangeDef = defaultRangeDaysForInterval(preset.timeframe)
  const toMs = nowMs
  const fromMs = toMs - rangeDef.days * DAY_MS

  return {
    kind:
      preset.domain === 'prediction-market'
        ? 'prediction-market'
        : 'walk-forward',
    pair: preset.strategy.pair,
    timeframe: preset.timeframe,
    rangePreset: rangeDef.preset,
    fromDate: toUtcDateInput(fromMs),
    toDate: toUtcDateInput(toMs),
    foldCount: 5,
    foldMode: 'anchored',
    trainRatioPct: '55',
    valRatioPct: '20',
    testRatioPct: '25',
    purgeGapBars: '5',
    commissionPct: String(preset.execution.commissionPct),
    slippagePct: String(preset.execution.slippagePct),
    initialBalance: String(preset.execution.initialBalance),
    allowShort: preset.execution.allowShort,
  }
}

export function validateTrainingDraft(
  draft: TrainingFormDraft,
  item: TrainingCatalogItem,
  nowMs: number,
  t: Translate,
): TrainingFormValidation {
  const errors: TrainingFormValidation['errors'] = {}
  const warnings: string[] = []

  const stepMs = intervalMs[draft.timeframe]
  let fromTimeMs = parseUtcDateStart(draft.fromDate)
  let toTimeMs = parseUtcDateEnd(draft.toDate, nowMs)

  if (draft.rangePreset !== 'custom') {
    const days =
      draft.rangePreset === '30d'
        ? 30
        : draft.rangePreset === '90d'
          ? 90
          : draft.rangePreset === '180d'
            ? 180
            : 365
    toTimeMs = nowMs
    fromTimeMs = nowMs - days * DAY_MS
  }

  if (
    !Number.isFinite(fromTimeMs) ||
    !Number.isFinite(toTimeMs) ||
    fromTimeMs >= toTimeMs
  ) {
    errors.range = t('training.errRangeOrder')
  } else if (toTimeMs > nowMs + stepMs) {
    errors.range = t('training.errRangeFuture')
  }

  const estimatedBars =
    Number.isFinite(fromTimeMs) &&
    Number.isFinite(toTimeMs) &&
    toTimeMs > fromTimeMs
      ? Math.floor((toTimeMs - fromTimeMs) / stepMs) + 1
      : 0

  if (!errors.range && estimatedBars > MAX_TRAINING_HISTORY_BARS) {
    errors.range = t('training.errMaxBars', {
      bars: estimatedBars,
      max: MAX_TRAINING_HISTORY_BARS,
    })
  } else if (!errors.range && estimatedBars < 120) {
    errors.range = t('training.errMinBars', { bars: estimatedBars })
  }

  const trainPct = Number(draft.trainRatioPct)
  const valPct = Number(draft.valRatioPct)
  const testPct = Number(draft.testRatioPct)
  if (
    !Number.isFinite(trainPct) ||
    !Number.isFinite(valPct) ||
    !Number.isFinite(testPct) ||
    trainPct < 30 ||
    valPct < 5 ||
    testPct < 10 ||
    Math.abs(trainPct + valPct + testPct - 100) > 0.1
  ) {
    errors.ratios = t('training.errRatiosSum')
  }

  const purge = Number(draft.purgeGapBars)
  if (!Number.isInteger(purge) || purge < 1 || purge > 500) {
    errors.purgeGapBars = t('validation.range', { min: 1, max: 500 })
  }

  const fee = Number(draft.commissionPct)
  if (!Number.isFinite(fee) || fee < 0 || fee > 5) {
    errors.commissionPct = t('validation.range', { min: 0, max: 5 })
  }

  const slip = Number(draft.slippagePct)
  if (!Number.isFinite(slip) || slip < 0 || slip > 5) {
    errors.slippagePct = t('validation.range', { min: 0, max: 5 })
  }

  const balance = Number(draft.initialBalance)
  if (!Number.isFinite(balance) || balance < 100 || balance > 10_000_000) {
    errors.initialBalance = t('validation.range', { min: 100, max: 10_000_000 })
  }

  const totalRangeDays =
    Number.isFinite(fromTimeMs) &&
    Number.isFinite(toTimeMs) &&
    toTimeMs > fromTimeMs
      ? (toTimeMs - fromTimeMs) / DAY_MS
      : 0

  const testRatio = Number.isFinite(testPct) ? testPct / 100 : 0.25
  const foldCount = draft.kind === 'walk-forward' ? draft.foldCount : 1
  const baseWindowBars =
    estimatedBars > 0
      ? Math.floor(estimatedBars / (1 + (foldCount - 1) * testRatio))
      : 0
  const testFoldBars = Math.max(0, Math.floor(baseWindowBars * testRatio))
  const testFoldDurationMs = testFoldBars * stepMs

  if (!errors.range) {
    if (totalRangeDays < 60) {
      warnings.push(
        t('training.warnShortRange', { days: Math.round(totalRangeDays) }),
      )
    }
    if (testFoldDurationMs > 0 && testFoldDurationMs < 14 * DAY_MS) {
      warnings.push(
        t('training.warnShortTestFold', {
          duration: formatDurationMs(testFoldDurationMs),
        }),
      )
    }
  }

  const isResearchVariant =
    draft.pair !== item.preset.strategy.pair ||
    draft.timeframe !== item.preset.timeframe

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    warnings,
    fromTimeMs: Math.floor(fromTimeMs),
    toTimeMs: Math.floor(toTimeMs),
    estimatedBars,
    testFoldDurationMs,
    totalRangeDays,
    isResearchVariant,
  }
}

export function draftToTrainingConfig(
  draft: TrainingFormDraft,
  item: TrainingCatalogItem,
  validation: TrainingFormValidation,
): TrainingConfig {
  return {
    kind: draft.kind,
    presetId: item.presetId,
    pair: draft.pair,
    timeframe: draft.timeframe,
    fromTimeMs: validation.fromTimeMs,
    toTimeMs: validation.toTimeMs,
    foldCount: draft.foldCount,
    foldMode: draft.foldMode,
    trainRatio: Number(draft.trainRatioPct) / 100,
    valRatio: Number(draft.valRatioPct) / 100,
    testRatio: Number(draft.testRatioPct) / 100,
    purgeGapBars: Math.round(Number(draft.purgeGapBars)),
    assumptions: {
      commissionPct: Number(draft.commissionPct),
      slippagePct: Number(draft.slippagePct),
      initialBalance: Number(draft.initialBalance),
      allowShort: draft.allowShort,
    },
    isResearchVariant: validation.isResearchVariant,
  }
}
