import { memo, useMemo, useState } from 'react'
import { History, RotateCcw, Save, SlidersHorizontal } from 'lucide-react'
import type {
  BotServerSnapshot,
  HardRiskLimits,
  RuntimeEventRecord,
  StreamConnectionStatus,
} from '@/api/botClient'
import OperatorSection from '@/components/botrun/OperatorSection'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  formatUtcTimestamp,
  validateHardLimitsDraft,
  validateStrategyParamsDraft,
} from '@/botRunUtils'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { availablePairs } from '@/strategy'
import type { Interval, Strategy } from '@/types'

const ALLOWED_TIMEFRAMES: readonly Interval[] = ['5m', '15m', '1h', '4h', '1d']

type HardLimitsDraft = {
  maxOrderNotionalUsd: string
  maxDailyOrders: string
  maxDailyLossUsd: string
  autoMirrorBotOrders: boolean
  allowedPairs: string[]
}

type StrategyDraft = {
  pair: string
  timeframe: Interval
  positionSize: string
  stopLoss: string
  takeProfit: string
  maxDailyRisk: string
}

type RiskLimitsCardProps = {
  snapshot: BotServerSnapshot
  strategy: Strategy
  events: RuntimeEventRecord[]
  streamStatus: StreamConnectionStatus
  open: boolean
  onToggle: () => void
  busyAction: string | null
  onSaveHardLimits: (
    limits: Partial<HardRiskLimits> & { autoMirrorBotOrders?: boolean },
  ) => Promise<void>
  onSelectPreset: (presetId: string) => Promise<void>
  onSaveStrategyParams: (params: {
    strategy: Strategy
    timeframe: Interval
  }) => Promise<void>
  onApplyBotSetup: () => Promise<void>
}

