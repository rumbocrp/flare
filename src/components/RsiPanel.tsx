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
import { formatDateTime, formatOrDash } from '../format'
import { useElementWidth } from '../hooks/useElementWidth'
import { useI18n, type Translate } from '../i18n'
import type { Series } from '../indicators'
import type { Candle, RsiPaneSettings } from '../types'

type RsiPanelProps = {
  candles: Candle[]
  values: Series
  overscanLeftValues?: Series
  overscanRightValues?: Series
  period: number
  overbought?: number
  oversold?: number
  activeIndex?: number | null
  onActiveIndexChange?: (index: number | null) => void
  crosshairChannel?: CrosshairChannel
  panTransformChannel?: PanTransformChannel
  height?: number
  compactHeader?: boolean
  collapsed?: boolean
  onToggleCollapse?: () => void
  onClose?: () => void
  onChangeSettings?: (patch: Partial<RsiPaneSettings>) => void
  onResetSettings?: () => void
}

const DEFAULT_HEIGHT = 80
const MARGIN = {
  top: 8,
  bottom: 10,
  left: STUDIO_PLOT_MARGIN.left,
  right: STUDIO_PLOT_MARGIN.right,
}
const MID_LEVEL = 50

function zoneLabel(
  value: number | null,
  overbought: number,
  oversold: number,
  t: Translate,
): string {
  if (value === null) return ''
  if (value >= overbought) return t('chart.rsiHigh', { level: overbought })
  if (value <= oversold) return t('chart.rsiLow', { level: oversold })
  return ''
}

