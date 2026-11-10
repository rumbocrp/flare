import type { Tone } from '../types'

type MetricCardProps = {
  label: string
  value: string
  hint: string
  tone?: Tone
}

function MetricCard({ label, value, hint, tone = 'neutral' }: MetricCardProps) {
  return (
    <article className="card">
      <span className="card__label">{label}</span>
      <strong
        className={`card__value ${
          tone === 'neutral' ? '' : `card__value--${tone}`
        }`}
      >
        {value}
      </strong>
      <span className="card__hint">{hint}</span>
    </article>
  )
}

export default MetricCard
