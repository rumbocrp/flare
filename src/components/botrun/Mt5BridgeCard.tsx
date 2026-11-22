import { memo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react'
import type {
  Mt5BridgeSnapshot,
  StreamConnectionStatus,
} from '@/api/botClient'
import type { StrategyPreset } from '@/botEngine'
import OperatorSection from '@/components/botrun/OperatorSection'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatUtcTimestamp } from '@/botRunUtils'
import { useI18n } from '@/i18n'

type Mt5BridgeCardProps = {
  mt5: Mt5BridgeSnapshot | undefined
  activePreset: StrategyPreset
  streamStatus: StreamConnectionStatus
  open: boolean
  onToggle: () => void
}

function Mt5BridgeCard({
  mt5,
  activePreset,
  streamStatus,
  open,
  onToggle,
}: Mt5BridgeCardProps) {
  const { t } = useI18n()
  const [rawExpanded, setRawExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const state = mt5?.executionState ?? 'waiting-for-ea'
  const statusBadge =
    state === 'confirmed'
      ? { variant: 'positive' as const, label: t('botRun.mt5Confirmed') }
      : state === 'error'
        ? { variant: 'negative' as const, label: 'EA ERROR' }
        : state === 'pending-ea'
          ? { variant: 'warning' as const, label: t('botRun.mt5Pending') }
          : state === 'unconfirmed'
            ? {
                variant: 'secondary' as const,
                label: t('botRun.mt5Unconfirmed'),
              }
            : { variant: 'secondary' as const, label: t('botRun.mt5Waiting') }

  async function handleCopyPayload() {
    if (!mt5?.lastPacket) return
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(mt5.lastPacket, null, 2),
      )
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Ignore clipboard unavailability
    }
  }

  return (
    <OperatorSection
      id="mt5"
      title={t('botRun.mt5Title')}
      badges={<Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>}
      sourceLabel="/api/mt5/signal"
      updatedAt={mt5?.lastPollAt ?? null}
      staleAfterMs={30_000}
      connectionState={streamStatus}
      open={open}
      onToggle={onToggle}
    >
      {mt5 && mt5.pollCount > 0 && mt5.lastPacket ? (
        <div className="flex flex-col gap-3">
          {/* Read-only EA-reported + preset-derived fields */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            <div className="flex flex-col gap-0.5 rounded-sm bg-muted/25 p-2">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {t('botRun.mt5TerminalVer')}
              </span>
              <strong className="truncate font-mono text-xs text-foreground">
                {mt5.lastTerminalName ?? '—'}
                {mt5.lastEaVersion ? ` v${mt5.lastEaVersion}` : ''}
              </strong>
            </div>
            <div className="flex flex-col gap-0.5 rounded-sm bg-muted/25 p-2">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {t('botRun.mt5PollsLast')}
              </span>
              <strong className="truncate font-mono text-xs tabular-nums text-foreground">
                {mt5.pollCount} · {formatUtcTimestamp(mt5.lastPollAt)}
              </strong>
            </div>
            <div className="flex flex-col gap-0.5 rounded-sm bg-muted/25 p-2">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {t('botRun.mt5MagicSymbol')}
              </span>
              <strong className="font-mono text-xs text-foreground">
                #{mt5.magicNumber} · {mt5.lastPacket.symbol}
              </strong>
            </div>
            <div className="flex flex-col gap-0.5 rounded-sm bg-muted/25 p-2">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {t('botRun.mt5LastAction')}
              </span>
              <strong className="font-mono text-xs text-foreground">
                {mt5.lastPacket.action} ({mt5.lastPacket.signalId})
              </strong>
            </div>
            <div className="flex flex-col gap-0.5 rounded-sm bg-muted/25 p-2">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {t('botRun.mt5SlTpPreset')}
              </span>
              <strong className="font-mono text-xs tabular-nums text-foreground">
                {activePreset.strategy.stopLoss}% /{' '}
                {activePreset.strategy.takeProfit}%
              </strong>
            </div>
            <div className="flex flex-col gap-0.5 rounded-sm bg-muted/25 p-2">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {t('botRun.mt5BrokerAcct')}
              </span>
              <strong className="truncate font-mono text-xs text-foreground">
                {mt5.lastBroker || mt5.lastAccount
                  ? `${mt5.lastBroker ?? '—'} · ${mt5.lastAccount ?? '—'}`
                  : t('botRun.mt5NotReported')}
              </strong>
            </div>
          </div>

          {/* Last Execution ACK */}
          {mt5.lastAck ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-sm bg-muted/30 px-3 py-2 font-mono text-[11px]">
              <span>
                <strong>ACK:</strong> {mt5.lastAck.status} ·{' '}
                {mt5.lastAck.signalId}
                {mt5.lastAck.ticket ? ` · #${mt5.lastAck.ticket}` : ''}
                {mt5.lastAck.fillPrice !== null
                  ? ` @ $${mt5.lastAck.fillPrice}`
                  : ''}
                {mt5.lastAck.error ? ` · ${mt5.lastAck.error}` : ''}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {formatUtcTimestamp(mt5.lastAck.receivedAt)}
              </span>
            </div>
          ) : (
            <p className="text-[11.5px] text-muted-foreground">
              {t('botRun.mt5NoAckHint')}
            </p>
          )}

          {/* Collapsible Raw Last-Served Payload + Copy */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setRawExpanded((v) => !v)}
                aria-expanded={rawExpanded}
                className="inline-flex items-center gap-1 rounded-sm font-mono text-[11px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
              >
                {rawExpanded ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
                <span>{t('botRun.mt5RawPayload')}</span>
              </button>

              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => void handleCopyPayload()}
              >
                {copied ? (
                  <Check className="size-3 text-[var(--positive)]" />
                ) : (
                  <Copy className="size-3" />
                )}
                <span>
                  {copied ? t('botRun.mt5Copied') : t('botRun.mt5CopyJson')}
                </span>
              </Button>
            </div>

            {rawExpanded && (
              <pre className="max-h-52 overflow-auto rounded-sm bg-muted/35 p-2.5 font-mono text-[11px] text-muted-foreground">
                {JSON.stringify(mt5.lastPacket, null, 2)}
              </pre>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-sm bg-muted/30 p-3 text-xs">
          <strong className="text-foreground">
            {t('botRun.mt5WaitingTitle')}
          </strong>
          <p className="text-muted-foreground">{t('botRun.mt5WaitingDesc')}</p>
          <div className="flex flex-col gap-1 rounded-sm bg-background/60 p-2 font-mono text-[11px] text-foreground">
            <span>Signal: GET /api/mt5/signal</span>
            <span>ACK: POST /api/mt5/ack</span>
            <span className="text-muted-foreground">
              {t('botRun.mt5AuthHint')}
            </span>
          </div>
        </div>
      )}
    </OperatorSection>
  )
}

export default memo(Mt5BridgeCard)
