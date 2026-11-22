import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import './EquityChart.css'
import './CandleChart.css'
import {
  ArrowDownRight,
  ArrowUpRight,
  BellPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
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
import { PAN_OVERSCAN_LIMIT, useChartPanZoom } from '../hooks/useChartPanZoom'
import { useElementSize, useElementWidth } from '../hooks/useElementWidth'
import {
  applyDrawingDrag,
  createDrawingId,
  DRAWING_FIB_LEVELS,
  hitTestDrawings,
  type DrawingHitPart,
} from '../chartDrawings'
import {
  computeChartYDomain,
  resolveAxisTagPositions,
  type AxisTagInput,
} from '../chartRenderer'
import type { CrosshairChannel, PanTransformChannel } from '../chartCrosshair'
import { STUDIO_PLOT_MARGIN } from '../chartLayout'
import { formatDateTime, formatPercent, formatPrice } from '../format'
import { useI18n } from '../i18n'
import type { LiveStreamStatus } from '../market/liveStream'
import type {
  Candle,
  CandleStyleMode,
  ChartAlert,
  ChartDrawing,
  ChartOrderLine,
  ChartOverlay,
  DrawingToolMode,
  Interval,
  Signal,
  TradeSide,
} from '../types'

export type { DrawingToolMode }

type CandleChartProps = {
  candles: Candle[]
  overscanLeftCandles?: Candle[]
  overscanRightCandles?: Candle[]
  overlays?: ChartOverlay[]
  overscanLeftOverlays?: (number | null)[][]
  overscanRightOverlays?: (number | null)[][]
  signals?: Signal[]
  orderLines?: ChartOrderLine[]
  alerts?: ChartAlert[]
  highlightedAlertId?: string | null
  drawings?: ChartDrawing[]
  drawingMode?: DrawingToolMode
  candleStyle?: CandleStyleMode
  magnetSnap?: boolean
  volSmaValues?: (number | null)[]
  overscanLeftVolSma?: (number | null)[]
  overscanRightVolSma?: (number | null)[]
  onAddDrawing?: (drawing: ChartDrawing) => void
  onUpdateDrawing?: (drawing: ChartDrawing) => void
  onRemoveDrawing?: (id: string) => void
  selectedDrawingId?: string | null
  onSelectDrawing?: (id: string | null) => void
  onCreateAlertAtPrice?: (price: number) => void
  onPrefillOrderAtPrice?: (side: TradeSide, price: number) => void
  activeIndex?: number | null
  onActiveIndexChange?: (index: number | null) => void
  crosshairChannel?: CrosshairChannel
  panTransformChannel?: PanTransformChannel
  wheelTargetRef?: { current: HTMLElement | null }
  viewStart?: number
  canPanLeft?: boolean
  canPanRight?: boolean
  onZoomDelta?: (deltaBars: number, anchorRatio?: number) => void
  onPanDelta?: (deltaBars: number) => void
  onResetView?: () => void
  canJumpLive?: boolean
  onJumpLive?: () => void
  livePrice?: number | null
  livePriceIsUp?: boolean
  pair?: string
  interval?: Interval
  streamStatus?: LiveStreamStatus
  height?: number
  fillHeight?: boolean
  defaultWheelZoomLocked?: boolean
  reducedMotion?: boolean
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

type MeasureAnchor = {
  index: number
  time: number
  price: number
}

type ContextMenuState = {
  x: number
  y: number
  price: number
}

function changeClass(change: number): string {
  if (change > 0) return 'chart__change--positive'
  if (change < 0) return 'chart__change--negative'
  return ''
}

const axisDayFmtCache = new Map<string, Intl.DateTimeFormat>()
const axisTimeFmtCache = new Map<string, Intl.DateTimeFormat>()

function formatAxisTick(timeMs: number, spanMs: number, locale: string): string {
  if (spanMs >= 5 * 86_400_000) {
    let fmt = axisDayFmtCache.get(locale)
    if (!fmt) {
      fmt = new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      })
      axisDayFmtCache.set(locale, fmt)
    }
    return fmt.format(timeMs)
  }
  let fmt = axisTimeFmtCache.get(locale)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    })
    axisTimeFmtCache.set(locale, fmt)
  }
  return fmt.format(timeMs)
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

function trySetPointerCapture(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture?.(pointerId)
  } catch {
    // Synthetic or already-released pointer id
  }
}

function tryReleasePointerCapture(el: Element, pointerId: number): void {
  try {
    if (el.hasPointerCapture?.(pointerId)) {
      el.releasePointerCapture(pointerId)
    }
  } catch {
    // Already released
  }
}

