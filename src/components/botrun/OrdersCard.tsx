import { memo, useMemo, useState } from 'react'
import { Download, RefreshCw, Search, X } from 'lucide-react'
import type {
  ExchangeOrderRecord,
  ExchangeOrderStatus,
  StreamConnectionStatus,
} from '@/api/botClient'
import OperatorSection from '@/components/botrun/OperatorSection'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  buildOrdersCsv,
  downloadTextFile,
  formatUtcTimestamp,
} from '@/botRunUtils'
import { useI18n } from '@/i18n'

type OrderSortKey =
  | 'time-desc'
  | 'time-asc'
  | 'notional-desc'
  | 'price-desc'
  | 'status-asc'

const STATUS_OPTIONS: readonly ('ALL' | ExchangeOrderStatus)[] = [
  'ALL',
  'FILLED',
  'NEW',
  'PARTIALLY_FILLED',
  'LIVE',
  'CANCELED',
  'REJECTED_RISK',
  'CANCELED_KILLSWITCH',
]

const PAGE_SIZE = 20

function statusBadgeVariant(status: ExchangeOrderStatus) {
  if (status === 'FILLED') return 'positive' as const
  if (status === 'REJECTED_RISK' || status === 'CANCELED_KILLSWITCH') {
    return 'negative' as const
  }
  if (status === 'NEW' || status === 'PARTIALLY_FILLED' || status === 'LIVE') {
    return 'warning' as const
  }
  return 'secondary' as const
}

function isCancelableTestnetOrder(order: ExchangeOrderRecord): boolean {
  return (
    order.mode === 'binance-testnet' &&
    (order.status === 'NEW' ||
      order.status === 'PARTIALLY_FILLED' ||
      order.status === 'LIVE')
  )
}

type OrdersCardProps = {
  orders: ExchangeOrderRecord[]
  updatedAt: string | null
  streamStatus: StreamConnectionStatus
  loading: boolean
  error: string | null
  open: boolean
  onToggle: () => void
  busyAction: string | null
  onRefresh: () => void
  onCancelOrder: (orderId: string) => Promise<void>
}

