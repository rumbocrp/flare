import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import './EquityChart.css'
import './CandleChart.css'
import {
  ChevronLeft,
  ChevronRight,
  Mouse,
  RotateCcw,
  TrendingDown,
  TrendingUp,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useElementWidth } from '../hooks/useElementWidth'
import { toHeikinAshi } from '../indicators'
import { niceTicks } from '../chart'
import { STUDIO_PLOT_MARGIN } from '../chartLayout'
import { formatDateTime, formatPercent, formatPrice } from '../format'
import { useI18n } from '../i18n'
import type {
  Candle,
  CandleStyleMode,
  ChartDrawing,
  ChartOrderLine,
  ChartOverlay,
  DrawingToolMode,
  Signal,
} from '../types'

export type { DrawingToolMode }

type CandleChartProps = {
  candles: Candle[]
  overlays?: ChartOverlay[]
  signals?: Signal[]
  orderLines?: ChartOrderLine[]
  drawings?: ChartDrawing[]
  drawingMode?: DrawingToolMode
  candleStyle?: CandleStyleMode
  magnetSnap?: boolean
  volSmaValues?: (number | null)[]
  onAddDrawing?: (drawing: ChartDrawing) => void
  onRemoveDrawing?: (id: string) => void
  activeIndex?: number | null
  onActiveIndexChange?: (index: number | null) => void
  onZoomDelta?: (deltaBars: number, anchorRatio?: number) => void
  onPanDelta?: (deltaBars: number) => void
  onResetView?: () => void
  height?: number
  defaultWheelZoomLocked?: boolean
  compactHeader?: boolean
}

const DEFAULT_HEIGHT = 380
const MARGIN = {
  top: 20,
  bottom: 26,
  left: STUDIO_PLOT_MARGIN.left,
  right: STUDIO_PLOT_MARGIN.right,
}
const MARKER_GAP = 6
const MARKER_SIZE = 8
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]

type MeasureAnchor = {
  index: number
  time: number
  price: number
}

function changeClass(change: number): string {
  if (change > 0) return 'chart__change--positive'
  if (change < 0) return 'chart__change--negative'
  return ''
}

function formatAxisTick(timeMs: number, spanMs: number, locale: string): string {
  const date = new Date(timeMs)
  if (spanMs >= 5 * 86_400_000) {
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(date)
  }
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(date)
}

