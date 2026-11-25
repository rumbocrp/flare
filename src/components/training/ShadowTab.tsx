import { memo, useMemo } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Info,
  Radio,
  RefreshCw,
  ShieldAlert,
  WifiOff,
} from 'lucide-react'
import { formatRelativeAge, formatUtcTimestamp } from '@/botRunUtils'
import MetricCard from '@/components/MetricCard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  formatDateTime,
  formatMoney,
  formatOrDash,
  formatPercent,
  formatPrice,
  formatR,
  formatSignedMoney,
} from '@/format'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  evaluateShadowDrift,
  MIN_DRIFT_SAMPLE_SIZE,
} from '@/training/shadowAndCustomize'
import type {
  TrainingLiveShadowResponse,
  TrainingRunRecord,
} from '@/training/types'

type ShadowTabProps = {
  presetId: string
  presetName: string
  run: TrainingRunRecord | null
  shadowData: TrainingLiveShadowResponse | null
  shadowLoadedAtMs: number | null
  loading: boolean
  error: string | null
  backendOffline: boolean
  nowMs: number
  onRefresh: () => void
}

const SHADOW_STALE_MS = 120_000

function computeTradeR(
  pnl: number,
  entryPrice: number,
  size: number,
  initialStopPrice?: number,
): number | null {
  if (
    typeof initialStopPrice === 'number' &&
    Number.isFinite(initialStopPrice) &&
    initialStopPrice > 0 &&
    size > 0
  ) {
    const risk = Math.abs(entryPrice - initialStopPrice) * size
    if (risk > 1e-9) {
      return pnl / risk
    }
  }
  return null
}

