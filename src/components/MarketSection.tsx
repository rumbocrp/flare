import { useMemo, useState } from 'react'
import { Maximize2, RefreshCw, Target } from 'lucide-react'
import './EquityChart.css'
import './CandleChart.css'
import MarketAnalysis from './MarketAnalysis'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { useLiveCandles } from '@/hooks/useCandles'
import { useLocalStorageState } from '@/hooks/useLocalStorageState'
import { atr, ema, rsi } from '@/indicators'
import { marketDataSource } from '@/market'
import { availablePairs } from '@/strategy'
import {
  averageOptions,
  defaultSignalParams,
  fastOptions,
  isSignalParams,
  slowOptions,
} from '@/signals'
import { useI18n, type TranslationKey } from '@/i18n'
import { cn } from '@/lib/utils'
import type { Interval, PageId, SignalParams, Strategy } from '@/types'

function formatUtcClock(timestamp: number | null): string {
  if (!timestamp) return '--:--:--'
  return new Date(timestamp).toISOString().slice(11, 19)
}

const SIGNAL_PARAMS_KEY = 'lixtrd:signal-params'

const intervalOptions: {
  id: Interval
  labelKey?: TranslationKey
  rawLabel?: string
}[] = [
    { id: '5m', labelKey: 'market.interval5m' },
    { id: '15m', labelKey: 'market.interval15m' },
    { id: '1h', labelKey: 'market.interval1h' },
    { id: '4h', labelKey: 'market.interval4h' },
    { id: '1d', labelKey: 'market.interval1d' },
  ]

// 360 candles = 310 navigable bars + 50 warm-up bars so SMA/EMA/EMA50/RSI never cut off
const CANDLE_SPECTRUM_LIMIT = 360

type CoinFocusMeta = {
  pair: string
  optimalTimeframe: Interval
  optimalParams: SignalParams
  presetBadgeEs: string
  presetBadgeEn: string
  edgeSummaryEs: string
  edgeSummaryEn: string
}

const COIN_FOCUS_PROFILES: Record<string, CoinFocusMeta> = {
  'BTC/USDT': {
    pair: 'BTC/USDT',
    optimalTimeframe: '15m',
    optimalParams: { fastPeriod: 12, slowPeriod: 26, average: 'ema' },
    presetBadgeEs: 'Preset #2 · EMA 12/26 (15m)',
    presetBadgeEn: 'Preset #2 · EMA 12/26 (15m)',
    edgeSummaryEs: '61.9% Win Rate · PF 2.09 · Polymarket 75.8% WR',
    edgeSummaryEn: '61.9% Win Rate · PF 2.09 · Polymarket 75.8% WR',
  },
  'ETH/USDT': {
    pair: 'ETH/USDT',
    optimalTimeframe: '15m',
    optimalParams: { fastPeriod: 12, slowPeriod: 26, average: 'ema' },
    presetBadgeEs: 'Preset #6 · EMA 12/26 (15m)',
    presetBadgeEn: 'Preset #6 · EMA 12/26 (15m)',
    edgeSummaryEs: '61.9% Win Rate · PF 2.86 · Polymarket 68.8% WR',
    edgeSummaryEn: '61.9% Win Rate · PF 2.86 · Polymarket 68.8% WR',
  },
  'SOL/USDT': {
    pair: 'SOL/USDT',
    optimalTimeframe: '15m',
    optimalParams: { fastPeriod: 5, slowPeriod: 20, average: 'ema' },
    presetBadgeEs: 'Preset #8 · EMA 5/20 (15m)',
    presetBadgeEn: 'Preset #8 · EMA 5/20 (15m)',
    edgeSummaryEs: '75.0% Win Rate · PF 4.91 · Polymarket 81.0% WR',
    edgeSummaryEn: '75.0% Win Rate · PF 4.91 · Polymarket 81.0% WR',
  },
}

type MarketSectionProps = {
  strategy?: Strategy
  onSaveStrategy?: (next: Strategy) => void
  onNavigate?: (page: PageId) => void
  isFullTerminal?: boolean
  compact?: boolean
  chartHeight?: number
  selectedPair?: string
  onSelectPair?: (pair: string) => void
}

