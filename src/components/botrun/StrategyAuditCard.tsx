import { memo, useEffect, useRef, useState } from 'react'
import { FlaskConical, Square } from 'lucide-react'
import {
  fetchLatestBotAccuracyAudit,
  fetchSinglePresetAccuracyAudit,
  type StrategyAuditRecord,
  type StreamConnectionStatus,
} from '@/api/botClient'
import type { StrategyPreset } from '@/botEngine'
import OperatorSection from '@/components/botrun/OperatorSection'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  formatShortUtcDate,
  formatUtcTimestamp,
  isAuditWindowStale,
} from '@/botRunUtils'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

function createAuditRunId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }
  return `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

type StrategyAuditCardProps = {
  presets: StrategyPreset[]
  audits: StrategyAuditRecord[]
  streamStatus: StreamConnectionStatus
  loading: boolean
  error: string | null
  open: boolean
  onToggle: () => void
  onRetry: () => void
  onAuditsUpdated: (audits: StrategyAuditRecord[]) => void
}

function StrategyAuditCard({
  presets,
  audits,
  streamStatus,
  loading,
  error,
  open,
  onToggle,
  onRetry,
  onAuditsUpdated,
}: StrategyAuditCardProps) {
  const { t } = useI18n()
  const [running, setRunning] = useState(false)
  const [progressCount, setProgressCount] = useState(0)
  const [currentPresetName, setCurrentPresetName] = useState<string | null>(
    null,
  )
  const [runError, setRunError] = useState<string | null>(null)
  const [liveItems, setLiveItems] = useState<StrategyAuditRecord[]>([])
  const [nowMs, setNowMs] = useState(() => Date.now())
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  const displayedAudits = running && liveItems.length > 0 ? liveItems : audits
  const latestRunTime = displayedAudits[0]?.createdAt ?? null
  const assumptionsSample = displayedAudits[0]?.assumptions ?? null
  const dataSourceSample = displayedAudits[0]?.dataSource ?? null

  const anyStale = displayedAudits.some((row) =>
    isAuditWindowStale(row.toTimeMs, row.timeframe, nowMs),
  )

  async function handleRunSequentialAudit() {
    if (running || presets.length === 0) return
    const controller = new AbortController()
    abortRef.current = controller
    const runId = createAuditRunId()

    setRunning(true)
    setRunError(null)
    setProgressCount(0)
    setLiveItems([])

    const collected: StrategyAuditRecord[] = []
    try {
      for (let i = 0; i < presets.length; i += 1) {
        if (controller.signal.aborted) break
        const preset = presets[i]
        setCurrentPresetName(preset.name)
        const res = await fetchSinglePresetAccuracyAudit(
          preset.id,
          runId,
          controller.signal,
        )
        const item = res.reports[0]
        if (item) {
          collected.push({
            id: `${runId}-${preset.id}`,
            tenantId: '',
            runId,
            createdAt: res.evaluatedAt,
            presetId: item.presetId,
            presetName: item.name,
            domain: item.domain,
            pair: item.pair ?? preset.strategy.pair,
            timeframe: item.timeframe,
            fromTimeMs: item.fromTimeMs ?? 0,
            toTimeMs: item.toTimeMs ?? 0,
            candles: item.candles ?? res.candleSampleSize,
            metrics: {
              totalOperations: item.totalOperations,
              wins: item.wins,
              losses: item.losses,
              winRatePct: item.winRatePct,
              wilsonLowerBoundPct: item.wilsonLowerBoundPct,
              netPnlUsd: item.netPnlUsd,
              returnPct: item.returnPct,
              profitFactor: item.profitFactor,
              maxDrawdownPct: item.maxDrawdownPct,
            },
            assumptions: item.assumptions ?? {
              commissionPct: preset.execution.commissionPct,
              slippagePct: preset.execution.slippagePct,
              initialBalance: preset.execution.initialBalance,
              allowShort: preset.execution.allowShort,
            },
            dataSource: item.dataSource,
          })
          setLiveItems([...collected])
        }
        setProgressCount(i + 1)
      }

      if (!controller.signal.aborted) {
        const persisted = await fetchLatestBotAccuracyAudit()
        onAuditsUpdated(persisted.length > 0 ? persisted : collected)
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setRunError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      abortRef.current = null
      setRunning(false)
      setCurrentPresetName(null)
    }
  }

  function handleCancelRun() {
    abortRef.current?.abort()
    setRunning(false)
    setCurrentPresetName(null)
  }

  const progressPct =
    presets.length > 0 ? Math.round((progressCount / presets.length) * 100) : 0

  return (
    <OperatorSection
      id="audit"
      title={t('botRun.auditTitle')}
      badges={
        <Badge variant="outline">
          {t('botRun.presetsCount', { count: presets.length })}
        </Badge>
      }
      sourceLabel="SQL strategy_audits"
      updatedAt={latestRunTime}
      forceStale={anyStale}
      connectionState={streamStatus}
      open={open}
      onToggle={onToggle}
      loading={loading}
      error={runError ?? error}
      onRetry={onRetry}
      actions={
        running ? (
          <Button
            type="button"
            size="xs"
            variant="destructive"
            onClick={handleCancelRun}
          >
            <Square className="size-3 fill-current" />
            <span>{t('botRun.cancel')}</span>
          </Button>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="default"
            disabled={presets.length === 0}
            onClick={() => void handleRunSequentialAudit()}
          >
            <FlaskConical className="size-3" />
            <span>{t('botRun.auditRunBtn', { count: presets.length })}</span>
          </Button>
        )
      }
    >
      {/* Real Sequential Progress Bar */}
      {running && (
        <div className="flex flex-col gap-1.5 rounded-sm bg-muted/30 p-2.5 font-mono text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-foreground">
              {t('botRun.auditEvaluating')} {currentPresetName ?? '…'}
            </span>
            <strong className="shrink-0 tabular-nums">
              {progressCount} / {presets.length} ({progressPct}%)
            </strong>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Explicit Backtest Assumptions Strip */}
      {assumptionsSample && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm bg-muted/25 px-2.5 py-1.5 font-mono text-[10.5px] text-muted-foreground tabular-nums">
          <span>
            {t('botRun.auditSource')}{' '}
            <strong className="text-foreground">{dataSourceSample}</strong>
          </span>
          <span>
            {t('botRun.auditFee')}{' '}
            <strong className="text-foreground">
              {assumptionsSample.commissionPct}%
            </strong>
          </span>
          <span>
            Slippage:{' '}
            <strong className="text-foreground">
              {assumptionsSample.slippagePct}%
            </strong>
          </span>
          <span>
            {t('botRun.auditBaseBal')}{' '}
            <strong className="text-foreground">
              ${assumptionsSample.initialBalance}
            </strong>
          </span>
          <span>
            {t('botRun.auditEvaluated')}{' '}
            <strong className="text-foreground">
              {formatUtcTimestamp(latestRunTime)}
            </strong>
          </span>
        </div>
      )}

      {displayedAudits.length === 0 && !running ? (
        <div className="rounded-sm bg-muted/25 px-3 py-5 text-center text-xs text-muted-foreground">
          {t('botRun.auditEmpty')}
        </div>
      ) : (
        <>
          <div className="hidden overflow-x-auto sm:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Preset</TableHead>
                  <TableHead>{t('botRun.auditColPairTf')}</TableHead>
                  <TableHead>{t('botRun.auditColWindow')}</TableHead>
                  <TableHead className="text-right">
                    {t('botRun.auditColOps')}
                  </TableHead>
                  <TableHead className="text-right">Win %</TableHead>
                  <TableHead className="text-right">Wilson 95%</TableHead>
                  <TableHead className="text-right">PF</TableHead>
                  <TableHead className="text-right">Net PnL</TableHead>
                  <TableHead>{t('botRun.auditColState')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayedAudits.map((row) => {
                  const rowStale = isAuditWindowStale(
                    row.toTimeMs,
                    row.timeframe,
                    nowMs,
                  )
                  return (
                    <TableRow key={row.id} className="font-mono text-[11px]">
                      <TableCell className="max-w-[160px] truncate font-semibold">
                        {row.presetName}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {row.pair} · {row.timeframe}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-[10px] text-muted-foreground tabular-nums">
                        {formatShortUtcDate(row.fromTimeMs)} →{' '}
                        {formatShortUtcDate(row.toTimeMs)} ({row.candles})
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {row.metrics.totalOperations} / {row.metrics.wins}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {row.metrics.winRatePct.toFixed(1)}%
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {row.metrics.wilsonLowerBoundPct.toFixed(1)}%
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {row.metrics.profitFactor !== null
                          ? row.metrics.profitFactor.toFixed(2)
                          : '—'}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'whitespace-nowrap text-right font-semibold tabular-nums',
                          row.metrics.netPnlUsd >= 0
                            ? 'text-[var(--positive)]'
                            : 'text-[var(--negative)]',
                        )}
                      >
                        {row.metrics.netPnlUsd >= 0 ? '+' : ''}$
                        {row.metrics.netPnlUsd.toFixed(2)}
                      </TableCell>
                      <TableCell>
                        {rowStale ? (
                          <Badge variant="warning" className="text-[9.5px]">
                            {t('botRun.stale')}
                          </Badge>
                        ) : (
                          <Badge variant="positive" className="text-[9.5px]">
                            FRESH
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="flex flex-col gap-2 sm:hidden">
            {displayedAudits.map((row) => {
              const rowStale = isAuditWindowStale(
                row.toTimeMs,
                row.timeframe,
                nowMs,
              )
              return (
                <div
                  key={row.id}
                  className="flex flex-col gap-1 rounded-sm bg-muted/25 p-2.5 font-mono text-[11px]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <strong className="truncate">{row.presetName}</strong>
                    <Badge
                      variant={rowStale ? 'warning' : 'positive'}
                      className="text-[9.5px]"
                    >
                      {rowStale ? t('botRun.stale') : 'FRESH'}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap justify-between gap-2 text-muted-foreground tabular-nums">
                    <span>
                      {row.pair} · {row.timeframe} ({row.candles})
                    </span>
                    <span>
                      {row.metrics.wins}/{row.metrics.totalOperations} (
                      {row.metrics.winRatePct.toFixed(1)}%)
                    </span>
                    <strong
                      className={
                        row.metrics.netPnlUsd >= 0
                          ? 'text-[var(--positive)]'
                          : 'text-[var(--negative)]'
                      }
                    >
                      {row.metrics.netPnlUsd >= 0 ? '+' : ''}$
                      {row.metrics.netPnlUsd.toFixed(2)}
                    </strong>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </OperatorSection>
  )
}

export default memo(StrategyAuditCard)
