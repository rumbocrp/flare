import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getBotStatus,
  submitDemoOrderOnServer,
  subscribeToBotStream,
  type BotServerSnapshot,
} from '../api/botClient'
import CandleChart from './CandleChart'
import MacdPanel from './MacdPanel'
import RsiPanel from './RsiPanel'
import SignalsTable from './SignalsTable'
import StudioSidebar from './StudioSidebar'
import {
  Crosshair,
  Layers,
  Magnet,
  Maximize2,
  Minimize2,
  Minus,
  PanelRight,
  RotateCcw,
  Ruler,
  SlidersHorizontal,
  Trash2,
  TrendingUp,
  Undo2,
  Zap,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { StrategyPreset } from '../botEngine'
import { formatPrice } from '../format'
import {
  atr,
  bollingerBands,
  ema,
  macd,
  rsi,
  sma,
  toHeikinAshi,
  vwap,
} from '../indicators'
import type { LiveStreamStatus } from '../market/liveStream'
import { RSI_PERIOD, crossoverSignals } from '../signals'
import { availablePairs } from '../strategy'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import { useI18n } from '../i18n'
import type {
  Candle,
  CandleStyleMode,
  ChartDrawing,
  ChartOrderLine,
  ChartOverlay,
  DrawingToolMode,
  Interval,
  PageId,
  SignalParams,
  Strategy,
} from '../types'

const DRAWINGS_STORAGE_KEY = 'lixtrd:chart-drawings-by-pair'

type DrawingsByPair = Record<string, ChartDrawing[]>

function isDrawingsByPair(value: unknown): value is DrawingsByPair {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type StudioPrefs = {
  candleStyle: CandleStyleMode
  magnetSnap: boolean
  showFastSlow: boolean
  showEma50: boolean
  showEma200: boolean
  showBollinger: boolean
  showVwap: boolean
  showVolumeSma: boolean
  showSignals: boolean
  showOrderLines: boolean
  showRsi: boolean
  showMacd: boolean
  showRightPanel: boolean
}

const DEFAULT_STUDIO_PREFS: StudioPrefs = {
  candleStyle: 'candles',
  magnetSnap: true,
  showFastSlow: true,
  showEma50: true,
  showEma200: false,
  showBollinger: true,
  showVwap: false,
  showVolumeSma: true,
  showSignals: true,
  showOrderLines: true,
  showRsi: true,
  showMacd: true,
  showRightPanel: true,
}

const VALID_CANDLE_STYLES: CandleStyleMode[] = [
  'candles',
  'hollow',
  'heikin-ashi',
]

function isStudioPrefs(value: unknown): value is StudioPrefs {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Record<string, unknown>
  return (
    typeof c.candleStyle === 'string' &&
    VALID_CANDLE_STYLES.includes(c.candleStyle as CandleStyleMode) &&
    typeof c.magnetSnap === 'boolean' &&
    typeof c.showFastSlow === 'boolean' &&
    typeof c.showEma50 === 'boolean' &&
    typeof c.showEma200 === 'boolean' &&
    typeof c.showBollinger === 'boolean' &&
    typeof c.showVwap === 'boolean' &&
    typeof c.showVolumeSma === 'boolean' &&
    typeof c.showSignals === 'boolean' &&
    typeof c.showOrderLines === 'boolean' &&
    typeof c.showRsi === 'boolean' &&
    typeof c.showMacd === 'boolean' &&
    typeof c.showRightPanel === 'boolean'
  )
}

type MarketAnalysisProps = {
  candles: Candle[]
  params: SignalParams
  pair?: string
  timeframe?: Interval
  onSelectPair?: (pair: string) => void
  onSelectTimeframe?: (tf: Interval) => void
  onChangeParams?: (next: SignalParams) => void
  strategy?: Strategy
  onSaveStrategy?: (next: Strategy) => void
  onNavigate?: (page: PageId) => void
  streamStatus?: LiveStreamStatus
  lastTickAt?: number | null
  chartHeight?: number
  defaultWheelZoomLocked?: boolean
  compact?: boolean
}

const ZOOM_PRESETS = [35, 75, 140, 240, 310] as const

function MarketAnalysis({
  candles,
  params,
  pair = 'BTC/USDT',
  timeframe = '1h',
  onSelectPair,
  onSelectTimeframe,
  onChangeParams,
  strategy,
  onSaveStrategy,
  streamStatus,
  chartHeight = 320,
  defaultWheelZoomLocked = false,
  compact = false,
}: MarketAnalysisProps) {
  const { t, language } = useI18n()
  const isEs = language === 'es'

  // Reserve the first 50 bars of the 360-candle spectrum as warm-up buffer
  // so SMA, EMA, EMA-50, and RSI-14 never start cut off or null on the left edge.
  const warmupBars = useMemo(
    () => (candles.length > 90 ? 50 : Math.min(20, Math.floor(candles.length / 4))),
    [candles.length],
  )
  const navigableTotal = Math.max(20, candles.length - warmupBars)

  const [prefs, setPrefs] = useLocalStorageState<StudioPrefs>(
    'flare:chart-studio-prefs',
    DEFAULT_STUDIO_PREFS,
    isStudioPrefs,
  )
  const [isExpanded, setIsExpanded] = useState(false)
  const [zoomCount, setZoomCount] = useState<number>(110)
  const [panOffset, setPanOffset] = useState<number>(0)
  const [drawingMode, setDrawingMode] = useState<DrawingToolMode>('cursor')
  const [orderSide, setOrderSide] = useState<'buy' | 'sell'>('buy')
  const [orderSizeUsd, setOrderSizeUsd] = useState<number>(250)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [botSnapshot, setBotSnapshot] = useState<BotServerSnapshot | null>(null)
  const [orderFeedback, setOrderFeedback] = useState<string | null>(null)
  const [submittingOrder, setSubmittingOrder] = useState(false)
  const [expandedStackHeight, setExpandedStackHeight] = useState<number>(560)
  const expandedStackRef = useRef<HTMLDivElement | null>(null)

  const showFastSlow = prefs.showFastSlow
  const showEma50 = prefs.showEma50
  const showEma200 = prefs.showEma200
  const showBollinger = prefs.showBollinger
  const showVwap = prefs.showVwap
  const showVolumeSma = prefs.showVolumeSma
  const showSignals = prefs.showSignals
  const showOrderLines = prefs.showOrderLines
  const showRsi = prefs.showRsi
  const showMacd = prefs.showMacd
  const showRightPanel = prefs.showRightPanel
  const candleStyle = prefs.candleStyle
  const magnetSnap = prefs.magnetSnap

  const updatePref = useCallback(
    <K extends keyof StudioPrefs>(key: K, value: StudioPrefs[K]) => {
      setPrefs((prev) => ({ ...prev, [key]: value }))
    },
    [setPrefs],
  )

  useEffect(() => {
    if (!isExpanded) return undefined
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevOverflow
    }
  }, [isExpanded])

  useEffect(() => {
    let popupOpenAtKeyDown = false
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        popupOpenAtKeyDown = Boolean(
          document.querySelector(
            '[data-slot="popover-content"], [data-slot="select-content"], [data-radix-popper-content-wrapper], [role="listbox"]',
          ),
        )
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (
        tag === 'INPUT' ||
        tag === 'SELECT' ||
        tag === 'TEXTAREA' ||
        target?.isContentEditable
      ) {
        return
      }
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        setIsExpanded((v) => !v)
      } else if (e.key === 'Escape') {
        if (popupOpenAtKeyDown || e.defaultPrevented) {
          popupOpenAtKeyDown = false
          return
        }
        if (drawingMode !== 'cursor') {
          e.preventDefault()
          setDrawingMode('cursor')
          return
        }
        if (isExpanded) {
          e.preventDefault()
          setIsExpanded(false)
        }
      }
    }
    window.addEventListener('keydown', onKeyDownCapture, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDownCapture, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [isExpanded, drawingMode])

  useEffect(() => {
    if (!isExpanded) return undefined
    const el = expandedStackRef.current
    if (!el) return undefined
    const updateHeight = () => {
      setExpandedStackHeight(Math.max(320, Math.floor(el.clientHeight)))
    }
    updateHeight()
    const observer = new ResizeObserver(() => updateHeight())
    observer.observe(el)
    return () => observer.disconnect()
  }, [isExpanded])

  const [drawingsByPair, setDrawingsByPair] =
    useLocalStorageState<DrawingsByPair>(
      DRAWINGS_STORAGE_KEY,
      {},
      isDrawingsByPair,
    )

  useEffect(() => {
    let active = true
    getBotStatus()
      .then((snap) => {
        if (active) setBotSnapshot(snap)
      })
      .catch(() => {})
    const unsubscribe = subscribeToBotStream((snap) => {
      if (active) setBotSnapshot(snap)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  // Clamp zoom and pan whenever candle spectrum updates
  const clampedZoom = Math.min(Math.max(25, zoomCount), navigableTotal)
  const maxPanOffset = Math.max(0, navigableTotal - clampedZoom)
  const clampedPan = Math.min(Math.max(0, panOffset), maxPanOffset)

  const viewEnd = candles.length - clampedPan
  const viewStart = Math.max(warmupBars, viewEnd - clampedZoom)

  // Compute indicators on the FULL candle spectrum first (Zero Warm-up Cut-off)
  const fullAnalysis = useMemo(() => {
    const closes = candles.map((candle) => candle.close)
    const volumes = candles.map((candle) => candle.volume)
    const average = params.average === 'ema' ? ema : sma
    const name = params.average.toUpperCase()

    const fastFull = average(closes, params.fastPeriod)
    const slowFull = average(closes, params.slowPeriod)
    const ema50Full = ema(closes, 50)
    const ema200Full = ema(closes, 200)
    const bbFull = bollingerBands(closes, 20, 2)
    const vwapFull = vwap(candles)
    const volSmaFull = sma(volumes, 20)
    const atrFull = atr(candles, 14)
    const rsiFull = rsi(closes, RSI_PERIOD)
    const macdFull = macd(closes, 12, 26, 9)
    const signalsFull = crossoverSignals(candles, params)

    return {
      name,
      fastFull,
      slowFull,
      ema50Full,
      ema200Full,
      bbFull,
      vwapFull,
      volSmaFull,
      atrFull,
      rsiFull,
      macdFull,
      signalsFull,
    }
  }, [candles, params])

  const displaySourceCandles = useMemo(
    () => (candleStyle === 'heikin-ashi' ? toHeikinAshi(candles) : candles),
    [candleStyle, candles],
  )

  // Slice visible spectrum window [viewStart .. viewEnd]
  const visibleCandles = useMemo(
    () => displaySourceCandles.slice(viewStart, viewEnd),
    [displaySourceCandles, viewStart, viewEnd],
  )

  const visibleOverlays: ChartOverlay[] = useMemo(() => {
    const list: ChartOverlay[] = []
    if (showFastSlow) {
      list.push(
        {
          id: 'fast',
          label: `${fullAnalysis.name} ${params.fastPeriod}`,
          kind: 'fast',
          values: fullAnalysis.fastFull.slice(viewStart, viewEnd),
        },
        {
          id: 'slow',
          label: `${fullAnalysis.name} ${params.slowPeriod}`,
          kind: 'slow',
          values: fullAnalysis.slowFull.slice(viewStart, viewEnd),
        },
      )
    }
    if (showEma50) {
      list.push({
        id: 'ema50',
        label: 'EMA 50',
        kind: 'trend',
        values: fullAnalysis.ema50Full.slice(viewStart, viewEnd),
      })
    }
    if (showEma200) {
      list.push({
        id: 'ema200',
        label: 'EMA 200',
        kind: 'ema200',
        values: fullAnalysis.ema200Full.slice(viewStart, viewEnd),
      })
    }
    if (showBollinger) {
      list.push(
        {
          id: 'bb-upper',
          label: 'BB Hi',
          kind: 'bb-upper',
          values: fullAnalysis.bbFull.upper.slice(viewStart, viewEnd),
        },
        {
          id: 'bb-basis',
          label: 'BB Mid',
          kind: 'bb-basis',
          values: fullAnalysis.bbFull.basis.slice(viewStart, viewEnd),
        },
        {
          id: 'bb-lower',
          label: 'BB Lo',
          kind: 'bb-lower',
          values: fullAnalysis.bbFull.lower.slice(viewStart, viewEnd),
        },
      )
    }
    if (showVwap) {
      list.push({
        id: 'vwap',
        label: 'VWAP Session',
        kind: 'vwap',
        values: fullAnalysis.vwapFull.slice(viewStart, viewEnd),
      })
    }
    return list
  }, [
    fullAnalysis,
    params.fastPeriod,
    params.slowPeriod,
    showBollinger,
    showEma50,
    showEma200,
    showFastSlow,
    showVwap,
    viewEnd,
    viewStart,
  ])

  const visibleVolSma = useMemo(
    () =>
      showVolumeSma ? fullAnalysis.volSmaFull.slice(viewStart, viewEnd) : undefined,
    [fullAnalysis.volSmaFull, showVolumeSma, viewEnd, viewStart],
  )

  const visibleRsi = useMemo(
    () => fullAnalysis.rsiFull.slice(viewStart, viewEnd),
    [fullAnalysis.rsiFull, viewStart, viewEnd],
  )

  const visibleMacd = useMemo(
    () => ({
      macdLine: fullAnalysis.macdFull.macd.slice(viewStart, viewEnd),
      signalLine: fullAnalysis.macdFull.signal.slice(viewStart, viewEnd),
      histogram: fullAnalysis.macdFull.histogram.slice(viewStart, viewEnd),
    }),
    [fullAnalysis.macdFull, viewEnd, viewStart],
  )

  const visibleSignals = useMemo(
    () =>
      showSignals
        ? fullAnalysis.signalsFull
            .filter((s) => s.index >= viewStart && s.index < viewEnd)
            .map((s) => ({
              ...s,
              index: s.index - viewStart,
            }))
        : [],
    [fullAnalysis.signalsFull, showSignals, viewEnd, viewStart],
  )

  const navigableSignals = useMemo(
    () => fullAnalysis.signalsFull.filter((s) => s.index >= warmupBars),
    [fullAnalysis.signalsFull, warmupBars],
  )

  // Build Binance-style Order Lines (Entry, Take Profit, Profit-Lock 50%, Stop Loss)
  const orderLines: ChartOrderLine[] = useMemo(() => {
    if (!showOrderLines || candles.length === 0 || visibleCandles.length === 0) {
      return []
    }

    const lastClose = candles[candles.length - 1].close
    const activeBotPosition = botSnapshot?.state.openPosition
    const hasMatchingBotPos =
      activeBotPosition && activeBotPosition.pair === pair

    const entryPrice = hasMatchingBotPos
      ? activeBotPosition.entryPrice
      : lastClose
    const side: 'buy' | 'sell' = hasMatchingBotPos
      ? activeBotPosition.side
      : orderSide

    const slPct = (strategy?.stopLoss ?? 2.0) / 100
    const tpPct = (strategy?.takeProfit ?? 4.0) / 100

    const tpPrice = hasMatchingBotPos
      ? activeBotPosition.targetPrice
      : side === 'buy'
        ? entryPrice * (1 + tpPct)
        : entryPrice * (1 - tpPct)

    const slPrice = hasMatchingBotPos
      ? activeBotPosition.stopPrice
      : side === 'buy'
        ? entryPrice * (1 - slPct)
        : entryPrice * (1 + slPct)

    const lockPrice =
      side === 'buy'
        ? entryPrice + (tpPrice - entryPrice) * 0.5
        : entryPrice - (entryPrice - tpPrice) * 0.5

    const tpDeltaPct = (((tpPrice - entryPrice) / entryPrice) * 100).toFixed(2)
    const slDeltaPct = (((slPrice - entryPrice) / entryPrice) * 100).toFixed(2)
    const rrRatio = (tpPct / Math.max(0.001, slPct)).toFixed(1)

    return [
      {
        id: 'tp',
        kind: 'tp',
        price: tpPrice,
        badge: `TP ${Number(tpDeltaPct) >= 0 ? '+' : ''}${tpDeltaPct}%`,
        label: `TAKE PROFIT (${Number(tpDeltaPct) >= 0 ? '+' : ''}${tpDeltaPct}% · ${rrRatio}R)`,
      },
      {
        id: 'lock',
        kind: 'lock',
        price: lockPrice,
        badge: 'LOCK 50%',
        label: isEs
          ? 'PROFIT-LOCK 50% TP (Breakeven)'
          : 'PROFIT-LOCK 50% TP (Breakeven)',
      },
      {
        id: 'entry',
        kind: 'entry',
        price: entryPrice,
        badge: side === 'buy' ? 'LONG' : 'SHORT',
        label: hasMatchingBotPos
          ? `BOT ${side === 'buy' ? 'LONG' : 'SHORT'} ACTIVO (${pair})`
          : `BINANCE ${side === 'buy' ? 'LONG' : 'SHORT'} ENTRY (${pair})`,
      },
      {
        id: 'sl',
        kind: 'sl',
        price: slPrice,
        badge: `SL ${Number(slDeltaPct) >= 0 ? '+' : ''}${slDeltaPct}%`,
        label: `STOP LOSS (${Number(slDeltaPct) >= 0 ? '+' : ''}${slDeltaPct}%)`,
      },
    ]
  }, [
    botSnapshot?.state.openPosition,
    candles,
    isEs,
    orderSide,
    pair,
    showOrderLines,
    strategy?.stopLoss,
    strategy?.takeProfit,
    visibleCandles.length,
  ])

  const pairDrawings = useMemo(
    () => drawingsByPair[pair] ?? [],
    [drawingsByPair, pair],
  )

  function handleAddDrawing(drawing: ChartDrawing) {
    const current = drawingsByPair[pair] ?? []
    setDrawingsByPair({
      ...drawingsByPair,
      [pair]: [...current, drawing],
    })
  }

  function handleRemoveDrawing(id: string) {
    const current = drawingsByPair[pair] ?? []
    setDrawingsByPair({
      ...drawingsByPair,
      [pair]: current.filter((d) => d.id !== id),
    })
  }

  function handleUndoDrawing() {
    const current = drawingsByPair[pair] ?? []
    if (current.length === 0) return
    setDrawingsByPair({
      ...drawingsByPair,
      [pair]: current.slice(0, -1),
    })
  }

  function handleClearDrawings() {
    setDrawingsByPair({
      ...drawingsByPair,
      [pair]: [],
    })
  }

  function handlePanDelta(deltaBars: number) {
    setPanOffset((prev) =>
      Math.min(maxPanOffset, Math.max(0, prev + deltaBars)),
    )
  }

  function handleZoomDelta(deltaBars: number, anchorRatio?: number) {
    const oldZoom = clampedZoom
    const nextZoom = Math.min(navigableTotal, Math.max(25, oldZoom + deltaBars))
    if (nextZoom === oldZoom) return

    const effectiveAnchor = anchorRatio ?? (clampedPan === 0 ? 1 : 0.5)
    const nextMaxPan = Math.max(0, navigableTotal - nextZoom)
    const nextPan =
      clampedPan + Math.round((1 - effectiveAnchor) * (oldZoom - nextZoom))

    setZoomCount(nextZoom)
    setPanOffset(Math.min(nextMaxPan, Math.max(0, nextPan)))
  }

  function handleResetView() {
    setZoomCount(110)
    setPanOffset(0)
  }

  function handleJumpToBar(globalIndex: number) {
    const desiredRightEdgeOffset = Math.max(
      0,
      Math.min(
        maxPanOffset,
        candles.length - 1 - globalIndex - Math.floor(clampedZoom * 0.35),
      ),
    )
    const targetEnd = candles.length - desiredRightEdgeOffset
    const targetStart = Math.max(warmupBars, targetEnd - clampedZoom)
    setPanOffset(desiredRightEdgeOffset)
    const localIdx = globalIndex - targetStart
    if (localIdx >= 0 && localIdx < clampedZoom) {
      setHoverIndex(localIdx)
    }
  }

  function handleApplyPreset(preset: StrategyPreset) {
    onSelectPair?.(preset.strategy.pair)
    onSelectTimeframe?.(preset.timeframe)
    onChangeParams?.(preset.signalParams)
    onSaveStrategy?.(preset.strategy)
  }

  async function handleExecuteQuickDemoOrder(overrideSide?: 'buy' | 'sell') {
    if (visibleCandles.length === 0 || submittingOrder) return
    const execSide = overrideSide ?? orderSide
    setSubmittingOrder(true)
    setOrderFeedback(null)
    const stakeUsd = Math.max(
      10,
      Math.round(orderSizeUsd > 0 ? orderSizeUsd : 10_000 * ((strategy?.positionSize ?? 10) / 100)),
    )

    try {
      const response = await submitDemoOrderOnServer({
        pair,
        side: execSide === 'buy' ? 'BUY' : 'SELL',
        notionalUsd: stakeUsd,
      })
      const latestOrder = response.order
      if (response.ok && latestOrder.status === 'FILLED') {
        setOrderFeedback(
          isEs
            ? `Orden ${latestOrder.side} ejecutada en ${pair} @ $${latestOrder.price.toLocaleString('en-US')} ($${stakeUsd} USD)`
            : `${latestOrder.side} order filled on ${pair} @ $${latestOrder.price.toLocaleString('en-US')} ($${stakeUsd} USD)`,
        )
      } else {
        setOrderFeedback(
          response.error ??
            latestOrder.reason ??
            (isEs
              ? 'Orden rechazada por límites de riesgo'
              : 'Order rejected by risk limits'),
        )
      }
    } catch {
      setOrderFeedback(
        isEs
          ? 'Error al conectar con el adaptador de órdenes Demo'
          : 'Failed to connect to Demo order adapter',
      )
    } finally {
      setSubmittingOrder(false)
    }
  }

  const drawToolItems = useMemo(
    () =>
      [
        {
          id: 'cursor',
          label: isEs ? 'Cursor' : 'Cursor',
          title: isEs
            ? 'Arrastrar espectro y navegar con controles de gráfica'
            : 'Drag spectrum and navigate with chart controls',
          Icon: Crosshair,
        },
        {
          id: 'measure',
          label: t('studio.measure'),
          title: isEs
            ? 'Medir rango Δ% y barras entre dos velas (2 clics)'
            : 'Measure % delta and bar count between two points (2 clicks)',
          Icon: Ruler,
        },
        {
          id: 'trendline',
          label: isEs ? 'Tendencia' : 'Trendline',
          title: isEs
            ? 'Dibujar línea de tendencia con pendiente % (2 clics)'
            : 'Draw trendline with % slope (2 clicks)',
          Icon: TrendingUp,
        },
        {
          id: 'horizontal',
          label: isEs ? 'Nivel S/R' : 'S/R Level',
          title: isEs
            ? 'Trazar soporte o resistencia horizontal (1 clic)'
            : 'Plot horizontal support/resistance (1 click)',
          Icon: Minus,
        },
        {
          id: 'fib',
          label: 'Fibonacci',
          title: isEs
            ? 'Trazar retroceso Fibonacci 0% – 100% (2 clics)'
            : 'Plot Fibonacci retracement 0% – 100% (2 clicks)',
          Icon: Layers,
        },
      ] as const,
    [isEs, t],
  )

  const latestBar = candles[candles.length - 1]
  const prevBar = candles[candles.length - 2]
  const spotClose = latestBar?.close ?? 0
  const spotChangePct =
    latestBar && prevBar && prevBar.close > 0
      ? ((latestBar.close - prevBar.close) / prevBar.close) * 100
      : 0
  const sessionHigh = useMemo(
    () =>
      visibleCandles.reduce(
        (max, c) => (c.high > max ? c.high : max),
        visibleCandles[0]?.high ?? 0,
      ),
    [visibleCandles],
  )
  const sessionLow = useMemo(
    () =>
      visibleCandles.reduce(
        (min, c) => (c.low < min ? c.low : min),
        visibleCandles[0]?.low ?? 0,
      ),
    [visibleCandles],
  )
  const latestAtr14 = fullAnalysis.atrFull[fullAnalysis.atrFull.length - 1] ?? null
  const latestVwap = fullAnalysis.vwapFull[fullAnalysis.vwapFull.length - 1] ?? null

  const activeIndicatorsCount = [
    showFastSlow,
    showEma50,
    showEma200,
    showBollinger,
    showVwap,
    showVolumeSma,
    showSignals,
    showOrderLines,
    showRsi,
    showMacd,
  ].filter(Boolean).length

  const indicatorMenu = (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="xs" className="gap-1.5">
          <SlidersHorizontal className="size-3 text-primary" />
          <span>{t('studio.indicators')}</span>
          <Badge variant="secondary" className="px-1 py-0 text-[9.5px] tabular-nums">
            {activeIndicatorsCount}
          </Badge>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3">
        <div className="flex flex-col gap-2.5">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            {t('studio.overlaysGroup')}
          </span>
          {(
            [
              {
                key: 'showFastSlow',
                label: `MA (${params.average.toUpperCase()} ${params.fastPeriod}/${params.slowPeriod})`,
                checked: showFastSlow,
              },
              { key: 'showEma50', label: 'EMA 50', checked: showEma50 },
              { key: 'showEma200', label: 'EMA 200', checked: showEma200 },
              {
                key: 'showBollinger',
                label: 'Bollinger Bands (20, 2)',
                checked: showBollinger,
              },
              { key: 'showVwap', label: 'VWAP Session', checked: showVwap },
              {
                key: 'showVolumeSma',
                label: 'Volume SMA (20)',
                checked: showVolumeSma,
              },
              {
                key: 'showSignals',
                label: isEs ? 'Señales de cruce' : 'Crossover Signals',
                checked: showSignals,
              },
              {
                key: 'showOrderLines',
                label: isEs ? 'Niveles TP / SL / Lock' : 'TP / SL / Lock Lines',
                checked: showOrderLines,
              },
            ] as const
          ).map((item) => (
            <div key={item.key} className="flex items-center justify-between gap-2">
              <Label
                htmlFor={`ind-${item.key}`}
                className="cursor-pointer font-mono text-[11px] font-medium text-foreground"
              >
                {item.label}
              </Label>
              <Checkbox
                id={`ind-${item.key}`}
                checked={item.checked}
                onCheckedChange={(v) => updatePref(item.key, Boolean(v))}
              />
            </div>
          ))}

          <Separator />

          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            {t('studio.panesGroup')}
          </span>
          {(
            [
              { key: 'showRsi', label: `RSI (${RSI_PERIOD})`, checked: showRsi },
              { key: 'showMacd', label: 'MACD (12, 26, 9)', checked: showMacd },
            ] as const
          ).map((item) => (
            <div key={item.key} className="flex items-center justify-between gap-2">
              <Label
                htmlFor={`ind-${item.key}`}
                className="cursor-pointer font-mono text-[11px] font-medium text-foreground"
              >
                {item.label}
              </Label>
              <Checkbox
                id={`ind-${item.key}`}
                checked={item.checked}
                onCheckedChange={(v) => updatePref(item.key, Boolean(v))}
              />
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )

  const candleStyleSelector = (
    <div
      className="inline-flex h-7 items-center gap-0.5 rounded-sm border border-border bg-secondary/65 p-0.5"
      role="group"
      aria-label={t('studio.candleStyle')}
    >
      {(
        [
          { id: 'candles', label: t('studio.styleCandles') },
          { id: 'hollow', label: t('studio.styleHollow') },
          { id: 'heikin-ashi', label: t('studio.styleHeikin') },
        ] as const
      ).map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => updatePref('candleStyle', opt.id)}
          className={cn(
            'inline-flex h-[22px] items-center justify-center whitespace-nowrap rounded-[4px] border px-2 font-mono text-[10.5px] font-medium transition-all duration-150 cursor-pointer',
            candleStyle === opt.id
              ? 'border-border bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.18)]'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )

  const zoomPresetsControl = (
    <div
      className="inline-flex h-7 items-center gap-0.5 rounded-sm border border-border bg-secondary/65 p-0.5"
      role="group"
    >
      {ZOOM_PRESETS.map((preset) => {
        const isAll = preset >= navigableTotal
        const targetCount = isAll ? navigableTotal : preset
        const active = Math.abs(clampedZoom - targetCount) <= 2
        return (
          <button
            key={preset}
            type="button"
            className={cn(
              'inline-flex h-[22px] min-w-[40px] items-center justify-center whitespace-nowrap rounded-[4px] border px-2 font-mono text-[10.5px] font-medium tabular-nums transition-all duration-150 cursor-pointer',
              active
                ? 'border-border bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.18)]'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
            onClick={() => {
              setZoomCount(targetCount)
              if (isAll) setPanOffset(0)
            }}
          >
            {isAll ? (isEs ? 'Todo' : 'All') : `${preset}V`}
          </button>
        )
      })}
    </div>
  )

  if (isExpanded) {
    const subPaneHeight = showRsi && showMacd ? 80 : 108
    const candleChrome = 96
    const subPaneChrome = 46
    const totalReserved =
      16 +
      candleChrome +
      (showRsi ? subPaneHeight + subPaneChrome : 0) +
      (showMacd ? subPaneHeight + subPaneChrome : 0)
    const expandedCandleHeight = Math.max(220, expandedStackHeight - totalReserved)

    return (
      <div
        className="fixed inset-0 z-50 flex h-dvh w-screen flex-col overflow-hidden bg-background text-foreground"
        role="dialog"
        aria-modal="true"
        aria-label={`${pair} Chart Studio`}
      >
        {/* Top Workstation Header */}
        <header className="flex h-11 shrink-0 items-center justify-between gap-2 overflow-x-auto overflow-y-hidden border-b border-border bg-card px-3 [scrollbar-width:none]">
          <div className="flex shrink-0 flex-nowrap items-center gap-2.5 whitespace-nowrap">
            {onSelectPair ? (
              <Select value={pair} onValueChange={onSelectPair}>
                <SelectTrigger className="h-7 !w-auto min-w-[116px] shrink-0 border-border bg-secondary/70 px-2 font-mono text-xs font-bold">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availablePairs.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="shrink-0 font-mono text-xs font-bold text-foreground">
                {pair}
              </span>
            )}

            <div className="flex shrink-0 flex-nowrap items-baseline gap-2 whitespace-nowrap font-mono tabular-nums">
              <span className="text-sm font-bold text-foreground">
                ${formatPrice(spotClose)}
              </span>
              <span
                className={cn(
                  'text-[11px] font-semibold',
                  spotChangePct >= 0
                    ? 'text-[var(--positive)]'
                    : 'text-[var(--negative)]',
                )}
              >
                {spotChangePct >= 0 ? '+' : ''}
                {spotChangePct.toFixed(2)}%
              </span>
              <span className="hidden shrink-0 whitespace-nowrap text-[10.5px] text-muted-foreground xl:inline">
                H ${formatPrice(sessionHigh)} · L ${formatPrice(sessionLow)}
              </span>
            </div>

            {(streamStatus === 'ws' || streamStatus === 'poll') && (
              <Badge variant="positive" className="text-[9.5px]">
                {streamStatus === 'ws' ? 'WS LIVE' : 'LIVE'}
              </Badge>
            )}
            {candleStyle === 'heikin-ashi' && (
              <Badge variant="violet" className="text-[9.5px]">
                HA
              </Badge>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {onSelectTimeframe && (
              <div
                className="inline-flex h-7 items-center gap-0.5 rounded-sm border border-border bg-secondary/65 p-0.5"
                role="group"
                aria-label={t('market.timeframeAria')}
              >
                {(['5m', '15m', '1h', '4h', '1d'] as const).map((tf) => (
                  <button
                    key={tf}
                    type="button"
                    onClick={() => onSelectTimeframe(tf)}
                    className={cn(
                      'inline-flex h-[22px] items-center justify-center rounded-[4px] border px-2 font-mono text-[10.5px] font-semibold transition-all duration-150 cursor-pointer',
                      timeframe === tf
                        ? 'border-border bg-card text-primary shadow-[0_1px_2px_rgba(0,0,0,0.18)]'
                        : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {tf}
                  </button>
                ))}
              </div>
            )}

            <div className="hidden md:flex">{candleStyleSelector}</div>
            {indicatorMenu}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="outline"
                  onClick={handleResetView}
                  aria-label={t('studio.resetView')}
                >
                  <RotateCcw className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('studio.resetView')}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-xs"
                  variant={showRightPanel ? 'default' : 'outline'}
                  onClick={() => updatePref('showRightPanel', !showRightPanel)}
                  aria-label={t('studio.togglePanel')}
                >
                  <PanelRight className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('studio.togglePanel')}</TooltipContent>
            </Tooltip>

            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => setIsExpanded(false)}
              className="gap-1.5 font-mono"
            >
              <Minimize2 className="size-3" />
              <span>{t('studio.collapse')}</span>
              <span className="hidden text-[9.5px] text-muted-foreground sm:inline">
                Esc
              </span>
            </Button>
          </div>
        </header>

        {/* Main Split Workspace */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
          {/* Left Vertical Drawing Rail */}
          <nav
            aria-label="Chart drawing tools"
            className="hidden w-11 shrink-0 flex-col items-center gap-1 border-r border-border bg-card/65 py-2 sm:flex"
          >
            {drawToolItems.map(({ id, label, title, Icon }) => {
              const active = drawingMode === id
              return (
                <Tooltip key={id}>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant={active ? 'default' : 'ghost'}
                      onClick={() => setDrawingMode(id)}
                      aria-label={label}
                      aria-pressed={active}
                    >
                      <Icon className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">{title}</TooltipContent>
                </Tooltip>
              )
            })}

            <Separator className="my-1 w-6" />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant={magnetSnap ? 'secondary' : 'ghost'}
                  onClick={() => updatePref('magnetSnap', !magnetSnap)}
                  aria-label={t('studio.magnet')}
                  aria-pressed={magnetSnap}
                  className={cn(magnetSnap && 'border-primary/45 text-primary')}
                >
                  <Magnet className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{t('studio.magnet')}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={pairDrawings.length === 0}
                  onClick={handleUndoDrawing}
                  aria-label={t('studio.undo')}
                >
                  <Undo2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{t('studio.undo')}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={pairDrawings.length === 0}
                  onClick={handleClearDrawings}
                  aria-label={t('studio.clear')}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                {t('studio.clear')} ({pairDrawings.length})
              </TooltipContent>
            </Tooltip>
          </nav>

          {/* Center Synchronized Chart Stack */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
            <div
              ref={expandedStackRef}
              className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overflow-x-hidden p-2 [scrollbar-width:thin]"
            >
              <CandleChart
                candles={visibleCandles}
                overlays={visibleOverlays}
                signals={visibleSignals}
                orderLines={orderLines}
                drawings={pairDrawings}
                drawingMode={drawingMode}
                candleStyle={candleStyle}
                magnetSnap={magnetSnap}
                volSmaValues={visibleVolSma}
                onAddDrawing={handleAddDrawing}
                onRemoveDrawing={handleRemoveDrawing}
                onPanDelta={handlePanDelta}
                onZoomDelta={handleZoomDelta}
                onResetView={handleResetView}
                activeIndex={hoverIndex}
                onActiveIndexChange={setHoverIndex}
                height={expandedCandleHeight}
                defaultWheelZoomLocked={true}
                compactHeader
              />

              {showRsi && (
                <RsiPanel
                  candles={visibleCandles}
                  values={visibleRsi}
                  period={RSI_PERIOD}
                  activeIndex={hoverIndex}
                  onActiveIndexChange={setHoverIndex}
                  height={subPaneHeight}
                  compactHeader
                />
              )}

              {showMacd && (
                <MacdPanel
                  candles={visibleCandles}
                  macdLine={visibleMacd.macdLine}
                  signalLine={visibleMacd.signalLine}
                  histogram={visibleMacd.histogram}
                  activeIndex={hoverIndex}
                  onActiveIndexChange={setHoverIndex}
                  height={subPaneHeight}
                  compactHeader
                />
              )}
            </div>

            {/* Bottom Expanded Scrubber Footer */}
            <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2.5 border-t border-border bg-card/65 px-3 py-1.5">
              {zoomPresetsControl}

              <div className="flex min-w-[180px] flex-1 items-center gap-2.5">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground whitespace-nowrap">
                  {isEs ? 'Espectro' : 'Spectrum'}
                </span>
                <Slider
                  min={0}
                  max={Math.max(1, maxPanOffset)}
                  step={1}
                  disabled={maxPanOffset === 0}
                  value={[maxPanOffset - clampedPan]}
                  onValueChange={([sliderVal]) => {
                    setPanOffset(Math.max(0, maxPanOffset - (sliderVal ?? 0)))
                  }}
                  aria-label={
                    isEs ? 'Desplazar espectro de velas' : 'Scrub candle spectrum'
                  }
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={clampedPan === 0}
                  onClick={() => setPanOffset(0)}
                  className="shrink-0 whitespace-nowrap"
                >
                  <RotateCcw className="size-3" />
                  <span>{isEs ? 'En Vivo' : 'Live'}</span>
                </Button>
              </div>

              <span className="hidden font-mono text-[10.5px] text-muted-foreground tabular-nums md:inline">
                {visibleCandles.length}/{navigableTotal} bars · +{warmupBars} warm-up
              </span>
            </footer>
          </div>

          {/* Collapsible Right Quantitative Drawer */}
          {showRightPanel && (
            <StudioSidebar
              candles={candles}
              pair={pair}
              timeframe={timeframe}
              params={params}
              signals={navigableSignals}
              orderSide={orderSide}
              onOrderSideChange={setOrderSide}
              strategy={strategy}
              onSaveStrategy={onSaveStrategy}
              onChangeParams={onChangeParams}
              onApplyPreset={handleApplyPreset}
              onJumpToBar={handleJumpToBar}
              botSnapshot={botSnapshot}
              orderSizeUsd={orderSizeUsd}
              onOrderSizeUsdChange={setOrderSizeUsd}
              onSubmitOrder={(s) => void handleExecuteQuickDemoOrder(s)}
              submittingOrder={submittingOrder}
              orderFeedback={orderFeedback}
              atr14={latestAtr14}
              lastVwap={latestVwap}
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      {/* Interactive toolbar */}
      <div
        className={cn(
          'flex min-w-0 flex-col gap-2 border-b border-border pb-2.5',
          compact && 'gap-1.5 pb-2',
        )}
      >
        <div className="flex min-w-0 max-w-full flex-nowrap items-center justify-between gap-2 overflow-x-auto [scrollbar-width:none]">
          {/* SVG drawing tools */}
          <div className="flex shrink-0 flex-nowrap items-center gap-1.5">
            <div
              className="inline-flex h-7 items-center gap-0.5 rounded-sm border border-border bg-secondary/65 p-0.5"
              role="group"
            >
              {drawToolItems.map(({ id, label, title, Icon }) => {
                const active = drawingMode === id
                return (
                  <Tooltip key={id}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setDrawingMode(id)}
                        className={cn(
                          'inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-[4px] border px-2 font-mono text-[10.5px] font-medium transition-all duration-150 cursor-pointer',
                          active
                            ? 'border-border bg-card font-semibold text-primary shadow-[0_1px_2px_rgba(0,0,0,0.18)]'
                            : 'border-transparent text-muted-foreground hover:text-foreground',
                        )}
                      >
                        <Icon className="size-3" />
                        <span>{label}</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">{title}</TooltipContent>
                  </Tooltip>
                )
              })}
            </div>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant={magnetSnap ? 'secondary' : 'outline'}
                  size="icon-xs"
                  onClick={() => updatePref('magnetSnap', !magnetSnap)}
                  aria-label={t('studio.magnet')}
                  aria-pressed={magnetSnap}
                  className={cn(magnetSnap && 'border-primary/45 text-primary')}
                >
                  <Magnet className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('studio.magnet')}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-xs"
                  onClick={handleUndoDrawing}
                  disabled={pairDrawings.length === 0}
                  aria-label={t('studio.undo')}
                >
                  <Undo2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('studio.undo')}</TooltipContent>
            </Tooltip>

            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={handleClearDrawings}
              disabled={pairDrawings.length === 0}
              className="font-mono text-[10.5px] tabular-nums"
            >
              <Trash2 className="size-3" />
              <span className="whitespace-nowrap tabular-nums">
                {t('studio.clear')} ({pairDrawings.length})
              </span>
            </Button>
          </div>

          {/* Right controls: candle style + indicators + zoom + expand */}
          <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-1.5">
            {!compact && <div className="hidden xl:flex">{candleStyleSelector}</div>}
            {!compact && indicatorMenu}
            {zoomPresetsControl}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="default"
                  size="xs"
                  onClick={() => setIsExpanded(true)}
                  className="gap-1.5 font-mono"
                >
                  <Maximize2 className="size-3" />
                  <span>{t('studio.expand')}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {isEs
                  ? 'Abrir Workstation a pantalla completa (tecla F)'
                  : 'Open Fullscreen Chart Studio (press F)'}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Row 2: Order Lines + Quick Overlay Shortcuts */}
        {!compact && (
          <div className="flex flex-nowrap items-center justify-between gap-2.5 overflow-x-auto border-t border-dashed border-border/80 pt-2 [scrollbar-width:none]">
            <div className="flex shrink-0 flex-nowrap items-center gap-1.5">
              <span className="mr-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground whitespace-nowrap">
                {isEs ? 'Órdenes' : 'Orders'}
              </span>
              <Button
                type="button"
                variant={showOrderLines ? 'default' : 'outline'}
                size="xs"
                onClick={() => updatePref('showOrderLines', !showOrderLines)}
              >
                <Layers className="size-3" />
                <span>{isEs ? 'Líneas TP/SL' : 'TP/SL Lines'}</span>
              </Button>

              <div
                className={cn(
                  'inline-flex h-7 items-center gap-0.5 rounded-sm border border-border bg-secondary/65 p-0.5',
                  !showOrderLines && 'opacity-45',
                )}
                role="group"
              >
                <button
                  type="button"
                  className={cn(
                    'inline-flex h-[22px] items-center justify-center rounded-[4px] border px-2 font-mono text-[10.5px] font-semibold transition-all duration-150 cursor-pointer disabled:cursor-not-allowed',
                    orderSide === 'buy'
                      ? 'border-[var(--positive)]/50 bg-[var(--positive-soft)] text-[var(--positive)]'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() => setOrderSide('buy')}
                  disabled={!showOrderLines}
                >
                  LONG
                </button>
                <button
                  type="button"
                  className={cn(
                    'inline-flex h-[22px] items-center justify-center rounded-[4px] border px-2 font-mono text-[10.5px] font-semibold transition-all duration-150 cursor-pointer disabled:cursor-not-allowed',
                    orderSide === 'sell'
                      ? 'border-[var(--negative)]/50 bg-[var(--negative-soft)] text-[var(--negative)]'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() => setOrderSide('sell')}
                  disabled={!showOrderLines}
                >
                  SHORT
                </button>
              </div>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    className="justify-center font-mono text-[11px] whitespace-nowrap"
                    onClick={() => void handleExecuteQuickDemoOrder()}
                    disabled={submittingOrder}
                  >
                    <Zap className="size-3 text-primary" />
                    <span>
                      {submittingOrder
                        ? '...'
                        : `${orderSide === 'buy' ? 'LONG' : 'SHORT'} $${orderSizeUsd}`}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {isEs
                    ? 'Enviar orden de prueba inmediata al adaptador Binance Testnet / Demo Vault'
                    : 'Send instant test order to Binance Testnet / Demo Vault adapter'}
                </TooltipContent>
              </Tooltip>
            </div>

            <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-1.5">
              <div className="flex xl:hidden">{candleStyleSelector}</div>
              <Button
                type="button"
                variant={showBollinger ? 'secondary' : 'outline'}
                size="xs"
                onClick={() => updatePref('showBollinger', !showBollinger)}
              >
                BB (20,2)
              </Button>
              <Button
                type="button"
                variant={showEma50 ? 'secondary' : 'outline'}
                size="xs"
                onClick={() => updatePref('showEma50', !showEma50)}
              >
                EMA 50
              </Button>
              <Button
                type="button"
                variant={showVwap ? 'secondary' : 'outline'}
                size="xs"
                onClick={() => updatePref('showVwap', !showVwap)}
              >
                VWAP
              </Button>
              <Button
                type="button"
                variant={showMacd ? 'secondary' : 'outline'}
                size="xs"
                onClick={() => updatePref('showMacd', !showMacd)}
              >
                MACD
              </Button>
            </div>
          </div>
        )}
      </div>

      {!compact && orderFeedback && (
        <div className="flex items-center gap-2 rounded-sm border border-primary/40 bg-primary/10 px-3 py-2 font-mono text-xs font-medium text-foreground">
          <Zap className="size-3.5 shrink-0 text-primary" />
          <span>{orderFeedback}</span>
        </div>
      )}

      {/* Interactive candlestick chart */}
      <CandleChart
        candles={visibleCandles}
        overlays={visibleOverlays}
        signals={visibleSignals}
        orderLines={compact ? [] : orderLines}
        drawings={pairDrawings}
        drawingMode={drawingMode}
        candleStyle={candleStyle}
        magnetSnap={magnetSnap}
        volSmaValues={visibleVolSma}
        onAddDrawing={handleAddDrawing}
        onRemoveDrawing={handleRemoveDrawing}
        onPanDelta={handlePanDelta}
        onZoomDelta={handleZoomDelta}
        onResetView={handleResetView}
        activeIndex={hoverIndex}
        onActiveIndexChange={setHoverIndex}
        height={chartHeight}
        defaultWheelZoomLocked={defaultWheelZoomLocked}
      />

      {/* Historical spectrum scrubber */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-y border-border/80 py-2">
        <div className="flex min-w-[200px] flex-1 items-center gap-3">
          <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground whitespace-nowrap">
            {isEs ? 'Espectro' : 'Spectrum'}
          </span>
          <Slider
            min={0}
            max={Math.max(1, maxPanOffset)}
            step={1}
            disabled={maxPanOffset === 0}
            value={[maxPanOffset - clampedPan]}
            onValueChange={([sliderVal]) => {
              setPanOffset(Math.max(0, maxPanOffset - (sliderVal ?? 0)))
            }}
            aria-label={
              isEs ? 'Desplazar espectro de velas' : 'Scrub candle spectrum'
            }
            className="flex-1"
          />
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={clampedPan === 0}
            onClick={() => setPanOffset(0)}
            className="shrink-0 whitespace-nowrap"
          >
            <RotateCcw className="size-3" />
            <span>{isEs ? 'Ir a Vela Actual' : 'Jump to Live'}</span>
          </Button>
        </div>

        {!compact && (
          <Badge
            variant="secondary"
            className="shrink-0 font-mono text-[10.5px] lowercase tracking-normal"
            title={
              isEs
                ? `Mostrando ${visibleCandles.length} de ${navigableTotal} velas navegables (+${warmupBars} velas de pre-calentamiento)`
                : `Showing ${visibleCandles.length} of ${navigableTotal} navigable bars (+${warmupBars} warm-up bars)`
            }
          >
            {isEs
              ? `${visibleCandles.length}/${navigableTotal} velas · +${warmupBars} warm-up`
              : `${visibleCandles.length}/${navigableTotal} bars · +${warmupBars} warm-up`}
          </Badge>
        )}
      </div>

      {!compact && (
        <div className="flex flex-col gap-3">
          {showRsi && (
            <RsiPanel
              candles={visibleCandles}
              values={visibleRsi}
              period={RSI_PERIOD}
              activeIndex={hoverIndex}
              onActiveIndexChange={setHoverIndex}
            />
          )}

          {showMacd && (
            <MacdPanel
              candles={visibleCandles}
              macdLine={visibleMacd.macdLine}
              signalLine={visibleMacd.signalLine}
              histogram={visibleMacd.histogram}
              activeIndex={hoverIndex}
              onActiveIndexChange={setHoverIndex}
            />
          )}

          <div className="flex flex-col gap-2">
            <h3 className="font-display text-xs font-semibold uppercase tracking-[0.06em] text-foreground">
              {t('market.signals', { count: navigableSignals.length })}
            </h3>
            <SignalsTable signals={navigableSignals} params={params} />
          </div>
        </div>
      )}
    </div>
  )
}

export default MarketAnalysis
