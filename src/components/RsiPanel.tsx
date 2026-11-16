import { useState, type PointerEvent as ReactPointerEvent } from 'react'
import './EquityChart.css'
import './CandleChart.css'
import { useElementWidth } from '../hooks/useElementWidth'
import { STUDIO_PLOT_MARGIN } from '../chartLayout'
import { formatDateTime, formatOrDash } from '../format'
import { useI18n, type Translate } from '../i18n'
import type { Series } from '../indicators'
import type { Candle } from '../types'

type RsiPanelProps = {
  candles: Candle[]
  values: Series
  period: number
  activeIndex?: number | null
  onActiveIndexChange?: (index: number | null) => void
  height?: number
  compactHeader?: boolean
}

const DEFAULT_HEIGHT = 132
const MARGIN = {
  top: 10,
  bottom: 12,
  left: STUDIO_PLOT_MARGIN.left,
  right: STUDIO_PLOT_MARGIN.right,
}
const LOW_LEVEL = 30
const MID_LEVEL = 50
const HIGH_LEVEL = 70

function zoneLabel(value: number | null, t: Translate): string {
  if (value === null) return ''
  if (value >= HIGH_LEVEL) return t('chart.rsiHigh', { level: HIGH_LEVEL })
  if (value <= LOW_LEVEL) return t('chart.rsiLow', { level: LOW_LEVEL })
  return ''
}

function RsiPanel({
  candles,
  values,
  period,
  activeIndex: controlledActiveIndex,
  onActiveIndexChange,
  height = DEFAULT_HEIGHT,
  compactHeader = false,
}: RsiPanelProps) {
  const { locale, t } = useI18n()
  const [containerRef, width] = useElementWidth<HTMLDivElement>()
  const [internalIndex, setInternalIndex] = useState<number | null>(null)

  const activeIndex =
    controlledActiveIndex !== undefined ? controlledActiveIndex : internalIndex

  function updateActiveIndex(next: number | null) {
    if (onActiveIndexChange) {
      onActiveIndexChange(next)
    } else {
      setInternalIndex(next)
    }
  }

  const count = values.length

  if (count < 2 || candles.length !== count) {
    return (
      <div className="chart" ref={containerRef}>
        <p className="chart__empty">{t('chart.noRsiData')}</p>
      </div>
    )
  }

  const lastIndex = count - 1
  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right)
  const plotHeight = height - MARGIN.top - MARGIN.bottom
  const slot = plotWidth / count

  function xOf(index: number): number {
    return MARGIN.left + (index + 0.5) * slot
  }

  function yOf(value: number): number {
    return MARGIN.top + (1 - value / 100) * plotHeight
  }

  const linePoints = values
    .map((value, index) =>
      value === null ? null : `${xOf(index)},${yOf(value)}`,
    )
    .filter((point): point is string => point !== null)
    .join(' ')

  const shownIndex = Math.min(activeIndex ?? lastIndex, lastIndex)
  const shownValue = values[shownIndex]
  const valueTone =
    shownValue === null || shownValue === undefined
      ? ''
      : shownValue >= HIGH_LEVEL
        ? 'text-[var(--negative)]'
        : shownValue <= LOW_LEVEL
          ? 'text-[var(--positive)]'
          : 'text-foreground'

  function handlePointer(event: ReactPointerEvent<SVGSVGElement>) {
    if (slot <= 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const index = Math.floor((event.clientX - rect.left - MARGIN.left) / slot)
    updateActiveIndex(Math.min(lastIndex, Math.max(0, index)))
  }

  return (
    <div
      className={compactHeader ? 'chart !px-2.5 !py-2' : 'chart'}
      ref={containerRef}
    >
      <div className="mb-1 flex flex-wrap items-center gap-2 font-mono text-[11px] tabular-nums text-muted-foreground">
        <span className="font-semibold text-foreground/85">RSI ({period})</span>
        <strong className={valueTone}>
          {formatOrDash(shownValue, (value) => value.toFixed(1))}
        </strong>
        {zoneLabel(shownValue, t) && (
          <span className="text-[10.5px] text-primary">
            {zoneLabel(shownValue, t)}
          </span>
        )}
        <span className="ml-auto text-[10.5px] text-[var(--text-subtle)]">
          {formatDateTime(candles[shownIndex].time, locale)} UTC
        </span>
      </div>

      {width > 0 && (
        <svg
          className="chart__svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={t('chart.rsiAria', { period })}
          onPointerMove={handlePointer}
          onPointerDown={handlePointer}
          onPointerLeave={() => updateActiveIndex(null)}
        >
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
            y={yOf(HIGH_LEVEL)}
            width={plotWidth}
            height={yOf(LOW_LEVEL) - yOf(HIGH_LEVEL)}
          />

          {[HIGH_LEVEL, MID_LEVEL, LOW_LEVEL].map((level) => (
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

          <polyline className="rsi__line" points={linePoints} />

          {shownValue !== null && shownValue !== undefined && (
            <g>
              <rect
                className="chart__axis-pill"
                x={MARGIN.left + plotWidth + 4}
                y={yOf(shownValue) - 9}
                width={MARGIN.right - 8}
                height={18}
                rx={3}
              />
              <text
                className="chart__axis-pill-text"
                x={MARGIN.left + plotWidth + 8}
                y={yOf(shownValue)}
                dominantBaseline="middle"
              >
                {shownValue.toFixed(1)}
              </text>
            </g>
          )}

          {activeIndex !== null && (
            <line
              className="chart__cursor"
              x1={xOf(shownIndex)}
              x2={xOf(shownIndex)}
              y1={MARGIN.top}
              y2={MARGIN.top + plotHeight}
            />
          )}
        </svg>
      )}
    </div>
  )
}

export default RsiPanel
