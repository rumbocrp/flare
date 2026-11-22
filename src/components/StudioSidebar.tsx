import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  Play,
  ShieldAlert,
  Layers,
  Target,
  TrendingUp,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import {
  STRATEGY_PRESETS,
  evaluateBotPresetAccuracy,
  type StrategyPreset,
} from '../botEngine'
import type { BotServerSnapshot } from '../api/botClient'
import { formatDateTime, formatMoney, formatPrice } from '../format'
import { useI18n } from '../i18n'
import { computeTechnicalSummary, type TechnicalBias } from '../indicators'
import { evaluateTimeframePredictions } from '../predictions'
import { averageOptions, fastOptions, slowOptions } from '../signals'
import type {
  AverageKind,
  Candle,
  Interval,
  OrderPrefillIntent,
  Signal,
  SignalParams,
  Strategy,
} from '../types'
import type { CoinFocusMeta, LiveMarketMetrics } from './MarketSection'

type PresetReport = ReturnType<typeof evaluateBotPresetAccuracy>

type StudioSidebarProps = {
  candles: Candle[]
  pair: string
  timeframe: Interval
  params: SignalParams
  signals: Signal[]
  orderSide: 'buy' | 'sell'
  onOrderSideChange: (side: 'buy' | 'sell') => void
  orderPrefill?: OrderPrefillIntent | null
  onClearOrderPrefill?: () => void
  strategy?: Strategy
  onSaveStrategy?: (next: Strategy) => void
  onChangeParams?: (next: SignalParams) => void
  onApplyPreset?: (preset: StrategyPreset) => void
  onJumpToBar: (globalIndex: number) => void
  botSnapshot: BotServerSnapshot | null
  orderSizeUsd: number
  onOrderSizeUsdChange: (next: number) => void
  onSubmitOrder: (side: 'buy' | 'sell') => void
  submittingOrder: boolean
  orderFeedback: string | null
  atr14: number | null
  lastVwap: number | null
  coinProfile?: CoinFocusMeta
  onCalibratePreset?: () => void
  liveMetrics?: LiveMarketMetrics | null
  className?: string
}

function biasBadgeVariant(
  bias: TechnicalBias,
): 'positive' | 'negative' | 'secondary' {
  if (bias === 'bull') return 'positive'
  if (bias === 'bear') return 'negative'
  return 'secondary'
}

