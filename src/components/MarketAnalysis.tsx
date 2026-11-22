import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getBotStatus,
  submitExchangeOrderOnServer,
  subscribeToBotStream,
  type BotServerSnapshot,
} from '../api/botClient'
import CandleChart from './CandleChart'
import ChartAlertsPopover from './ChartAlertsPopover'
import MacdPanel from './MacdPanel'
import PaneResizeHandle from './PaneResizeHandle'
import RsiPanel from './RsiPanel'
import StudioSidebar from './StudioSidebar'
import type { CoinFocusMeta, LiveMarketMetrics } from './MarketSection'
import {
  Bell,
  Bot,
  Check,
  Crosshair,
  Layers,
  Magnet,
  Maximize2,
  Minimize2,
  Minus,
  PanelRight,
  Plus,
  Redo2,
  RotateCcw,
  Ruler,
  SlidersHorizontal,
  Target,
  Trash2,
  TrendingUp,
  Undo2,
  X,
} from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { StrategyPreset } from '../botEngine'
import { playAlertChime } from '../botProfiles'
import {
  createChartAlert,
  evaluateAlerts,
  loadChartAlerts,
  rearmAlert,
  removeAlert,
  saveChartAlerts,
  toggleAlertEnabled,
} from '../chartAlerts'
import {
  createCrosshairChannel,
  createPanTransformChannel,
} from '../chartCrosshair'
import {
  createDrawingHistory,
  drawingScopeKey,
  loadDrawingsStore,
  pushDrawingHistory,
  redoDrawingHistory,
  saveDrawingsStore,
  undoDrawingHistory,
  type DrawingHistoryState,
  type DrawingsByScope,
} from '../chartDrawings'
import {
  COLLAPSED_PANE_HEIGHT,
  DEFAULT_MACD_SETTINGS,
  DEFAULT_PANE_HEIGHT,
  DEFAULT_RSI_SETTINGS,
  MIN_PANE_HEIGHT,
  clampPaneHeight,
  createDefaultPanes,
  isChartPaneList,
  normalizeChartPanes,
  resolvePaneSvgHeight,
  sanitizeMacdSettings,
  sanitizeRsiSettings,
} from '../chartPanes'
import {
  appendHeikinAshiTail,
  appendLiveAnalysisTail,
  buildAnalysisPrefix,
  buildHeikinAshiPrefix,
} from '../chartRenderer'
import {
  DEFAULT_VISIBLE_COUNT,
  ZOOM_PRESETS,
  applyZoomPreset,
  compute24hChangePct,
  createDefaultViewport,
  jumpViewportToIndex,
  jumpViewportToLive,
  panViewport,
  resolveViewportRange,
  zoomViewport,
} from '../chartViewport'
import { formatPrice } from '../format'
import { useElementSize } from '../hooks/useElementWidth'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import { macd as computeMacd, rsi as computeRsi } from '../indicators'
import type { LiveStreamStatus } from '../market/liveStream'
import { RSI_PERIOD } from '../signals'
import { availablePairs } from '../strategy'
import { useI18n } from '../i18n'
import type {
  Candle,
  CandleStyleMode,
  ChartAlert,
  ChartAlertDirection,
  ChartDrawing,
  ChartOrderLine,
  ChartOverlay,
  ChartPaneConfig,
  ChartPaneKind,
  ChartViewport,
  DensitySetting,
  DrawingToolMode,
  Interval,
  MacdPaneSettings,
  OrderPrefillIntent,
  PageId,
  RsiPaneSettings,
  SignalParams,
  Strategy,
  TradeSide,
} from '../types'

const STUDIO_PREFS_KEY = 'flare:chart-studio-prefs'
const VIEWPORT_ZOOM_STORAGE_KEY = 'flare:chart-viewport-v1'

type ViewportZoomByScope = Record<string, number>

function isViewportZoomByScope(value: unknown): value is ViewportZoomByScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  return Object.values(value as Record<string, unknown>).every(
    (entry) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 10,
  )
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
  panes?: ChartPaneConfig[]
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
  showMacd: false,
  showRightPanel: true,
  panes: createDefaultPanes(true, false),
}

const VALID_CANDLE_STYLES: CandleStyleMode[] = [
  'candles',
  'hollow',
  'heikin-ashi',
]

const INTERVAL_OPTIONS: readonly Interval[] = ['5m', '15m', '1h', '4h', '1d']

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
    typeof c.showRightPanel === 'boolean' &&
    (c.panes === undefined || isChartPaneList(c.panes))
  )
}

function formatUtcClock(timestamp: number | null | undefined): string {
  if (!timestamp) return '--:--:--'
  return new Date(timestamp).toISOString().slice(11, 19)
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
  coinProfile?: CoinFocusMeta
  liveMetrics?: LiveMarketMetrics | null
  onCalibratePreset?: () => void
  chartHeight?: number
  defaultWheelZoomLocked?: boolean
  compact?: boolean
  soundAlerts?: boolean
  density?: DensitySetting
  reducedMotion?: boolean
}

