import { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  ChevronDown,
  ChevronUp,
  FlaskConical,
  Maximize2,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react'
import {
  getBotStatus,
  subscribeToBotStream,
  type BotServerSnapshot,
} from '@/api/botClient'
import type { BacktestSnapshot } from '@/backtest'
import EquityChart from '@/components/EquityChart'
import {
  MiniOutcomeStrip,
  MiniSparkChart,
} from '@/components/MiniSparkChart'
import PageHeader from '@/components/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  formatDateTime,
  formatMoney,
  formatPercent,
  formatPrice,
  formatSignedMoney,
} from '@/format'
import { useCandles } from '@/hooks/useCandles'
import { useMultiPairCandles } from '@/hooks/useMultiPairCandles'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { marketDataSource } from '@/market'
import { computeEquityPoints, computeMetrics } from '@/metrics'
import type { PredictionFocusTarget } from '@/pages/Predictions'
import { evaluateTimeframePredictions } from '@/predictions'
import { availablePairs } from '@/strategy'
import type { BotStatus, Interval, PageId, Strategy } from '@/types'

type DashboardProps = {
  botStatus: BotStatus
  strategy?: Strategy
  backtestHistory?: BacktestSnapshot[]
  onNavigate?: (page: PageId) => void
  onOpenTerminalForPair?: (pair: string) => void
  onOpenPredictionStrategy?: (target: PredictionFocusTarget) => void
}

type ExecutedOpRecord = {
  id: string
  kind: 'spot' | 'pred'
  label: string
  sideText: string
  pnlUsd: number
  won: boolean
  timeMs: number
}

const MINI_TIMEFRAMES: { id: Interval; label: string }[] = [
  { id: '5m', label: '5m' },
  { id: '15m', label: '15m' },
  { id: '1h', label: '1h' },
  { id: '4h', label: '4h' },
  { id: '1d', label: '1d' },
]

const INITIAL_BACKTESTS_SHOWN = 5

function formatAssetPrice(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) < 10) {
    return value.toLocaleString('en-US', {
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    })
  }
  return formatPrice(value)
}

function getBacktestStrategyLabel(snap: BacktestSnapshot): string {
  if (snap.label && snap.label.trim().length > 0) {
    return snap.label
  }
  const { average, fastPeriod, slowPeriod } = snap.config.params
  const shortTag = snap.config.settings.allowShort ? ' · L/S' : ''
  return `${average.toUpperCase()} ${fastPeriod}/${slowPeriod}${shortTag}`
}

