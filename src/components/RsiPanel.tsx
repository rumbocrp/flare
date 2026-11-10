import { useState, type PointerEvent as ReactPointerEvent } from 'react'
import './EquityChart.css'
import './CandleChart.css'
import { useElementWidth } from '../hooks/useElementWidth'
import { PLOT_X } from '../chartLayout'
import { formatDateTime, formatOrDash } from '../format'
import type { Series } from '../indicators'
import type { Candle } from '../types'

type RsiPanelProps = {
  candles: Candle[]
  values: Series
  period: number
}

const HEIGHT = 140
const MARGIN = { top: 12, bottom: 12, ...PLOT_X }
const LOW_LEVEL = 30
const HIGH_LEVEL = 70

function zoneLabel(value: number | null): string {
  if (value === null) return ''
  if (value >= HIGH_LEVEL) return `Zona alta (≥ ${HIGH_LEVEL})`
  if (value <= LOW_LEVEL) return `Zona baja (≤ ${LOW_LEVEL})`
  return ''
}

function RsiPanel({ candles, values, period }: RsiPanelProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>()
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  const count = values.length

  if (count < 2 || candles.length !== count) {
    return (
      <div className="chart" ref={containerRef}>
        <p className="chart__empty">No hay datos suficientes para el RSI.</p>
      </div>
    )
  }

  const lastIndex = count - 1
  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right)
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom
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

  function handlePointer(event: ReactPointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    const index = Math.floor((event.clientX - rect.left - MARGIN.left) / slot)
    setActiveIndex(Math.min(lastIndex, Math.max(0, index)))
  }

  return (
    <div className="chart" ref={containerRef}>
      <p className="chart__readout">
        <span>RSI {period}:</span>
        <strong>{formatOrDash(shownValue, (value) => value.toFixed(1))}</strong>
        <span>{zoneLabel(shownValue)}</span>
        <span>{formatDateTime(candles[shownIndex].time)} UTC</span>
      </p>

      {width > 0 && (
        <svg
          className="chart__svg"
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-label={`Panel de RSI de ${period} periodos`}
          onPointerMove={handlePointer}
          onPointerDown={handlePointer}
          onPointerLeave={() => setActiveIndex(null)}
        >
          <rect
            className="rsi__zone"
            x={MARGIN.left}
            y={yOf(HIGH_LEVEL)}
            width={plotWidth}
            height={yOf(LOW_LEVEL) - yOf(HIGH_LEVEL)}
          />

          {[HIGH_LEVEL, LOW_LEVEL].map((level) => (
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
                x={MARGIN.left - 8}
                y={yOf(level)}
                textAnchor="end"
                dominantBaseline="middle"
              >
                {level}
              </text>
            </g>
          ))}

          <polyline className="rsi__line" points={linePoints} />

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