function OrdersCard({
  orders,
  updatedAt,
  streamStatus,
  loading,
  error,
  open,
  onToggle,
  busyAction,
  onRefresh,
  onCancelOrder,
}: OrdersCardProps) {
  const { t } = useI18n()
  const [statusFilter, setStatusFilter] = useState<'ALL' | ExchangeOrderStatus>(
    'ALL',
  )
  const [sideFilter, setSideFilter] = useState<'ALL' | 'BUY' | 'SELL'>('ALL')
  const [sourceFilter, setSourceFilter] = useState<
    'ALL' | 'manual' | 'bot-auto'
  >('ALL')
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState<OrderSortKey>('time-desc')
  const [page, setPage] = useState(0)

  const filteredOrders = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const list = orders.filter((o) => {
      if (statusFilter !== 'ALL' && o.status !== statusFilter) return false
      if (sideFilter !== 'ALL' && o.side !== sideFilter) return false
      if (sourceFilter !== 'ALL' && o.source !== sourceFilter) return false
      if (q) {
        const hay =
          `${o.id} ${o.pair} ${o.venueOrderId ?? ''} ${o.clientOrderId ?? ''} ${o.reason ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })

    const sorted = [...list]
    sorted.sort((a, b) => {
      if (sortBy === 'time-asc') {
        return Date.parse(a.timestamp) - Date.parse(b.timestamp)
      }
      if (sortBy === 'notional-desc') {
        return b.notionalUsd - a.notionalUsd
      }
      if (sortBy === 'price-desc') {
        return (b.avgPrice ?? b.price) - (a.avgPrice ?? a.price)
      }
      if (sortBy === 'status-asc') {
        return a.status.localeCompare(b.status)
      }
      return Date.parse(b.timestamp) - Date.parse(a.timestamp)
    })
    return sorted
  }, [orders, statusFilter, sideFilter, sourceFilter, searchQuery, sortBy])

  const totalPages = Math.max(1, Math.ceil(filteredOrders.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const pagedOrders = useMemo(
    () =>
      filteredOrders.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE),
    [filteredOrders, safePage],
  )

  function handleExportCsv() {
    const csv = buildOrdersCsv(filteredOrders)
    downloadTextFile(
      `flare-orders-${new Date().toISOString().slice(0, 10)}.csv`,
      csv,
    )
  }

  return (
    <OperatorSection
      id="orders"
      title={t('botRun.ordersTitle')}
      badges={<Badge variant="outline">{filteredOrders.length}</Badge>}
      sourceLabel="/api/exchange/orders"
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
            variant="ghost"
            onClick={onRefresh}
            disabled={loading}
          >
            <RefreshCw className="size-3" />
            <span>{t('botRun.refresh')}</span>
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={filteredOrders.length === 0}
            onClick={handleExportCsv}
          >
            <Download className="size-3" />
            <span>CSV</span>
          </Button>
        </>
      }
    >
      {/* Filters & Search Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[160px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value)
              setPage(0)
            }}
            placeholder={t('botRun.ordersSearchPlaceholder')}
            aria-label={t('botRun.ordersSearchAria')}
            className="h-8 pl-8 font-mono text-xs"
          />
        </div>

        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v as 'ALL' | ExchangeOrderStatus)
            setPage(0)
          }}
        >
          <SelectTrigger
            className="h-8 w-[148px] font-mono text-[11px]"
            aria-label={t('botRun.colStatus')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((st) => (
              <SelectItem key={st} value={st}>
                {st === 'ALL' ? t('botRun.ordersStatusAll') : st}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={sideFilter}
          onValueChange={(v) => {
            setSideFilter(v as 'ALL' | 'BUY' | 'SELL')
            setPage(0)
          }}
        >
          <SelectTrigger
            className="h-8 w-[105px] font-mono text-[11px]"
            aria-label={t('botRun.ticketSide')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t('botRun.ordersSideAll')}</SelectItem>
            <SelectItem value="BUY">BUY</SelectItem>
            <SelectItem value="SELL">SELL</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={sourceFilter}
          onValueChange={(v) => {
            setSourceFilter(v as 'ALL' | 'manual' | 'bot-auto')
            setPage(0)
          }}
        >
          <SelectTrigger
            className="h-8 w-[122px] font-mono text-[11px]"
            aria-label={t('botRun.colSource')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t('botRun.ordersSourceAll')}</SelectItem>
            <SelectItem value="manual">manual</SelectItem>
            <SelectItem value="bot-auto">bot-auto</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={sortBy}
          onValueChange={(v) => setSortBy(v as OrderSortKey)}
        >
          <SelectTrigger
            className="h-8 w-[134px] font-mono text-[11px]"
            aria-label={t('botRun.ordersSortNewest')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="time-desc">
              {t('botRun.ordersSortNewest')}
            </SelectItem>
            <SelectItem value="time-asc">
              {t('botRun.ordersSortOldest')}
            </SelectItem>
            <SelectItem value="notional-desc">
              {t('botRun.ordersSortSize')}
            </SelectItem>
            <SelectItem value="price-desc">
              {t('botRun.ordersSortPrice')}
            </SelectItem>
            <SelectItem value="status-asc">
              {t('botRun.ordersSortStatus')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {pagedOrders.length === 0 ? (
        <div className="rounded-sm bg-muted/25 px-3 py-6 text-center text-xs text-muted-foreground">
          {orders.length === 0
            ? t('botRun.ordersEmptySql')
            : t('botRun.ordersEmptyFilter')}
        </div>
      ) : (
        <>
          {/* Desktop Dense Table */}
          <div className="hidden overflow-x-auto sm:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('botRun.colTime')}</TableHead>
                  <TableHead>{t('botRun.colSource')}</TableHead>
                  <TableHead>{t('botRun.pair')}</TableHead>
                  <TableHead>{t('botRun.ticketSide')}</TableHead>
                  <TableHead className="text-right">
                    {t('botRun.colSize')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('botRun.colFilledQty')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('botRun.colAvgPrice')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('botRun.colFees')}
                  </TableHead>
                  <TableHead>{t('botRun.colStatus')}</TableHead>
                  <TableHead>Venue ID</TableHead>
                  <TableHead>{t('botRun.colReason')}</TableHead>
                  <TableHead className="text-right">
                    {t('botRun.colAction')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedOrders.map((order) => {
                  const avg = order.avgPrice ?? order.price
                  const canCancel = isCancelableTestnetOrder(order)
                  return (
                    <TableRow key={order.id} className="font-mono text-[11px]">
                      <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                        {formatUtcTimestamp(order.timestamp)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <span className="text-foreground">{order.source}</span>
                        <span className="ml-1 text-[9.5px] uppercase text-muted-foreground">
                          (
                          {order.mode === 'binance-testnet'
                            ? 'TESTNET'
                            : 'PAPER'}
                          )
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-semibold">
                        {order.pair}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            order.side === 'BUY' ? 'positive' : 'negative'
                          }
                          className="text-[10px]"
                        >
                          {order.side}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        ${order.notionalUsd.toFixed(2)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {order.filledQty !== undefined
                          ? order.filledQty.toFixed(6)
                          : order.quantity.toFixed(6)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {avg > 0 ? `$${avg.toFixed(2)}` : '—'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                        {order.fee !== undefined
                          ? `${order.fee.toFixed(4)} ${order.feeAsset ?? ''}`.trim()
                          : '—'}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={statusBadgeVariant(order.status)}
                          className="text-[10px]"
                        >
                          {order.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[110px] truncate text-muted-foreground">
                        {order.venueOrderId ?? order.id}
                      </TableCell>
                      <TableCell
                        className="max-w-[180px] truncate text-muted-foreground"
                        title={order.reason}
                      >
                        {order.reason ?? '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        {canCancel ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={busyAction !== null}
                            onClick={() => void onCancelOrder(order.id)}
                          >
                            <X className="size-3" />
                            <span>{t('botRun.cancel')}</span>
                          </Button>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>

          {/* Mobile Card-Row List */}
          <div className="flex flex-col gap-2 sm:hidden">
            {pagedOrders.map((order) => {
              const avg = order.avgPrice ?? order.price
              const canCancel = isCancelableTestnetOrder(order)
              return (
                <div
                  key={order.id}
                  className="flex flex-col gap-1.5 rounded-sm bg-muted/25 p-2.5 font-mono text-[11px]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <Badge
                        variant={order.side === 'BUY' ? 'positive' : 'negative'}
                        className="text-[10px]"
                      >
                        {order.side}
                      </Badge>
                      <strong>{order.pair}</strong>
                      <span className="text-[10px] text-muted-foreground">
                        {order.source}
                      </span>
                    </div>
                    <Badge
                      variant={statusBadgeVariant(order.status)}
                      className="text-[10px]"
                    >
                      {order.status}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-muted-foreground tabular-nums">
                    <span>Size: ${order.notionalUsd.toFixed(2)}</span>
                    <span>Avg: {avg > 0 ? `$${avg.toFixed(2)}` : '—'}</span>
                    <span>
                      Qty: {(order.filledQty ?? order.quantity).toFixed(5)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                    <span>{formatUtcTimestamp(order.timestamp)}</span>
                    <span>{order.venueOrderId ?? order.id}</span>
                  </div>
                  {order.reason && (
                    <span className="text-[10.5px] text-muted-foreground">
                      {order.reason}
                    </span>
                  )}
                  {canCancel && (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={busyAction !== null}
                      onClick={() => void onCancelOrder(order.id)}
                    >
                      {t('botRun.cancelOrder')}
                    </Button>
                  )}
                </div>
              )
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-1 font-mono text-[11px] text-muted-foreground">
              <span>
                {safePage * PAGE_SIZE + 1}–
                {Math.min((safePage + 1) * PAGE_SIZE, filteredOrders.length)} /{' '}
                {filteredOrders.length}
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={safePage <= 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  {t('botRun.prev')}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={safePage >= totalPages - 1}
                  onClick={() =>
                    setPage((p) => Math.min(totalPages - 1, p + 1))
                  }
                >
                  {t('botRun.next')}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </OperatorSection>
  )
}

export default memo(OrdersCard)