function Dashboard({
  botStatus,
  strategy,
  backtestHistory = [],
  onNavigate,
  onOpenTerminalForPair,
  onOpenPredictionStrategy,
}: DashboardProps) {
  const { locale, language, t } = useI18n()
  const isEs = language === 'es'

  const [snapshot, setSnapshot] = useState<BotServerSnapshot | null>(null)
  const [selectedPair, setSelectedPair] = useState<string>(
    strategy?.pair ?? availablePairs[0],
  )
  const [miniTimeframe, setMiniTimeframe] = useState<Interval>('15m')
  const [miniReloadKey, setMiniReloadKey] = useState(0)
  const [predTimeframe, setPredTimeframe] = useState<Interval>('15m')
  const [predReloadKey, setPredReloadKey] = useState(0)
  const [selectedBacktestIdx, setSelectedBacktestIdx] = useState(0)
  const [showAllBacktests, setShowAllBacktests] = useState(false)

  useEffect(() => {
    let active = true
    getBotStatus()
      .then((snap) => {
        if (active) setSnapshot(snap)
      })
      .catch(() => {})

    const unsubscribe = subscribeToBotStream((nextSnap) => {
      if (active) setSnapshot(nextSnap)
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  // Live Binance candle data for each pair's mini spark chart
  const miniCandlesByPair = useMultiPairCandles(
    marketDataSource,
    availablePairs,
    miniTimeframe,
    48,
    miniReloadKey,
  )

  // 500-candle Binance history to evaluate predictive rules for the selected pair
  const predCandlesState = useCandles(
    marketDataSource,
    selectedPair,
    predTimeframe,
    500,
    predReloadKey,
  )

  const predictionOptions = useMemo(() => {
    if (predCandlesState.status !== 'success') return []
    return [
      ...evaluateTimeframePredictions(predTimeframe, predCandlesState.data),
    ].sort((a, b) => {
      if (a.currentlyActive !== b.currentlyActive) {
        return a.currentlyActive ? -1 : 1
      }
      return b.wilsonLowerBoundPct - a.wilsonLowerBoundPct
    })
  }, [predCandlesState, predTimeframe])

  // Live Balance, Equity, and P&L accounting
  const hasSnapshot = snapshot !== null
  const engineState = snapshot?.state
  const freeBalance = engineState?.balance ?? 0
  const initialBalance = engineState?.initialBalance ?? 0
  const dayStartBalance = engineState?.dayStartBalance ?? initialBalance
  const lockedTicketsStake =
    engineState?.activeTickets.reduce((acc, tk) => acc + tk.stakeUsd, 0) ?? 0

  const openPos = engineState?.openPosition ?? null
  const openPosPairState = openPos ? miniCandlesByPair[openPos.pair] : undefined
  const openPosLivePrice =
    openPos &&
    openPosPairState?.status === 'success' &&
    openPosPairState.data.length > 0
      ? openPosPairState.data[openPosPairState.data.length - 1].close
      : null

  const unrealizedSpotPnl =
    openPos && openPosLivePrice !== null
      ? (openPos.side === 'buy' ? 1 : -1) *
        (openPosLivePrice - openPos.entryPrice) *
        openPos.quantity
      : 0

  const equity = freeBalance + lockedTicketsStake + unrealizedSpotPnl
  const netPnl = equity - initialBalance
  const netRoiPct = initialBalance > 0 ? (netPnl / initialBalance) * 100 : 0
  const dailyPnl = equity - dayStartBalance
  const dailyPnlPct =
    dayStartBalance > 0 ? (dailyPnl / dayStartBalance) * 100 : 0

  const maxDailyRiskPct = strategy?.maxDailyRisk ?? 3
  const maxDailyLossBudget = dayStartBalance * (maxDailyRiskPct / 100)
  const dailyDrawdownUsed = Math.max(0, -dailyPnl)
  const dailyRiskUsagePct =
    maxDailyLossBudget > 0
      ? Math.min(100, (dailyDrawdownUsed / maxDailyLossBudget) * 100)
      : 0

  const isRunning = snapshot ? snapshot.running : botStatus === 'running'
  const killSwitchActive = Boolean(snapshot?.exchange?.killSwitchActive)

  const usdtExchangeBal = snapshot?.exchange?.balances.find(
    (b) => b.asset === 'USDT',
  )

  const executedHistory = useMemo<ExecutedOpRecord[]>(() => {
    if (!engineState) return []

    const spotOps: ExecutedOpRecord[] = engineState.closedTrades.map(
      (trade, idx) => ({
        id: `spot-${trade.exitTime}-${idx}`,
        kind: 'spot',
        label: trade.pair,
        sideText: trade.side === 'buy' ? 'BUY' : 'SELL',
        pnlUsd: trade.pnl,
        won: trade.pnl > 0,
        timeMs: trade.exitTime,
      }),
    )

    const predOps: ExecutedOpRecord[] = engineState.resolvedTickets.map(
      (tk) => ({
        id: `pred-${tk.id}-${tk.resolvedTime}`,
        kind: 'pred',
        label: `#${tk.ruleId.split('-')[0].toUpperCase()} ${tk.title}`,
        sideText: tk.outcome,
        pnlUsd: tk.netPnlUsd,
        won: tk.won,
        timeMs: tk.resolvedTime,
      }),
    )

    return [...spotOps, ...predOps].sort((a, b) => a.timeMs - b.timeMs)
  }, [engineState])

  const historyStats = useMemo(() => {
    const total = executedHistory.length
    const wins = executedHistory.filter((op) => op.won).length
    const losses = total - wins
    const winRate = total > 0 ? (wins / total) * 100 : null
    const realizedPnl = executedHistory.reduce(
      (acc, op) => acc + op.pnlUsd,
      0,
    )

    const cumulativeWinRates: number[] = []
    let runningWins = 0
    for (let index = 0; index < executedHistory.length; index++) {
      if (executedHistory[index].won) runningWins += 1
      cumulativeWinRates.push((runningWins / (index + 1)) * 100)
    }

    return {
      total,
      wins,
      losses,
      winRate,
      realizedPnl,
      outcomes: executedHistory.map((op) => op.won),
      cumulativeWinRates,
      recentRows: [...executedHistory].reverse().slice(0, 6),
    }
  }, [executedHistory])

  // Backtest history state (up to 5 shown until 'Show more')
  const safeBacktestIdx =
    backtestHistory.length > 0
      ? Math.min(selectedBacktestIdx, backtestHistory.length - 1)
      : 0
  const selectedBacktest = backtestHistory[safeBacktestIdx] ?? null
  const visibleBacktests = showAllBacktests
    ? backtestHistory
    : backtestHistory.slice(0, INITIAL_BACKTESTS_SHOWN)
  const hiddenBacktestCount = Math.max(
    0,
    backtestHistory.length - INITIAL_BACKTESTS_SHOWN,
  )

  const selectedBacktestPoints = useMemo(() => {
    if (!selectedBacktest) return []
    return computeEquityPoints(
      selectedBacktest.trades,
      selectedBacktest.summary.initialBalance,
      t('chart.start'),
    )
  }, [selectedBacktest, t])

  const selectedBacktestMetrics = useMemo(() => {
    if (!selectedBacktest) return null
    return computeMetrics(
      selectedBacktest.trades,
      selectedBacktest.summary.initialBalance,
    )
  }, [selectedBacktest])

  function handleOpenChart(pairToOpen: string) {
    if (onOpenTerminalForPair) {
      onOpenTerminalForPair(pairToOpen)
    } else {
      onNavigate?.('terminal')
    }
  }

  function handleExpandPrediction(ruleId: string) {
    if (onOpenPredictionStrategy) {
      onOpenPredictionStrategy({
        ruleId,
        pair: selectedPair,
        timeframe: predTimeframe,
        family: 'flare20',
      })
    } else {
      onNavigate?.('predictions')
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader
        title="FLARE"
        actions={
          onNavigate && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleOpenChart(selectedPair)}
              >
                <Maximize2 className="size-3.5" />
                <span>{isEs ? 'Gráficos' : 'Charts'}</span>
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={() => onNavigate('bot-run')}
              >
                <Bot className="size-3.5" />
                <span>{isEs ? 'Ejecutar Bot' : 'Run Bot'}</span>
                <ArrowRight className="size-3.5" />
              </Button>
            </>
          )
        }
      />

      {/* 1. Core Summary Strip: Balance, P&L, Win Rate, Bot Status */}
      <section className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Card className="gap-1.5 p-3.5">
          <span className="text-xs font-medium text-muted-foreground">
            {isEs ? 'Balance' : 'Balance'}
          </span>
          <strong className="font-mono text-xl font-bold tracking-tight text-foreground tabular-nums">
            {hasSnapshot ? formatMoney(equity) : '—'}
          </strong>
          <div className="mt-auto flex items-center justify-between gap-2 pt-1.5 font-mono text-[11px] text-muted-foreground tabular-nums">
            <span>
              {isEs ? 'Disp.' : 'Avail.'}{' '}
              <strong className="text-foreground">
                {hasSnapshot ? formatMoney(freeBalance) : '—'}
              </strong>
            </span>
            <span>
              {!hasSnapshot
                ? '—'
                : lockedTicketsStake > 0
                  ? `${isEs ? 'Bloq.' : 'Lock'} ${formatMoney(lockedTicketsStake)}`
                  : usdtExchangeBal
                    ? `USDT ${formatMoney(usdtExchangeBal.free)}`
                    : formatMoney(0)}
            </span>
          </div>
        </Card>

        <Card className="gap-1.5 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              P &amp; L
            </span>
            <Badge variant={engineState?.dayHalted ? 'negative' : 'secondary'}>
              {!hasSnapshot
                ? '...'
                : engineState?.dayHalted
                  ? isEs
                    ? 'FRENO'
                    : 'HALTED'
                  : `${dailyPnlPct >= 0 ? '+' : ''}${dailyPnlPct.toFixed(2)}% ${isEs ? 'HOY' : 'DAY'}`}
            </Badge>
          </div>
          <strong
            className={cn(
              'font-mono text-xl font-bold tracking-tight tabular-nums',
              !hasSnapshot
                ? 'text-foreground'
                : netPnl > 0
                  ? 'text-[var(--positive)]'
                  : netPnl < 0
                    ? 'text-[var(--negative)]'
                    : 'text-foreground',
            )}
          >
            {hasSnapshot ? formatSignedMoney(netPnl) : '—'}
          </strong>
          <div
            className="h-1 w-full overflow-hidden rounded-full bg-muted"
            aria-hidden="true"
          >
            <div
              className={cn(
                'h-full transition-all',
                dailyRiskUsagePct >= 85
                  ? 'bg-[var(--negative)]'
                  : dailyRiskUsagePct >= 50
                    ? 'bg-primary'
                    : 'bg-[var(--positive)]',
              )}
              style={{ width: `${dailyRiskUsagePct}%` }}
            />
          </div>
          <div className="mt-auto flex items-center justify-between gap-2 pt-0.5 font-mono text-[11px] tabular-nums">
            <span className="text-muted-foreground">
              {isEs ? 'Hoy' : 'Day'}{' '}
              <strong
                className={cn(
                  !hasSnapshot
                    ? 'text-foreground'
                    : dailyPnl > 0
                      ? 'text-[var(--positive)]'
                      : dailyPnl < 0
                        ? 'text-[var(--negative)]'
                        : 'text-foreground',
                )}
              >
                {hasSnapshot ? formatSignedMoney(dailyPnl) : '—'}
              </strong>
            </span>
            <span className="text-muted-foreground">
              {openPos ? openPos.pair : 'ROI'}{' '}
              <strong
                className={cn(
                  !hasSnapshot
                    ? 'text-foreground'
                    : (openPos ? unrealizedSpotPnl : netRoiPct) > 0
                      ? 'text-[var(--positive)]'
                      : (openPos ? unrealizedSpotPnl : netRoiPct) < 0
                        ? 'text-[var(--negative)]'
                        : 'text-foreground',
                )}
              >
                {!hasSnapshot
                  ? '—'
                  : openPos
                    ? openPosLivePrice !== null
                      ? formatSignedMoney(unrealizedSpotPnl)
                      : '—'
                    : `${netRoiPct >= 0 ? '+' : ''}${netRoiPct.toFixed(2)}%`}
              </strong>
            </span>
          </div>
        </Card>

        <Card className="gap-1.5 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {isEs ? 'Tasa de Éxito' : 'Win Rate'}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
              {historyStats.total} ops
            </span>
          </div>
          <strong
            className={cn(
              'font-mono text-xl font-bold tracking-tight tabular-nums',
              historyStats.winRate !== null
                ? historyStats.winRate >= 50
                  ? 'text-[var(--positive)]'
                  : 'text-[var(--negative)]'
                : 'text-foreground',
            )}
          >
            {historyStats.winRate !== null
              ? formatPercent(historyStats.winRate, 1)
              : '—'}
          </strong>
          <div className="mt-auto flex items-center justify-between gap-2 pt-1.5 font-mono text-[11px] tabular-nums">
            <span className="text-foreground font-semibold">
              {historyStats.wins}W · {historyStats.losses}L
            </span>
            <span
              className={cn(
                'font-semibold',
                historyStats.realizedPnl > 0
                  ? 'text-[var(--positive)]'
                  : historyStats.realizedPnl < 0
                    ? 'text-[var(--negative)]'
                    : 'text-muted-foreground',
              )}
            >
              {historyStats.total > 0
                ? formatSignedMoney(historyStats.realizedPnl)
                : formatMoney(0)}
            </span>
          </div>
        </Card>

        <Card className="gap-1.5 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {isEs ? 'Bot' : 'Bot Status'}
            </span>
            <Badge
              variant={
                killSwitchActive
                  ? 'negative'
                  : isRunning
                    ? 'positive'
                    : 'secondary'
              }
            >
              {killSwitchActive && <ShieldAlert className="size-3" />}
              {killSwitchActive
                ? 'KILL-SWITCH'
                : isRunning
                  ? isEs
                    ? 'ACTIVO'
                    : 'RUNNING'
                  : isEs
                    ? 'DETENIDO'
                    : 'STOPPED'}
            </Badge>
          </div>
          <strong className="font-mono text-xl font-bold tracking-tight text-foreground tabular-nums">
            {selectedPair}
          </strong>
          <div className="mt-auto flex items-center justify-between gap-2 pt-1.5 font-mono text-[11px] text-muted-foreground tabular-nums">
            <span>
              SL/TP{' '}
              <strong className="text-foreground">
                {strategy?.stopLoss ?? 2}%/{strategy?.takeProfit ?? 4}%
              </strong>
            </span>
            <span>
              {isEs ? 'Día' : 'Cap'}{' '}
              <strong className="text-foreground">{maxDailyRiskPct}%</strong>
            </span>
          </div>
        </Card>
      </section>

      {/* 2. Full-Bleed Mini Market Charts Strip (100% card-fill graph with blended data undertone) */}
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-xs font-semibold text-muted-foreground">
            {isEs ? `Mercado (${miniTimeframe})` : `Markets (${miniTimeframe})`}
          </h2>
          <div className="flex items-center gap-1.5">
            <Tabs
              value={miniTimeframe}
              onValueChange={(val) => setMiniTimeframe(val as Interval)}
            >
              <TabsList
                aria-label={
                  isEs ? 'Temporalidad mini' : 'Mini chart timeframe'
                }
              >
                {MINI_TIMEFRAMES.map((tf) => (
                  <TabsTrigger key={tf.id} value={tf.id} className="px-2">
                    {tf.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={isEs ? 'Actualizar mercados' : 'Refresh markets'}
              onClick={() => setMiniReloadKey((k) => k + 1)}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
          {availablePairs.map((pairOption) => {
            const pairState = miniCandlesByPair[pairOption]
            const isSelected = selectedPair === pairOption
            const candles = pairState.status === 'success' ? pairState.data : []
            const closes = candles.map((c) => c.close)
            const firstOpen = candles.length > 0 ? candles[0].open : 0
            const lastClose =
              candles.length > 0 ? candles[candles.length - 1].close : 0
            const minLow =
              candles.length > 0
                ? Math.min(...candles.map((c) => c.low))
                : 0
            const maxHigh =
              candles.length > 0
                ? Math.max(...candles.map((c) => c.high))
                : 0
            const pctChange =
              firstOpen > 0 ? ((lastClose - firstOpen) / firstOpen) * 100 : 0
            const trendTone =
              pctChange > 0
                ? 'positive'
                : pctChange < 0
                  ? 'negative'
                  : 'neutral'

            return (
              <div
                key={pairOption}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                onClick={() => setSelectedPair(pairOption)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setSelectedPair(pairOption)
                  }
                }}
                className="group relative flex h-[136px] min-w-0 cursor-pointer flex-col overflow-hidden rounded-md bg-card text-card-foreground text-left transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {/* Subtle trend & selection tint layered over the solid card surface */}
                <div
                  aria-hidden="true"
                  className={cn(
                    'pointer-events-none absolute inset-0',
                    isSelected
                      ? trendTone === 'positive'
                        ? 'bg-gradient-to-b from-primary/[0.08] via-transparent to-[var(--positive)]/[0.06]'
                        : trendTone === 'negative'
                          ? 'bg-gradient-to-b from-primary/[0.08] via-transparent to-[var(--negative)]/[0.06]'
                          : 'bg-gradient-to-b from-primary/[0.08] to-transparent'
                      : trendTone === 'positive'
                        ? 'bg-gradient-to-b from-transparent via-transparent to-[var(--positive)]/[0.06]'
                        : trendTone === 'negative'
                          ? 'bg-gradient-to-b from-transparent via-transparent to-[var(--negative)]/[0.06]'
                          : '',
                  )}
                />

                {/* Header row + tight price directly beneath */}
                <div className="relative z-10 flex shrink-0 flex-col gap-0.5 px-3 pt-2.5 pb-1">
                  <div className="flex min-h-5 items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      {isSelected && (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-primary"
                          aria-hidden="true"
                        />
                      )}
                      <span className="truncate font-mono text-xs leading-none font-semibold text-foreground">
                        {pairOption}
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      {pairState.status === 'success' ? (
                        <span
                          className={cn(
                            'font-mono text-[11px] leading-none font-semibold tabular-nums',
                            pctChange >= 0
                              ? 'text-[var(--positive)]'
                              : 'text-[var(--negative)]',
                          )}
                        >
                          {pctChange >= 0 ? '+' : ''}
                          {pctChange.toFixed(2)}%
                        </span>
                      ) : (
                        <span className="font-mono text-[10.5px] leading-none text-muted-foreground">
                          {pairState.status === 'loading' ? '...' : 'ERR'}
                        </span>
                      )}

                      {onNavigate && (
                        <button
                          type="button"
                          aria-label={
                            isEs
                              ? `Abrir gráfico grande de ${pairOption}`
                              : `Open full chart for ${pairOption}`
                          }
                          title={
                            isEs
                              ? `Abrir gráfico ${pairOption}`
                              : `Open ${pairOption} chart`
                          }
                          onClick={(e) => {
                            e.stopPropagation()
                            handleOpenChart(pairOption)
                          }}
                          className="inline-flex size-5 items-center justify-center rounded-[4px] bg-card/65 text-muted-foreground opacity-80 transition-all hover:bg-card hover:text-primary group-hover:opacity-100 cursor-pointer"
                        >
                          <Maximize2 className="size-3" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="font-mono text-lg leading-tight font-bold tracking-tight text-foreground tabular-nums">
                    {pairState.status === 'success'
                      ? `$${formatAssetPrice(lastClose)}`
                      : pairState.status === 'loading'
                        ? isEs
                          ? 'Cargando...'
                          : 'Loading...'
                        : isEs
                          ? 'Sin conexión'
                          : 'No feed'}
                  </div>
                </div>

                {/* Dedicated middle chart region — never behind header, price, or footer */}
                <div className="relative z-10 min-h-0 w-full flex-1" aria-hidden="true">
                  <MiniSparkChart
                    values={closes}
                    baseline={firstOpen > 0 ? firstOpen : undefined}
                    tone={trendTone}
                    variant="backdrop"
                    label={`${pairOption} ${miniTimeframe} sparkline`}
                  />
                </div>

                {/* Dedicated Low/High footer strip matching the bottom trend tint */}
                <div
                  className={cn(
                    'relative z-10 flex h-6 shrink-0 items-center px-3 font-mono text-[10px] leading-none tabular-nums',
                    trendTone === 'positive'
                      ? 'bg-[var(--positive)]/[0.08]'
                      : trendTone === 'negative'
                        ? 'bg-[var(--negative)]/[0.08]'
                        : 'bg-muted/20',
                  )}
                >
                  <span className="truncate text-muted-foreground/85">
                    {pairState.status === 'success' ? (
                      <>
                        <span className="text-muted-foreground/65">L</span>{' '}
                        {formatAssetPrice(minLow)}
                        <span className="mx-1 text-muted-foreground/50">·</span>
                        <span className="text-muted-foreground/65">H</span>{' '}
                        {formatAssetPrice(maxHigh)}
                      </>
                    ) : pairState.status === 'error' ? (
                      pairState.message
                    ) : (
                      `${miniTimeframe} · 48`
                    )}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* 3 & 4. Predictive Options (clickable -> expands in Predictions) + Executed Win-Rate History */}
      <section className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        <Card className="lg:col-span-7">
          <CardHeader className="px-3.5 py-2.5">
            <CardTitle>
              {isEs
                ? `Opciones Predictivas · ${selectedPair} (${predTimeframe})`
                : `Predictive Options · ${selectedPair} (${predTimeframe})`}
            </CardTitle>

            <div className="flex flex-wrap items-center gap-1.5">
              <Tabs
                value={predTimeframe}
                onValueChange={(val) => setPredTimeframe(val as Interval)}
              >
                <TabsList
                  aria-label={
                    isEs
                      ? 'Temporalidad predictiva'
                      : 'Prediction timeframe'
                  }
                >
                  {MINI_TIMEFRAMES.map((tf) => (
                    <TabsTrigger key={tf.id} value={tf.id} className="px-2">
                      {tf.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              {onNavigate && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => onNavigate('predictions')}
                >
                  <span>{isEs ? 'Ver 20' : 'View 20'}</span>
                  <ArrowRight className="size-3" />
                </Button>
              )}
            </div>
          </CardHeader>

          <CardContent className="p-0">
            {predCandlesState.status === 'loading' && (
              <div className="flex flex-col gap-2 p-3.5" role="status">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <span className="sr-only">
                  {isEs
                    ? `Evaluando ${selectedPair} (${predTimeframe})...`
                    : `Evaluating ${selectedPair} (${predTimeframe})...`}
                </span>
              </div>
            )}

            {predCandlesState.status === 'error' && (
              <div
                className="flex flex-col items-center gap-2 p-6 text-center text-xs text-[var(--negative)]"
                role="alert"
              >
                <span>
                  {isEs
                    ? `Error Binance: ${predCandlesState.message}`
                    : `Binance error: ${predCandlesState.message}`}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => setPredReloadKey((k) => k + 1)}
                >
                  <RefreshCw className="size-3" />
                  <span>{isEs ? 'Reintentar' : 'Retry'}</span>
                </Button>
              </div>
            )}

            {predCandlesState.status === 'success' && (
              <ScrollArea className="h-[310px]">
                <div className="flex flex-col gap-0.5 p-1">
                  {predictionOptions.map((opt) => (
                    <button
                      key={opt.ruleId}
                      type="button"
                      title={opt.contractQuestion}
                      onClick={() => handleExpandPrediction(opt.ruleId)}
                      className={cn(
                        'group flex w-full cursor-pointer items-center justify-between gap-3 rounded-sm px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)] outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        opt.currentlyActive && 'bg-primary/6',
                      )}
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-[11px] font-semibold text-muted-foreground">
                            #{opt.number}
                          </span>
                          <Badge
                            variant={
                              opt.predictedOutcome === 'YES'
                                ? 'positive'
                                : 'negative'
                            }
                          >
                            {opt.predictedOutcome} +{opt.horizonBars}
                            {isEs ? 'v' : 'b'}
                          </Badge>
                          {opt.currentlyActive && (
                            <Badge variant="default">
                              {isEs ? 'ACTIVA' : 'ACTIVE'}
                            </Badge>
                          )}
                          <span className="truncate text-xs font-medium text-foreground group-hover:text-primary">
                            {opt.title}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10.5px] text-muted-foreground tabular-nums">
                          <span>
                            WR{' '}
                            <strong className="text-foreground">
                              {opt.winRatePct.toFixed(1)}%
                            </strong>
                          </span>
                          <span>
                            Wilson{' '}
                            <strong className="text-foreground">
                              {opt.wilsonLowerBoundPct.toFixed(1)}%
                            </strong>
                          </span>
                          <span>
                            <strong className="text-primary">
                              ${opt.fairYesPrice.toFixed(2)}
                            </strong>
                          </span>
                          <span>
                            Kelly{' '}
                            <strong className="text-foreground">
                              {opt.quarterKellyPct.toFixed(1)}%
                            </strong>
                          </span>
                          <span>
                            {opt.hits}/{opt.triggers}
                          </span>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <MiniOutcomeStrip
                          outcomes={opt.recentOutcomes}
                          label={`${opt.title}: ${opt.hits} / ${opt.triggers}`}
                        />
                        <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-45 transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-primary group-hover:opacity-100" />
                      </div>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-5">
          <CardHeader className="px-3.5 py-2.5">
            <CardTitle>
              {isEs
                ? 'Historial de Tasa de Éxito'
                : 'Executed Win-Rate History'}
            </CardTitle>
            {onNavigate && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onNavigate('stats')}
              >
                <span>{isEs ? 'Estadísticas' : 'Statistics'}</span>
                <ArrowRight className="size-3" />
              </Button>
            )}
          </CardHeader>

          <CardContent className="flex flex-1 flex-col gap-3 p-3.5">
            <div className="grid grid-cols-3 gap-2 rounded-sm bg-muted/30 px-2.5 py-2 font-mono tabular-nums">
              <div className="flex flex-col">
                <span className="text-[10px] text-muted-foreground">OPS</span>
                <strong className="text-xs font-semibold text-foreground">
                  {historyStats.total} ({historyStats.wins}W·{historyStats.losses}L)
                </strong>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] text-muted-foreground">WIN RATE</span>
                <strong
                  className={cn(
                    'text-xs font-semibold',
                    historyStats.winRate !== null
                      ? historyStats.winRate >= 50
                        ? 'text-[var(--positive)]'
                        : 'text-[var(--negative)]'
                      : 'text-foreground',
                  )}
                >
                  {historyStats.winRate !== null
                    ? formatPercent(historyStats.winRate, 1)
                    : '—'}
                </strong>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] text-muted-foreground">P&amp;L</span>
                <strong
                  className={cn(
                    'text-xs font-semibold',
                    historyStats.realizedPnl > 0
                      ? 'text-[var(--positive)]'
                      : historyStats.realizedPnl < 0
                        ? 'text-[var(--negative)]'
                        : 'text-foreground',
                  )}
                >
                  {historyStats.total > 0
                    ? formatSignedMoney(historyStats.realizedPnl)
                    : formatMoney(0)}
                </strong>
              </div>
            </div>

            {historyStats.total === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2.5 rounded-sm bg-muted/25 p-6 text-center">
                <span className="text-xs text-muted-foreground">
                  {isEs
                    ? 'Sin operaciones cerradas en la sesión actual.'
                    : 'No closed operations in this live session yet.'}
                </span>
                {onNavigate && (
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    onClick={() => onNavigate('bot-run')}
                  >
                    <span>{isEs ? 'Ejecutar Bot' : 'Run Bot'}</span>
                    <ArrowRight className="size-3.5" />
                  </Button>
                )}
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-1.5 rounded-sm bg-muted/30 p-2.5">
                  <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span>
                      {isEs
                        ? 'Win Rate acumulado (%)'
                        : 'Cumulative Win Rate (%)'}
                    </span>
                    <MiniOutcomeStrip
                      outcomes={historyStats.outcomes}
                      label={
                        isEs
                          ? 'Resultados por operación'
                          : 'Outcomes per operation'
                      }
                    />
                  </div>
                  <MiniSparkChart
                    values={historyStats.cumulativeWinRates}
                    baseline={50}
                    tone={
                      (historyStats.winRate ?? 0) >= 50 ? 'positive' : 'negative'
                    }
                    label={
                      isEs
                        ? 'Curva de tasa de éxito acumulada'
                        : 'Cumulative win rate chart'
                    }
                  />
                </div>

                <div className="flex flex-col gap-1 rounded-sm bg-muted/20 p-1">
                  {historyStats.recentRows.map((row) => (
                    <div
                      key={row.id}
                      className="flex items-center justify-between gap-2 px-2.5 py-1.5 font-mono text-[11px] tabular-nums"
                    >
                      <Badge variant={row.won ? 'positive' : 'negative'}>
                        {row.sideText}
                      </Badge>
                      <span
                        className="min-w-0 flex-1 truncate text-foreground"
                        title={row.label}
                      >
                        {row.label}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {formatDateTime(row.timeMs, locale)}
                      </span>
                      <span
                        className={cn(
                          'shrink-0 font-semibold',
                          row.pnlUsd >= 0
                            ? 'text-[var(--positive)]'
                            : 'text-[var(--negative)]',
                        )}
                      >
                        {formatSignedMoney(row.pnlUsd)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </section>

      {/* 5. Recent Backtests Chart & Strategy Results (up to 5 until 'Show more') */}
      <section>
        <Card>
          <CardHeader className="px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <CardTitle>
                {isEs ? 'Backtests Recientes' : 'Recent Backtests'}
              </CardTitle>
              {backtestHistory.length > 0 && (
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                  {backtestHistory.length}{' '}
                  {isEs ? 'guardados' : 'runs'}
                </span>
              )}
            </div>

            {onNavigate && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onNavigate('backtest')}
              >
                <FlaskConical className="size-3" />
                <span>{isEs ? 'Nuevo Backtest' : 'Run Backtest'}</span>
                <ArrowRight className="size-3" />
              </Button>
            )}
          </CardHeader>

          <CardContent className="p-3.5 pt-2">
            {!selectedBacktest ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm bg-muted/25 px-4 py-5">
                <span className="text-xs text-muted-foreground">
                  {isEs
                    ? 'Aún no hay backtests ejecutados. Corre una simulación para ver la curva de capital y comparar estrategias aquí.'
                    : 'No backtest runs saved yet. Run a simulation to plot the equity curve and compare strategies here.'}
                </span>
                {onNavigate && (
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    onClick={() => onNavigate('backtest')}
                  >
                    <FlaskConical className="size-3.5" />
                    <span>{isEs ? 'Abrir Backtest' : 'Open Backtest'}</span>
                  </Button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
                {/* Left: Selected Backtest Equity Curve */}
                <div className="flex min-w-0 flex-col gap-2 lg:col-span-7">
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-sm bg-muted/25 px-3 py-2 font-mono text-[11px] tabular-nums">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="font-sans text-xs font-semibold text-foreground">
                        {getBacktestStrategyLabel(selectedBacktest)}
                      </strong>
                      <span className="text-muted-foreground">
                        {selectedBacktest.config.pair}
                        {selectedBacktest.timeframe
                          ? ` · ${selectedBacktest.timeframe}`
                          : ''}
                      </span>
                      <span className="text-muted-foreground">
                        SL {selectedBacktest.config.strategy.stopLoss}% / TP{' '}
                        {selectedBacktest.config.strategy.takeProfit}%
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <span
                        className={cn(
                          'font-semibold',
                          selectedBacktest.summary.returnPct > 0
                            ? 'text-[var(--positive)]'
                            : selectedBacktest.summary.returnPct < 0
                              ? 'text-[var(--negative)]'
                              : 'text-foreground',
                        )}
                      >
                        {selectedBacktest.summary.returnPct >= 0 ? '+' : ''}
                        {selectedBacktest.summary.returnPct.toFixed(2)}%
                      </span>
                      {selectedBacktestMetrics && (
                        <>
                          <span className="text-muted-foreground">
                            WR{' '}
                            <strong className="text-foreground">
                              {selectedBacktestMetrics.winRate !== null
                                ? `${selectedBacktestMetrics.winRate.toFixed(1)}%`
                                : '—'}
                            </strong>
                          </span>
                          <span className="text-muted-foreground">
                            PF{' '}
                            <strong className="text-foreground">
                              {selectedBacktestMetrics.profitFactor !== null
                                ? selectedBacktestMetrics.profitFactor.toFixed(2)
                                : '—'}
                            </strong>
                          </span>
                          <span className="text-muted-foreground">
                            DD{' '}
                            <strong className="text-[var(--negative)]">
                              -{selectedBacktestMetrics.maxDrawdownPct.toFixed(1)}%
                            </strong>
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <EquityChart
                    points={selectedBacktestPoints}
                    height={210}
                    className="bg-transparent p-0"
                  />
                </div>

                {/* Right: Recent Runs with Strategy Used (up to 5 until 'Show more') */}
                <div className="flex min-w-0 flex-col gap-1.5 lg:col-span-5">
                  <div className="flex flex-col gap-1">
                    {visibleBacktests.map((run, idx) => {
                      const isActive = idx === safeBacktestIdx
                      const wins = run.trades.filter((tr) => tr.pnl > 0).length
                      const wr =
                        run.trades.length > 0
                          ? (wins / run.trades.length) * 100
                          : null
                      const stratLabel = getBacktestStrategyLabel(run)

                      return (
                        <button
                          key={`${run.createdAt}-${idx}`}
                          type="button"
                          aria-pressed={isActive}
                          onClick={() => setSelectedBacktestIdx(idx)}
                          className={cn(
                            'flex w-full cursor-pointer items-center justify-between gap-3 rounded-sm px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            isActive
                              ? 'bg-primary/12'
                              : 'bg-muted/25 hover:bg-[var(--surface-hover)]',
                          )}
                        >
                          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div className="flex items-center gap-1.5">
                              {isActive && (
                                <span
                                  className="size-1.5 shrink-0 rounded-full bg-primary"
                                  aria-hidden="true"
                                />
                              )}
                              <span className="truncate text-xs font-semibold text-foreground">
                                {stratLabel}
                              </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-x-2 font-mono text-[10.5px] text-muted-foreground tabular-nums">
                              <span>
                                {run.config.pair}
                                {run.timeframe ? ` · ${run.timeframe}` : ''}
                              </span>
                              <span>·</span>
                              <span>
                                {run.trades.length} {isEs ? 'ops' : 'trades'}
                              </span>
                              <span>·</span>
                              <span>
                                WR {wr !== null ? `${wr.toFixed(0)}%` : '—'}
                              </span>
                            </div>
                          </div>

                          <div className="flex shrink-0 flex-col items-end gap-0.5 font-mono tabular-nums">
                            <span
                              className={cn(
                                'text-xs font-semibold',
                                run.summary.returnPct > 0
                                  ? 'text-[var(--positive)]'
                                  : run.summary.returnPct < 0
                                    ? 'text-[var(--negative)]'
                                    : 'text-foreground',
                              )}
                            >
                              {run.summary.returnPct >= 0 ? '+' : ''}
                              {run.summary.returnPct.toFixed(2)}%
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {formatSignedMoney(run.summary.netPnl)} ·{' '}
                              {formatDateTime(run.createdAt, locale)}
                            </span>
                          </div>
                        </button>
                      )
                    })}
                  </div>

                  {hiddenBacktestCount > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setShowAllBacktests((prev) => !prev)}
                      className="mt-0.5 w-full text-muted-foreground"
                    >
                      {showAllBacktests ? (
                        <>
                          <ChevronUp className="size-3.5" />
                          <span>{isEs ? 'Mostrar menos' : 'Show less'}</span>
                        </>
                      ) : (
                        <>
                          <ChevronDown className="size-3.5" />
                          <span>
                            {isEs
                              ? `Mostrar más (${hiddenBacktestCount})`
                              : `Show more (${hiddenBacktestCount})`}
                          </span>
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  )
}

export default Dashboard
