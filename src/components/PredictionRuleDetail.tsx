import { useMemo, useState } from 'react'
import { ArrowLeft, Maximize2, X } from 'lucide-react'
import CandleChart from '@/components/CandleChart'
import {
  MiniOutcomeStrip,
  MiniSparkChart,
} from '@/components/MiniSparkChart'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatDateTime, formatPrice } from '@/format'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { RuleMarketStats } from '@/predictionMarket'
import {
  evaluatePredictionRuleDetailed,
  type PredictionRule,
} from '@/predictions'
import type { Candle, ChartOverlay, Signal } from '@/types'

type PredictionRuleDetailProps = {
  rule: PredictionRule
  marketStats?: RuleMarketStats | null
  candles: Candle[]
  pair: string
  onClose: () => void
  onOpenCharts?: () => void
}

const DEFAULT_VISIBLE_BARS = 140

export default function PredictionRuleDetail({
  rule,
  marketStats,
  candles,
  pair,
  onClose,
  onOpenCharts,
}: PredictionRuleDetailProps) {
  const { language, locale } = useI18n()
  const isEs = language === 'es'

  const warmup = candles.length > 90 ? 50 : Math.min(20, Math.floor(candles.length / 4))
  const navigableTotal = Math.max(25, candles.length - warmup)

  const [zoomCount, setZoomCount] = useState<number>(
    Math.min(DEFAULT_VISIBLE_BARS, navigableTotal),
  )
  const [panOffset, setPanOffset] = useState<number>(0)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  const analysis = useMemo(
    () => evaluatePredictionRuleDetailed(rule, candles),
    [rule, candles],
  )

  const clampedZoom = Math.min(Math.max(30, zoomCount), navigableTotal)
  const maxPanOffset = Math.max(0, navigableTotal - clampedZoom)
  const clampedPan = Math.min(Math.max(0, panOffset), maxPanOffset)

  const viewEnd = candles.length - clampedPan
  const viewStart = Math.max(warmup, viewEnd - clampedZoom)

  const visibleCandles = useMemo(
    () => candles.slice(viewStart, viewEnd),
    [candles, viewStart, viewEnd],
  )

  const overlays: ChartOverlay[] = useMemo(() => {
    const { ctx } = analysis
    const list: ChartOverlay[] = []
    const idAndTitle = `${rule.id} ${rule.title} ${rule.contractQuestion}`.toLowerCase()
    const needsBb =
      idAndTitle.includes('bb') ||
      idAndTitle.includes('bollinger') ||
      rule.category === 'volatility'
    const needsEma200 =
      idAndTitle.includes('ema 200') ||
      idAndTitle.includes('ema200') ||
      idAndTitle.includes('ema 50') ||
      idAndTitle.includes('ema50')

    list.push({
      id: 'sma20',
      label: 'SMA 20',
      kind: 'fast',
      values: ctx.sma20.slice(viewStart, viewEnd),
    })

    list.push({
      id: 'ema50',
      label: 'EMA 50',
      kind: 'trend',
      values: ctx.ema50.slice(viewStart, viewEnd),
    })

    if (needsEma200) {
      list.push({
        id: 'ema200',
        label: 'EMA 200',
        kind: 'ema200',
        values: ctx.ema200.slice(viewStart, viewEnd),
      })
    }

    if (needsBb) {
      list.push(
        {
          id: 'bb-upper',
          label: 'BB Hi',
          kind: 'bb-upper',
          values: ctx.bbUpper20.slice(viewStart, viewEnd),
        },
        {
          id: 'bb-lower',
          label: 'BB Lo',
          kind: 'bb-lower',
          values: ctx.bbLower20.slice(viewStart, viewEnd),
        },
      )
    }

    return list
  }, [analysis, rule, viewStart, viewEnd])

  const visibleSignals: Signal[] = useMemo(
    () =>
      analysis.events
        .filter((ev) => ev.index >= viewStart && ev.index < viewEnd)
        .map((ev) => ({
          index: ev.index - viewStart,
          time: ev.time,
          side: ev.won ? 'buy' : 'sell',
          price: ev.close,
          reason: ev.won
            ? `${rule.predictedOutcome} HIT (+${rule.horizonBars}b)`
            : `${rule.predictedOutcome} MISS (+${rule.horizonBars}b)`,
        })),
    [analysis.events, rule.horizonBars, rule.predictedOutcome, viewStart, viewEnd],
  )

  const cumulativeWinCurve = useMemo(
    () => analysis.events.map((ev) => ev.cumulativeWinRatePct),
    [analysis.events],
  )

  const recentEvents = useMemo(
    () => [...analysis.events].reverse().slice(0, 24),
    [analysis.events],
  )

  const stats = analysis.stats
  const losses = stats.triggers - stats.hits

  function handlePanDelta(deltaBars: number) {
    setPanOffset((prev) => Math.min(maxPanOffset, Math.max(0, prev + deltaBars)))
  }

  function handleZoomDelta(deltaBars: number, anchorRatio?: number) {
    const oldZoom = clampedZoom
    const nextZoom = Math.min(navigableTotal, Math.max(30, oldZoom + deltaBars))
    if (nextZoom === oldZoom) return
    const effectiveAnchor = anchorRatio ?? (clampedPan === 0 ? 1 : 0.5)
    const nextMaxPan = Math.max(0, navigableTotal - nextZoom)
    const nextPan =
      clampedPan + Math.round((1 - effectiveAnchor) * (oldZoom - nextZoom))
    setZoomCount(nextZoom)
    setPanOffset(Math.min(nextMaxPan, Math.max(0, nextPan)))
  }

  function handleResetView() {
    setZoomCount(Math.min(DEFAULT_VISIBLE_BARS, navigableTotal))
    setPanOffset(0)
  }

  function handleJumpToEvent(globalIndex: number) {
    const desiredRightOffset = Math.max(
      0,
      Math.min(
        maxPanOffset,
        candles.length - 1 - globalIndex - Math.floor(clampedZoom * 0.35),
      ),
    )
    const targetEnd = candles.length - desiredRightOffset
    const targetStart = Math.max(warmup, targetEnd - clampedZoom)
    setPanOffset(desiredRightOffset)
    const localIdx = globalIndex - targetStart
    if (localIdx >= 0 && localIdx < clampedZoom) {
      setHoverIndex(localIdx)
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="gap-3 px-4 pt-3.5 pb-2">
        <div className="flex w-full flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onClose}
                className="-ml-1.5 px-1.5 text-muted-foreground"
              >
                <ArrowLeft className="size-3.5" />
                <span>{isEs ? 'Todas las reglas' : 'All rules'}</span>
              </Button>
              <span className="font-mono text-xs text-muted-foreground">
                #{rule.number}
              </span>
              <Badge
                variant={
                  rule.predictedOutcome === 'YES' ? 'positive' : 'negative'
                }
              >
                {rule.predictedOutcome} +{rule.horizonBars}
                {isEs ? 'v' : 'b'}
              </Badge>
              <Badge variant={stats.currentlyActive ? 'default' : 'secondary'}>
                {stats.currentlyActive
                  ? isEs
                    ? 'ACTIVA AHORA'
                    : 'ACTIVE NOW'
                  : isEs
                    ? 'ESPERA'
                    : 'WAIT'}
              </Badge>
              <span className="font-mono text-[11px] text-muted-foreground">
                {pair} · {rule.timeframe} · {rule.category}
              </span>
            </div>

            <CardTitle className="text-base">{rule.title}</CardTitle>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {rule.contractQuestion}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {onOpenCharts && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={onOpenCharts}
              >
                <Maximize2 className="size-3" />
                <span>{isEs ? 'Gráficos' : 'Charts'}</span>
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={isEs ? 'Cerrar detalle' : 'Close detail'}
              onClick={onClose}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 pt-2">
        {/* Disclosed KPI Grid */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          <div className="flex flex-col gap-0.5 rounded-sm bg-muted/30 px-2.5 py-2">
            <span className="text-[10.5px] text-muted-foreground">Win Rate</span>
            <strong
              className={cn(
                'font-mono text-sm font-bold tabular-nums',
                stats.winRatePct >= 55
                  ? 'text-[var(--positive)]'
                  : 'text-foreground',
              )}
            >
              {stats.winRatePct.toFixed(1)}%
            </strong>
          </div>

          <div className="flex flex-col gap-0.5 rounded-sm bg-muted/30 px-2.5 py-2">
            <span className="text-[10.5px] text-muted-foreground">Wilson 95% LB</span>
            <strong className="font-mono text-sm font-bold tabular-nums text-foreground">
              {stats.wilsonLowerBoundPct.toFixed(1)}%
            </strong>
          </div>

          <div className="flex flex-col gap-0.5 rounded-sm bg-muted/30 px-2.5 py-2">
            <span className="text-[10.5px] text-muted-foreground">
              {isEs ? 'Aciertos / Total' : 'Hits / Triggers'}
            </span>
            <strong className="font-mono text-sm font-bold tabular-nums text-foreground">
              {stats.hits}W · {losses}L
            </strong>
          </div>

          <div className="flex flex-col gap-0.5 rounded-sm bg-muted/30 px-2.5 py-2">
            <span className="text-[10.5px] text-muted-foreground">
              {isEs ? 'Precio Justo' : 'Fair Price'}
            </span>
            <strong className="font-mono text-sm font-bold tabular-nums text-primary">
              ${stats.fairYesPrice.toFixed(2)}
            </strong>
          </div>

          <div className="flex flex-col gap-0.5 rounded-sm bg-muted/30 px-2.5 py-2">
            <span className="text-[10.5px] text-muted-foreground">1/4 Kelly</span>
            <strong className="font-mono text-sm font-bold tabular-nums text-foreground">
              {stats.quarterKellyPct.toFixed(1)}%
            </strong>
          </div>

          <div className="flex flex-col gap-0.5 rounded-sm bg-muted/30 px-2.5 py-2">
            <span className="text-[10.5px] text-muted-foreground">
              {isEs ? 'Lift vs Base' : 'Lift vs Base'}
            </span>
            <strong
              className={cn(
                'font-mono text-sm font-bold tabular-nums',
                marketStats && marketStats.liftPct > 0
                  ? 'text-[var(--positive)]'
                  : marketStats && marketStats.liftPct < 0
                    ? 'text-[var(--negative)]'
                    : 'text-foreground',
              )}
            >
              {marketStats
                ? `${marketStats.liftPct > 0 ? '+' : ''}${marketStats.liftPct.toFixed(1)}%`
                : '—'}
            </strong>
          </div>

          <div className="flex flex-col gap-0.5 rounded-sm bg-muted/30 px-2.5 py-2">
            <span className="text-[10.5px] text-muted-foreground">
              {isEs ? 'Edge Neto' : 'Net Edge'}
            </span>
            <strong
              className={cn(
                'font-mono text-sm font-bold tabular-nums',
                marketStats && marketStats.netEdgePct > 0
                  ? 'text-[var(--positive)]'
                  : 'text-muted-foreground',
              )}
            >
              {marketStats
                ? `${marketStats.netEdgePct > 0 ? '+' : ''}${marketStats.netEdgePct.toFixed(1)}%`
                : '—'}
            </strong>
          </div>
        </div>

        {/* Full Candlestick Chart with Trigger Pins (Green = HIT, Red = MISS) */}
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-muted-foreground">
            <span>
              {isEs
                ? `Velas ${pair} (${rule.timeframe}) · ${visibleSignals.length} señales en vista`
                : `${pair} (${rule.timeframe}) candles · ${visibleSignals.length} triggers in view`}
            </span>
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1 text-[var(--positive)]">
                ▲ {isEs ? 'Acierto' : 'Hit'}
              </span>
              <span className="inline-flex items-center gap-1 text-[var(--negative)]">
                ▼ {isEs ? 'Fallo' : 'Miss'}
              </span>
            </div>
          </div>

          <CandleChart
            candles={visibleCandles}
            overlays={overlays}
            signals={visibleSignals}
            activeIndex={hoverIndex}
            onActiveIndexChange={setHoverIndex}
            onPanDelta={handlePanDelta}
            onZoomDelta={handleZoomDelta}
            onResetView={handleResetView}
            height={320}
          />
        </div>

        {/* Bottom Split: Cumulative Win Rate Curve + Historical Trigger Ledger */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
          <div className="flex flex-col justify-between gap-2.5 rounded-sm bg-muted/25 p-3 lg:col-span-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                {isEs ? 'Acierto acumulado (%)' : 'Cumulative Win Rate (%)'}
              </span>
              <MiniOutcomeStrip
                outcomes={stats.recentOutcomes}
                label={`${rule.title}: ${stats.hits}/${stats.triggers}`}
              />
            </div>

            <MiniSparkChart
              values={cumulativeWinCurve}
              baseline={50}
              tone={stats.winRatePct >= 50 ? 'positive' : 'negative'}
              label={`${rule.title} cumulative win rate`}
              className="h-24"
            />

            <div className="flex items-center justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
              <span>
                {isEs ? 'Tasa Base:' : 'Base Rate:'}{' '}
                <strong className="text-foreground">
                  {marketStats ? `${marketStats.baseRatePct.toFixed(1)}%` : '—'}
                </strong>
              </span>
              <span>
                {isEs ? 'Muestra:' : 'Sample:'}{' '}
                <strong className="text-foreground">
                  {stats.triggers} {isEs ? 'eventos' : 'events'}
                </strong>
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-1.5 lg:col-span-8">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                {isEs
                  ? `Activaciones recientes (${recentEvents.length} de ${analysis.events.length}) — clic para centrar`
                  : `Recent triggers (${recentEvents.length} of ${analysis.events.length}) — click to inspect bar`}
              </span>
            </div>

            {recentEvents.length === 0 ? (
              <div className="rounded-sm bg-muted/25 p-4 text-center text-xs text-muted-foreground">
                {isEs
                  ? 'Sin activaciones en las últimas 500 velas.'
                  : 'No triggers recorded in the last 500 candles.'}
              </div>
            ) : (
              <ScrollArea className="h-[190px] rounded-sm bg-muted/20">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{isEs ? 'Señal (UTC)' : 'Trigger (UTC)'}</TableHead>
                      <TableHead className="text-right">
                        {isEs ? 'Cierre' : 'Entry Close'}
                      </TableHead>
                      <TableHead className="text-right">
                        +{rule.horizonBars}
                        {isEs ? 'v' : 'b'} {isEs ? 'Cierre' : 'Close'}
                      </TableHead>
                      <TableHead className="text-right">Δ%</TableHead>
                      <TableHead className="text-right">
                        {isEs ? 'Resultado' : 'Outcome'}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentEvents.map((ev) => (
                      <TableRow
                        key={`${ev.index}-${ev.time}`}
                        onClick={() => handleJumpToEvent(ev.index)}
                        className="cursor-pointer"
                      >
                        <TableCell>{formatDateTime(ev.time, locale)}</TableCell>
                        <TableCell className="text-right">
                          ${formatPrice(ev.close)}
                        </TableCell>
                        <TableCell className="text-right">
                          ${formatPrice(ev.resolveClose)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right font-semibold',
                            ev.changePct > 0
                              ? 'text-[var(--positive)]'
                              : ev.changePct < 0
                                ? 'text-[var(--negative)]'
                                : 'text-muted-foreground',
                          )}
                        >
                          {ev.changePct >= 0 ? '+' : ''}
                          {ev.changePct.toFixed(2)}%
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge variant={ev.won ? 'positive' : 'negative'}>
                            {ev.won ? 'HIT' : 'MISS'}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
