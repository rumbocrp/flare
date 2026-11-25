import { memo, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react'
import type {
  SpotSignalEngine,
  StrategyPreset,
  StrategyPresetPatch,
} from '@/botEngine'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { BITCOIN_20_PREDICTIONS } from '@/predictions'
import { availablePairs } from '@/strategy'
import {
  bestParamsToPresetPatch,
  buildPromotionPlan,
  computePresetCatalogDiff,
  type ClampedFieldNotice,
} from '@/training/shadowAndCustomize'
import type { TrainingCatalogItem, TrainingRunRecord } from '@/training/types'
import type { Interval } from '@/types'

const MAX_PROFILES = 24
const INTERVALS: readonly Interval[] = ['5m', '15m', '1h', '4h', '1d']
const SPOT_ENGINES: readonly SpotSignalEngine[] = [
  'momentum-structure',
  'crossover',
  'rsi-reversion',
  'donchian-breakout',
  'support-resistance',
  'break-of-structure',
]

type CustomizePanelProps = {
  selectedItem: TrainingCatalogItem
  draftPreset: StrategyPreset
  catalogBase: StrategyPreset
  clamps: readonly ClampedFieldNotice[]
  isResearchVariant: boolean
  backendOffline: boolean
  customProfileCount: number
  activeRun: TrainingRunRecord | null
  onPatchPreset: (patch: StrategyPresetPatch) => void
  onResetToCatalog: () => void
  onSaveProfile: (name: string) => void
  onDuplicateProfile: (name: string) => void
  onDeleteProfile: (profileId: string) => void
  onPromote: () => Promise<{ ok: boolean; message: string }>
}

type NumericInputProps = {
  id: string
  label: string
  value: number
  step?: number
  clampedNotice?: ClampedFieldNotice
  clampText?: string
  onCommit: (nextValue: number) => void
}

function NumericParamField({
  id,
  label,
  value,
  step = 1,
  clampedNotice,
  clampText,
  onCommit,
}: NumericInputProps) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-[11px] text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => {
          const parsed = Number(e.target.value)
          if (Number.isFinite(parsed)) {
            onCommit(parsed)
          }
        }}
        className="h-8 font-mono text-xs tabular-nums"
      />
      {clampedNotice && clampText && (
        <span
          role="status"
          className="font-mono text-[10.5px] text-[var(--warning)] tabular-nums"
        >
          {clampText}
        </span>
      )}
    </div>
  )
}

