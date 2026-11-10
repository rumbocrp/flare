import { useState, type PointerEvent as ReactPointerEvent } from 'react'
import './EquityChart.css'
import './CandleChart.css'
import { useElementWidth } from '../hooks/useElementWidth'
import { niceTicks } from '../chart'
import { PLOT_X } from '../chartLayout'
import { formatDateTime, formatPercent, formatPrice } from '../format'
import type { Candle, ChartOverlay, Signal } from '../types'

type CandleChartProps = {
  candles: Candle[]
  overlays?: ChartOverlay[]
  signals?: Signal[]
}

const HEIGHT = 320
const MARGIN = { top: 16, bottom: 28, ...PLOT_X }
const MARKER_GAP = 6
const MARKER_SIZE = 8

function changeClass(change: number): string {
  if (change > 0) return 'chart__change--positive'
  if (change < 0) return 'chart__change--negative'
  return ''
}

function CandleChart({
  candles,
  overlays = [],
  signals = [],
}: CandleChartProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>()
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  if (candles.length === 0) {
    return (
      <div className="chart" ref={containerRef}>
        <p className="chart__empty">No hay velas para mostrar.</p>
      </div>
    )
  }

  const count = candles.length
  const lastIndex = count - 1
  const ticks = niceTicks(
    Math.min(...candles.map((candle) => candle.low)),
    Math.max(...candles.map((candle) => candle.high)),
    5,
  )
  const yMin = ticks[0]
  const yMax = ticks[ticks.length - 1]

  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right)
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom
  const yBottom = MARGIN.top + plotHeight
  const slot = plotWidth / count
  const bodyWidth = Math.max(1, Math.min(14, slot * 0.7))

  function xOf(index: number): number {
    return MARGIN.left + (index + 0.5) * slot
  }

  function yOf(value: number): number {
    return MARGIN.top + (1 - (value - yMin) / (yMax - yMin)) * plotHeight
  }

  const shownIndex = Math.min(activeIndex ?? lastIndex, lastIndex)
  const shown = candles[shownIndex]
  const change = ((shown.close - shown.open) / shown.open) * 100

  const description = `Gráfico de velas de ${count} velas, de ${formatDateTime(candles[0].time)} a ${formatDateTime(candles[lastIndex].time)} UTC${
    signals.length > 0 ? `, con ${signals.length} señales` : ''
  }`

  function handlePointer(event: ReactPointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    const index = Math.floor((event.clientX - rect.left - MARGIN.left) / slot)
    setActiveIndex(Math.min(lastIndex, Math.max(0, index)))
  }

  return (
    <div className="chart" ref={containerRef}>
      <p className="chart__readout">
        <strong>{formatPrice(shown.close)}</strong>
        <span className={changeClass(change)}>
          {change > 0 ? '+' : ''}
          {formatPercent(change, 2)}
        </span>
        <span className="chart__ohlc">
          O {formatPrice(shown.open)} · H {formatPrice(shown.high)} · L{' '}
          {formatPrice(shown.low)} · C {formatPrice(shown.close)}
        </span>
        <span>{formatDateTime(shown.time)} UTC</span>
      </p>

      {(overlays.length > 0 || signals.length > 0) && (
        <p className="chart__legend">
          {overlays.map((overlay) => (
            <span key={overlay.id}>
              <span className={`chart__swatch chart__swatch--${overlay.kind}`} />
              {overlay.label}
            </span>
          ))}
          {signals.length > 0 && (
            <>
              <span>
                <span className="legend__buy">▲</span> Compra
              </span>
              <span>
                <span className="legend__sell">▼</span> Venta
              </span>
            </>
          )}
        </p>
      )}

      {width > 0 && (
        <svg
          className="chart__svg"
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-label={description}
          onPointerMove={handlePointer}
          onPointerDown={handlePointer}
          onPointerLeave={() => setActiveIndex(null)}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                className="chart__grid"
                x1={MARGIN.left}
                x2={MARGIN.left + plotWidth}
                y1={yOf(tick)}
                y2={yOf(tick)}
              />
              <text
                className="chart__label"
                x={MARGIN.left - 8}
                y={yOf(tick)}
                textAnchor="end"
                dominantBaseline="middle"
              >
                {formatPrice(tick)}
              </text>
            </g>
          ))}

          {candles.map((candle, index) => {
            const isUp = candle.close >= candle.open
            const x = xOf(index)
            const bodyTop = yOf(Math.max(candle.open, candle.close))
            const bodyBottom = yOf(Math.min(candle.open, candle.close))

            return (
              <g
                key={candle.time}
                className={isUp ? 'candle candle--up' : 'candle candle--down'}
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
                  height={Math.max(1, bodyBottom - bodyTop)}
                />
              </g>
            )
          })}

          {overlays.map((overlay) => {
            const points = overlay.values
              .map((value, index) =>
                value === null ? null : `${xOf(index)},${yOf(value)}`,
              )
              .filter((point): point is string => point !== null)
              .join(' ')

            return (
              <polyline
                key={overlay.id}
                className={`overlay overlay--${overlay.kind}`}
                points={points}
              />
            )
          })}

          {signals.map((signal) => {
            const candle = candles[signal.index]
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

          <text
            className="chart__label"
            x={MARGIN.left}
            y={HEIGHT - 8}
            textAnchor="start"
          >
            {formatDateTime(candles[0].time)}
          </text>
          <text
            className="chart__label"
            x={MARGIN.left + plotWidth}
            y={HEIGHT - 8}
            textAnchor="end"
          >
            {formatDateTime(candles[lastIndex].time)}
          </text>

          {activeIndex !== null && (
            <line
              className="chart__cursor"
              x1={xOf(shownIndex)}
              x2={xOf(shownIndex)}
              y1={MARGIN.top}
              y2={yBottom}
            />
          )}
        </svg>
      )}
    </div>
  )
}

export default CandleChart