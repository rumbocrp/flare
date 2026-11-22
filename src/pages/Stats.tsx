import { useEffect, useState } from 'react'
import { ArrowRight, Maximize2, X } from 'lucide-react'
import { getBotStatus, type BotServerSnapshot } from '@/api/botClient'
import type { BacktestSnapshot } from '@/backtest'
import EquityChart from '@/components/EquityChart'
import MetricCard from '@/components/MetricCard'
import PageHeader from '@/components/PageHeader'
import TradesTable from '@/components/TradesTable'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  formatDateTime,
  formatMoney,
  formatOrDash,
  formatPercent,
  formatSignedMoney,
} from '@/format'
import { useI18n, type TranslationKey } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  computeEquityPoints,
  computeMetrics,
  computeStrategyDiagnostics,
  startingBalance,
} from '@/metrics'
import { tradePnl } from '@/trades'
import type { PageId, Strategy, Tone, Trade } from '@/types'

type TradeFilter = 'all' | 'wins' | 'losses'
type TradeSource = 'backtest' | 'bot'
type DiagTab = 'edge' | 'pairs' | 'exits'

type StatsProps = {
  backtest: BacktestSnapshot | null
  strategy: Strategy
  onNavigate: (page: PageId) => void
}

const filterOptions: { id: TradeFilter; labelKey: TranslationKey }[] = [
  { id: 'all', labelKey: 'stats.filterAll' },
  { id: 'wins', labelKey: 'stats.filterWins' },
  { id: 'losses', labelKey: 'stats.filterLosses' },
]

function toneOf(value: number | null, threshold = 0): Tone {
  if (value === null) return 'neutral'
  if (value > threshold) return 'positive'
  if (value < threshold) return 'negative'
  return 'neutral'
}

function signedPercent(value: number, digits = 2): string {
  const prefix = value > 0 ? '+' : ''
  return `${prefix}${value.toFixed(digits)}%`
}

function valToneClass(value: number | null): string {
  if (value === null || value === 0) return 'text-foreground'
  return value > 0 ? 'text-[var(--positive)]' : 'text-[var(--negative)]'
}