function MarketSection({
  strategy,
  onSaveStrategy,
  onNavigate,
  isFullTerminal = false,
  compact = false,
  chartHeight,
  selectedPair,
  onSelectPair,
}: MarketSectionProps) {
  const { t, language } = useI18n()
  const isEs = language === 'es'
  const [internalPair, setInternalPair] = useState<string>(
    strategy?.pair ?? availablePairs[0],
  )
  const pair = selectedPair ?? internalPair

  function handlePairChange(nextPair: string) {
    setInternalPair(nextPair)
    onSelectPair?.(nextPair)
  }

  const [timeframe, setTimeframe] = useState<Interval>('15m')
  const [reloadKey, setReloadKey] = useState(0)

  const [params, setParams] = useLocalStorageState<SignalParams>(
    SIGNAL_PARAMS_KEY,
    defaultSignalParams,
    isSignalParams,
  )

  const { state, streamStatus, lastTickAt } = useLiveCandles(
    marketDataSource,
    pair,
    timeframe,
    CANDLE_SPECTRUM_LIMIT,
    reloadKey,
  )

  const coinProfile =
    COIN_FOCUS_PROFILES[pair] ?? COIN_FOCUS_PROFILES['BTC/USDT']

  const liveMetrics = useMemo(() => {
    if (state.status !== 'success' || state.data.length < 55) return null
    const data = state.data
    const last = data[data.length - 1]
    const ref24 = data[Math.max(0, data.length - 96)]
    const changePct = ((last.close - ref24.close) / ref24.close) * 100

    const closes = data.map((c) => c.close)
    const ema50Series = ema(closes, 50)
    const rsiSeries = rsi(closes, 14)
    const atrSeries = atr(data, 14)
    const lastAtr = atrSeries[atrSeries.length - 1] ?? 0

    const lastEma50 = ema50Series[ema50Series.length - 1] ?? last.close
    const lastRsi = rsiSeries[rsiSeries.length - 1] ?? 50
    const atrPct = (lastAtr / last.close) * 100
    const emaDistPct = ((last.close - lastEma50) / lastEma50) * 100

    let high = -Infinity
    let low = Infinity
    for (let i = Math.max(0, data.length - 120); i < data.length; i += 1) {
      if (data[i].high > high) high = data[i].high
      if (data[i].low < low) low = data[i].low
    }

    return {
      lastClose: last.close,
      changePct,
      lastEma50,
      emaDistPct,
      lastRsi,
      lastAtr,
      atrPct,
      high,
      low,
    }
  }, [state])

  const liveTimeText = formatUtcClock(lastTickAt)
  const liveStatusText =
    streamStatus === 'ws'
      ? isEs
        ? `EN VIVO · WS · ${liveTimeText} UTC`
        : `LIVE · WS · ${liveTimeText} UTC`
      : streamStatus === 'poll'
        ? isEs
          ? `EN VIVO · SYNC · ${liveTimeText} UTC`
          : `LIVE · SYNC · ${liveTimeText} UTC`
        : streamStatus === 'connecting'
          ? isEs
            ? 'CONECTANDO...'
            : 'CONNECTING...'
          : isEs
            ? 'SERIE ESTÁTICA'
            : 'STATIC'

  function handleApplyCoinOptimalPreset() {
    setTimeframe(coinProfile.optimalTimeframe)
    setParams(coinProfile.optimalParams)
  }

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="font-display text-sm font-semibold uppercase tracking-[0.06em] text-foreground">
              {isFullTerminal
                ? isEs
                  ? `Estudio Gráfico · ${pair} (${timeframe})`
                  : `Chart Studio · ${pair} (${timeframe})`
                : t('market.title')}
            </h2>
            <Badge
              variant={
                streamStatus === 'ws'
                  ? 'positive'
                  : streamStatus === 'poll'
                    ? 'default'
                    : 'secondary'
              }
              aria-live="polite"
            >
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  streamStatus === 'ws'
                    ? 'bg-[var(--positive)]'
                    : streamStatus === 'poll'
                      ? 'bg-primary'
                      : 'bg-muted-foreground',
                )}
              />
              <span>{liveStatusText}</span>
            </Badge>
          </div>
        </div>

        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            <div
              className="inline-flex h-8 max-w-full items-center gap-0.5 overflow-x-auto rounded-sm border border-border bg-secondary/65 p-0.5 [scrollbar-width:none]"
              role="group"
              aria-label={t('market.pairAria')}
            >
              {availablePairs.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={cn(
                    'inline-flex h-[26px] items-center rounded-[4px] border px-2.5 font-mono text-xs font-medium whitespace-nowrap transition-all duration-150 cursor-pointer',
                    pair === option
                      ? 'border-border bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.18)]'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                  aria-pressed={pair === option}
                  onClick={() => handlePairChange(option)}
                >
                  {option}
                </button>
              ))}
            </div>

            <div
              className="inline-flex h-8 items-center gap-0.5 rounded-sm border border-border bg-secondary/65 p-0.5"
              role="group"
              aria-label={t('market.timeframeAria')}
            >
              {intervalOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={cn(
                    'inline-flex h-[26px] items-center rounded-[4px] border px-2.5 font-mono text-xs font-medium whitespace-nowrap transition-all duration-150 cursor-pointer',
                    timeframe === option.id
                      ? 'border-border bg-card font-semibold text-primary shadow-[0_1px_2px_rgba(0,0,0,0.18)]'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                  aria-pressed={timeframe === option.id}
                  onClick={() => setTimeframe(option.id)}
                >
                  {option.rawLabel ??
                    (option.labelKey ? t(option.labelKey) : option.id)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {!compact && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleApplyCoinOptimalPreset}
                title={
                  isEs
                    ? `Calibrar ${coinProfile.presetBadgeEs}`
                    : `Calibrate ${coinProfile.presetBadgeEn}`
                }
              >
                <Target className="size-3.5 text-primary" />
                <span>
                  {isEs
                    ? `Calibrar ${pair.replace('/USDT', '')}`
                    : `Calibrate ${pair.replace('/USDT', '')}`}
                </span>
              </Button>
            )}
            {!isFullTerminal && onNavigate && (
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={() => onNavigate('terminal')}
              >
                <Maximize2 className="size-3.5" />
                <span>
                  {compact
                    ? isEs
                      ? 'Abrir Estudio Gráfico'
                      : 'Open Chart Studio'
                    : isEs
                      ? 'Estudio Gráfico'
                      : 'Chart Studio'}
                </span>
              </Button>
            )}
          </div>
        </div>
      </div>

      {!compact && (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="gap-1 bg-secondary/45 px-3 py-2.5">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                {pair} · Live Spot
              </span>
              <strong className="font-mono text-sm font-bold text-foreground tabular-nums">
                {liveMetrics
                  ? `$${liveMetrics.lastClose.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}`
                  : '—'}
              </strong>
              <span
                className={cn(
                  'font-mono text-[11px] font-medium tabular-nums',
                  liveMetrics && liveMetrics.changePct >= 0
                    ? 'text-[var(--positive)]'
                    : 'text-[var(--negative)]',
                )}
              >
                {liveMetrics
                  ? `${liveMetrics.changePct >= 0 ? '+' : ''}${liveMetrics.changePct.toFixed(2)}% (96 bars)`
                  : '—'}
              </span>
            </Card>

            <Card className="gap-1 bg-secondary/45 px-3 py-2.5">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                {isEs ? 'Config Óptima Moneda' : 'Coin Optimal Preset'}
              </span>
              <strong className="font-mono text-xs font-semibold text-foreground">
                {isEs ? coinProfile.presetBadgeEs : coinProfile.presetBadgeEn}
              </strong>
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {isEs ? coinProfile.edgeSummaryEs : coinProfile.edgeSummaryEn}
              </span>
            </Card>

            <Card className="gap-1 bg-secondary/45 px-3 py-2.5">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                {isEs ? 'Régimen EMA 50 · RSI 14' : 'EMA 50 Regime · RSI 14'}
              </span>
              <strong
                className={cn(
                  'font-mono text-xs font-bold',
                  liveMetrics && liveMetrics.emaDistPct >= 0
                    ? 'text-[var(--positive)]'
                    : 'text-[var(--negative)]',
                )}
              >
                {liveMetrics
                  ? `${liveMetrics.emaDistPct >= 0 ? 'BULL ▲' : 'BEAR ▼'} (${liveMetrics.emaDistPct >= 0 ? '+' : ''}${liveMetrics.emaDistPct.toFixed(2)}%)`
                  : '—'}
              </strong>
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {liveMetrics
                  ? `RSI(14): ${liveMetrics.lastRsi.toFixed(1)} · ATR: ${liveMetrics.atrPct.toFixed(2)}%`
                  : '—'}
              </span>
            </Card>

            <Card className="gap-1 bg-secondary/45 px-3 py-2.5">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                {isEs ? 'Rango 120 Velas' : '120-Bar Range'}
              </span>
              <strong className="font-mono text-xs font-semibold text-foreground tabular-nums">
                {liveMetrics
                  ? `$${liveMetrics.low.toLocaleString('en-US', { maximumFractionDigits: 0 })} – $${liveMetrics.high.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
                  : '—'}
              </strong>
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {liveMetrics
                  ? `ATR(14): $${liveMetrics.lastAtr.toFixed(2)} · 310+50 bars`
                  : '—'}
              </span>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fast-period">{t('market.fastAverage')}</Label>
              <Select
                value={String(params.fastPeriod)}
                onValueChange={(val) =>
                  setParams({ ...params, fastPeriod: Number(val) })
                }
              >
                <SelectTrigger id="fast-period">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {fastOptions.map((option) => (
                    <SelectItem key={option} value={String(option)}>
                      {t('market.candleCount', { count: option })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="slow-period">{t('market.slowAverage')}</Label>
              <Select
                value={String(params.slowPeriod)}
                onValueChange={(val) =>
                  setParams({ ...params, slowPeriod: Number(val) })
                }
              >
                <SelectTrigger id="slow-period">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {slowOptions.map((option) => (
                    <SelectItem key={option} value={String(option)}>
                      {t('market.candleCount', { count: option })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <span
                className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground"
                id="average-label"
              >
                {t('market.averageType')}
              </span>
              <div
                className="inline-flex h-8 w-full items-center gap-0.5 rounded-sm border border-border bg-secondary/65 p-0.5"
                role="group"
                aria-labelledby="average-label"
              >
                {averageOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={cn(
                      'inline-flex h-[26px] flex-1 items-center justify-center rounded-[4px] border px-2.5 font-mono text-xs font-medium transition-all duration-150 cursor-pointer',
                      params.average === option.id
                        ? 'border-border bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.18)]'
                        : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                    aria-pressed={params.average === option.id}
                    onClick={() => setParams({ ...params, average: option.id })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {state.status === 'loading' && (
        <Card className="flex flex-col gap-2.5 p-5" role="status">
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-24" />
          </div>
          <Skeleton className="h-64 w-full" />
          <span className="sr-only">{t('market.loading')}</span>
        </Card>
      )}

      {state.status === 'error' && (
        <Card
          className="flex flex-col items-center justify-center gap-3 border-[var(--negative)]/40 bg-[var(--negative-soft)] p-6 text-center"
          role="alert"
        >
          <p className="text-xs text-[var(--negative)]">
            {t('market.loadError', { message: state.message })}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            <RefreshCw className="size-3.5" />
            <span>{t('market.retry')}</span>
          </Button>
        </Card>
      )}

      {state.status === 'success' && (
        <MarketAnalysis
          candles={state.data}
          params={params}
          pair={pair}
          timeframe={timeframe}
          onSelectPair={handlePairChange}
          onSelectTimeframe={setTimeframe}
          onChangeParams={setParams}
          strategy={strategy}
          onSaveStrategy={onSaveStrategy}
          onNavigate={onNavigate}
          streamStatus={streamStatus}
          lastTickAt={lastTickAt}
          chartHeight={
            chartHeight ?? (isFullTerminal ? 460 : compact ? 250 : 330)
          }
          defaultWheelZoomLocked={isFullTerminal}
          compact={compact}
        />
      )}
    </section>
  )
}

export default MarketSection
