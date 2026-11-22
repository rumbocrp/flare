import { memo, useId, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { niceTicks } from '@/chart'
import {
  formatDateTime,
  formatMoney,
  formatMoneyWhole,
  formatPercent,
  formatSignedMoney,
} from '@/format'
import { useElementWidth } from '@/hooks/useElementWidth'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { TrainingEquityPoint, TrainingRunRecord } from '@/training/types'

type EquityTabProps = {
  run: TrainingRunRecord | null
}

const EQ_HEIGHT = 250
const DD_HEIGHT = 140
const MARGIN = { top: 14, right: 16, bottom: 26, left: 72 }

function downsamplePoints(
  points: readonly TrainingEquityPoint[],
  maxPoints = 360,
): TrainingEquityPoint[] {
  if (points.length <= maxPoints) return [...points]
  const step = (points.length - 1) / (maxPoints - 1)
  const out: TrainingEquityPoint[] = []
  for (let i = 0; i < maxPoints; i += 1) {
    out.push(points[Math.round(i * step)])
  }
  return out
}

function EquityTabInner({ run }: EquityTabProps) {
  const { t, locale } = useI18n()
  const eqGradId = useId()
  const ddGradId = useId()
  const [eqWrapRef, eqWidth] = useElementWidth<HTMLDivElement>()
  const [ddWrapRef, ddWidth] = useElementWidth<HTMLDivElement>()
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const points = useMemo(() => downsamplePoints(run?.equity ?? []), [run])

  if (!run || points.length < 2) {
    return (
      <div className="rounded-md bg-card px-6 py-10 text-center text-xs text-[var(--text-subtle)]">
        {t('training.equityEmpty')}
      </div>
    )
  }

  const hasBaseline = points.some((p) => typeof p.baselineEquity === 'number')
  const lastIdx = points.length - 1
  const shownIdx = Math.min(hoverIdx ?? lastIdx, lastIdx)
  const shown = points[shownIdx]
  const initialBal = run.assumptions.initialBalance
  const delta = shown.equity - initialBal

  // Equity Y bounds including optional baseline overlay
  const eqVals: number[] = [initialBal]
  for (const p of points) {
    eqVals.push(p.equity)
    if (typeof p.baselineEquity === 'number') eqVals.push(p.baselineEquity)
  }
  const eqTicks = niceTicks(Math.min(...eqVals), Math.max(...eqVals), 4)
  const eqMin = eqTicks[0]
  const eqMax = eqTicks[eqTicks.length - 1]
  const eqPlotW = Math.max(0, eqWidth - MARGIN.left - MARGIN.right)
  const eqPlotH = EQ_HEIGHT - MARGIN.top - MARGIN.bottom
  const eqBottom = MARGIN.top + eqPlotH

  const eqX = (i: number) => MARGIN.left + (i / lastIdx) * eqPlotW
  const eqY = (v: number) =>
    MARGIN.top + (1 - (v - eqMin) / Math.max(1e-6, eqMax - eqMin)) * eqPlotH

  const eqCoords = points.map((p, i) => `${eqX(i)},${eqY(p.equity)}`)
  const eqLine = eqCoords.join(' ')
  const eqArea = `M ${eqX(0)},${eqBottom} L ${eqCoords.join(' L ')} L ${eqX(lastIdx)},${eqBottom} Z`
  const baseLine = hasBaseline
    ? points
        .map((p, i) => `${eqX(i)},${eqY(p.baselineEquity ?? p.equity)}`)
        .join(' ')
    : ''

  // Drawdown Y bounds (0 at top, max DD at bottom)
  const maxDd = Math.max(1, ...points.map((p) => p.drawdownPct))
  const ddTicks = niceTicks(0, maxDd, 3)
  const ddMax = Math.max(1, ddTicks[ddTicks.length - 1])
  const ddPlotW = Math.max(0, ddWidth - MARGIN.left - MARGIN.right)
  const ddPlotH = DD_HEIGHT - MARGIN.top - MARGIN.bottom
  const ddX = (i: number) => MARGIN.left + (i / lastIdx) * ddPlotW
  const ddY = (pct: number) => MARGIN.top + (pct / ddMax) * ddPlotH

  const ddCoords = points.map((p, i) => `${ddX(i)},${ddY(p.drawdownPct)}`)
  const ddLine = ddCoords.join(' ')
  const ddArea = `M ${ddX(0)},${MARGIN.top} L ${ddCoords.join(' L ')} L ${ddX(lastIdx)},${MARGIN.top} Z`

  const handlePointer = (
    event: ReactPointerEvent<SVGSVGElement>,
    plotW: number,
  ) => {
    if (plotW <= 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left - MARGIN.left) / plotW
    const idx = Math.round(ratio * lastIdx)
    setHoverIdx(Math.min(lastIdx, Math.max(0, idx)))
  }

  return (
    <div className="flex flex-col gap-4">
      {/* OOS Equity Chart in fixed-height wrapper */}
      <section className="rounded-md bg-card p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-foreground">
            {t('training.equityChartTitle')}
          </h3>
          <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] tabular-nums">
            <strong className="text-sm text-foreground">
              {formatMoney(shown.equity)}
            </strong>
            <span
              className={cn(
                delta > 0
                  ? 'text-[var(--positive)]'
                  : delta < 0
                    ? 'text-[var(--negative)]'
                    : 'text-muted-foreground',
              )}
            >
              {formatSignedMoney(delta)}
            </span>
            {hasBaseline && typeof shown.baselineEquity === 'number' && (
              <span className="text-[var(--text-subtle)]">
                {t('training.equityBaselineLegend')}:{' '}
                {formatMoney(shown.baselineEquity)}
              </span>
            )}
            <span className="text-[var(--text-subtle)]">
              {formatDateTime(shown.time, locale)}
            </span>
          </div>
        </div>

        {/* Fixed-height chart container prevents layout shift */}
        <div ref={eqWrapRef} className="h-[250px] w-full">
          {eqWidth > 0 && (
            <svg
              width={eqWidth}
              height={EQ_HEIGHT}
              viewBox={`0 0 ${eqWidth} ${EQ_HEIGHT}`}
              className="block max-w-full touch-pan-y"
              role="img"
              aria-label={t('training.equityChartTitle')}
              onPointerMove={(e) => handlePointer(e, eqPlotW)}
              onPointerDown={(e) => handlePointer(e, eqPlotW)}
              onPointerLeave={() => setHoverIdx(null)}
            >
              <defs>
                <linearGradient id={eqGradId} x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    style={{
                      stopColor:
                        delta >= 0 ? 'var(--positive)' : 'var(--negative)',
                      stopOpacity: 0.18,
                    }}
                  />
                  <stop
                    offset="100%"
                    style={{
                      stopColor:
                        delta >= 0 ? 'var(--positive)' : 'var(--negative)',
                      stopOpacity: 0,
                    }}
                  />
                </linearGradient>
              </defs>

              {eqTicks.map((tick) => (
                <g key={tick}>
                  <line
                    x1={MARGIN.left}
                    x2={MARGIN.left + eqPlotW}
                    y1={eqY(tick)}
                    y2={eqY(tick)}
                    style={{
                      stroke: 'var(--chart-axis)',
                      strokeDasharray: '3 4',
                      opacity: 0.45,
                    }}
                  />
                  <text
                    x={MARGIN.left - 8}
                    y={eqY(tick)}
                    textAnchor="end"
                    dominantBaseline="middle"
                    style={{
                      fill: 'var(--text-subtle)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '9.5px',
                    }}
                  >
                    {formatMoneyWhole(tick)}
                  </text>
                </g>
              ))}

              <line
                x1={MARGIN.left}
                x2={MARGIN.left + eqPlotW}
                y1={eqY(initialBal)}
                y2={eqY(initialBal)}
                style={{ stroke: 'var(--chart-baseline)', strokeDasharray: '2 4' }}
              />

              <path d={eqArea} fill={`url(#${eqGradId})`} />

              {hasBaseline && (
                <polyline
                  points={baseLine}
                  fill="none"
                  style={{
                    stroke: 'var(--text-subtle)',
                    strokeWidth: 1.25,
                    strokeDasharray: '4 3',
                    opacity: 0.75,
                  }}
                />
              )}

              <polyline
                points={eqLine}
                fill="none"
                style={{
                  stroke: delta >= 0 ? 'var(--positive)' : 'var(--negative)',
                  strokeWidth: 1.75,
                  strokeLinejoin: 'round',
                  strokeLinecap: 'round',
                }}
              />

              <text
                x={eqX(0)}
                y={EQ_HEIGHT - 8}
                textAnchor="start"
                style={{
                  fill: 'var(--text-subtle)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '9.5px',
                }}
              >
                {formatDateTime(points[0].time, locale)}
              </text>
              <text
                x={eqX(lastIdx)}
                y={EQ_HEIGHT - 8}
                textAnchor="end"
                style={{
                  fill: 'var(--text-subtle)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '9.5px',
                }}
              >
                {formatDateTime(points[lastIdx].time, locale)}
              </text>

              {hoverIdx !== null && (
                <line
                  x1={eqX(shownIdx)}
                  x2={eqX(shownIdx)}
                  y1={MARGIN.top}
                  y2={eqBottom}
                  style={{ stroke: 'var(--chart-axis)' }}
                />
              )}
              <circle
                cx={eqX(shownIdx)}
                cy={eqY(shown.equity)}
                r={4.5}
                style={{
                  fill: delta >= 0 ? 'var(--positive)' : 'var(--negative)',
                  stroke: 'var(--surface)',
                  strokeWidth: 2,
                }}
              />
            </svg>
          )}
        </div>

        {hasBaseline && (
          <div className="mt-2 flex items-center gap-4 text-[11px] text-[var(--text-subtle)]">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4 bg-[var(--positive)]" />
              <span>{t('training.equityFilteredLegend')}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4 border-t border-dashed border-[var(--text-subtle)]" />
              <span>{t('training.equityBaselineLegend')}</span>
            </span>
          </div>
        )}
      </section>

      {/* Underwater Drawdown Chart in fixed-height wrapper */}
      <section className="rounded-md bg-card p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-foreground">
            {t('training.drawdownChartTitle')}
          </h3>
          <span className="font-mono text-xs font-semibold text-[var(--negative)] tabular-nums">
            -{formatPercent(shown.drawdownPct)}
          </span>
        </div>

        <div ref={ddWrapRef} className="h-[140px] w-full">
          {ddWidth > 0 && (
            <svg
              width={ddWidth}
              height={DD_HEIGHT}
              viewBox={`0 0 ${ddWidth} ${DD_HEIGHT}`}
              className="block max-w-full touch-pan-y"
              role="img"
              aria-label={t('training.drawdownChartTitle')}
              onPointerMove={(e) => handlePointer(e, ddPlotW)}
              onPointerDown={(e) => handlePointer(e, ddPlotW)}
              onPointerLeave={() => setHoverIdx(null)}
            >
              <defs>
                <linearGradient id={ddGradId} x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    style={{ stopColor: 'var(--negative)', stopOpacity: 0.05 }}
                  />
                  <stop
                    offset="100%"
                    style={{ stopColor: 'var(--negative)', stopOpacity: 0.25 }}
                  />
                </linearGradient>
              </defs>

              {ddTicks.map((tick) => (
                <g key={tick}>
                  <line
                    x1={MARGIN.left}
                    x2={MARGIN.left + ddPlotW}
                    y1={ddY(tick)}
                    y2={ddY(tick)}
                    style={{
                      stroke: 'var(--chart-axis)',
                      strokeDasharray: '3 4',
                      opacity: 0.45,
                    }}
                  />
                  <text
                    x={MARGIN.left - 8}
                    y={ddY(tick)}
                    textAnchor="end"
                    dominantBaseline="middle"
                    style={{
                      fill: 'var(--text-subtle)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '9.5px',
                    }}
                  >
                    -{tick.toFixed(0)}%
                  </text>
                </g>
              ))}

              <path d={ddArea} fill={`url(#${ddGradId})`} />
              <polyline
                points={ddLine}
                fill="none"
                style={{
                  stroke: 'var(--negative)',
                  strokeWidth: 1.5,
                  strokeLinejoin: 'round',
                }}
              />
            </svg>
          )}
        </div>
      </section>
    </div>
  )
}

const EquityTab = memo(EquityTabInner)
export default EquityTab
