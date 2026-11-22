import { memo, useState } from 'react'
import { RefreshCw, RotateCcw } from 'lucide-react'
import type {
  BotServerSnapshot,
  ExchangeAccountResponse,
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
import { formatUtcTimestamp } from '@/botRunUtils'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

type AccountCardProps = {
  snapshot: BotServerSnapshot
  account: ExchangeAccountResponse | null
  accountLoading: boolean
  accountError: string | null
  liveMarkPrice: number | null
  streamStatus: StreamConnectionStatus
  open: boolean
  onToggle: () => void
  onRetryAccount: () => void
  onFundPaper: (amountUsd: number) => Promise<void>
  onResetSession: () => Promise<void>
  busyAction: string | null
}

function AccountCard({
  snapshot,
  account,
  accountLoading,
  accountError,
  liveMarkPrice,
  streamStatus,
  open,
  onToggle,
  onRetryAccount,
  onFundPaper,
  onResetSession,
  busyAction,
}: AccountCardProps) {
  const { t } = useI18n()
  const [fundInput, setFundInput] = useState('')
  const [fundError, setFundError] = useState<string | null>(null)
  const [resetOpen, setResetOpen] = useState(false)

  const { state, exchange, telemetry } = snapshot
  const openPos = state.openPosition
  const unrealizedPaperPnl =
    openPos && liveMarkPrice !== null && liveMarkPrice > 0
      ? (openPos.side === 'buy' ? 1 : -1) *
        (liveMarkPrice - openPos.entryPrice) *
        openPos.quantity
      : null

  const lockedStake = state.activeTickets.reduce(
    (acc, tk) => acc + tk.stakeUsd,
    0,
  )
  const totalPaperEquity =
    state.balance + lockedStake + (unrealizedPaperPnl ?? 0)
  const paperNetPnl = totalPaperEquity - state.initialBalance
  const paperNetPnlPct =
    state.initialBalance > 0
      ? (paperNetPnl / state.initialBalance) * 100
      : null

  function handleSubmitPaperFund() {
    const val = Number(fundInput.trim())
    if (
      fundInput.trim() === '' ||
      !Number.isFinite(val) ||
      val < 10 ||
      val > 10_000_000
    ) {
      setFundError(t('botRun.acctFundErr'))
      return
    }
    setFundError(null)
    void onFundPaper(val).then(() => setFundInput(''))
  }

  return (
    <OperatorSection
      id="account"
      title={t('botRun.acctTitle')}
      badges={
        <>
          <span
            className={cn(
              'inline-flex h-5 items-center rounded-sm px-2 font-mono text-[10px] font-bold uppercase',
              account?.connected
                ? 'bg-[var(--warning-soft)] text-[var(--warning)]'
                : 'bg-[var(--brand-violet)]/15 text-[var(--brand-violet)]',
            )}
          >
            {account?.connected ? 'TESTNET' : 'PAPER'}
          </span>
          <Badge variant={account?.connected ? 'positive' : 'secondary'}>
            {account?.connected
              ? t('botRun.acctConnected')
              : t('botRun.acctNotConnected')}
          </Badge>
        </>
      }
      sourceLabel={
        account?.connected ? 'Binance Spot Testnet' : '/api/exchange/account'
      }
      updatedAt={
        account?.updatedAt ?? exchange?.updatedAt ?? telemetry?.lastTickAt
      }
      staleAfterMs={60_000}
      connectionState={streamStatus}
      open={open}
      onToggle={onToggle}
      loading={accountLoading}
      error={accountError}
      onRetry={onRetryAccount}
      actions={
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={accountLoading}
          onClick={onRetryAccount}
        >
          <RefreshCw
            className={cn('size-3', accountLoading && 'animate-spin')}
          />
          <span>{t('botRun.acctSync')}</span>
        </Button>
      }
    >
      {account?.connected ? (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="flex flex-col gap-0.5 rounded-sm bg-muted/25 p-2.5">
              <span className="text-[10.5px] text-muted-foreground">
                {t('botRun.acctEstEquity')}
              </span>
              <strong className="font-mono text-sm font-bold tabular-nums">
                {account.totalEquityUsd !== null
                  ? `$${account.totalEquityUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : '—'}
              </strong>
            </div>
            <div className="flex flex-col gap-0.5 rounded-sm bg-muted/25 p-2.5">
              <span className="text-[10.5px] text-muted-foreground">
                {t('botRun.acctType')}
              </span>
              <strong className="font-mono text-xs font-semibold">
                {account.accountType}
              </strong>
            </div>
            <div className="flex flex-col gap-0.5 rounded-sm bg-muted/25 p-2.5">
              <span className="text-[10.5px] text-muted-foreground">
                canTrade
              </span>
              <strong
                className={cn(
                  'font-mono text-xs font-semibold',
                  account.canTrade
                    ? 'text-[var(--positive)]'
                    : 'text-[var(--negative)]',
                )}
              >
                {account.canTrade ? 'TRUE' : 'FALSE'}
              </strong>
            </div>
            <div className="flex flex-col gap-0.5 rounded-sm bg-muted/25 p-2.5">
              <span className="text-[10.5px] text-muted-foreground">
                canWithdraw
              </span>
              <strong
                className={cn(
                  'font-mono text-xs font-semibold',
                  account.canWithdraw
                    ? 'text-[var(--warning)]'
                    : 'text-[var(--positive)]',
                )}
              >
                {account.canWithdraw ? 'TRUE' : 'FALSE'}
              </strong>
            </div>
          </div>

          {account.balances.length > 0 ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {account.balances.map((bal) => (
                <div
                  key={bal.asset}
                  className="flex flex-col gap-0.5 rounded-sm bg-muted/30 px-2.5 py-2 font-mono text-xs tabular-nums"
                >
                  <div className="flex items-center justify-between gap-2">
                    <strong className="text-foreground">{bal.asset}</strong>
                    {bal.usdValue !== null && bal.usdValue !== undefined && (
                      <span className="text-[10.5px] text-muted-foreground">
                        ${bal.usdValue.toFixed(2)}
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-foreground">
                    Free: {bal.free}
                  </span>
                  {bal.locked > 0 && (
                    <span className="text-[10.5px] text-muted-foreground">
                      Locked: {bal.locked}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t('botRun.acctNoBalances')}
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Exchange Testnet Disconnected State */}
          <div className="flex flex-col gap-2 rounded-sm bg-muted/30 p-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-foreground">
                {t('botRun.acctTestnetDown')}
              </strong>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={accountLoading}
                onClick={onRetryAccount}
              >
                <RefreshCw className="size-3" />
                <span>{t('botRun.retry')}</span>
              </Button>
            </div>
            <p className="text-muted-foreground">
              {account?.reason ?? t('botRun.acctTestnetHint')}
            </p>
            <code className="rounded-sm bg-background/60 px-2 py-1 font-mono text-[11px] text-foreground">
              BINANCE_TESTNET_KEY=... &nbsp; BINANCE_TESTNET_SECRET=...
            </code>
          </div>

          {/* Explicitly Labelled Operator-Funded PAPER Account */}
          <div className="flex flex-col gap-2.5 rounded-sm bg-[var(--brand-violet)]/8 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-5 items-center rounded-sm bg-[var(--brand-violet)]/18 px-2 font-mono text-[10px] font-bold uppercase text-[var(--brand-violet)]">
                  PAPER
                </span>
                <strong className="text-xs text-foreground">
                  {t('botRun.acctPaperTitle')}
                </strong>
              </div>

              <div className="flex items-center gap-1.5">
                <Badge
                  variant={exchange?.paperFunded ? 'secondary' : 'outline'}
                >
                  {exchange?.paperFunded
                    ? t('botRun.acctFunded')
                    : t('botRun.acctUnfunded')}
                </Badge>

                {exchange?.paperFunded && (
                  <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
                    <AlertDialogTrigger asChild>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={busyAction !== null}
                      >
                        <RotateCcw className="size-3" />
                        <span>{t('botRun.acctReset')}</span>
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {t('botRun.acctResetTitle')}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {t('botRun.acctResetDesc')}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>
                          {t('botRun.cancel')}
                        </AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => {
                            setResetOpen(false)
                            void onResetSession()
                          }}
                        >
                          {t('botRun.acctResetConfirm')}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </div>

            {exchange?.paperFunded ? (
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <div className="flex flex-col gap-0.5 rounded-sm bg-background/55 p-2">
                  <span className="text-[10.5px] text-muted-foreground">
                    {t('botRun.acctPaperEquity')}
                  </span>
                  <strong className="font-mono text-sm font-bold tabular-nums">
                    ${totalPaperEquity.toFixed(2)}
                  </strong>
                </div>
                <div className="flex flex-col gap-0.5 rounded-sm bg-background/55 p-2">
                  <span className="text-[10.5px] text-muted-foreground">
                    {t('botRun.acctPaperNetPnl')}
                  </span>
                  <strong
                    className={cn(
                      'font-mono text-sm font-bold tabular-nums',
                      paperNetPnl > 0
                        ? 'text-[var(--positive)]'
                        : paperNetPnl < 0
                          ? 'text-[var(--negative)]'
                          : 'text-foreground',
                    )}
                  >
                    {paperNetPnl >= 0 ? '+' : ''}${paperNetPnl.toFixed(2)}
                    {paperNetPnlPct !== null
                      ? ` (${paperNetPnlPct >= 0 ? '+' : ''}${paperNetPnlPct.toFixed(2)}%)`
                      : ''}
                  </strong>
                </div>
                <div className="flex flex-col gap-0.5 rounded-sm bg-background/55 p-2">
                  <span className="text-[10.5px] text-muted-foreground">
                    {t('botRun.acctOperatorFunded')}
                  </span>
                  <strong className="font-mono text-xs font-semibold tabular-nums">
                    ${state.initialBalance.toFixed(2)}
                  </strong>
                </div>
                <div className="flex flex-col gap-0.5 rounded-sm bg-background/55 p-2">
                  <span className="text-[10.5px] text-muted-foreground">
                    {t('botRun.acctBreaker')}
                  </span>
                  <strong
                    className={cn(
                      'font-mono text-xs font-semibold',
                      state.dayHalted
                        ? 'text-[var(--negative)]'
                        : 'text-[var(--positive)]',
                    )}
                  >
                    {state.dayHalted ? 'HALTED' : 'OK'}
                  </strong>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('botRun.acctNoSeeded')}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="number"
                min={10}
                max={10000000}
                step="10"
                aria-label={t('botRun.acctFundAria')}
                placeholder={t('botRun.acctFundPlaceholder')}
                value={fundInput}
                onChange={(e) => {
                  setFundInput(e.target.value)
                  if (fundError) setFundError(null)
                }}
                className="h-8 w-44 font-mono text-xs"
              />
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busyAction !== null}
                onClick={handleSubmitPaperFund}
              >
                {exchange?.paperFunded
                  ? t('botRun.acctSetPaperBal')
                  : t('botRun.acctFundPaperBtn')}
              </Button>
              {fundError && (
                <span className="text-[11px] text-[var(--negative)]">
                  {fundError}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Server Runtime Telemetry Strip */}
      <div className="grid grid-cols-2 gap-2 rounded-sm bg-muted/25 p-2.5 font-mono text-[11px] sm:grid-cols-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">
            {t('botRun.telLatency')}
          </span>
          <strong className="tabular-nums text-foreground">
            {telemetry ? `${telemetry.cache.avgLatencyMs} ms` : '—'}
          </strong>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">
            {t('botRun.telCacheHit')}
          </span>
          <strong className="tabular-nums text-foreground">
            {telemetry
              ? `${telemetry.cache.hitRatePct}% (${telemetry.cache.hits})`
              : '—'}
          </strong>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">
            {t('botRun.telTicksSse')}
          </span>
          <strong className="tabular-nums text-foreground">
            {telemetry
              ? `${telemetry.tickCount} · ${telemetry.connectedStreamClients}`
              : '—'}
          </strong>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">
            {t('botRun.telLastTick')}
          </span>
          <strong className="truncate tabular-nums text-foreground">
            {formatUtcTimestamp(telemetry?.lastTickAt)}
          </strong>
        </div>
      </div>
    </OperatorSection>
  )
}

export default memo(AccountCard)
