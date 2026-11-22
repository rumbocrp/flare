import { memo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  FlaskConical,
  Info,
  ShieldAlert,
} from 'lucide-react'
import {
  formatRelativeAge,
  formatShortUtcDate,
  formatUtcTimestamp,
} from '@/botRunUtils'
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
  formatMoney,
  formatOrDash,
  formatPercent,
  formatR,
  formatSignedMoney,
} from '@/format'
import { useI18n, type TranslationKey } from '@/i18n'
import type {
  HistoricalCandlesMissingSpan,
  TrainingLiveShadowResponse,
  TrainingRunRecord,
  TrainingVerdict,
} from '@/training/types'

type OverviewTabProps = {
  run: TrainingRunRecord | null
  presetName: string
  loading: boolean
  error: string | null
  partialMissingSpans: readonly HistoricalCandlesMissingSpan[]
  shadowData: TrainingLiveShadowResponse | null
  configuredToTimeMs: number
  nowMs: number
  onRetry: () => void
}

function verdictVariant(
  verdict: TrainingVerdict,
): 'positive' | 'warning' | 'negative' | 'violet' {
  if (verdict === 'eligible') return 'positive'
  if (verdict === 'override') return 'violet'
  if (verdict === 'insufficient') return 'warning'
  return 'negative'
}

function verdictLabelKey(verdict: TrainingVerdict): TranslationKey {
  if (verdict === 'eligible') return 'training.verdictEligible'
  if (verdict === 'override') return 'training.verdictOverride'
  if (verdict === 'insufficient') return 'training.verdictInsufficient'
  return 'training.verdictBelow'
}

