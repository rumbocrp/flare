import { useState, type PointerEvent as ReactPointerEvent } from 'react'
import './EquityChart.css'
import './CandleChart.css'
import { useElementWidth } from '../hooks/useElementWidth'
import { STUDIO_PLOT_MARGIN } from '../chartLayout'
import { formatDateTime } from '../format'
import { useI18n } from '../i18n'
import type { Series } from '../indicators'
import type { Candle } from '../types'

type MacdPanelProps = {
  candles: Candle[]
  macdLine: Series
  signalLine: Series
  histogram: Series
  activeIndex?: number | null
  onActiveIndexChange?: (index: number | null) => void
  height?: number
  compactHeader?: boolean
}

const DEFAULT_HEIGHT = 128
const MARGIN = {
  top: 10,
  bottom: 12,
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
  activeIndex: controlledActiveIndex,
  onActiveIndexChange,
  height = DEFAULT_HEIGHT,
  compactHeader = false,
}: MacdPanelProps) {
  const { locale } = useI18n()
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

  const count = candles.length
  if (count < 2 || macdLine.length !== count) {
    return null
  }

  const validVals: number[] = [0]
  for (let i = 0; i < count; i++) {
    if (macdLine[i] !== null) validVals.push(macdLine[i]!)
    if (signalLine[i] !== null) validVals.push(signalLine[i]!)
    if (histogram[i] !== null) validVals.push(histogram[i]!)
  }
  const absMax = Math.max(
    1e-6,
    ...validVals.map((v) => Math.abs(v)),
  )
  const yMin = -absMax * 1.12
  const yMax = absMax * 1.12
  const ySpan = yMax - yMin

  const lastIndex = count - 1
  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right)
  const plotHeight = height - MARGIN.top - MARGIN.bottom
  const slot = plotWidth / count
  const barWidth = Math.max(1.5, Math.min(12, slot * 0.68))

  function xOf(index: number): number {
    return MARGIN.left + (index + 0.5) * slot
  }

  function yOf(value: number): number {
    return MARGIN.top + (1 - (value - yMin) / ySpan) * plotHeight
  }

  const yZero = yOf(0)

  const macdPoints = macdLine
    .map((v, i) => (v === null ? null : `${xOf(i)},${yOf(v)}`))
    .filter((pt): pt is string => pt !== null)
    .join(' ')

  const signalPoints = signalLine
    .map((v, i) => (v === null ? null : `${xOf(i)},${yOf(v)}`))
    .filter((pt): pt is string => pt !== null)
    .join(' ')

  const shownIndex = Math.min(activeIndex ?? lastIndex, lastIndex)
  const shownMacd = macdLine[shownIndex]
  const shownSignal = signalLine[shownIndex]
  const shownHist = histogram[shownIndex]

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
      <div className="mb-1 flex flex-wrap items-center gap-2.5 font-mono text-[11px] tabular-nums text-muted-foreground">
        <span className="font-semibold text-foreground/85">MACD (12, 26, 9)</span>
        <span>
          DIF <strong className="text-[#38bdf8]">{formatCompactOsc(shownMacd)}</strong>
        </span>
        <span>
          DEA{' '}
          <strong className="text-[var(--brand)]">
            {formatCompactOsc(shownSignal)}
          </strong>
        </span>
        <span>
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
          aria-label="MACD (12, 26, 9) oscillator panel"
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

          {histogram.map((h, i) => {
            if (h === null) return null
            const prevH = i > 0 ? histogram[i - 1] : null
            const widening =
              prevH !== null && Math.abs(h) >= Math.abs(prevH)
            const cls =
              h >= 0
                ? widening
                  ? 'macd__bar--up'
                  : 'macd__bar--up-fade'
                : widening
                  ? 'macd__bar--down'
                  : 'macd__bar--down-fade'
            const yTop = h >= 0 ? yOf(h) : yZero
            const hPx = Math.max(1, Math.abs(yOf(h) - yZero))
            return (
              <rect
                key={`hist-${candles[i].time}`}
                className={cls}
                x={xOf(i) - barWidth / 2}
                y={yTop}
                width={barWidth}
                height={hPx}
              />
            )
          })}

          {macdPoints && <polyline className="macd__line" points={macdPoints} />}
          {signalPoints && (
            <polyline className="macd__signal" points={signalPoints} />
          )}

          {shownMacd !== null && shownMacd !== undefined && (
            <g>
              <rect
                className="chart__axis-pill"
                x={MARGIN.left + plotWidth + 4}
                y={yOf(shownMacd) - 9}
                width={MARGIN.right - 8}
                height={18}
                rx={3}
              />
              <text
                className="chart__axis-pill-text"
                x={MARGIN.left + plotWidth + 8}
                y={yOf(shownMacd)}
                dominantBaseline="middle"
              >
                {formatCompactOsc(shownMacd)}
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

export default MacdPanel