function formatDurationMs(deltaMs: number): string {
  const absMins = Math.max(0, Math.round(Math.abs(deltaMs) / 60_000))
  const days = Math.floor(absMins / 1440)
  const hours = Math.floor((absMins % 1440) / 60)
  const mins = absMins % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

function snapPriceToCandleOhlc(candle: Candle, rawPrice: number): number {
  const candidates = [candle.open, candle.high, candle.low, candle.close]
  let closest = candidates[0]
  let minDiff = Math.abs(rawPrice - closest)
  for (let i = 1; i < candidates.length; i++) {
    const diff = Math.abs(rawPrice - candidates[i])
    if (diff < minDiff) {
      minDiff = diff
      closest = candidates[i]
    }
  }
  return closest
}

function CandleChart({
  candles,
  overlays = [],
  signals = [],
  orderLines = [],
  drawings = [],
  drawingMode = 'cursor',
  candleStyle = 'candles',
  magnetSnap = false,
  volSmaValues,
  onAddDrawing,
  onRemoveDrawing,
  activeIndex: controlledActiveIndex,
  onActiveIndexChange,
  onZoomDelta,
  onPanDelta,
  onResetView,
  height = DEFAULT_HEIGHT,
  defaultWheelZoomLocked = false,
  compactHeader = false,
}: CandleChartProps) {
  const { locale, t, language } = useI18n()
  const isEs = language === 'es'
  const clipId = useId()
  const [containerRef, width] = useElementWidth<HTMLDivElement>()
  const canvasWrapRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const wheelAccumRef = useRef<number>(0)
  const candleCountRef = useRef<number>(candles.length)
  candleCountRef.current = candles.length

  const [internalIndex, setInternalIndex] = useState<number | null>(null)
  const [hoverPrice, setHoverPrice] = useState<number | null>(null)
  const [wheelZoomLocked, setWheelZoomLocked] = useState<boolean>(
    defaultWheelZoomLocked,
  )
  const [draftAnchor, setDraftAnchor] = useState<{
    time: number
    price: number
  } | null>(null)
  const [measureRange, setMeasureRange] = useState<{
    start: MeasureAnchor
    end: MeasureAnchor | null
    locked: boolean
  } | null>(null)

  const displayCandles = useMemo(
    () => (candleStyle === 'heikin-ashi' ? toHeikinAshi(candles) : candles),
    [candleStyle, candles],
  )

  useEffect(() => {
    setWheelZoomLocked(defaultWheelZoomLocked)
  }, [defaultWheelZoomLocked])

  useEffect(() => {
    if (drawingMode !== 'trendline' && drawingMode !== 'fib') {
      setDraftAnchor(null)
    }
    if (drawingMode !== 'measure') {
      setMeasureRange(null)
    }
  }, [drawingMode])

  useEffect(() => {
    if (!draftAnchor && !measureRange) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setDraftAnchor(null)
        setMeasureRange(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [draftAnchor, measureRange])

  const dragRef = useRef<{
    startX: number
    accumulatedBars: number
    isDragging: boolean
  } | null>(null)

  const activeIndex =
    controlledActiveIndex !== undefined ? controlledActiveIndex : internalIndex

  function updateActiveIndex(next: number | null) {
    if (onActiveIndexChange) {
      onActiveIndexChange(next)
    } else {
      setInternalIndex(next)
    }
  }

  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right)

  useEffect(() => {
    const rootEl = containerRef.current
    if (!rootEl || !onZoomDelta || plotWidth <= 0) return

    function handleNativeWheel(event: WheelEvent) {
      const hasZoomModifier = event.ctrlKey || event.metaKey || event.altKey
      if (!wheelZoomLocked && !hasZoomModifier) {
        return
      }
      event.preventDefault()
      event.stopPropagation()

      if (Math.abs(event.deltaY) < 0.01) return
      if (
        wheelAccumRef.current !== 0 &&
        Math.sign(event.deltaY) !== Math.sign(wheelAccumRef.current)
      ) {
        wheelAccumRef.current = 0
      }
      wheelAccumRef.current += event.deltaY
      if (Math.abs(wheelAccumRef.current) < 28) return

      const direction = wheelAccumRef.current > 0 ? 1 : -1
      wheelAccumRef.current = 0

      const rect = (canvasWrapRef.current ?? rootEl!).getBoundingClientRect()
      const relX = Math.max(
        0,
        Math.min(plotWidth, event.clientX - rect.left - MARGIN.left),
      )
      const rawRatio = relX / plotWidth
      const anchorRatio = rawRatio >= 0.9 ? 1 : rawRatio
      const step = Math.max(3, Math.round(candleCountRef.current * 0.14))
      onZoomDelta!(direction * step, anchorRatio)
    }

    rootEl.addEventListener('wheel', handleNativeWheel, { passive: false })
    return () => {
      rootEl.removeEventListener('wheel', handleNativeWheel)
    }
  }, [containerRef, onZoomDelta, plotWidth, wheelZoomLocked])

  if (displayCandles.length === 0) {
    return (
      <div className="chart" ref={containerRef}>
        <p className="chart__empty">{t('chart.noCandles')}</p>
      </div>
    )
  }

  const count = displayCandles.length
  const lastIndex = count - 1

  let candleLowMin = Infinity
  let candleHighMax = -Infinity
  let minIdx = 0
  let maxIdx = 0
  let maxVolume = 1

  for (let i = 0; i < count; i++) {
    const c = displayCandles[i]
    if (c.low < candleLowMin) {
      candleLowMin = c.low
      minIdx = i
    }
    if (c.high > candleHighMax) {
      candleHighMax = c.high
      maxIdx = i
    }
    if (c.volume > maxVolume) {
      maxVolume = c.volume
    }
  }

  const overlayExtremes: number[] = []
  for (const ov of overlays) {
    if (ov.kind === 'bb-upper' || ov.kind === 'bb-lower') {
      for (const v of ov.values) {
        if (v !== null && v !== undefined && Number.isFinite(v)) {
          overlayExtremes.push(v)
        }
      }
    }
  }

  const orderPrices = orderLines.map((o) => o.price).filter((p) => p > 0)
  const allMinCandidates = [candleLowMin, ...orderPrices, ...overlayExtremes]
  const allMaxCandidates = [candleHighMax, ...orderPrices, ...overlayExtremes]
  const rawMin = Math.min(...allMinCandidates)
  const rawMax = Math.max(...allMaxCandidates)

  const ticks = niceTicks(rawMin, rawMax, 6)
  const yMin = ticks[0]
  const yMax = ticks[ticks.length - 1]
  const ySpan = Math.max(1e-9, yMax - yMin)

  const plotHeight = Math.max(80, height - MARGIN.top - MARGIN.bottom)
  const yBottom = MARGIN.top + plotHeight
  const slot = plotWidth / count
  const bodyWidth = Math.max(1.5, Math.min(18, slot * 0.72))

  function xOf(index: number): number {
    return MARGIN.left + (index + 0.5) * slot
  }

  function xOfTime(timestamp: number): number | null {
    if (displayCandles.length === 0) return null
    const firstT = displayCandles[0].time
    const lastT = displayCandles[lastIndex].time
    if (lastT === firstT) return xOf(0)
    const exactIdx = ((timestamp - firstT) / (lastT - firstT)) * lastIndex
    return MARGIN.left + (exactIdx + 0.5) * slot
  }

  function yOf(value: number): number {
    return MARGIN.top + (1 - (value - yMin) / ySpan) * plotHeight
  }

  function priceOfY(yPx: number): number {
    const clampedY = Math.max(MARGIN.top, Math.min(yBottom, yPx))
    const ratio = 1 - (clampedY - MARGIN.top) / plotHeight
    return yMin + ratio * ySpan
  }

  const shownIndex = Math.min(activeIndex ?? lastIndex, lastIndex)
  const shown = displayCandles[shownIndex] ?? displayCandles[lastIndex]
  const rawShown = candles[shownIndex] ?? candles[lastIndex]
  const change =
    rawShown.open !== 0
      ? ((rawShown.close - rawShown.open) / rawShown.open) * 100
      : 0
  const lastCandle = displayCandles[lastIndex]

  const fromText = formatDateTime(displayCandles[0].time, locale)
  const toText = formatDateTime(displayCandles[lastIndex].time, locale)
  const spanMs = displayCandles[lastIndex].time - displayCandles[0].time

  const timeTicks = useMemo(() => {
    if (count < 4 || plotWidth < 200) return []
    const steps = plotWidth >= 720 ? 6 : 4
    const indices: number[] = []
    for (let s = 1; s < steps; s++) {
      const idx = Math.round((s / steps) * lastIndex)
      if (idx > 1 && idx < lastIndex - 1) {
        indices.push(idx)
      }
    }
    return indices
  }, [count, lastIndex, plotWidth])

  const bbPolygonPoints = useMemo(() => {
    const upper = overlays.find((o) => o.kind === 'bb-upper')
    const lower = overlays.find((o) => o.kind === 'bb-lower')
    if (!upper || !lower) return null
    const topCoords: string[] = []
    const botCoords: string[] = []
    for (let i = 0; i < count; i++) {
      const u = upper.values[i]
      const l = lower.values[i]
      if (
        u !== null &&
        u !== undefined &&
        l !== null &&
        l !== undefined &&
        Number.isFinite(u) &&
        Number.isFinite(l)
      ) {
        const x = MARGIN.left + (i + 0.5) * slot
        const yU = MARGIN.top + (1 - (u - yMin) / ySpan) * plotHeight
        const yL = MARGIN.top + (1 - (l - yMin) / ySpan) * plotHeight
        topCoords.push(`${x},${yU}`)
        botCoords.unshift(`${x},${yL}`)
      }
    }
    if (topCoords.length < 2) return null
    return `${topCoords.join(' ')} ${botCoords.join(' ')}`
  }, [count, overlays, plotHeight, slot, yMin, ySpan])

  const hoveredSignal = useMemo(() => {
    if (activeIndex === null || signals.length === 0) return null
    return (
      signals.find((s) => s.index === activeIndex) ??
      signals.find((s) => Math.abs(s.index - activeIndex) <= 1) ??
      null
    )
  }, [activeIndex, signals])

  const description =
    signals.length > 0
      ? t('chart.candlesAriaSignals', {
          count,
          from: fromText,
          to: toText,
          signals: signals.length,
        })
      : t('chart.candlesAria', {
          count,
          from: fromText,
          to: toText,
        })

  function resolvePointerPrice(index: number, relY: number): number {
    const raw = priceOfY(relY)
    if (!magnetSnap || drawingMode === 'cursor') return raw
    const targetCandle = displayCandles[index]
    return targetCandle ? snapPriceToCandleOhlc(targetCandle, raw) : raw
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (slot <= 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const relX = event.clientX - rect.left - MARGIN.left
    const relY = event.clientY - rect.top
    const index = Math.floor(relX / slot)
    const clampedIdx = Math.min(lastIndex, Math.max(0, index))
    const resolvedPrice = resolvePointerPrice(clampedIdx, relY)
    updateActiveIndex(clampedIdx)
    setHoverPrice(resolvedPrice)

    if (
      drawingMode === 'measure' &&
      measureRange &&
      !measureRange.locked &&
      displayCandles[clampedIdx]
    ) {
      setMeasureRange({
        ...measureRange,
        end: {
          index: clampedIdx,
          time: displayCandles[clampedIdx].time,
          price: resolvedPrice,
        },
      })
    }

    if (
      drawingMode === 'cursor' &&
      dragRef.current &&
      dragRef.current.isDragging &&
      onPanDelta
    ) {
      const dx = event.clientX - dragRef.current.startX
      const totalBarsMoved = Math.round(-dx / Math.max(4, slot))
      const stepDelta = totalBarsMoved - dragRef.current.accumulatedBars
      if (stepDelta !== 0) {
        dragRef.current.accumulatedBars = totalBarsMoved
        onPanDelta(stepDelta)
      }
    }
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (slot <= 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const relX = event.clientX - rect.left - MARGIN.left
    const relY = event.clientY - rect.top
    const index = Math.min(lastIndex, Math.max(0, Math.floor(relX / slot)))
    const clickedCandle = displayCandles[index]
    const clickedPrice = resolvePointerPrice(index, relY)

    updateActiveIndex(index)
    setHoverPrice(clickedPrice)

    // Quick measure via Shift+Click or explicit Measure tool
    if (drawingMode === 'measure' && clickedCandle) {
      if (!measureRange || measureRange.locked) {
        setMeasureRange({
          start: {
            index,
            time: clickedCandle.time,
            price: clickedPrice,
          },
          end: {
            index,
            time: clickedCandle.time,
            price: clickedPrice,
          },
          locked: false,
        })
      } else {
        setMeasureRange({
          ...measureRange,
          end: {
            index,
            time: clickedCandle.time,
            price: clickedPrice,
          },
          locked: true,
        })
      }
      return
    }

    if (drawingMode === 'cursor') {
      event.currentTarget.setPointerCapture?.(event.pointerId)
      dragRef.current = {
        startX: event.clientX,
        accumulatedBars: 0,
        isDragging: true,
      }
      return
    }

    if (!onAddDrawing || !clickedCandle) return

    if (drawingMode === 'horizontal') {
      onAddDrawing({
        id: `hz-${Date.now()}`,
        type: 'horizontal',
        price: clickedPrice,
        label: `S/R ${formatPrice(clickedPrice)}`,
      })
      return
    }

    if (drawingMode === 'trendline' || drawingMode === 'fib') {
      if (!draftAnchor) {
        setDraftAnchor({ time: clickedCandle.time, price: clickedPrice })
      } else {
        onAddDrawing(
          drawingMode === 'trendline'
            ? {
                id: `tl-${Date.now()}`,
                type: 'trendline',
                t1: draftAnchor.time,
                p1: draftAnchor.price,
                t2: clickedCandle.time,
                p2: clickedPrice,
              }
            : {
                id: `fib-${Date.now()}`,
                type: 'fib',
                t1: draftAnchor.time,
                p1: draftAnchor.price,
                t2: clickedCandle.time,
                p2: clickedPrice,
              },
        )
        setDraftAnchor(null)
      }
    }
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (dragRef.current) {
      dragRef.current.isDragging = false
    }
  }

  function handlePointerLeave() {
    if (dragRef.current) {
      dragRef.current.isDragging = false
    }
    updateActiveIndex(null)
    setHoverPrice(null)
  }

  const entryLine = orderLines.find((o) => o.kind === 'entry')
  const tpLine = orderLines.find((o) => o.kind === 'tp')
  const slLine = orderLines.find((o) => o.kind === 'sl')
  const hoverNearLast = Boolean(
    lastCandle &&
      activeIndex !== null &&
      hoverPrice !== null &&
      Math.abs(yOf(hoverPrice) - yOf(lastCandle.close)) < 18,
  )

  const volSmaPoints = useMemo(() => {
    if (!volSmaValues || volSmaValues.length !== count) return ''
    return volSmaValues
      .map((val, idx) => {
        if (val === null || val === undefined || !Number.isFinite(val)) {
          return null
        }
        const volRatio = Math.min(1, val / maxVolume)
        const volH = Math.max(1, volRatio * (plotHeight * 0.16))
        return `${xOf(idx)},${yBottom - volH}`
      })
      .filter((p): p is string => p !== null)
      .join(' ')
  }, [count, maxVolume, plotHeight, volSmaValues, yBottom])

  const activeMeasureEnd = measureRange?.end
  const measureData = useMemo(() => {
    if (!measureRange || !activeMeasureEnd) return null
    const x1 = xOfTime(measureRange.start.time) ?? MARGIN.left
    const x2 = xOfTime(activeMeasureEnd.time) ?? xOf(activeMeasureEnd.index)
    const y1 = yOf(measureRange.start.price)
    const y2 = yOf(activeMeasureEnd.price)
    const diffUsd = activeMeasureEnd.price - measureRange.start.price
    const diffPct =
      measureRange.start.price > 0
        ? (diffUsd / measureRange.start.price) * 100
        : 0
    const barsDelta = Math.abs(activeMeasureEnd.index - measureRange.start.index) + 1
    const durationText = formatDurationMs(
      activeMeasureEnd.time - measureRange.start.time,
    )
    const isUp = diffUsd >= 0
    const leftX = Math.min(x1, x2)
    const topY = Math.min(y1, y2)
    const rectW = Math.max(2, Math.abs(x2 - x1))
    const rectH = Math.max(2, Math.abs(y2 - y1))
    return {
      leftX,
      topY,
      rectW,
      rectH,
      x2,
      y2,
      isUp,
      label: `${diffUsd >= 0 ? '+' : ''}${formatPrice(diffUsd)} (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(2)}%) · ${barsDelta}b · ${durationText}`,
    }
  }, [activeMeasureEnd, measureRange])

  return (
    <div
      className={compactHeader ? 'chart !px-2.5 !py-2' : 'chart'}
      ref={containerRef}
    >
      <div className="chart__header-bar">
        <div className="chart__readout">
          <span className="chart__readout-main">
            <strong>{formatPrice(shown.close)}</strong>
            <span className={changeClass(change)}>
              {change > 0 ? '+' : ''}
              {formatPercent(change, 2)}
            </span>
          </span>
          <span className="chart__ohlc">
            {candleStyle === 'heikin-ashi' && (
              <span className="rounded bg-secondary px-1 py-0.5 text-[9.5px] font-semibold text-primary">
                HA
              </span>
            )}
            O {formatPrice(shown.open)} · H {formatPrice(shown.high)} · L{' '}
            {formatPrice(shown.low)} · C{' '}
            <span
              className={
                shown.close >= shown.open ? 'chart__ohlc--pos' : 'chart__ohlc--neg'
              }
            >
              {formatPrice(shown.close)}
            </span>{' '}
            ·{' '}
            <span className="chart__ohlc-vol">
              V {shown.volume.toFixed(1)}
            </span>
          </span>
          <span className="chart__readout-time">
            {formatDateTime(shown.time, locale)} UTC
          </span>
        </div>
      </div>

      {(overlays.length > 0 || signals.length > 0) && (
        <div className="chart__legend">
          {overlays.map((overlay) => {
            const valAtCursor = overlay.values[shownIndex]
            return (
              <span key={overlay.id} className="chart__legend-item">
                <span
                  className={`chart__swatch chart__swatch--${overlay.kind}`}
                />
                <span>{overlay.label}</span>
                {valAtCursor !== null && valAtCursor !== undefined && (
                  <span className="chart__legend-val">
                    : {formatPrice(valAtCursor)}
                  </span>
                )}
              </span>
            )
          })}
          {signals.length > 0 && (
            <>
              <span className="chart__legend-item">
                <span className="legend__buy">
                  <TrendingUp className="size-3" />
                </span>
                <span>{t('chart.buy')}</span>
              </span>
              <span className="chart__legend-item">
                <span className="legend__sell">
                  <TrendingDown className="size-3" />
                </span>
                <span>{t('chart.sell')}</span>
              </span>
            </>
          )}
        </div>
      )}

      <div className="chart__canvas-wrap" ref={canvasWrapRef}>
        {draftAnchor && (
          <div className="chart__drawing-hint" role="status">
            <span>
              {isEs
                ? 'Punto A fijado · Haz clic en el Punto B (o Esc)'
                : 'Point A set · Click Point B (or Esc)'}
            </span>
            <button
              type="button"
              className="chart__drawing-cancel"
              onClick={() => setDraftAnchor(null)}
            >
              {isEs ? 'Cancelar' : 'Cancel'}
            </button>
          </div>
        )}
        {drawingMode === 'measure' && !measureRange && (
          <div className="chart__drawing-hint" role="status">
            <span>
              {isEs
                ? 'Regla: clic en inicio y fin para medir Δ$, Δ% y velas'
                : 'Measure: click start and end bar to measure Δ$, Δ% and bars'}
            </span>
          </div>
        )}
        {width > 0 && (
          <svg
            ref={svgRef}
            className={`chart__svg ${
              drawingMode !== 'cursor'
                ? 'chart__svg--crosshair'
                : 'chart__svg--interactive'
            }`}
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={description}
            onPointerMove={handlePointerMove}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onPointerLeave={handlePointerLeave}
            onDoubleClick={() => {
              if (drawingMode === 'cursor') onResetView?.()
            }}
          >
            <defs>
              <clipPath id={clipId}>
                <rect
                  x={MARGIN.left}
                  y={MARGIN.top}
                  width={plotWidth}
                  height={Math.max(0, plotHeight)}
                />
              </clipPath>
            </defs>

            {/* Dark matte plot backdrop matching TradingView canvas contrast */}
            <rect
              className="chart__plot-bg"
              x={MARGIN.left}
              y={MARGIN.top}
              width={plotWidth}
              height={Math.max(0, plotHeight)}
            />

            {/* Vertical time gridlines and X-axis tick labels */}
            {timeTicks.map((idx) => {
              const x = xOf(idx)
              return (
                <g key={`tgrid-${idx}`}>
                  <line
                    className="chart__grid--vertical"
                    x1={x}
                    x2={x}
                    y1={MARGIN.top}
                    y2={yBottom}
                  />
                  <text
                    className="chart__label"
                    x={x}
                    y={height - 8}
                    textAnchor="middle"
                  >
                    {formatAxisTick(displayCandles[idx].time, spanMs, locale)}
                  </text>
                </g>
              )
            })}

            {/* Horizontal grid and right-aligned price scale */}
            {ticks.map((tick) => {
              const y = yOf(tick)
              return (
                <g key={tick}>
                  <line
                    className="chart__grid"
                    x1={MARGIN.left}
                    x2={MARGIN.left + plotWidth}
                    y1={y}
                    y2={y}
                  />
                  <text
                    className="chart__label"
                    x={MARGIN.left + plotWidth + 8}
                    y={y}
                    textAnchor="start"
                    dominantBaseline="middle"
                  >
                    {formatPrice(tick)}
                  </text>
                </g>
              )
            })}

            {/* Axis border hairlines */}
            <line
              className="chart__axis-border"
              x1={MARGIN.left + plotWidth}
              x2={MARGIN.left + plotWidth}
              y1={MARGIN.top}
              y2={yBottom}
            />
            <line
              className="chart__axis-border"
              x1={MARGIN.left}
              x2={MARGIN.left + plotWidth}
              y1={yBottom}
              y2={yBottom}
            />

            <g clipPath={`url(#${clipId})`}>
              {/* Active hovered candle column highlight */}
              {activeIndex !== null && slot > 0 && (
                <rect
                  className="chart__active-col"
                  x={MARGIN.left + shownIndex * slot}
                  y={MARGIN.top}
                  width={slot}
                  height={plotHeight}
                />
              )}

              {/* Shaded Take Profit and Stop Loss zones (Binance style) */}
              {entryLine && tpLine && (
                <rect
                  className="chart__zone-tp"
                  x={MARGIN.left}
                  y={Math.min(yOf(entryLine.price), yOf(tpLine.price))}
                  width={plotWidth}
                  height={Math.abs(yOf(tpLine.price) - yOf(entryLine.price))}
                />
              )}
              {entryLine && slLine && (
                <rect
                  className="chart__zone-sl"
                  x={MARGIN.left}
                  y={Math.min(yOf(entryLine.price), yOf(slLine.price))}
                  width={plotWidth}
                  height={Math.abs(yOf(slLine.price) - yOf(entryLine.price))}
                />
              )}

              {/* Bollinger Bands channel fill */}
              {bbPolygonPoints && (
                <polygon className="chart__bb-band" points={bbPolygonPoints} />
              )}

              {/* Volume histogram in bottom 16% + optional Vol SMA */}
              {displayCandles.map((candle, index) => {
                const isUp = candle.close >= candle.open
                const x = xOf(index)
                const volRatio = candle.volume / maxVolume
                const volHeight = Math.max(1, volRatio * (plotHeight * 0.16))
                const isActive = activeIndex === index
                return (
                  <rect
                    key={`vol-${candle.time}`}
                    className={cn(
                      'chart__vol',
                      isUp ? 'chart__vol--up' : 'chart__vol--down',
                      isActive && 'chart__vol--active',
                    )}
                    x={x - bodyWidth / 2}
                    y={yBottom - volHeight}
                    width={bodyWidth}
                    height={volHeight}
                  />
                )
              })}

              {volSmaPoints && (
                <polyline className="chart__vol-sma" points={volSmaPoints} />
              )}

              {/* OHLC / Hollow / Heikin Ashi candlesticks */}
              {displayCandles.map((candle, index) => {
                const isUp = candle.close >= candle.open
                const x = xOf(index)
                const bodyTop = yOf(Math.max(candle.open, candle.close))
                const bodyBottom = yOf(Math.min(candle.open, candle.close))
                const isHollow = candleStyle === 'hollow' && isUp
                const isActive = activeIndex === index

                return (
                  <g
                    key={candle.time}
                    className={cn(
                      isUp ? 'candle candle--up' : 'candle candle--down',
                      isHollow && 'candle--hollow',
                      isActive && 'candle--active',
                    )}
                  >
                    <line
                      className="candle__wick"
                      x1={x}
                      x2={x}
                      y1={yOf(candle.high)}
                      y2={yOf(candle.low)}
                    />
                    <rect
                      className="candle__body"
                      x={x - bodyWidth / 2}
                      y={bodyTop}
                      width={bodyWidth}
                      height={Math.max(1.5, bodyBottom - bodyTop)}
                      rx={bodyWidth >= 5 ? 0.8 : 0}
                    />
                  </g>
                )
              })}

              {/* Visible High / Low price extremes callouts (TradingView / Binance style) */}
              {count >= 12 &&
                (() => {
                  const highX = xOf(maxIdx)
                  const highY = yOf(candleHighMax)
                  const highOnRight = highX > MARGIN.left + plotWidth * 0.72
                  const lowX = xOf(minIdx)
                  const lowY = yOf(candleLowMin)
                  const lowOnRight = lowX > MARGIN.left + plotWidth * 0.72
                  return (
                    <g pointerEvents="none">
                      <line
                        className="chart__extremum-line"
                        x1={highX}
                        x2={highOnRight ? highX - 18 : highX + 18}
                        y1={highY}
                        y2={highY}
                      />
                      <text
                        className="chart__extremum-label"
                        x={highOnRight ? highX - 21 : highX + 21}
                        y={Math.max(MARGIN.top + 8, highY)}
                        textAnchor={highOnRight ? 'end' : 'start'}
                        dominantBaseline="middle"
                      >
                        H {formatPrice(candleHighMax)}
                      </text>
                      <line
                        className="chart__extremum-line"
                        x1={lowX}
                        x2={lowOnRight ? lowX - 18 : lowX + 18}
                        y1={lowY}
                        y2={lowY}
                      />
                      <text
                        className="chart__extremum-label"
                        x={lowOnRight ? lowX - 21 : lowX + 21}
                        y={Math.min(yBottom - 8, lowY)}
                        textAnchor={lowOnRight ? 'end' : 'start'}
                        dominantBaseline="middle"
                      >
                        L {formatPrice(candleLowMin)}
                      </text>
                    </g>
                  )
                })()}

              {/* Continuous moving averages, Bollinger & VWAP */}
              {overlays.map((overlay) => {
                const points = overlay.values
                  .map((value, index) =>
                    value === null || value === undefined
                      ? null
                      : `${xOf(index)},${yOf(value)}`,
                  )
                  .filter((point): point is string => point !== null)
                  .join(' ')

                if (!points) return null
                return (
                  <polyline
                    key={overlay.id}
                    className={`overlay overlay--${overlay.kind}`}
                    points={points}
                  />
                )
              })}

              {/* Live current price line (clipped) */}
              {lastCandle && (
                <line
                  className={`chart__last-price-line ${
                    lastCandle.close >= lastCandle.open
                      ? 'chart__last-price-line--up'
                      : 'chart__last-price-line--down'
                  }`}
                  x1={MARGIN.left}
                  x2={MARGIN.left + plotWidth}
                  y1={yOf(lastCandle.close)}
                  y2={yOf(lastCandle.close)}
                />
              )}

              {/* Binance-style order lines (ENTRY, TP, SL, PROFIT-LOCK) */}
              {orderLines.map((ord) => {
                if (ord.price < yMin || ord.price > yMax) return null
                const y = yOf(ord.price)
                return (
                  <g
                    key={ord.id}
                    className={`chart__order chart__order--${ord.kind}`}
                  >
                    <line
                      className="chart__order-line"
                      x1={MARGIN.left}
                      x2={MARGIN.left + plotWidth}
                      y1={y}
                      y2={y}
                    />
                    <rect
                      className="chart__order-tag-bg"
                      x={MARGIN.left + 8}
                      y={y - 10}
                      width={Math.min(260, ord.label.length * 6.5 + 16)}
                      height={19}
                      rx={3}
                    />
                    <text
                      className="chart__order-tag-text"
                      x={MARGIN.left + 14}
                      y={y}
                      dominantBaseline="middle"
                    >
                      {ord.label}
                    </text>
                  </g>
                )
              })}

              {/* User technical drawings (trendlines, horizontal S/R, Fibonacci) */}
              {drawings.map((d) => {
                if (d.type === 'horizontal') {
                  if (d.price < yMin || d.price > yMax) return null
                  const y = yOf(d.price)
                  return (
                    <g key={d.id} className="chart__drawing-hz">
                      <line
                        className="chart__drawing-line--sr"
                        x1={MARGIN.left}
                        x2={MARGIN.left + plotWidth}
                        y1={y}
                        y2={y}
                      />
                      <text
                        className="chart__drawing-label chart__drawing-label--sr"
                        x={MARGIN.left + plotWidth - (onRemoveDrawing ? 22 : 6)}
                        y={y - 5}
                        textAnchor="end"
                      >
                        {d.label}
                      </text>
                      {onRemoveDrawing && (
                        <g
                          className="chart__drawing-delete"
                          onPointerDown={(e) => {
                            e.stopPropagation()
                            onRemoveDrawing(d.id)
                          }}
                        >
                          <rect
                            className="chart__drawing-delete-bg"
                            x={MARGIN.left + plotWidth - 18}
                            y={y - 14}
                            width={13}
                            height={13}
                            rx={3}
                          />
                          <text
                            className="chart__drawing-delete-text"
                            x={MARGIN.left + plotWidth - 11.5}
                            y={y - 7.5}
                            textAnchor="middle"
                            dominantBaseline="middle"
                          >
                            ×
                          </text>
                        </g>
                      )}
                    </g>
                  )
                }

                if (d.type === 'trendline') {
                  const x1 = xOfTime(d.t1)
                  const x2 = xOfTime(d.t2)
                  if (x1 === null || x2 === null) return null
                  if (
                    Math.max(x1, x2) < MARGIN.left ||
                    Math.min(x1, x2) > MARGIN.left + plotWidth
                  ) {
                    return null
                  }
                  const y1 = yOf(d.p1)
                  const y2 = yOf(d.p2)
                  const pctDiff = d.p1 !== 0 ? ((d.p2 - d.p1) / d.p1) * 100 : 0
                  const midX = (x1 + x2) / 2
                  const midY = (y1 + y2) / 2
                  return (
                    <g key={d.id} className="chart__drawing-tl">
                      <line
                        className="chart__drawing-line"
                        x1={x1}
                        y1={y1}
                        x2={x2}
                        y2={y2}
                      />
                      <circle
                        className="chart__drawing-handle"
                        cx={x1}
                        cy={y1}
                        r={3.5}
                      />
                      <circle
                        className="chart__drawing-handle"
                        cx={x2}
                        cy={y2}
                        r={3.5}
                      />
                      <text
                        className="chart__drawing-label"
                        x={midX}
                        y={midY - 7}
                        textAnchor="middle"
                      >
                        {pctDiff >= 0 ? '+' : ''}
                        {pctDiff.toFixed(2)}%
                      </text>
                      {onRemoveDrawing && (
                        <g
                          className="chart__drawing-delete"
                          onPointerDown={(e) => {
                            e.stopPropagation()
                            onRemoveDrawing(d.id)
                          }}
                        >
                          <circle
                            className="chart__drawing-delete-bg"
                            cx={x2 + 10}
                            cy={y2 - 8}
                            r={6.5}
                          />
                          <text
                            className="chart__drawing-delete-text"
                            x={x2 + 10}
                            y={y2 - 7.5}
                            textAnchor="middle"
                            dominantBaseline="middle"
                          >
                            ×
                          </text>
                        </g>
                      )}
                    </g>
                  )
                }

                if (d.type === 'fib') {
                  const x1 = xOfTime(d.t1)
                  const x2 = xOfTime(d.t2)
                  if (x1 === null || x2 === null) return null
                  if (
                    Math.max(x1, x2) < MARGIN.left ||
                    Math.min(x1, x2) > MARGIN.left + plotWidth
                  ) {
                    return null
                  }
                  const leftX = Math.max(MARGIN.left, Math.min(x1, x2))
                  const rightX = Math.min(
                    MARGIN.left + plotWidth,
                    Math.max(x1, x2, leftX + 75),
                  )
                  const topY = Math.min(yOf(d.p1), yOf(d.p2))
                  return (
                    <g key={d.id} className="chart__drawing-fib">
                      <rect
                        className="chart__drawing-zone-fib"
                        x={leftX}
                        y={topY}
                        width={Math.max(2, rightX - leftX)}
                        height={Math.abs(yOf(d.p2) - yOf(d.p1))}
                      />
                      {FIB_LEVELS.map((lvl) => {
                        const price = d.p1 + (d.p2 - d.p1) * lvl
                        const y = yOf(price)
                        return (
                          <g key={lvl}>
                            <line
                              className="chart__drawing-line--fib"
                              x1={leftX}
                              x2={rightX}
                              y1={y}
                              y2={y}
                            />
                            <text
                              className="chart__drawing-label chart__drawing-label--fib"
                              x={rightX - 4}
                              y={y - 3}
                              textAnchor="end"
                            >
                              {(lvl * 100).toFixed(1)}% ({formatPrice(price)})
                            </text>
                          </g>
                        )
                      })}
                      {onRemoveDrawing && (
                        <g
                          className="chart__drawing-delete"
                          onPointerDown={(e) => {
                            e.stopPropagation()
                            onRemoveDrawing(d.id)
                          }}
                        >
                          <rect
                            className="chart__drawing-delete-bg"
                            x={rightX - 15}
                            y={topY + 2}
                            width={13}
                            height={13}
                            rx={3}
                          />
                          <text
                            className="chart__drawing-delete-text"
                            x={rightX - 8.5}
                            y={topY + 8.5}
                            textAnchor="middle"
                            dominantBaseline="middle"
                          >
                            ×
                          </text>
                        </g>
                      )}
                    </g>
                  )
                }

                return null
              })}

              {/* Active Measurement Ruler box & telemetry badge */}
              {measureData && (
                <g pointerEvents="none">
                  <rect
                    className={
                      measureData.isUp
                        ? 'chart__measure-box--up'
                        : 'chart__measure-box--down'
                    }
                    x={measureData.leftX}
                    y={measureData.topY}
                    width={measureData.rectW}
                    height={measureData.rectH}
                    rx={2}
                  />
                  {(() => {
                    const pillW = Math.min(280, measureData.label.length * 6 + 14)
                    const pillX = Math.max(
                      MARGIN.left + 6,
                      Math.min(
                        MARGIN.left + plotWidth - pillW - 6,
                        measureData.leftX + measureData.rectW / 2 - pillW / 2,
                      ),
                    )
                    const pillY =
                      measureData.topY > MARGIN.top + 26
                        ? measureData.topY - 22
                        : Math.min(yBottom - 22, measureData.topY + measureData.rectH + 6)
                    return (
                      <g>
                        <rect
                          className={
                            measureData.isUp
                              ? 'chart__measure-pill-bg--up'
                              : 'chart__measure-pill-bg--down'
                          }
                          x={pillX}
                          y={pillY}
                          width={pillW}
                          height={18}
                          rx={3}
                        />
                        <text
                          className="chart__measure-pill-text"
                          x={pillX + pillW / 2}
                          y={pillY + 9}
                          textAnchor="middle"
                          dominantBaseline="middle"
                        >
                          {measureData.label}
                        </text>
                      </g>
                    )
                  })()}
                </g>
              )}

              {/* Elastic preview while drawing a trendline or Fibonacci */}
              {draftAnchor && hoverPrice !== null && (
                <g className="chart__drawing-tl chart__drawing-tl--draft">
                  <line
                    className="chart__drawing-line--draft"
                    x1={xOfTime(draftAnchor.time) ?? MARGIN.left}
                    y1={yOf(draftAnchor.price)}
                    x2={xOf(shownIndex)}
                    y2={yOf(hoverPrice)}
                  />
                  <circle
                    className="chart__drawing-handle"
                    cx={xOfTime(draftAnchor.time) ?? MARGIN.left}
                    cy={yOf(draftAnchor.price)}
                    r={4}
                  />
                  <circle
                    className="chart__drawing-handle"
                    cx={xOf(shownIndex)}
                    cy={yOf(hoverPrice)}
                    r={4}
                  />
                </g>
              )}

              {/* Signal markers (Buy / Sell) */}
              {signals.map((signal) => {
                const candle = displayCandles[signal.index]
                if (!candle) return null

                const x = xOf(signal.index)
                const half = MARKER_SIZE / 2

                if (signal.side === 'buy') {
                  const y = yOf(candle.low) + MARKER_GAP
                  return (
                    <polygon
                      key={`${signal.index}-${signal.side}`}
                      className="signal signal--buy"
                      points={`${x},${y} ${x - half},${y + MARKER_SIZE} ${x + half},${y + MARKER_SIZE}`}
                    />
                  )
                }

                const y = yOf(candle.high) - MARKER_GAP
                return (
                  <polygon
                    key={`${signal.index}-${signal.side}`}
                    className="signal signal--sell"
                    points={`${x},${y} ${x - half},${y - MARKER_SIZE} ${x + half},${y - MARKER_SIZE}`}
                  />
                )
              })}

              {/* Interactive hovered signal tooltip badge */}
              {hoveredSignal &&
                (() => {
                  const sigCandle = displayCandles[hoveredSignal.index]
                  if (!sigCandle) return null
                  const tipText = `${hoveredSignal.side.toUpperCase()} @ ${formatPrice(hoveredSignal.price)}`
                  const tipW = Math.min(200, tipText.length * 6.2 + 14)
                  const tipX = Math.max(
                    MARGIN.left + 6,
                    Math.min(
                      MARGIN.left + plotWidth - tipW - 6,
                      xOf(hoveredSignal.index) - tipW / 2,
                    ),
                  )
                  const tipY =
                    hoveredSignal.side === 'buy'
                      ? Math.min(yBottom - 22, yOf(sigCandle.low) + 18)
                      : Math.max(MARGIN.top + 4, yOf(sigCandle.high) - 34)
                  return (
                    <g pointerEvents="none">
                      <rect
                        className="chart__signal-tip-bg"
                        x={tipX}
                        y={tipY}
                        width={tipW}
                        height={18}
                        rx={3}
                      />
                      <text
                        className="chart__signal-tip-text"
                        x={tipX + tipW / 2}
                        y={tipY + 9}
                        textAnchor="middle"
                        dominantBaseline="middle"
                      >
                        {tipText}
                      </text>
                    </g>
                  )
                })()}

              {/* Synced crosshair + Magnet OHLC snap ring */}
              {activeIndex !== null && (
                <g pointerEvents="none">
                  <line
                    className="chart__cursor"
                    x1={xOf(shownIndex)}
                    x2={xOf(shownIndex)}
                    y1={MARGIN.top}
                    y2={yBottom}
                  />
                  {hoverPrice !== null && (
                    <line
                      className="chart__cursor"
                      x1={MARGIN.left}
                      x2={MARGIN.left + plotWidth}
                      y1={yOf(hoverPrice)}
                      y2={yOf(hoverPrice)}
                    />
                  )}
                  {magnetSnap && drawingMode !== 'cursor' && hoverPrice !== null && (
                    <circle
                      className="chart__magnet-dot"
                      cx={xOf(shownIndex)}
                      cy={yOf(hoverPrice)}
                      r={4}
                    />
                  )}
                </g>
              )}
            </g>

            {/* Right-axis price tags (Orders, Current Price, and Crosshair) */}
            {orderLines.map((ord) => {
              if (ord.price < yMin || ord.price > yMax) return null
              const y = yOf(ord.price)
              if (
                ord.kind === 'entry' &&
                lastCandle &&
                Math.abs(y - yOf(lastCandle.close)) < 16
              ) {
                return null
              }
              return (
                <g
                  key={`pill-${ord.id}`}
                  className={`chart__order chart__order--${ord.kind}`}
                >
                  <rect
                    className="chart__order-pill"
                    x={MARGIN.left + plotWidth + 4}
                    y={y - 9}
                    width={MARGIN.right - 8}
                    height={18}
                    rx={3}
                  />
                  <text
                    className="chart__order-pill-text"
                    x={MARGIN.left + plotWidth + 8}
                    y={y}
                    dominantBaseline="middle"
                  >
                    {ord.badge}
                  </text>
                </g>
              )
            })}

            {lastCandle && (
              <g opacity={hoverNearLast ? 0.25 : 1}>
                <rect
                  className={`chart__axis-pill ${
                    lastCandle.close >= lastCandle.open
                      ? 'chart__axis-pill--up'
                      : 'chart__axis-pill--down'
                  }`}
                  x={MARGIN.left + plotWidth + 4}
                  y={yOf(lastCandle.close) - 9}
                  width={MARGIN.right - 8}
                  height={18}
                  rx={3}
                />
                <text
                  className="chart__axis-pill-text"
                  x={MARGIN.left + plotWidth + 8}
                  y={yOf(lastCandle.close)}
                  dominantBaseline="middle"
                >
                  {formatPrice(lastCandle.close)}
                </text>
              </g>
            )}

            {activeIndex !== null && hoverPrice !== null && (
              <g>
                <rect
                  className="chart__axis-pill--crosshair"
                  x={MARGIN.left + plotWidth + 4}
                  y={yOf(hoverPrice) - 9}
                  width={MARGIN.right - 8}
                  height={18}
                  rx={3}
                />
                <text
                  className="chart__axis-pill-text--crosshair"
                  x={MARGIN.left + plotWidth + 8}
                  y={yOf(hoverPrice)}
                  dominantBaseline="middle"
                >
                  {formatPrice(hoverPrice)}
                </text>
              </g>
            )}

            {/* Bottom edge timestamps + active cursor timestamp pill */}
            <text
              className="chart__label"
              x={MARGIN.left}
              y={height - 8}
              textAnchor="start"
            >
              {fromText}
            </text>
            <text
              className="chart__label"
              x={MARGIN.left + plotWidth}
              y={height - 8}
              textAnchor="end"
            >
              {toText}
            </text>
            {activeIndex !== null &&
              (() => {
                const pillW = 94
                const pillX = Math.max(
                  MARGIN.left + 2,
                  Math.min(
                    MARGIN.left + plotWidth - pillW - 2,
                    xOf(shownIndex) - pillW / 2,
                  ),
                )
                return (
                  <g pointerEvents="none">
                    <rect
                      className="chart__time-pill"
                      x={pillX}
                      y={yBottom + 4}
                      width={pillW}
                      height={16}
                      rx={3}
                    />
                    <text
                      className="chart__time-pill-text"
                      x={pillX + pillW / 2}
                      y={yBottom + 12}
                      textAnchor="middle"
                      dominantBaseline="middle"
                    >
                      {formatDateTime(shown.time, locale)}
                    </text>
                  </g>
                )
              })()}
          </svg>
        )}

        {/* Floating in-chart controls (TradingView style) */}
        <div
          className="absolute bottom-[34px] left-1/2 z-[4] inline-flex -translate-x-1/2 items-center gap-0.5 rounded-md border border-[var(--border-strong)] bg-[var(--surface-glass)] px-1.5 py-1 opacity-90 shadow-[var(--shadow-soft)] backdrop-blur-xl transition-opacity hover:opacity-100"
          role="toolbar"
          aria-label={
            isEs
              ? 'Controles de zoom y navegación estilo TradingView'
              : 'TradingView-style zoom and pan controls'
          }
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => onPanDelta?.(Math.max(4, Math.round(count * 0.14)))}
                aria-label={isEs ? 'Desplazar a la izquierda' : 'Pan left'}
              >
                <ChevronLeft className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {isEs ? 'Desplazar izquierda' : 'Pan left (History)'}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => onZoomDelta?.(Math.max(4, Math.round(count * 0.16)))}
                aria-label={isEs ? 'Alejar gráfica' : 'Zoom Out'}
              >
                <ZoomOut className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {isEs ? 'Alejar gráfica (-)' : 'Zoom Out (-)'}
            </TooltipContent>
          </Tooltip>

          <span className="inline-flex min-w-[40px] items-center justify-center px-1 font-mono text-[11px] font-semibold whitespace-nowrap text-foreground tabular-nums">
            {count}V
          </span>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => onZoomDelta?.(-Math.max(4, Math.round(count * 0.16)))}
                aria-label={isEs ? 'Acercar gráfica' : 'Zoom In'}
              >
                <ZoomIn className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {isEs ? 'Acercar gráfica (+)' : 'Zoom In (+)'}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => onPanDelta?.(-Math.max(4, Math.round(count * 0.14)))}
                aria-label={isEs ? 'Desplazar a la derecha' : 'Pan right'}
              >
                <ChevronRight className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {isEs ? 'Desplazar derecha' : 'Pan right (Recent)'}
            </TooltipContent>
          </Tooltip>

          <span className="mx-0.5 h-3.5 w-px bg-border" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => onResetView?.()}
                aria-label={isEs ? 'Restablecer vista' : 'Reset view'}
              >
                <RotateCcw className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {isEs ? 'Restablecer vista (Doble clic)' : 'Reset view (Double click)'}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setWheelZoomLocked((v) => !v)}
                className={cn(
                  'min-w-[84px] justify-center font-mono text-[10.5px] font-semibold whitespace-nowrap tabular-nums',
                  wheelZoomLocked
                    ? 'border-primary/50 bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary'
                    : 'text-muted-foreground',
                )}
              >
                <Mouse className="size-3" />
                <span>
                  {wheelZoomLocked
                    ? isEs
                      ? 'Rueda ON'
                      : 'Wheel ON'
                    : isEs
                      ? 'Rueda OFF'
                      : 'Wheel OFF'}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {wheelZoomLocked
                ? isEs
                  ? 'Zoom con rueda ACTIVO'
                  : 'Wheel Zoom ON (Locks page scroll)'
                : isEs
                  ? 'Activar Zoom con rueda (o Ctrl + Rueda)'
                  : 'Enable Wheel Zoom (or hold Ctrl + Wheel)'}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

export default CandleChart