function OverviewTabInner({
  run,
  presetName,
  loading,
  error,
  partialMissingSpans,
  shadowData,
  configuredToTimeMs,
  nowMs,
  onRetry,
}: OverviewTabProps) {
  const { t, language } = useI18n()
  const [showCandidates, setShowCandidates] = useState(false)

  if (loading && !run) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-20 w-full" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-[var(--negative-soft)] p-4 text-xs text-[var(--negative)]"
      >
        <span>{error}</span>
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          {t('training.retry')}
        </Button>
      </div>
    )
  }

  const metrics = run?.metrics ?? null
  const folds = run?.folds ?? []
  const isStale = Boolean(
    run &&
      run.status === 'completed' &&
      configuredToTimeMs > run.toTimeMs + 3_600_000,
  )

  const totalShadowOps =
    (shadowData?.paper.count ?? 0) + (shadowData?.testnet.filledOrderCount ?? 0)
  const valTradesSum = folds.reduce((acc, f) => acc + f.valTrades, 0)
  const latestFold = folds[folds.length - 1] ?? null

  return (
    <div className="flex flex-col gap-4">
      {/* 4-Stage Pipeline Funnel Strip: Fit -> Validate -> Test -> Shadow */}
      <section aria-label={t('training.funnelAria')}>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          {/* Stage 1: Fit */}
          <div className="flex flex-col gap-1 rounded-md bg-card p-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-foreground">
                {t('training.stageFit')}
              </span>
              <Badge variant={metrics ? 'positive' : 'secondary'}>
                {metrics
                  ? run?.kind === 'walk-forward'
                    ? t('training.stageCandidatesCount', {
                        count: metrics.candidatesEvaluated ?? 0,
                      })
                    : run?.kind === 'meta-filter'
                      ? `${metrics.metaComparison?.trainSamples ?? 0} smp`
                      : `${metrics.predictionSummary?.calibration.length ?? 0} rules`
                  : t('training.emptyFit')}
              </Badge>
            </div>
            <p className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
              {metrics
                ? `${run?.dataSource ?? 'binance'} · ${run?.candleCount ?? 0} bars`
                : '—'}
            </p>
          </div>

          {/* Stage 2: Validate */}
          <div className="flex flex-col gap-1 rounded-md bg-card p-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-foreground">
                {t('training.stageValidate')}
              </span>
              <Badge variant={metrics && folds.length > 0 ? 'positive' : 'secondary'}>
                {metrics && folds.length > 0
                  ? run?.kind === 'meta-filter'
                    ? `${metrics.metaComparison?.valSamples ?? 0} val`
                    : `${valTradesSum} trades`
                  : t('training.emptyValidate')}
              </Badge>
            </div>
            <p className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
              {metrics && latestFold
                ? latestFold.valProfitFactor !== null
                  ? `PF ${latestFold.valProfitFactor.toFixed(2)} · DD ${formatPercent(latestFold.valMaxDrawdownPct)}`
                  : `${folds.length} fold(s)`
                : '—'}
            </p>
          </div>

          {/* Stage 3: Test (OOS) */}
          <div className="flex flex-col gap-1 rounded-md bg-card p-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-foreground">
                {t('training.stageTest')}
              </span>
              <Badge variant={metrics ? verdictVariant(metrics.verdict) : 'secondary'}>
                {metrics
                  ? `${metrics.totalTrades} OOS`
                  : t('training.emptyTest')}
              </Badge>
            </div>
            <p className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
              {metrics
                ? `WR ${formatOrDash(metrics.winRate, (v) => formatPercent(v))} · PF ${formatOrDash(metrics.profitFactor, (v) => v.toFixed(2))}`
                : '—'}
            </p>
          </div>

          {/* Stage 4: Shadow */}
          <div className="flex flex-col gap-1 rounded-md bg-card p-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-foreground">
                {t('training.stageShadow')}
              </span>
              <Badge variant={totalShadowOps > 0 ? 'default' : 'secondary'}>
                {totalShadowOps > 0
                  ? `${totalShadowOps} ops`
                  : t('training.emptyShadow')}
              </Badge>
            </div>
            <p className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
              {shadowData && totalShadowOps > 0
                ? `Paper ${shadowData.paper.count} · Testnet ${shadowData.testnet.filledOrderCount}`
                : '—'}
            </p>
          </div>
        </div>
      </section>

      {/* Empty state before any completed run */}
      {!run || !metrics ? (
        <div className="flex flex-col items-center gap-2 rounded-md bg-card px-6 py-10 text-center">
          <Info className="size-5 text-[var(--text-subtle)]" />
          <h3 className="text-sm font-semibold text-foreground">
            {run && run.status !== 'completed'
              ? t('training.runIncompleteTitle', { status: run.status })
              : t('training.overviewEmptyTitle')}
          </h3>
          <p className="max-w-md text-xs text-[var(--text-subtle)]">
            {run?.error ? run.error : t('training.overviewEmptyAction')}
          </p>
        </div>
      ) : (
        <>
          {/* Partial-range warning if upstream pagination missed spans */}
          {partialMissingSpans.length > 0 && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md bg-[var(--warning-soft)] px-3.5 py-2.5 text-xs text-[var(--warning)]"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                {t('training.partialRangeWarning', {
                  count: partialMissingSpans.length,
                })}
              </span>
            </div>
          )}

          {/* Run metadata + source + freshness + stale badge */}
          <section className="flex flex-col gap-2.5 rounded-md bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">
                  {presetName}
                </h3>
                <Badge variant="outline">
                  {run.pair} · {run.timeframe}
                </Badge>
                <Badge variant="secondary">{run.kind}</Badge>
                {run.config.isResearchVariant && (
                  <Badge variant="violet">
                    <FlaskConical className="size-3" />
                    <span>{t('training.researchVariantBadge')}</span>
                  </Badge>
                )}
                {isStale && (
                  <Badge variant="warning">
                    <Clock className="size-3" />
                    <span>{t('training.staleBadge')}</span>
                  </Badge>
                )}
              </div>

              <span className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
                {run.dataSource} ·{' '}
                {formatRelativeAge(
                  run.completedAt ?? run.createdAt,
                  nowMs,
                  language === 'es',
                )}
              </span>
            </div>

            <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-muted-foreground tabular-nums">
              <span>
                {t('training.metaRange')}: {formatShortUtcDate(run.fromTimeMs)} →{' '}
                {formatShortUtcDate(run.toTimeMs)}
              </span>
              <span>
                {t('training.metaCandles')}: {run.candleCount}
              </span>
              <span>
                {t('training.metaAssumptions')}: Fee{' '}
                {formatPercent(run.assumptions.commissionPct, 2)} · Slip{' '}
                {formatPercent(run.assumptions.slippagePct, 2)} · Bal{' '}
                {formatMoney(run.assumptions.initialBalance)} · Short{' '}
                {run.assumptions.allowShort ? 'ON' : 'OFF'}
              </span>
              <span>
                {t('training.metaCompleted')}:{' '}
                {formatUtcTimestamp(run.completedAt ?? run.createdAt)}
              </span>
            </div>

            {/* Verdict banner with exact rule explanation */}
            <div className="flex flex-wrap items-center gap-2.5 rounded-sm bg-muted/25 px-3 py-2 text-xs">
              <Badge variant={verdictVariant(metrics.verdict)}>
                {metrics.verdict === 'eligible' ? (
                  <CheckCircle2 className="size-3" />
                ) : (
                  <ShieldAlert className="size-3" />
                )}
                <span>{t(verdictLabelKey(metrics.verdict))}</span>
              </Badge>
              <span className="text-foreground">{metrics.verdictReason}</span>
            </div>
          </section>

          {/* 8 OOS Metric Cards */}
          <section
            aria-label={t('training.metricsGridAria')}
            className="grid grid-cols-2 gap-3 lg:grid-cols-4"
          >
            <MetricCard
              label={t('training.metricOosTrades')}
              value={String(metrics.totalTrades)}
              hint={`${metrics.wins}W / ${metrics.losses}L`}
            />
            <MetricCard
              label={t('training.metricWinRate')}
              value={formatOrDash(metrics.winRate, (v) => formatPercent(v))}
              hint={t('training.metricWilsonHint', {
                lb: formatOrDash(metrics.wilsonLowerBoundPct, (v) =>
                  formatPercent(v),
                ),
              })}
              tone={
                metrics.wilsonLowerBoundPct !== null &&
                metrics.wilsonLowerBoundPct >= 40
                  ? 'positive'
                  : 'neutral'
              }
            />
            <MetricCard
              label={t('training.metricProfitFactor')}
              value={formatOrDash(metrics.profitFactor, (v) => v.toFixed(2))}
              hint={t('training.metricPfGateHint')}
              tone={
                metrics.profitFactor !== null
                  ? metrics.profitFactor >= 1.2
                    ? 'positive'
                    : 'negative'
                  : 'neutral'
              }
            />
            <MetricCard
              label={t('training.metricMaxDd')}
              value={formatPercent(metrics.maxDrawdownPct)}
              hint={formatMoney(metrics.maxDrawdown)}
              tone={metrics.maxDrawdownPct > 20 ? 'negative' : 'neutral'}
            />
            <MetricCard
              label={t('training.metricNetPnl')}
              value={formatSignedMoney(metrics.netPnl)}
              hint={formatPercent(metrics.returnPct, 2)}
              tone={
                metrics.netPnl > 0
                  ? 'positive'
                  : metrics.netPnl < 0
                    ? 'negative'
                    : 'neutral'
              }
            />
            <MetricCard
              label={t('training.metricExpectancy')}
              value={formatOrDash(metrics.expectancy, formatSignedMoney)}
              tone={
                metrics.expectancy !== null && metrics.expectancy > 0
                  ? 'positive'
                  : metrics.expectancy !== null && metrics.expectancy < 0
                    ? 'negative'
                    : 'neutral'
              }
            />
            <MetricCard
              label={t('training.metricAverageR')}
              value={formatOrDash(metrics.averageR, (v) => formatR(v))}
              tone={
                metrics.averageR !== null && metrics.averageR > 0
                  ? 'positive'
                  : metrics.averageR !== null && metrics.averageR < 0
                    ? 'negative'
                    : 'neutral'
              }
            />
            <MetricCard
              label={t('training.metricFeesPaid')}
              value={formatMoney(metrics.feesPaid)}
              hint={formatPercent(run.assumptions.commissionPct, 2)}
            />
          </section>

          {/* Parameter diff & candidate evaluations (Walk-Forward) */}
          {run.kind === 'walk-forward' && metrics.bestSelectedParams && (
            <section className="flex flex-col gap-3 rounded-md bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-foreground">
                  {t('training.paramDiffTitle')}
                </h3>
                <span className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
                  {t('training.candidatesEvaluatedLabel', {
                    count: metrics.candidatesEvaluated ?? 0,
                  })}
                </span>
              </div>

              {metrics.paramDiffs && metrics.paramDiffs.length > 0 ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">{t('training.colParam')}</TableHead>
                        <TableHead scope="col">{t('training.colCatalogDefault')}</TableHead>
                        <TableHead scope="col">{t('training.colSelectedVal')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {metrics.paramDiffs.map((diff) => (
                        <TableRow key={diff.param}>
                          <TableCell className="font-mono text-xs">
                            {diff.param}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-[var(--text-subtle)] tabular-nums">
                            {String(diff.defaultValue)}
                          </TableCell>
                          <TableCell className="font-mono text-xs font-semibold text-primary tabular-nums">
                            {String(diff.selectedValue)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-xs text-[var(--text-subtle)]">
                  {t('training.paramDiffNoChanges')}
                </p>
              )}

              {metrics.candidates && metrics.candidates.length > 0 && (
                <div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowCandidates((v) => !v)}
                    className="h-7 gap-1 px-2 text-xs"
                  >
                    {showCandidates ? (
                      <ChevronDown className="size-3.5" />
                    ) : (
                      <ChevronRight className="size-3.5" />
                    )}
                    <span>
                      {t('training.toggleCandidates', {
                        count: metrics.candidates.length,
                      })}
                    </span>
                  </Button>

                  {showCandidates && (
                    <div className="mt-2 max-h-60 overflow-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead scope="col">#</TableHead>
                            <TableHead scope="col">{t('training.colValTrades')}</TableHead>
                            <TableHead scope="col">{t('training.colValPf')}</TableHead>
                            <TableHead scope="col">{t('training.colMaxDd')}</TableHead>
                            <TableHead scope="col">{t('training.colNetPnl')}</TableHead>
                            <TableHead scope="col">{t('training.colStatus')}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {metrics.candidates.map((cand) => (
                            <TableRow key={cand.candidateIndex}>
                              <TableCell className="font-mono text-xs tabular-nums">
                                #{cand.candidateIndex + 1}
                              </TableCell>
                              <TableCell className="font-mono text-xs tabular-nums">
                                {cand.valTrades}
                              </TableCell>
                              <TableCell className="font-mono text-xs tabular-nums">
                                {cand.valProfitFactor !== null
                                  ? cand.valProfitFactor.toFixed(2)
                                  : '—'}
                              </TableCell>
                              <TableCell className="font-mono text-xs tabular-nums">
                                {formatPercent(cand.valMaxDrawdownPct)}
                              </TableCell>
                              <TableCell className="font-mono text-xs tabular-nums">
                                {formatSignedMoney(cand.valNetPnlUsd)}
                              </TableCell>
                              <TableCell>
                                {cand.selected && (
                                  <Badge variant="positive">
                                    {t('training.selectedBadge')}
                                  </Badge>
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* Meta-filter Baseline vs Filtered Comparison */}
          {metrics.metaComparison && (
            <section className="flex flex-col gap-3 rounded-md bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-foreground">
                  {t('training.metaComparisonTitle')}
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  <Badge
                    variant={
                      metrics.metaComparison.delta.winRateLiftPp >= 0
                        ? 'positive'
                        : 'negative'
                    }
                  >
                    WR {metrics.metaComparison.delta.winRateLiftPp >= 0 ? '+' : ''}
                    {metrics.metaComparison.delta.winRateLiftPp.toFixed(1)} pp
                  </Badge>
                  <Badge variant="default">
                    {t('training.metaLossesEliminated', {
                      count: metrics.metaComparison.delta.lossesEliminated,
                      pct: metrics.metaComparison.delta.lossEliminationRatePct.toFixed(0),
                    })}
                  </Badge>
                  <Badge variant="secondary">
                    DD {metrics.metaComparison.delta.drawdownReductionPct >= 0 ? '-' : '+'}
                    {Math.abs(metrics.metaComparison.delta.drawdownReductionPct).toFixed(1)}%
                  </Badge>
                </div>
              </div>

              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">{t('training.colCohort')}</TableHead>
                      <TableHead scope="col" className="text-right">
                        {t('training.colOosTrades')}
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        {t('training.metricWinRate')}
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        Wilson 95% LB
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        {t('training.colOosPf')}
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        {t('training.colMaxDd')}
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        {t('training.colNetPnl')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(
                      [
                        ['Baseline', metrics.metaComparison.baseline],
                        ['Filtered', metrics.metaComparison.filtered],
                        ['Filtered + Sized', metrics.metaComparison.filteredSized],
                      ] as const
                    ).map(([label, row]) => (
                      <TableRow key={label}>
                        <TableCell className="text-xs font-semibold">
                          {label}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {row.trades}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {formatPercent(row.winRatePct)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {formatPercent(row.wilson95LbPct)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {row.profitFactor !== null
                            ? row.profitFactor.toFixed(2)
                            : '—'}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {formatPercent(row.maxDrawdownPct)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {formatSignedMoney(row.netPnlUsd)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}

          {/* Prediction-market Calibration & Monte Carlo */}
          {metrics.predictionSummary && (
            <section className="flex flex-col gap-3 rounded-md bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-foreground">
                  {t('training.predictionSummaryTitle')}
                </h3>
                <Badge variant="outline">
                  {metrics.predictionSummary.priceSource}
                </Badge>
              </div>

              {metrics.predictionSummary.monteCarlo && (
                <div className="flex flex-wrap gap-4 rounded-sm bg-muted/25 px-3 py-2 font-mono text-[11px] text-muted-foreground tabular-nums">
                  <span>
                    MC P5: {formatMoney(metrics.predictionSummary.monteCarlo.finalP5)}
                  </span>
                  <span>
                    MC P50: {formatMoney(metrics.predictionSummary.monteCarlo.finalP50)}
                  </span>
                  <span>
                    MC P95: {formatMoney(metrics.predictionSummary.monteCarlo.finalP95)}
                  </span>
                  <span>
                    DD P95: {formatPercent(metrics.predictionSummary.monteCarlo.maxDrawdownP95)}
                  </span>
                  <span>
                    Ruin: {formatPercent(metrics.predictionSummary.monteCarlo.ruinPct)}
                  </span>
                </div>
              )}

              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">{t('training.colRule')}</TableHead>
                      <TableHead scope="col" className="text-right">
                        Train Triggers
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        Base Rate
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        Calibrated P
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {metrics.predictionSummary.calibration.map((cal) => (
                      <TableRow key={cal.ruleId}>
                        <TableCell className="text-xs font-medium">
                          #{cal.number} {cal.title}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {cal.trainHits}/{cal.trainTriggers}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {formatPercent(cal.baseRate * 100)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs font-semibold tabular-nums">
                          {formatPercent(cal.probability * 100)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

const OverviewTab = memo(OverviewTabInner)
export default OverviewTab
