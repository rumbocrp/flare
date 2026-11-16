import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { Tone } from '@/types'

type MetricCardProps = {
  label: string
  value: string
  hint: string
  tone?: Tone
}

const VALUE_TONE_CLASS: Record<Tone, string> = {
  neutral: 'text-foreground',
  positive: 'text-[var(--positive)]',
  negative: 'text-[var(--negative)]',
}

const ACCENT_BAR_CLASS: Record<Tone, string> = {
  neutral: 'border-t-border',
  positive: 'border-t-[var(--positive)]/75',
  negative: 'border-t-[var(--negative)]/75',
}

function MetricCard({
  label,
  value,
  hint,
  tone = 'neutral',
}: MetricCardProps) {
  return (
    <Card
      className={cn(
        'gap-1 border-t-2 px-3.5 py-3 transition-all duration-150 hover:border-[var(--border-strong)]',
        ACCENT_BAR_CLASS[tone],
      )}
    >
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
        {label}
      </span>
      <strong
        className={cn(
          'truncate font-mono text-lg font-semibold leading-tight tracking-tight tabular-nums sm:text-xl',
          VALUE_TONE_CLASS[tone],
        )}
      >
        {value}
      </strong>
      <span className="truncate text-[11px] leading-snug text-[var(--text-subtle)] tabular-nums">
        {hint}
      </span>
    </Card>
  )
}

export default MetricCard
