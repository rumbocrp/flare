import { useId } from 'react'
import { cn } from '@/lib/utils'
import type { Tone } from '@/types'

type MiniSparkChartProps = {
  values: number[]
  tone?: Tone
  label: string
  baseline?: number
  variant?: 'default' | 'backdrop'
  className?: string
}

const SPARK_W = 180
const SPARK_H = 52
const SPARK_PAD_Y = 5

const TONE_STROKE: Record<Tone, string> = {
  positive: 'var(--positive)',
  negative: 'var(--negative)',
  neutral: 'var(--brand)',
}

const TONE_AREA: Record<Tone, string> = {
  positive: 'rgba(14, 203, 129, 0.14)',
  negative: 'rgba(246, 70, 93, 0.14)',
  neutral: 'var(--accent-soft)',
}

/** Minimal SVG sparkline chart for market overview cards and win-rate curves. */
export function MiniSparkChart({
  values,
  tone = 'neutral',
  label,
  baseline,
  variant = 'default',
  className,
}: MiniSparkChartProps) {
  const gradId = useId()
  const isBackdrop = variant === 'backdrop'

  if (values.length < 2) {
    return (
      <div
        className={cn(
          isBackdrop
            ? 'h-full w-full bg-muted/20'
            : 'h-[52px] w-full rounded-sm bg-muted/30',
          className,
        )}
        role="img"
        aria-label={label}
      />
    )
  }

  const domainValues =
    baseline !== undefined && Number.isFinite(baseline)
      ? [...values, baseline]
      : values
  const minVal = Math.min(...domainValues)
  const maxVal = Math.max(...domainValues)
  const span = Math.max(1e-9, maxVal - minVal)

  // In backdrop mode, the chart occupies its own dedicated middle slot in the mini
  // card (between price and the L/H footer), so use compact vertical padding.
  const topPad = isBackdrop ? 4 : SPARK_PAD_Y
  const bottomPad = isBackdrop ? 2 : SPARK_PAD_Y
  const plotH = SPARK_H - topPad - bottomPad

  const coords = values.map((val, idx) => {
    const x = (idx / (values.length - 1)) * SPARK_W
    const y = topPad + (1 - (val - minVal) / span) * plotH
    return { x, y }
  })

  const linePoints = coords
    .map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
    .join(' ')
  const areaPoints = `0,${SPARK_H} ${linePoints} ${SPARK_W},${SPARK_H}`
  const baseY =
    baseline !== undefined && Number.isFinite(baseline)
      ? topPad + (1 - (baseline - minVal) / span) * plotH
      : null

  return (
    <svg
      className={cn(
        isBackdrop
          ? 'block h-full w-full'
          : 'block h-[52px] w-full overflow-visible',
        className,
      )}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {isBackdrop && (
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={TONE_STROKE[tone]} stopOpacity={0.26} />
            <stop offset="65%" stopColor={TONE_STROKE[tone]} stopOpacity={0.14} />
            <stop offset="100%" stopColor={TONE_STROKE[tone]} stopOpacity={0.08} />
          </linearGradient>
        </defs>
      )}
      {baseY !== null && (
        <line
          x1={0}
          x2={SPARK_W}
          y1={baseY}
          y2={baseY}
          stroke="var(--chart-baseline)"
          strokeWidth={1}
          strokeDasharray="2 3"
          opacity={isBackdrop ? 0.55 : 1}
          vectorEffect="non-scaling-stroke"
        />
      )}
      <polygon
        points={areaPoints}
        fill={isBackdrop ? `url(#${gradId})` : TONE_AREA[tone]}
      />
      <polyline
        points={linePoints}
        fill="none"
        stroke={TONE_STROKE[tone]}
        strokeWidth={isBackdrop ? 1.5 : 1.6}
        strokeOpacity={isBackdrop ? 0.85 : 1}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

type MiniOutcomeStripProps = {
  outcomes: boolean[]
  label: string
}

const STRIP_W = 96
const STRIP_H = 22

/** Compact historical outcome barcode strip (wins above in green, losses below in red). */
export function MiniOutcomeStrip({ outcomes, label }: MiniOutcomeStripProps) {
  if (outcomes.length === 0) {
    return (
      <span
        className="inline-flex h-[22px] w-24 items-center justify-center font-mono text-[11px] text-muted-foreground"
        aria-label={label}
      >
        —
      </span>
    )
  }

  const maxSlots = 16
  const visible = outcomes.slice(-maxSlots)
  const slotW = STRIP_W / maxSlots
  const barW = Math.max(2.5, slotW - 1.5)
  const startOffset = (maxSlots - visible.length) * slotW

  return (
    <svg
      className="block h-[22px] w-24 shrink-0"
      width={STRIP_W}
      height={STRIP_H}
      viewBox={`0 0 ${STRIP_W} ${STRIP_H}`}
      role="img"
      aria-label={label}
    >
      <line
        x1={0}
        x2={STRIP_W}
        y1={STRIP_H / 2}
        y2={STRIP_H / 2}
        stroke="var(--chart-axis)"
        strokeWidth={1}
      />
      {visible.map((won, idx) => {
        const x = startOffset + idx * slotW
        const barH = won ? 8 : 6
        const y = won ? STRIP_H / 2 - barH - 1 : STRIP_H / 2 + 1
        return (
          <rect
            key={idx}
            fill={won ? 'var(--positive)' : 'var(--negative)'}
            x={x}
            y={y}
            width={barW}
            height={barH}
            rx={1}
          />
        )
      })}
    </svg>
  )
}