function CustomizePanelInner({
  selectedItem,
  draftPreset,
  catalogBase,
  clamps,
  isResearchVariant,
  backendOffline,
  customProfileCount,
  activeRun,
  onPatchPreset,
  onResetToCatalog,
  onSaveProfile,
  onDuplicateProfile,
  onDeleteProfile,
  onPromote,
}: CustomizePanelProps) {
  const { t } = useI18n()
  const [profileName, setProfileName] = useState(draftPreset.name)
  const [trackedItemId, setTrackedItemId] = useState(selectedItem.id)
  const [promoteDialogOpen, setPromoteDialogOpen] = useState(false)
  const [promoting, setPromoting] = useState(false)
  const [feedback, setFeedback] = useState<{
    tone: 'positive' | 'negative'
    message: string
  } | null>(null)

  if (trackedItemId !== selectedItem.id) {
    setTrackedItemId(selectedItem.id)
    setProfileName(draftPreset.name)
    setFeedback(null)
  }

  const clampByField = useMemo(() => {
    const map = new Map<string, ClampedFieldNotice>()
    for (const c of clamps) {
      map.set(c.field, c)
    }
    return map
  }, [clamps])

  const diffs = useMemo(
    () => computePresetCatalogDiff(catalogBase, draftPreset),
    [catalogBase, draftPreset],
  )

  const promotionPlan = useMemo(
    () => buildPromotionPlan(selectedItem, draftPreset, isResearchVariant),
    [selectedItem, draftPreset, isResearchVariant],
  )

  const renderClampHint = (field: string) => {
    const notice = clampByField.get(field)
    if (!notice) return undefined
    return t('training.customClampedHint', {
      from: notice.requested,
      to: notice.clamped,
    })
  }

  const isPrediction = draftPreset.domain === 'prediction-market'
  const filters = draftPreset.filters ?? {}
  const activeEngine: SpotSignalEngine =
    filters.signalEngine ?? 'momentum-structure'

  const hasWinningParams = Boolean(
    activeRun?.status === 'completed' &&
      activeRun.presetId === selectedItem.presetId &&
      activeRun.metrics?.bestSelectedParams &&
      Object.keys(activeRun.metrics.bestSelectedParams).length > 0,
  )

  const handleApplyWinningParams = () => {
    const best = activeRun?.metrics?.bestSelectedParams
    if (!best) return
    const patch = bestParamsToPresetPatch(catalogBase, best)
    onPatchPreset(patch)
    setFeedback({
      tone: 'positive',
      message: t('training.customLoadedWinning'),
    })
  }

  const handleSave = () => {
    const cleaned = profileName.trim() || draftPreset.name
    onSaveProfile(cleaned)
    setFeedback({
      tone: 'positive',
      message: t('training.customProfileSaved', { name: cleaned }),
    })
  }

  const handleDuplicate = () => {
    const base = profileName.trim() || draftPreset.name
    const dupName = `${base} Copy`
    setProfileName(dupName)
    onDuplicateProfile(dupName)
    setFeedback({
      tone: 'positive',
      message: t('training.customProfileDuplicated', { name: dupName }),
    })
  }

  const handleDelete = () => {
    if (selectedItem.kind !== 'custom-profile') return
    onDeleteProfile(selectedItem.id)
    setFeedback({
      tone: 'positive',
      message: t('training.customProfileDeleted'),
    })
  }

  const handleConfirmPromote = async () => {
    setPromoting(true)
    setFeedback(null)
    try {
      const res = await onPromote()
      setFeedback({
        tone: res.ok ? 'positive' : 'negative',
        message: res.message,
      })
    } finally {
      setPromoting(false)
      setPromoteDialogOpen(false)
    }
  }

  const promoteDisabled =
    !promotionPlan.allowed || backendOffline || promoting

  return (
    <div className="flex flex-col gap-4">
      {/* Action Header & Profile Bar */}
      <section
        aria-label={t('training.customTitle')}
        className="flex flex-col gap-3 rounded-md bg-card p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">
              {t('training.customTitle')}
            </h2>
            <Badge variant="outline" className="font-mono text-[10.5px]">
              {draftPreset.domain}
            </Badge>
            <Badge variant="secondary" className="font-mono text-[10.5px]">
              {t('training.customProfileCapacity', {
                count: customProfileCount,
                max: MAX_PROFILES,
              })}
            </Badge>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {hasWinningParams && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleApplyWinningParams}
                className="h-8 gap-1.5 text-xs"
              >
                <Sparkles className="size-3.5" />
                <span>{t('training.customApplyWinning')}</span>
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                onResetToCatalog()
                setProfileName(catalogBase.name)
                setFeedback({
                  tone: 'positive',
                  message: t('training.customResetDone'),
                })
              }}
              className="h-8 gap-1.5 text-xs"
            >
              <RotateCcw className="size-3.5" />
              <span>{t('training.customReset')}</span>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={promoteDisabled}
              onClick={() => setPromoteDialogOpen(true)}
              className="h-8 gap-1.5 text-xs"
            >
              <Upload className="size-3.5" />
              <span>
                {promoting
                  ? t('training.customPromoting')
                  : t('training.customPromote')}
              </span>
            </Button>
          </div>
        </div>

        {/* Profile name + Save / Duplicate / Delete */}
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-[200px] flex-1 flex-col gap-1">
            <Label
              htmlFor="custom-profile-name"
              className="text-[11px] text-muted-foreground"
            >
              {t('training.customProfileName')}
            </Label>
            <Input
              id="custom-profile-name"
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              placeholder={draftPreset.name}
              className="h-8 text-xs"
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleSave}
            className="h-8 gap-1.5 text-xs"
          >
            <Save className="size-3.5" />
            <span>{t('training.customSaveProfile')}</span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={customProfileCount >= MAX_PROFILES}
            onClick={handleDuplicate}
            className="h-8 gap-1.5 text-xs"
          >
            <Copy className="size-3.5" />
            <span>{t('training.customDuplicate')}</span>
          </Button>
          {selectedItem.kind === 'custom-profile' && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleDelete}
              className="h-8 gap-1.5 text-xs text-[var(--negative)]"
            >
              <Trash2 className="size-3.5" />
              <span>{t('training.customDelete')}</span>
            </Button>
          )}
        </div>

        {/* Promote Disabled Reason Notice */}
        {isResearchVariant && (
          <div
            role="note"
            className="flex items-start gap-2 rounded-sm bg-[var(--warning-soft)] px-3 py-2 text-xs text-[var(--warning)]"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{t('training.customPromoteBlockedResearch')}</span>
          </div>
        )}

        {backendOffline && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-sm bg-[var(--negative-soft)] px-3 py-2 text-xs text-[var(--negative)]"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{t('training.customPromoteBlockedOffline')}</span>
          </div>
        )}

        {feedback && (
          <div
            role={feedback.tone === 'negative' ? 'alert' : 'status'}
            className={cn(
              'flex items-center gap-2 rounded-sm px-3 py-2 text-xs',
              feedback.tone === 'positive'
                ? 'bg-[var(--positive-soft)] text-[var(--positive)]'
                : 'bg-[var(--negative-soft)] text-[var(--negative)]',
            )}
          >
            {feedback.tone === 'positive' ? (
              <CheckCircle2 className="size-3.5 shrink-0" />
            ) : (
              <AlertTriangle className="size-3.5 shrink-0" />
            )}
            <span>{feedback.message}</span>
          </div>
        )}
      </section>

      {/* 4 Parameter Groups Grid: Engine, Signal Filters, Risk, Execution */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Group 1: Engine */}
        <section
          aria-label={t('training.customGroupEngine')}
          className="flex flex-col gap-3 rounded-md bg-card p-4"
        >
          <h3 className="text-xs font-semibold text-foreground">
            {t('training.customGroupEngine')}
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label
                htmlFor="custom-pair"
                className="text-[11px] text-muted-foreground"
              >
                {t('training.fieldPair')}
              </Label>
              <Select
                value={draftPreset.strategy.pair}
                onValueChange={(pair) =>
                  onPatchPreset({ strategy: { pair } })
                }
              >
                <SelectTrigger id="custom-pair" className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availablePairs.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <Label
                htmlFor="custom-timeframe"
                className="text-[11px] text-muted-foreground"
              >
                {t('training.fieldTimeframe')}
              </Label>
              <Select
                value={draftPreset.timeframe}
                onValueChange={(tf) =>
                  onPatchPreset({ timeframe: tf as Interval })
                }
              >
                <SelectTrigger id="custom-timeframe" className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERVALS.map((tf) => (
                    <SelectItem key={tf} value={tf}>
                      {tf}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {isPrediction ? (
              <div className="flex flex-col gap-1 sm:col-span-2">
                <Label
                  htmlFor="custom-pred-rule"
                  className="text-[11px] text-muted-foreground"
                >
                  {t('training.colRule')}
                </Label>
                <Select
                  value={
                    draftPreset.predictionRuleId ??
                    BITCOIN_20_PREDICTIONS[0]?.id ??
                    ''
                  }
                  onValueChange={(ruleId) =>
                    onPatchPreset({ predictionRuleId: ruleId })
                  }
                >
                  <SelectTrigger id="custom-pred-rule" className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BITCOIN_20_PREDICTIONS.map((rule) => (
                      <SelectItem key={rule.id} value={rule.id}>
                        {rule.title} ({rule.timeframe})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-1 sm:col-span-2">
                  <Label
                    htmlFor="custom-engine"
                    className="text-[11px] text-muted-foreground"
                  >
                    {t('training.customFieldSignalEngine')}
                  </Label>
                  <Select
                    value={activeEngine}
                    onValueChange={(engine) =>
                      onPatchPreset({
                        filters: { signalEngine: engine as SpotSignalEngine },
                      })
                    }
                  >
                    <SelectTrigger id="custom-engine" className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SPOT_ENGINES.map((eng) => (
                        <SelectItem key={eng} value={eng}>
                          {eng}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <NumericParamField
                  id="custom-fast-period"
                  label={t('training.customFieldFastPeriod')}
                  value={draftPreset.signalParams.fastPeriod}
                  step={1}
                  clampedNotice={clampByField.get('signalParams.fastPeriod')}
                  clampText={renderClampHint('signalParams.fastPeriod')}
                  onCommit={(v) =>
                    onPatchPreset({ signalParams: { fastPeriod: v } })
                  }
                />

                <NumericParamField
                  id="custom-slow-period"
                  label={t('training.customFieldSlowPeriod')}
                  value={draftPreset.signalParams.slowPeriod}
                  step={1}
                  clampedNotice={clampByField.get('signalParams.slowPeriod')}
                  clampText={renderClampHint('signalParams.slowPeriod')}
                  onCommit={(v) =>
                    onPatchPreset({ signalParams: { slowPeriod: v } })
                  }
                />

                <div className="flex flex-col gap-1 sm:col-span-2">
                  <Label
                    htmlFor="custom-ma-type"
                    className="text-[11px] text-muted-foreground"
                  >
                    {t('training.customFieldMaType')}
                  </Label>
                  <Select
                    value={draftPreset.signalParams.average}
                    onValueChange={(avg) =>
                      onPatchPreset({
                        signalParams: { average: avg as 'ema' | 'sma' },
                      })
                    }
                  >
                    <SelectTrigger id="custom-ma-type" className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ema">EMA</SelectItem>
                      <SelectItem value="sma">SMA</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
          </div>
        </section>

        {/* Group 2: Signal Filters */}
        <section
          aria-label={t('training.customGroupFilters')}
          className="flex flex-col gap-3 rounded-md bg-card p-4"
        >
          <h3 className="text-xs font-semibold text-foreground">
            {t('training.customGroupFilters')}
          </h3>

          {isPrediction ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <NumericParamField
                id="custom-min-edge"
                label={t('training.customFieldMinEdge')}
                value={draftPreset.minEdgePct ?? 15}
                step={0.5}
                clampedNotice={clampByField.get('minEdgePct')}
                clampText={renderClampHint('minEdgePct')}
                onCommit={(v) => onPatchPreset({ minEdgePct: v })}
              />
              <NumericParamField
                id="custom-min-triggers"
                label={t('training.customFieldMinTriggers')}
                value={draftPreset.minTriggers ?? 5}
                step={1}
                clampedNotice={clampByField.get('minTriggers')}
                clampText={renderClampHint('minTriggers')}
                onCommit={(v) => onPatchPreset({ minTriggers: v })}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {(activeEngine === 'momentum-structure' ||
                  activeEngine === 'crossover') && (
                  <>
                    <NumericParamField
                      id="custom-max-buy-rsi"
                      label="maxBuyRsi"
                      value={filters.maxBuyRsi ?? 68}
                      step={1}
                      clampedNotice={clampByField.get('filters.maxBuyRsi')}
                      clampText={renderClampHint('filters.maxBuyRsi')}
                      onCommit={(v) =>
                        onPatchPreset({ filters: { maxBuyRsi: v } })
                      }
                    />
                    <NumericParamField
                      id="custom-min-sell-rsi"
                      label="minSellRsi"
                      value={filters.minSellRsi ?? 32}
                      step={1}
                      clampedNotice={clampByField.get('filters.minSellRsi')}
                      clampText={renderClampHint('filters.minSellRsi')}
                      onCommit={(v) =>
                        onPatchPreset({ filters: { minSellRsi: v } })
                      }
                    />
                  </>
                )}

                {activeEngine === 'rsi-reversion' && (
                  <>
                    <NumericParamField
                      id="custom-oversold-rsi"
                      label="oversoldRsi"
                      value={filters.oversoldRsi ?? 30}
                      step={1}
                      clampedNotice={clampByField.get('filters.oversoldRsi')}
                      clampText={renderClampHint('filters.oversoldRsi')}
                      onCommit={(v) =>
                        onPatchPreset({ filters: { oversoldRsi: v } })
                      }
                    />
                    <NumericParamField
                      id="custom-overbought-rsi"
                      label="overboughtRsi"
                      value={filters.overboughtRsi ?? 70}
                      step={1}
                      clampedNotice={clampByField.get('filters.overboughtRsi')}
                      clampText={renderClampHint('filters.overboughtRsi')}
                      onCommit={(v) =>
                        onPatchPreset({ filters: { overboughtRsi: v } })
                      }
                    />
                  </>
                )}

                {activeEngine === 'donchian-breakout' && (
                  <>
                    <NumericParamField
                      id="custom-channel-period"
                      label="channelPeriod"
                      value={filters.channelPeriod ?? 20}
                      step={1}
                      clampedNotice={clampByField.get('filters.channelPeriod')}
                      clampText={renderClampHint('filters.channelPeriod')}
                      onCommit={(v) =>
                        onPatchPreset({ filters: { channelPeriod: v } })
                      }
                    />
                    <NumericParamField
                      id="custom-exit-period"
                      label="exitPeriod"
                      value={filters.exitPeriod ?? 10}
                      step={1}
                      clampedNotice={clampByField.get('filters.exitPeriod')}
                      clampText={renderClampHint('filters.exitPeriod')}
                      onCommit={(v) =>
                        onPatchPreset({ filters: { exitPeriod: v } })
                      }
                    />
                    <NumericParamField
                      id="custom-atr-stop"
                      label="atrStopMult"
                      value={filters.atrStopMult ?? 2}
                      step={0.1}
                      clampedNotice={clampByField.get('filters.atrStopMult')}
                      clampText={renderClampHint('filters.atrStopMult')}
                      onCommit={(v) =>
                        onPatchPreset({ filters: { atrStopMult: v } })
                      }
                    />
                    <NumericParamField
                      id="custom-min-atr-pct"
                      label="minAtrPct (%)"
                      value={filters.minAtrPct ?? 0.15}
                      step={0.05}
                      clampedNotice={clampByField.get('filters.minAtrPct')}
                      clampText={renderClampHint('filters.minAtrPct')}
                      onCommit={(v) =>
                        onPatchPreset({ filters: { minAtrPct: v } })
                      }
                    />
                    <div className="flex flex-col gap-1 sm:col-span-2">
                      <Label
                        htmlFor="custom-trend-filter"
                        className="text-[11px] text-muted-foreground"
                      >
                        trendFilter
                      </Label>
                      <Select
                        value={filters.trendFilter ?? 'ema200'}
                        onValueChange={(tf) =>
                          onPatchPreset({
                            filters: { trendFilter: tf as 'ema200' | 'none' },
                          })
                        }
                      >
                        <SelectTrigger
                          id="custom-trend-filter"
                          className="h-8 text-xs"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ema200">EMA 200</SelectItem>
                          <SelectItem value="none">None</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                )}

                {activeEngine === 'support-resistance' && (
                  <>
                    <NumericParamField
                      id="custom-pivot-lookback"
                      label="pivotLookback"
                      value={filters.pivotLookback ?? 2}
                      step={1}
                      clampedNotice={clampByField.get('filters.pivotLookback')}
                      clampText={renderClampHint('filters.pivotLookback')}
                      onCommit={(v) =>
                        onPatchPreset({ filters: { pivotLookback: v } })
                      }
                    />
                    <NumericParamField
                      id="custom-cluster-atr"
                      label="clusterAtrMult"
                      value={filters.clusterAtrMult ?? 0.35}
                      step={0.05}
                      clampedNotice={clampByField.get('filters.clusterAtrMult')}
                      clampText={renderClampHint('filters.clusterAtrMult')}
                      onCommit={(v) =>
                        onPatchPreset({ filters: { clusterAtrMult: v } })
                      }
                    />
                    <NumericParamField
                      id="custom-min-touches"
                      label="minTouches"
                      value={filters.minTouches ?? 2}
                      step={1}
                      clampedNotice={clampByField.get('filters.minTouches')}
                      clampText={renderClampHint('filters.minTouches')}
                      onCommit={(v) =>
                        onPatchPreset({ filters: { minTouches: v } })
                      }
                    />
                    <NumericParamField
                      id="custom-touch-tol"
                      label="touchToleranceAtr"
                      value={filters.touchToleranceAtr ?? 0.25}
                      step={0.05}
                      clampedNotice={clampByField.get(
                        'filters.touchToleranceAtr',
                      )}
                      clampText={renderClampHint('filters.touchToleranceAtr')}
                      onCommit={(v) =>
                        onPatchPreset({ filters: { touchToleranceAtr: v } })
                      }
                    />
                    <NumericParamField
                      id="custom-sr-atr-stop"
                      label="atrStopMult"
                      value={filters.atrStopMult ?? 1.0}
                      step={0.1}
                      clampedNotice={clampByField.get('filters.atrStopMult')}
                      clampText={renderClampHint('filters.atrStopMult')}
                      onCommit={(v) =>
                        onPatchPreset({ filters: { atrStopMult: v } })
                      }
                    />
                    <NumericParamField
                      id="custom-min-long-rsi"
                      label="minLongRsi"
                      value={filters.minLongRsi ?? 40}
                      step={1}
                      clampedNotice={clampByField.get('filters.minLongRsi')}
                      clampText={renderClampHint('filters.minLongRsi')}
                      onCommit={(v) =>
                        onPatchPreset({ filters: { minLongRsi: v } })
                      }
                    />
                  </>
                )}

                {activeEngine === 'break-of-structure' && (
                  <>
                    <NumericParamField
                      id="custom-swing-lookback"
                      label="swingLookback"
                      value={filters.swingLookback ?? 2}
                      step={1}
                      clampedNotice={clampByField.get('filters.swingLookback')}
                      clampText={renderClampHint('filters.swingLookback')}
                      onCommit={(v) =>
                        onPatchPreset({ filters: { swingLookback: v } })
                      }
                    />
                    <NumericParamField
                      id="custom-retest-window"
                      label="retestWindowBars"
                      value={filters.retestWindowBars ?? 3}
                      step={1}
                      clampedNotice={clampByField.get(
                        'filters.retestWindowBars',
                      )}
                      clampText={renderClampHint('filters.retestWindowBars')}
                      onCommit={(v) =>
                        onPatchPreset({ filters: { retestWindowBars: v } })
                      }
                    />
                    <NumericParamField
                      id="custom-retest-tol"
                      label="retestToleranceAtr"
                      value={filters.retestToleranceAtr ?? 0.5}
                      step={0.05}
                      clampedNotice={clampByField.get(
                        'filters.retestToleranceAtr',
                      )}
                      clampText={renderClampHint('filters.retestToleranceAtr')}
                      onCommit={(v) =>
                        onPatchPreset({ filters: { retestToleranceAtr: v } })
                      }
                    />
                    <NumericParamField
                      id="custom-stop-buffer"
                      label="stopBufferAtr"
                      value={filters.stopBufferAtr ?? 0.25}
                      step={0.05}
                      clampedNotice={clampByField.get('filters.stopBufferAtr')}
                      clampText={renderClampHint('filters.stopBufferAtr')}
                      onCommit={(v) =>
                        onPatchPreset({ filters: { stopBufferAtr: v } })
                      }
                    />
                    <NumericParamField
                      id="custom-target-r"
                      label="targetRMultiple"
                      value={filters.targetRMultiple ?? 2.0}
                      step={0.1}
                      clampedNotice={clampByField.get(
                        'filters.targetRMultiple',
                      )}
                      clampText={renderClampHint('filters.targetRMultiple')}
                      onCommit={(v) =>
                        onPatchPreset({ filters: { targetRMultiple: v } })
                      }
                    />
                    <div className="flex items-center justify-between gap-2 rounded-sm bg-muted/25 px-3 py-2">
                      <Label
                        htmlFor="custom-require-retest"
                        className="text-xs text-foreground"
                      >
                        requireRetest
                      </Label>
                      <Switch
                        id="custom-require-retest"
                        checked={Boolean(filters.requireRetest)}
                        onCheckedChange={(checked) =>
                          onPatchPreset({ filters: { requireRetest: checked } })
                        }
                      />
                    </div>
                  </>
                )}
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {(activeEngine === 'momentum-structure' ||
                  activeEngine === 'crossover') && (
                  <div className="flex items-center justify-between gap-2 rounded-sm bg-muted/25 px-3 py-2">
                    <Label
                      htmlFor="custom-avoid-rsi"
                      className="text-xs text-foreground"
                    >
                      avoidRsiExtremes
                    </Label>
                    <Switch
                      id="custom-avoid-rsi"
                      checked={filters.avoidRsiExtremes ?? true}
                      onCheckedChange={(checked) =>
                        onPatchPreset({
                          filters: { avoidRsiExtremes: checked },
                        })
                      }
                    />
                  </div>
                )}

                {(activeEngine === 'momentum-structure' ||
                  activeEngine === 'crossover' ||
                  activeEngine === 'rsi-reversion') && (
                  <div className="flex items-center justify-between gap-2 rounded-sm bg-muted/25 px-3 py-2">
                    <Label
                      htmlFor="custom-ema50"
                      className="text-xs text-foreground"
                    >
                      EMA 50 alignment
                    </Label>
                    <Switch
                      id="custom-ema50"
                      checked={Boolean(filters.requireEma50Alignment)}
                      onCheckedChange={(checked) =>
                        onPatchPreset({
                          filters: { requireEma50Alignment: checked },
                        })
                      }
                    />
                  </div>
                )}

                <div className="flex items-center justify-between gap-2 rounded-sm bg-muted/25 px-3 py-2">
                  <Label
                    htmlFor="custom-breakeven"
                    className="text-xs text-foreground"
                  >
                    breakevenAtOneR
                  </Label>
                  <Switch
                    id="custom-breakeven"
                    checked={filters.breakevenAtOneR ?? true}
                    onCheckedChange={(checked) =>
                      onPatchPreset({ filters: { breakevenAtOneR: checked } })
                    }
                  />
                </div>

                <div className="flex items-center justify-between gap-2 rounded-sm bg-muted/25 px-3 py-2">
                  <Label
                    htmlFor="custom-flip"
                    className="text-xs text-foreground"
                  >
                    flipOnOppositeSignal
                  </Label>
                  <Switch
                    id="custom-flip"
                    checked={Boolean(filters.flipOnOppositeSignal)}
                    onCheckedChange={(checked) =>
                      onPatchPreset({
                        filters: { flipOnOppositeSignal: checked },
                      })
                    }
                  />
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Group 3: Risk */}
        <section
          aria-label={t('training.customGroupRisk')}
          className="flex flex-col gap-3 rounded-md bg-card p-4"
        >
          <h3 className="text-xs font-semibold text-foreground">
            {t('training.customGroupRisk')}
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <NumericParamField
              id="custom-pos-size"
              label={t('training.customFieldPositionSize')}
              value={draftPreset.strategy.positionSize}
              step={1}
              clampedNotice={clampByField.get('strategy.positionSize')}
              clampText={renderClampHint('strategy.positionSize')}
              onCommit={(v) =>
                onPatchPreset({ strategy: { positionSize: v } })
              }
            />
            <NumericParamField
              id="custom-stop-loss"
              label={t('training.customFieldStopLoss')}
              value={draftPreset.strategy.stopLoss}
              step={0.1}
              clampedNotice={clampByField.get('strategy.stopLoss')}
              clampText={renderClampHint('strategy.stopLoss')}
              onCommit={(v) => onPatchPreset({ strategy: { stopLoss: v } })}
            />
            <NumericParamField
              id="custom-take-profit"
              label={t('training.customFieldTakeProfit')}
              value={draftPreset.strategy.takeProfit}
              step={0.1}
              clampedNotice={clampByField.get('strategy.takeProfit')}
              clampText={renderClampHint('strategy.takeProfit')}
              onCommit={(v) => onPatchPreset({ strategy: { takeProfit: v } })}
            />
            <NumericParamField
              id="custom-daily-risk"
              label={t('training.customFieldMaxDailyRisk')}
              value={draftPreset.strategy.maxDailyRisk}
              step={0.5}
              clampedNotice={clampByField.get('strategy.maxDailyRisk')}
              clampText={renderClampHint('strategy.maxDailyRisk')}
              onCommit={(v) =>
                onPatchPreset({ strategy: { maxDailyRisk: v } })
              }
            />
            {isPrediction && (
              <div className="flex items-center justify-between gap-2 rounded-sm bg-muted/25 px-3 py-2 sm:col-span-2">
                <Label
                  htmlFor="custom-quarter-kelly"
                  className="text-xs text-foreground"
                >
                  {t('training.customFieldQuarterKelly')}
                </Label>
                <Switch
                  id="custom-quarter-kelly"
                  checked={draftPreset.useQuarterKelly ?? true}
                  onCheckedChange={(checked) =>
                    onPatchPreset({ useQuarterKelly: checked })
                  }
                />
              </div>
            )}
          </div>
        </section>

        {/* Group 4: Execution */}
        <section
          aria-label={t('training.customGroupExecution')}
          className="flex flex-col gap-3 rounded-md bg-card p-4"
        >
          <h3 className="text-xs font-semibold text-foreground">
            {t('training.customGroupExecution')}
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <NumericParamField
              id="custom-balance"
              label={t('training.fieldBalance')}
              value={draftPreset.execution.initialBalance}
              step={500}
              clampedNotice={clampByField.get('execution.initialBalance')}
              clampText={renderClampHint('execution.initialBalance')}
              onCommit={(v) =>
                onPatchPreset({ execution: { initialBalance: v } })
              }
            />
            <NumericParamField
              id="custom-fee"
              label={t('training.fieldFeePct')}
              value={draftPreset.execution.commissionPct}
              step={0.01}
              clampedNotice={clampByField.get('execution.commissionPct')}
              clampText={renderClampHint('execution.commissionPct')}
              onCommit={(v) =>
                onPatchPreset({ execution: { commissionPct: v } })
              }
            />
            <NumericParamField
              id="custom-slippage"
              label={t('training.fieldSlippagePct')}
              value={draftPreset.execution.slippagePct}
              step={0.01}
              clampedNotice={clampByField.get('execution.slippagePct')}
              clampText={renderClampHint('execution.slippagePct')}
              onCommit={(v) =>
                onPatchPreset({ execution: { slippagePct: v } })
              }
            />
            <div className="flex items-center justify-between gap-2 rounded-sm bg-muted/25 px-3 py-2">
              <Label
                htmlFor="custom-allow-short"
                className="text-xs text-foreground"
              >
                {t('training.fieldAllowShort')}
              </Label>
              <Switch
                id="custom-allow-short"
                checked={draftPreset.execution.allowShort}
                onCheckedChange={(checked) =>
                  onPatchPreset({ execution: { allowShort: checked } })
                }
              />
            </div>
          </div>
        </section>
      </div>

      {/* Live Diff Against Catalog Preset */}
      <section
        aria-label={t('training.customDiffTitle')}
        className="flex flex-col gap-3 rounded-md bg-card p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-foreground">
            {t('training.customDiffTitle')}
          </h3>
          <Badge variant={diffs.length > 0 ? 'violet' : 'secondary'}>
            {diffs.length > 0
              ? t('training.customDiffCount', { count: diffs.length })
              : t('training.customDiffNoneShort')}
          </Badge>
        </div>

        {diffs.length === 0 ? (
          <p className="rounded-sm bg-muted/20 px-4 py-4 text-xs text-[var(--text-subtle)]">
            {t('training.customDiffEmpty')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t('training.customColGroup')}</TableHead>
                  <TableHead scope="col">{t('training.colParam')}</TableHead>
                  <TableHead scope="col" className="text-right">
                    {t('training.colCatalogDefault')}
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    {t('training.customColCurrent')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {diffs.map((d) => (
                  <TableRow key={d.field}>
                    <TableCell className="font-mono text-[11px] uppercase text-muted-foreground">
                      {d.group}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-foreground">
                      {d.field}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-[var(--text-subtle)] tabular-nums">
                      {String(d.catalogValue)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs font-semibold text-primary tabular-nums">
                      {String(d.currentValue)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {/* Accessible Promotion Confirmation Dialog */}
      <AlertDialog open={promoteDialogOpen} onOpenChange={setPromoteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('training.customPromoteDialogTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('training.customPromoteDialogDesc', {
                name: draftPreset.name,
                pair: draftPreset.strategy.pair,
                tf: draftPreset.timeframe,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="flex flex-col gap-2 rounded-sm bg-muted/25 p-3 text-xs">
            <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
              <span className="text-muted-foreground">
                {t('training.customPromoteModeLabel')}
              </span>
              <Badge variant="outline">
                {promotionPlan.allowed && promotionPlan.mode === 'catalog'
                  ? t('training.customPromoteModeCatalog')
                  : t('training.customPromoteModeCustom')}
              </Badge>
            </div>
            {diffs.length > 0 ? (
              <ul className="flex max-h-36 flex-col gap-1 overflow-y-auto font-mono text-[11px] tabular-nums">
                {diffs.map((d) => (
                  <li
                    key={d.field}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="truncate text-muted-foreground">
                      {d.field}
                    </span>
                    <span className="shrink-0 text-foreground">
                      {String(d.catalogValue)} →{' '}
                      <strong className="text-primary">
                        {String(d.currentValue)}
                      </strong>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11px] text-[var(--text-subtle)]">
                {t('training.customDiffEmpty')}
              </p>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={promoting}>
              {t('training.cancelRun')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="default"
              disabled={promoting}
              onClick={(e) => {
                e.preventDefault()
                void handleConfirmPromote()
              }}
            >
              {promoting
                ? t('training.customPromoting')
                : t('training.customPromoteConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

const CustomizePanel = memo(CustomizePanelInner)
export default CustomizePanel
