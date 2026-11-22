import { memo, useMemo, useState } from 'react'
import { ArrowUpDown, Download } from 'lucide-react'
import { formatShortUtcDate } from '@/botRunUtils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
  formatPrice,
  formatR,
  formatSignedMoney,
} from '@/format'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { TrainingRunRecord, TrainingTradeRecord } from '@/training/types'

type TradesTabProps = {
  run: TrainingRunRecord | null
}

type SortField = 'exitTime' | 'pnl' | 'rMultiple' | 'foldIndex'

function csvEscape(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function downloadTradesCsv(
  trades: readonly TrainingTradeRecord[],
  runId: string,
): void {
  const header = [
    'id',
    'fold',
    'entry_time_utc',
    'exit_time_utc',
    'pair',
    'side',
    'size_usd',
    'entry_price',
    'exit_price',
    'fees_usd',
    'pnl_usd',
    'r_multiple',
    'exit_reason',
  ]
  const rows = trades.map((tr) => [
    tr.id,
    tr.foldIndex !== undefined ? tr.foldIndex + 1 : '',
    tr.entryTime ? new Date(tr.entryTime).toISOString() : '',
    tr.exitTime ? new Date(tr.exitTime).toISOString() : tr.time,
    tr.pair,
    tr.side,
    tr.size.toFixed(2),
    tr.entryPrice.toFixed(4),
    tr.exitPrice.toFixed(4),
    (tr.fees ?? 0).toFixed(2),
    tr.pnl.toFixed(2),
    tr.rMultiple !== null && tr.rMultiple !== undefined
      ? tr.rMultiple.toFixed(2)
      : '',
    tr.exitReason ?? '',
  ])

  const csv = [header, ...rows]
    .map((line) => line.map(csvEscape).join(','))
    .join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `flare-oos-trades-${runId.slice(0, 14)}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function TradesTabInner({ run }: TradesTabProps) {
  const { t } = useI18n()
  const [sideFilter, setSideFilter] = useState<'all' | 'buy' | 'sell'>('all')
  const [foldFilter, setFoldFilter] = useState<string>('all')
  const [sortField, setSortField] = useState<SortField>('exitTime')
  const [sortAsc, setSortAsc] = useState(false)

  const trades = useMemo(() => run?.trades ?? [], [run])

  const foldNumbers = useMemo(() => {
    const set = new Set<number>()
    for (const tr of trades) {
      if (tr.foldIndex !== undefined) set.add(tr.foldIndex)
    }
    return Array.from(set).sort((a, b) => a - b)
  }, [trades])

  const filtered = useMemo(() => {
    const list = trades.filter((tr) => {
      if (sideFilter !== 'all' && tr.side !== sideFilter) return false
      if (foldFilter !== 'all' && String(tr.foldIndex ?? -1) !== foldFilter) {
        return false
      }
      return true
    })

    return [...list].sort((a, b) => {
      let diff: number
      if (sortField === 'exitTime') {
        diff = (a.exitTime ?? 0) - (b.exitTime ?? 0)
      } else if (sortField === 'pnl') {
        diff = a.pnl - b.pnl
      } else if (sortField === 'rMultiple') {
        diff = (a.rMultiple ?? -999) - (b.rMultiple ?? -999)
      } else {
        diff = (a.foldIndex ?? 0) - (b.foldIndex ?? 0)
      }
      return sortAsc ? diff : -diff
    })
  }, [foldFilter, sideFilter, sortAsc, sortField, trades])

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc((prev) => !prev)
    } else {
      setSortField(field)
      setSortAsc(false)
    }
  }

  if (!run || trades.length === 0) {
    return (
      <div className="rounded-md bg-card px-6 py-10 text-center text-xs text-[var(--text-subtle)]">
        {t('training.tradesEmpty')}
      </div>
    )
  }

  return (
    <section className="flex flex-col gap-3 rounded-md bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={sideFilter}
            onValueChange={(v) => setSideFilter(v as 'all' | 'buy' | 'sell')}
          >
            <SelectTrigger
              className="h-8 w-28 text-xs"
              aria-label={t('training.tradesFilterSide')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {t('training.tradesFilterSide')}: {t('training.tradesFilterAll')}
              </SelectItem>
              <SelectItem value="buy">BUY</SelectItem>
              <SelectItem value="sell">SELL</SelectItem>
            </SelectContent>
          </Select>

          {foldNumbers.length > 1 && (
            <Select value={foldFilter} onValueChange={setFoldFilter}>
              <SelectTrigger
                className="h-8 w-28 text-xs"
                aria-label={t('training.tradesFilterFold')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t('training.tradesFilterFold')}: {t('training.tradesFilterAll')}
                </SelectItem>
                {foldNumbers.map((f) => (
                  <SelectItem key={f} value={String(f)}>
                    Fold #{f + 1}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <span className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
            {filtered.length}/{trades.length}
          </span>
        </div>

        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 text-xs"
          onClick={() => downloadTradesCsv(filtered, run.id)}
        >
          <Download className="size-3.5" />
          <span>{t('training.tradesExportCsv')}</span>
        </Button>
      </div>

      {/* Desktop / Tablet dense table */}
      <div className="hidden max-h-[520px] overflow-auto sm:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">
                <button
                  type="button"
                  onClick={() => toggleSort('foldIndex')}
                  className="inline-flex items-center gap-1 cursor-pointer"
                >
                  <span>{t('training.colFold')}</span>
                  <ArrowUpDown className="size-3 opacity-60" />
                </button>
              </TableHead>
              <TableHead scope="col">{t('training.colEntryTime')}</TableHead>
              <TableHead scope="col">
                <button
                  type="button"
                  onClick={() => toggleSort('exitTime')}
                  className="inline-flex items-center gap-1 cursor-pointer"
                >
                  <span>{t('training.colExitTime')}</span>
                  <ArrowUpDown className="size-3 opacity-60" />
                </button>
              </TableHead>
              <TableHead scope="col">{t('table.side')}</TableHead>
              <TableHead scope="col" className="text-right">
                {t('table.size')}
              </TableHead>
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
                <button
                  type="button"
                  onClick={() => toggleSort('pnl')}
                  className="inline-flex items-center gap-1 cursor-pointer"
                >
                  <span>{t('training.colNetPnl')}</span>
                  <ArrowUpDown className="size-3 opacity-60" />
                </button>
              </TableHead>
              <TableHead scope="col" className="text-right">
                <button
                  type="button"
                  onClick={() => toggleSort('rMultiple')}
                  className="inline-flex items-center gap-1 cursor-pointer"
                >
                  <span>{t('training.colRMultiple')}</span>
                  <ArrowUpDown className="size-3 opacity-60" />
                </button>
              </TableHead>
              <TableHead scope="col">{t('training.colExitReason')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((tr) => (
              <TableRow key={`${tr.id}-${tr.exitTime ?? tr.time}`}>
                <TableCell className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
                  {tr.foldIndex !== undefined ? `#${tr.foldIndex + 1}` : '—'}
                </TableCell>
                <TableCell className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
                  {formatShortUtcDate(tr.entryTime)}
                </TableCell>
                <TableCell className="font-mono text-[11px] tabular-nums">
                  {formatShortUtcDate(tr.exitTime ?? Date.parse(tr.time))}
                </TableCell>
                <TableCell>
                  <Badge variant={tr.side === 'buy' ? 'positive' : 'negative'}>
                    {tr.side.toUpperCase()}
                  </Badge>
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {formatMoney(tr.size)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {formatPrice(tr.entryPrice)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {formatPrice(tr.exitPrice)}
                </TableCell>
                <TableCell className="text-right font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
                  {formatMoney(tr.fees ?? 0)}
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
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {formatOrDash(tr.rMultiple ?? null, (v) => formatR(v))}
                </TableCell>
                <TableCell className="font-mono text-[11px] text-muted-foreground">
                  {tr.exitReason ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile card rows (< sm) */}
      <div className="flex flex-col gap-2 sm:hidden">
        {filtered.map((tr) => (
          <div
            key={`${tr.id}-${tr.exitTime ?? tr.time}`}
            className="flex flex-col gap-1 rounded-sm bg-muted/25 p-3 font-mono text-[11px] tabular-nums"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <Badge variant={tr.side === 'buy' ? 'positive' : 'negative'}>
                  {tr.side.toUpperCase()}
                </Badge>
                <span>{tr.foldIndex !== undefined ? `F${tr.foldIndex + 1}` : ''}</span>
              </div>
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
                {formatSignedMoney(tr.pnl)} (
                {formatOrDash(tr.rMultiple ?? null, (v) => formatR(v))})
              </span>
            </div>
            <div className="flex items-center justify-between text-[var(--text-subtle)]">
              <span>
                {formatPrice(tr.entryPrice)} → {formatPrice(tr.exitPrice)}
              </span>
              <span>{tr.exitReason ?? '—'}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

const TradesTab = memo(TradesTabInner)
export default TradesTab
