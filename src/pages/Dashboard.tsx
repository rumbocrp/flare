import { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  Bot,
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
import MarketSection from '@/components/MarketSection'
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
  CardFooter,
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
import { evaluateTimeframePredictions } from '@/predictions'
import { availablePairs } from '@/strategy'
import type { BotStatus, Interval, PageId, Strategy } from '@/types'

type DashboardProps = {
  botStatus: BotStatus
  strategy?: Strategy
  backtest?: BacktestSnapshot | null
  onNavigate?: (page: PageId) => void
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

/** Primary chart height in Dashboard (Chart Studio keeps its own full height) */
const DASHBOARD_CHART_HEIGHT = 240

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

function Dashboard({
  botStatus,
  strategy,
  backtest = null,
  onNavigate,
}: DashboardProps) {
  const { locale, language } = useI18n()
  const isEs = language === 'es'

  const [snapshot, setSnapshot] = useState<BotServerSnapshot | null>(null)
  const [selectedPair, setSelectedPair] = useState<string>(
    strategy?.pair ?? availablePairs[0],
  )
  const [miniTimeframe, setMiniTimeframe] = useState<Interval>('15m')
  const [miniReloadKey, setMiniReloadKey] = useState(0)
  const [predTimeframe, setPredTimeframe] = useState<Interval>('15m')
  const [predReloadKey, setPredReloadKey] = useState(0)

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

  // Live Binance candle data for each pair's mini spark chart in `availablePairs`
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

  // Live Balance, Equity, and P&L accounting (no placeholder mock values)
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
  const connectionMode = snapshot?.connectionMode ?? 'local-fallback'
  const exchangeMode = snapshot?.exchange?.mode ?? 'demo-vault'
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

  const savedBacktestWr = useMemo(() => {
    if (!backtest || backtest.trades.length === 0) return null
    const wins = backtest.trades.filter((tr) => tr.pnl > 0).length
    return {
      winRate: (wins / backtest.trades.length) * 100,
      count: backtest.trades.length,
      pair: backtest.config.pair,
    }
  }, [backtest])

  const badgeText =
    connectionMode === 'sse-live'
      ? isEs
        ? 'SSE EN VIVO · BINANCE'
        : 'SSE LIVE · BINANCE'
      : connectionMode === 'http-server'
        ? isEs
          ? 'BACKEND HTTP · BINANCE'
          : 'HTTP BACKEND · BINANCE'
        : isEs
          ? 'MODO DEMO · LOCAL'
          : 'DEMO MODE · LOCAL'

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        title="FLARE"
        badge={badgeText}
        actions={
          onNavigate && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onNavigate('terminal')}
              >
                <Maximize2 className="size-3.5" />
                <span>{isEs ? 'Estudio Gráfico' : 'Chart Studio'}</span>
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

      {/* Band 1: Account KPI Telemetry Strip */}
      <section className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="gap-2 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
              {isEs ? 'Balance' : 'Balance'}
            </span>
            <Badge
              variant={exchangeMode === 'binance-testnet' ? 'default' : 'secondary'}
            >
              {exchangeMode === 'binance-testnet'
                ? 'TESTNET'
                : isEs
                  ? 'BÓVEDA DEMO'
                  : 'DEMO VAULT'}
            </Badge>
          </div>
          <strong className="font-mono text-xl font-bold tracking-tight text-foreground tabular-nums">
            {hasSnapshot ? formatMoney(equity) : '—'}
          </strong>
          <div className="mt-auto grid grid-cols-2 gap-2 border-t border-[var(--border-subtle)] pt-2">
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] text-muted-foreground">
                {isEs ? 'Disponible' : 'Available'}
              </span>
              <span className="font-mono text-xs font-semibold text-foreground tabular-nums">
                {hasSnapshot ? formatMoney(freeBalance) : '—'}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] text-muted-foreground">
                {isEs ? 'Tickets / USDT' : 'Locked / USDT'}
              </span>
              <span className="font-mono text-xs font-semibold text-foreground tabular-nums">
                {!hasSnapshot
                  ? '—'
                  : lockedTicketsStake > 0
                    ? formatMoney(lockedTicketsStake)
                    : usdtExchangeBal
                      ? formatMoney(usdtExchangeBal.free)
                      : formatMoney(0)}
              </span>
            </div>
          </div>
        </Card>

        <Card className="gap-2 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
              P &amp; L
            </span>
            <Badge variant={engineState?.dayHalted ? 'negative' : 'secondary'}>
              {!hasSnapshot
                ? '...'
                : engineState?.dayHalted
                  ? isEs
                    ? 'FRENO ACTIVO'
                    : 'DAY HALTED'
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
            className="h-1 w-full overflow-hidden rounded-full bg-secondary"
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

          <div className="mt-auto grid grid-cols-2 gap-2 border-t border-[var(--border-subtle)] pt-2">
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] text-muted-foreground">
                {isEs ? 'P&L Hoy' : 'Daily P&L'}
              </span>
              <span
                className={cn(
                  'font-mono text-xs font-semibold tabular-nums',
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
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="truncate font-mono text-[10px] text-muted-foreground">
                {openPos
                  ? isEs
                    ? `Abierto (${openPos.pair})`
                    : `Open (${openPos.pair})`
                  : isEs
                    ? 'ROI Total'
                    : 'Total ROI'}
              </span>
              <span
                className={cn(
                  'font-mono text-xs font-semibold tabular-nums',
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
              </span>
            </div>
          </div>
        </Card>

        <Card className="gap-2 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
              {isEs ? 'Tasa de Éxito' : 'Win Rate'}
            </span>
            <Badge variant="secondary">{historyStats.total} OPS</Badge>
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
          <div className="mt-auto grid grid-cols-2 gap-2 border-t border-[var(--border-subtle)] pt-2">
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] text-muted-foreground">
                {isEs ? 'Ganadas / Perdidas' : 'Wins / Losses'}
              </span>
              <span className="font-mono text-xs font-semibold text-foreground tabular-nums">
                {historyStats.wins}W · {historyStats.losses}L
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] text-muted-foreground">
                {isEs ? 'P&L Cerrado' : 'Realized P&L'}
              </span>
              <span
                className={cn(
                  'font-mono text-xs font-semibold tabular-nums',
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
              </span>
            </div>
          </div>
        </Card>

        <Card className="gap-2 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
              {isEs ? 'Motor & Seguridad' : 'Engine & Guard'}
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
          <div className="mt-auto grid grid-cols-2 gap-2 border-t border-[var(--border-subtle)] pt-2">
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] text-muted-foreground">
                {isEs ? 'Riesgo SL / TP' : 'Risk SL / TP'}
              </span>
              <span className="font-mono text-xs font-semibold text-foreground tabular-nums">
                {strategy?.stopLoss ?? 2}% / {strategy?.takeProfit ?? 4}%
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] text-muted-foreground">
                {isEs ? 'Tope Pérdida Día' : 'Daily Max Risk'}
              </span>
              <span className="font-mono text-xs font-semibold text-foreground tabular-nums">
                {maxDailyRiskPct}% ({formatMoney(maxDailyLossBudget)})
              </span>
            </div>
          </div>
        </Card>
      </section>

      {/* Band 2: Live 5-Pair Market Watchlist Mini Charts */}
      <section className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-xs font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            {isEs
              ? `Mercado en Vivo · Gráficas Mini (${miniTimeframe})`
              : `Live Market · Mini Charts (${miniTimeframe})`}
          </h2>
          <div className="flex flex-wrap items-center gap-1.5">
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
              variant="outline"
              size="sm"
              onClick={() => setMiniReloadKey((k) => k + 1)}
            >
              <RefreshCw className="size-3.5" />
              <span>{isEs ? 'Actualizar' : 'Refresh'}</span>
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
              <Card
                key={pairOption}
                className={cn(
                  'gap-0 overflow-hidden transition-all duration-150 hover:border-[var(--border-strong)]',
                  isSelected && 'border-primary/80 bg-secondary/50',
                )}
              >
                <button
                  type="button"
                  onClick={() => setSelectedPair(pairOption)}
                  aria-pressed={isSelected}
                  className="flex flex-col gap-2 p-3 text-left outline-none cursor-pointer"
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold text-foreground">
                      {pairOption}
                    </span>
                    {pairState.status === 'success' ? (
                      <Badge
                        variant={pctChange >= 0 ? 'positive' : 'negative'}
                        className="tabular-nums"
                      >
                        {pctChange >= 0 ? '+' : ''}
                        {pctChange.toFixed(2)}%
                      </Badge>
                    ) : (
                      <Badge variant="secondary">
                        {pairState.status === 'loading' ? '...' : 'ERR'}
                      </Badge>
                    )}
                  </div>

                  <div className="font-mono text-base font-bold text-foreground tabular-nums">
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

                  <MiniSparkChart
                    values={closes}
                    baseline={firstOpen > 0 ? firstOpen : undefined}
                    tone={trendTone}
                    label={`${pairOption} ${miniTimeframe} sparkline`}
                  />
                </button>

                <div className="flex items-center justify-between gap-2 border-t border-[var(--border-subtle)] bg-secondary/30 px-3 py-1.5 font-mono text-[10.5px] text-muted-foreground tabular-nums">
                  <span className="truncate">
                    {pairState.status === 'success'
                      ? `L ${formatAssetPrice(minLow)} · H ${formatAssetPrice(maxHigh)}`
                      : pairState.status === 'error'
                        ? pairState.message
                        : `${miniTimeframe} · ${isEs ? '48v' : '48 bars'}`}
                  </span>
                  {onNavigate && (
                    <button
                      type="button"
                      onClick={() => onNavigate('terminal')}
                      className="shrink-0 font-mono text-[10.5px] font-semibold text-primary hover:underline cursor-pointer"
                    >
                      Studio
                    </button>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      </section>

      {/* Band 3: Predictive Options Split + Executed Win-Rate History */}
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
              <ScrollArea className="h-[340px]">
                <div className="flex flex-col divide-y divide-border/70">
                  {predictionOptions.map((opt) => (
                    <div
                      key={opt.ruleId}
                      title={opt.contractQuestion}
                      className={cn(
                        'flex items-center justify-between gap-3 px-3.5 py-2.5 transition-colors hover:bg-accent/50',
                        opt.currentlyActive && 'bg-primary/5',
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
                          <span className="truncate text-xs font-medium text-foreground">
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

                      <div className="shrink-0">
                        <MiniOutcomeStrip
                          outcomes={opt.recentOutcomes}
                          label={`${opt.title}: ${opt.hits} / ${opt.triggers}`}
                        />
                      </div>
                    </div>
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
            <div className="grid grid-cols-3 gap-2 rounded-sm border border-[var(--border-subtle)] bg-secondary/35 px-2.5 py-2 font-mono tabular-nums">
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
              <div className="flex flex-1 flex-col items-center justify-center gap-2.5 rounded-sm border border-dashed border-border p-6 text-center">
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
                    <span>{isEs ? 'Ejecutar Bot' : 'Open Run Bot'}</span>
                    <ArrowRight className="size-3.5" />
                  </Button>
                )}
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-1.5 rounded-sm border border-[var(--border-subtle)] bg-secondary/35 p-2.5">
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

                <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-sm border border-[var(--border-subtle)]">
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

          {savedBacktestWr && (
            <CardFooter className="font-mono text-[11px] text-muted-foreground">
              {isEs
                ? `Último backtest guardado (${savedBacktestWr.pair}): ${savedBacktestWr.winRate.toFixed(1)}% WR en ${savedBacktestWr.count} ops.`
                : `Last saved backtest (${savedBacktestWr.pair}): ${savedBacktestWr.winRate.toFixed(1)}% WR across ${savedBacktestWr.count} trades.`}
            </CardFooter>
          )}
        </Card>
      </section>

      {/* Band 4: Primary Live Chart */}
      <Card className="p-3.5">
        <MarketSection
          strategy={strategy}
          onNavigate={onNavigate}
          selectedPair={selectedPair}
          onSelectPair={setSelectedPair}
          compact
          chartHeight={DASHBOARD_CHART_HEIGHT}
        />
      </Card>
    </div>
  )
}

export default Dashboard
