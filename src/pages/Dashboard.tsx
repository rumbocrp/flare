import PageHeader from '../components/PageHeader'
import { botStatusLabels } from '../botStatus'
import type { BotStatus } from '../types'

type Stat = {
  label: string
  value: string
  positive?: boolean
}

type DashboardProps = {
  botStatus: BotStatus
}

function Dashboard({ botStatus }: DashboardProps) {
  const stats: Stat[] = [
    { label: 'Balance (SIM)', value: '$10,000.00' },
    { label: 'Daily P/L', value: '+$124.50', positive: true },
    { label: 'Bot status', value: botStatusLabels[botStatus] },
    { label: 'Trades', value: '12' },
  ]

  return (
    <div className="page">
      <PageHeader
        title="FLARE"
        subtitle="Beta 1.0 (DEMO)"
        badge="PHASE 6"
      />

      <section className="stats">
        {stats.map((stat) => (
          <article key={stat.label} className="card">
            <span className="card__label">{stat.label}</span>
            <strong
              className={`card__value ${stat.positive ? 'card__value--positive' : ''}`}
            >
              {stat.value}
            </strong>
          </article>
        ))}
      </section>

      <p className="disclaimer">
        DEMO | NO REAL DATA
      </p>
    </div>
  )
}

export default Dashboard
