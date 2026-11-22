import { memo } from 'react'
import { formatShortUtcDate } from '@/botRunUtils'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatOrDash, formatPercent, formatSignedMoney } from '@/format'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { TrainingRunRecord } from '@/training/types'

type FoldsTabProps = {
  run: TrainingRunRecord | null
}

function pctOffset(valueMs: number, minMs: number, spanMs: number): number {
  if (spanMs <= 0) return 0
  return Math.max(0, Math.min(100, ((valueMs - minMs) / spanMs) * 100))
}

function FoldsTabInner({ run }: FoldsTabProps) {
  const { t } = useI18n()
  const folds = run?.folds ?? []

  if (!run || folds.length === 0) {
    return (
      <div className="rounded-md bg-card px-6 py-10 text-center text-xs text-[var(--text-subtle)]">
        {t('training.foldsEmpty')}
      </div>
    )
  }

  const minMs = Math.min(...folds.map((f) => f.trainFromMs))
  const maxMs = Math.max(...folds.map((f) => f.testToMs))
  const spanMs = Math.max(1, maxMs - minMs)

  return (
    <div className="flex flex-col gap-4">
      {/* Pure CSS chronological walk-forward split timeline */}
      <section
        aria-label={t('training.foldsTimelineTitle')}
        className="flex flex-col gap-3 rounded-md bg-card p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-foreground">
            {t('training.foldsTimelineTitle')}
          </h3>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-[2px] bg-primary/75" />
              <span>{t('training.segmentTrain')}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-[2px] bg-[var(--warning)]/80" />
              <span>{t('training.segmentVal')}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-[2px] bg-[var(--positive)]/85" />
              <span>{t('training.segmentTest')}</span>
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {folds.map((fold) => {
            const trainLeft = pctOffset(fold.trainFromMs, minMs, spanMs)
            const trainRight = pctOffset(fold.trainToMs, minMs, spanMs)
            const valLeft = pctOffset(fold.valFromMs, minMs, spanMs)
            const valRight = pctOffset(fold.valToMs, minMs, spanMs)
            const testLeft = pctOffset(fold.testFromMs, minMs, spanMs)
            const testRight = pctOffset(fold.testToMs, minMs, spanMs)

            return (
              <div
                key={fold.foldIndex}
                className="grid grid-cols-[56px_1fr_84px] items-center gap-2.5"
              >
                <span className="font-mono text-[11px] font-medium text-muted-foreground tabular-nums">
                  Fold {fold.foldIndex + 1}
                </span>
                <div className="relative h-4 w-full overflow-hidden rounded-sm bg-muted/35">
                  <div
                    className="absolute inset-y-0 bg-primary/75"
                    style={{
                      left: `${trainLeft}%`,
                      width: `${Math.max(1, trainRight - trainLeft)}%`,
                    }}
                    title={`${t('training.segmentTrain')}: ${formatShortUtcDate(fold.trainFromMs)} → ${formatShortUtcDate(fold.trainToMs)} (${fold.trainBars})`}
                  />
                  {fold.valBars > 0 && (
                    <div
                      className="absolute inset-y-0 bg-[var(--warning)]/80"
                      style={{
                        left: `${valLeft}%`,
                        width: `${Math.max(1, valRight - valLeft)}%`,
                      }}
                      title={`${t('training.segmentVal')}: ${formatShortUtcDate(fold.valFromMs)} → ${formatShortUtcDate(fold.valToMs)} (${fold.valBars})`}
                    />
                  )}
                  <div
                    className="absolute inset-y-0 bg-[var(--positive)]/85"
                    style={{
                      left: `${testLeft}%`,
                      width: `${Math.max(1, testRight - testLeft)}%`,
                    }}
                    title={`${t('training.segmentTest')}: ${formatShortUtcDate(fold.testFromMs)} → ${formatShortUtcDate(fold.testToMs)} (${fold.testBars})`}
                  />
                </div>
                <span
                  className={cn(
                    'text-right font-mono text-[11px] font-semibold tabular-nums',
                    fold.testNetPnlUsd > 0
                      ? 'text-[var(--positive)]'
                      : fold.testNetPnlUsd < 0
                        ? 'text-[var(--negative)]'
                        : 'text-muted-foreground',
                  )}
                >
                  {formatSignedMoney(fold.testNetPnlUsd)}
                </span>
              </div>
            )
          })}
        </div>
      </section>

      {/* Per-fold detailed metrics table */}
      <section className="rounded-md bg-card p-4">
        <div className="hidden overflow-x-auto sm:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t('training.colFold')}</TableHead>
                <TableHead scope="col">{t('training.colTrainRange')}</TableHead>
                <TableHead scope="col">{t('training.colValRange')}</TableHead>
                <TableHead scope="col">{t('training.colTestRange')}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t('training.colOosTrades')}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t('training.metricWinRate')}
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
              {folds.map((fold) => (
                <TableRow key={fold.foldIndex}>
                  <TableCell className="font-mono text-xs font-semibold tabular-nums">
                    #{fold.foldIndex + 1}
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
                    {formatShortUtcDate(fold.trainFromMs).slice(0, 10)} →{' '}
                    {formatShortUtcDate(fold.trainToMs).slice(0, 10)} ({fold.trainBars})
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
                    {fold.valBars > 0
                      ? `${formatShortUtcDate(fold.valFromMs).slice(0, 10)} → ${formatShortUtcDate(fold.valToMs).slice(0, 10)} (${fold.valBars})`
                      : '—'}
                  </TableCell>
                  <TableCell className="font-mono text-[11px] tabular-nums">
                    {formatShortUtcDate(fold.testFromMs).slice(0, 10)} →{' '}
                    {formatShortUtcDate(fold.testToMs).slice(0, 10)} ({fold.testBars})
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {fold.testTrades}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {formatOrDash(fold.testWinRatePct, (v) => formatPercent(v))}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {formatOrDash(fold.testProfitFactor, (v) => v.toFixed(2))}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {formatPercent(fold.testMaxDrawdownPct)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right font-mono text-xs font-semibold tabular-nums',
                      fold.testNetPnlUsd > 0
                        ? 'text-[var(--positive)]'
                        : fold.testNetPnlUsd < 0
                          ? 'text-[var(--negative)]'
                          : 'text-foreground',
                    )}
                  >
                    {formatSignedMoney(fold.testNetPnlUsd)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Mobile cards (< sm) */}
        <div className="flex flex-col gap-2 sm:hidden">
          {folds.map((fold) => (
            <div
              key={fold.foldIndex}
              className="flex flex-col gap-1 rounded-sm bg-muted/25 p-3 font-mono text-[11px] tabular-nums"
            >
              <div className="flex items-center justify-between">
                <strong className="text-xs text-foreground">
                  Fold #{fold.foldIndex + 1}
                </strong>
                <span
                  className={cn(
                    'font-semibold',
                    fold.testNetPnlUsd > 0
                      ? 'text-[var(--positive)]'
                      : fold.testNetPnlUsd < 0
                        ? 'text-[var(--negative)]'
                        : 'text-foreground',
                  )}
                >
                  {formatSignedMoney(fold.testNetPnlUsd)}
                </span>
              </div>
              <span className="text-[var(--text-subtle)]">
                Test: {formatShortUtcDate(fold.testFromMs).slice(0, 10)} →{' '}
                {formatShortUtcDate(fold.testToMs).slice(0, 10)}
              </span>
              <div className="flex items-center justify-between text-muted-foreground">
                <span>
                  {fold.testTrades}t · WR{' '}
                  {formatOrDash(fold.testWinRatePct, (v) => formatPercent(v))}
                </span>
                <span>
                  PF {formatOrDash(fold.testProfitFactor, (v) => v.toFixed(2))} ·
                  DD {formatPercent(fold.testMaxDrawdownPct)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

const FoldsTab = memo(FoldsTabInner)
export default FoldsTab
