import { memo, useState } from 'react'
import { Lock, Send, ShieldAlert, XCircle } from 'lucide-react'
import type {
  BotServerSnapshot,
  ExchangeAccountResponse,
  ExchangeOrderRecord,
  StreamConnectionStatus,
} from '@/api/botClient'
import OperatorSection from '@/components/botrun/OperatorSection'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
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
import { formatUtcTimestamp } from '@/botRunUtils'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

function createOrderUuid(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return `manual-${crypto.randomUUID()}`
  }
  return `manual-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

type PositionsCardProps = {
  snapshot: BotServerSnapshot
  account: ExchangeAccountResponse | null
  orders: ExchangeOrderRecord[]
  liveMarkPrice: number | null
  liveMarkPair: string | null
  lastSseAt: string | null
  streamStatus: StreamConnectionStatus
  open: boolean
  onToggle: () => void
  busyAction: string | null
  confirmCloseOpen: boolean
  onConfirmCloseOpenChange: (open: boolean) => void
  onClosePosition: () => Promise<void>
  onSubmitOrder: (params: {
    pair: string
    side: 'BUY' | 'SELL'
    notionalUsd: number
    clientOrderId: string
  }) => Promise<boolean>
}

function PositionsCard({
  snapshot,
  account,
  orders,
  liveMarkPrice,
  liveMarkPair,
  lastSseAt,
  streamStatus,
  open,
  onToggle,
  busyAction,
  confirmCloseOpen,
  onConfirmCloseOpenChange,
  onClosePosition,
  onSubmitOrder,
}: PositionsCardProps) {
  const { t } = useI18n()
  const { preset, state, exchange, mt5 } = snapshot
  const allowedPairs = exchange?.hardLimits.allowedPairs ?? []
  const maxNotional = exchange?.hardLimits.maxOrderNotionalUsd ?? 0
  const accountMode = snapshot.accountMode ?? exchange?.mode ?? 'paper'
  const killSwitchActive = Boolean(exchange?.killSwitchActive)

  const [selectedPair, setSelectedPair] = useState<string>('')
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [notionalInput, setNotionalInput] = useState('')
  const [orderConfirmOpen, setOrderConfirmOpen] = useState(false)
  const [pendingClientOrderId, setPendingClientOrderId] = useState<
    string | null
  >(null)
  const [submittingOrder, setSubmittingOrder] = useState(false)

  const effectivePair =
    selectedPair && allowedPairs.includes(selectedPair)
      ? selectedPair
      : allowedPairs.includes(preset.strategy.pair)
        ? preset.strategy.pair
        : (allowedPairs[0] ?? '')

  const openPos = state.openPosition
  const botTestnetPos = exchange?.botOwnedPosition ?? null
  const mt5Positions = mt5?.reportedPositions ?? null

  const paperMark =
    openPos && liveMarkPair === openPos.pair && liveMarkPrice !== null
      ? liveMarkPrice
      : null
  const paperUnrealizedUsd =
    openPos && paperMark !== null
      ? (openPos.side === 'buy' ? 1 : -1) *
        (paperMark - openPos.entryPrice) *
        openPos.quantity
      : null
  const paperUnrealizedPct =
    openPos && paperUnrealizedUsd !== null && openPos.notional > 0
      ? (paperUnrealizedUsd / openPos.notional) * 100
      : null

  const testnetMark =
    botTestnetPos &&
    liveMarkPair === botTestnetPos.pair &&
    liveMarkPrice !== null
      ? liveMarkPrice
      : null
  const testnetUnrealizedUsd =
    botTestnetPos && testnetMark !== null
      ? (testnetMark - botTestnetPos.entryPrice) * botTestnetPos.quantity
      : null

  const openTestnetOrders = orders.filter(
    (o) =>
      o.mode === 'binance-testnet' &&
      (o.status === 'NEW' ||
        o.status === 'PARTIALLY_FILLED' ||
        o.status === 'LIVE'),
  )

  const hasClosablePosition = Boolean(openPos || botTestnetPos)

  const parsedNotional = Number(notionalInput.trim())
  const notionalValid =
    notionalInput.trim() !== '' &&
    Number.isFinite(parsedNotional) &&
    parsedNotional >= 10 &&
    (maxNotional <= 0 || parsedNotional <= maxNotional)

  const notionalError =
    notionalInput.trim() === ''
      ? null
      : !Number.isFinite(parsedNotional) || parsedNotional < 10
        ? t('botRun.ticketMinErr')
        : maxNotional > 0 && parsedNotional > maxNotional
          ? t('botRun.ticketMaxErr', { max: maxNotional })
          : null

  const ticketEstPrice =
    effectivePair && liveMarkPair === effectivePair && liveMarkPrice !== null
      ? liveMarkPrice
      : null
  const ticketEstQty =
    notionalValid && ticketEstPrice !== null && ticketEstPrice > 0
      ? parsedNotional / ticketEstPrice
      : null
  const feePct =
    accountMode === 'binance-testnet' ? 0.1 : preset.execution.commissionPct
  const ticketEstFee = notionalValid ? (parsedNotional * feePct) / 100 : null

  const canPlaceOrder =
    !killSwitchActive &&
    Boolean(effectivePair) &&
    notionalValid &&
    (accountMode === 'binance-testnet' || Boolean(exchange?.paperFunded)) &&
    !submittingOrder &&
    busyAction === null

  function handleOpenOrderConfirm() {
    if (!canPlaceOrder) return
    setPendingClientOrderId((prev) => prev ?? createOrderUuid())
    setOrderConfirmOpen(true)
  }

  async function handleConfirmOrder() {
    if (!canPlaceOrder || !pendingClientOrderId) return
    setSubmittingOrder(true)
    try {
      const ok = await onSubmitOrder({
        pair: effectivePair,
        side,
        notionalUsd: parsedNotional,
        clientOrderId: pendingClientOrderId,
      })
      if (ok) {
        setOrderConfirmOpen(false)
        setPendingClientOrderId(null)
        setNotionalInput('')
      }
    } finally {
      setSubmittingOrder(false)
    }
  }

  return (
    <OperatorSection
      id="positions"
      title={t('botRun.posTitle')}
      badges={
        <>
          {openPos && <Badge variant="warning">PAPER OPEN</Badge>}
          {botTestnetPos && <Badge variant="warning">TESTNET HOLDING</Badge>}
          {!openPos && !botTestnetPos && (
            <Badge variant="secondary">{t('botRun.posFlat')}</Badge>
          )}
        </>
      }
      sourceLabel="Runtime + Live Market Feed"
      updatedAt={lastSseAt ?? snapshot.telemetry?.lastTickAt ?? exchange?.updatedAt}
      staleAfterMs={30_000}
      connectionState={streamStatus}
      open={open}
      onToggle={onToggle}
      actions={
        hasClosablePosition ? (
          <AlertDialog
            open={confirmCloseOpen}
            onOpenChange={onConfirmCloseOpenChange}
          >
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                size="xs"
                variant="destructive"
                disabled={busyAction !== null}
              >
                <XCircle className="size-3" />
                <span>{t('botRun.posCloseBtn')}</span>
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('botRun.posCloseTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('botRun.posCloseDesc')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('botRun.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    onConfirmCloseOpenChange(false)
                    void onClosePosition()
                  }}
                >
                  {t('botRun.posCloseConfirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null
      }
    >
      {/* 1. Paper Open Position */}
      {openPos && (
        <div className="flex flex-col gap-2 rounded-sm bg-[var(--brand-violet)]/10 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-5 items-center rounded-sm bg-[var(--brand-violet)]/18 px-2 font-mono text-[10px] font-bold uppercase text-[var(--brand-violet)]">
                PAPER
              </span>
              <Badge variant={openPos.side === 'buy' ? 'positive' : 'negative'}>
                {openPos.side === 'buy' ? 'LONG' : 'SHORT'}
              </Badge>
              <strong className="font-mono text-xs text-foreground">
                {openPos.pair}
              </strong>
              {openPos.breakevenArmed && (
                <Badge variant="positive" className="gap-1 text-[10px]">
                  <Lock className="size-2.5" />
                  <span>PROFIT-LOCK</span>
                </Badge>
              )}
            </div>
            <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">
              {formatUtcTimestamp(openPos.entryTime)}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 font-mono text-xs tabular-nums sm:grid-cols-5">
            <div className="flex flex-col rounded-sm bg-background/55 p-2">
              <span className="text-[10px] text-muted-foreground">Entry</span>
              <strong>${openPos.entryPrice.toFixed(2)}</strong>
            </div>
            <div className="flex flex-col rounded-sm bg-background/55 p-2">
              <span className="text-[10px] text-muted-foreground">
                {t('botRun.posLiveMark')}
              </span>
              <strong>
                {paperMark !== null ? `$${paperMark.toFixed(2)}` : '—'}
              </strong>
            </div>
            <div className="flex flex-col rounded-sm bg-background/55 p-2">
              <span className="text-[10px] text-muted-foreground">
                Unrealized PnL
              </span>
              <strong
                className={cn(
                  paperUnrealizedUsd === null
                    ? 'text-muted-foreground'
                    : paperUnrealizedUsd >= 0
                      ? 'text-[var(--positive)]'
                      : 'text-[var(--negative)]',
                )}
              >
                {paperUnrealizedUsd !== null
                  ? `${paperUnrealizedUsd >= 0 ? '+' : ''}$${paperUnrealizedUsd.toFixed(2)}${paperUnrealizedPct !== null ? ` (${paperUnrealizedPct >= 0 ? '+' : ''}${paperUnrealizedPct.toFixed(2)}%)` : ''}`
                  : '—'}
              </strong>
            </div>
            <div className="flex flex-col rounded-sm bg-background/55 p-2">
              <span className="text-[10px] text-muted-foreground">
                Stop Loss
              </span>
              <strong className="text-[var(--negative)]">
                ${openPos.stopPrice.toFixed(2)}
              </strong>
            </div>
            <div className="flex flex-col rounded-sm bg-background/55 p-2">
              <span className="text-[10px] text-muted-foreground">
                Take Profit
              </span>
              <strong className="text-[var(--positive)]">
                ${openPos.targetPrice.toFixed(2)}
              </strong>
            </div>
          </div>
        </div>
      )}

      {/* Active Paper Prediction Tickets */}
      {state.activeTickets.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-sm bg-[var(--brand-violet)]/10 p-3">
          <div className="flex items-center gap-2 font-mono text-[11px] font-semibold">
            <span className="inline-flex h-4 items-center rounded-sm bg-[var(--brand-violet)]/18 px-1.5 text-[9.5px] font-bold uppercase text-[var(--brand-violet)]">
              PAPER
            </span>
            <span>
              {t('botRun.posActiveTickets')} ({state.activeTickets.length})
            </span>
          </div>
          {state.activeTickets.map((tk) => (
            <div
              key={tk.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-sm bg-background/55 px-2.5 py-1.5 font-mono text-[11px] tabular-nums"
            >
              <span>
                #{tk.id} · {tk.outcome} · {tk.title}
              </span>
              <span>
                ${tk.stakeUsd.toFixed(2)} @ {tk.fairPricePaid.toFixed(3)} ·{' '}
                {tk.barsElapsed}/{tk.horizonBars} bars
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 2. Testnet Spot Balances & Open Orders */}
      {account?.connected && (
        <div className="flex flex-col gap-2 rounded-sm bg-muted/25 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-5 items-center rounded-sm bg-[var(--warning-soft)] px-2 font-mono text-[10px] font-bold uppercase text-[var(--warning)]">
                TESTNET
              </span>
              <strong className="text-xs text-foreground">
                {t('botRun.posTestnetSpotTitle')}
              </strong>
            </div>
            <Badge variant="outline">
              {t('botRun.posOpenOrdersCount', {
                count: openTestnetOrders.length,
              })}
            </Badge>
          </div>

          {botTestnetPos ? (
            <div className="grid grid-cols-2 gap-2 rounded-sm bg-background/55 p-2 font-mono text-[11px] tabular-nums sm:grid-cols-4">
              <div>
                <span className="block text-[10px] text-muted-foreground">
                  {t('botRun.posBotHolding')}
                </span>
                <strong>
                  {botTestnetPos.pair} ({botTestnetPos.quantity})
                </strong>
              </div>
              <div>
                <span className="block text-[10px] text-muted-foreground">
                  Entry
                </span>
                <strong>${botTestnetPos.entryPrice.toFixed(2)}</strong>
              </div>
              <div>
                <span className="block text-[10px] text-muted-foreground">
                  Unrealized
                </span>
                <strong
                  className={cn(
                    testnetUnrealizedUsd === null
                      ? 'text-muted-foreground'
                      : testnetUnrealizedUsd >= 0
                        ? 'text-[var(--positive)]'
                        : 'text-[var(--negative)]',
                  )}
                >
                  {testnetUnrealizedUsd !== null
                    ? `${testnetUnrealizedUsd >= 0 ? '+' : ''}$${testnetUnrealizedUsd.toFixed(2)}`
                    : '—'}
                </strong>
              </div>
              <div>
                <span className="block text-[10px] text-muted-foreground">
                  Order ID
                </span>
                <strong>{botTestnetPos.orderId}</strong>
              </div>
            </div>
          ) : (
            <p className="text-[11.5px] text-muted-foreground">
              {t('botRun.posNoTestnetHolding')}
            </p>
          )}
        </div>
      )}

      {/* 3. MT5 Positions (EA-reported only) */}
      <div className="flex flex-col gap-1.5 rounded-sm bg-muted/20 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {t('botRun.posMt5Header')}
          </span>
          <Badge variant="secondary" className="text-[9.5px]">
            {mt5Positions && mt5Positions.length > 0
              ? `${mt5Positions.length} OPEN`
              : !mt5 || mt5.pollCount === 0
                ? t('botRun.posMt5Waiting')
                : t('botRun.posMt5SignalOnly')}
          </Badge>
        </div>

        {mt5Positions && mt5Positions.length > 0 ? (
          <div className="flex flex-col gap-1">
            {mt5Positions.map((pos) => (
              <div
                key={pos.ticket}
                className="flex flex-wrap items-center justify-between gap-2 rounded-sm bg-background/55 px-2.5 py-1.5 font-mono text-[11px] tabular-nums"
              >
                <span>
                  #{pos.ticket} · {pos.side} {pos.volume} {pos.symbol} @{' '}
                  {pos.openPrice}
                </span>
                <span
                  className={
                    pos.profit >= 0
                      ? 'text-[var(--positive)]'
                      : 'text-[var(--negative)]'
                  }
                >
                  {pos.profit >= 0 ? '+' : ''}${pos.profit.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {!mt5 || mt5.pollCount === 0
              ? t('botRun.posMt5EmptyWaiting')
              : t('botRun.posMt5EmptyUnconfirmed')}
          </p>
        )}
      </div>

      {/* 4. Manual Order Ticket */}
      <div className="flex flex-col gap-2.5 rounded-sm bg-muted/25 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong className="font-mono text-[11px] uppercase tracking-[0.05em] text-foreground">
            {t('botRun.ticketTitle')}
          </strong>
          <span
            className={cn(
              'inline-flex h-4 items-center rounded-sm px-1.5 font-mono text-[9.5px] font-bold uppercase',
              accountMode === 'binance-testnet'
                ? 'bg-[var(--warning-soft)] text-[var(--warning)]'
                : 'bg-[var(--brand-violet)]/15 text-[var(--brand-violet)]',
            )}
          >
            {accountMode === 'binance-testnet' ? 'TESTNET' : 'PAPER'}
          </span>
        </div>

        {killSwitchActive && (
          <div className="flex items-center gap-2 rounded-sm bg-[var(--negative-soft)] px-2.5 py-1.5 text-[11.5px] text-[var(--negative)]">
            <ShieldAlert className="size-3.5 shrink-0" />
            <span>{t('botRun.ticketKillBlocked')}</span>
          </div>
        )}

        {accountMode === 'paper' && !exchange?.paperFunded && (
          <p className="text-[11.5px] text-muted-foreground">
            {t('botRun.ticketFundFirst')}
          </p>
        )}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
          <div className="flex flex-col gap-1 sm:col-span-4">
            <span className="font-mono text-[10px] text-muted-foreground">
              {t('botRun.pair')}
            </span>
            <Select
              value={effectivePair}
              disabled={allowedPairs.length === 0 || killSwitchActive}
              onValueChange={setSelectedPair}
            >
              <SelectTrigger
                className="h-8 font-mono text-xs"
                aria-label={t('botRun.pair')}
              >
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {allowedPairs.map((pair) => (
                  <SelectItem key={pair} value={pair}>
                    {pair}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1 sm:col-span-3">
            <span className="font-mono text-[10px] text-muted-foreground">
              {t('botRun.ticketSide')}
            </span>
            <div className="grid grid-cols-2 gap-1">
              <Button
                type="button"
                size="xs"
                variant={side === 'BUY' ? 'positive' : 'outline'}
                className="h-8"
                onClick={() => setSide('BUY')}
              >
                BUY
              </Button>
              <Button
                type="button"
                size="xs"
                variant={side === 'SELL' ? 'destructive' : 'outline'}
                className="h-8"
                onClick={() => setSide('SELL')}
              >
                SELL
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-1 sm:col-span-3">
            <label
              htmlFor="botrun-order-notional"
              className="font-mono text-[10px] text-muted-foreground"
            >
              {t('botRun.ticketNotional')}
            </label>
            <Input
              id="botrun-order-notional"
              type="number"
              min={10}
              max={maxNotional > 0 ? maxNotional : undefined}
              step="10"
              placeholder={maxNotional > 0 ? `10–${maxNotional}` : '10+'}
              value={notionalInput}
              onChange={(e) => setNotionalInput(e.target.value)}
              aria-invalid={Boolean(notionalError)}
              className="h-8 font-mono text-xs tabular-nums"
            />
          </div>

          <div className="flex items-end sm:col-span-2">
            <Button
              type="button"
              size="sm"
              variant="default"
              className="h-8 w-full"
              disabled={!canPlaceOrder}
              onClick={handleOpenOrderConfirm}
            >
              <Send className="size-3" />
              <span>{t('botRun.ticketSubmit')}</span>
            </Button>
          </div>
        </div>

        {notionalError && (
          <span className="text-[11px] text-[var(--negative)]">
            {notionalError}
          </span>
        )}

        {/* Estimated Qty & Fee Preview */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground tabular-nums">
          <span>
            {t('botRun.ticketEstPrice')}{' '}
            <strong className="text-foreground">
              {ticketEstPrice !== null ? `$${ticketEstPrice.toFixed(2)}` : '—'}
            </strong>
          </span>
          <span>
            {t('botRun.ticketEstQty')}{' '}
            <strong className="text-foreground">
              {ticketEstQty !== null ? ticketEstQty.toFixed(6) : '—'}
            </strong>
          </span>
          <span>
            {t('botRun.ticketEstFee')}{' '}
            <strong className="text-foreground">
              {ticketEstFee !== null
                ? `$${ticketEstFee.toFixed(4)} (${feePct}%)`
                : `${feePct}%`}
            </strong>
          </span>
        </div>

        {/* Manual Order Confirmation Dialog */}
        <AlertDialog
          open={orderConfirmOpen}
          onOpenChange={(nextOpen) => {
            setOrderConfirmOpen(nextOpen)
            if (!nextOpen && !submittingOrder) {
              setPendingClientOrderId(null)
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('botRun.ticketConfirmTitle')}
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                  <p>{t('botRun.ticketConfirmDesc')}</p>
                  <div className="grid grid-cols-2 gap-1.5 rounded-sm bg-muted/40 p-2.5 font-mono text-[11px] text-foreground tabular-nums">
                    <span>Mode:</span>
                    <strong>
                      {accountMode === 'binance-testnet' ? 'TESTNET' : 'PAPER'}
                    </strong>
                    <span>Pair / Side:</span>
                    <strong>
                      {effectivePair} · {side}
                    </strong>
                    <span>Notional:</span>
                    <strong>
                      $
                      {Number.isFinite(parsedNotional)
                        ? parsedNotional.toFixed(2)
                        : '0.00'}
                    </strong>
                    <span>Est. Qty:</span>
                    <strong>
                      {ticketEstQty !== null ? ticketEstQty.toFixed(6) : 'Market'}
                    </strong>
                    <span>Est. Fee:</span>
                    <strong>
                      {ticketEstFee !== null
                        ? `$${ticketEstFee.toFixed(4)} (${feePct}%)`
                        : `${feePct}%`}
                    </strong>
                    <span>Client Order ID:</span>
                    <strong className="truncate">
                      {pendingClientOrderId ?? '—'}
                    </strong>
                  </div>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={submittingOrder}>
                {t('botRun.cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={submittingOrder}
                onClick={(e) => {
                  e.preventDefault()
                  void handleConfirmOrder()
                }}
              >
                {submittingOrder
                  ? t('botRun.ticketSubmitting')
                  : t('botRun.ticketPlaceOrder')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </OperatorSection>
  )
}

export default memo(PositionsCard)
