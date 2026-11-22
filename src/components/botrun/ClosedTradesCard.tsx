import { memo, useMemo } from 'react'
import { ArrowRight, Download } from 'lucide-react'
import type { StreamConnectionStatus } from '@/api/botClient'
import type { BacktestTrade } from '@/backtest'
import type { BotEngineState, StrategyPreset } from '@/botEngine'
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
  buildClosedTradesCsv,
  computeClosedTradesSummary,
  computeTradeRMultiple,
  downloadTextFile,
  formatDurationMs,
  formatUtcTimestamp,
} from '@/botRunUtils'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

type ClosedTradesCardProps = {
  trades: BacktestTrade[]
  resolvedTickets: BotEngineState['resolvedTickets']
  activePreset: StrategyPreset
  streamStatus: StreamConnectionStatus
  open: boolean
  onToggle: () => void
  onSendToStats?: () => void
}

function ClosedTradesCard({
  trades,
  resolvedTickets,
  activePreset,
  streamStatus,
  open,
  onToggle,
  onSendToStats,
}: ClosedTradesCardProps) {
  const { t } = useI18n()

  const summary = useMemo(
    () => computeClosedTradesSummary(trades, activePreset.strategy.stopLoss),
    [trades, activePreset.strategy.stopLoss],
  )

  const lastTradeTime = trades[0]?.exitTime ?? null

  function handleExportCsv() {
    const csv = buildClosedTradesCsv(
      trades,
      activePreset.name,
      activePreset.strategy.stopLoss,
    )
    downloadTextFile(
      `flare-closed-trades-${new Date().toISOString().slice(0, 10)}.csv`,
      csv,
    )
  }

  return (
    <OperatorSection
      id="trades"
      title={t('botRun.tradesTitle')}
      badges={
        <>
          <span className="inline-flex h-5 items-center rounded-sm bg-[var(--brand-violet)]/15 px-2 font-mono text-[10px] font-bold uppercase text-[var(--brand-violet)]">
            PAPER
          </span>
          <Badge variant="outline">{trades.length}</Badge>
        </>
      }
      sourceLabel="Bot Engine (PAPER)"
      updatedAt={lastTradeTime}
      connectionState={streamStatus}
      open={open}
      onToggle={onToggle}
      actions={
        <>
          {onSendToStats && trades.length > 0 && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={onSendToStats}
            >
              <span>{t('botRun.tradesSendStats')}</span>
              <ArrowRight className="size-3" />
            </Button>
          )}
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={trades.length === 0}
            onClick={handleExportCsv}
          >
            <Download className="size-3" />
            <span>CSV</span>
          </Button>
        </>
      }
    >
      {/* Summary Stats Strip */}
      <div className="grid grid-cols-2 gap-2 rounded-sm bg-muted/25 p-2.5 font-mono text-xs tabular-nums sm:grid-cols-5">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">
            {t('botRun.tradesTotalPnl')}
          </span>
          <strong
            className={cn(
              summary.totalPnlUsd > 0
                ? 'text-[var(--positive)]'
                : summary.totalPnlUsd < 0
                  ? 'text-[var(--negative)]'
                  : 'text-foreground',
            )}
          >
            {summary.totalPnlUsd >= 0 ? '+' : ''}$
            {summary.totalPnlUsd.toFixed(2)}
          </strong>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">Win Rate</span>
          <strong>
            {summary.winRatePct !== null
              ? `${summary.winRatePct.toFixed(1)}% (${summary.wins}W/${summary.losses}L)`
              : '—'}
          </strong>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">Avg R</span>
          <strong>
            {summary.avgR !== null
              ? `${summary.avgR >= 0 ? '+' : ''}${summary.avgR.toFixed(2)}R`
              : '—'}
          </strong>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">
            Profit Factor
          </span>
          <strong>
            {summary.profitFactor !== null
              ? summary.profitFactor.toFixed(2)
              : '—'}
          </strong>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">
            {t('botRun.tradesTotalFees')}
          </span>
          <strong>${summary.totalFeesUsd.toFixed(2)}</strong>
        </div>
      </div>

      {trades.length === 0 ? (
        <div className="rounded-sm bg-muted/25 px-3 py-6 text-center text-xs text-muted-foreground">
          {t('botRun.tradesEmpty')}
        </div>
      ) : (
        <>
          <div className="hidden overflow-x-auto sm:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('botRun.tradesColEntryExit')}</TableHead>
                  <TableHead>{t('botRun.pair')}</TableHead>
                  <TableHead>{t('botRun.ticketSide')}</TableHead>
                  <TableHead className="text-right">
                    {t('botRun.colSize')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('botRun.tradesColPrices')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('botRun.colFees')}
                  </TableHead>
                  <TableHead className="text-right">PnL</TableHead>
                  <TableHead className="text-right">
                    {t('botRun.tradesColDuration')}
                  </TableHead>
                  <TableHead>{t('botRun.tradesColPreset')}</TableHead>
                  <TableHead>{t('botRun.tradesColExitReason')}</TableHead>
                  <TableHead className="text-right">R</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trades.map((trade) => {
                  const r = computeTradeRMultiple(
                    trade,
                    activePreset.strategy.stopLoss,
                  )
                  return (
                    <TableRow key={trade.id} className="font-mono text-[11px]">
                      <TableCell className="whitespace-nowrap text-[10px] text-muted-foreground tabular-nums">
                        <div>{formatUtcTimestamp(trade.entryTime)}</div>
                        <div>{formatUtcTimestamp(trade.exitTime)}</div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-semibold">
                        {trade.pair}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            trade.side === 'buy' ? 'positive' : 'negative'
                          }
                          className="text-[10px]"
                        >
                          {trade.side === 'buy' ? 'LONG' : 'SHORT'}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        ${trade.size.toFixed(2)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        ${trade.entryPrice.toFixed(2)} → $
                        {trade.exitPrice.toFixed(2)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-muted-foreground tabular-nums">
                        ${trade.fees.toFixed(2)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'whitespace-nowrap text-right font-semibold tabular-nums',
                          trade.pnl >= 0
                            ? 'text-[var(--positive)]'
                            : 'text-[var(--negative)]',
                        )}
                      >
                        {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-muted-foreground tabular-nums">
                        {formatDurationMs(trade.exitTime - trade.entryTime)}
                      </TableCell>
                      <TableCell className="max-w-[140px] truncate text-muted-foreground">
                        {trade.presetName ?? activePreset.name}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <Badge variant="outline" className="text-[10px]">
                          {t(`exit.${trade.exitReason}`)}
                        </Badge>
                      </TableCell>
                      <TableCell
                        className={cn(
                          'whitespace-nowrap text-right tabular-nums',
                          r === null
                            ? 'text-muted-foreground'
                            : r >= 0
                              ? 'text-[var(--positive)]'
                              : 'text-[var(--negative)]',
                        )}
                      >
                        {r !== null
                          ? `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`
                          : '—'}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="flex flex-col gap-2 sm:hidden">
            {trades.map((trade) => {
              const r = computeTradeRMultiple(
                trade,
                activePreset.strategy.stopLoss,
              )
              return (
                <div
                  key={trade.id}
                  className="flex flex-col gap-1 rounded-sm bg-muted/25 p-2.5 font-mono text-[11px]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <Badge
                        variant={trade.side === 'buy' ? 'positive' : 'negative'}
                        className="text-[10px]"
                      >
                        {trade.side === 'buy' ? 'LONG' : 'SHORT'}
                      </Badge>
                      <strong>{trade.pair}</strong>
                    </div>
                    <strong
                      className={
                        trade.pnl >= 0
                          ? 'text-[var(--positive)]'
                          : 'text-[var(--negative)]'
                      }
                    >
                      {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
                      {r !== null
                        ? ` (${r >= 0 ? '+' : ''}${r.toFixed(2)}R)`
                        : ''}
                    </strong>
                  </div>
                  <div className="flex flex-wrap justify-between gap-2 text-muted-foreground tabular-nums">
                    <span>
                      ${trade.entryPrice.toFixed(2)} → $
                      {trade.exitPrice.toFixed(2)}
                    </span>
                    <span>
                      {formatDurationMs(trade.exitTime - trade.entryTime)}
                    </span>
                    <span>{t(`exit.${trade.exitReason}`)}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* Resolved Binary Tickets (Prediction Presets) */}
      {resolvedTickets.length > 0 && (
        <div className="flex flex-col gap-1.5 pt-2">
          <strong className="font-mono text-[11px] uppercase tracking-[0.05em] text-muted-foreground">
            {t('botRun.tradesResolvedTickets')} ({resolvedTickets.length})
          </strong>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>{t('botRun.tradesColRule')}</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead className="text-right">Stake</TableHead>
                  <TableHead className="text-right">PnL</TableHead>
                  <TableHead>{t('botRun.tradesColResult')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resolvedTickets.map((tk) => (
                  <TableRow key={tk.id} className="font-mono text-[11px]">
                    <TableCell>#{tk.id}</TableCell>
                    <TableCell className="max-w-[180px] truncate">
                      {tk.title}
                    </TableCell>
                    <TableCell>{tk.outcome}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      ${tk.stakeUsd.toFixed(2)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right font-semibold tabular-nums',
                        tk.netPnlUsd >= 0
                          ? 'text-[var(--positive)]'
                          : 'text-[var(--negative)]',
                      )}
                    >
                      {tk.netPnlUsd >= 0 ? '+' : ''}${tk.netPnlUsd.toFixed(2)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={tk.won ? 'positive' : 'negative'}
                        className="text-[10px]"
                      >
                        {tk.won ? 'WIN' : 'LOSS'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </OperatorSection>
  )
}

export default memo(ClosedTradesCard)
