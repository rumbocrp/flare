import { Activity, Ban, CheckCircle2, Clock, PauseCircle, XCircle } from 'lucide-react'
import { formatDurationMs, formatShortUtcDate } from '@/botRunUtils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useI18n, type TranslationKey } from '@/i18n'
import { cn } from '@/lib/utils'
import type {
  TrainingProgress,
  TrainingProgressPhase,
  TrainingRunStatus,
} from '@/training/types'

type RunBarProps = {
  status: TrainingRunStatus | 'idle'
  strategyName: string
  pair: string
  timeframe: string
  fromTimeMs: number
  toTimeMs: number
  progress: TrainingProgress | null
  runStartedAtMs: number | null
  nowMs: number
  isCancelling: boolean
  onCancel: () => void
}

const PHASE_KEYS: Record<TrainingProgressPhase, TranslationKey> = {
  preparing: 'training.phasePreparing',
  fitting: 'training.phaseFitting',
  validating: 'training.phaseValidating',
  testing: 'training.phaseTesting',
  finalizing: 'training.phaseFinalizing',
}

function statusBadgeVariant(
  status: TrainingRunStatus | 'idle',
): 'secondary' | 'default' | 'positive' | 'negative' | 'warning' {
  if (status === 'running') return 'default'
  if (status === 'completed') return 'positive'
  if (status === 'failed') return 'negative'
  if (status === 'interrupted' || status === 'cancelled') return 'warning'
  return 'secondary'
}

function statusLabelKey(status: TrainingRunStatus | 'idle'): TranslationKey {
  if (status === 'running') return 'training.statusRunning'
  if (status === 'completed') return 'training.statusCompleted'
  if (status === 'failed') return 'training.statusFailed'
  if (status === 'cancelled') return 'training.statusCancelled'
  if (status === 'interrupted') return 'training.statusInterrupted'
  return 'training.statusIdle'
}

function StatusIcon({ status }: { status: TrainingRunStatus | 'idle' }) {
  if (status === 'running') return <Activity className="size-3 animate-pulse" />
  if (status === 'completed') return <CheckCircle2 className="size-3" />
  if (status === 'failed') return <XCircle className="size-3" />
  if (status === 'cancelled' || status === 'interrupted') {
    return <PauseCircle className="size-3" />
  }
  return <Clock className="size-3" />
}

/**
 * Sticky run status bar isolated from the rest of the workspace so real
 * worker progress checkpoints update ONLY this bar without re-rendering
 * the catalog, tables, or history.
 */
function RunBar({
  status,
  strategyName,
  pair,
  timeframe,
  fromTimeMs,
  toTimeMs,
  progress,
  runStartedAtMs,
  nowMs,
  isCancelling,
  onCancel,
}: RunBarProps) {
  const { t } = useI18n()

  const isRunning = status === 'running'
  const hasBarCount = Boolean(progress && progress.barCount > 0)
  const rawPct =
    progress && progress.barCount > 0
      ? Math.max(0, Math.min(100, (progress.barIndex / progress.barCount) * 100))
      : null

  // Per §4: ETA ONLY after >= 10% progress AND at least one completed fold, computed from actual elapsed time.
  let etaText: string | null = null
  if (
    isRunning &&
    rawPct !== null &&
    rawPct >= 10 &&
    progress &&
    progress.foldIndex >= 1 &&
    runStartedAtMs !== null
  ) {
    const elapsedMs = Math.max(0, nowMs - runStartedAtMs)
    if (elapsedMs > 0 && rawPct < 100) {
      const remainingMs = (elapsedMs / rawPct) * (100 - rawPct)
      etaText = formatDurationMs(remainingMs)
    }
  }

  return (
    <section
      aria-label={t('training.runBarAria')}
      aria-live="polite"
      className="sticky top-2 z-20 rounded-md bg-card/95 px-3.5 py-2.5 backdrop-blur-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <Badge variant={statusBadgeVariant(status)}>
            <StatusIcon status={status} />
            <span>{t(statusLabelKey(status))}</span>
          </Badge>

          <span className="truncate font-semibold text-foreground">
            {strategyName}
          </span>
          <span className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
            {pair} · {timeframe}
          </span>
          <span className="hidden font-mono text-[11px] text-[var(--text-subtle)] tabular-nums md:inline">
            {formatShortUtcDate(fromTimeMs)} → {formatShortUtcDate(toTimeMs)}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {progress && isRunning && (
            <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground tabular-nums">
              <span className="font-sans font-medium text-foreground">
                {t(PHASE_KEYS[progress.phase])}
              </span>
              {progress.foldCount > 1 && (
                <span>
                  {t('training.foldCounter', {
                    current: Math.min(progress.foldIndex + 1, progress.foldCount),
                    total: progress.foldCount,
                  })}
                </span>
              )}
              {rawPct !== null && <span>{rawPct.toFixed(0)}%</span>}
              {etaText && (
                <span className="text-[var(--text-subtle)]">
                  {t('training.etaLabel', { eta: etaText })}
                </span>
              )}
            </div>
          )}

          {isRunning && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isCancelling}
              onClick={onCancel}
              className="h-7 gap-1 px-2.5 text-xs"
            >
              <Ban className="size-3" />
              <span>
                {isCancelling
                  ? t('training.cancelling')
                  : t('training.cancelRun')}
              </span>
            </Button>
          )}
        </div>
      </div>

      {isRunning && (
        <div
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted/50"
          role="progressbar"
          aria-label={t('training.progressAria')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={rawPct !== null ? Math.round(rawPct) : undefined}
        >
          <div
            className={cn(
              'h-full rounded-full bg-primary transition-[width] duration-150 motion-reduce:transition-none',
              !hasBarCount && 'w-1/3 animate-pulse',
            )}
            style={
              hasBarCount && rawPct !== null ? { width: `${rawPct}%` } : undefined
            }
          />
        </div>
      )}
    </section>
  )
}

export default RunBar