function MarketAnalysis({
  candles,
  params,
  pair = 'BTC/USDT',
  timeframe = '15m',
  onSelectPair,
  onSelectTimeframe,
  onChangeParams,
  strategy,
  onSaveStrategy,
  onNavigate,
  streamStatus,
  lastTickAt,
  coinProfile,
  liveMetrics,
  onCalibratePreset,
  defaultWheelZoomLocked = false,
  soundAlerts = false,
  density = 'comfortable',
  reducedMotion = false,
}: MarketAnalysisProps) {
  const { t, language } = useI18n()
  const isEs = language === 'es'
  const isCompactDensity = density === 'compact'

  // Reserve the first 50 bars of the 360-candle spectrum as warm-up buffer
  // so SMA, EMA, EMA-50, and RSI-14 never start cut off or null on the left edge.
  const warmupBars = useMemo(
    () =>
      candles.length > 90 ? 50 : Math.min(20, Math.floor(candles.length / 4)),
    [candles.length],
  )
  const navigableTotal = Math.max(20, candles.length - warmupBars)

  const [prefs, setPrefs] = useLocalStorageState<StudioPrefs>(
    STUDIO_PREFS_KEY,
    DEFAULT_STUDIO_PREFS,
    isStudioPrefs,
  )
  const [persistedZoomByScope, setPersistedZoomByScope] =
    useLocalStorageState<ViewportZoomByScope>(
      VIEWPORT_ZOOM_STORAGE_KEY,
      {},
      isViewportZoomByScope,
    )
  const viewportScopeKey = `${pair}|${timeframe}`
  const defaultScopeZoom =
    persistedZoomByScope[viewportScopeKey] ?? DEFAULT_VISIBLE_COUNT
  const [scopedViewport, setScopedViewport] = useState<{
    scopeKey: string
    viewport: ChartViewport
  }>(() => ({
    scopeKey: viewportScopeKey,
    viewport: createDefaultViewport(defaultScopeZoom),
  }))
  const activeViewport: ChartViewport =
    scopedViewport.scopeKey === viewportScopeKey
      ? scopedViewport.viewport
      : createDefaultViewport(defaultScopeZoom)

  const commitViewport = useCallback(
    (next: ChartViewport, persistZoom = false) => {
      setScopedViewport({ scopeKey: viewportScopeKey, viewport: next })
      if (persistZoom) {
        setPersistedZoomByScope((prev) =>
          prev[viewportScopeKey] === next.visibleCount
            ? prev
            : { ...prev, [viewportScopeKey]: next.visibleCount },
        )
      }
    },
    [setPersistedZoomByScope, viewportScopeKey],
  )

  const [isExpanded, setIsExpanded] = useState(false)
  const [drawingMode, setDrawingMode] = useState<DrawingToolMode>('cursor')
  const [orderSide, setOrderSide] = useState<'buy' | 'sell'>('buy')
  const [orderSizeUsd, setOrderSizeUsd] = useState<number>(250)
  // Crosshair & sub-pixel pan pub/sub channels shared by CandleChart, RsiPanel,
  // and MacdPanel so hovering and sub-pixel panning never trigger MarketAnalysis re-renders.
  const crosshairChannel = useMemo(() => createCrosshairChannel(), [])
  const panTransformChannel = useMemo(() => createPanTransformChannel(), [])

  useEffect(() => {
    crosshairChannel.set(null)
    panTransformChannel.set(0)
  }, [crosshairChannel, panTransformChannel, viewportScopeKey])
  const [botSnapshot, setBotSnapshot] = useState<BotServerSnapshot | null>(null)
  const [orderFeedback, setOrderFeedback] = useState<string | null>(null)
  const [submittingOrder, setSubmittingOrder] = useState(false)
  const [narrowPanelOpen, setNarrowPanelOpen] = useState(false)
  const [isWideViewport, setIsWideViewport] = useState<boolean>(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(min-width: 1024px)').matches
      : true,
  )
  const [plotStackRef, plotStackSize] = useElementSize<HTMLDivElement>()

  const panes = useMemo(
    () => normalizeChartPanes(prefs.panes, prefs.showRsi, prefs.showMacd),
    [prefs.panes, prefs.showMacd, prefs.showRsi],
  )
  const rsiPane = panes[0]
  const macdPane = panes[1]

  const showFastSlow = prefs.showFastSlow
  const showEma50 = prefs.showEma50
  const showEma200 = prefs.showEma200
  const showBollinger = prefs.showBollinger
  const showVwap = prefs.showVwap
  const showVolumeSma = prefs.showVolumeSma
  const showSignals = prefs.showSignals
  const showOrderLines = prefs.showOrderLines
  const showRsi = rsiPane.visible
  const showMacd = macdPane.visible
  const showRightPanel = isWideViewport ? prefs.showRightPanel : narrowPanelOpen
  const candleStyle = prefs.candleStyle
  const magnetSnap = prefs.magnetSnap

  const updatePref = useCallback(
    <K extends keyof StudioPrefs>(key: K, value: StudioPrefs[K]) => {
      setPrefs((prev) => ({ ...prev, [key]: value }))
    },
    [setPrefs],
  )

  const updatePanes = useCallback(
    (updater: (current: ChartPaneConfig[]) => ChartPaneConfig[]) => {
      setPrefs((prev) => {
        const current = normalizeChartPanes(
          prev.panes,
          prev.showRsi,
          prev.showMacd,
        )
        const nextPanes = updater(current)
        const nextRsi = nextPanes.find((p) => p.kind === 'rsi')
        const nextMacd = nextPanes.find((p) => p.kind === 'macd')
        return {
          ...prev,
          panes: nextPanes,
          showRsi: nextRsi ? nextRsi.visible : prev.showRsi,
          showMacd: nextMacd ? nextMacd.visible : prev.showMacd,
        }
      })
    },
    [setPrefs],
  )

  const handleSetPaneVisible = useCallback(
    (kind: ChartPaneKind, visible: boolean) => {
      updatePanes((list) =>
        list.map((pane) =>
          pane.kind === kind
            ? { ...pane, visible, collapsed: visible ? false : pane.collapsed }
            : pane,
        ),
      )
    },
    [updatePanes],
  )

  const handleTogglePaneCollapse = useCallback(
    (kind: ChartPaneKind) => {
      updatePanes((list) =>
        list.map((pane) =>
          pane.kind === kind ? { ...pane, collapsed: !pane.collapsed } : pane,
        ),
      )
    },
    [updatePanes],
  )

  const handleResizePane = useCallback(
    (kind: ChartPaneKind, requestedHeight: number) => {
      updatePanes((list) => {
        const visibleList = list.filter((p) => p.visible)
        const otherHeight = visibleList
          .filter((p) => p.kind !== kind)
          .reduce(
            (sum, p) => sum + (p.collapsed ? COLLAPSED_PANE_HEIGHT : p.height),
            0,
          )
        const clamped = clampPaneHeight(
          requestedHeight,
          plotStackSize.height,
          otherHeight,
          visibleList.length,
        )
        return list.map((pane) =>
          pane.kind === kind
            ? { ...pane, height: clamped, collapsed: false }
            : pane,
        )
      })
    },
    [plotStackSize.height, updatePanes],
  )

  const handleResetPaneHeight = useCallback(
    (kind: ChartPaneKind) => {
      handleResizePane(kind, DEFAULT_PANE_HEIGHT)
    },
    [handleResizePane],
  )

  const handleUpdateRsiSettings = useCallback(
    (patch: Partial<RsiPaneSettings>) => {
      updatePanes((list) =>
        list.map((pane) =>
          pane.kind === 'rsi'
            ? { ...pane, settings: sanitizeRsiSettings(patch, pane.settings) }
            : pane,
        ),
      )
    },
    [updatePanes],
  )

  const handleUpdateMacdSettings = useCallback(
    (patch: Partial<MacdPaneSettings>) => {
      updatePanes((list) =>
        list.map((pane) =>
          pane.kind === 'macd'
            ? { ...pane, settings: sanitizeMacdSettings(patch, pane.settings) }
            : pane,
        ),
      )
    },
    [updatePanes],
  )

  const handleToggleRightPanel = useCallback(() => {
    if (isWideViewport) {
      updatePref('showRightPanel', !prefs.showRightPanel)
    } else {
      setNarrowPanelOpen((prev) => !prev)
    }
  }, [isWideViewport, prefs.showRightPanel, updatePref])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const mq = window.matchMedia('(min-width: 1024px)')
    const onChange = (event: MediaQueryListEvent) => {
      setIsWideViewport(event.matches)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (!isExpanded) return undefined
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevOverflow
    }
  }, [isExpanded])

  const [drawingsState, setDrawingsState] = useState<{
    store: DrawingsByScope
    history: Record<string, DrawingHistoryState>
  }>(() => ({
    store: loadDrawingsStore(timeframe),
    history: {},
  }))
  const [scopedSelectedDrawing, setScopedSelectedDrawing] = useState<{
    scopeKey: string
    id: string
  } | null>(null)
  const [clearDialogOpen, setClearDialogOpen] = useState(false)

  const currentDrawingScope = drawingScopeKey(pair, timeframe)
  const selectedDrawingId =
    scopedSelectedDrawing &&
      scopedSelectedDrawing.scopeKey === currentDrawingScope
      ? scopedSelectedDrawing.id
      : null
  const setSelectedDrawingId = useCallback(
    (id: string | null) => {
      setScopedSelectedDrawing(
        id === null ? null : { scopeKey: currentDrawingScope, id },
      )
    },
    [currentDrawingScope],
  )

  const handleSelectDrawingMode = useCallback(
    (mode: DrawingToolMode) => {
      setDrawingMode(mode)
      if (mode !== 'cursor') {
        setSelectedDrawingId(null)
      }
    },
    [setSelectedDrawingId],
  )

  useEffect(() => {
    saveDrawingsStore(drawingsState.store)
  }, [drawingsState.store])

  const currentHistory: DrawingHistoryState = useMemo(
    () =>
      drawingsState.history[currentDrawingScope] ??
      createDrawingHistory(drawingsState.store[currentDrawingScope] ?? []),
    [currentDrawingScope, drawingsState.history, drawingsState.store],
  )
  const scopedDrawings = currentHistory.present
  const canUndoDrawings = currentHistory.past.length > 0
  const canRedoDrawings = currentHistory.future.length > 0

  const commitDrawingList = useCallback(
    (updater: (current: ChartDrawing[]) => ChartDrawing[]) => {
      setDrawingsState((prev) => {
        const base =
          prev.history[currentDrawingScope] ??
          createDrawingHistory(prev.store[currentDrawingScope] ?? [])
        const nextList = updater(base.present)
        const nextHistory = pushDrawingHistory(base, nextList)
        return {
          store: { ...prev.store, [currentDrawingScope]: nextList },
          history: { ...prev.history, [currentDrawingScope]: nextHistory },
        }
      })
    },
    [currentDrawingScope],
  )

  const handleAddDrawing = useCallback(
    (drawing: ChartDrawing) => {
      commitDrawingList((list) => [...list, drawing])
    },
    [commitDrawingList],
  )

  const handleUpdateDrawing = useCallback(
    (updated: ChartDrawing) => {
      commitDrawingList((list) =>
        list.map((d) => (d.id === updated.id ? updated : d)),
      )
    },
    [commitDrawingList],
  )

  const handleRemoveDrawing = useCallback(
    (id: string) => {
      commitDrawingList((list) => list.filter((d) => d.id !== id))
      setScopedSelectedDrawing((prev) => (prev && prev.id === id ? null : prev))
    },
    [commitDrawingList],
  )

  const handleUndoDrawing = useCallback(() => {
    setDrawingsState((prev) => {
      const base = prev.history[currentDrawingScope]
      if (!base || base.past.length === 0) return prev
      const nextHistory = undoDrawingHistory(base)
      return {
        store: { ...prev.store, [currentDrawingScope]: nextHistory.present },
        history: { ...prev.history, [currentDrawingScope]: nextHistory },
      }
    })
  }, [currentDrawingScope])

  const handleRedoDrawing = useCallback(() => {
    setDrawingsState((prev) => {
      const base = prev.history[currentDrawingScope]
      if (!base || base.future.length === 0) return prev
      const nextHistory = redoDrawingHistory(base)
      return {
        store: { ...prev.store, [currentDrawingScope]: nextHistory.present },
        history: { ...prev.history, [currentDrawingScope]: nextHistory },
      }
    })
  }, [currentDrawingScope])

  const handleConfirmClearDrawings = useCallback(() => {
    commitDrawingList(() => [])
    setScopedSelectedDrawing(null)
    setClearDialogOpen(false)
  }, [commitDrawingList])

  useEffect(() => {
    let popupOpenAtKeyDown = false
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        popupOpenAtKeyDown = Boolean(
          document.querySelector(
            '[data-slot="popover-content"], [data-slot="select-content"], [data-radix-popper-content-wrapper], [role="listbox"], [role="alertdialog"]',
          ),
        )
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
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
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
          if (canUndoDrawings) {
            e.preventDefault()
            handleUndoDrawing()
          }
          return
        }
        if (
          (e.key.toLowerCase() === 'z' && e.shiftKey) ||
          e.key.toLowerCase() === 'y'
        ) {
          if (canRedoDrawings) {
            e.preventDefault()
            handleRedoDrawing()
          }
          return
        }
        return
      }
      if (e.altKey) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedDrawingId) {
        e.preventDefault()
        handleRemoveDrawing(selectedDrawingId)
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
        if (selectedDrawingId) {
          e.preventDefault()
          setSelectedDrawingId(null)
          return
        }
        if (drawingMode !== 'cursor') {
          e.preventDefault()
          setDrawingMode('cursor')
          return
        }
        if (!isWideViewport && narrowPanelOpen) {
          e.preventDefault()
          setNarrowPanelOpen(false)
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
  }, [
    canRedoDrawings,
    canUndoDrawings,
    drawingMode,
    handleRedoDrawing,
    handleRemoveDrawing,
    handleUndoDrawing,
    isExpanded,
    isWideViewport,
    narrowPanelOpen,
    selectedDrawingId,
    setSelectedDrawingId,
  ])

  useEffect(() => {
    let active = true
    getBotStatus()
      .then((snap) => {
        if (active) setBotSnapshot(snap)
      })
      .catch(() => { })
    const unsubscribe = subscribeToBotStream((snap) => {
      if (active) setBotSnapshot(snap)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  // Resolve absolute timestamp-anchored viewport (immune to live candle drift)
  const resolvedViewport = useMemo(
    () => resolveViewportRange(candles, warmupBars, activeViewport),
    [candles, warmupBars, activeViewport],
  )
  const { viewStart, viewEnd, visibleCount: clampedZoom } = resolvedViewport
  const isFollowingLive = activeViewport.followLive

  // Cache closed-bar prefix [0 .. n-2] so intra-bar ticks update only index n-1 in O(1)
  const closedCount = Math.max(0, candles.length - 1)
  const closedPrefixKey =
    closedCount > 0
      ? `${closedCount}|${candles[0].time}|${candles[closedCount - 1].time}|${candles[closedCount - 1].close}`
      : 'empty'

  const closedCandles = useMemo(
    () => (closedCount > 0 ? candles.slice(0, closedCount) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [closedPrefixKey],
  )

  const analysisPrefixCache = useMemo(
    () => buildAnalysisPrefix(closedCandles, params),
    [closedCandles, params],
  )

  const fullAnalysis = useMemo(() => {
    if (candles.length === 0) return analysisPrefixCache.analysis
    const liveCandle = candles[candles.length - 1]
    const prevClosed =
      closedCandles.length > 0
        ? closedCandles[closedCandles.length - 1]
        : null
    return appendLiveAnalysisTail(
      analysisPrefixCache,
      liveCandle,
      prevClosed,
      params,
    )
  }, [analysisPrefixCache, candles, closedCandles, params])

  // Single Heikin Ashi conversion cached over closed bars + O(1) live tail
  const haPrefix = useMemo(
    () => (candleStyle === 'heikin-ashi' ? buildHeikinAshiPrefix(closedCandles) : null),
    [candleStyle, closedCandles],
  )

  const displaySourceCandles = useMemo(() => {
    if (candleStyle !== 'heikin-ashi' || haPrefix === null) return candles
    if (candles.length === 0) return []
    return appendHeikinAshiTail(haPrefix, candles[candles.length - 1])
  }, [candleStyle, haPrefix, candles])

  // Slice visible spectrum window [viewStart .. viewEnd] plus 10-bar overscan
  // buffers on both edges so GPU translate3d panning glides seamlessly behind clipPath.
  const PAN_OVERSCAN = 10
  const ovLeftStart = Math.max(0, viewStart - PAN_OVERSCAN)
  const ovRightEnd = Math.min(displaySourceCandles.length, viewEnd + PAN_OVERSCAN)
  const canPanLeft = viewStart > warmupBars
  const canPanRight = viewEnd < displaySourceCandles.length

  const visibleCandles = useMemo(
    () => displaySourceCandles.slice(viewStart, viewEnd),
    [displaySourceCandles, viewStart, viewEnd],
  )
  const overscanLeftCandles = useMemo(
    () =>
      ovLeftStart < viewStart
        ? displaySourceCandles.slice(ovLeftStart, viewStart)
        : undefined,
    [displaySourceCandles, ovLeftStart, viewStart],
  )
  const overscanRightCandles = useMemo(
    () =>
      viewEnd < ovRightEnd
        ? displaySourceCandles.slice(viewEnd, ovRightEnd)
        : undefined,
    [displaySourceCandles, ovRightEnd, viewEnd],
  )

  const { visibleOverlays, overscanLeftOverlays, overscanRightOverlays } = useMemo(() => {
    const list: ChartOverlay[] = []
    const leftList: (number | null)[][] = []
    const rightList: (number | null)[][] = []
    const pushOverlay = (
      id: string,
      label: string,
      kind: ChartOverlay['kind'],
      full: (number | null)[],
    ) => {
      list.push({ id, label, kind, values: full.slice(viewStart, viewEnd) })
      leftList.push(ovLeftStart < viewStart ? full.slice(ovLeftStart, viewStart) : [])
      rightList.push(viewEnd < ovRightEnd ? full.slice(viewEnd, ovRightEnd) : [])
    }

    if (showFastSlow) {
      pushOverlay(
        'fast',
        `${fullAnalysis.name} ${params.fastPeriod}`,
        'fast',
        fullAnalysis.fastFull,
      )
      pushOverlay(
        'slow',
        `${fullAnalysis.name} ${params.slowPeriod}`,
        'slow',
        fullAnalysis.slowFull,
      )
    }
    if (showEma50) {
      pushOverlay('ema50', 'EMA 50', 'trend', fullAnalysis.ema50Full)
    }
    if (showEma200) {
      pushOverlay('ema200', 'EMA 200', 'ema200', fullAnalysis.ema200Full)
    }
    if (showBollinger) {
      pushOverlay('bb-upper', 'BB Hi', 'bb-upper', fullAnalysis.bbFull.upper)
      pushOverlay('bb-basis', 'BB Mid', 'bb-basis', fullAnalysis.bbFull.basis)
      pushOverlay('bb-lower', 'BB Lo', 'bb-lower', fullAnalysis.bbFull.lower)
    }
    if (showVwap) {
      pushOverlay('vwap', 'VWAP Session', 'vwap', fullAnalysis.vwapFull)
    }
    return {
      visibleOverlays: list,
      overscanLeftOverlays: leftList,
      overscanRightOverlays: rightList,
    }
  }, [
    fullAnalysis,
    ovLeftStart,
    ovRightEnd,
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
      showVolumeSma
        ? fullAnalysis.volSmaFull.slice(viewStart, viewEnd)
        : undefined,
    [fullAnalysis.volSmaFull, showVolumeSma, viewEnd, viewStart],
  )
  const overscanLeftVolSma = useMemo(
    () =>
      showVolumeSma && ovLeftStart < viewStart
        ? fullAnalysis.volSmaFull.slice(ovLeftStart, viewStart)
        : undefined,
    [fullAnalysis.volSmaFull, ovLeftStart, showVolumeSma, viewStart],
  )
  const overscanRightVolSma = useMemo(
    () =>
      showVolumeSma && viewEnd < ovRightEnd
        ? fullAnalysis.volSmaFull.slice(viewEnd, ovRightEnd)
        : undefined,
    [fullAnalysis.volSmaFull, ovRightEnd, showVolumeSma, viewEnd],
  )

  // Display-only RSI & MACD series feeding existing indicator functions (never alters bot/backtest)
  const rsiPeriodDisplay =
    rsiPane.kind === 'rsi' ? rsiPane.settings.period : RSI_PERIOD
  const macdSettingsDisplay =
    macdPane.kind === 'macd' ? macdPane.settings : DEFAULT_MACD_SETTINGS

  const displayRsiFull = useMemo(() => {
    if (rsiPeriodDisplay === RSI_PERIOD) return fullAnalysis.rsiFull
    return computeRsi(
      candles.map((c) => c.close),
      rsiPeriodDisplay,
    )
  }, [candles, fullAnalysis.rsiFull, rsiPeriodDisplay])

  const displayMacdFull = useMemo(() => {
    if (
      macdSettingsDisplay.fastPeriod === DEFAULT_MACD_SETTINGS.fastPeriod &&
      macdSettingsDisplay.slowPeriod === DEFAULT_MACD_SETTINGS.slowPeriod &&
      macdSettingsDisplay.signalPeriod === DEFAULT_MACD_SETTINGS.signalPeriod
    ) {
      return fullAnalysis.macdFull
    }
    return computeMacd(
      candles.map((c) => c.close),
      macdSettingsDisplay.fastPeriod,
      macdSettingsDisplay.slowPeriod,
      macdSettingsDisplay.signalPeriod,
    )
  }, [candles, fullAnalysis.macdFull, macdSettingsDisplay])

  const visibleRsi = useMemo(
    () => displayRsiFull.slice(viewStart, viewEnd),
    [displayRsiFull, viewStart, viewEnd],
  )
  const overscanLeftRsi = useMemo(
    () =>
      ovLeftStart < viewStart
        ? displayRsiFull.slice(ovLeftStart, viewStart)
        : undefined,
    [displayRsiFull, ovLeftStart, viewStart],
  )
  const overscanRightRsi = useMemo(
    () =>
      viewEnd < ovRightEnd
        ? displayRsiFull.slice(viewEnd, ovRightEnd)
        : undefined,
    [displayRsiFull, ovRightEnd, viewEnd],
  )

  const visibleMacd = useMemo(
    () => ({
      macdLine: displayMacdFull.macd.slice(viewStart, viewEnd),
      signalLine: displayMacdFull.signal.slice(viewStart, viewEnd),
      histogram: displayMacdFull.histogram.slice(viewStart, viewEnd),
    }),
    [displayMacdFull, viewEnd, viewStart],
  )
  const overscanLeftMacd = useMemo(
    () =>
      ovLeftStart < viewStart
        ? {
          macdLine: displayMacdFull.macd.slice(ovLeftStart, viewStart),
          signalLine: displayMacdFull.signal.slice(ovLeftStart, viewStart),
          histogram: displayMacdFull.histogram.slice(ovLeftStart, viewStart),
        }
        : undefined,
    [displayMacdFull, ovLeftStart, viewStart],
  )
  const overscanRightMacd = useMemo(
    () =>
      viewEnd < ovRightEnd
        ? {
          macdLine: displayMacdFull.macd.slice(viewEnd, ovRightEnd),
          signalLine: displayMacdFull.signal.slice(viewEnd, ovRightEnd),
          histogram: displayMacdFull.histogram.slice(viewEnd, ovRightEnd),
        }
        : undefined,
    [displayMacdFull, ovRightEnd, viewEnd],
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
        label: 'PROFIT-LOCK 50% TP (Breakeven)',
      },
      {
        id: 'entry',
        kind: 'entry',
        price: entryPrice,
        badge: side === 'buy' ? 'LONG' : 'SHORT',
        label: hasMatchingBotPos
          ? `BOT ${side === 'buy' ? 'LONG' : 'SHORT'} (${pair})`
          : `${side === 'buy' ? 'LONG' : 'SHORT'} ENTRY (${pair})`,
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
    orderSide,
    pair,
    showOrderLines,
    strategy?.stopLoss,
    strategy?.takeProfit,
    visibleCandles.length,
  ])

  const viewportActionCtxRef = useRef({
    candles,
    warmupBars,
    activeViewport,
    commitViewport,
  })
  useEffect(() => {
    viewportActionCtxRef.current = {
      candles,
      warmupBars,
      activeViewport,
      commitViewport,
    }
  })

  const handlePanDelta = useCallback((deltaBars: number) => {
    const ctx = viewportActionCtxRef.current
    ctx.commitViewport(
      panViewport(ctx.candles, ctx.warmupBars, ctx.activeViewport, deltaBars),
    )
  }, [])

  const handleZoomDelta = useCallback(
    (deltaBars: number, anchorRatio?: number) => {
      const ctx = viewportActionCtxRef.current
      const next = zoomViewport(
        ctx.candles,
        ctx.warmupBars,
        ctx.activeViewport,
        deltaBars,
        anchorRatio,
      )
      ctx.commitViewport(next, true)
    },
    [],
  )

  const handleApplyZoomPreset = useCallback((presetBars: number) => {
    const ctx = viewportActionCtxRef.current
    const next = applyZoomPreset(
      ctx.candles,
      ctx.warmupBars,
      ctx.activeViewport,
      presetBars,
    )
    ctx.commitViewport(next, true)
  }, [])

  const handleJumpLive = useCallback(() => {
    const ctx = viewportActionCtxRef.current
    ctx.commitViewport(jumpViewportToLive(ctx.activeViewport))
  }, [])

  const handleResetView = useCallback(() => {
    const ctx = viewportActionCtxRef.current
    ctx.commitViewport(createDefaultViewport(DEFAULT_VISIBLE_COUNT), true)
  }, [])

  const handleJumpToBar = useCallback(
    (globalIndex: number) => {
      const ctx = viewportActionCtxRef.current
      const { viewport: nextVp, localIndex } = jumpViewportToIndex(
        ctx.candles,
        ctx.warmupBars,
        ctx.activeViewport,
        globalIndex,
      )
      ctx.commitViewport(nextVp)
      if (localIndex !== null) {
        crosshairChannel.set(localIndex)
      }
    },
    [crosshairChannel],
  )

  const handleApplyPreset = useCallback(
    (preset: StrategyPreset) => {
      onSelectPair?.(preset.strategy.pair)
      onSelectTimeframe?.(preset.timeframe)
      onChangeParams?.(preset.signalParams)
      onSaveStrategy?.(preset.strategy)
    },
    [onChangeParams, onSaveStrategy, onSelectPair, onSelectTimeframe],
  )

  const handleExecuteQuickDemoOrder = useCallback(
    async (overrideSide?: 'buy' | 'sell') => {
      if (visibleCandles.length === 0 || submittingOrder) return
      const execSide = overrideSide ?? orderSide
      setSubmittingOrder(true)
      setOrderFeedback(null)
      const stakeUsd =
        orderSizeUsd > 0
          ? Math.round(orderSizeUsd)
          : botSnapshot && botSnapshot.state.balance > 0
            ? Math.round(
                botSnapshot.state.balance *
                  ((strategy?.positionSize ?? 10) / 100),
              )
            : 0
      if (stakeUsd < 10) {
        setOrderFeedback(t('studio.orderRejected'))
        setSubmittingOrder(false)
        return
      }

      try {
        const response = await submitExchangeOrderOnServer({
          pair,
          side: execSide === 'buy' ? 'BUY' : 'SELL',
          notionalUsd: stakeUsd,
        })
        const latestOrder = response.order
        if (response.ok && latestOrder.status === 'FILLED') {
          setOrderFeedback(
            t('studio.orderFilled', {
              side: latestOrder.side,
              pair,
              price: latestOrder.price.toLocaleString('en-US'),
              usd: stakeUsd,
            }),
          )
        } else {
          setOrderFeedback(
            response.error ?? latestOrder.reason ?? t('studio.orderRejected'),
          )
        }
      } catch (err) {
        setOrderFeedback(
          err instanceof Error ? err.message : t('studio.orderError'),
        )
      } finally {
        setSubmittingOrder(false)
      }
    },
    [
      botSnapshot,
      orderSide,
      orderSizeUsd,
      pair,
      strategy?.positionSize,
      submittingOrder,
      t,
      visibleCandles.length,
    ],
  )

  const handleSidebarSubmitOrder = useCallback(
    (side: 'buy' | 'sell') => {
      void handleExecuteQuickDemoOrder(side)
    },
    [handleExecuteQuickDemoOrder],
  )

  const drawToolItems = useMemo(
    () =>
      [
        {
          id: 'cursor',
          label: t('studio.toolCursor'),
          title: t('studio.toolCursorHint'),
          Icon: Crosshair,
        },
        {
          id: 'measure',
          label: t('studio.measure'),
          title: t('studio.toolMeasureHint'),
          Icon: Ruler,
        },
        {
          id: 'trendline',
          label: t('studio.toolTrendline'),
          title: t('studio.toolTrendlineHint'),
          Icon: TrendingUp,
        },
        {
          id: 'horizontal',
          label: t('studio.toolHorizontal'),
          title: t('studio.toolHorizontalHint'),
          Icon: Minus,
        },
        {
          id: 'fib',
          label: t('studio.toolFib'),
          title: t('studio.toolFibHint'),
          Icon: Layers,
        },
      ] as const,
    [t],
  )

  // Single canonical live price source shared by header, in-chart tag, alerts, and order lines
  const latestBar = candles[candles.length - 1]
  const livePrice = latestBar?.close ?? null
  const livePriceIsUp = latestBar ? latestBar.close >= latestBar.open : true

  // Phase 6: Client-only price alerts persisted in `flare:chart-alerts`
  const [alerts, setAlerts] = useState<ChartAlert[]>(() => loadChartAlerts())
  const alertsRef = useRef<ChartAlert[]>(alerts)
  const [firedBannerAlerts, setFiredBannerAlerts] = useState<ChartAlert[]>([])
  const [highlightedAlertId, setHighlightedAlertId] = useState<string | null>(
    null,
  )
  const [orderPrefill, setOrderPrefill] = useState<OrderPrefillIntent | null>(
    null,
  )
  const [alertAnnouncement, setAlertAnnouncement] = useState<string>('')
  const highlightTimerRef = useRef<number | null>(null)

  useEffect(() => {
    alertsRef.current = alerts
    saveChartAlerts(alerts)
  }, [alerts])

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current)
      }
    }
  }, [])

  // Evaluate armed client-only alerts against live price (not candle close)
  useEffect(() => {
    if (livePrice === null) return
    const frame = requestAnimationFrame(() => {
      const result = evaluateAlerts(alertsRef.current, pair, livePrice)
      if (result.newlyTriggered.length === 0) return
      alertsRef.current = result.nextAlerts
      setAlerts(result.nextAlerts)
      setFiredBannerAlerts((prev) => {
        const seen = new Set(prev.map((item) => item.id))
        const fresh = result.newlyTriggered.filter((item) => !seen.has(item.id))
        return fresh.length > 0 ? [...fresh, ...prev].slice(0, 4) : prev
      })
      const lead = result.newlyTriggered[0]
      setAlertAnnouncement(
        t('studio.alertFiredBanner', {
          pair: lead.pair,
          dir:
            lead.direction === 'above'
              ? t('studio.alertAbove')
              : t('studio.alertBelow'),
          price: formatPrice(lead.price),
        }),
      )
      if (soundAlerts) {
        playAlertChime()
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [alerts, livePrice, pair, soundAlerts, t])

  const pairAlerts = useMemo(
    () => alerts.filter((a) => a.pair === pair),
    [alerts, pair],
  )

  const handleAddAlert = useCallback(
    (price: number, direction?: ChartAlertDirection) => {
      const created = createChartAlert({
        pair,
        interval: timeframe,
        price,
        livePrice,
        direction,
      })
      setAlerts((prev) => [created, ...prev])
      setHighlightedAlertId(created.id)
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current)
      }
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightedAlertId(null)
      }, 2200)
    },
    [livePrice, pair, timeframe],
  )

  const handleCreateAlertAtPrice = useCallback(
    (price: number) => {
      handleAddAlert(price)
    },
    [handleAddAlert],
  )

  const handleToggleAlert = useCallback((id: string) => {
    setAlerts((prev) => toggleAlertEnabled(prev, id))
  }, [])

  const handleRearmAlert = useCallback((id: string) => {
    setAlerts((prev) => rearmAlert(prev, id))
    setFiredBannerAlerts((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const handleRemoveAlert = useCallback((id: string) => {
    setAlerts((prev) => removeAlert(prev, id))
    setFiredBannerAlerts((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const handleDismissFiredAlert = useCallback((id: string) => {
    setFiredBannerAlerts((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const handleJumpToAlert = useCallback(
    (alert: ChartAlert) => {
      if (!isFollowingLive) {
        handleJumpLive()
      }
      setHighlightedAlertId(alert.id)
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current)
      }
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightedAlertId(null)
      }, 2400)
    },
    [handleJumpLive, isFollowingLive],
  )

  // Phase 6: Order-at-price = prefill only (opens & focuses StudioSidebar Trade tab; never auto-submits)
  const handlePrefillOrderAtPrice = useCallback(
    (side: TradeSide, referencePrice: number) => {
      setOrderSide(side)
      setOrderPrefill((prev) => ({
        nonce: (prev?.nonce ?? 0) + 1,
        pair,
        side,
        referencePrice,
      }))
      if (isWideViewport) {
        updatePref('showRightPanel', true)
      } else {
        setNarrowPanelOpen(true)
      }
    },
    [isWideViewport, pair, updatePref],
  )

  const handleClearOrderPrefill = useCallback(() => {
    setOrderPrefill(null)
  }, [])

  const activeToolLabel =
    drawToolItems.find((item) => item.id === drawingMode)?.label ?? ''

  const change24h = useMemo(() => compute24hChangePct(candles), [candles])
  const spotChangePct = change24h?.changePct ?? 0
  const is24hChange = change24h?.is24h ?? false
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
  const latestAtr14 =
    fullAnalysis.atrFull[fullAnalysis.atrFull.length - 1] ?? null
  const latestVwap =
    fullAnalysis.vwapFull[fullAnalysis.vwapFull.length - 1] ?? null

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

  const liveStatusLabel =
    streamStatus === 'ws'
      ? t('terminal.liveWs')
      : streamStatus === 'poll'
        ? t('terminal.liveSync')
        : streamStatus === 'connecting'
          ? t('terminal.liveConnecting')
          : t('terminal.liveStatic')

  const liveClockText = formatUtcClock(lastTickAt)

  const visiblePanes = useMemo(() => panes.filter((p) => p.visible), [panes])

  const addPaneMenu = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label={t('studio.addPane')}
          className="h-6 gap-1 px-2 font-mono text-[10px]"
        >
          <Plus className="size-3 text-primary" />
          <span className="hidden md:inline">{t('studio.addPane')}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-48 p-2">
        <div className="flex flex-col gap-1">
          <span className="px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            {t('studio.panesGroup')}
          </span>
          {panes.map((pane) => {
            const label =
              pane.kind === 'rsi'
                ? `RSI (${pane.settings.period})`
                : `MACD (${pane.settings.fastPeriod}, ${pane.settings.slowPeriod}, ${pane.settings.signalPeriod})`
            return (
              <button
                key={pane.id}
                type="button"
                onClick={() => handleSetPaneVisible(pane.kind, !pane.visible)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-[4px] px-2 py-1.5 text-left font-mono text-[11px] transition-colors cursor-pointer',
                  pane.visible
                    ? 'bg-primary/12 font-semibold text-foreground'
                    : 'text-muted-foreground hover:bg-muted/45 hover:text-foreground',
                )}
              >
                <span>{label}</span>
                {pane.visible && <Check className="size-3 text-primary" />}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )

  const candleStyleSelector = (
    <div
      className="inline-flex h-6 items-center gap-0.5 rounded-sm bg-muted/45 p-0.5"
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
            'inline-flex h-5 items-center justify-center whitespace-nowrap rounded-[4px] px-1.5 font-mono text-[10px] font-medium transition-all duration-150 cursor-pointer',
            candleStyle === opt.id
              ? 'bg-card font-semibold text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )

  const indicatorMenu = (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="xs" className="h-6 gap-1 px-2">
          <SlidersHorizontal className="size-3 text-primary" />
          <span className="hidden sm:inline">{t('studio.indicators')}</span>
          <Badge
            variant="secondary"
            className="px-1 py-0 text-[9.5px] tabular-nums"
          >
            {activeIndicatorsCount}
          </Badge>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3">
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-1.5 xl:hidden">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
              {t('studio.candleStyle')}
            </span>
            {candleStyleSelector}
            <Separator />
          </div>

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
                label: t('studio.overlaySignals'),
                checked: showSignals,
              },
              {
                key: 'showOrderLines',
                label: t('studio.overlayOrderLines'),
                checked: showOrderLines,
              },
            ] as const
          ).map((item) => (
            <div
              key={item.key}
              className="flex items-center justify-between gap-2"
            >
              <Label
                htmlFor={`ind-${item.key}`}
                className="cursor-pointer text-xs font-medium text-foreground"
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
          {panes.map((pane) => {
            const label =
              pane.kind === 'rsi'
                ? `RSI (${pane.settings.period})`
                : `MACD (${pane.settings.fastPeriod}, ${pane.settings.slowPeriod}, ${pane.settings.signalPeriod})`
            return (
              <div
                key={pane.id}
                className="flex items-center justify-between gap-2"
              >
                <Label
                  htmlFor={`ind-pane-${pane.id}`}
                  className="cursor-pointer text-xs font-medium text-foreground"
                >
                  {label}
                </Label>
                <Checkbox
                  id={`ind-pane-${pane.id}`}
                  checked={pane.visible}
                  onCheckedChange={(v) =>
                    handleSetPaneVisible(pane.kind, Boolean(v))
                  }
                />
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )

  const zoomPresetsControl = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label={t('studio.zoomPresets')}
          className="h-6 gap-1 px-2 font-mono text-[10px] tabular-nums"
        >
          <span>{visibleCandles.length}V</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-52 p-2.5">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
              {t('studio.zoomPresets')}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
              {visibleCandles.length}/{navigableTotal}
            </span>
          </div>
          <div className="grid grid-cols-5 gap-1">
            {ZOOM_PRESETS.map((preset) => {
              const isAll = preset >= navigableTotal
              const targetCount = isAll ? navigableTotal : preset
              const active = Math.abs(clampedZoom - targetCount) <= 2
              return (
                <button
                  key={preset}
                  type="button"
                  className={cn(
                    'inline-flex h-6 items-center justify-center rounded-[4px] font-mono text-[10px] font-medium tabular-nums transition-all duration-150 cursor-pointer',
                    active
                      ? 'bg-primary text-primary-foreground font-semibold'
                      : 'bg-muted/45 text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() => handleApplyZoomPreset(preset)}
                >
                  {isAll ? t('studio.allBars') : `${preset}`}
                </button>
              )
            })}
          </div>
          <p className="text-[10.5px] leading-snug text-muted-foreground">
            {t('studio.wheelPanHint')}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )

  const calibrateLabel = coinProfile
    ? isEs
      ? coinProfile.presetBadgeEs
      : coinProfile.presetBadgeEn
    : ''

  return (
    <div
      data-slot="chart-workspace"
      data-expanded={isExpanded ? 'true' : 'false'}
      data-density={density}
      role={isExpanded ? 'dialog' : 'region'}
      aria-modal={isExpanded ? true : undefined}
      aria-label={t('studio.workspaceAria', { pair })}
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground',
        isExpanded && 'fixed inset-0 z-50 h-dvh w-screen',
      )}
    >
      {/* Screen-reader live region for drawing mode switches and triggered alerts */}
      <div className="sr-only" role="status" aria-live="polite">
        {alertAnnouncement || t('studio.modeAnnounced', { mode: activeToolLabel })}
      </div>

      {/* Unified Workspace Header */}
      <header
        className={cn(
          'flex shrink-0 items-center justify-between gap-2 overflow-x-auto overflow-y-hidden bg-card [scrollbar-width:none]',
          isCompactDensity ? 'h-8 px-2' : 'h-9 px-2.5',
        )}
      >
        <div className="flex shrink-0 flex-nowrap items-center gap-2 whitespace-nowrap">
          {onSelectPair ? (
            <Select value={pair} onValueChange={onSelectPair}>
              <SelectTrigger
                aria-label={t('market.pairAria')}
                className="h-6 !w-auto min-w-[104px] shrink-0 bg-muted/45 px-2 font-mono text-xs font-bold"
              >
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

          <div className="flex shrink-0 flex-nowrap items-baseline gap-1.5 whitespace-nowrap font-mono tabular-nums">
            <span className="text-xs font-bold text-foreground">
              {livePrice !== null ? `$${formatPrice(livePrice)}` : '—'}
            </span>
            <span
              className={cn(
                'text-[10.5px] font-semibold',
                spotChangePct >= 0
                  ? 'text-[var(--positive)]'
                  : 'text-[var(--negative)]',
              )}
            >
              {spotChangePct >= 0 ? '+' : ''}
              {spotChangePct.toFixed(2)}%
              {is24hChange && (
                <span className="ml-0.5 text-[9.5px] font-normal text-muted-foreground">
                  {t('studio.change24h')}
                </span>
              )}
            </span>
            <span className="hidden shrink-0 whitespace-nowrap text-[10px] text-muted-foreground 2xl:inline">
              H ${formatPrice(sessionHigh)} · L ${formatPrice(sessionLow)}
            </span>
            {liveMetrics && (
              <span
                className={cn(
                  'hidden shrink-0 whitespace-nowrap text-[10px] font-semibold 2xl:inline',
                  liveMetrics.emaDistPct >= 0
                    ? 'text-[var(--positive)]'
                    : 'text-[var(--negative)]',
                )}
              >
                EMA50 {liveMetrics.emaDistPct >= 0 ? '▲' : '▼'}
                {Math.abs(liveMetrics.emaDistPct).toFixed(2)}%
              </span>
            )}
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant={
                  streamStatus === 'ws'
                    ? 'positive'
                    : streamStatus === 'poll'
                      ? 'default'
                      : 'secondary'
                }
                aria-live="polite"
                className="h-5 gap-1 px-1.5 font-mono text-[9.5px]"
              >
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    streamStatus === 'ws'
                      ? 'bg-[var(--positive)]'
                      : streamStatus === 'poll'
                        ? 'bg-primary'
                        : 'bg-muted-foreground',
                  )}
                />
                <span>{liveStatusLabel}</span>
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {liveStatusLabel} · {liveClockText} UTC ·{' '}
              {isFollowingLive ? t('studio.followLive') : t('studio.followPaused')}
            </TooltipContent>
          </Tooltip>

          {!isFollowingLive && (
            <Button
              type="button"
              variant="default"
              size="xs"
              onClick={handleJumpLive}
              className="h-5 shrink-0 px-2 font-mono text-[10px]"
            >
              {t('studio.jumpLive')}
            </Button>
          )}

          {onSelectTimeframe && (
            <div
              className="inline-flex h-6 items-center gap-0.5 rounded-sm bg-muted/45 p-0.5"
              role="group"
              aria-label={t('market.timeframeAria')}
            >
              {INTERVAL_OPTIONS.map((tf) => (
                <button
                  key={tf}
                  type="button"
                  aria-pressed={timeframe === tf}
                  onClick={() => onSelectTimeframe(tf)}
                  className={cn(
                    'inline-flex h-5 items-center justify-center rounded-[4px] px-1.5 font-mono text-[10px] font-semibold transition-all duration-150 cursor-pointer',
                    timeframe === tf
                      ? 'bg-card text-primary'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {tf}
                </button>
              ))}
            </div>
          )}

          {candleStyle === 'heikin-ashi' && (
            <Badge variant="violet" className="h-5 px-1.5 text-[9.5px]">
              HA
            </Badge>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <div className="hidden xl:flex">{candleStyleSelector}</div>
          {zoomPresetsControl}
          {addPaneMenu}
          {indicatorMenu}
          <ChartAlertsPopover
            pair={pair}
            livePrice={livePrice}
            alerts={pairAlerts}
            onAddAlert={handleAddAlert}
            onToggleAlert={handleToggleAlert}
            onRearmAlert={handleRearmAlert}
            onRemoveAlert={handleRemoveAlert}
            onJumpToAlert={handleJumpToAlert}
          />

          {onCalibratePreset && coinProfile && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={onCalibratePreset}
                  className="h-6 gap-1 px-2"
                >
                  <Target className="size-3 text-primary" />
                  <span className="hidden md:inline">
                    {t('terminal.calibrate', {
                      coin: pair.replace('/USDT', ''),
                    })}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t('terminal.calibrateTitle', { preset: calibrateLabel })}
              </TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-xs"
                variant="outline"
                onClick={handleResetView}
                aria-label={t('studio.resetView')}
                className="size-6"
              >
                <RotateCcw className="size-3" />
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
                onClick={handleToggleRightPanel}
                aria-label={t('studio.togglePanel')}
                aria-pressed={showRightPanel}
                className="size-6"
              >
                <PanelRight className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('studio.togglePanel')}</TooltipContent>
          </Tooltip>

          {onNavigate && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => {
                      setIsExpanded(false)
                      onNavigate('predictions')
                    }}
                    aria-label={t('nav.predictions')}
                    className="h-6 gap-1 px-2"
                  >
                    <Target className="size-3" />
                    <span className="hidden xl:inline">{t('nav.predictions')}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('nav.predictions')}</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="default"
                    size="xs"
                    onClick={() => {
                      setIsExpanded(false)
                      onNavigate('bot-run')
                    }}
                    aria-label={t('terminal.runBot')}
                    className="h-6 gap-1 px-2"
                  >
                    <Bot className="size-3" />
                    <span className="hidden lg:inline">{t('terminal.runBot')}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('terminal.runBot')}</TooltipContent>
              </Tooltip>
            </>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => setIsExpanded((v) => !v)}
                aria-label={
                  isExpanded ? t('studio.collapseHint') : t('studio.expandHint')
                }
                className="h-6 gap-1 px-2 font-mono"
              >
                {isExpanded ? (
                  <>
                    <Minimize2 className="size-3" />
                    <span className="hidden sm:inline">{t('studio.collapse')}</span>
                  </>
                ) : (
                  <>
                    <Maximize2 className="size-3" />
                    <span className="hidden sm:inline">{t('studio.expand')}</span>
                  </>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isExpanded ? t('studio.collapseHint') : t('studio.expandHint')}
            </TooltipContent>
          </Tooltip>
        </div>
      </header>

      {/* Main Split Workspace */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Left Vertical Drawing Rail */}
        <nav
          aria-label={t('studio.drawingToolsAria')}
          className={cn(
            'flex shrink-0 flex-col items-center gap-1 bg-card/65 py-1.5',
            isCompactDensity ? 'w-8' : 'w-10',
          )}
        >
          {drawToolItems.map(({ id, label, title, Icon }) => {
            const active = drawingMode === id
            return (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant={active ? 'default' : 'ghost'}
                    onClick={() => handleSelectDrawingMode(id)}
                    aria-label={label}
                    aria-pressed={active}
                    className="size-7"
                  >
                    <Icon className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">{title}</TooltipContent>
              </Tooltip>
            )
          })}

          <Separator className="my-0.5 w-6" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-xs"
                variant={magnetSnap ? 'secondary' : 'ghost'}
                onClick={() => updatePref('magnetSnap', !magnetSnap)}
                aria-label={t('studio.magnet')}
                aria-pressed={magnetSnap}
                className={cn('size-7', magnetSnap && 'text-primary')}
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
                size="icon-xs"
                variant="ghost"
                disabled={!canUndoDrawings}
                onClick={handleUndoDrawing}
                aria-label={t('studio.undo')}
                className="size-7"
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
                size="icon-xs"
                variant="ghost"
                disabled={!canRedoDrawings}
                onClick={handleRedoDrawing}
                aria-label={t('studio.redo')}
                className="size-7"
              >
                <Redo2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{t('studio.redo')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                disabled={scopedDrawings.length === 0}
                onClick={() => setClearDialogOpen(true)}
                aria-label={`${t('studio.clear')} (${scopedDrawings.length})`}
                className="size-7"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {t('studio.clear')} ({scopedDrawings.length})
            </TooltipContent>
          </Tooltip>
        </nav>

        <AlertDialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('studio.clearConfirmTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('studio.clearConfirmDesc', {
                  count: scopedDrawings.length,
                  pair,
                  tf: timeframe,
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('settings.cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={handleConfirmClearDrawings}>
                {t('studio.clearConfirmYes')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Center Synchronized Chart Stack — seamless full-height surface */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card">
          {firedBannerAlerts.length > 0 && (
            <div
              role="status"
              aria-live="assertive"
              className="pointer-events-auto absolute top-2 right-2 z-20 flex max-w-xs flex-col gap-1"
            >
              {firedBannerAlerts.map((alert) => (
                <div
                  key={`fired-${alert.id}`}
                  className="flex items-center gap-2 rounded-sm bg-popover px-2.5 py-1.5 font-mono text-[10.5px] text-popover-foreground tabular-nums"
                >
                  <Bell className="size-3.5 shrink-0 text-[var(--chart-alert)]" />
                  <span className="min-w-0 flex-1 truncate">
                    {t('studio.alertFiredBanner', {
                      pair: alert.pair,
                      dir:
                        alert.direction === 'above'
                          ? t('studio.alertAbove')
                          : t('studio.alertBelow'),
                      price: formatPrice(alert.price),
                    })}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRearmAlert(alert.id)}
                    className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[10px] font-semibold text-primary hover:bg-primary/15"
                  >
                    {t('studio.alertRearm')}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDismissFiredAlert(alert.id)}
                    aria-label={t('studio.alertDismiss')}
                    className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div
            ref={plotStackRef}
            className={cn(
              'flex min-h-0 flex-1 flex-col gap-1 overflow-hidden px-1 pt-1',
              isExpanded ? 'pb-1' : 'pb-[var(--flare-dock-clearance)]',
            )}
          >
            <CandleChart
              candles={visibleCandles}
              overscanLeftCandles={overscanLeftCandles}
              overscanRightCandles={overscanRightCandles}
              overlays={visibleOverlays}
              overscanLeftOverlays={overscanLeftOverlays}
              overscanRightOverlays={overscanRightOverlays}
              signals={visibleSignals}
              orderLines={orderLines}
              alerts={pairAlerts}
              highlightedAlertId={highlightedAlertId}
              drawings={scopedDrawings}
              drawingMode={drawingMode}
              candleStyle={candleStyle}
              magnetSnap={magnetSnap}
              volSmaValues={visibleVolSma}
              overscanLeftVolSma={overscanLeftVolSma}
              overscanRightVolSma={overscanRightVolSma}
              onAddDrawing={handleAddDrawing}
              onUpdateDrawing={handleUpdateDrawing}
              onRemoveDrawing={handleRemoveDrawing}
              selectedDrawingId={selectedDrawingId}
              onSelectDrawing={setSelectedDrawingId}
              onCreateAlertAtPrice={handleCreateAlertAtPrice}
              onPrefillOrderAtPrice={handlePrefillOrderAtPrice}
              viewStart={viewStart}
              canPanLeft={canPanLeft}
              canPanRight={canPanRight}
              onPanDelta={handlePanDelta}
              onZoomDelta={handleZoomDelta}
              onResetView={handleResetView}
              canJumpLive={!isFollowingLive}
              onJumpLive={handleJumpLive}
              livePrice={livePrice}
              livePriceIsUp={livePriceIsUp}
              pair={pair}
              interval={timeframe}
              streamStatus={streamStatus}
              crosshairChannel={crosshairChannel}
              panTransformChannel={panTransformChannel}
              wheelTargetRef={plotStackRef}
              fillHeight
              defaultWheelZoomLocked={defaultWheelZoomLocked || isExpanded}
              reducedMotion={reducedMotion}
              compactHeader
            />

            {visiblePanes.map((pane) => {
              const otherPanesHeight = visiblePanes
                .filter((p) => p.id !== pane.id)
                .reduce(
                  (sum, p) =>
                    sum + (p.collapsed ? COLLAPSED_PANE_HEIGHT : p.height),
                  0,
                )
              const clampedPaneHeight = clampPaneHeight(
                pane.height,
                plotStackSize.height,
                otherPanesHeight,
                visiblePanes.length,
              )
              const maxAllowed = clampPaneHeight(
                9999,
                plotStackSize.height,
                otherPanesHeight,
                visiblePanes.length,
              )
              const svgHeight = resolvePaneSvgHeight(clampedPaneHeight)
              const paneLabel = pane.kind === 'rsi' ? 'RSI' : 'MACD'

              return (
                <div key={pane.id} className="flex shrink-0 flex-col">
                  <PaneResizeHandle
                    paneLabel={paneLabel}
                    currentHeight={clampedPaneHeight}
                    minHeight={MIN_PANE_HEIGHT}
                    maxHeight={maxAllowed}
                    disabled={pane.collapsed}
                    ariaLabel={t('studio.paneResizeAria', { pane: paneLabel })}
                    title={t('studio.paneResizeHint')}
                    onResize={(nextH) => handleResizePane(pane.kind, nextH)}
                    onReset={() => handleResetPaneHeight(pane.kind)}
                  />
                  {pane.kind === 'rsi' ? (
                    <RsiPanel
                      candles={visibleCandles}
                      values={visibleRsi}
                      overscanLeftValues={overscanLeftRsi}
                      overscanRightValues={overscanRightRsi}
                      period={pane.settings.period}
                      overbought={pane.settings.overbought}
                      oversold={pane.settings.oversold}
                      crosshairChannel={crosshairChannel}
                      panTransformChannel={panTransformChannel}
                      height={svgHeight}
                      compactHeader
                      collapsed={pane.collapsed}
                      onToggleCollapse={() => handleTogglePaneCollapse('rsi')}
                      onClose={() => handleSetPaneVisible('rsi', false)}
                      onChangeSettings={handleUpdateRsiSettings}
                      onResetSettings={() =>
                        handleUpdateRsiSettings(DEFAULT_RSI_SETTINGS)
                      }
                    />
                  ) : (
                    <MacdPanel
                      candles={visibleCandles}
                      macdLine={visibleMacd.macdLine}
                      signalLine={visibleMacd.signalLine}
                      histogram={visibleMacd.histogram}
                      overscanLeft={overscanLeftMacd}
                      overscanRight={overscanRightMacd}
                      fastPeriod={pane.settings.fastPeriod}
                      slowPeriod={pane.settings.slowPeriod}
                      signalPeriod={pane.settings.signalPeriod}
                      crosshairChannel={crosshairChannel}
                      panTransformChannel={panTransformChannel}
                      height={svgHeight}
                      compactHeader
                      collapsed={pane.collapsed}
                      onToggleCollapse={() => handleTogglePaneCollapse('macd')}
                      onClose={() => handleSetPaneVisible('macd', false)}
                      onChangeSettings={handleUpdateMacdSettings}
                      onResetSettings={() =>
                        handleUpdateMacdSettings(DEFAULT_MACD_SETTINGS)
                      }
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Collapsible Right Quantitative Drawer (docked on lg+, overlay drawer on < lg) */}
        {showRightPanel && !isWideViewport && (
          <div
            className="absolute inset-0 z-20 bg-foreground/15"
            aria-hidden="true"
            onClick={() => setNarrowPanelOpen(false)}
          />
        )}
        {showRightPanel && (
          <StudioSidebar
            candles={candles}
            pair={pair}
            timeframe={timeframe}
            params={params}
            signals={navigableSignals}
            orderSide={orderSide}
            onOrderSideChange={setOrderSide}
            orderPrefill={orderPrefill}
            onClearOrderPrefill={handleClearOrderPrefill}
            strategy={strategy}
            onSaveStrategy={onSaveStrategy}
            onChangeParams={onChangeParams}
            onApplyPreset={handleApplyPreset}
            onJumpToBar={handleJumpToBar}
            botSnapshot={botSnapshot}
            orderSizeUsd={orderSizeUsd}
            onOrderSizeUsdChange={setOrderSizeUsd}
            onSubmitOrder={handleSidebarSubmitOrder}
            submittingOrder={submittingOrder}
            orderFeedback={orderFeedback}
            atr14={latestAtr14}
            lastVwap={latestVwap}
            coinProfile={coinProfile}
            onCalibratePreset={onCalibratePreset}
            liveMetrics={liveMetrics}
            className={
              !isWideViewport
                ? 'absolute inset-y-0 right-0 z-30 w-[320px] max-w-[88vw]'
                : undefined
            }
          />
        )}
      </div>
    </div>
  )
}

export default MarketAnalysis
