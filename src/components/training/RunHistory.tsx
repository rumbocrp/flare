import { memo } from 'react'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { formatRelativeAge, formatShortUtcDate } from '@/botRunUtils'
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
import { useI18n, type TranslationKey } from '@/i18n'
import { cn } from '@/lib/utils'
import type {
  TrainingRunKind,
  TrainingRunRecord,
  TrainingRunStatus,
  TrainingVerdict,
} from '@/training/types'

type RunHistoryProps = {
  runs: readonly TrainingRunRecord[]
  selectedRunId: string | null
  loading: boolean
  error: string | null
  nowMs: number
  collapsed: boolean
  onToggleCollapse: () => void
  onSelectRun: (runId: string) => void
  onRetry: () => void
  presetNameMap: ReadonlyMap<string, string>
}

function statusVariant(
  status: TrainingRunStatus,
): 'positive' | 'negative' | 'warning' | 'default' | 'secondary' {
  if (status === 'completed') return 'positive'
  if (status === 'failed') return 'negative'
  if (status === 'cancelled' || status === 'interrupted') return 'warning'
  return 'default'
}

function verdictVariant(
  verdict: TrainingVerdict,
): 'positive' | 'warning' | 'negative' | 'violet' {
  if (verdict === 'eligible') return 'positive'
  if (verdict === 'override') return 'violet'
  if (verdict === 'insufficient') return 'warning'
  return 'negative'
}

function kindLabelKey(kind: TrainingRunKind): TranslationKey {
  if (kind === 'meta-filter') return 'training.kindMetaFilterShort'
  if (kind === 'prediction-market') return 'training.kindPredictionShort'
  return 'training.kindWalkForwardShort'
}

function verdictLabelKey(verdict: TrainingVerdict): TranslationKey {
  if (verdict === 'eligible') return 'training.verdictEligible'
  if (verdict === 'override') return 'training.verdictOverride'
  if (verdict === 'insufficient') return 'training.verdictInsufficient'
  return 'training.verdictBelow'
}

function RunHistoryInner({
  runs,
  selectedRunId,
  loading,
  error,
  nowMs,
  collapsed,
  onToggleCollapse,
  onSelectRun,
  onRetry,
  presetNameMap,
}: RunHistoryProps) {
  const { t, language } = useI18n()

  return (
    <section
      aria-label={t('training.historyTitle')}
      className="rounded-md bg-card"
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            className="flex items-center gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm cursor-pointer"
          >
            {collapsed ? (
              <ChevronRight className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
            <span>{t('training.historyTitle')}</span>
            <span className="font-mono text-xs font-normal text-[var(--text-subtle)] tabular-nums">
              ({runs.length})
            </span>
          </button>
        </h2>

        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onRetry}
          disabled={loading}
          className="h-7 gap-1 px-2 text-xs"
        >
          <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          <span>{t('training.refresh')}</span>
        </Button>
      </div>

      {!collapsed && (
        <div className="px-4 pb-4">
          {loading && runs.length === 0 ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : error ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-2 rounded-sm bg-[var(--negative-soft)] px-3 py-2.5 text-xs text-[var(--negative)]"
            >
              <span>{error}</span>
              <Button type="button" size="sm" variant="outline" onClick={onRetry}>
                {t('training.retry')}
              </Button>
            </div>
          ) : runs.length === 0 ? (
            <p className="rounded-sm bg-muted/20 px-4 py-6 text-center text-xs text-[var(--text-subtle)]">
              {t('training.historyEmpty')}
            </p>
          ) : (
            <>
              {/* Desktop / Tablet dense table */}
              <div className="hidden overflow-x-auto sm:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">{t('training.colStrategy')}</TableHead>
                      <TableHead scope="col">{t('training.colKind')}</TableHead>
                      <TableHead scope="col">{t('training.colMarket')}</TableHead>
                      <TableHead scope="col">{t('training.colRange')}</TableHead>
                      <TableHead scope="col">{t('training.colStatus')}</TableHead>
                      <TableHead scope="col" className="text-right">
                        {t('training.colOosTrades')}
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        {t('training.colOosPf')}
                      </TableHead>
                      <TableHead scope="col">{t('training.colVerdict')}</TableHead>
                      <TableHead scope="col" className="text-right">
                        {t('training.colWhen')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runs.map((run) => {
                      const isSelected = run.id === selectedRunId
                      const pf = run.metrics?.profitFactor ?? null
                      return (
                        <TableRow
                          key={run.id}
                          onClick={() => onSelectRun(run.id)}
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              onSelectRun(run.id)
                            }
                          }}
                          className={cn(
                            'cursor-pointer transition-colors',
                            isSelected && 'bg-primary/10',
                          )}
                        >
                          <TableCell className="max-w-[200px] truncate text-xs font-medium">
                            {presetNameMap.get(run.presetId) ?? run.presetId}
                          </TableCell>
                          <TableCell className="font-mono text-[11px] text-muted-foreground">
                            {t(kindLabelKey(run.kind))}
                          </TableCell>
                          <TableCell className="font-mono text-[11px] tabular-nums">
                            {run.pair} · {run.timeframe}
                          </TableCell>
                          <TableCell className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
                            {formatShortUtcDate(run.fromTimeMs).slice(0, 10)} →{' '}
                            {formatShortUtcDate(run.toTimeMs).slice(0, 10)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={statusVariant(run.status)}>
                              {run.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {run.metrics ? run.metrics.totalTrades : '—'}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {pf !== null ? pf.toFixed(2) : '—'}
                          </TableCell>
                          <TableCell>
                            {run.metrics ? (
                              <Badge variant={verdictVariant(run.metrics.verdict)}>
                                {t(verdictLabelKey(run.metrics.verdict))}
                              </Badge>
                            ) : (
                              <span className="text-xs text-[var(--text-subtle)]">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
                            {formatRelativeAge(
                              run.completedAt ?? run.createdAt,
                              nowMs,
                              language === 'es',
                            )}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile card rows (< sm) */}
              <div className="flex flex-col gap-2 sm:hidden">
                {runs.map((run) => {
                  const isSelected = run.id === selectedRunId
                  const pf = run.metrics?.profitFactor ?? null
                  return (
                    <button
                      key={run.id}
                      type="button"
                      onClick={() => onSelectRun(run.id)}
                      className={cn(
                        'flex flex-col gap-1.5 rounded-sm p-3 text-left transition-colors cursor-pointer',
                        isSelected ? 'bg-primary/14' : 'bg-muted/25',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-xs font-semibold text-foreground">
                          {presetNameMap.get(run.presetId) ?? run.presetId}
                        </span>
                        <Badge variant={statusVariant(run.status)}>
                          {run.status}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
                        <span>
                          {t(kindLabelKey(run.kind))} · {run.pair} {run.timeframe}
                        </span>
                        <span>
                          {pf !== null ? `PF ${pf.toFixed(2)}` : 'PF —'} ·{' '}
                          {run.metrics ? `${run.metrics.totalTrades}t` : '—'}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}

const RunHistory = memo(RunHistoryInner)
export default RunHistory
