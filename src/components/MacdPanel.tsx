import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { ChevronDown, ChevronUp, Settings2, X } from 'lucide-react'
import './EquityChart.css'
import './CandleChart.css'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { CrosshairChannel, PanTransformChannel } from '../chartCrosshair'
import { STUDIO_PLOT_MARGIN } from '../chartLayout'
import { formatDateTime } from '../format'
import { useElementWidth } from '../hooks/useElementWidth'
import { useI18n } from '../i18n'
import type { Series } from '../indicators'
import type { Candle, MacdPaneSettings } from '../types'

type MacdSeriesSlice = {
  macdLine: Series
  signalLine: Series
  histogram: Series
}

type MacdPanelProps = {
  candles: Candle[]
  macdLine: Series
  signalLine: Series
  histogram: Series
  overscanLeft?: MacdSeriesSlice
  overscanRight?: MacdSeriesSlice
  fastPeriod?: number
  slowPeriod?: number
  signalPeriod?: number
  activeIndex?: number | null
  onActiveIndexChange?: (index: number | null) => void
  crosshairChannel?: CrosshairChannel
  panTransformChannel?: PanTransformChannel
  height?: number
  compactHeader?: boolean
  collapsed?: boolean
  onToggleCollapse?: () => void
  onClose?: () => void
  onChangeSettings?: (patch: Partial<MacdPaneSettings>) => void
  onResetSettings?: () => void
}

const DEFAULT_HEIGHT = 80
const MARGIN = {
  top: 8,
  bottom: 10,
  left: STUDIO_PLOT_MARGIN.left,
  right: STUDIO_PLOT_MARGIN.right,
}

function formatCompactOsc(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 100) return value.toFixed(0)
  if (abs >= 10) return value.toFixed(1)
  if (abs >= 1) return value.toFixed(2)
  return value.toFixed(3)
}

