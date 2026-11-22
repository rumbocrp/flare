import { memo, useEffect, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  RefreshCw,
} from 'lucide-react'
import type { StreamConnectionStatus } from '@/api/botClient'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatRelativeAge, isTimestampStale } from '@/botRunUtils'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

type FreshnessMetaProps = {
  sourceLabel: string
  updatedAt: string | number | null | undefined
  staleAfterMs?: number
  forceStale?: boolean
  connectionState?: StreamConnectionStatus
}

export const FreshnessStamp = memo(function FreshnessStamp({
  sourceLabel,
  updatedAt,
  staleAfterMs,
  forceStale = false,
  connectionState,
}: FreshnessMetaProps) {
  const { t, language } = useI18n()
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now())
    }, 5_000)
    return () => clearInterval(timer)
  }, [])

  const isOffline = connectionState === 'offline'
  const isReconnecting = connectionState === 'reconnecting'
  const stale =
    !isOffline &&
    (forceStale ||
      (staleAfterMs !== undefined &&
        isTimestampStale(updatedAt, staleAfterMs, nowMs)))

  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground tabular-nums">
      <span>
        {sourceLabel} · {formatRelativeAge(updatedAt, nowMs, language === 'es')}
      </span>
      {isOffline && (
        <Badge variant="negative" className="h-4 px-1.5 text-[9.5px]">
          {t('botRun.offline')}
        </Badge>
      )}
      {isReconnecting && (
        <Badge variant="warning" className="h-4 px-1.5 text-[9.5px]">
          {t('botRun.reconnecting')}
        </Badge>
      )}
      {stale && (
        <Badge variant="warning" className="h-4 px-1.5 text-[9.5px]">
          {t('botRun.stale')}
        </Badge>
      )}
    </span>
  )
})

type OperatorSectionProps = {
  id: string
  title: string
  badges?: ReactNode
  sourceLabel: string
  updatedAt: string | number | null | undefined
  staleAfterMs?: number
  forceStale?: boolean
  connectionState?: StreamConnectionStatus
  open: boolean
  onToggle: () => void
  actions?: ReactNode
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  contentClassName?: string
  className?: string
  children: ReactNode
}

function OperatorSection({
  id,
  title,
  badges,
  sourceLabel,
  updatedAt,
  staleAfterMs,
  forceStale,
  connectionState,
  open,
  onToggle,
  actions,
  loading = false,
  error = null,
  onRetry,
  contentClassName,
  className,
  children,
}: OperatorSectionProps) {
  const { t } = useI18n()

  return (
    <Card className={cn('min-w-0', className)} data-section-id={id}>
      <CardHeader className="flex-col items-stretch gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={`botrun-section-${id}`}
            className="inline-flex items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
          >
            {open ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <CardTitle className="text-xs font-bold uppercase tracking-[0.06em]">
              {title}
            </CardTitle>
          </button>
          {badges}
          <FreshnessStamp
            sourceLabel={sourceLabel}
            updatedAt={updatedAt}
            staleAfterMs={staleAfterMs}
            forceStale={forceStale}
            connectionState={connectionState}
          />
        </div>

        {actions && (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </CardHeader>

      {open && (
        <CardContent
          id={`botrun-section-${id}`}
          className={cn('flex flex-col gap-3 px-4 pt-0 pb-4', contentClassName)}
        >
          {error && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-2 rounded-sm bg-[var(--negative-soft)] px-3 py-2 text-xs text-[var(--negative)]"
            >
              <span className="flex items-center gap-2">
                <AlertTriangle className="size-3.5 shrink-0" />
                <span>{error}</span>
              </span>
              {onRetry && (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={onRetry}
                >
                  <RefreshCw className="size-3" />
                  <span>{t('botRun.retry')}</span>
                </Button>
              )}
            </div>
          )}

          {loading ? (
            <div className="flex flex-col gap-2 py-1">
              <Skeleton className="h-7 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : (
            children
          )}
        </CardContent>
      )}
    </Card>
  )
}

export default memo(OperatorSection)
