import { memo, useMemo, useState } from 'react'
import { ArrowUpRight, Play } from 'lucide-react'
import { fetchHistoricalCandlesApi } from '@/api/trainingClient'
import type { BacktestConfig, BacktestResult } from '@/backtest'
import { formatShortUtcDate } from '@/botRunUtils'
import EquityChart from '@/components/EquityChart'
import MetricCard from '@/components/MetricCard'
import TradesTable from '@/components/TradesTable'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  formatDateTime,
  formatMoney,
  formatOrDash,
  formatPercent,
  formatSignedMoney,
} from '@/format'
import { useI18n } from '@/i18n'
import { computeMetrics } from '@/metrics'
import type {
  TrainingCatalogItem,
  TrainingRunRecord,
} from '@/training/types'
import type { Candle, ChartPoint, PageId } from '@/types'
import { runBacktestOffloaded } from '@/workers/backtestClient'

type BacktestTabProps = {
  selectedItem: TrainingCatalogItem
  run: TrainingRunRecord | null
  cachedCandles: readonly Candle[] | null
  backendOffline: boolean
  onNavigate?: (page: PageId) => void
}

function BacktestTabInner({
  selectedItem,
  run,
  cachedCandles,
  backendOffline,
  onNavigate,
}: BacktestTabProps) {
  const { t, locale } = useI18n()
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    runKey: string
    backtest: BacktestResult
    candlesUsed: number
    fromMs: number
    toMs: number
    dataSource: string
  } | null>(null)

  const isPrediction = selectedItem.preset.domain === 'prediction-market'
  const lastFold =
    run?.folds && run.folds.length > 0
      ? run.folds[run.folds.length - 1]
      : null

  const testFromMs = lastFold?.testFromMs ?? run?.fromTimeMs ?? null
  const testToMs = lastFold?.testToMs ?? run?.toTimeMs ?? null
  const activeRunKey = run ? `${run.id}:${selectedItem.id}` : selectedItem.id
  const visibleResult =
    result && result.runKey === activeRunKey ? result : null

  const metrics = useMemo(() => {
    if (!visibleResult) return null
    return computeMetrics(
      visibleResult.backtest.trades,
      run?.assumptions.initialBalance ??
        selectedItem.preset.execution.initialBalance,
    )
  }, [run, selectedItem.preset.execution.initialBalance, visibleResult])

  const equityPoints = useMemo<ChartPoint[]>(() => {
    if (!visibleResult) return []
    const initBal =
      run?.assumptions.initialBalance ??
      selectedItem.preset.execution.initialBalance
    const pts: ChartPoint[] = [{ label: t('chart.start'), value: initBal }]
    for (const tr of visibleResult.backtest.trades) {
      pts.push({
        label: formatDateTime(tr.exitTime ?? Date.parse(tr.time), locale),
        value: tr.balanceAfter,
      })
    }
    return pts
  }, [locale, run, selectedItem.preset.execution.initialBalance, t, visibleResult])

  const handleRunHeldOutBacktest = async () => {
    if (!run || testFromMs === null || testToMs === null) return
    setRunning(true)
    setError(null)
    try {
      let candles: Candle[]
      let dataSource = run.dataSource
      if (
        cachedCandles &&
        cachedCandles.length > 0 &&
        cachedCandles[0].time <= run.fromTimeMs &&
        cachedCandles[cachedCandles.length - 1].time >= testToMs
      ) {
        // Keep warmup bars before testFromMs, end strictly at testToMs
        candles = cachedCandles.filter((c) => c.time <= testToMs)
      } else {
        const fetched = await fetchHistoricalCandlesApi({
          pair: run.pair,
          interval: run.timeframe,
          fromTimeMs: run.fromTimeMs,
          toTimeMs: testToMs,
        })
        candles = fetched.candles
        dataSource = fetched.source
      }

      // Slice to include sufficient MA warmup before the held-out test window
      const firstTestIdx = candles.findIndex((c) => c.time >= testFromMs)
      const warmupStart = Math.max(0, firstTestIdx >= 0 ? firstTestIdx - 60 : 0)
      const slice = candles.slice(warmupStart)

      const cfg: BacktestConfig = {
        pair: run.pair,
        params: selectedItem.preset.signalParams,
        strategy: {
          positionSize: selectedItem.preset.strategy.positionSize,
          stopLoss: selectedItem.preset.strategy.stopLoss,
          takeProfit: selectedItem.preset.strategy.takeProfit,
          maxDailyRisk: selectedItem.preset.strategy.maxDailyRisk,
        },
        settings: {
          initialBalance: run.assumptions.initialBalance,
          commissionPct: run.assumptions.commissionPct,
          slippagePct: run.assumptions.slippagePct,
          allowShort: run.assumptions.allowShort,
        },
      }

      const job = await runBacktestOffloaded(slice, cfg)
      // Restrict displayed trades strictly to entries/exits inside the held-out test window
      const heldOutTrades = job.result.trades.filter(
        (tr) => (tr.entryTime ?? Date.parse(tr.time)) >= testFromMs,
      )
      setResult({
        runKey: activeRunKey,
        backtest: { ...job.result, trades: heldOutTrades },
        candlesUsed: slice.length,
        fromMs: testFromMs,
        toMs: testToMs,
        dataSource,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  if (isPrediction) {
    return (
      <div className="rounded-md bg-card px-6 py-8 text-center text-xs text-[var(--text-subtle)]">
        {t('training.backtestPredictionNote')}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 rounded-md bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              {t('training.backtestTitle')}
            </h3>
            <p className="mt-0.5 text-xs text-[var(--text-subtle)]">
              {t('training.backtestBody')}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onNavigate && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-1 text-xs"
                onClick={() => onNavigate('backtest')}
              >
                <span>{t('training.backtestOpenFull')}</span>
                <ArrowUpRight className="size-3.5" />
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={running || !run || backendOffline}
              onClick={() => void handleRunHeldOutBacktest()}
              className="h-8 gap-1.5 text-xs"
            >
              <Play className="size-3.5" />
              <span>
                {running
                  ? t('training.backtestRunning')
                  : t('training.backtestRunCta')}
              </span>
            </Button>
          </div>
        </div>

        {run && testFromMs !== null && testToMs !== null && (
          <div className="flex flex-wrap items-center gap-3 rounded-sm bg-muted/25 px-3 py-2 font-mono text-[11px] text-muted-foreground tabular-nums">
            <Badge variant="outline">
              {run.pair} · {run.timeframe}
            </Badge>
            <span>
              {formatShortUtcDate(testFromMs)} → {formatShortUtcDate(testToMs)}
            </span>
            <span>
              Fee {formatPercent(run.assumptions.commissionPct, 2)} · Slip{' '}
              {formatPercent(run.assumptions.slippagePct, 2)} · Bal{' '}
              {formatMoney(run.assumptions.initialBalance)}
            </span>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-sm bg-[var(--negative-soft)] px-3 py-2 text-xs text-[var(--negative)]"
          >
            {error}
          </div>
        )}
      </section>

      {!visibleResult || !metrics ? (
        <div className="rounded-md bg-card px-6 py-8 text-center text-xs text-[var(--text-subtle)]">
          {t('training.backtestEmpty')}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard
              label={t('training.metricOosTrades')}
              value={String(metrics.totalTrades)}
              hint={`${metrics.wins}W / ${metrics.losses}L`}
            />
            <MetricCard
              label={t('training.metricWinRate')}
              value={formatOrDash(metrics.winRate, (v) => formatPercent(v))}
            />
            <MetricCard
              label={t('training.metricProfitFactor')}
              value={formatOrDash(metrics.profitFactor, (v) => v.toFixed(2))}
            />
            <MetricCard
              label={t('training.metricNetPnl')}
              value={formatSignedMoney(
                visibleResult.backtest.trades.reduce((acc, tr) => acc + tr.pnl, 0),
              )}
              hint={`Max DD ${formatPercent(metrics.maxDrawdownPct)}`}
            />
          </div>

          {/* Fixed-height wrapper around canonical EquityChart */}
          <div className="min-h-[296px]">
            <EquityChart points={equityPoints} height={240} />
          </div>

          <TradesTable trades={visibleResult.backtest.trades} />
        </>
      )}
    </div>
  )
}

const BacktestTab = memo(BacktestTabInner)
export default BacktestTab