function StudioSidebar({
  candles,
  pair,
  timeframe,
  params,
  signals,
  orderSide,
  onOrderSideChange,
  orderPrefill = null,
  onClearOrderPrefill,
  strategy,
  onSaveStrategy,
  onChangeParams,
  onApplyPreset,
  onJumpToBar,
  botSnapshot,
  orderSizeUsd,
  onOrderSizeUsdChange,
  onSubmitOrder,
  submittingOrder,
  orderFeedback,
  atr14,
  lastVwap,
  coinProfile,
  onCalibratePreset,
  liveMetrics,
  className,
}: StudioSidebarProps) {
  const { t, locale, language } = useI18n()
  const notionalInputRef = useRef<HTMLInputElement | null>(null)
  const [tabState, setTabState] = useState<{
    prefillNonce: number
    tab: 'strategies' | 'indicators' | 'trade'
  }>({ prefillNonce: 0, tab: 'strategies' })
  const currentPrefillNonce = orderPrefill?.nonce ?? 0
  const activeTab =
    currentPrefillNonce > 0 && tabState.prefillNonce !== currentPrefillNonce
      ? 'trade'
      : tabState.tab
  const setActiveTab = (tab: 'strategies' | 'indicators' | 'trade') =>
    setTabState({ prefillNonce: currentPrefillNonce, tab })

  useEffect(() => {
    if (!orderPrefill || orderPrefill.pair !== pair) return
    const frame = requestAnimationFrame(() => {
      notionalInputRef.current?.focus()
      notionalInputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [orderPrefill, pair])
  const [presetFilter, setPresetFilter] = useState<'all' | 'crypto-spot' | 'prediction-market'>('all')
  const feedSignature = `${pair}|${timeframe}|${candles.length}|${candles[candles.length - 1]?.time ?? 0}`
  const [reportBatch, setReportBatch] = useState<{
    signature: string
    reports: Record<string, PresetReport>
    evaluatingCount: number | null
  }>({
    signature: '',
    reports: {},
    evaluatingCount: null,
  })
  const presetReports =
    reportBatch.signature === feedSignature ? reportBatch.reports : {}
  const evaluatingCount =
    reportBatch.signature === feedSignature ? reportBatch.evaluatingCount : null
  const [evalNonce, setEvalNonce] = useState(0)

  // Local editable risk fields when Trade tab strategy calibration is open
  const strategyKey = strategy
    ? `${strategy.stopLoss}|${strategy.takeProfit}|${strategy.positionSize}|${strategy.maxDailyRisk}`
    : 'default'
  const [riskEdits, setRiskEdits] = useState<{
    key: string
    sl: string
    tp: string
    pos: string
    daily: string
  } | null>(null)
  const activeRisk =
    riskEdits && riskEdits.key === strategyKey
      ? riskEdits
      : {
          key: strategyKey,
          sl: String(strategy?.stopLoss ?? 2),
          tp: String(strategy?.takeProfit ?? 4),
          pos: String(strategy?.positionSize ?? 15),
          daily: String(strategy?.maxDailyRisk ?? 3),
        }
  const slInput = activeRisk.sl
  const tpInput = activeRisk.tp
  const posInput = activeRisk.pos
  const dailyInput = activeRisk.daily
  const setSlInput = (val: string) => setRiskEdits({ ...activeRisk, sl: val })
  const setTpInput = (val: string) => setRiskEdits({ ...activeRisk, tp: val })
  const setPosInput = (val: string) => setRiskEdits({ ...activeRisk, pos: val })
  const setDailyInput = (val: string) =>
    setRiskEdits({ ...activeRisk, daily: val })
  const [riskSavedMsg, setRiskSavedMsg] = useState<string | null>(null)

  // Progressive non-blocking preset simulation when triggered
  useEffect(() => {
    if (evalNonce === 0 || candles.length < 60) return
    let cancelled = false
    const nextReports: Record<string, PresetReport> = {}

    const runStep = (idx: number) => {
      if (cancelled) return
      if (idx >= STRATEGY_PRESETS.length) {
        setReportBatch({
          signature: feedSignature,
          reports: { ...nextReports },
          evaluatingCount: null,
        })
        return
      }
      const preset = STRATEGY_PRESETS[idx]
      nextReports[preset.id] = evaluateBotPresetAccuracy(candles, preset)
      setReportBatch({
        signature: feedSignature,
        reports: { ...nextReports },
        evaluatingCount: idx + 1,
      })
      window.setTimeout(() => runStep(idx + 1), 12)
    }

    window.setTimeout(() => runStep(0), 0)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evalNonce, feedSignature])

  const techSummary = useMemo(
    () => computeTechnicalSummary(candles, params),
    [candles, params],
  )

  const predictionStats = useMemo(
    () => (candles.length >= 60 ? evaluateTimeframePredictions(timeframe, candles) : []),
    [timeframe, candles],
  )

  const globalSignalIndexByTime = useMemo(() => {
    const map = new Map<number, number>()
    candles.forEach((c, i) => map.set(c.time, i))
    return map
  }, [candles])

  const lastCandle = candles[candles.length - 1]
  const spotPrice = lastCandle?.close ?? 0
  const atrPct = spotPrice > 0 && atr14 !== null ? (atr14 / spotPrice) * 100 : null
  const vwapDiffPct =
    spotPrice > 0 && lastVwap !== null && lastVwap > 0
      ? ((spotPrice - lastVwap) / lastVwap) * 100
      : null

  const filteredPresets = useMemo(
    () =>
      STRATEGY_PRESETS.filter((p) =>
        presetFilter === 'all' ? true : p.domain === presetFilter,
      ),
    [presetFilter],
  )

  const recentSignals = useMemo(
    () => [...signals].reverse().slice(0, 18),
    [signals],
  )

  const slNum = Number(slInput)
  const tpNum = Number(tpInput)
  const posNum = Number(posInput)
  const dailyNum = Number(dailyInput)
  const riskFormValid =
    Number.isFinite(slNum) &&
    slNum >= 0.1 &&
    slNum <= 50 &&
    Number.isFinite(tpNum) &&
    tpNum >= 0.1 &&
    tpNum <= 100 &&
    Number.isFinite(posNum) &&
    posNum >= 1 &&
    posNum <= 100 &&
    Number.isFinite(dailyNum) &&
    dailyNum >= 0.5 &&
    dailyNum <= 50

  const handleSaveRisk = () => {
    if (!strategy || !onSaveStrategy || !riskFormValid) return
    onSaveStrategy({
      ...strategy,
      pair,
      stopLoss: slNum,
      takeProfit: tpNum,
      positionSize: posNum,
      maxDailyRisk: dailyNum,
    })
    setRiskSavedMsg(language === 'es' ? 'Guardado' : 'Saved')
    window.setTimeout(() => setRiskSavedMsg(null), 2200)
  }

  const targetPrice =
    spotPrice > 0 && Number.isFinite(tpNum)
      ? orderSide === 'buy'
        ? spotPrice * (1 + tpNum / 100)
        : spotPrice * (1 - tpNum / 100)
      : null
  const stopPrice =
    spotPrice > 0 && Number.isFinite(slNum)
      ? orderSide === 'buy'
        ? spotPrice * (1 - slNum / 100)
        : spotPrice * (1 + slNum / 100)
      : null
  const lockHalfPrice =
    spotPrice > 0 && Number.isFinite(tpNum)
      ? orderSide === 'buy'
        ? spotPrice * (1 + (tpNum * 0.5) / 100)
        : spotPrice * (1 - (tpNum * 0.5) / 100)
      : null
  const rrRatio =
    Number.isFinite(slNum) && slNum > 0 && Number.isFinite(tpNum)
      ? (tpNum / slNum).toFixed(2)
      : '—'

  const openPos = botSnapshot?.state.openPosition ?? null
  const unrealizedPnl =
    openPos && openPos.pair === pair && spotPrice > 0
      ? (openPos.side === 'buy'
          ? spotPrice - openPos.entryPrice
          : openPos.entryPrice - spotPrice) * openPos.quantity
      : null

  return (
    <aside
      className={cn(
        'flex h-full min-h-0 w-full flex-col bg-card lg:w-[324px] lg:shrink-0 xl:w-[344px]',
        className,
      )}
    >
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as 'strategies' | 'indicators' | 'trade')}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="shrink-0 px-2.5 py-2">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="strategies" className="text-[11px]">
              <Layers className="size-3" />
              {t('studio.tabStrategies')}
            </TabsTrigger>
            <TabsTrigger value="indicators" className="text-[11px]">
              <Activity className="size-3" />
              {t('studio.tabIndicators')}
            </TabsTrigger>
            <TabsTrigger value="trade" className="text-[11px]">
              <Target className="size-3" />
              {t('studio.tabTrade')}
            </TabsTrigger>
          </TabsList>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          {/* ================= STRATEGIES TAB ================= */}
          <TabsContent value="strategies" className="m-0 flex flex-col gap-3 p-3 pb-[var(--flare-dock-clearance)]">
            {coinProfile && (
              <div className="flex flex-col gap-1.5 rounded-sm bg-primary/10 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                    {t('terminal.optimalPreset')}
                  </span>
                  {onCalibratePreset && (
                    <Button
                      type="button"
                      size="xs"
                      variant="default"
                      onClick={onCalibratePreset}
                    >
                      <Target className="size-3" />
                      <span>
                        {t('terminal.calibrate', {
                          coin: pair.replace('/USDT', ''),
                        })}
                      </span>
                    </Button>
                  )}
                </div>
                <span className="font-mono text-xs font-semibold text-foreground">
                  {language === 'es'
                    ? coinProfile.presetBadgeEs
                    : coinProfile.presetBadgeEn}
                </span>
                <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">
                  {language === 'es'
                    ? coinProfile.edgeSummaryEs
                    : coinProfile.edgeSummaryEn}
                </span>
              </div>
            )}

            {onChangeParams && (
              <div className="flex flex-col gap-2 rounded-sm bg-muted/35 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                    {t('studio.maTuner')}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {params.average.toUpperCase()} {params.fastPeriod}/{params.slowPeriod}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  <Select
                    value={params.average}
                    onValueChange={(val) =>
                      onChangeParams({ ...params, average: val as AverageKind })
                    }
                  >
                    <SelectTrigger className="h-7 min-w-0 px-2 text-[11px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {averageOptions.map((opt) => (
                        <SelectItem key={opt.id} value={opt.id}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Select
                    value={String(params.fastPeriod)}
                    onValueChange={(val) => {
                      const nextFast = Number(val)
                      const nextSlow =
                        params.slowPeriod <= nextFast
                          ? slowOptions.find((s) => s > nextFast) ?? params.slowPeriod
                          : params.slowPeriod
                      onChangeParams({
                        ...params,
                        fastPeriod: nextFast,
                        slowPeriod: nextSlow,
                      })
                    }}
                  >
                    <SelectTrigger className="h-7 min-w-0 px-2 text-[11px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {fastOptions.map((p) => (
                        <SelectItem key={p} value={String(p)}>
                          Fast {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Select
                    value={String(params.slowPeriod)}
                    onValueChange={(val) =>
                      onChangeParams({ ...params, slowPeriod: Number(val) })
                    }
                  >
                    <SelectTrigger className="h-7 min-w-0 px-2 text-[11px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {slowOptions
                        .filter((p) => p > params.fastPeriod)
                        .map((p) => (
                          <SelectItem key={p} value={String(p)}>
                            Slow {p}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <div className="flex items-center gap-1">
                {(['all', 'crypto-spot', 'prediction-market'] as const).map((f) => (
                  <Button
                    key={f}
                    type="button"
                    size="xs"
                    variant={presetFilter === f ? 'default' : 'ghost'}
                    onClick={() => setPresetFilter(f)}
                  >
                    {f === 'all' ? 'All (8)' : f === 'crypto-spot' ? 'Spot (5)' : 'Rules (3)'}
                  </Button>
                ))}
              </div>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={evaluatingCount !== null || candles.length < 60}
                onClick={() => setEvalNonce((n) => n + 1)}
              >
                <Play className="size-3" />
                {evaluatingCount !== null
                  ? t('studio.analyzingPresets', {
                      done: evaluatingCount,
                      total: STRATEGY_PRESETS.length,
                    })
                  : t('studio.analyzePresets')}
              </Button>
            </div>

            <div className="flex flex-col gap-2">
              {filteredPresets.map((preset) => {
                const report = presetReports[preset.id]
                const isActivePreset =
                  preset.strategy.pair === pair &&
                  preset.timeframe === timeframe &&
                  preset.signalParams.fastPeriod === params.fastPeriod &&
                  preset.signalParams.slowPeriod === params.slowPeriod &&
                  preset.signalParams.average === params.average

                return (
                  <div
                    key={preset.id}
                    className={cn(
                      'flex flex-col gap-1.5 rounded-sm p-2.5 transition-colors',
                      isActivePreset
                        ? 'bg-primary/12'
                        : 'bg-muted/25 hover:bg-muted/40',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[12px] leading-snug font-semibold text-foreground">
                        {preset.name}
                      </span>
                      <Badge
                        variant={
                          preset.domain === 'prediction-market' ? 'violet' : 'outline'
                        }
                        className="shrink-0 font-mono text-[9.5px]"
                      >
                        {preset.timeframe}
                      </Badge>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-muted-foreground tabular-nums">
                      <span>{preset.strategy.pair}</span>
                      <span>·</span>
                      <span>
                        {preset.signalParams.average.toUpperCase()}{' '}
                        {preset.signalParams.fastPeriod}/{preset.signalParams.slowPeriod}
                      </span>
                      {preset.domain === 'crypto-spot' && (
                        <>
                          <span>·</span>
                          <span>
                            SL {preset.strategy.stopLoss}% / TP {preset.strategy.takeProfit}%
                          </span>
                        </>
                      )}
                    </div>

                    {report && (
                      <div className="grid grid-cols-4 gap-1 rounded-[4px] bg-background/60 px-2 py-1.5 font-mono text-[10.5px] tabular-nums">
                        <div className="flex flex-col">
                          <span className="text-[9px] text-muted-foreground">WR</span>
                          <span
                            className={cn(
                              'font-semibold',
                              report.winRatePct >= 55
                                ? 'text-[var(--positive)]'
                                : report.winRatePct >= 45
                                  ? 'text-foreground'
                                  : 'text-[var(--negative)]',
                            )}
                          >
                            {report.winRatePct.toFixed(1)}%
                          </span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[9px] text-muted-foreground">RET</span>
                          <span
                            className={cn(
                              'font-semibold',
                              report.returnPct >= 0
                                ? 'text-[var(--positive)]'
                                : 'text-[var(--negative)]',
                            )}
                          >
                            {report.returnPct >= 0 ? '+' : ''}
                            {report.returnPct.toFixed(1)}%
                          </span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[9px] text-muted-foreground">PF</span>
                          <span className="font-semibold text-foreground">
                            {report.profitFactor !== null ? report.profitFactor.toFixed(2) : '—'}
                          </span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[9px] text-muted-foreground">OPS</span>
                          <span className="font-semibold text-foreground">
                            {report.totalOperations}
                          </span>
                        </div>
                      </div>
                    )}

                    {onApplyPreset && (
                      <div className="flex justify-end pt-0.5">
                        <Button
                          type="button"
                          size="xs"
                          variant={isActivePreset ? 'secondary' : 'outline'}
                          onClick={() => onApplyPreset(preset)}
                        >
                          {isActivePreset ? (
                            <>
                              <Check className="size-3 text-[var(--positive)]" />
                              {t('studio.appliedPreset')}
                            </>
                          ) : (
                            t('studio.applyPreset')
                          )}
                        </Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </TabsContent>

          {/* ================= INDICATORS & RULES TAB ================= */}
          <TabsContent value="indicators" className="m-0 flex flex-col gap-3 p-3 pb-[var(--flare-dock-clearance)]">
            {liveMetrics && (
              <div className="flex flex-col gap-2 rounded-sm bg-muted/30 p-2.5 font-mono tabular-nums">
                <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  {t('terminal.marketSnapshot')}
                </span>
                <div className="grid grid-cols-2 gap-1.5 text-[10.5px]">
                  <div className="flex flex-col gap-0.5 rounded-[4px] bg-background/55 px-2 py-1.5">
                    <span className="text-[9.5px] text-muted-foreground">
                      {t('terminal.emaRegime')}
                    </span>
                    <span
                      className={cn(
                        'font-semibold',
                        liveMetrics.emaDistPct >= 0
                          ? 'text-[var(--positive)]'
                          : 'text-[var(--negative)]',
                      )}
                    >
                      {liveMetrics.emaDistPct >= 0 ? 'BULL ▲' : 'BEAR ▼'}{' '}
                      {liveMetrics.emaDistPct >= 0 ? '+' : ''}
                      {liveMetrics.emaDistPct.toFixed(2)}%
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5 rounded-[4px] bg-background/55 px-2 py-1.5">
                    <span className="text-[9.5px] text-muted-foreground">
                      RSI(14) · {liveMetrics.is24hChange ? t('studio.change24h') : 'Δ'}
                    </span>
                    <span className="font-semibold text-foreground">
                      {liveMetrics.lastRsi.toFixed(1)} ·{' '}
                      <span
                        className={
                          liveMetrics.changePct >= 0
                            ? 'text-[var(--positive)]'
                            : 'text-[var(--negative)]'
                        }
                      >
                        {liveMetrics.changePct >= 0 ? '+' : ''}
                        {liveMetrics.changePct.toFixed(2)}%
                      </span>
                    </span>
                  </div>
                  <div className="col-span-2 flex items-center justify-between gap-2 rounded-[4px] bg-background/55 px-2 py-1.5">
                    <span className="text-[9.5px] text-muted-foreground">
                      {t('terminal.range120')}
                    </span>
                    <span className="font-semibold text-foreground">
                      ${formatPrice(liveMetrics.low)} – ${formatPrice(liveMetrics.high)}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {techSummary && (
              <div className="flex flex-col gap-2.5 rounded-sm bg-muted/35 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                    {t('studio.consensus')}
                  </span>
                  <Badge
                    variant={
                      techSummary.label === 'Strong Buy' || techSummary.label === 'Buy'
                        ? 'positive'
                        : techSummary.label === 'Strong Sell' || techSummary.label === 'Sell'
                          ? 'negative'
                          : 'secondary'
                    }
                  >
                    {techSummary.label}
                  </Badge>
                </div>

                {/* Tri-segment gauge */}
                <div className="flex h-2 w-full overflow-hidden rounded-full bg-background/80">
                  {techSummary.bullCount > 0 && (
                    <div
                      className="bg-[var(--positive)]"
                      style={{
                        width: `${(techSummary.bullCount / Math.max(1, techSummary.bullCount + techSummary.neutralCount + techSummary.bearCount)) * 100}%`,
                      }}
                    />
                  )}
                  {techSummary.neutralCount > 0 && (
                    <div
                      className="bg-muted-foreground/35"
                      style={{
                        width: `${(techSummary.neutralCount / Math.max(1, techSummary.bullCount + techSummary.neutralCount + techSummary.bearCount)) * 100}%`,
                      }}
                    />
                  )}
                  {techSummary.bearCount > 0 && (
                    <div
                      className="bg-[var(--negative)]"
                      style={{
                        width: `${(techSummary.bearCount / Math.max(1, techSummary.bullCount + techSummary.neutralCount + techSummary.bearCount)) * 100}%`,
                      }}
                    />
                  )}
                </div>

                <div className="flex items-center justify-between font-mono text-[10.5px] tabular-nums">
                  <span className="text-[var(--positive)]">
                    BUY {techSummary.bullCount}
                  </span>
                  <span className="text-muted-foreground">
                    NEUT {techSummary.neutralCount}
                  </span>
                  <span className="text-[var(--negative)]">
                    SELL {techSummary.bearCount}
                  </span>
                </div>

                <Separator />

                <div className="grid grid-cols-2 gap-2 font-mono text-[10.5px] tabular-nums">
                  <div className="flex flex-col gap-0.5 rounded-[4px] bg-background/50 px-2 py-1.5">
                    <span className="text-[9.5px] text-muted-foreground">ATR (14)</span>
                    <span className="font-semibold text-foreground">
                      {atr14 !== null ? `$${formatPrice(atr14)}` : '—'}
                      {atrPct !== null ? ` (${atrPct.toFixed(2)}%)` : ''}
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5 rounded-[4px] bg-background/50 px-2 py-1.5">
                    <span className="text-[9.5px] text-muted-foreground">VWAP Session</span>
                    <span
                      className={cn(
                        'font-semibold',
                        vwapDiffPct === null
                          ? 'text-foreground'
                          : vwapDiffPct >= 0
                            ? 'text-[var(--positive)]'
                            : 'text-[var(--negative)]',
                      )}
                    >
                      {lastVwap !== null ? `$${formatPrice(lastVwap)}` : '—'}
                      {vwapDiffPct !== null
                        ? ` (${vwapDiffPct >= 0 ? '+' : ''}${vwapDiffPct.toFixed(2)}%)`
                        : ''}
                    </span>
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  {[...techSummary.oscillators, ...techSummary.movingAverages].map(
                    (reading) => (
                      <div
                        key={reading.name}
                        className="flex items-center justify-between gap-2 py-1 font-mono text-[11px] tabular-nums"
                      >
                        <span className="truncate text-muted-foreground">
                          {reading.name}
                        </span>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <span className="font-medium text-foreground">
                            {reading.value}
                          </span>
                          <Badge
                            variant={biasBadgeVariant(reading.bias)}
                            className="px-1 py-0 text-[9px]"
                          >
                            {reading.bias === 'bull'
                              ? 'BUY'
                              : reading.bias === 'bear'
                                ? 'SELL'
                                : 'NEUT'}
                          </Badge>
                        </div>
                      </div>
                    ),
                  )}
                </div>
              </div>
            )}

            {/* Prediction Rules for active timeframe */}
            <div className="flex flex-col gap-2 rounded-sm bg-muted/25 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  {t('studio.predictionRules', { tf: timeframe })}
                </span>
                <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">
                  {predictionStats.length}
                </span>
              </div>
              {predictionStats.length === 0 ? (
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t('studio.noPredictionRules', { tf: timeframe })}
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {predictionStats.map((rule) => (
                    <div
                      key={rule.ruleId}
                      className={cn(
                        'flex flex-col gap-1 rounded-[4px] p-2',
                        rule.currentlyActive
                          ? 'bg-[var(--positive-soft)]'
                          : 'bg-background/55',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-[11px] font-medium text-foreground">
                          #{rule.number} {rule.title}
                        </span>
                        {rule.currentlyActive && (
                          <Badge variant="positive" className="shrink-0 text-[9px]">
                            TRIGGERED
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground tabular-nums">
                        <span>
                          WR {rule.winRatePct.toFixed(1)}% ({rule.hits}/{rule.triggers})
                        </span>
                        <span>Wilson LB {rule.wilsonLowerBoundPct.toFixed(1)}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Interactive Jump-to-Signal List */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  {t('market.signals', { count: signals.length })}
                </span>
              </div>
              <p className="text-[10.5px] text-muted-foreground">
                {t('studio.signalsJumpHint')}
              </p>
              {recentSignals.length === 0 ? (
                <div className="rounded-sm bg-muted/20 px-2.5 py-2 text-[11px] text-muted-foreground">
                  {t('signals.empty')}
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {recentSignals.map((sig) => {
                    const globalIdx = globalSignalIndexByTime.get(sig.time)
                    return (
                      <button
                        key={`${sig.time}-${sig.side}`}
                        type="button"
                        disabled={globalIdx === undefined}
                        onClick={() => {
                          if (globalIdx !== undefined) onJumpToBar(globalIdx)
                        }}
                        className="flex cursor-pointer items-center justify-between gap-2 rounded-[4px] bg-muted/20 px-2 py-1.5 text-left font-mono text-[10.5px] transition-colors hover:bg-[var(--surface-hover)] tabular-nums"
                      >
                        <div className="flex items-center gap-1.5">
                          {sig.side === 'buy' ? (
                            <ArrowUpRight className="size-3.5 text-[var(--positive)]" />
                          ) : (
                            <ArrowDownRight className="size-3.5 text-[var(--negative)]" />
                          )}
                          <span
                            className={cn(
                              'font-semibold uppercase',
                              sig.side === 'buy'
                                ? 'text-[var(--positive)]'
                                : 'text-[var(--negative)]',
                            )}
                          >
                            {sig.side}
                          </span>
                          <span className="text-muted-foreground">
                            {formatDateTime(sig.time, locale)}
                          </span>
                        </div>
                        <span className="font-semibold text-foreground">
                          ${formatPrice(sig.price)}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </TabsContent>

          {/* ================= TRADE & RISK TAB ================= */}
          <TabsContent value="trade" className="m-0 flex flex-col gap-3 p-3 pb-[var(--flare-dock-clearance)]">
            {/* Direction Toggle */}
            <div className="grid grid-cols-2 gap-1.5 rounded-sm bg-background/60 p-1">
              <Button
                type="button"
                size="sm"
                variant={orderSide === 'buy' ? 'positive' : 'ghost'}
                onClick={() => onOrderSideChange('buy')}
                className="font-mono"
              >
                <ArrowUpRight className="size-3.5" />
                LONG / BUY
              </Button>
              <Button
                type="button"
                size="sm"
                variant={orderSide === 'sell' ? 'destructive' : 'ghost'}
                onClick={() => onOrderSideChange('sell')}
                className="font-mono"
              >
                <ArrowDownRight className="size-3.5" />
                SHORT / SELL
              </Button>
            </div>

            {/* Ticket Amount */}
            <div className="flex flex-col gap-2 rounded-sm bg-muted/30 p-2.5">
              {orderPrefill && orderPrefill.pair === pair && (
                <div className="flex flex-col gap-1 rounded-[4px] bg-primary/10 px-2 py-1.5 font-mono text-[10.5px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">
                      {t('studio.prefillRefLabel')}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <strong className="text-foreground tabular-nums">
                        ${formatPrice(orderPrefill.referencePrice)}
                      </strong>
                      {onClearOrderPrefill && (
                        <button
                          type="button"
                          onClick={onClearOrderPrefill}
                          aria-label={t('studio.prefillClear')}
                          title={t('studio.prefillClear')}
                          className="inline-flex size-4 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                        >
                          <X className="size-3" />
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="font-sans text-[10px] leading-snug text-muted-foreground">
                    {t('studio.prefillMarketNote')}
                  </p>
                </div>
              )}

              <div className="flex items-center justify-between gap-2 font-mono text-[10.5px]">
                <span className="text-muted-foreground">ORDER NOTIONAL (USD)</span>
                <span className="font-semibold text-foreground tabular-nums">
                  {botSnapshot
                    ? formatMoney(botSnapshot.state.balance)
                    : '—'}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  ref={notionalInputRef}
                  type="number"
                  min={10}
                  step={50}
                  value={orderSizeUsd}
                  onChange={(e) => {
                    const next = Number(e.target.value)
                    if (Number.isFinite(next) && next >= 0) {
                      onOrderSizeUsdChange(next)
                    }
                  }}
                  aria-label="Order notional USD"
                />
                <span className="inline-flex h-8 shrink-0 items-center rounded-sm bg-muted/45 px-2 font-mono text-[10.5px] text-muted-foreground">
                  USDT
                </span>
              </div>
              <div className="grid grid-cols-4 gap-1">
                {[100, 250, 500, 1000].map((amt) => (
                  <Button
                    key={amt}
                    type="button"
                    size="xs"
                    variant={orderSizeUsd === amt ? 'secondary' : 'outline'}
                    className="font-mono tabular-nums"
                    onClick={() => onOrderSizeUsdChange(amt)}
                  >
                    ${amt}
                  </Button>
                ))}
              </div>

              <Button
                type="button"
                variant={orderSide === 'buy' ? 'positive' : 'destructive'}
                disabled={submittingOrder || orderSizeUsd <= 0}
                onClick={() => onSubmitOrder(orderSide)}
                className="mt-1 w-full font-mono uppercase tracking-[0.04em]"
              >
                {submittingOrder
                  ? '...'
                  : `${orderSide === 'buy' ? 'BUY / LONG' : 'SELL / SHORT'} ${pair} · $${orderSizeUsd}`}
              </Button>

              {orderFeedback && (
                <div className="rounded-[4px] bg-primary/10 px-2 py-1.5 text-[11px] text-foreground">
                  {orderFeedback}
                </div>
              )}
            </div>

            {/* Active Position Box if running */}
            {openPos && (
              <div className="flex flex-col gap-1.5 rounded-sm bg-[var(--brand-violet)]/10 p-2.5 font-mono text-[10.5px] tabular-nums">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-foreground">
                    OPEN · {openPos.side.toUpperCase()} {openPos.pair}
                  </span>
                  {unrealizedPnl !== null && (
                    <Badge variant={unrealizedPnl >= 0 ? 'positive' : 'negative'}>
                      {unrealizedPnl >= 0 ? '+' : ''}
                      {formatMoney(unrealizedPnl)}
                    </Badge>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-1 text-muted-foreground">
                  <span>Entry: ${formatPrice(openPos.entryPrice)}</span>
                  <span>Qty: {openPos.quantity.toFixed(5)}</span>
                  <span className="text-[var(--positive)]">
                    TP: ${formatPrice(openPos.targetPrice)}
                  </span>
                  <span className="text-[var(--negative)]">
                    SL: ${formatPrice(openPos.stopPrice)}
                  </span>
                </div>
                {openPos.breakevenArmed && (
                  <div className="flex items-center gap-1 text-[10px] text-primary">
                    <ShieldAlert className="size-3" />
                    Profit-Lock 50% Breakeven Armed
                  </div>
                )}
              </div>
            )}

            {/* TP / SL / Position Risk */}
            {strategy && onSaveStrategy && (
              <div className="flex flex-col gap-2 rounded-sm bg-muted/25 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                    {t('studio.riskCalibration')}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    R:R 1:{rrRatio}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="studio-sl" className="text-[10.5px]">
                      Stop Loss (%)
                    </Label>
                    <Input
                      id="studio-sl"
                      type="number"
                      step="0.1"
                      value={slInput}
                      onChange={(e) => setSlInput(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="studio-tp" className="text-[10.5px]">
                      Take Profit (%)
                    </Label>
                    <Input
                      id="studio-tp"
                      type="number"
                      step="0.1"
                      value={tpInput}
                      onChange={(e) => setTpInput(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="studio-size" className="text-[10.5px]">
                      Position (%)
                    </Label>
                    <Input
                      id="studio-size"
                      type="number"
                      step="1"
                      value={posInput}
                      onChange={(e) => setPosInput(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="studio-daily" className="text-[10.5px]">
                      Daily Cap (%)
                    </Label>
                    <Input
                      id="studio-daily"
                      type="number"
                      step="0.5"
                      value={dailyInput}
                      onChange={(e) => setDailyInput(e.target.value)}
                    />
                  </div>
                </div>

                {spotPrice > 0 && (
                  <div className="grid grid-cols-3 gap-1 rounded-[4px] bg-background/60 px-2 py-1.5 font-mono text-[10px] tabular-nums">
                    <div>
                      <span className="block text-[9px] text-muted-foreground">TP EST.</span>
                      <span className="font-semibold text-[var(--positive)]">
                        {targetPrice !== null ? `$${formatPrice(targetPrice)}` : '—'}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[9px] text-muted-foreground">LOCK 50%</span>
                      <span className="font-semibold text-primary">
                        {lockHalfPrice !== null ? `$${formatPrice(lockHalfPrice)}` : '—'}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[9px] text-muted-foreground">SL EST.</span>
                      <span className="font-semibold text-[var(--negative)]">
                        {stopPrice !== null ? `$${formatPrice(stopPrice)}` : '—'}
                      </span>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] text-[var(--positive)]">
                    {riskSavedMsg ?? ''}
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    disabled={!riskFormValid}
                    onClick={handleSaveRisk}
                  >
                    <TrendingUp className="size-3" />
                    {t('studio.saveLevels')}
                  </Button>
                </div>
              </div>
            )}
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </aside>
  )
}

function areStudioSidebarPropsEqual(
  prev: StudioSidebarProps,
  next: StudioSidebarProps,
): boolean {
  if (
    prev.pair !== next.pair ||
    prev.timeframe !== next.timeframe ||
    prev.params.fastPeriod !== next.params.fastPeriod ||
    prev.params.slowPeriod !== next.params.slowPeriod ||
    prev.params.average !== next.params.average ||
    prev.orderSide !== next.orderSide ||
    prev.orderPrefill !== next.orderPrefill ||
    prev.orderSizeUsd !== next.orderSizeUsd ||
    prev.submittingOrder !== next.submittingOrder ||
    prev.orderFeedback !== next.orderFeedback ||
    prev.strategy !== next.strategy ||
    prev.botSnapshot !== next.botSnapshot ||
    prev.coinProfile !== next.coinProfile ||
    prev.className !== next.className ||
    prev.signals.length !== next.signals.length
  ) {
    return false
  }
  const prevLastSig = prev.signals[prev.signals.length - 1]
  const nextLastSig = next.signals[next.signals.length - 1]
  if (
    prevLastSig?.time !== nextLastSig?.time ||
    prevLastSig?.side !== nextLastSig?.side
  ) {
    return false
  }
  // Ignore intra-bar live ticks on the active candle; re-render on bar close/switch
  const prevLen = prev.candles.length
  const nextLen = next.candles.length
  if (prevLen !== nextLen) return false
  if (prevLen > 1) {
    const prevClosed = prev.candles[prevLen - 2]
    const nextClosed = next.candles[nextLen - 2]
    if (
      prevClosed.time !== nextClosed.time ||
      prevClosed.close !== nextClosed.close
    ) {
      return false
    }
  }
  if (prevLen > 0) {
    if (prev.candles[prevLen - 1].time !== next.candles[nextLen - 1].time) {
      return false
    }
  }
  return true
}

export default memo(StudioSidebar, areStudioSidebarPropsEqual)