function RsiPanel({
  candles,
  values,
  overscanLeftValues,
  overscanRightValues,
  period,
  overbought = 70,
  oversold = 30,
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
}: RsiPanelProps) {
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

  const count = values.length
  const lastIndex = Math.max(0, count - 1)
  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right)
  const plotHeight = Math.max(24, height - MARGIN.top - MARGIN.bottom)
  const slot = count > 0 ? plotWidth / count : 0

  const linePoints = useMemo(() => {
    if (collapsed || count < 2 || plotWidth <= 0) return ''
    const parts: string[] = []
    const pushPoint = (idx: number, value: number | null) => {
      if (value === null) return
      const x = MARGIN.left + (idx + 0.5) * slot
      const y = MARGIN.top + (1 - value / 100) * plotHeight
      parts.push(`${x.toFixed(1)},${y.toFixed(1)}`)
    }
    if (overscanLeftValues) {
      const leftLen = overscanLeftValues.length
      for (let i = 0; i < leftLen; i++) {
        pushPoint(i - leftLen, overscanLeftValues[i])
      }
    }
    for (let index = 0; index < count; index++) {
      pushPoint(index, values[index])
    }
    if (overscanRightValues) {
      for (let i = 0; i < overscanRightValues.length; i++) {
        pushPoint(count + i, overscanRightValues[i])
      }
    }
    return parts.join(' ')
  }, [
    collapsed,
    count,
    overscanLeftValues,
    overscanRightValues,
    plotHeight,
    plotWidth,
    slot,
    values,
  ])

  if (count < 2 || candles.length !== count) {
    return (
      <div
        className="chart"
        ref={containerRef}
        role="region"
        aria-label={t('chart.rsiAria', { period })}
      >
        <p className="chart__empty">{t('chart.noRsiData')}</p>
      </div>
    )
  }

  function xOf(index: number): number {
    return MARGIN.left + (index + 0.5) * slot
  }

  function yOf(value: number): number {
    const clamped = Math.max(0, Math.min(100, value))
    return MARGIN.top + (1 - clamped / 100) * plotHeight
  }

  const shownIndex = Math.min(activeIndex ?? lastIndex, lastIndex)
  const shownValue = values[shownIndex]
  const valueTone =
    shownValue === null || shownValue === undefined
      ? ''
      : shownValue >= overbought
        ? 'text-[var(--negative)]'
        : shownValue <= oversold
          ? 'text-[var(--positive)]'
          : 'text-foreground'

  const crosshairValue =
    activeIndex !== null
      ? (hoverVal ?? (shownValue !== undefined ? shownValue : null))
      : null
  const crosshairY = crosshairValue !== null ? yOf(crosshairValue) : null
  const staticValueY =
    shownValue !== null && shownValue !== undefined ? yOf(shownValue) : null
  const hideStaticPill =
    crosshairY !== null &&
    staticValueY !== null &&
    Math.abs(crosshairY - staticValueY) < 18

  function handlePointer(event: ReactPointerEvent<SVGSVGElement>) {
    if (slot <= 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const index = Math.floor((event.clientX - rect.left - MARGIN.left) / slot)
    const clampedIdx = Math.min(lastIndex, Math.max(0, index))
    const relY = Math.max(MARGIN.top, Math.min(MARGIN.top + plotHeight, event.clientY - rect.top))
    const yVal = (1 - (relY - MARGIN.top) / plotHeight) * 100

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

  const zoneText = zoneLabel(shownValue ?? null, overbought, oversold, t)

  return (
    <div
      className={compactHeader ? 'chart !px-2 !py-1' : 'chart'}
      ref={containerRef}
      role="region"
      aria-label={t('chart.rsiAria', { period })}
    >
      <div
        className={
          compactHeader
            ? 'mb-0.5 flex h-5 items-center gap-2 font-mono text-[10.5px] leading-tight tabular-nums text-muted-foreground'
            : 'mb-1 flex flex-wrap items-center gap-2 font-mono text-[11px] tabular-nums text-muted-foreground'
        }
      >
        <span className="font-semibold text-foreground/85">RSI ({period})</span>
        <strong className={valueTone}>
          {formatOrDash(shownValue, (value) => value.toFixed(1))}
        </strong>
        {zoneText && (
          <span className="hidden sm:inline text-[10px] text-primary">
            {zoneText}
          </span>
        )}
        <span className="ml-auto hidden text-[10px] text-[var(--text-subtle)] md:inline">
          {formatDateTime(candles[shownIndex].time, locale)} UTC
        </span>

        <div className="flex shrink-0 items-center gap-0.5">
          {onChangeSettings && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={t('studio.paneSettings', { pane: 'RSI' })}
                  title={t('studio.paneSettings', { pane: 'RSI' })}
                  className="inline-flex size-5 items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground cursor-pointer"
                >
                  <Settings2 className="size-3" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-56 p-3">
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                      {t('studio.paneSettings', { pane: 'RSI' })}
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
                      <Label htmlFor="rsi-pane-period" className="text-[10px]">
                        {t('studio.rsiPeriod')}
                      </Label>
                      <Input
                        id="rsi-pane-period"
                        type="number"
                        min={2}
                        max={50}
                        value={period}
                        onChange={(e) => {
                          const v = Number(e.target.value)
                          if (Number.isFinite(v)) onChangeSettings({ period: v })
                        }}
                        className="h-7 px-2 text-xs"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="rsi-pane-ob" className="text-[10px]">
                        {t('studio.rsiOverbought')}
                      </Label>
                      <Input
                        id="rsi-pane-ob"
                        type="number"
                        min={55}
                        max={95}
                        value={overbought}
                        onChange={(e) => {
                          const v = Number(e.target.value)
                          if (Number.isFinite(v)) {
                            onChangeSettings({ overbought: v })
                          }
                        }}
                        className="h-7 px-2 text-xs"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="rsi-pane-os" className="text-[10px]">
                        {t('studio.rsiOversold')}
                      </Label>
                      <Input
                        id="rsi-pane-os"
                        type="number"
                        min={5}
                        max={45}
                        value={oversold}
                        onChange={(e) => {
                          const v = Number(e.target.value)
                          if (Number.isFinite(v)) {
                            onChangeSettings({ oversold: v })
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
                  ? t('studio.paneExpand', { pane: 'RSI' })
                  : t('studio.paneCollapse', { pane: 'RSI' })
              }
              title={
                collapsed
                  ? t('studio.paneExpand', { pane: 'RSI' })
                  : t('studio.paneCollapse', { pane: 'RSI' })
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
              aria-label={t('studio.paneClose', { pane: 'RSI' })}
              title={t('studio.paneClose', { pane: 'RSI' })}
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
          aria-label={t('chart.rsiAria', { period })}
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
          <rect
            className="rsi__zone"
            x={MARGIN.left}
            y={yOf(overbought)}
            width={plotWidth}
            height={Math.max(0, yOf(oversold) - yOf(overbought))}
          />

          {[overbought, MID_LEVEL, oversold].map((level) => (
            <g key={level}>
              <line
                className="chart__grid"
                x1={MARGIN.left}
                x2={MARGIN.left + plotWidth}
                y1={yOf(level)}
                y2={yOf(level)}
              />
              <text
                className="chart__label"
                x={MARGIN.left + plotWidth + 8}
                y={yOf(level)}
                textAnchor="start"
                dominantBaseline="middle"
              >
                {level}
              </text>
            </g>
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
              <polyline className="rsi__line" points={linePoints} />
            </g>
          </g>

          {shownValue !== null &&
            shownValue !== undefined &&
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
                  {shownValue.toFixed(1)}
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
                    {crosshairValue.toFixed(1)}
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

export default memo(RsiPanel)
