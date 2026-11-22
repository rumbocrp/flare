import { useId, useState, type PointerEvent as ReactPointerEvent } from 'react'
import './EquityChart.css'
import { useElementWidth } from '../hooks/useElementWidth'
import { niceTicks } from '../chart'
import { formatMoney, formatMoneyWhole, formatSignedMoney } from '../format'
import { useI18n } from '../i18n'
import { cn } from '@/lib/utils'
import type { ChartPoint } from '../types'

type EquityChartProps = {
  points: ChartPoint[]
  height?: number
  className?: string
}

const DEFAULT_HEIGHT = 260
const MARGIN = { top: 16, right: 16, bottom: 28, left: 72 }

function changeClass(change: number): string {
  if (change > 0) return 'chart__change--positive'
  if (change < 0) return 'chart__change--negative'
  return ''
}

function EquityChart({
  points,
  height = DEFAULT_HEIGHT,
  className,
}: EquityChartProps) {
  const { t } = useI18n()
  const gradientId = useId()
  const [containerRef, width] = useElementWidth<HTMLDivElement>()
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  if (points.length < 2) {
    return (
      <div className={cn('chart', className)} ref={containerRef}>
        <p className="chart__empty">
          {t('chart.needPoints')}
        </p>
      </div>
    )
  }

  const lastIndex = points.length - 1
  const values = points.map((point) => point.value)
  const ticks = niceTicks(Math.min(...values), Math.max(...values), 4)
  const yMin = ticks[0]
  const yMax = ticks[ticks.length - 1]

  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right)
  const plotHeight = height - MARGIN.top - MARGIN.bottom
  const yBottom = MARGIN.top + plotHeight

  function xOf(index: number): number {
    return MARGIN.left + (index / lastIndex) * plotWidth
  }

  function yOf(value: number): number {
    return MARGIN.top + (1 - (value - yMin) / (yMax - yMin)) * plotHeight
  }

  const coords = points.map((point, index) => `${xOf(index)},${yOf(point.value)}`)
  const linePoints = coords.join(' ')
  const areaPath = `M ${xOf(0)},${yBottom} L ${coords.join(' L ')} L ${xOf(lastIndex)},${yBottom} Z`

  const shownIndex = Math.min(activeIndex ?? lastIndex, lastIndex)
  const shown = points[shownIndex]
  const change = shown.value - points[0].value

  function handlePointer(event: ReactPointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left - MARGIN.left) / plotWidth
    const index = Math.round(ratio * lastIndex)
    setActiveIndex(Math.min(lastIndex, Math.max(0, index)))
  }

  return (
    <div className={cn('chart', className)} ref={containerRef}>
      <p className="chart__readout">
        <strong>{formatMoney(shown.value)}</strong>
        <span className={changeClass(change)}>{formatSignedMoney(change)}</span>
        <span>{shown.label}</span>
      </p>

      {width > 0 && (
        <svg
          className="chart__svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={t('chart.equityAria', {
            from: formatMoney(points[0].value),
            to: formatMoney(points[lastIndex].value),
            count: lastIndex,
          })}
          onPointerMove={handlePointer}
          onPointerDown={handlePointer}
          onPointerLeave={() => setActiveIndex(null)}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="chart__stop--top" />
              <stop offset="100%" className="chart__stop--bottom" />
            </linearGradient>
          </defs>

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
                {formatMoneyWhole(tick)}
              </text>
            </g>
          ))}

          <line
            className="chart__baseline"
            x1={MARGIN.left}
            x2={MARGIN.left + plotWidth}
            y1={yOf(points[0].value)}
            y2={yOf(points[0].value)}
          />

          <path className="chart__area" fill={`url(#${gradientId})`} d={areaPath} />
          <polyline className="chart__line" points={linePoints} />

          <text
            className="chart__label"
            x={xOf(0)}
            y={height - 8}
            textAnchor="start"
          >
            {points[0].label}
          </text>
          <text
            className="chart__label"
            x={xOf(lastIndex)}
            y={height - 8}
            textAnchor="end"
          >
            {points[lastIndex].label}
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

          <circle
            className="chart__dot"
            cx={xOf(shownIndex)}
            cy={yOf(shown.value)}
            r={5}
          />
        </svg>
      )}
    </div>
  )
}

export default EquityChart
