import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { Tone } from '@/types'

type MetricCardProps = {
  label: string
  value: string
  hint?: string
  tone?: Tone
}

const VALUE_TONE_CLASS: Record<Tone, string> = {
  neutral: 'text-foreground',
  positive: 'text-[var(--positive)]',
  negative: 'text-[var(--negative)]',
}

function MetricCard({
  label,
  value,
  hint,
  tone = 'neutral',
}: MetricCardProps) {
  return (
    <Card className="gap-1 px-4 py-3.5">
      <span className="text-xs font-medium text-muted-foreground">
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
      {hint && (
        <span className="truncate text-[11px] leading-snug text-[var(--text-subtle)] tabular-nums">
          {hint}
        </span>
      )}
    </Card>
  )
}

export default MetricCard
