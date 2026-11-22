import { useState, type FormEvent } from 'react'
import {
  Bell,
  BellOff,
  Crosshair,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { inferAlertDirection } from '@/chartAlerts'
import { formatPrice } from '@/format'
import { useI18n } from '@/i18n'
import type { ChartAlert, ChartAlertDirection } from '@/types'

type ChartAlertsPopoverProps = {
  pair: string
  livePrice: number | null
  alerts: ChartAlert[]
  onAddAlert: (price: number, direction: ChartAlertDirection) => void
  onToggleAlert: (id: string) => void
  onRearmAlert: (id: string) => void
  onRemoveAlert: (id: string) => void
  onJumpToAlert: (alert: ChartAlert) => void
}

function ChartAlertsPopover({
  pair,
  livePrice,
  alerts,
  onAddAlert,
  onToggleAlert,
  onRearmAlert,
  onRemoveAlert,
  onJumpToAlert,
}: ChartAlertsPopoverProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [priceDraft, setPriceDraft] = useState('')
  const [directionOverride, setDirectionOverride] =
    useState<ChartAlertDirection | null>(null)

  const parsedPrice = Number(priceDraft)
  const validPrice = Number.isFinite(parsedPrice) && parsedPrice > 0
  const effectiveDirection: ChartAlertDirection =
    directionOverride ??
    (validPrice ? inferAlertDirection(parsedPrice, livePrice) : 'above')

  const armedCount = alerts.filter(
    (a) => a.enabled && a.triggeredAt === undefined,
  ).length
  const sortedAlerts = [...alerts].sort((a, b) => {
    const aArmed = a.enabled && a.triggeredAt === undefined ? 0 : 1
    const bArmed = b.enabled && b.triggeredAt === undefined ? 0 : 1
    if (aArmed !== bArmed) return aArmed - bArmed
    return b.createdAt - a.createdAt
  })

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen && !priceDraft && livePrice !== null) {
      setPriceDraft(String(Number(livePrice.toFixed(livePrice >= 100 ? 2 : 4))))
      setDirectionOverride(null)
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!validPrice) return
    onAddAlert(parsedPrice, effectiveDirection)
    setPriceDraft('')
    setDirectionOverride(null)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label={t('studio.alerts')}
          className="h-6 gap-1 px-2 font-mono text-[10px]"
        >
          <Bell className="size-3 text-[var(--chart-alert)]" />
          <span className="hidden md:inline">{t('studio.alerts')}</span>
          {armedCount > 0 && (
            <Badge
              variant="secondary"
              className="px-1 py-0 text-[9.5px] tabular-nums"
            >
              {armedCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-foreground">
              {t('studio.alertsTitle', { pair })}
            </span>
            {livePrice !== null && (
              <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                ${formatPrice(livePrice)}
              </span>
            )}
          </div>

          <p className="rounded-[4px] bg-muted/40 px-2 py-1.5 text-[10.5px] leading-snug text-muted-foreground">
            {t('studio.alertsClientNotice')}
          </p>

          <form onSubmit={handleSubmit} className="flex flex-col gap-1.5">
            <div className="flex items-end gap-1.5">
              <div className="flex flex-1 flex-col gap-1">
                <Label htmlFor="chart-alert-price" className="text-[10px]">
                  {t('studio.alertPriceLabel')}
                </Label>
                <Input
                  id="chart-alert-price"
                  type="number"
                  step="any"
                  min={0}
                  value={priceDraft}
                  onChange={(e) => setPriceDraft(e.target.value)}
                  placeholder={livePrice !== null ? formatPrice(livePrice) : '0'}
                  className="h-7 px-2 font-mono text-xs tabular-nums"
                />
              </div>
              <Button
                type="submit"
                size="xs"
                variant="default"
                disabled={!validPrice}
                className="h-7 shrink-0 gap-1 px-2 font-mono text-[10.5px]"
              >
                <Plus className="size-3" />
                <span>{t('studio.alertAdd')}</span>
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                aria-pressed={effectiveDirection === 'above'}
                onClick={() => setDirectionOverride('above')}
                className={cn(
                  'h-6 cursor-pointer rounded-[4px] font-mono text-[10px] font-semibold transition-colors',
                  effectiveDirection === 'above'
                    ? 'bg-[var(--positive-soft)] text-[var(--positive)]'
                    : 'bg-muted/40 text-muted-foreground hover:text-foreground',
                )}
              >
                {t('studio.alertAbove')}
              </button>
              <button
                type="button"
                aria-pressed={effectiveDirection === 'below'}
                onClick={() => setDirectionOverride('below')}
                className={cn(
                  'h-6 cursor-pointer rounded-[4px] font-mono text-[10px] font-semibold transition-colors',
                  effectiveDirection === 'below'
                    ? 'bg-[var(--negative-soft)] text-[var(--negative)]'
                    : 'bg-muted/40 text-muted-foreground hover:text-foreground',
                )}
              >
                {t('studio.alertBelow')}
              </button>
            </div>
          </form>

          {sortedAlerts.length === 0 ? (
            <p className="py-2 text-center text-[11px] leading-snug text-muted-foreground">
              {t('studio.alertEmpty', { pair })}
            </p>
          ) : (
            <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
              {sortedAlerts.map((alert) => {
                const isTriggered = alert.triggeredAt !== undefined
                const isPaused = !alert.enabled
                return (
                  <div
                    key={alert.id}
                    className="flex items-center justify-between gap-1.5 rounded-[4px] bg-muted/25 px-2 py-1.5 font-mono text-[10.5px] tabular-nums"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <div className="flex items-center gap-1">
                        <span
                          className={cn(
                            'font-bold',
                            alert.direction === 'above'
                              ? 'text-[var(--positive)]'
                              : 'text-[var(--negative)]',
                          )}
                        >
                          {alert.direction === 'above' ? '≥' : '≤'}
                        </span>
                        <span className="font-semibold text-foreground">
                          ${formatPrice(alert.price)}
                        </span>
                      </div>
                      <span
                        className={cn(
                          'text-[9.5px]',
                          isTriggered
                            ? 'text-primary'
                            : isPaused
                              ? 'text-muted-foreground'
                              : 'text-[var(--chart-alert)]',
                        )}
                      >
                        {isTriggered
                          ? t('studio.alertTriggered')
                          : isPaused
                            ? t('studio.alertPaused')
                            : t('studio.alertArmed')}
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => onJumpToAlert(alert)}
                        aria-label={t('studio.alertJump')}
                        title={t('studio.alertJump')}
                        className="inline-flex size-6 cursor-pointer items-center justify-center rounded-[4px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                      >
                        <Crosshair className="size-3" />
                      </button>
                      {isTriggered ? (
                        <button
                          type="button"
                          onClick={() => onRearmAlert(alert.id)}
                          aria-label={t('studio.alertRearm')}
                          title={t('studio.alertRearm')}
                          className="inline-flex size-6 cursor-pointer items-center justify-center rounded-[4px] text-primary hover:bg-primary/15"
                        >
                          <RotateCcw className="size-3" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onToggleAlert(alert.id)}
                          aria-label={
                            alert.enabled
                              ? t('studio.alertPause')
                              : t('studio.alertEnable')
                          }
                          title={
                            alert.enabled
                              ? t('studio.alertPause')
                              : t('studio.alertEnable')
                          }
                          className="inline-flex size-6 cursor-pointer items-center justify-center rounded-[4px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                        >
                          {alert.enabled ? (
                            <Bell className="size-3 text-[var(--chart-alert)]" />
                          ) : (
                            <BellOff className="size-3" />
                          )}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onRemoveAlert(alert.id)}
                        aria-label={t('studio.alertDelete')}
                        title={t('studio.alertDelete')}
                        className="inline-flex size-6 cursor-pointer items-center justify-center rounded-[4px] text-muted-foreground hover:bg-muted/60 hover:text-[var(--negative)]"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default ChartAlertsPopover