function MacdPanel({
  candles,
  macdLine,
  signalLine,
  histogram,
  overscanLeft,
  overscanRight,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
  activeIndex: controlledActiveIndex,
  onActiveIndexChange,
  crosshairChannel,
  panTransformChannel,
  height = DEFAULT_HEIGHT,
  compactHeader = false,
  collapsed = false,
  onToggleCollapse,
  onClose,
  onChangeSettings,
  onResetSettings,
}: MacdPanelProps) {
  const { locale, t } = useI18n()
  const clipId = useId()
  const [containerRef, width] = useElementWidth<HTMLDivElement>()
  const panLayerRef = useRef<SVGGElement | null>(null)
  const [internalIndex, setInternalIndex] = useState<number | null>(null)
  const [hoverVal, setHoverVal] = useState<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const pendingRef = useRef<{ index: number; val: number } | null>(null)

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  useEffect(() => {
    if (!panTransformChannel) return
    const apply = (px: number) => {
      if (panLayerRef.current) {
        panLayerRef.current.style.transform =
          px === 0 ? '' : `translate3d(${px.toFixed(2)}px, 0, 0)`
      }
    }
    apply(panTransformChannel.get())
    return panTransformChannel.subscribe(apply)
  }, [panTransformChannel])

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

  function updateActiveIndex(next: number | null) {
    if (next === activeIndex) return
    if (crosshairChannel) {
      crosshairChannel.set(next)
    } else if (onActiveIndexChange) {
      onActiveIndexChange(next)
    } else {
      setInternalIndex(next)
    }
  }

  const count = candles.length
  const lastIndex = Math.max(0, count - 1)
  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right)
  const plotHeight = Math.max(24, height - MARGIN.top - MARGIN.bottom)
  const slot = count > 0 ? plotWidth / count : 0
  const barWidth = Math.max(1.5, Math.min(12, slot * 0.68))

  const { absMax, yMin, ySpan, yZero, macdPoints, signalPoints, histPaths } =
    useMemo(() => {
      let maxAbs = 1e-6
      for (let i = 0; i < count; i++) {
        const m = macdLine[i]
        const s = signalLine[i]
        const h = histogram[i]
        if (m !== null && Math.abs(m) > maxAbs) maxAbs = Math.abs(m)
        if (s !== null && Math.abs(s) > maxAbs) maxAbs = Math.abs(s)
        if (h !== null && Math.abs(h) > maxAbs) maxAbs = Math.abs(h)
      }
      const minY = -maxAbs * 1.12
      const spanY = maxAbs * 2.24
      const toY = (val: number) =>
        MARGIN.top + (1 - (val - minY) / spanY) * plotHeight
      const toX = (idx: number) => MARGIN.left + (idx + 0.5) * slot
      const zeroY = toY(0)

      const mPts: string[] = []
      const sPts: string[] = []
      const upParts: string[] = []
      const upFadeParts: string[] = []
      const downParts: string[] = []
      const downFadeParts: string[] = []

      if (!collapsed && plotWidth > 0 && count >= 2) {
        const halfW = barWidth / 2
        const bwStr = barWidth.toFixed(1)
        const pushBar = (
          idx: number,
          m: number | null,
          s: number | null,
          h: number | null,
          prevH: number | null,
        ) => {
          const x = toX(idx)
          if (m !== null) mPts.push(`${x.toFixed(1)},${toY(m).toFixed(1)}`)
          if (s !== null) sPts.push(`${x.toFixed(1)},${toY(s).toFixed(1)}`)
          if (h !== null) {
            const widening = prevH !== null && Math.abs(h) >= Math.abs(prevH)
            const yVal = toY(h)
            const yTop = h >= 0 ? yVal : zeroY
            const hPx = Math.max(1, Math.abs(yVal - zeroY))
            const seg = `M${(x - halfW).toFixed(1)} ${yTop.toFixed(1)}h${bwStr}v${hPx.toFixed(1)}h-${bwStr}Z`
            if (h >= 0) {
              if (widening) upParts.push(seg)
              else upFadeParts.push(seg)
            } else if (widening) {
              downParts.push(seg)
            } else {
              downFadeParts.push(seg)
            }
          }
        }

        if (overscanLeft) {
          const leftLen = overscanLeft.macdLine.length
          for (let i = 0; i < leftLen; i++) {
            pushBar(
              i - leftLen,
              overscanLeft.macdLine[i],
              overscanLeft.signalLine[i],
              overscanLeft.histogram[i],
              i > 0 ? overscanLeft.histogram[i - 1] : null,
            )
          }
        }
        for (let i = 0; i < count; i++) {
          const prevH =
            i > 0
              ? histogram[i - 1]
              : overscanLeft && overscanLeft.histogram.length > 0
                ? overscanLeft.histogram[overscanLeft.histogram.length - 1]
                : null
          pushBar(i, macdLine[i], signalLine[i], histogram[i], prevH)
        }
        if (overscanRight) {
          for (let i = 0; i < overscanRight.macdLine.length; i++) {
            const prevH =
              i > 0
                ? overscanRight.histogram[i - 1]
                : count > 0
                  ? histogram[count - 1]
                  : null
            pushBar(
              count + i,
              overscanRight.macdLine[i],
              overscanRight.signalLine[i],
              overscanRight.histogram[i],
              prevH,
            )
          }
        }
      }

      return {
        absMax: maxAbs,
        yMin: minY,
        ySpan: spanY,
        yZero: zeroY,
        macdPoints: mPts.join(' '),
        signalPoints: sPts.join(' '),
        histPaths: {
          up: upParts.join(''),
          upFade: upFadeParts.join(''),
          down: downParts.join(''),
          downFade: downFadeParts.join(''),
        },
      }
    }, [
      barWidth,
      collapsed,
      count,
      histogram,
      macdLine,
      overscanLeft,
      overscanRight,
      plotHeight,
      plotWidth,
      signalLine,
      slot,
    ])

  if (count < 2 || macdLine.length !== count) {
    return null
  }

  function xOf(index: number): number {
    return MARGIN.left + (index + 0.5) * slot
  }

  function yOf(value: number): number {
    const raw = MARGIN.top + (1 - (value - yMin) / ySpan) * plotHeight
    return Math.max(MARGIN.top, Math.min(MARGIN.top + plotHeight, raw))
  }

  const shownIndex = Math.min(activeIndex ?? lastIndex, lastIndex)
  const shownMacd = macdLine[shownIndex]
  const shownSignal = signalLine[shownIndex]
  const shownHist = histogram[shownIndex]

  const crosshairValue =
    activeIndex !== null
      ? (hoverVal ?? (shownMacd !== undefined ? shownMacd : null))
      : null
  const crosshairY = crosshairValue !== null ? yOf(crosshairValue) : null
  const staticValueY =
    shownMacd !== null && shownMacd !== undefined ? yOf(shownMacd) : null
  const hideStaticPill =
    crosshairY !== null &&
    staticValueY !== null &&
    Math.abs(crosshairY - staticValueY) < 18

  function handlePointer(event: ReactPointerEvent<SVGSVGElement>) {
    if (slot <= 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const index = Math.floor((event.clientX - rect.left - MARGIN.left) / slot)
    const clampedIdx = Math.min(lastIndex, Math.max(0, index))
    const relY = Math.max(
      MARGIN.top,
      Math.min(MARGIN.top + plotHeight, event.clientY - rect.top),
    )
    const yVal = yMin + (1 - (relY - MARGIN.top) / plotHeight) * ySpan

    pendingRef.current = { index: clampedIdx, val: yVal }
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        const next = pendingRef.current
        if (!next) return
        updateActiveIndex(next.index)
        setHoverVal(next.val)
      })
    }
  }

  function handlePointerLeave() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    pendingRef.current = null
    setHoverVal(null)
    updateActiveIndex(null)
  }

  const macdTitle = `MACD (${fastPeriod}, ${slowPeriod}, ${signalPeriod})`

  return (
    <div
      className={compactHeader ? 'chart !px-2 !py-1' : 'chart'}
      ref={containerRef}
      role="region"
      aria-label={macdTitle}
    >
      <div
        className={
          compactHeader
            ? 'mb-0.5 flex h-5 items-center gap-2 font-mono text-[10.5px] leading-tight tabular-nums text-muted-foreground'
            : 'mb-1 flex flex-wrap items-center gap-2.5 font-mono text-[11px] tabular-nums text-muted-foreground'
        }
      >
        <span className="font-semibold text-foreground/85">{macdTitle}</span>
        <span>
          DIF{' '}
          <strong className="text-[var(--secondary)]">
            {formatCompactOsc(shownMacd)}
          </strong>
        </span>
        <span>
          DEA{' '}
          <strong className="text-[var(--brand)]">
            {formatCompactOsc(shownSignal)}
          </strong>
        </span>
        <span className="hidden sm:inline">
          HIST{' '}
          <strong
            className={
              shownHist !== null && shownHist !== undefined
                ? shownHist >= 0
                  ? 'text-[var(--positive)]'
                  : 'text-[var(--negative)]'
                : 'text-muted-foreground'
            }
          >
            {formatCompactOsc(shownHist)}
          </strong>
        </span>
        <span className="ml-auto hidden text-[10px] text-[var(--text-subtle)] md:inline">
          {formatDateTime(candles[shownIndex].time, locale)} UTC
        </span>

        <div className="flex shrink-0 items-center gap-0.5">
          {onChangeSettings && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={t('studio.paneSettings', { pane: 'MACD' })}
                  title={t('studio.paneSettings', { pane: 'MACD' })}
                  className="inline-flex size-5 items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground cursor-pointer"
                >
                  <Settings2 className="size-3" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-56 p-3">
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                      {t('studio.paneSettings', { pane: 'MACD' })}
                    </span>
                    {onResetSettings && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={onResetSettings}
                        className="h-5 px-1.5 text-[10px]"
                      >
                        {t('studio.paneReset')}
                      </Button>
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-1.5">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="macd-pane-fast" className="text-[10px]">
                        {t('studio.macdFast')}
                      </Label>
                      <Input
                        id="macd-pane-fast"
                        type="number"
                        min={2}
                        max={50}
                        value={fastPeriod}
                        onChange={(e) => {
                          const v = Number(e.target.value)
                          if (Number.isFinite(v)) {
                            onChangeSettings({ fastPeriod: v })
                          }
                        }}
                        className="h-7 px-2 text-xs"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="macd-pane-slow" className="text-[10px]">
                        {t('studio.macdSlow')}
                      </Label>
                      <Input
                        id="macd-pane-slow"
                        type="number"
                        min={3}
                        max={100}
                        value={slowPeriod}
                        onChange={(e) => {
                          const v = Number(e.target.value)
                          if (Number.isFinite(v)) {
                            onChangeSettings({ slowPeriod: v })
                          }
                        }}
                        className="h-7 px-2 text-xs"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="macd-pane-signal" className="text-[10px]">
                        {t('studio.macdSignal')}
                      </Label>
                      <Input
                        id="macd-pane-signal"
                        type="number"
                        min={2}
                        max={50}
                        value={signalPeriod}
                        onChange={(e) => {
                          const v = Number(e.target.value)
                          if (Number.isFinite(v)) {
                            onChangeSettings({ signalPeriod: v })
                          }
                        }}
                        className="h-7 px-2 text-xs"
                      />
                    </div>
                  </div>

                  <p className="text-[10px] leading-snug text-muted-foreground">
                    {t('studio.paneDisplayOnly')}
                  </p>
                </div>
              </PopoverContent>
            </Popover>
          )}

          {onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-expanded={!collapsed}
              aria-label={
                collapsed
                  ? t('studio.paneExpand', { pane: 'MACD' })
                  : t('studio.paneCollapse', { pane: 'MACD' })
              }
              title={
                collapsed
                  ? t('studio.paneExpand', { pane: 'MACD' })
                  : t('studio.paneCollapse', { pane: 'MACD' })
              }
              className="inline-flex size-5 items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground cursor-pointer"
            >
              {collapsed ? (
                <ChevronUp className="size-3" />
              ) : (
                <ChevronDown className="size-3" />
              )}
            </button>
          )}

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t('studio.paneClose', { pane: 'MACD' })}
              title={t('studio.paneClose', { pane: 'MACD' })}
              className="inline-flex size-5 items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:bg-muted/55 hover:text-[var(--negative)] cursor-pointer"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>

      {!collapsed && width > 0 && (
        <svg
          className="chart__svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${macdTitle} oscillator panel`}
          onPointerMove={handlePointer}
          onPointerDown={handlePointer}
          onPointerLeave={handlePointerLeave}
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

          <line
            className="macd__zero"
            x1={MARGIN.left}
            x2={MARGIN.left + plotWidth}
            y1={yZero}
            y2={yZero}
          />

          {[absMax * 0.75, 0, -absMax * 0.75].map((tick) => (
            <text
              key={tick}
              className="chart__label"
              x={MARGIN.left + plotWidth + 8}
              y={yOf(tick)}
              textAnchor="start"
              dominantBaseline="middle"
            >
              {formatCompactOsc(tick)}
            </text>
          ))}

          <line
            className="chart__axis-border"
            x1={MARGIN.left + plotWidth}
            x2={MARGIN.left + plotWidth}
            y1={MARGIN.top}
            y2={MARGIN.top + plotHeight}
          />

          <g clipPath={`url(#${clipId})`}>
            <g ref={panLayerRef} className="chart__pan-layer">
              {histPaths.up && <path className="macd__bar--up" d={histPaths.up} />}
              {histPaths.upFade && (
                <path className="macd__bar--up-fade" d={histPaths.upFade} />
              )}
              {histPaths.down && (
                <path className="macd__bar--down" d={histPaths.down} />
              )}
              {histPaths.downFade && (
                <path className="macd__bar--down-fade" d={histPaths.downFade} />
              )}

              {macdPoints && <polyline className="macd__line" points={macdPoints} />}
              {signalPoints && (
                <polyline className="macd__signal" points={signalPoints} />
              )}
            </g>
          </g>

          {shownMacd !== null &&
            shownMacd !== undefined &&
            staticValueY !== null &&
            !hideStaticPill && (
              <g>
                <rect
                  className="chart__axis-pill"
                  x={MARGIN.left + plotWidth + 4}
                  y={staticValueY - 9}
                  width={MARGIN.right - 8}
                  height={18}
                  rx={3}
                />
                <text
                  className="chart__axis-pill-text"
                  x={MARGIN.left + plotWidth + 8}
                  y={staticValueY}
                  dominantBaseline="middle"
                >
                  {formatCompactOsc(shownMacd)}
                </text>
              </g>
            )}

          {activeIndex !== null && (
            <g pointerEvents="none">
              <line
                className="chart__cursor"
                x1={xOf(shownIndex)}
                x2={xOf(shownIndex)}
                y1={MARGIN.top}
                y2={MARGIN.top + plotHeight}
              />
              {crosshairY !== null && crosshairValue !== null && (
                <>
                  <line
                    className="chart__cursor chart__cursor--horizontal"
                    x1={MARGIN.left}
                    x2={MARGIN.left + plotWidth}
                    y1={crosshairY}
                    y2={crosshairY}
                  />
                  <rect
                    className="chart__axis-pill--crosshair"
                    x={MARGIN.left + plotWidth + 4}
                    y={crosshairY - 9}
                    width={MARGIN.right - 8}
                    height={18}
                    rx={3}
                  />
                  <text
                    className="chart__axis-pill-text--crosshair"
                    x={MARGIN.left + plotWidth + 8}
                    y={crosshairY}
                    dominantBaseline="middle"
                  >
                    {formatCompactOsc(crosshairValue)}
                  </text>
                </>
              )}
            </g>
          )}
        </svg>
      )}
    </div>
  )
}

export default memo(MacdPanel)
