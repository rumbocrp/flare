import { memo, useMemo, useState } from 'react'
import { Download, Pause, Play, RefreshCw, Search } from 'lucide-react'
import type {
  RuntimeEventRecord,
  RuntimeEventType,
  StreamConnectionStatus,
} from '@/api/botClient'
import OperatorSection from '@/components/botrun/OperatorSection'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  buildEventsCsv,
  computeVirtualWindow,
  downloadTextFile,
  formatUtcTimestamp,
} from '@/botRunUtils'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

const ALL_EVENT_TYPES: readonly RuntimeEventType[] = [
  'TRADE',
  'SIGNAL',
  'RISK',
  'INFO',
  'ERROR',
  'OPERATOR',
]

const VIEWPORT_HEIGHT = 320
const ROW_HEIGHT = 52

function eventTypeBadgeVariant(type: RuntimeEventType, severity: string) {
  if (type === 'ERROR' || severity === 'error' || severity === 'critical') {
    return 'negative' as const
  }
  if (type === 'RISK' || severity === 'warn') return 'warning' as const
  if (type === 'TRADE') return 'positive' as const
  return 'secondary' as const
}

type EventLogCardProps = {
  events: RuntimeEventRecord[]
  updatedAt: string | null
  streamStatus: StreamConnectionStatus
  loading: boolean
  error: string | null
  open: boolean
  onToggle: () => void
  onRefresh: () => void
}