function CandleChart({
  candles,
  overscanLeftCandles,
  overscanRightCandles,
  overlays = [],
  overscanLeftOverlays,
  overscanRightOverlays,
  signals = [],
  orderLines = [],
  alerts = [],
  highlightedAlertId = null,
  drawings = [],
  drawingMode = 'cursor',
  candleStyle = 'candles',
  magnetSnap = false,
  volSmaValues,
  overscanLeftVolSma,
  overscanRightVolSma,
  onAddDrawing,
  onUpdateDrawing,
  onRemoveDrawing,
  selectedDrawingId = null,
  onSelectDrawing,
  onCreateAlertAtPrice,
  onPrefillOrderAtPrice,
  activeIndex: controlledActiveIndex,
  onActiveIndexChange,
  crosshairChannel,
  panTransformChannel,
  wheelTargetRef,
  viewStart = 0,
  canPanLeft = true,
  canPanRight = true,
  onZoomDelta,
  onPanDelta,
  onResetView,
  canJumpLive = false,
  onJumpLive,
  livePrice,
  livePriceIsUp = true,
  pair = '',
  interval = '15m',
  streamStatus,
  height = DEFAULT_HEIGHT,
  fillHeight = false,
  defaultWheelZoomLocked = false,
  reducedMotion = false,
  compactHeader = false,
}: CandleChartProps) {
  const { locale, t } = useI18n()
  const clipId = useId()
  const [containerRef, width] = useElementWidth<HTMLDivElement>()
  const [canvasWrapRef, canvasSize] = useElementSize<HTMLDivElement>()
  const svgRef = useRef<SVGSVGElement | null>(null)
  const panLayerRef = useRef<SVGGElement | null>(null)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(
    new Map(),
  )
  const pinchRef = useRef<{ startDist: number; accumZoom: number } | null>(null)
  const hoverRafRef = useRef<number | null>(null)
  const pendingHoverRef = useRef<{ index: number; price: number } | null>(null)

  const [internalIndex, setInternalIndex] = useState<number | null>(null)
  const [scopedHoverPrice, setScopedHoverPrice] = useState<{
    pair: string
    price: number
  } | null>(null)
  const hoverPrice =
    scopedHoverPrice && scopedHoverPrice.pair === pair
      ? scopedHoverPrice.price
      : null
  const setHoverPrice = useCallback(
    (price: number | null) =>
      setScopedHoverPrice(price === null ? null : { pair, price }),
    [pair],
  )

  const [legendCollapsed, setLegendCollapsed] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [editingDrawing, setEditingDrawing] = useState<ChartDrawing | null>(null)
  const drawingDragRef = useRef<{
    origin: ChartDrawing
    part: DrawingHitPart
    startTime: number
    startPrice: number
    current: ChartDrawing
    hasMoved: boolean
  } | null>(null)
  const drawingDragRafRef = useRef<number | null>(null)

  const [wheelZoomOverride, setWheelZoomOverride] = useState<{
    defaultLocked: boolean
    locked: boolean
  } | null>(null)
  const wheelZoomLocked =
    wheelZoomOverride && wheelZoomOverride.defaultLocked === defaultWheelZoomLocked
      ? wheelZoomOverride.locked
      : defaultWheelZoomLocked
  const setWheelZoomLocked = (
    updater: boolean | ((prev: boolean) => boolean),
  ) => {
    setWheelZoomOverride((prev) => {
      const current =
        prev && prev.defaultLocked === defaultWheelZoomLocked
          ? prev.locked
          : defaultWheelZoomLocked
      const next = typeof updater === 'function' ? updater(current) : updater
      return { defaultLocked: defaultWheelZoomLocked, locked: next }
    })
  }

  const [rawDraftAnchor, setRawDraftAnchor] = useState<{
    pair: string
    time: number
    price: number
  } | null>(null)
  const [rawMeasureRange, setRawMeasureRange] = useState<{
    pair: string
    start: MeasureAnchor
    end: MeasureAnchor | null
    locked: boolean
  } | null>(null)

  const setDraftAnchor = (anchor: { time: number; price: number } | null) =>
    setRawDraftAnchor(anchor ? { pair, ...anchor } : null)
  const setMeasureRange = (
    range: {
      start: MeasureAnchor
      end: MeasureAnchor | null
      locked: boolean
    } | null,
  ) => setRawMeasureRange(range ? { pair, ...range } : null)

  const draftAnchor =
    (drawingMode === 'trendline' || drawingMode === 'fib') &&
    rawDraftAnchor &&
    rawDraftAnchor.pair === pair
      ? rawDraftAnchor
      : null
  const measureRange =
    drawingMode === 'measure' && rawMeasureRange && rawMeasureRange.pair === pair
      ? rawMeasureRange
      : null

  // Single Heikin Ashi conversion: MarketAnalysis converts once at the display boundary;
  // CandleChart renders the exact candle array it receives.
  const displayCandles = candles

  useEffect(() => {
    if (!draftAnchor && !measureRange) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setRawDraftAnchor(null)
        setRawMeasureRange(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [draftAnchor, measureRange])

  useEffect(() => {
    if (!contextMenu) return
    const firstBtn = contextMenuRef.current?.querySelector('button')
    firstBtn?.focus()

    const handleGlobalPointerDown = (event: PointerEvent) => {
      if (
        contextMenuRef.current &&
        event.target instanceof Node &&
        !contextMenuRef.current.contains(event.target)
      ) {
        setContextMenu(null)
      }
    }
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setContextMenu(null)
      }
    }
    window.addEventListener('pointerdown', handleGlobalPointerDown, true)
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handleGlobalPointerDown, true)
      window.removeEventListener('keydown', handleGlobalKeyDown)
    }
  }, [contextMenu])

  useEffect(() => {
    return () => {
      if (hoverRafRef.current !== null) cancelAnimationFrame(hoverRafRef.current)
      if (drawingDragRafRef.current !== null) {
        cancelAnimationFrame(drawingDragRafRef.current)
      }
    }
  }, [])

  const channelIndex = useSyncExternalStore(
    (cb) => (crosshairChannel ? crosshairChannel.subscribe(cb) : () => {}),
    () => (crosshairChannel ? crosshairChannel.get() : undefined),
  )

  const activeIndex =
    crosshairChannel !== undefined
      ? (channelIndex ?? null)
      : controlledActiveIndex !== undefined
        ? controlledActiveIndex
        : internalIndex

  const updateActiveIndex = useCallback(
    (next: number | null) => {
      if (crosshairChannel) {
        crosshairChannel.set(next)
      } else if (onActiveIndexChange) {
        onActiveIndexChange(next)
      } else {
        setInternalIndex(next)
      }
    },
    [crosshairChannel, onActiveIndexChange],
  )

  const handleClearCrosshair = useCallback(() => {
    updateActiveIndex(null)
    setHoverPrice(null)
  }, [setHoverPrice, updateActiveIndex])

  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right)
  const count = displayCandles.length
  const slot = count > 0 ? plotWidth / count : 0

  const {
    cancelWheelPan,
    startDragPan,
    moveDragPan,
    endDragPan,
    abortDragPan,
  } = useChartPanZoom({
    containerRef,
    canvasWrapRef,
    wheelTargetRef,
    panLayerRef,
    marginLeft: MARGIN.left,
    plotWidth,
    count,
    slot,
    viewStart,
    canPanLeft,
    canPanRight,
    wheelZoomLocked,
    reducedMotion,
    panTransformChannel,
    onPanDelta,
    onZoomDelta,
    onClearCrosshair: handleClearCrosshair,
  })

  const lastIndex = Math.max(0, count - 1)
  const firstTime = count > 0 ? displayCandles[0].time : 0
  const lastTime = count > 0 ? displayCandles[lastIndex].time : 0

  const { candleLowMin, candleHighMax, minIdx, maxIdx, maxVolume } = useMemo(() => {
    let lowMin = Infinity
    let highMax = -Infinity
    let loIdx = 0
    let hiIdx = 0
    let peakVol = 1

    for (let i = 0; i < displayCandles.length; i++) {
      const c = displayCandles[i]
      if (c.low < lowMin) {
        lowMin = c.low
        loIdx = i
      }
      if (c.high > highMax) {
        highMax = c.high
        hiIdx = i
      }
      if (c.volume > peakVol) {
        peakVol = c.volume
      }
    }

    return {
      candleLowMin: lowMin,
      candleHighMax: highMax,
      minIdx: loIdx,
      maxIdx: hiIdx,
      maxVolume: peakVol,
    }
  }, [displayCandles])

  const effectiveHeight =
    fillHeight && canvasSize.height > 0
      ? Math.max(160, canvasSize.height)
      : height
  const plotHeight = Math.max(80, effectiveHeight - MARGIN.top - MARGIN.bottom)
  const yBottom = MARGIN.top + plotHeight
  const bodyWidth = Math.max(1.5, Math.min(18, slot * 0.72))

  const visibleLastCandle = count > 0 ? displayCandles[lastIndex] : null
  const effectiveLastPrice =
    livePrice !== undefined && livePrice !== null && Number.isFinite(livePrice)
      ? livePrice
      : (visibleLastCandle?.close ?? null)
  const effectiveLastIsUp =
    livePrice !== undefined && livePrice !== null
      ? livePriceIsUp
      : visibleLastCandle
        ? visibleLastCandle.close >= visibleLastCandle.open
        : true

  const { yMin, yMax, ySpan, ticks } = useMemo(
    () =>
      computeChartYDomain({
        candleMin: candleLowMin,
        candleMax: candleHighMax,
        overlays,
        orderLines,
        livePrice: effectiveLastPrice,
        plotHeight,
      }),
    [
      candleHighMax,
      candleLowMin,
      effectiveLastPrice,
      orderLines,
      overlays,
      plotHeight,
    ],
  )

  const timeTicks = useMemo(() => {
    if (count < 4 || plotWidth < 200) return []
    const steps = Math.max(3, Math.min(8, Math.floor(plotWidth / 135)))
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
    if (count === 0 || slot <= 0) return null
    const upperIdx = overlays.findIndex((o) => o.kind === 'bb-upper')
    const lowerIdx = overlays.findIndex((o) => o.kind === 'bb-lower')
    if (upperIdx < 0 || lowerIdx < 0) return null
    const upper = overlays[upperIdx]
    const lower = overlays[lowerIdx]
    const leftUpper = overscanLeftOverlays?.[upperIdx]
    const leftLower = overscanLeftOverlays?.[lowerIdx]
    const rightUpper = overscanRightOverlays?.[upperIdx]
    const rightLower = overscanRightOverlays?.[lowerIdx]

    const topCoords: string[] = []
    const botCoords: string[] = []
    const pushBand = (
      idx: number,
      u: number | null | undefined,
      l: number | null | undefined,
    ) => {
      if (
        u !== null &&
        u !== undefined &&
        l !== null &&
        l !== undefined &&
        Number.isFinite(u) &&
        Number.isFinite(l)
      ) {
        const x = MARGIN.left + (idx + 0.5) * slot
        const yU = MARGIN.top + (1 - (u - yMin) / ySpan) * plotHeight
        const yL = MARGIN.top + (1 - (l - yMin) / ySpan) * plotHeight
        topCoords.push(`${x.toFixed(1)},${yU.toFixed(1)}`)
        botCoords.unshift(`${x.toFixed(1)},${yL.toFixed(1)}`)
      }
    }

    if (leftUpper && leftLower) {
      const leftLen = Math.min(leftUpper.length, leftLower.length)
      for (let i = 0; i < leftLen; i++) {
        pushBand(i - leftLen, leftUpper[i], leftLower[i])
      }
    }
    for (let i = 0; i < count; i++) {
      pushBand(i, upper.values[i], lower.values[i])
    }
    if (rightUpper && rightLower) {
      const rightLen = Math.min(rightUpper.length, rightLower.length)
      for (let i = 0; i < rightLen; i++) {
        pushBand(count + i, rightUpper[i], rightLower[i])
      }
    }
    if (topCoords.length < 2) return null
    return `${topCoords.join(' ')} ${botCoords.join(' ')}`
  }, [
    count,
    overlays,
    overscanLeftOverlays,
    overscanRightOverlays,
    plotHeight,
    slot,
    yMin,
    ySpan,
  ])

  const hoveredSignal = useMemo(() => {
    if (activeIndex === null || signals.length === 0) return null
    return (
      signals.find((s) => s.index === activeIndex) ??
      signals.find((s) => Math.abs(s.index - activeIndex) <= 1) ??
      null
    )
  }, [activeIndex, signals])

  const volSmaPoints = useMemo(() => {
    if (count === 0 || !volSmaValues || volSmaValues.length !== count || slot <= 0) {
      return ''
    }
    const pts: string[] = []
    const pushVol = (idx: number, val: number | null | undefined) => {
      if (val === null || val === undefined || !Number.isFinite(val)) return
      const volRatio = Math.min(1, val / maxVolume)
      const volH = Math.max(1, volRatio * (plotHeight * 0.16))
      const x = MARGIN.left + (idx + 0.5) * slot
      pts.push(`${x.toFixed(1)},${(yBottom - volH).toFixed(1)}`)
    }
    if (overscanLeftVolSma) {
      const leftLen = overscanLeftVolSma.length
      for (let i = 0; i < leftLen; i++) pushVol(i - leftLen, overscanLeftVolSma[i])
    }
    for (let i = 0; i < count; i++) pushVol(i, volSmaValues[i])
    if (overscanRightVolSma) {
      for (let i = 0; i < overscanRightVolSma.length; i++) {
        pushVol(count + i, overscanRightVolSma[i])
      }
    }
    return pts.join(' ')
  }, [
    count,
    maxVolume,
    overscanLeftVolSma,
    overscanRightVolSma,
    plotHeight,
    slot,
    volSmaValues,
    yBottom,
  ])

  const activeMeasureEnd = measureRange?.end

  // Batch all volume bars, candlesticks, and overlay polylines (including left/right
  // pan overscan bars clipped by clipPath) into 6 minimal SVG paths.
  const batchedSeries = useMemo(() => {
    const volUp: string[] = []
    const volDown: string[] = []
    const wickUp: string[] = []
    const wickDown: string[] = []
    const bodyUp: string[] = []
    const bodyDown: string[] = []

    if (count > 0 && plotWidth > 0 && slot > 0) {
      const halfW = bodyWidth / 2
      const bwStr = bodyWidth.toFixed(1)
      const volScale = (plotHeight * 0.16) / maxVolume
      const toY = (val: number) =>
        MARGIN.top + (1 - (val - yMin) / ySpan) * plotHeight

      const pushCandle = (idx: number, c: Candle) => {
        const isUp = c.close >= c.open
        const x = MARGIN.left + (idx + 0.5) * slot
        const xLeftStr = (x - halfW).toFixed(1)
        const xStr = x.toFixed(1)

        const volH = Math.max(1, c.volume * volScale)
        const volSeg = `M${xLeftStr} ${(yBottom - volH).toFixed(1)}h${bwStr}v${volH.toFixed(1)}h-${bwStr}Z`
        if (isUp) volUp.push(volSeg)
        else volDown.push(volSeg)

        const yHigh = toY(c.high)
        const yLow = toY(c.low)
        const wickSeg = `M${xStr} ${yHigh.toFixed(1)}V${yLow.toFixed(1)}`
        if (isUp) wickUp.push(wickSeg)
        else wickDown.push(wickSeg)

        const yOpen = toY(c.open)
        const yClose = toY(c.close)
        const bodyTop = Math.min(yOpen, yClose)
        const bodyH = Math.max(1.5, Math.abs(yClose - yOpen))
        const bodySeg = `M${xLeftStr} ${bodyTop.toFixed(1)}h${bwStr}v${bodyH.toFixed(1)}h-${bwStr}Z`
        if (isUp) bodyUp.push(bodySeg)
        else bodyDown.push(bodySeg)
      }

      if (overscanLeftCandles) {
        const leftLen = overscanLeftCandles.length
        for (let i = 0; i < leftLen; i++) {
          pushCandle(i - leftLen, overscanLeftCandles[i])
        }
      }
      for (let i = 0; i < count; i++) {
        pushCandle(i, displayCandles[i])
      }
      if (overscanRightCandles) {
        for (let i = 0; i < overscanRightCandles.length; i++) {
          pushCandle(count + i, overscanRightCandles[i])
        }
      }
    }

    const overlayLines = overlays
      .map((overlay, overlayIdx) => {
        const pts: string[] = []
        if (plotWidth > 0 && slot > 0) {
          const pushPt = (idx: number, v: number | null | undefined) => {
            if (v === null || v === undefined) return
            const x = MARGIN.left + (idx + 0.5) * slot
            const y = MARGIN.top + (1 - (v - yMin) / ySpan) * plotHeight
            pts.push(`${x.toFixed(1)},${y.toFixed(1)}`)
          }
          const leftOv = overscanLeftOverlays?.[overlayIdx]
          if (leftOv) {
            const leftLen = leftOv.length
            for (let i = 0; i < leftLen; i++) pushPt(i - leftLen, leftOv[i])
          }
          for (let i = 0; i < overlay.values.length; i++) {
            pushPt(i, overlay.values[i])
          }
          const rightOv = overscanRightOverlays?.[overlayIdx]
          if (rightOv) {
            for (let i = 0; i < rightOv.length; i++) pushPt(count + i, rightOv[i])
          }
        }
        return { id: overlay.id, kind: overlay.kind, points: pts.join(' ') }
      })
      .filter((item) => item.points.length > 0)

    return {
      volUp: volUp.join(''),
      volDown: volDown.join(''),
      wickUp: wickUp.join(''),
      wickDown: wickDown.join(''),
      bodyUp: bodyUp.join(''),
      bodyDown: bodyDown.join(''),
      overlayLines,
    }
  }, [
    bodyWidth,
    count,
    displayCandles,
    maxVolume,
    overlays,
    overscanLeftCandles,
    overscanLeftOverlays,
    overscanRightCandles,
    overscanRightOverlays,
    plotHeight,
    plotWidth,
    slot,
    yBottom,
    yMin,
    ySpan,
  ])

  const measureData = useMemo(() => {
    if (count === 0 || !measureRange || !activeMeasureEnd) return null
    const mapTimeX = (ts: number): number => {
      if (lastTime === firstTime) return MARGIN.left + 0.5 * slot
      const exactIdx = ((ts - firstTime) / (lastTime - firstTime)) * lastIndex
      return MARGIN.left + (exactIdx + 0.5) * slot
    }
    const mapPriceY = (val: number): number =>
      MARGIN.top + (1 - (val - yMin) / ySpan) * plotHeight
    const x1 = mapTimeX(measureRange.start.time)
    const x2 = mapTimeX(activeMeasureEnd.time)
    const y1 = mapPriceY(measureRange.start.price)
    const y2 = mapPriceY(activeMeasureEnd.price)
    const diffUsd = activeMeasureEnd.price - measureRange.start.price
    const diffPct =
      measureRange.start.price > 0
        ? (diffUsd / measureRange.start.price) * 100
        : 0
    const barsDelta =
      Math.abs(activeMeasureEnd.index - measureRange.start.index) + 1
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
  }, [
    activeMeasureEnd,
    count,
    firstTime,
    lastIndex,
    lastTime,
    measureRange,
    plotHeight,
    slot,
    yMin,
    ySpan,
  ])

  if (count === 0) {
    return (
      <div className="chart" ref={containerRef}>
        <p className="chart__empty">{t('chart.noCandles')}</p>
      </div>
    )
  }

  function xOf(index: number): number {
    return MARGIN.left + (index + 0.5) * slot
  }

  function xOfTime(timestamp: number): number | null {
    if (displayCandles.length === 0) return null
    if (lastTime === firstTime) return xOf(0)
    const exactIdx = ((timestamp - firstTime) / (lastTime - firstTime)) * lastIndex
    return MARGIN.left + (exactIdx + 0.5) * slot
  }

  function timeOfX(relPlotX: number): number {
    if (displayCandles.length === 0) return 0
    if (lastTime === firstTime || slot <= 0 || lastIndex <= 0) return firstTime
    const exactIdx = relPlotX / slot - 0.5
    return Math.round(firstTime + (exactIdx / lastIndex) * (lastTime - firstTime))
  }

  function yOf(value: number): number {
    return MARGIN.top + (1 - (value - yMin) / ySpan) * plotHeight
  }

  function priceOfY(yPx: number): number {
    const clampedY = Math.max(MARGIN.top, Math.min(yBottom, yPx))
    const ratio = 1 - (clampedY - MARGIN.top) / plotHeight
    return yMin + ratio * ySpan
  }

  const renderedDrawings = editingDrawing
    ? drawings.map((d) => (d.id === editingDrawing.id ? editingDrawing : d))
    : drawings
  const horizontalDrawings = renderedDrawings.filter((d) => d.type === 'horizontal')
  const anchoredDrawings = renderedDrawings.filter((d) => d.type !== 'horizontal')
  const visibleAlerts = alerts.filter((a) => a.price >= yMin && a.price <= yMax)

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

  function resolvePointerPrice(
    index: number,
    relY: number,
    allowSnapInCursor = false,
  ): number {
    const raw = priceOfY(relY)
    if (!magnetSnap || (drawingMode === 'cursor' && !allowSnapInCursor)) return raw
    const targetCandle = displayCandles[index]
    return targetCandle ? snapPriceToCandleOhlc(targetCandle, raw) : raw
  }

  function handleContextMenu(event: ReactMouseEvent<SVGSVGElement>) {
    if (!onCreateAlertAtPrice && !onPrefillOrderAtPrice) return
    event.preventDefault()
    const svgRect = event.currentTarget.getBoundingClientRect()
    const relY = event.clientY - svgRect.top
    if (relY < MARGIN.top || relY > yBottom) {
      setContextMenu(null)
      return
    }
    const price = priceOfY(relY)
    const menuWidth = 228
    const menuHeight = 148
    const wrapRect = (canvasWrapRef.current ?? event.currentTarget).getBoundingClientRect()
    const rawX = event.clientX - wrapRect.left
    const rawY = event.clientY - wrapRect.top
    const clampedX = Math.max(8, Math.min(wrapRect.width - menuWidth - 8, rawX))
    const clampedY = Math.max(8, Math.min(wrapRect.height - menuHeight - 8, rawY))
    setContextMenu({ x: clampedX, y: clampedY, price })
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (slot <= 0) return
    const rect = event.currentTarget.getBoundingClientRect()

    // Two-finger touch pinch-to-zoom
    if (activePointersRef.current.has(event.pointerId)) {
      activePointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      })
      if (
        activePointersRef.current.size === 2 &&
        pinchRef.current &&
        onZoomDelta
      ) {
        const pts = Array.from(activePointersRef.current.values())
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
        const deltaPx = dist - pinchRef.current.startDist
        if (Math.abs(deltaPx) >= 14) {
          const midX = (pts[0].x + pts[1].x) / 2
          const relMidX = Math.max(
            0,
            Math.min(plotWidth, midX - rect.left - MARGIN.left),
          )
          const anchorRatio = plotWidth > 0 ? relMidX / plotWidth : 0.5
          const direction = deltaPx > 0 ? -1 : 1
          const step = Math.max(2, Math.round(count * 0.08))
          pinchRef.current.startDist = dist
          onZoomDelta(direction * step, anchorRatio)
        }
        return
      }
    }

    const relX = event.clientX - rect.left - MARGIN.left
    const relY = event.clientY - rect.top
    const index = Math.floor(relX / slot)
    const clampedIdx = Math.min(lastIndex, Math.max(0, index))
    const isDraggingDrawing = drawingDragRef.current !== null
    const resolvedPrice = resolvePointerPrice(clampedIdx, relY, isDraggingDrawing)

    if (drawingDragRef.current) {
      const drag = drawingDragRef.current
      const curTime = timeOfX(relX)
      const next = applyDrawingDrag({
        origin: drag.origin,
        part: drag.part,
        startTime: drag.startTime,
        startPrice: drag.startPrice,
        currentTime: curTime,
        currentPrice: resolvedPrice,
      })
      drag.current = next
      drag.hasMoved = true
      pendingHoverRef.current = { index: clampedIdx, price: resolvedPrice }
      if (drawingDragRafRef.current === null) {
        drawingDragRafRef.current = requestAnimationFrame(() => {
          drawingDragRafRef.current = null
          if (drawingDragRef.current) {
            setEditingDrawing(drawingDragRef.current.current)
          }
          if (pendingHoverRef.current) {
            updateActiveIndex(pendingHoverRef.current.index)
            setHoverPrice(pendingHoverRef.current.price)
          }
        })
      }
      return
    }

    if (drawingMode === 'cursor' && moveDragPan(event.clientX)) {
      return
    }

    if (
      drawingMode === 'measure' &&
      measureRange &&
      !measureRange.locked &&
      displayCandles[clampedIdx]
    ) {
      updateActiveIndex(clampedIdx)
      setHoverPrice(resolvedPrice)
      setMeasureRange({
        ...measureRange,
        end: {
          index: clampedIdx,
          time: displayCandles[clampedIdx].time,
          price: resolvedPrice,
        },
      })
      return
    }

    pendingHoverRef.current = { index: clampedIdx, price: resolvedPrice }
    if (hoverRafRef.current === null) {
      hoverRafRef.current = requestAnimationFrame(() => {
        hoverRafRef.current = null
        const next = pendingHoverRef.current
        if (!next) return
        updateActiveIndex(next.index)
        setHoverPrice(next.price)
      })
    }
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button === 2) return
    if (contextMenu) setContextMenu(null)
    if (slot <= 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const relX = event.clientX - rect.left - MARGIN.left
    const relY = event.clientY - rect.top
    const index = Math.min(lastIndex, Math.max(0, Math.floor(relX / slot)))
    const clickedCandle = displayCandles[index]
    const clickedPrice = resolvePointerPrice(index, relY)

    if (drawingMode === 'measure' && clickedCandle) {
      updateActiveIndex(index)
      setHoverPrice(clickedPrice)
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
      cancelWheelPan()
      const svgX = event.clientX - rect.left
      const svgY = relY
      if (activePointersRef.current.size === 0) {
        const hit = hitTestDrawings(
          renderedDrawings,
          svgX,
          svgY,
          {
            xOfTime,
            yOfPrice: yOf,
            plotLeft: MARGIN.left,
            plotRight: MARGIN.left + plotWidth,
            plotTop: MARGIN.top,
            plotBottom: yBottom,
          },
          selectedDrawingId,
        )
        if (hit) {
          onSelectDrawing?.(hit.drawingId)
          const targetDrawing = renderedDrawings.find(
            (d) => d.id === hit.drawingId,
          )
          if (targetDrawing && !targetDrawing.locked && onUpdateDrawing) {
            trySetPointerCapture(event.currentTarget, event.pointerId)
            drawingDragRef.current = {
              origin: targetDrawing,
              part: hit.part,
              startTime: timeOfX(relX),
              startPrice: priceOfY(relY),
              current: targetDrawing,
              hasMoved: false,
            }
          }
          return
        }
        if (selectedDrawingId) {
          onSelectDrawing?.(null)
        }
      }

      trySetPointerCapture(event.currentTarget, event.pointerId)
      activePointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      })
      if (activePointersRef.current.size === 2) {
        const pts = Array.from(activePointersRef.current.values())
        pinchRef.current = {
          startDist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
          accumZoom: 0,
        }
        abortDragPan()
        return
      }
      startDragPan(event.clientX)
      return
    }

    updateActiveIndex(index)
    setHoverPrice(clickedPrice)

    if (!onAddDrawing || !clickedCandle) return
    const now = Date.now()

    if (drawingMode === 'horizontal') {
      const created: ChartDrawing = {
        id: createDrawingId(),
        type: 'horizontal',
        pair,
        interval,
        createdAt: now,
        updatedAt: now,
        price: clickedPrice,
        label: `S/R ${formatPrice(clickedPrice)}`,
      }
      onAddDrawing(created)
      onSelectDrawing?.(created.id)
      return
    }

    if (drawingMode === 'trendline' || drawingMode === 'fib') {
      if (!draftAnchor) {
        setDraftAnchor({ time: clickedCandle.time, price: clickedPrice })
      } else {
        const created: ChartDrawing =
          drawingMode === 'trendline'
            ? {
                id: createDrawingId(),
                type: 'trendline',
                pair,
                interval,
                createdAt: now,
                updatedAt: now,
                t1: draftAnchor.time,
                p1: draftAnchor.price,
                t2: clickedCandle.time,
                p2: clickedPrice,
              }
            : {
                id: createDrawingId(),
                type: 'fib',
                pair,
                interval,
                createdAt: now,
                updatedAt: now,
                t1: draftAnchor.time,
                p1: draftAnchor.price,
                t2: clickedCandle.time,
                p2: clickedPrice,
              }
        onAddDrawing(created)
        onSelectDrawing?.(created.id)
        setDraftAnchor(null)
      }
    }
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    tryReleasePointerCapture(event.currentTarget, event.pointerId)
    if (drawingDragRef.current) {
      if (drawingDragRafRef.current !== null) {
        cancelAnimationFrame(drawingDragRafRef.current)
        drawingDragRafRef.current = null
      }
      const drag = drawingDragRef.current
      drawingDragRef.current = null
      setEditingDrawing(null)
      if (drag.hasMoved && onUpdateDrawing) {
        onUpdateDrawing(drag.current)
      }
      return
    }
    activePointersRef.current.delete(event.pointerId)
    if (activePointersRef.current.size < 2) {
      pinchRef.current = null
    }
    if (activePointersRef.current.size === 0) {
      endDragPan()
    }
  }

  function handlePointerLeave() {
    if (hoverRafRef.current !== null) {
      cancelAnimationFrame(hoverRafRef.current)
      hoverRafRef.current = null
    }
    pendingHoverRef.current = null
    activePointersRef.current.clear()
    pinchRef.current = null
    abortDragPan()
    updateActiveIndex(null)
    setHoverPrice(null)
  }

  const entryLine = orderLines.find((o) => o.kind === 'entry')
  const tpLine = orderLines.find((o) => o.kind === 'tp')
  const slLine = orderLines.find((o) => o.kind === 'sl')
  const livePriceInView =
    effectiveLastPrice !== null &&
    effectiveLastPrice >= yMin &&
    effectiveLastPrice <= yMax
  const isLiveStreamActive = streamStatus === 'ws'
  const liveDiffersFromVisibleClose = Boolean(
    effectiveLastPrice !== null &&
      lastCandle &&
      Math.abs(effectiveLastPrice - lastCandle.close) >
        Math.max(1e-6, Math.abs(effectiveLastPrice) * 1e-5),
  )

  const effectiveCrosshairPrice =
    activeIndex !== null ? (hoverPrice ?? shown.close) : null

  const axisTagPositions = (() => {
    const inputs: AxisTagInput[] = []
    if (effectiveCrosshairPrice !== null) {
      inputs.push({
        id: 'crosshair',
        y: yOf(effectiveCrosshairPrice),
        priority: 100,
      })
    }
    if (effectiveLastPrice !== null && livePriceInView) {
      inputs.push({ id: 'last', y: yOf(effectiveLastPrice), priority: 90 })
    }
    for (const ord of orderLines) {
      if (ord.price < yMin || ord.price > yMax) continue
      const priority =
        ord.kind === 'entry'
          ? 70
          : ord.kind === 'tp'
            ? 60
            : ord.kind === 'sl'
              ? 55
              : 50
      inputs.push({ id: `ord-${ord.id}`, y: yOf(ord.price), priority })
    }
    for (const alert of visibleAlerts) {
      const priority =
        highlightedAlertId === alert.id
          ? 65
          : alert.enabled && !alert.triggeredAt
            ? 45
            : 35
      inputs.push({ id: `alert-${alert.id}`, y: yOf(alert.price), priority })
    }
    return resolveAxisTagPositions(inputs, MARGIN.top + 9, yBottom - 9, 19, 22)
  })()

  function makeDrawingKeyDown(drawingId: string) {
    return (e: ReactKeyboardEvent<SVGGElement>) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        e.stopPropagation()
        onRemoveDrawing?.(drawingId)
        onSelectDrawing?.(null)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onSelectDrawing?.(null)
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onSelectDrawing?.(drawingId)
      }
    }
  }

  return (
    <div
      className={cn(
        compactHeader ? 'chart !px-2 !py-1.5' : 'chart',
        fillHeight && 'chart--workspace',
      )}
      ref={containerRef}
    >
      <div className="chart__canvas-wrap" ref={canvasWrapRef}>
        {/* Collapsible in-plot OHLC + indicator legend overlay */}
        <div
          className={cn(
            'chart__hud',
            legendCollapsed && 'chart__hud--collapsed',
          )}
        >
          <div className="chart__hud-row">
            <button
              type="button"
              className="chart__hud-toggle"
              onClick={() => setLegendCollapsed((v) => !v)}
              aria-expanded={!legendCollapsed}
              aria-label={
                legendCollapsed
                  ? t('chart.legendToggleShow')
                  : t('chart.legendToggleHide')
              }
              title={
                legendCollapsed
                  ? t('chart.legendToggleShow')
                  : t('chart.legendToggleHide')
              }
            >
              {legendCollapsed ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronUp className="size-3" />
              )}
              {legendCollapsed && (
                <span>
                  {formatPrice(shown.close)}
                  {overlays.length > 0 ? ` · ${overlays.length}` : ''}
                </span>
              )}
            </button>

            {!legendCollapsed && (
              <>
                {candleStyle === 'heikin-ashi' && (
                  <span className="rounded bg-secondary px-1 py-0 text-[9px] font-semibold text-secondary-foreground">
                    HA
                  </span>
                )}
                <span>O {formatPrice(shown.open)}</span>
                <span>H {formatPrice(shown.high)}</span>
                <span>L {formatPrice(shown.low)}</span>
                <span>
                  C{' '}
                  <strong
                    className={
                      shown.close >= shown.open
                        ? 'chart__ohlc--pos'
                        : 'chart__ohlc--neg'
                    }
                  >
                    {formatPrice(shown.close)}
                  </strong>
                </span>
                <span className={changeClass(change)}>
                  {change > 0 ? '+' : ''}
                  {formatPercent(change, 2)}
                </span>
                <span className="hidden sm:inline chart__ohlc-vol">
                  V {shown.volume.toFixed(1)}
                </span>
                <span className="hidden md:inline text-[var(--text-subtle)]">
                  {formatDateTime(shown.time, locale)} UTC
                </span>
              </>
            )}
          </div>

          {!legendCollapsed && (overlays.length > 0 || signals.length > 0) && (
            <div className="chart__hud-legend">
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
                        {formatPrice(valAtCursor)}
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
        </div>

        {draftAnchor && (
          <div className="chart__drawing-hint" role="status">
            <span>{t('chart.draftPointHint')}</span>
            <button
              type="button"
              className="chart__drawing-cancel"
              onClick={() => setDraftAnchor(null)}
            >
              {t('chart.cancel')}
            </button>
          </div>
        )}
        {drawingMode === 'measure' && !measureRange && (
          <div className="chart__drawing-hint" role="status">
            <span>{t('chart.measureHint')}</span>
          </div>
        )}
        {drawingMode === 'cursor' && !draftAnchor && selectedDrawingId && (
          <div className="chart__drawing-hint" role="status">
            <span>{t('studio.drawingSelectedHint')}</span>
            {onRemoveDrawing && (
              <button
                type="button"
                className="chart__drawing-cancel"
                onClick={() => {
                  onRemoveDrawing(selectedDrawingId)
                  onSelectDrawing?.(null)
                }}
              >
                {t('studio.deleteSelected')}
              </button>
            )}
          </div>
        )}

        {contextMenu && (
          <div
            ref={contextMenuRef}
            role="menu"
            aria-label={t('studio.ctxPriceHeader', {
              price: formatPrice(contextMenu.price),
            })}
            className="chart__context-menu"
            style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          >
            <div className="chart__context-menu-header">
              <span>
                {t('studio.ctxPriceHeader', {
                  price: formatPrice(contextMenu.price),
                })}
              </span>
            </div>
            {onCreateAlertAtPrice && (
              <button
                type="button"
                role="menuitem"
                className="chart__context-menu-item"
                onClick={() => {
                  onCreateAlertAtPrice(contextMenu.price)
                  setContextMenu(null)
                }}
              >
                <BellPlus className="size-3.5 text-[var(--chart-alert)]" />
                <span>
                  {t('studio.ctxAddAlert', {
                    price: formatPrice(contextMenu.price),
                  })}
                </span>
              </button>
            )}
            {onPrefillOrderAtPrice && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="chart__context-menu-item"
                  onClick={() => {
                    onPrefillOrderAtPrice('buy', contextMenu.price)
                    setContextMenu(null)
                  }}
                >
                  <ArrowUpRight className="size-3.5 text-[var(--positive)]" />
                  <span>
                    {t('studio.ctxPrefillLong', {
                      price: formatPrice(contextMenu.price),
                    })}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="chart__context-menu-item"
                  onClick={() => {
                    onPrefillOrderAtPrice('sell', contextMenu.price)
                    setContextMenu(null)
                  }}
                >
                  <ArrowDownRight className="size-3.5 text-[var(--negative)]" />
                  <span>
                    {t('studio.ctxPrefillShort', {
                      price: formatPrice(contextMenu.price),
                    })}
                  </span>
                </button>
                <p className="chart__context-menu-note">
                  {t('studio.ctxPrefillNote')}
                </p>
              </>
            )}
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
            height={effectiveHeight}
            viewBox={`0 0 ${width} ${effectiveHeight}`}
            role="img"
            aria-label={description}
            onPointerMove={handlePointerMove}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onPointerLeave={handlePointerLeave}
            onContextMenu={handleContextMenu}
            onDoubleClick={() => {
              if (drawingMode === 'cursor' && !selectedDrawingId) onResetView?.()
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

            <rect
              className="chart__plot-bg"
              x={MARGIN.left}
              y={MARGIN.top}
              width={plotWidth}
              height={Math.max(0, plotHeight)}
            />

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
                    y={effectiveHeight - 8}
                    textAnchor="middle"
                  >
                    {formatAxisTick(displayCandles[idx].time, spanMs, locale)}
                  </text>
                </g>
              )
            })}

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
              {activeIndex !== null && slot > 0 && (
                <rect
                  className="chart__active-col"
                  x={MARGIN.left + shownIndex * slot}
                  y={MARGIN.top}
                  width={slot}
                  height={plotHeight}
                />
              )}

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

              <g ref={panLayerRef} className="chart__pan-layer">
                {bbPolygonPoints && (
                  <polygon className="chart__bb-band" points={bbPolygonPoints} />
                )}

                {batchedSeries.volUp && (
                  <path
                    className="chart__vol chart__vol--up"
                    d={batchedSeries.volUp}
                  />
                )}
                {batchedSeries.volDown && (
                  <path
                    className="chart__vol chart__vol--down"
                    d={batchedSeries.volDown}
                  />
                )}

                {volSmaPoints && (
                  <polyline className="chart__vol-sma" points={volSmaPoints} />
                )}

                {batchedSeries.wickUp && (
                  <path
                    className="candle__wick--up"
                    d={batchedSeries.wickUp}
                  />
                )}
                {batchedSeries.wickDown && (
                  <path
                    className="candle__wick--down"
                    d={batchedSeries.wickDown}
                  />
                )}
                {batchedSeries.bodyUp && (
                  <path
                    className={
                      candleStyle === 'hollow'
                        ? 'candle__body--up-hollow'
                        : 'candle__body--up'
                    }
                    d={batchedSeries.bodyUp}
                  />
                )}
                {batchedSeries.bodyDown && (
                  <path
                    className="candle__body--down"
                    d={batchedSeries.bodyDown}
                  />
                )}

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

                {batchedSeries.overlayLines.map((overlay) => (
                  <polyline
                    key={overlay.id}
                    className={`overlay overlay--${overlay.kind}`}
                    points={overlay.points}
                  />
                ))}

                {anchoredDrawings.map((d) => {
                  const isSelected = selectedDrawingId === d.id
                  const handleDrawingKeyDown = makeDrawingKeyDown(d.id)

                  if (d.type === 'trendline') {
                    const x1 = xOfTime(d.t1)
                    const x2 = xOfTime(d.t2)
                    if (x1 === null || x2 === null) return null
                    if (
                      Math.max(x1, x2) < MARGIN.left - PAN_OVERSCAN_LIMIT * slot ||
                      Math.min(x1, x2) >
                        MARGIN.left + plotWidth + PAN_OVERSCAN_LIMIT * slot
                    ) {
                      return null
                    }
                    const y1 = yOf(d.p1)
                    const y2 = yOf(d.p2)
                    const pctDiff = d.p1 !== 0 ? ((d.p2 - d.p1) / d.p1) * 100 : 0
                    const midX = (x1 + x2) / 2
                    const midY = (y1 + y2) / 2
                    return (
                      <g
                        key={d.id}
                        tabIndex={0}
                        role="button"
                        aria-label={`Trendline ${formatPrice(d.p1)} – ${formatPrice(d.p2)}`}
                        aria-pressed={isSelected}
                        onFocus={() => onSelectDrawing?.(d.id)}
                        onKeyDown={handleDrawingKeyDown}
                        className={cn(
                          'chart__drawing-tl chart__drawing-item',
                          isSelected && 'chart__drawing--selected',
                        )}
                      >
                        <line
                          className="chart__drawing-line"
                          x1={x1}
                          y1={y1}
                          x2={x2}
                          y2={y2}
                        />
                        <circle
                          className={cn(
                            'chart__drawing-handle',
                            isSelected && 'chart__drawing-handle--selected',
                          )}
                          cx={x1}
                          cy={y1}
                          r={isSelected ? 5 : 3.5}
                        />
                        <circle
                          className={cn(
                            'chart__drawing-handle',
                            isSelected && 'chart__drawing-handle--selected',
                          )}
                          cx={x2}
                          cy={y2}
                          r={isSelected ? 5 : 3.5}
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
                              if (isSelected) onSelectDrawing?.(null)
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
                      Math.max(x1, x2) < MARGIN.left - PAN_OVERSCAN_LIMIT * slot ||
                      Math.min(x1, x2) >
                        MARGIN.left + plotWidth + PAN_OVERSCAN_LIMIT * slot
                    ) {
                      return null
                    }
                    const leftX = Math.max(MARGIN.left, Math.min(x1, x2))
                    const rightX = Math.min(
                      MARGIN.left + plotWidth,
                      Math.max(x1, x2, leftX + 75),
                    )
                    const y1 = yOf(d.p1)
                    const y2 = yOf(d.p2)
                    const topY = Math.min(y1, y2)
                    return (
                      <g
                        key={d.id}
                        tabIndex={0}
                        role="button"
                        aria-label={`Fibonacci ${formatPrice(d.p1)} – ${formatPrice(d.p2)}`}
                        aria-pressed={isSelected}
                        onFocus={() => onSelectDrawing?.(d.id)}
                        onKeyDown={handleDrawingKeyDown}
                        className={cn(
                          'chart__drawing-fib chart__drawing-item',
                          isSelected && 'chart__drawing--selected',
                        )}
                      >
                        <rect
                          className="chart__drawing-zone-fib"
                          x={leftX}
                          y={topY}
                          width={Math.max(2, rightX - leftX)}
                          height={Math.abs(y2 - y1)}
                        />
                        {isSelected && (
                          <line
                            className="chart__drawing-fib-guide"
                            x1={x1}
                            y1={y1}
                            x2={x2}
                            y2={y2}
                          />
                        )}
                        {DRAWING_FIB_LEVELS.map((lvl) => {
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
                        {isSelected && (
                          <>
                            <circle
                              className="chart__drawing-handle chart__drawing-handle--selected"
                              cx={x1}
                              cy={y1}
                              r={5}
                            />
                            <circle
                              className="chart__drawing-handle chart__drawing-handle--selected"
                              cx={x2}
                              cy={y2}
                              r={5}
                            />
                          </>
                        )}
                        {onRemoveDrawing && (
                          <g
                            className="chart__drawing-delete"
                            onPointerDown={(e) => {
                              e.stopPropagation()
                              onRemoveDrawing(d.id)
                              if (isSelected) onSelectDrawing?.(null)
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
                          : Math.min(
                              yBottom - 22,
                              measureData.topY + measureData.rectH + 6,
                            )
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
              </g>

              {horizontalDrawings.map((d) => {
                if (d.type !== 'horizontal') return null
                if (d.price < yMin || d.price > yMax) return null
                const isSelected = selectedDrawingId === d.id
                const y = yOf(d.price)
                return (
                  <g
                    key={d.id}
                    tabIndex={0}
                    role="button"
                    aria-label={d.label}
                    aria-pressed={isSelected}
                    onFocus={() => onSelectDrawing?.(d.id)}
                    onKeyDown={makeDrawingKeyDown(d.id)}
                    className={cn(
                      'chart__drawing-hz chart__drawing-item',
                      isSelected && 'chart__drawing--selected',
                    )}
                  >
                    <line
                      className="chart__drawing-line--sr"
                      x1={MARGIN.left}
                      x2={MARGIN.left + plotWidth}
                      y1={y}
                      y2={y}
                    />
                    {isSelected && (
                      <>
                        <circle
                          className="chart__drawing-handle chart__drawing-handle--selected"
                          cx={MARGIN.left + plotWidth * 0.25}
                          cy={y}
                          r={4.5}
                        />
                        <circle
                          className="chart__drawing-handle chart__drawing-handle--selected"
                          cx={MARGIN.left + plotWidth * 0.75}
                          cy={y}
                          r={4.5}
                        />
                      </>
                    )}
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
                          if (isSelected) onSelectDrawing?.(null)
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
              })}

              {/* Client-only Price Alert markers (visually distinct from order lines) */}
              {visibleAlerts.map((alert) => {
                const y = yOf(alert.price)
                const isTriggered = alert.triggeredAt !== undefined
                const isPaused = !alert.enabled
                const isHighlighted = highlightedAlertId === alert.id
                const dx = MARGIN.left + 8
                return (
                  <g
                    key={`alert-line-${alert.id}`}
                    pointerEvents="none"
                    className={cn(
                      'chart__alert',
                      isTriggered && 'chart__alert--triggered',
                      isPaused && 'chart__alert--paused',
                      isHighlighted && 'chart__alert--highlighted',
                    )}
                  >
                    <line
                      className="chart__alert-line"
                      x1={MARGIN.left}
                      x2={MARGIN.left + plotWidth}
                      y1={y}
                      y2={y}
                    />
                    <polygon
                      className="chart__alert-diamond"
                      points={`${dx},${y - 4} ${dx + 4},${y} ${dx},${y + 4} ${dx - 4},${y}`}
                    />
                  </g>
                )
              })}

              {effectiveLastPrice !== null && livePriceInView && (
                <line
                  className={`chart__last-price-line ${
                    effectiveLastIsUp
                      ? 'chart__last-price-line--up'
                      : 'chart__last-price-line--down'
                  }`}
                  x1={MARGIN.left}
                  x2={MARGIN.left + plotWidth}
                  y1={yOf(effectiveLastPrice)}
                  y2={yOf(effectiveLastPrice)}
                />
              )}

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

              {activeIndex !== null && (
                <g pointerEvents="none">
                  <line
                    className="chart__cursor"
                    x1={xOf(shownIndex)}
                    x2={xOf(shownIndex)}
                    y1={MARGIN.top}
                    y2={yBottom}
                  />
                  {effectiveCrosshairPrice !== null && (
                    <line
                      className="chart__cursor chart__cursor--horizontal"
                      x1={MARGIN.left}
                      x2={MARGIN.left + plotWidth}
                      y1={yOf(effectiveCrosshairPrice)}
                      y2={yOf(effectiveCrosshairPrice)}
                    />
                  )}
                  {magnetSnap &&
                    (drawingMode !== 'cursor' || editingDrawing !== null) &&
                    hoverPrice !== null && (
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

            {visibleAlerts.map((alert) => {
              const resolvedY = axisTagPositions.get(`alert-${alert.id}`)
              if (resolvedY === undefined) return null
              const isTriggered = alert.triggeredAt !== undefined
              const isPaused = !alert.enabled
              const prefix = alert.direction === 'above' ? '▲' : '▼'
              return (
                <g
                  key={`alert-pill-${alert.id}`}
                  className={cn(
                    'chart__alert',
                    isTriggered && 'chart__alert--triggered',
                    isPaused && 'chart__alert--paused',
                  )}
                >
                  <rect
                    className="chart__alert-pill"
                    x={MARGIN.left + plotWidth + 4}
                    y={resolvedY - 9}
                    width={MARGIN.right - 8}
                    height={18}
                    rx={3}
                  />
                  <text
                    className="chart__alert-pill-text"
                    x={MARGIN.left + plotWidth + 8}
                    y={resolvedY}
                    dominantBaseline="middle"
                  >
                    {prefix} {formatPrice(alert.price)}
                  </text>
                </g>
              )
            })}

            {orderLines.map((ord) => {
              const resolvedY = axisTagPositions.get(`ord-${ord.id}`)
              if (resolvedY === undefined) return null
              return (
                <g
                  key={`pill-${ord.id}`}
                  className={`chart__order chart__order--${ord.kind}`}
                >
                  <rect
                    className="chart__order-pill"
                    x={MARGIN.left + plotWidth + 4}
                    y={resolvedY - 9}
                    width={MARGIN.right - 8}
                    height={18}
                    rx={3}
                  />
                  <text
                    className="chart__order-pill-text"
                    x={MARGIN.left + plotWidth + 8}
                    y={resolvedY}
                    dominantBaseline="middle"
                  >
                    {ord.badge}
                  </text>
                </g>
              )
            })}

            {effectiveLastPrice !== null &&
              livePriceInView &&
              axisTagPositions.has('last') &&
              (() => {
                const lastTagY = axisTagPositions.get('last')!
                const useStaticStyle =
                  streamStatus === 'off' && !liveDiffersFromVisibleClose
                return (
                  <g>
                    <rect
                      className={
                        useStaticStyle
                          ? 'chart__axis-pill--static'
                          : `chart__axis-pill ${
                              effectiveLastIsUp
                                ? 'chart__axis-pill--up'
                                : 'chart__axis-pill--down'
                            }`
                      }
                      x={MARGIN.left + plotWidth + 4}
                      y={lastTagY - 9}
                      width={MARGIN.right - 8}
                      height={18}
                      rx={3}
                    />
                    <text
                      className={
                        useStaticStyle
                          ? 'chart__axis-pill-text--static'
                          : 'chart__axis-pill-text'
                      }
                      x={MARGIN.left + plotWidth + 8}
                      y={lastTagY}
                      dominantBaseline="middle"
                    >
                      {formatPrice(effectiveLastPrice)}
                    </text>
                    {(liveDiffersFromVisibleClose || !isLiveStreamActive) && (
                      <title>
                        {isLiveStreamActive
                          ? `${t('chart.liveTradeTag')}: ${formatPrice(effectiveLastPrice)}`
                          : `${t('chart.closedBarTag')}: ${formatPrice(effectiveLastPrice)}`}
                      </title>
                    )}
                  </g>
                )
              })()}

            {effectiveCrosshairPrice !== null &&
              axisTagPositions.has('crosshair') &&
              (() => {
                const hoverTagY = axisTagPositions.get('crosshair')!
                return (
                  <g>
                    <rect
                      className="chart__axis-pill--crosshair"
                      x={MARGIN.left + plotWidth + 4}
                      y={hoverTagY - 9}
                      width={MARGIN.right - 8}
                      height={18}
                      rx={3}
                    />
                    <text
                      className="chart__axis-pill-text--crosshair"
                      x={MARGIN.left + plotWidth + 8}
                      y={hoverTagY}
                      dominantBaseline="middle"
                    >
                      {formatPrice(effectiveCrosshairPrice)}
                    </text>
                  </g>
                )
              })()}

            <text
              className="chart__label"
              x={MARGIN.left}
              y={effectiveHeight - 8}
              textAnchor="start"
            >
              {fromText}
            </text>
            <text
              className="chart__label"
              x={MARGIN.left + plotWidth}
              y={effectiveHeight - 8}
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

        <div
          className="absolute bottom-[34px] left-1/2 z-[4] inline-flex -translate-x-1/2 items-center gap-0.5 rounded-md bg-card/95 px-1.5 py-1 opacity-90 transition-opacity hover:opacity-100"
          role="toolbar"
          aria-label={t('chart.navControlsAria')}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => onPanDelta?.(Math.max(4, Math.round(count * 0.14)))}
                aria-label={t('chart.panLeft')}
              >
                <ChevronLeft className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('chart.panLeftTip')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => onZoomDelta?.(Math.max(4, Math.round(count * 0.16)))}
                aria-label={t('chart.zoomOut')}
              >
                <ZoomOut className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('chart.zoomOutTip')}</TooltipContent>
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
                aria-label={t('chart.zoomIn')}
              >
                <ZoomIn className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('chart.zoomInTip')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => onPanDelta?.(-Math.max(4, Math.round(count * 0.14)))}
                aria-label={t('chart.panRight')}
              >
                <ChevronRight className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('chart.panRightTip')}</TooltipContent>
          </Tooltip>

          <span className="mx-0.5 h-3.5 w-1" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => onResetView?.()}
                aria-label={t('chart.resetView')}
              >
                <RotateCcw className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('chart.resetViewTip')}</TooltipContent>
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
                    ? 'bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary'
                    : 'text-muted-foreground',
                )}
              >
                <Mouse className="size-3" />
                <span>
                  {wheelZoomLocked ? t('chart.wheelOn') : t('chart.wheelOff')}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {wheelZoomLocked ? t('chart.wheelOnTip') : t('chart.wheelOffTip')}
            </TooltipContent>
          </Tooltip>

          {canJumpLive && onJumpLive && (
            <Button
              type="button"
              variant="default"
              size="xs"
              onClick={onJumpLive}
              className="ml-0.5 h-6 px-2 font-mono text-[10px]"
            >
              <span>{t('studio.jumpLive')}</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

export default memo(CandleChart)