function RiskLimitsCard({
  snapshot,
  strategy,
  events,
  streamStatus,
  open,
  onToggle,
  busyAction,
  onSaveHardLimits,
  onSelectPreset,
  onSaveStrategyParams,
  onApplyBotSetup,
}: RiskLimitsCardProps) {
  const { t } = useI18n()
  const { preset: activePreset, presets, exchange } = snapshot
  const hardLimits = exchange?.hardLimits

  const [limitsDraft, setLimitsDraft] = useState<HardLimitsDraft | null>(null)
  const [strategyDraft, setStrategyDraft] = useState<StrategyDraft | null>(null)

  const currentLimits: HardLimitsDraft = limitsDraft ?? {
    maxOrderNotionalUsd: hardLimits ? String(hardLimits.maxOrderNotionalUsd) : '',
    maxDailyOrders: hardLimits ? String(hardLimits.maxDailyOrders) : '',
    maxDailyLossUsd: hardLimits ? String(hardLimits.maxDailyLossUsd) : '',
    autoMirrorBotOrders: Boolean(exchange?.autoMirrorBotOrders),
    allowedPairs: hardLimits ? [...hardLimits.allowedPairs] : [],
  }

  const currentStrategy: StrategyDraft = strategyDraft ?? {
    pair: activePreset.strategy.pair,
    timeframe: activePreset.timeframe,
    positionSize: String(activePreset.strategy.positionSize),
    stopLoss: String(activePreset.strategy.stopLoss),
    takeProfit: String(activePreset.strategy.takeProfit),
    maxDailyRisk: String(activePreset.strategy.maxDailyRisk),
  }

  const limitsErrors = useMemo(
    () =>
      hardLimits
        ? validateHardLimitsDraft({
            maxOrderNotionalUsd: currentLimits.maxOrderNotionalUsd,
            maxDailyOrders: currentLimits.maxDailyOrders,
            maxDailyLossUsd: currentLimits.maxDailyLossUsd,
          })
        : {},
    [
      hardLimits,
      currentLimits.maxOrderNotionalUsd,
      currentLimits.maxDailyOrders,
      currentLimits.maxDailyLossUsd,
    ],
  )

  const pairsError =
    hardLimits && currentLimits.allowedPairs.length === 0
      ? t('botRun.riskPairsErr')
      : undefined

  const hasLimitsErrors = Boolean(
    limitsErrors.maxOrderNotionalUsd ||
      limitsErrors.maxDailyOrders ||
      limitsErrors.maxDailyLossUsd ||
      pairsError,
  )

  const strategyErrors = useMemo(
    () =>
      validateStrategyParamsDraft({
        positionSize: currentStrategy.positionSize,
        stopLoss: currentStrategy.stopLoss,
        takeProfit: currentStrategy.takeProfit,
        maxDailyRisk: currentStrategy.maxDailyRisk,
      }),
    [
      currentStrategy.positionSize,
      currentStrategy.stopLoss,
      currentStrategy.takeProfit,
      currentStrategy.maxDailyRisk,
    ],
  )

  const hasStrategyErrors = Boolean(
    strategyErrors.positionSize ||
      strategyErrors.stopLoss ||
      strategyErrors.takeProfit ||
      strategyErrors.maxDailyRisk,
  )

  const recentChanges = useMemo(
    () => events.filter((ev) => ev.type === 'OPERATOR').slice(0, 5),
    [events],
  )

  const dailyOrderPct =
    hardLimits && hardLimits.maxDailyOrders > 0
      ? Math.min(
          100,
          Math.round(
            ((exchange?.dailyOrderCount ?? 0) / hardLimits.maxDailyOrders) *
              100,
          ),
        )
      : 0

  const dailyLossPct =
    hardLimits && hardLimits.maxDailyLossUsd > 0
      ? Math.min(
          100,
          Math.round(
            ((exchange?.dailyRealizedLossUsd ?? 0) /
              hardLimits.maxDailyLossUsd) *
              100,
          ),
        )
      : 0

  const remainingDailyBudgetUsd = hardLimits
    ? Math.max(
        0,
        hardLimits.maxDailyLossUsd - (exchange?.dailyRealizedLossUsd ?? 0),
      )
    : null

  function updateLimitsField<K extends keyof HardLimitsDraft>(
    key: K,
    value: HardLimitsDraft[K],
  ) {
    setLimitsDraft((prev) => ({
      ...(prev ?? currentLimits),
      [key]: value,
    }))
  }

  function toggleAllowedPair(pair: string) {
    const base = limitsDraft ?? currentLimits
    const exists = base.allowedPairs.includes(pair)
    const nextPairs = exists
      ? base.allowedPairs.filter((p) => p !== pair)
      : [...base.allowedPairs, pair]
    setLimitsDraft({
      ...base,
      allowedPairs: nextPairs,
    })
  }

  function updateStrategyField<K extends keyof StrategyDraft>(
    key: K,
    value: StrategyDraft[K],
  ) {
    setStrategyDraft((prev) => ({
      ...(prev ?? currentStrategy),
      [key]: value,
    }))
  }

  async function handleSaveLimits() {
    if (!hardLimits || !limitsDraft || hasLimitsErrors) return
    await onSaveHardLimits({
      maxOrderNotionalUsd: Number(limitsDraft.maxOrderNotionalUsd.trim()),
      maxDailyOrders: Number(limitsDraft.maxDailyOrders.trim()),
      maxDailyLossUsd: Number(limitsDraft.maxDailyLossUsd.trim()),
      autoMirrorBotOrders: limitsDraft.autoMirrorBotOrders,
      allowedPairs: limitsDraft.allowedPairs,
    })
    setLimitsDraft(null)
  }

  async function handleSaveStrategy() {
    if (!strategyDraft || hasStrategyErrors) return
    await onSaveStrategyParams({
      timeframe: strategyDraft.timeframe,
      strategy: {
        pair: strategyDraft.pair,
        positionSize: Number(strategyDraft.positionSize.trim()),
        stopLoss: Number(strategyDraft.stopLoss.trim()),
        takeProfit: Number(strategyDraft.takeProfit.trim()),
        maxDailyRisk: Number(strategyDraft.maxDailyRisk.trim()),
      },
    })
    setStrategyDraft(null)
  }

  return (
    <OperatorSection
      id="risk"
      title={t('botRun.riskTitle')}
      badges={
        <>
          <Badge variant="outline">
            {t('botRun.presetsCount', { count: presets.length })}
          </Badge>
          {exchange?.killSwitchActive && (
            <Badge variant="negative">LOCKED</Badge>
          )}
        </>
      }
      sourceLabel="/api/exchange/limits · /api/bot/preset"
      updatedAt={exchange?.updatedAt ?? snapshot.telemetry?.lastTickAt}
      connectionState={streamStatus}
      open={open}
      onToggle={onToggle}
    >
      {/* Group 1 — Server-Enforced Hard Limits */}
      <div className="flex flex-col gap-2.5 rounded-sm bg-muted/25 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <strong className="font-mono text-[11px] uppercase tracking-[0.05em] text-foreground">
              {t('botRun.riskGroup1')}
            </strong>
            <Badge variant="positive" className="text-[9.5px]">
              SERVER
            </Badge>
          </div>
          {limitsDraft && (
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={busyAction !== null}
                onClick={() => setLimitsDraft(null)}
              >
                <RotateCcw className="size-3" />
                <span>{t('botRun.discard')}</span>
              </Button>
              <Button
                type="button"
                size="xs"
                variant="default"
                disabled={hasLimitsErrors || busyAction !== null}
                onClick={() => void handleSaveLimits()}
              >
                <Save className="size-3" />
                <span>{t('botRun.riskSaveLimits')}</span>
              </Button>
            </div>
          )}
        </div>

        {hardLimits ? (
          <>
            {/* Real Usage Meters */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="flex flex-col gap-1 rounded-sm bg-background/55 p-2">
                <div className="flex items-center justify-between font-mono text-[10.5px]">
                  <span className="text-muted-foreground">
                    {t('botRun.riskOrdersToday')}
                  </span>
                  <strong className="tabular-nums text-foreground">
                    {exchange.dailyOrderCount} / {hardLimits.maxDailyOrders}
                  </strong>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      dailyOrderPct >= 90
                        ? 'bg-[var(--negative)]'
                        : dailyOrderPct >= 70
                          ? 'bg-[var(--warning)]'
                          : 'bg-[var(--positive)]',
                    )}
                    style={{ width: `${dailyOrderPct}%` }}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1 rounded-sm bg-background/55 p-2">
                <div className="flex items-center justify-between font-mono text-[10.5px]">
                  <span className="text-muted-foreground">
                    {t('botRun.riskDailyLoss')}
                  </span>
                  <strong className="tabular-nums text-foreground">
                    ${exchange.dailyRealizedLossUsd.toFixed(2)} / $
                    {hardLimits.maxDailyLossUsd.toFixed(0)}
                  </strong>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      dailyLossPct >= 90
                        ? 'bg-[var(--negative)]'
                        : dailyLossPct >= 65
                          ? 'bg-[var(--warning)]'
                          : 'bg-[var(--positive)]',
                    )}
                    style={{ width: `${dailyLossPct}%` }}
                  />
                </div>
              </div>

              <div className="flex flex-col justify-between rounded-sm bg-background/55 p-2 font-mono">
                <span className="text-[10.5px] text-muted-foreground">
                  {t('botRun.riskRemainingBudget')}
                </span>
                <strong className="text-xs font-bold tabular-nums text-foreground">
                  {remainingDailyBudgetUsd !== null
                    ? `$${remainingDailyBudgetUsd.toFixed(2)}`
                    : '—'}
                </strong>
              </div>
            </div>

            {/* Editable Hard Limits Form */}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="botrun-max-notional"
                  className="font-mono text-[10.5px] text-muted-foreground"
                >
                  {t('botRun.riskMaxOrder')}
                </label>
                <Input
                  id="botrun-max-notional"
                  type="number"
                  min={10}
                  max={100000}
                  step="10"
                  value={currentLimits.maxOrderNotionalUsd}
                  onChange={(e) =>
                    updateLimitsField('maxOrderNotionalUsd', e.target.value)
                  }
                  aria-invalid={Boolean(limitsErrors.maxOrderNotionalUsd)}
                  className="h-8 font-mono text-xs tabular-nums"
                />
                {limitsErrors.maxOrderNotionalUsd && (
                  <span className="text-[10.5px] text-[var(--negative)]">
                    {limitsErrors.maxOrderNotionalUsd}
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor="botrun-max-daily-orders"
                  className="font-mono text-[10.5px] text-muted-foreground"
                >
                  {t('botRun.riskMaxDailyOrders')}
                </label>
                <Input
                  id="botrun-max-daily-orders"
                  type="number"
                  min={1}
                  max={500}
                  step="1"
                  value={currentLimits.maxDailyOrders}
                  onChange={(e) =>
                    updateLimitsField('maxDailyOrders', e.target.value)
                  }
                  aria-invalid={Boolean(limitsErrors.maxDailyOrders)}
                  className="h-8 font-mono text-xs tabular-nums"
                />
                {limitsErrors.maxDailyOrders && (
                  <span className="text-[10.5px] text-[var(--negative)]">
                    {limitsErrors.maxDailyOrders}
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor="botrun-max-daily-loss"
                  className="font-mono text-[10.5px] text-muted-foreground"
                >
                  {t('botRun.riskMaxDailyLoss')}
                </label>
                <Input
                  id="botrun-max-daily-loss"
                  type="number"
                  min={10}
                  max={250000}
                  step="10"
                  value={currentLimits.maxDailyLossUsd}
                  onChange={(e) =>
                    updateLimitsField('maxDailyLossUsd', e.target.value)
                  }
                  aria-invalid={Boolean(limitsErrors.maxDailyLossUsd)}
                  className="h-8 font-mono text-xs tabular-nums"
                />
                {limitsErrors.maxDailyLossUsd && (
                  <span className="text-[10.5px] text-[var(--negative)]">
                    {limitsErrors.maxDailyLossUsd}
                  </span>
                )}
              </div>
            </div>

            {/* Allowed Pairs + Auto-Mirror */}
            <div className="flex flex-col gap-2 pt-0.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-[10.5px] text-muted-foreground">
                  {t('botRun.riskAllowedPairs')}
                </span>
                <label className="inline-flex items-center gap-2 text-xs text-foreground cursor-pointer">
                  <Switch
                    checked={currentLimits.autoMirrorBotOrders}
                    disabled={busyAction !== null}
                    onCheckedChange={(checked) =>
                      updateLimitsField('autoMirrorBotOrders', checked)
                    }
                    aria-label={t('botRun.riskAutoMirrorAria')}
                  />
                  <span className="text-[11px] text-muted-foreground">
                    {t('botRun.riskAutoMirror')}
                  </span>
                </label>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {availablePairs.map((pair) => {
                  const active = currentLimits.allowedPairs.includes(pair)
                  return (
                    <button
                      key={pair}
                      type="button"
                      onClick={() => toggleAllowedPair(pair)}
                      aria-pressed={active}
                      className={cn(
                        'rounded-sm px-2 py-1 font-mono text-[10.5px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring cursor-pointer',
                        active
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-background/60 text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {pair}
                    </button>
                  )
                })}
              </div>
              {pairsError && (
                <span className="text-[10.5px] text-[var(--negative)]">
                  {pairsError}
                </span>
              )}
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('botRun.riskNoLimits')}
          </p>
        )}
      </div>

      {/* Group 2 — Engine Strategy Parameters */}
      <div className="flex flex-col gap-2.5 rounded-sm bg-muted/25 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="font-mono text-[11px] uppercase tracking-[0.05em] text-foreground">
              {t('botRun.riskGroup2')}
            </strong>
            <span className="text-[10.5px] text-muted-foreground">
              {t('botRun.riskGroup2Hint')}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busyAction !== null}
              onClick={() => {
                setStrategyDraft(null)
                void onApplyBotSetup()
              }}
              title={t('botRun.riskApplySetupTitle', {
                pair: strategy.pair,
                sl: strategy.stopLoss,
                tp: strategy.takeProfit,
              })}
            >
              <SlidersHorizontal className="size-3" />
              <span>{t('botRun.riskApplySetup')}</span>
            </Button>

            {strategyDraft && (
              <>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busyAction !== null}
                  onClick={() => setStrategyDraft(null)}
                >
                  <RotateCcw className="size-3" />
                  <span>{t('botRun.discard')}</span>
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="default"
                  disabled={hasStrategyErrors || busyAction !== null}
                  onClick={() => void handleSaveStrategy()}
                >
                  <Save className="size-3" />
                  <span>{t('botRun.riskSaveStrategy')}</span>
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Preset Selector + Pair / Timeframe */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
          <div className="flex flex-col gap-1 sm:col-span-6">
            <span className="font-mono text-[10.5px] text-muted-foreground">
              {t('botRun.riskActivePreset')}
            </span>
            <Select
              value={activePreset.id}
              disabled={busyAction !== null}
              onValueChange={(id) => {
                setStrategyDraft(null)
                void onSelectPreset(id)
              }}
            >
              <SelectTrigger
                className="h-8 text-xs"
                aria-label={t('botRun.riskActivePreset')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {presets.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    [{p.domain === 'prediction-market' ? 'PRED' : 'SPOT'} ·{' '}
                    {p.timeframe}] {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1 sm:col-span-3">
            <span className="font-mono text-[10.5px] text-muted-foreground">
              {t('botRun.pair')}
            </span>
            <Select
              value={currentStrategy.pair}
              disabled={busyAction !== null}
              onValueChange={(pair) => updateStrategyField('pair', pair)}
            >
              <SelectTrigger
                className="h-8 font-mono text-xs"
                aria-label={t('botRun.pair')}
              >
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

          <div className="flex flex-col gap-1 sm:col-span-3">
            <span className="font-mono text-[10.5px] text-muted-foreground">
              {t('botRun.riskTimeframe')}
            </span>
            <Select
              value={currentStrategy.timeframe}
              disabled={busyAction !== null}
              onValueChange={(tf) =>
                updateStrategyField('timeframe', tf as Interval)
              }
            >
              <SelectTrigger
                className="h-8 font-mono text-xs"
                aria-label={t('botRun.riskTimeframe')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALLOWED_TIMEFRAMES.map((tf) => (
                  <SelectItem key={tf} value={tf}>
                    {tf}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Numeric Strategy Params */}
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="botrun-pos-size"
              className="font-mono text-[10.5px] text-muted-foreground"
            >
              {t('botRun.riskSizePct')}
            </label>
            <Input
              id="botrun-pos-size"
              type="number"
              min={0.1}
              max={100}
              step="0.5"
              value={currentStrategy.positionSize}
              onChange={(e) =>
                updateStrategyField('positionSize', e.target.value)
              }
              aria-invalid={Boolean(strategyErrors.positionSize)}
              className="h-8 font-mono text-xs tabular-nums"
            />
            {strategyErrors.positionSize && (
              <span className="text-[10px] text-[var(--negative)]">
                {strategyErrors.positionSize}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="botrun-stop-loss"
              className="font-mono text-[10.5px] text-muted-foreground"
            >
              Stop Loss (%)
            </label>
            <Input
              id="botrun-stop-loss"
              type="number"
              min={0.1}
              max={50}
              step="0.1"
              value={currentStrategy.stopLoss}
              onChange={(e) => updateStrategyField('stopLoss', e.target.value)}
              aria-invalid={Boolean(strategyErrors.stopLoss)}
              className="h-8 font-mono text-xs tabular-nums"
            />
            {strategyErrors.stopLoss && (
              <span className="text-[10px] text-[var(--negative)]">
                {strategyErrors.stopLoss}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="botrun-take-profit"
              className="font-mono text-[10.5px] text-muted-foreground"
            >
              Take Profit (%)
            </label>
            <Input
              id="botrun-take-profit"
              type="number"
              min={0.1}
              max={100}
              step="0.1"
              value={currentStrategy.takeProfit}
              onChange={(e) =>
                updateStrategyField('takeProfit', e.target.value)
              }
              aria-invalid={Boolean(strategyErrors.takeProfit)}
              className="h-8 font-mono text-xs tabular-nums"
            />
            {strategyErrors.takeProfit && (
              <span className="text-[10px] text-[var(--negative)]">
                {strategyErrors.takeProfit}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="botrun-daily-risk"
              className="font-mono text-[10.5px] text-muted-foreground"
            >
              {t('botRun.riskDailyRiskPct')}
            </label>
            <Input
              id="botrun-daily-risk"
              type="number"
              min={0.1}
              max={100}
              step="0.5"
              value={currentStrategy.maxDailyRisk}
              onChange={(e) =>
                updateStrategyField('maxDailyRisk', e.target.value)
              }
              aria-invalid={Boolean(strategyErrors.maxDailyRisk)}
              className="h-8 font-mono text-xs tabular-nums"
            />
            {strategyErrors.maxDailyRisk && (
              <span className="text-[10px] text-[var(--negative)]">
                {strategyErrors.maxDailyRisk}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Compact Recent Operator Change History (from SQL runtime_events) */}
      <div className="flex flex-col gap-1.5 rounded-sm bg-muted/20 p-2.5">
        <div className="flex items-center gap-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          <History className="size-3" />
          <span>{t('botRun.riskHistoryTitle')}</span>
        </div>
        {recentChanges.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {recentChanges.map((ev) => (
              <li
                key={ev.id}
                className="flex flex-wrap items-baseline justify-between gap-2 font-mono text-[11px]"
              >
                <span className="min-w-0 truncate text-foreground">
                  {ev.message}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                  {formatUtcTimestamp(ev.timestamp)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {t('botRun.riskHistoryEmpty')}
          </p>
        )}
      </div>
    </OperatorSection>
  )
}

export default memo(RiskLimitsCard)