function EventLogCard({
  events,
  updatedAt,
  streamStatus,
  loading,
  error,
  open,
  onToggle,
  onRefresh,
}: EventLogCardProps) {
  const { t } = useI18n()
  const [selectedTypes, setSelectedTypes] = useState<RuntimeEventType[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [pausedSnapshot, setPausedSnapshot] = useState<
    RuntimeEventRecord[] | null
  >(null)
  const [scrollTop, setScrollTop] = useState(0)

  const isPaused = pausedSnapshot !== null
  const sourceEvents = pausedSnapshot ?? events

  const bufferedNewCount = useMemo(() => {
    if (!pausedSnapshot) return 0
    const frozenIds = new Set(pausedSnapshot.map((e) => e.id))
    let count = 0
    for (const ev of events) {
      if (!frozenIds.has(ev.id)) count += 1
    }
    return count
  }, [pausedSnapshot, events])

  const filteredEvents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return sourceEvents.filter((ev) => {
      if (selectedTypes.length > 0 && !selectedTypes.includes(ev.type)) {
        return false
      }
      if (q) {
        const hay =
          `${ev.message} ${ev.type} ${ev.severity} ${ev.source} ${ev.correlationId ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [sourceEvents, selectedTypes, searchQuery])

  const win = useMemo(
    () =>
      computeVirtualWindow({
        totalItems: filteredEvents.length,
        scrollTop,
        viewportHeight: VIEWPORT_HEIGHT,
        rowHeight: ROW_HEIGHT,
        overscan: 6,
      }),
    [filteredEvents.length, scrollTop],
  )

  const visibleSlice = useMemo(
    () => filteredEvents.slice(win.startIndex, win.endIndex),
    [filteredEvents, win.startIndex, win.endIndex],
  )

  function toggleType(type: RuntimeEventType) {
    setSelectedTypes((prev) =>
      prev.includes(type) ? prev.filter((tItem) => tItem !== type) : [...prev, type],
    )
    setScrollTop(0)
  }

  function handleTogglePause() {
    if (isPaused) {
      setPausedSnapshot(null)
    } else {
      setPausedSnapshot(events)
    }
  }

  function handleExportCsv() {
    const csv = buildEventsCsv(filteredEvents)
    downloadTextFile(
      `flare-events-${new Date().toISOString().slice(0, 10)}.csv`,
      csv,
    )
  }

  return (
    <OperatorSection
      id="events"
      title={t('botRun.eventsTitle')}
      badges={
        <>
          <Badge variant="outline">{filteredEvents.length}</Badge>
          {isPaused && (
            <Badge variant="warning">
              {t('botRun.eventsPaused')}
              {bufferedNewCount > 0 ? ` (+${bufferedNewCount})` : ''}
            </Badge>
          )}
        </>
      }
      sourceLabel="/api/events"
      updatedAt={updatedAt}
      connectionState={streamStatus}
      open={open}
      onToggle={onToggle}
      loading={loading}
      error={error}
      onRetry={onRefresh}
      actions={
        <>
          <Button
            type="button"
            size="xs"
            variant={isPaused ? 'default' : 'outline'}
            onClick={handleTogglePause}
          >
            {isPaused ? (
              <>
                <Play className="size-3 fill-current" />
                <span>{t('botRun.eventsResumeFeed')}</span>
              </>
            ) : (
              <>
                <Pause className="size-3" />
                <span>{t('botRun.eventsPauseScroll')}</span>
              </>
            )}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={loading}
            onClick={onRefresh}
          >
            <RefreshCw className="size-3" />
            <span>{t('botRun.refresh')}</span>
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={filteredEvents.length === 0}
            onClick={handleExportCsv}
          >
            <Download className="size-3" />
            <span>CSV</span>
          </Button>
        </>
      }
    >
      {/* Filter Chips + Search */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSelectedTypes([])}
            aria-pressed={selectedTypes.length === 0}
            className={cn(
              'rounded-sm px-2 py-1 font-mono text-[10px] font-bold uppercase outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring cursor-pointer',
              selectedTypes.length === 0
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted/40 text-muted-foreground hover:text-foreground',
            )}
          >
            {t('botRun.eventsAll')}
          </button>
          {ALL_EVENT_TYPES.map((type) => {
            const active = selectedTypes.includes(type)
            return (
              <button
                key={type}
                type="button"
                onClick={() => toggleType(type)}
                aria-pressed={active}
                className={cn(
                  'rounded-sm px-2 py-1 font-mono text-[10px] font-bold uppercase outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring cursor-pointer',
                  active
                    ? type === 'ERROR'
                      ? 'bg-[var(--negative)] text-white'
                      : 'bg-primary text-primary-foreground'
                    : 'bg-muted/40 text-muted-foreground hover:text-foreground',
                )}
              >
                {type}
              </button>
            )
          })}
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="botrun-event-search"
            type="search"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value)
              setScrollTop(0)
            }}
            placeholder={t('botRun.eventsSearchPlaceholder')}
            aria-label={t('botRun.eventsSearchAria')}
            className="h-8 pl-8 font-mono text-xs"
          />
        </div>
      </div>

      {/* Windowed Virtual List */}
      {filteredEvents.length === 0 ? (
        <div className="rounded-sm bg-muted/25 px-3 py-6 text-center text-xs text-muted-foreground">
          {sourceEvents.length === 0
            ? t('botRun.eventsEmptySql')
            : t('botRun.eventsEmptyFilter')}
        </div>
      ) : (
        <div
          role="log"
          aria-live={isPaused ? 'off' : 'polite'}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          style={{ height: VIEWPORT_HEIGHT }}
          className="overflow-y-auto rounded-sm bg-muted/25"
        >
          <div style={{ height: win.totalHeight, position: 'relative' }}>
            <div
              style={{
                transform: `translateY(${win.offsetTop}px)`,
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
              }}
            >
              {visibleSlice.map((ev) => {
                const isErr =
                  ev.type === 'ERROR' ||
                  ev.severity === 'error' ||
                  ev.severity === 'critical'
                return (
                  <div
                    key={ev.id}
                    style={{ height: ROW_HEIGHT }}
                    className={cn(
                      'flex flex-col justify-center gap-0.5 px-3 font-mono text-[11px]',
                      isErr && 'bg-[var(--negative-soft)]/55',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                          {formatUtcTimestamp(ev.timestamp)}
                        </span>
                        <Badge
                          variant={eventTypeBadgeVariant(ev.type, ev.severity)}
                          className="h-4 px-1.5 text-[9.5px]"
                        >
                          {ev.type}
                        </Badge>
                        {ev.severity !== 'info' && (
                          <span
                            className={cn(
                              'text-[9.5px] font-bold uppercase',
                              isErr
                                ? 'text-[var(--negative)]'
                                : 'text-[var(--warning)]',
                            )}
                          >
                            {ev.severity}
                          </span>
                        )}
                      </div>
                      <span className="shrink-0 truncate text-[10px] text-muted-foreground">
                        {ev.source}
                        {ev.correlationId ? ` · ${ev.correlationId}` : ''}
                      </span>
                    </div>
                    <div
                      className={cn(
                        'truncate text-[11.5px]',
                        isErr ? 'text-[var(--negative)]' : 'text-foreground',
                      )}
                      title={ev.message}
                    >
                      {ev.message}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </OperatorSection>
  )
}

export default memo(EventLogCard)
