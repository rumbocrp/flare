import { memo } from 'react'
import { AlertTriangle, FlaskConical, Play } from 'lucide-react'
import { formatDurationMs } from '@/botRunUtils'
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
import { useI18n } from '@/i18n'
import { availablePairs } from '@/strategy'
import {
  MAX_TRAINING_HISTORY_BARS,
  toUtcDateInput,
  type DateRangePreset,
  type TrainingFormDraft,
  type TrainingFormValidation,
} from '@/training/formDraft'
import type { TrainingCatalogItem, TrainingRunKind } from '@/training/types'
import type { Interval } from '@/types'

const INTERVALS: readonly Interval[] = ['5m', '15m', '1h', '4h', '1d']
const FOLD_OPTIONS = [3, 5, 8] as const
const DAY_MS = 86_400_000

type RunConfigProps = {
  selectedItem: TrainingCatalogItem
  draft: TrainingFormDraft
  validation: TrainingFormValidation
  backendOffline: boolean
  isRunning: boolean
  nowMs: number
  onChangeDraft: (updater: (prev: TrainingFormDraft) => TrainingFormDraft) => void
  onStartRun: () => void
}

function RunConfigInner({
  selectedItem,
  draft,
  validation,
  backendOffline,
  isRunning,
  nowMs,
  onChangeDraft,
  onStartRun,
}: RunConfigProps) {
  const { t } = useI18n()
  const isPrediction = selectedItem.preset.domain === 'prediction-market'

  const handleSelectRangePreset = (preset: DateRangePreset) => {
    if (preset === 'custom') {
      onChangeDraft((prev) => ({ ...prev, rangePreset: 'custom' }))
      return
    }
    const days =
      preset === '30d' ? 30 : preset === '90d' ? 90 : preset === '180d' ? 180 : 365
    onChangeDraft((prev) => ({
      ...prev,
      rangePreset: preset,
      fromDate: toUtcDateInput(nowMs - days * DAY_MS),
      toDate: toUtcDateInput(nowMs),
    }))
  }

  return (
    <section
      aria-label={t('training.configTitle')}
      className="rounded-md bg-card p-4"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">
            {t('training.configTitle')}
          </h2>
          {validation.isResearchVariant && (
            <Badge variant="violet">
              <FlaskConical className="size-3" />
              <span>{t('training.researchVariantBadge')}</span>
            </Badge>
          )}
        </div>

        <Button
          type="button"
          size="sm"
          variant="default"
          disabled={!validation.valid || backendOffline || isRunning}
          onClick={onStartRun}
          className="h-8 gap-1.5 px-3 text-xs"
        >
          <Play className="size-3.5" />
          <span>
            {isRunning ? t('training.runningCta') : t('training.runTraining')}
          </span>
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Run kind */}
        <div className="flex flex-col gap-1">
          <Label htmlFor="training-kind" className="text-[11px] text-muted-foreground">
            {t('training.fieldKind')}
          </Label>
          <Select
            value={draft.kind}
            onValueChange={(val) =>
              onChangeDraft((prev) => ({
                ...prev,
                kind: val as TrainingRunKind,
              }))
            }
          >
            <SelectTrigger id="training-kind" className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {isPrediction ? (
                <SelectItem value="prediction-market">
                  {t('training.kindPrediction')}
                </SelectItem>
              ) : (
                <>
                  <SelectItem value="walk-forward">
                    {t('training.kindWalkForward')}
                  </SelectItem>
                  <SelectItem value="meta-filter">
                    {t('training.kindMetaFilter')}
                  </SelectItem>
                </>
              )}
            </SelectContent>
          </Select>
        </div>

        {/* Pair */}
        <div className="flex flex-col gap-1">
          <Label htmlFor="training-pair" className="text-[11px] text-muted-foreground">
            {t('training.fieldPair')}
          </Label>
          <Select
            value={draft.pair}
            onValueChange={(val) =>
              onChangeDraft((prev) => ({ ...prev, pair: val }))
            }
          >
            <SelectTrigger id="training-pair" className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availablePairs.map((pair) => (
                <SelectItem key={pair} value={pair}>
                  {pair}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Timeframe */}
        <div className="flex flex-col gap-1">
          <Label htmlFor="training-tf" className="text-[11px] text-muted-foreground">
            {t('training.fieldTimeframe')}
          </Label>
          <Select
            value={draft.timeframe}
            onValueChange={(val) =>
              onChangeDraft((prev) => ({
                ...prev,
                timeframe: val as Interval,
              }))
            }
          >
            <SelectTrigger id="training-tf" className="h-8 text-xs">
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

        {/* Date range preset */}
        <div className="flex flex-col gap-1">
          <Label className="text-[11px] text-muted-foreground">
            {t('training.fieldRange')}
          </Label>
          <div className="flex flex-wrap gap-1">
            {(['30d', '90d', '180d', '365d', 'custom'] as const).map((p) => (
              <Button
                key={p}
                type="button"
                size="sm"
                variant={draft.rangePreset === p ? 'default' : 'outline'}
                className="h-8 px-2 font-mono text-[11px]"
                onClick={() => handleSelectRangePreset(p)}
              >
                {p === 'custom' ? t('training.rangeCustom') : p}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {draft.rangePreset === 'custom' && (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="training-from" className="text-[11px] text-muted-foreground">
              {t('training.fieldFromDate')}
            </Label>
            <Input
              id="training-from"
              type="date"
              value={draft.fromDate}
              onChange={(e) =>
                onChangeDraft((prev) => ({ ...prev, fromDate: e.target.value }))
              }
              className="h-8 font-mono text-xs tabular-nums"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="training-to" className="text-[11px] text-muted-foreground">
              {t('training.fieldToDate')}
            </Label>
            <Input
              id="training-to"
              type="date"
              value={draft.toDate}
              onChange={(e) =>
                onChangeDraft((prev) => ({ ...prev, toDate: e.target.value }))
              }
              className="h-8 font-mono text-xs tabular-nums"
            />
          </div>
        </div>
      )}

      {/* Walk-forward / split / execution assumptions */}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <div className="flex flex-col gap-1">
          <Label htmlFor="training-folds" className="text-[11px] text-muted-foreground">
            {t('training.fieldFolds')}
          </Label>
          <Select
            value={String(draft.foldCount)}
            onValueChange={(val) =>
              onChangeDraft((prev) => ({ ...prev, foldCount: Number(val) }))
            }
          >
            <SelectTrigger id="training-folds" className="h-8 font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FOLD_OPTIONS.map((f) => (
                <SelectItem key={f} value={String(f)}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="training-fold-mode" className="text-[11px] text-muted-foreground">
            {t('training.fieldFoldMode')}
          </Label>
          <Select
            value={draft.foldMode}
            onValueChange={(val) =>
              onChangeDraft((prev) => ({
                ...prev,
                foldMode: val as 'anchored' | 'rolling',
              }))
            }
          >
            <SelectTrigger id="training-fold-mode" className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="anchored">
                {t('training.foldModeAnchored')}
              </SelectItem>
              <SelectItem value="rolling">
                {t('training.foldModeRolling')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="training-train-pct" className="text-[11px] text-muted-foreground">
            {t('training.fieldTrainPct')}
          </Label>
          <Input
            id="training-train-pct"
            type="number"
            min={30}
            max={80}
            value={draft.trainRatioPct}
            onChange={(e) =>
              onChangeDraft((prev) => ({ ...prev, trainRatioPct: e.target.value }))
            }
            className="h-8 font-mono text-xs tabular-nums"
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="training-val-pct" className="text-[11px] text-muted-foreground">
            {t('training.fieldValPct')}
          </Label>
          <Input
            id="training-val-pct"
            type="number"
            min={5}
            max={40}
            value={draft.valRatioPct}
            onChange={(e) =>
              onChangeDraft((prev) => ({ ...prev, valRatioPct: e.target.value }))
            }
            className="h-8 font-mono text-xs tabular-nums"
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="training-test-pct" className="text-[11px] text-muted-foreground">
            {t('training.fieldTestPct')}
          </Label>
          <Input
            id="training-test-pct"
            type="number"
            min={10}
            max={50}
            value={draft.testRatioPct}
            onChange={(e) =>
              onChangeDraft((prev) => ({ ...prev, testRatioPct: e.target.value }))
            }
            className="h-8 font-mono text-xs tabular-nums"
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="training-purge" className="text-[11px] text-muted-foreground">
            {t('training.fieldPurgeGap')}
          </Label>
          <Input
            id="training-purge"
            type="number"
            min={1}
            max={500}
            value={draft.purgeGapBars}
            onChange={(e) =>
              onChangeDraft((prev) => ({ ...prev, purgeGapBars: e.target.value }))
            }
            className="h-8 font-mono text-xs tabular-nums"
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="training-fee" className="text-[11px] text-muted-foreground">
            {t('training.fieldFeePct')}
          </Label>
          <Input
            id="training-fee"
            type="number"
            step="0.01"
            min={0}
            max={5}
            value={draft.commissionPct}
            onChange={(e) =>
              onChangeDraft((prev) => ({ ...prev, commissionPct: e.target.value }))
            }
            className="h-8 font-mono text-xs tabular-nums"
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="training-slip" className="text-[11px] text-muted-foreground">
            {t('training.fieldSlippagePct')}
          </Label>
          <Input
            id="training-slip"
            type="number"
            step="0.01"
            min={0}
            max={5}
            value={draft.slippagePct}
            onChange={(e) =>
              onChangeDraft((prev) => ({ ...prev, slippagePct: e.target.value }))
            }
            className="h-8 font-mono text-xs tabular-nums"
          />
        </div>
      </div>

      {/* Balance, shorting toggle, and pre-flight metrics */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-sm bg-muted/25 px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Label htmlFor="training-balance" className="text-[11px] text-muted-foreground">
              {t('training.fieldBalance')}
            </Label>
            <Input
              id="training-balance"
              type="number"
              min={100}
              max={10_000_000}
              value={draft.initialBalance}
              onChange={(e) =>
                onChangeDraft((prev) => ({
                  ...prev,
                  initialBalance: e.target.value,
                }))
              }
              className="h-7 w-28 font-mono text-xs tabular-nums"
            />
          </div>

          {!isPrediction && (
            <div className="flex items-center gap-2">
              <Switch
                id="training-short"
                checked={draft.allowShort}
                onCheckedChange={(checked) =>
                  onChangeDraft((prev) => ({ ...prev, allowShort: checked }))
                }
              />
              <Label htmlFor="training-short" className="text-[11px] text-foreground cursor-pointer">
                {t('training.fieldAllowShort')}
              </Label>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-muted-foreground tabular-nums">
          <span>
            {t('training.preflightCandles', {
              count: validation.estimatedBars,
              max: MAX_TRAINING_HISTORY_BARS,
            })}
          </span>
          {validation.testFoldDurationMs > 0 && (
            <span>
              {t('training.preflightTestFold', {
                duration: formatDurationMs(validation.testFoldDurationMs),
              })}
            </span>
          )}
        </div>
      </div>

      {validation.isResearchVariant && (
        <p className="mt-2 text-[11.5px] text-[var(--brand-violet)]">
          {t('training.researchVariantHint', {
            pair: selectedItem.preset.strategy.pair,
            tf: selectedItem.preset.timeframe,
          })}
        </p>
      )}

      {/* Inline validation errors */}
      {!validation.valid && (
        <div
          role="alert"
          className="mt-2.5 flex flex-col gap-1 rounded-sm bg-[var(--negative-soft)] px-3 py-2 text-xs text-[var(--negative)]"
        >
          {Object.values(validation.errors).map((msg, idx) => (
            <span key={idx}>{msg}</span>
          ))}
        </div>
      )}

      {/* Inline pre-flight warnings (< 60d range or < 14d test fold) */}
      {validation.warnings.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-1 rounded-sm bg-[var(--warning-soft)] px-3 py-2 text-xs text-[var(--warning)]">
          {validation.warnings.map((msg, idx) => (
            <span key={idx} className="inline-flex items-center gap-1.5">
              <AlertTriangle className="size-3.5 shrink-0" />
              <span>{msg}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

const RunConfig = memo(RunConfigInner)
export default RunConfig