function ShadowTabInner({
  presetId,
  presetName,
  run,
  shadowData,
  shadowLoadedAtMs,
  loading,
  error,
  backendOffline,
  nowMs,
  onRefresh,
}: ShadowTabProps) {
  const { t, language, locale } = useI18n()

  const drift = useMemo(() => {
    const oosMetrics = run?.status === 'completed' ? run.metrics : null
    return evaluateShadowDrift({
      oosTrades: oosMetrics?.totalTrades ?? 0,
      oosWins: oosMetrics?.wins ?? 0,
      oosWinRatePct: oosMetrics?.winRate ?? null,
      shadowTrades: shadowData?.paper.count ?? 0,
      shadowWins: shadowData?.paper.wins ?? 0,
      shadowWinRatePct: shadowData?.paper.winRatePct ?? null,
    })
  }, [run, shadowData])

  if (backendOffline) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-[var(--negative-soft)] p-4 text-xs text-[var(--negative)]"
      >
        <div className="flex items-center gap-2.5">
          <WifiOff className="size-4 shrink-0" />
          <div>
            <p className="font-semibold">{t('training.offlineTitle')}</p>
            <p className="text-[11.5px] opacity-90">
              {t('training.shadowOfflineBody')}
            </p>
          </div>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onRefresh}>
          {t('training.retry')}
        </Button>
      </div>
    )
  }

  if (loading && !shadowData) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  if (error && !shadowData) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-[var(--negative-soft)] p-4 text-xs text-[var(--negative)]"
      >
        <span>{error}</span>
        <Button type="button" size="sm" variant="outline" onClick={onRefresh}>
          {t('training.retry')}
        </Button>
      </div>
    )
  }

  const isStale = Boolean(
    shadowLoadedAtMs !== null && nowMs - shadowLoadedAtMs > SHADOW_STALE_MS,
  )

  const driftBadgeVariant: 'warning' | 'positive' | 'negative' =
    drift.status === 'aligned'
      ? 'positive'
      : drift.status === 'divergent'
        ? 'negative'
        : 'warning'

  const driftBadgeText =
    drift.status === 'insufficient-sample'
      ? t('training.shadowInsufficientSample')
      : drift.status === 'aligned'
        ? t('training.shadowDriftAligned')
        : drift.status === 'warning'
          ? t('training.shadowDriftWarning')
          : t('training.shadowDriftDivergent')

  const paper = shadowData?.paper ?? null
  const testnet = shadowData?.testnet ?? null
  const mt5 = shadowData?.mt5 ?? null

  return (
    <div className="flex flex-col gap-4">
      {/* Freshness & Source Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">
            {t('training.shadowHeader', { name: presetName })}
          </h2>
          <Badge variant="outline" className="font-mono text-[10.5px]">
            {presetId}
          </Badge>
          {isStale && (
            <Badge variant="warning" className="gap-1">
              <Clock className="size-3" />
              <span>{t('training.staleBadge')}</span>
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
            /api/training/live ·{' '}
            {shadowLoadedAtMs !== null
              ? formatRelativeAge(
                  new Date(shadowLoadedAtMs).toISOString(),
                  nowMs,
                  language === 'es',
                )
              : '—'}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onRefresh}
            disabled={loading}
            className="h-7 gap-1 px-2 text-xs"
          >
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
            <span>{t('training.refresh')}</span>
          </Button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-[var(--negative-soft)] px-3.5 py-2.5 text-xs text-[var(--negative)]"
        >
          <span>{error}</span>
          <Button type="button" size="sm" variant="outline" onClick={onRefresh}>
            {t('training.retry')}
          </Button>
        </div>
      )}

      {/* 1. OOS vs Shadow Drift Comparison (Strictly gated at >= 30 both samples) */}
      <section
        aria-label={t('training.shadowDriftTitle')}
        className="flex flex-col gap-3 rounded-md bg-card p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-primary" aria-hidden="true" />
            <h3 className="text-xs font-semibold text-foreground">
              {t('training.shadowDriftTitle')}
            </h3>
          </div>
          <Badge variant={driftBadgeVariant} className="gap-1">
            {drift.status === 'aligned' ? (
              <CheckCircle2 className="size-3" />
            ) : drift.status === 'divergent' ? (
              <ShieldAlert className="size-3" />
            ) : (
              <AlertTriangle className="size-3" />
            )}
            <span>{driftBadgeText}</span>
          </Badge>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {/* OOS Expectation */}
          <div className="flex flex-col gap-1 rounded-sm bg-muted/25 p-3">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t('training.shadowOosExpected')}
            </span>
            <span className="font-mono text-base font-bold text-foreground tabular-nums">
              {formatOrDash(drift.oosWinRatePct, (v) => formatPercent(v))}
            </span>
            <span className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
              {drift.oosWilsonInterval
                ? t('training.shadowWilsonRange', {
                    low: formatPercent(drift.oosWilsonInterval.lowerPct),
                    high: formatPercent(drift.oosWilsonInterval.upperPct),
                  })
                : t('training.shadowNoOosRun')}
            </span>
            <span className="font-mono text-[10.5px] text-[var(--text-subtle)] tabular-nums">
              {t('training.shadowSampleProgress', {
                count: drift.oosSampleCount,
                min: MIN_DRIFT_SAMPLE_SIZE,
              })}
            </span>
          </div>

          {/* Shadow Paper Observed */}
          <div className="flex flex-col gap-1 rounded-sm bg-muted/25 p-3">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t('training.shadowPaperObserved')}
            </span>
            <span className="font-mono text-base font-bold text-foreground tabular-nums">
              {formatOrDash(drift.shadowWinRatePct, (v) => formatPercent(v))}
            </span>
            <span className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
              {drift.shadowWilsonInterval
                ? t('training.shadowWilsonRange', {
                    low: formatPercent(drift.shadowWilsonInterval.lowerPct),
                    high: formatPercent(drift.shadowWilsonInterval.upperPct),
                  })
                : t('training.shadowPaperEmptyShort')}
            </span>
            <span className="font-mono text-[10.5px] text-[var(--text-subtle)] tabular-nums">
              {t('training.shadowSampleProgress', {
                count: drift.shadowSampleCount,
                min: MIN_DRIFT_SAMPLE_SIZE,
              })}
            </span>
          </div>

          {/* Drift Readout (strictly suppressed below 30/30) */}
          <div className="flex flex-col gap-1 rounded-sm bg-muted/25 p-3">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t('training.shadowDriftDeltaLabel')}
            </span>
            <span
              className={cn(
                'font-mono text-base font-bold tabular-nums',
                drift.sufficient
                  ? drift.status === 'aligned'
                    ? 'text-[var(--positive)]'
                    : drift.status === 'divergent'
                      ? 'text-[var(--negative)]'
                      : 'text-[var(--warning)]'
                  : 'text-muted-foreground',
              )}
            >
              {drift.sufficient && drift.driftPp !== null
                ? `${drift.driftPp > 0 ? '+' : ''}${drift.driftPp.toFixed(1)} pp`
                : t('training.shadowInsufficientSample')}
            </span>
            <span className="text-[11px] leading-snug text-[var(--text-subtle)]">
              {drift.sufficient
                ? drift.withinWilsonInterval
                  ? t('training.shadowWithinInterval')
                  : t('training.shadowOutsideInterval')
                : t('training.shadowInsufficientExplain', {
                    oos: drift.oosSampleCount,
                    shadow: drift.shadowSampleCount,
                    min: MIN_DRIFT_SAMPLE_SIZE,
                  })}
            </span>
          </div>
        </div>
      </section>

      {/* 2. Paper Operations (engineState.closedTrades filtered by presetId) */}
      <section
        aria-label={t('training.shadowPaperTitle')}
        className="flex flex-col gap-3 rounded-md bg-card p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-foreground">
            {t('training.shadowPaperTitle')}
          </h3>
          <span className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
            engineState.closedTrades · {paper?.count ?? 0} trades
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-5">
          <MetricCard
            label={t('training.shadowSampleSize')}
            value={String(paper?.count ?? 0)}
            hint={
              paper && paper.count > 0
                ? `${paper.wins}W / ${paper.losses}L`
                : '—'
            }
          />
          <MetricCard
            label={t('training.metricWinRate')}
            value={formatOrDash(paper?.winRatePct ?? null, (v) =>
              formatPercent(v),
            )}
            hint={
              paper?.wilsonLowerBoundPct !== null &&
              paper?.wilsonLowerBoundPct !== undefined
                ? t('training.metricWilsonHint', {
                    lb: formatPercent(paper.wilsonLowerBoundPct),
                  })
                : '—'
            }
          />
          <MetricCard
            label={t('training.metricProfitFactor')}
            value={formatOrDash(paper?.profitFactor ?? null, (v) =>
              v.toFixed(2),
            )}
          />
          <MetricCard
            label={t('training.shadowRealizedPnl')}
            value={paper ? formatSignedMoney(paper.netPnlUsd) : '—'}
            tone={
              paper && paper.netPnlUsd > 0
                ? 'positive'
                : paper && paper.netPnlUsd < 0
                  ? 'negative'
                  : 'neutral'
            }
            hint={
              paper
                ? `${t('training.colFees')}: ${formatMoney(paper.totalFeesUsd)}`
                : '—'
            }
          />
          <MetricCard
            label={t('training.metricAverageR')}
            value={formatOrDash(paper?.averageR ?? null, (v) => formatR(v))}
          />
        </div>

        {!paper || paper.trades.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 rounded-sm bg-muted/20 px-4 py-6 text-center">
            <Info className="size-4 text-[var(--text-subtle)]" />
            <p className="text-xs font-medium text-foreground">
              {t('training.shadowPaperEmptyTitle')}
            </p>
            <p className="max-w-md text-[11px] text-[var(--text-subtle)]">
              {t('training.shadowPaperEmptyAction')}
            </p>
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto sm:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">{t('training.colExitTime')}</TableHead>
                    <TableHead scope="col">{t('training.fieldPair')}</TableHead>
                    <TableHead scope="col">{t('table.side')}</TableHead>
                    <TableHead scope="col" className="text-right">
                      {t('table.entry')}
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      {t('table.exit')}
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      {t('training.colFees')}
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      {t('training.colNetPnl')}
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      {t('training.colRMultiple')}
                    </TableHead>
                    <TableHead scope="col">
                      {t('training.colExitReason')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paper.trades.map((tr) => {
                    const rVal = computeTradeR(
                      tr.pnl,
                      tr.entryPrice,
                      tr.size,
                      tr.initialStopPrice,
                    )
                    const exitTs = tr.exitTime ?? Date.parse(tr.time)
                    return (
                      <TableRow key={`${tr.id}-${tr.time}`}>
                        <TableCell className="font-mono text-[11px] tabular-nums">
                          {Number.isFinite(exitTs)
                            ? formatDateTime(exitTs, locale)
                            : tr.time}
                        </TableCell>
                        <TableCell className="font-mono text-[11px]">
                          {tr.pair ?? '—'}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={tr.side === 'buy' ? 'positive' : 'negative'}
                          >
                            {tr.side.toUpperCase()}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-[11px] tabular-nums">
                          {formatPrice(tr.entryPrice)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-[11px] tabular-nums">
                          {formatPrice(tr.exitPrice)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
                          {formatMoney(tr.fees)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right font-mono text-xs font-semibold tabular-nums',
                            tr.pnl > 0
                              ? 'text-[var(--positive)]'
                              : tr.pnl < 0
                                ? 'text-[var(--negative)]'
                                : 'text-foreground',
                          )}
                        >
                          {formatSignedMoney(tr.pnl)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-[11px] tabular-nums">
                          {formatOrDash(rVal, (v) => formatR(v))}
                        </TableCell>
                        <TableCell className="font-mono text-[11px] text-muted-foreground">
                          {tr.exitReason}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>

            <div className="flex flex-col gap-2 sm:hidden">
              {paper.trades.map((tr) => {
                const rVal = computeTradeR(
                  tr.pnl,
                  tr.entryPrice,
                  tr.size,
                  tr.initialStopPrice,
                )
                const exitTs = tr.exitTime ?? Date.parse(tr.time)
                return (
                  <div
                    key={`${tr.id}-${tr.time}-m`}
                    className="flex flex-col gap-1 rounded-sm bg-muted/25 p-3 font-mono text-[11px] tabular-nums"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Badge
                        variant={tr.side === 'buy' ? 'positive' : 'negative'}
                      >
                        {tr.side.toUpperCase()} · {tr.pair ?? '—'}
                      </Badge>
                      <span
                        className={cn(
                          'font-semibold',
                          tr.pnl > 0
                            ? 'text-[var(--positive)]'
                            : tr.pnl < 0
                              ? 'text-[var(--negative)]'
                              : 'text-foreground',
                        )}
                      >
                        {formatSignedMoney(tr.pnl)} ({formatOrDash(rVal, (v) => formatR(v))})
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[var(--text-subtle)]">
                      <span>
                        {Number.isFinite(exitTs)
                          ? formatDateTime(exitTs, locale)
                          : tr.time}
                      </span>
                      <span>{tr.exitReason}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </section>

      {/* 3. Testnet / Exchange Venue Activity (Position-ID PnL when paired; order-level otherwise) */}
      <section
        aria-label={t('training.shadowTestnetTitle')}
        className="flex flex-col gap-3 rounded-md bg-card p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-foreground">
            {t('training.shadowTestnetTitle')}
          </h3>
          <Badge
            variant={testnet?.pnlAttributionAvailable ? 'positive' : 'warning'}
          >
            {testnet?.pnlAttributionAvailable
              ? t('training.shadowTestnetPnlAttributedBadge')
              : t('training.shadowTestnetNoPnlBadge')}
          </Badge>
        </div>

        {!testnet?.pnlAttributionAvailable && (
          <div
            role="note"
            className="flex items-start gap-2 rounded-sm bg-[var(--warning-soft)] px-3 py-2 text-xs text-[var(--warning)]"
          >
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>{t('training.shadowTestnetNoPnlNote')}</span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <MetricCard
            label={t('training.shadowTestnetOrders')}
            value={String(testnet?.orderCount ?? 0)}
            hint={
              testnet && (testnet.closedPositionCount ?? 0) > 0
                ? t('training.shadowPositionsCountHint', {
                    closed: testnet.closedPositionCount ?? 0,
                    open: testnet.openPositionCount ?? 0,
                  })
                : undefined
            }
          />
          <MetricCard
            label={
              testnet?.pnlAttributionAvailable
                ? t('training.shadowRealizedPnl')
                : t('training.shadowTestnetFilled')
            }
            value={
              testnet?.pnlAttributionAvailable &&
              testnet.realizedPnlUsd !== null &&
              testnet.realizedPnlUsd !== undefined
                ? formatSignedMoney(testnet.realizedPnlUsd)
                : String(testnet?.filledOrderCount ?? 0)
            }
            tone={
              testnet?.pnlAttributionAvailable &&
              typeof testnet.realizedPnlUsd === 'number'
                ? testnet.realizedPnlUsd > 0
                  ? 'positive'
                  : testnet.realizedPnlUsd < 0
                    ? 'negative'
                    : 'neutral'
                : 'neutral'
            }
            hint={
              testnet?.pnlAttributionAvailable
                ? `${t('training.shadowTestnetFilled')}: ${testnet.filledOrderCount}`
                : undefined
            }
          />
          <MetricCard
            label={
              testnet?.pnlAttributionAvailable
                ? t('training.metricWinRate')
                : t('training.shadowTestnetNotional')
            }
            value={
              testnet?.pnlAttributionAvailable
                ? formatOrDash(testnet.winRatePct ?? null, (v) =>
                    formatPercent(v),
                  )
                : formatMoney(testnet?.totalNotionalUsd ?? 0)
            }
            hint={
              testnet?.pnlAttributionAvailable
                ? `PF ${formatOrDash(testnet.profitFactor ?? null, (v) => v.toFixed(2))} · ${formatOrDash(testnet.averageR ?? null, (v) => formatR(v))}`
                : undefined
            }
          />
          <MetricCard
            label={t('training.colFees')}
            value={formatMoney(testnet?.totalFeesUsd ?? 0)}
            hint={
              testnet?.pnlAttributionAvailable
                ? `${t('training.shadowTestnetNotional')}: ${formatMoney(testnet.totalNotionalUsd)}`
                : undefined
            }
          />
        </div>

        {/* Paired Position Ledger Table (shown when entry/exit position IDs exist) */}
        {testnet?.positions && testnet.positions.length > 0 && (
          <div className="flex flex-col gap-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('training.shadowPositionsTableTitle')}
            </h4>
            <div className="hidden overflow-x-auto sm:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">{t('training.colStatus')}</TableHead>
                    <TableHead scope="col">{t('training.fieldPair')}</TableHead>
                    <TableHead scope="col" className="text-right">
                      {t('table.entry')}
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      {t('table.exit')}
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      {t('training.colNetPnl')}
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      {t('training.colRMultiple')}
                    </TableHead>
                    <TableHead scope="col">
                      {t('training.shadowColVenueIds')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {testnet.positions.map((pos) => (
                    <TableRow key={pos.id}>
                      <TableCell>
                        <Badge
                          variant={
                            pos.status === 'CLOSED' ? 'secondary' : 'default'
                          }
                        >
                          {pos.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-[11px]">
                        {pos.pair}
                      </TableCell>
                      <TableCell className="text-right font-mono text-[11px] tabular-nums">
                        {formatPrice(pos.entryAvgPrice)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-[11px] tabular-nums">
                        {formatOrDash(pos.exitAvgPrice, (v) => formatPrice(v))}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right font-mono text-xs font-semibold tabular-nums',
                          (pos.realizedPnlUsd ?? 0) > 0
                            ? 'text-[var(--positive)]'
                            : (pos.realizedPnlUsd ?? 0) < 0
                              ? 'text-[var(--negative)]'
                              : 'text-foreground',
                        )}
                      >
                        {formatOrDash(pos.realizedPnlUsd, (v) =>
                          formatSignedMoney(v),
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-[11px] tabular-nums">
                        {formatOrDash(pos.rMultiple, (v) => formatR(v))}
                      </TableCell>
                      <TableCell className="font-mono text-[10.5px] text-[var(--text-subtle)] tabular-nums">
                        #{pos.entryVenueOrderId ?? pos.entryOrderId} →{' '}
                        {pos.exitVenueOrderId
                          ? `#${pos.exitVenueOrderId}`
                          : pos.protectionOrderId
                            ? `SL:${pos.protectionOrderId}`
                            : 'OPEN'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex flex-col gap-2 sm:hidden">
              {testnet.positions.map((pos) => (
                <div
                  key={`${pos.id}-m`}
                  className="flex flex-col gap-1 rounded-sm bg-muted/25 p-3 font-mono text-[11px] tabular-nums"
                >
                  <div className="flex items-center justify-between gap-2">
                    <Badge
                      variant={pos.status === 'CLOSED' ? 'secondary' : 'default'}
                    >
                      {pos.status} · {pos.pair}
                    </Badge>
                    <span
                      className={cn(
                        'font-semibold',
                        (pos.realizedPnlUsd ?? 0) > 0
                          ? 'text-[var(--positive)]'
                          : (pos.realizedPnlUsd ?? 0) < 0
                            ? 'text-[var(--negative)]'
                            : 'text-foreground',
                      )}
                    >
                      {formatOrDash(pos.realizedPnlUsd, (v) =>
                        formatSignedMoney(v),
                      )}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[var(--text-subtle)]">
                    <span>
                      {formatPrice(pos.entryAvgPrice)} →{' '}
                      {formatOrDash(pos.exitAvgPrice, (v) => formatPrice(v))}
                    </span>
                    <span>{formatOrDash(pos.rMultiple, (v) => formatR(v))}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {!testnet || testnet.orders.length === 0 ? (
          <p className="rounded-sm bg-muted/20 px-4 py-5 text-center text-xs text-[var(--text-subtle)]">
            {t('training.shadowTestnetEmpty')}
          </p>
        ) : (
          <>
            <div className="hidden overflow-x-auto sm:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">{t('training.colWhen')}</TableHead>
                    <TableHead scope="col">{t('training.fieldPair')}</TableHead>
                    <TableHead scope="col">{t('table.side')}</TableHead>
                    <TableHead scope="col" className="text-right">
                      {t('training.shadowColNotional')}
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      {t('training.shadowColFilledQty')}
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      {t('training.shadowColAvgPrice')}
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      {t('training.colFees')}
                    </TableHead>
                    <TableHead scope="col">{t('training.colStatus')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {testnet.orders.map((ord) => {
                    const ts = Date.parse(ord.timestamp)
                    return (
                      <TableRow key={ord.id}>
                        <TableCell className="font-mono text-[11px] tabular-nums">
                          {Number.isFinite(ts)
                            ? formatDateTime(ts, locale)
                            : ord.timestamp}
                        </TableCell>
                        <TableCell className="font-mono text-[11px]">
                          {ord.pair}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              ord.side === 'BUY' ? 'positive' : 'negative'
                            }
                          >
                            {ord.side}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-[11px] tabular-nums">
                          {formatMoney(ord.notionalUsd)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-[11px] tabular-nums">
                          {formatOrDash(ord.filledQty, (v) => v.toFixed(5))}
                        </TableCell>
                        <TableCell className="text-right font-mono text-[11px] tabular-nums">
                          {formatOrDash(ord.avgPrice, (v) => formatPrice(v))}
                        </TableCell>
                        <TableCell className="text-right font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
                          {ord.fee !== null
                            ? `${ord.fee.toFixed(4)} ${ord.feeAsset ?? ''}`.trim()
                            : '—'}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              ord.status === 'FILLED'
                                ? 'positive'
                                : ord.status === 'REJECTED' ||
                                    ord.status === 'ERROR'
                                  ? 'negative'
                                  : 'secondary'
                            }
                          >
                            {ord.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>

            <div className="flex flex-col gap-2 sm:hidden">
              {testnet.orders.map((ord) => (
                <div
                  key={`${ord.id}-m`}
                  className="flex flex-col gap-1 rounded-sm bg-muted/25 p-3 font-mono text-[11px] tabular-nums"
                >
                  <div className="flex items-center justify-between gap-2">
                    <Badge
                      variant={ord.side === 'BUY' ? 'positive' : 'negative'}
                    >
                      {ord.side} · {ord.pair}
                    </Badge>
                    <Badge variant="secondary">{ord.status}</Badge>
                  </div>
                  <div className="flex items-center justify-between text-[var(--text-subtle)]">
                    <span>{formatMoney(ord.notionalUsd)}</span>
                    <span>
                      {formatOrDash(ord.avgPrice, (v) => formatPrice(v))}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {/* 4. MT5 Bridge Status (Explicitly Signal-only · execution unconfirmed) */}
      <section
        aria-label={t('training.shadowMt5Title')}
        className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-card p-4"
      >
        <div className="flex items-center gap-2.5">
          <Radio className="size-4 text-[var(--text-subtle)]" aria-hidden="true" />
          <div>
            <h3 className="text-xs font-semibold text-foreground">
              {t('training.shadowMt5Title')}
            </h3>
            <p className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
              {t('training.shadowMt5Meta', {
                state: mt5?.executionState ?? 'unconfirmed',
                polls: mt5?.pollCount ?? 0,
                lastPoll: mt5?.lastPollAt
                  ? formatUtcTimestamp(mt5.lastPollAt)
                  : '—',
              })}
            </p>
          </div>
        </div>
        <Badge variant="warning">{t('training.shadowMt5SignalOnly')}</Badge>
      </section>
    </div>
  )
}

const ShadowTab = memo(ShadowTabInner)
export default ShadowTab

