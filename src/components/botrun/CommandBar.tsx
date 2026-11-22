import { memo } from 'react'
import {
  CheckCircle2,
  Keyboard,
  Pause,
  Play,
  ShieldAlert,
  Square,
  Zap,
} from 'lucide-react'
import type {
  BotServerSnapshot,
  ExchangeAccountResponse,
  StreamConnectionStatus,
} from '@/api/botClient'
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
import { formatUtcTimestamp } from '@/botRunUtils'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

type CommandBarProps = {
  snapshot: BotServerSnapshot
  account: ExchangeAccountResponse | null
  streamStatus: StreamConnectionStatus
  busyAction: string | null
  confirmKillOpen: boolean
  onConfirmKillOpenChange: (open: boolean) => void
  onOpenShortcuts: () => void
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onTickNow: () => void
  onToggleKillSwitch: () => void
}

function CommandBar({
  snapshot,
  account,
  streamStatus,
  busyAction,
  confirmKillOpen,
  onConfirmKillOpenChange,
  onOpenShortcuts,
  onStart,
  onPause,
  onResume,
  onStop,
  onTickNow,
  onToggleKillSwitch,
}: CommandBarProps) {
  const { t } = useI18n()
  const { preset, state, exchange, mt5 } = snapshot
  const isRunning = snapshot.running
  const isPaused = Boolean(snapshot.paused)
  const killSwitchActive = Boolean(exchange?.killSwitchActive)
  const accountMode = snapshot.accountMode ?? exchange?.mode ?? 'paper'
  const hasOpenPosition =
    state.openPosition !== null || Boolean(exchange?.botOwnedPosition)

  const statusText = killSwitchActive
    ? 'KILL-SWITCH ACTIVE'
    : isRunning
      ? 'RUNNING'
      : isPaused
        ? 'PAUSED'
        : hasOpenPosition
          ? 'STOPPED · position open'
          : 'STOPPED'

  const statusVariant = killSwitchActive
    ? 'negative'
    : isRunning
      ? 'positive'
      : isPaused || hasOpenPosition
        ? 'warning'
        : 'secondary'

  const exchangeStatusLabel = account?.connected
    ? 'TESTNET OK'
    : accountMode === 'binance-testnet'
      ? 'TESTNET ERR'
      : exchange?.paperFunded
        ? 'PAPER FUNDED'
        : 'PAPER UNFUNDED'

  const mt5Label =
    !mt5 || mt5.executionState === 'waiting-for-ea'
      ? t('botRun.mt5WaitingShort')
      : mt5.executionState === 'pending-ea'
        ? 'MT5: PENDING EA'
        : mt5.executionState === 'confirmed'
          ? 'MT5: ACK OK'
          : mt5.executionState === 'error'
            ? 'MT5: ERROR'
            : 'MT5: UNCONFIRMED'

  const mt5Variant =
    mt5?.executionState === 'confirmed'
      ? 'positive'
      : mt5?.executionState === 'error'
        ? 'negative'
        : mt5?.executionState === 'pending-ea'
          ? 'warning'
          : 'secondary'

  return (
    <div
      role="region"
      aria-label={t('botRun.cmdAria')}
      className={cn(
        'sticky top-11 z-30 -mx-1 rounded-md px-3.5 py-2.5 backdrop-blur-xl transition-colors',
        killSwitchActive ? 'bg-[var(--negative-soft)]/95' : 'bg-card/92',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        {/* Left: Status, Mode, Strategy, Connections */}
        <div
          className="flex min-w-0 flex-wrap items-center gap-2"
          aria-live="polite"
        >
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              killSwitchActive
                ? 'bg-[var(--negative)]'
                : isRunning
                  ? 'bg-[var(--positive)]'
                  : isPaused || hasOpenPosition
                    ? 'bg-[var(--warning)]'
                    : 'bg-muted-foreground/50',
            )}
            aria-hidden="true"
          />

          <Badge
            variant={statusVariant}
            className="font-mono text-[11px] font-bold"
          >
            {statusText}
          </Badge>

          {/* Visually distinct account mode badge */}
          <span
            className={cn(
              'inline-flex h-5 items-center rounded-sm px-2 font-mono text-[10.5px] font-bold tracking-[0.06em] uppercase',
              accountMode === 'binance-testnet'
                ? 'bg-[var(--warning-soft)] text-[var(--warning)]'
                : 'bg-[var(--brand-violet)]/15 text-[var(--brand-violet)]',
            )}
          >
            {accountMode === 'binance-testnet' ? 'TESTNET' : 'PAPER'}
          </span>

          <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11.5px] text-foreground">
            <span className="max-w-[200px] truncate font-semibold">
              {preset.name}
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="shrink-0 text-muted-foreground">
              {preset.strategy.pair} {preset.timeframe}
            </span>
          </div>

          <Badge
            variant={
              account?.connected
                ? 'positive'
                : exchange?.paperFunded
                  ? 'secondary'
                  : 'warning'
            }
            className="text-[10px]"
          >
            {exchangeStatusLabel}
          </Badge>

          <Badge variant={mt5Variant} className="text-[10px]">
            {mt5Label}
          </Badge>

          <Badge
            variant={
              streamStatus === 'live'
                ? 'positive'
                : streamStatus === 'reconnecting'
                  ? 'warning'
                  : 'negative'
            }
            className="text-[10px]"
          >
            SSE: {streamStatus.toUpperCase()}
          </Badge>
        </div>

        {/* Right: Controls + Shortcuts + 1-click Kill-Switch */}
        <div className="flex flex-wrap items-center gap-1.5">
          {isPaused ? (
            <Button
              type="button"
              variant="default"
              size="xs"
              disabled={killSwitchActive || busyAction !== null}
              onClick={onResume}
            >
              <Play className="size-3 fill-current" />
              <span>{t('botRun.resume')}</span>
            </Button>
          ) : (
            <Button
              type="button"
              variant="default"
              size="xs"
              disabled={isRunning || killSwitchActive || busyAction !== null}
              onClick={onStart}
            >
              <Play className="size-3 fill-current" />
              <span>{t('botRun.start')}</span>
            </Button>
          )}

          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={!isRunning || busyAction !== null}
            onClick={onPause}
          >
            <Pause className="size-3" />
            <span>{t('botRun.pause')}</span>
          </Button>

          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={(!isRunning && !isPaused) || busyAction !== null}
            onClick={onStop}
          >
            <Square className="size-3 fill-current" />
            <span>{t('botRun.stop')}</span>
          </Button>

          <Button
            type="button"
            variant="secondary"
            size="xs"
            disabled={killSwitchActive || busyAction !== null}
            onClick={onTickNow}
          >
            <Zap className="size-3" />
            <span className="hidden sm:inline">{t('botRun.evalBar')}</span>
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onOpenShortcuts}
            aria-label={t('botRun.shortcutsTitle')}
            title={`${t('botRun.shortcutsBtn')} (?)`}
          >
            <Keyboard className="size-3.5" />
            <span className="hidden md:inline font-mono text-[10.5px]">?</span>
          </Button>

          {killSwitchActive ? (
            <Button
              type="button"
              variant="positive"
              size="xs"
              disabled={busyAction !== null}
              onClick={onToggleKillSwitch}
            >
              <CheckCircle2 className="size-3.5" />
              <span>{t('botRun.rearm')}</span>
            </Button>
          ) : (
            <AlertDialog
              open={confirmKillOpen}
              onOpenChange={onConfirmKillOpenChange}
            >
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="destructive"
                  size="xs"
                  disabled={busyAction !== null}
                >
                  <ShieldAlert className="size-3.5" />
                  <span>{t('botRun.killSwitch')}</span>
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2 text-[var(--negative)]">
                    <ShieldAlert className="size-4" />
                    <span>{t('botRun.killSwitchDialogTitle')}</span>
                  </AlertDialogTitle>
                  <AlertDialogDescription asChild>
                    <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                      <p>{t('botRun.killSwitchDialogIntro')}</p>
                      <ul className="list-disc space-y-1 pl-4 text-foreground">
                        <li>{t('botRun.killSwitchBullet1')}</li>
                        <li>{t('botRun.killSwitchBullet2')}</li>
                        <li>{t('botRun.killSwitchBullet3')}</li>
                        <li>{t('botRun.killSwitchBullet4')}</li>
                      </ul>
                    </div>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('botRun.cancel')}</AlertDialogCancel>
                  <AlertDialogAction onClick={onToggleKillSwitch}>
                    {t('botRun.killSwitchConfirm')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {killSwitchActive && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm bg-background/55 px-2.5 py-1.5 font-mono text-[11px] text-[var(--negative)]">
          <strong>KILL-SWITCH ACTIVE</strong>
          <span>
            {t('botRun.killSwitchEngagedAt')}{' '}
            {formatUtcTimestamp(exchange?.killSwitchActivatedAt)}
          </span>
          {exchange?.killSwitchReason && (
            <span>
              {t('botRun.killSwitchReasonLabel')} {exchange.killSwitchReason}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export default memo(CommandBar)