function Stats({ backtest, strategy, onNavigate }: StatsProps) {
  const { locale, t } = useI18n()
  const [filter, setFilter] = useState<TradeFilter>('all')
  const [pairFilter, setPairFilter] = useState<string | null>(null)
  const [diagTab, setDiagTab] = useState<DiagTab>('edge')
  const [source, setSource] = useState<TradeSource>(
    backtest ? 'backtest' : 'bot',
  )
  const [botSnapshot, setBotSnapshot] = useState<BotServerSnapshot | null>(null)

  useEffect(() => {
    let active = true
    getBotStatus().then((snap) => {
      if (active) setBotSnapshot(snap)
    })
    return () => {
      active = false
    }
  }, [])

  const botTrades = botSnapshot?.state.closedTrades ?? []

  const activeTrades: Trade[] =
    source === 'backtest' ? (backtest ? backtest.trades : []) : botTrades
  const initialBalance =
    source === 'backtest'
      ? backtest
        ? backtest.summary.initialBalance
        : startingBalance
      : (botSnapshot?.state.initialBalance ??
        botSnapshot?.preset.execution.initialBalance ??
        startingBalance)

  const metrics = computeMetrics(activeTrades, initialBalance)
  const diag = computeStrategyDiagnostics(activeTrades, initialBalance)
  const equityPoints = computeEquityPoints(
    activeTrades,
    initialBalance,
    t('chart.start'),
  )

  const visibleTrades = activeTrades.filter((trade) => {
    if (pairFilter && trade.pair !== pairFilter) return false
    const pnl = tradePnl(trade)
    if (filter === 'wins') return pnl > 0
    if (filter === 'losses') return pnl < 0
    return true
  })

  function handleChangeSource(next: TradeSource) {
    setSource(next)
    setPairFilter(null)
  }

  const hasData = activeTrades.length > 0
  const maxPairAbsPnl = Math.max(
    1,
    ...diag.byPair.map((row) => Math.abs(row.netPnl)),
  )

  const targetRR = strategy.takeProfit / Math.max(0.1, strategy.stopLoss)

  const winRateHint =
    diag.breakEvenWinRatePct !== null && diag.winRateEdgePp !== null
      ? t('stats.winRateEdgeHint', {
        wins: metrics.wins,
        total: metrics.totalTrades,
        be: formatPercent(diag.breakEvenWinRatePct, 1),
        edge: `${diag.winRateEdgePp >= 0 ? '+' : ''}${diag.winRateEdgePp.toFixed(1)} pp`,
      })
      : t('stats.winRateHint', {
        wins: metrics.wins,
        total: metrics.totalTrades,
      })

  const profitFactorValue =
    metrics.profitFactor !== null
      ? metrics.profitFactor.toFixed(2)
      : diag.grossProfit > 0
        ? '∞'
        : '—'

  const expectancyHint =
    metrics.expectancy === null
      ? '—'
      : diag.expectancyR !== null
        ? t('stats.pfExpectancyRHint', {
          exp: formatSignedMoney(metrics.expectancy),
          r: `${diag.expectancyR >= 0 ? '+' : ''}${diag.expectancyR.toFixed(2)}`,
        })
        : t('stats.pfExpectancyHint', {
          exp: formatSignedMoney(metrics.expectancy),
        })

  const hasDrawdown = metrics.maxDrawdown > 0
  const drawdownHint = !hasDrawdown
    ? t('stats.noDrawdown')
    : diag.recoveryFactor !== null
      ? t('stats.drawdownRecoveryHint', {
        dd: formatMoney(-metrics.maxDrawdown),
        rec: diag.recoveryFactor.toFixed(2),
      })
      : t('stats.drawdownLossStreakHint', {
        dd: formatMoney(-metrics.maxDrawdown),
        streak: diag.maxLossStreak,
      })

  const streakText =
    diag.currentStreak > 0
      ? t('stats.streakWin', { count: diag.currentStreak })
      : diag.currentStreak < 0
        ? t('stats.streakLoss', { count: Math.abs(diag.currentStreak) })
        : t('stats.streakFlat')

  const insightCopy =
    diag.winRateEdgePp === null
      ? t('stats.insightNeutral', {
        sl: strategy.stopLoss.toFixed(1),
        tp: strategy.takeProfit.toFixed(1),
      })
      : diag.winRateEdgePp >= 0
        ? t('stats.insightPositive', {
          pp: diag.winRateEdgePp.toFixed(1),
          pair: strategy.pair,
        })
        : t('stats.insightNegative', {
          pp: Math.abs(diag.winRateEdgePp).toFixed(1),
        })

  const meterWidthPct = Math.min(100, Math.max(0, metrics.winRate ?? 0))
  const meterBarColor =
    diag.winRateEdgePp === null
      ? 'bg-primary'
      : diag.winRateEdgePp >= 0
        ? 'bg-[var(--positive)]'
        : 'bg-[var(--negative)]'

  const sourceEmptyMessage =
    source === 'backtest' ? t('stats.emptyBacktest') : t('stats.emptyBot')

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('stats.title')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Tabs
              value={source}
              onValueChange={(val) => handleChangeSource(val as TradeSource)}
            >
              <TabsList aria-label={t('stats.sourceAria')}>
                <TabsTrigger value="backtest">
                  {t('stats.sourceBacktest')}
                </TabsTrigger>
                <TabsTrigger value="bot">
                  {t('stats.sourceBot')}
                  {botTrades.length > 0 && (
                    <Badge variant="secondary" className="ml-0.5 px-1 py-0 text-[9px]">
                      {botTrades.length}
                    </Badge>
                  )}
                </TabsTrigger>
              </TabsList>
            </Tabs>

            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => onNavigate('terminal')}
            >
              <Maximize2 className="size-3.5" />
              <span>{t('stats.openTerminal')}</span>
            </Button>
          </div>
        }
      />

      {!hasData ? (
        <Card className="items-center justify-center gap-3 p-8 text-center">
          <p className="max-w-md text-xs text-muted-foreground">
            {sourceEmptyMessage}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() =>
                onNavigate(source === 'backtest' ? 'backtest' : 'bot-run')
              }
            >
              <span>
                {source === 'backtest'
                  ? t('stats.openBacktest')
                  : t('stats.openBot')}
              </span>
              <ArrowRight className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                onNavigate(source === 'backtest' ? 'bot-run' : 'backtest')
              }
            >
              <span>
                {source === 'backtest'
                  ? t('stats.openBot')
                  : t('stats.openBacktest')}
              </span>
            </Button>
          </div>
        </Card>
      ) : (
        <>
          {/* 4-column core KPI telemetry */}
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            <MetricCard
              label={t('stats.netReturn')}
              value={formatSignedMoney(diag.netPnl)}
              hint={t('stats.netReturnHint', {
                pct: signedPercent(diag.returnPct, 2),
                balance: formatMoney(diag.finalBalance),
              })}
              tone={toneOf(diag.netPnl)}
            />
            <MetricCard
              label={t('stats.winRate')}
              value={formatOrDash(metrics.winRate, formatPercent)}
              hint={winRateHint}
              tone={
                diag.winRateEdgePp !== null
                  ? toneOf(diag.winRateEdgePp)
                  : toneOf(metrics.winRate, 50)
              }
            />
            <MetricCard
              label={t('stats.profitFactor')}
              value={profitFactorValue}
              hint={expectancyHint}
              tone={toneOf(metrics.expectancy)}
            />
            <MetricCard
              label={t('stats.maxDrawdown')}
              value={
                hasDrawdown
                  ? formatMoney(-metrics.maxDrawdown)
                  : formatMoney(0)
              }
              hint={drawdownHint}
              tone={hasDrawdown ? 'negative' : 'neutral'}
            />
          </div>

          {/* Equity evolution + Strategy diagnostics split */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
            <Card className="lg:col-span-7">
              <CardHeader className="px-3.5 py-2.5">
                <CardTitle>{t('stats.balanceEvolution')}</CardTitle>
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                  {t('stats.equityMeta', {
                    initial: formatMoney(initialBalance),
                    count: activeTrades.length,
                  })}
                </span>
              </CardHeader>

              <CardContent className="p-3">
                <EquityChart points={equityPoints} />
              </CardContent>

              <CardFooter className="grid grid-cols-3 gap-2 bg-muted/25 px-3.5 py-2.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[11px] text-muted-foreground">
                    {t('stats.bestTrade')}
                  </span>
                  <strong
                    className={cn(
                      'font-mono text-xs font-semibold tabular-nums',
                      valToneClass(metrics.bestTrade),
                    )}
                  >
                    {formatOrDash(metrics.bestTrade, formatSignedMoney)}
                  </strong>
                </div>

                <div className="flex flex-col gap-0.5">
                  <span className="text-[11px] text-muted-foreground">
                    {t('stats.worstTrade')}
                  </span>
                  <strong
                    className={cn(
                      'font-mono text-xs font-semibold tabular-nums',
                      valToneClass(metrics.worstTrade),
                    )}
                  >
                    {formatOrDash(metrics.worstTrade, formatSignedMoney)}
                  </strong>
                </div>

                <div className="flex flex-col gap-0.5">
                  <span className="text-[11px] text-muted-foreground">
                    {t('stats.currentStreak')}
                  </span>
                  <strong
                    className={cn(
                      'font-mono text-xs font-semibold tabular-nums',
                      valToneClass(
                        diag.currentStreak === 0 ? null : diag.currentStreak,
                      ),
                    )}
                  >
                    {streakText}
                  </strong>
                </div>
              </CardFooter>
            </Card>

            <Card className="lg:col-span-5">
              <CardHeader className="px-3.5 py-2">
                <CardTitle>{t('stats.diagnosticsTitle')}</CardTitle>
                <Tabs
                  value={diagTab}
                  onValueChange={(val) => setDiagTab(val as DiagTab)}
                >
                  <TabsList aria-label={t('stats.diagTabAria')}>
                    <TabsTrigger value="edge">{t('stats.diagEdge')}</TabsTrigger>
                    <TabsTrigger value="pairs">{t('stats.diagPairs')}</TabsTrigger>
                    <TabsTrigger value="exits">{t('stats.diagExits')}</TabsTrigger>
                  </TabsList>
                </Tabs>
              </CardHeader>

              <CardContent className="flex flex-1 flex-col gap-3 p-3.5">
                {diagTab === 'edge' && (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                        <span className="font-semibold text-muted-foreground">
                          {t('stats.breakEvenMeter')}
                        </span>
                        <span className="text-foreground tabular-nums">
                          {formatOrDash(metrics.winRate, (v) =>
                            formatPercent(v, 1),
                          )}
                          {diag.breakEvenWinRatePct !== null
                            ? ` / ${t('stats.breakEvenLabel', {
                              pct: formatPercent(
                                diag.breakEvenWinRatePct,
                                1,
                              ),
                            })}`
                            : ''}
                        </span>
                      </div>
                      <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn('h-full transition-all', meterBarColor)}
                          style={{ width: `${meterWidthPct}%` }}
                        />
                        {diag.breakEvenWinRatePct !== null && (
                          <span
                            className="absolute inset-y-0 w-0.5 bg-foreground"
                            style={{
                              left: `${Math.min(
                                100,
                                Math.max(0, diag.breakEvenWinRatePct),
                              )}%`,
                            }}
                            aria-hidden="true"
                          />
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div className="flex flex-col gap-0.5 rounded-sm bg-muted/30 px-2.5 py-2">
                        <span className="text-[11px] text-muted-foreground">
                          {t('stats.averageWin')}
                        </span>
                        <strong
                          className={cn(
                            'font-mono text-xs font-semibold tabular-nums',
                            valToneClass(metrics.averageWin),
                          )}
                        >
                          {formatOrDash(metrics.averageWin, formatSignedMoney)}
                        </strong>
                      </div>

                      <div className="flex flex-col gap-0.5 rounded-sm bg-muted/30 px-2.5 py-2">
                        <span className="text-[11px] text-muted-foreground">
                          {t('stats.averageLoss')}
                        </span>
                        <strong
                          className={cn(
                            'font-mono text-xs font-semibold tabular-nums',
                            valToneClass(metrics.averageLoss),
                          )}
                        >
                          {formatOrDash(metrics.averageLoss, formatSignedMoney)}
                        </strong>
                      </div>

                      <div className="flex flex-col gap-0.5 rounded-sm bg-muted/30 px-2.5 py-2">
                        <span className="text-[11px] text-muted-foreground">
                          {t('stats.payoffRealized')}
                        </span>
                        <strong className="font-mono text-xs font-semibold text-foreground tabular-nums">
                          {diag.payoffRatio !== null
                            ? `${diag.payoffRatio.toFixed(2)}R`
                            : '—'}
                        </strong>
                      </div>

                      <div className="flex flex-col gap-0.5 rounded-sm bg-muted/30 px-2.5 py-2">
                        <span className="text-[11px] text-muted-foreground">
                          {t('stats.targetRiskReward')}
                        </span>
                        <strong className="font-mono text-xs font-semibold text-foreground tabular-nums">
                          {`${targetRR.toFixed(2)}R (-${strategy.stopLoss}%/+${strategy.takeProfit}%)`}
                        </strong>
                      </div>

                      <div className="flex flex-col gap-0.5 rounded-sm bg-muted/30 px-2.5 py-2">
                        <span className="text-[11px] text-muted-foreground">
                          {t('stats.longBias')}
                        </span>
                        <strong
                          className={cn(
                            'font-mono text-xs font-semibold tabular-nums',
                            valToneClass(diag.longs.netPnl),
                          )}
                        >
                          {diag.longs.count > 0
                            ? `${formatSignedMoney(diag.longs.netPnl)} · ${formatOrDash(diag.longs.winRate, (v) => formatPercent(v, 0))}`
                            : '—'}
                        </strong>
                      </div>

                      <div className="flex flex-col gap-0.5 rounded-sm bg-muted/30 px-2.5 py-2">
                        <span className="text-[11px] text-muted-foreground">
                          {t('stats.shortBias')}
                        </span>
                        <strong
                          className={cn(
                            'font-mono text-xs font-semibold tabular-nums',
                            valToneClass(diag.shorts.netPnl),
                          )}
                        >
                          {diag.shorts.count > 0
                            ? `${formatSignedMoney(diag.shorts.netPnl)} · ${formatOrDash(diag.shorts.winRate, (v) => formatPercent(v, 0))}`
                            : '—'}
                        </strong>
                      </div>

                      <div className="flex flex-col gap-0.5 rounded-sm bg-muted/30 px-2.5 py-2">
                        <span className="text-[11px] text-muted-foreground">
                          {t('stats.worstLossStreak')}
                        </span>
                        <strong
                          className={cn(
                            'font-mono text-xs font-semibold tabular-nums',
                            diag.maxLossStreak >= 3
                              ? 'text-[var(--negative)]'
                              : 'text-foreground',
                          )}
                        >
                          {t('stats.streakEstRisk', {
                            count: diag.maxLossStreak,
                            pct: (
                              diag.maxLossStreak *
                              strategy.stopLoss *
                              (strategy.positionSize / 100)
                            ).toFixed(1),
                          })}
                        </strong>
                      </div>

                      <div className="flex flex-col gap-0.5 rounded-sm bg-muted/30 px-2.5 py-2">
                        <span className="text-[11px] text-muted-foreground">
                          {t('stats.recoveryFactor')}
                        </span>
                        <strong
                          className={cn(
                            'font-mono text-xs font-semibold tabular-nums',
                            valToneClass(diag.recoveryFactor),
                          )}
                        >
                          {diag.recoveryFactor !== null
                            ? `${diag.recoveryFactor.toFixed(2)}×`
                            : '—'}
                        </strong>
                      </div>
                    </div>

                    <div className="mt-auto flex flex-wrap items-center justify-between gap-2 rounded-sm bg-muted/35 px-3 py-2.5">
                      <p className="min-w-0 flex-1 text-[11.5px] leading-snug text-muted-foreground">
                        {insightCopy}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => onNavigate('terminal')}
                      >
                        <span>{t('stats.calibrateTerminal')}</span>
                        <ArrowRight className="size-3" />
                      </Button>
                    </div>
                  </>
                )}

                {diagTab === 'pairs' && (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">
                        {t('stats.pairsHint')}
                      </span>
                      {pairFilter && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => setPairFilter(null)}
                        >
                          {t('stats.clearPairFilter')}
                        </Button>
                      )}
                    </div>

                    <div className="flex flex-col gap-1.5">
                      {diag.byPair.map((row) => {
                        const barWidth = Math.max(
                          6,
                          (Math.abs(row.netPnl) / maxPairAbsPnl) * 100,
                        )
                        const isSelected = pairFilter === row.pair
                        return (
                          <button
                            key={row.pair}
                            type="button"
                            aria-pressed={isSelected}
                            onClick={() =>
                              setPairFilter(isSelected ? null : row.pair)
                            }
                            className={cn(
                              'flex flex-col gap-1.5 rounded-sm p-2.5 text-left transition-all duration-150 cursor-pointer',
                              isSelected
                                ? 'bg-primary/14'
                                : 'bg-muted/30 hover:bg-muted/50',
                            )}
                          >
                            <div className="flex items-center justify-between gap-2 font-mono text-xs tabular-nums">
                              <span className="font-semibold text-foreground">
                                {row.pair}
                              </span>
                              <span className="text-[11px] text-muted-foreground">
                                {t('stats.pairMeta', {
                                  wins: row.wins,
                                  total: row.count,
                                  wr: formatOrDash(row.winRate, (v) =>
                                    formatPercent(v, 0),
                                  ),
                                })}
                              </span>
                              <span
                                className={cn(
                                  'font-semibold',
                                  row.netPnl > 0
                                    ? 'text-[var(--positive)]'
                                    : row.netPnl < 0
                                      ? 'text-[var(--negative)]'
                                      : 'text-foreground',
                                )}
                              >
                                {formatSignedMoney(row.netPnl)}
                              </span>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                              <div
                                className={cn(
                                  'h-full',
                                  row.netPnl > 0
                                    ? 'bg-[var(--positive)]'
                                    : row.netPnl < 0
                                      ? 'bg-[var(--negative)]'
                                      : 'bg-muted-foreground',
                                )}
                                style={{ width: `${barWidth}%` }}
                              />
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {diagTab === 'exits' && (
                  <div className="flex flex-col gap-2.5">
                    {diag.exits.length === 0 ? (
                      <div className="flex flex-col items-center gap-2.5 py-6 text-center">
                        <p className="text-xs text-muted-foreground">
                          {t('stats.noExitData')}
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => onNavigate('backtest')}
                        >
                          <span>{t('stats.openBacktest')}</span>
                          <ArrowRight className="size-3.5" />
                        </Button>
                      </div>
                    ) : (
                      <>
                        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                          {t('stats.exitsBreakdown')}
                        </span>
                        <div className="flex flex-col gap-2">
                          {diag.exits.map((ex) => (
                            <div
                              key={ex.reason}
                              className="flex flex-col gap-1 rounded-sm bg-muted/30 p-2.5"
                            >
                              <div className="flex items-center justify-between gap-2 font-mono text-xs tabular-nums">
                                <span className="font-medium text-foreground">
                                  {t(`exit.${ex.reason}`)}
                                </span>
                                <span className="text-[11px] text-muted-foreground">
                                  {ex.count} ({formatPercent(ex.sharePct, 0)})
                                </span>
                                <span
                                  className={cn(
                                    'font-semibold',
                                    ex.netPnl > 0
                                      ? 'text-[var(--positive)]'
                                      : ex.netPnl < 0
                                        ? 'text-[var(--negative)]'
                                        : 'text-foreground',
                                  )}
                                >
                                  {formatSignedMoney(ex.netPnl)}
                                </span>
                              </div>
                              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                                <div
                                  className={cn(
                                    'h-full',
                                    ex.netPnl > 0
                                      ? 'bg-[var(--positive)]'
                                      : ex.netPnl < 0
                                        ? 'bg-[var(--negative)]'
                                        : 'bg-muted-foreground',
                                  )}
                                  style={{
                                    width: `${Math.max(4, ex.sharePct)}%`,
                                  }}
                                />
                              </div>
                            </div>
                          ))}
                        </div>

                        {diag.totalFees !== null && (
                          <div className="grid grid-cols-2 gap-2">
                            <div className="flex flex-col gap-0.5 rounded-sm bg-muted/30 px-2.5 py-2">
                              <span className="font-mono text-[10px] uppercase tracking-[0.05em] text-muted-foreground">
                                {t('stats.totalFees')}
                              </span>
                              <strong className="font-mono text-xs font-semibold text-foreground tabular-nums">
                                {formatMoney(-diag.totalFees)}
                              </strong>
                            </div>
                            <div className="flex flex-col gap-0.5 rounded-sm bg-muted/30 px-2.5 py-2">
                              <span className="font-mono text-[10px] uppercase tracking-[0.05em] text-muted-foreground">
                                {t('stats.feeDrag', {
                                  pct:
                                    diag.grossProfit > 0
                                      ? (
                                        (diag.totalFees / diag.grossProfit) *
                                        100
                                      ).toFixed(1)
                                      : '0.0',
                                })}
                              </span>
                              <strong className="font-mono text-xs font-semibold text-foreground tabular-nums">
                                {formatMoney(diag.grossProfit)}
                              </strong>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Filtered Operations Table */}
          <section className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display text-sm font-semibold uppercase tracking-[0.06em] text-foreground">
                  {t('stats.operations', { count: visibleTrades.length })}
                </h2>
                {pairFilter && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => setPairFilter(null)}
                    className="gap-1 bg-primary/14 text-primary"
                  >
                    <span>{pairFilter}</span>
                    <X className="size-3" />
                  </Button>
                )}
              </div>

              <Tabs
                value={filter}
                onValueChange={(val) => setFilter(val as TradeFilter)}
              >
                <TabsList aria-label={t('stats.filterAria')}>
                  {filterOptions.map((option) => (
                    <TabsTrigger key={option.id} value={option.id}>
                      {t(option.labelKey)}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>

            <TradesTable trades={visibleTrades} />
          </section>

          {source === 'backtest' && backtest && (
            <Card className="flex-row flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-xs">
              <div>
                <strong className="text-foreground">
                  {t('stats.lastBacktest')}{' '}
                </strong>
                <span className="font-mono text-muted-foreground">
                  {t('stats.lastBacktestReadout', {
                    pair: backtest.config.pair,
                    candles: backtest.candles.count,
                    date: formatDateTime(backtest.createdAt, locale),
                    trades: backtest.trades.length,
                  })}
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => onNavigate('backtest')}
              >
                <span>{t('stats.openBacktest')}</span>
                <ArrowRight className="size-3" />
              </Button>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

export default Stats
