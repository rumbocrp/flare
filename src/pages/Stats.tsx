import { useState } from 'react'
import PageHeader from '../components/PageHeader'
import EquityChart from '../components/EquityChart'
import MetricCard from '../components/MetricCard'
import TradesTable from '../components/TradesTable'
import { trades, tradePnl } from '../trades'
import { computeEquityPoints, computeMetrics } from '../metrics'
import {
  formatMoney,
  formatOrDash,
  formatPercent,
  formatSignedMoney,
} from '../format'
import type { Tone } from '../types'
import MarketSection from '../components/MarketSection'

type TradeFilter = 'all' | 'wins' | 'losses'

const filterOptions: { id: TradeFilter; label: string }[] = [
  { id: 'all', label: 'Todas' },
  { id: 'wins', label: 'Ganadoras' },
  { id: 'losses', label: 'Perdedoras' },
]

function toneOf(value: number | null, threshold = 0): Tone {
  if (value === null) return 'neutral'
  if (value > threshold) return 'positive'
  if (value < threshold) return 'negative'
  return 'neutral'
}

function Stats() {
  const [filter, setFilter] = useState<TradeFilter>('all')

  const metrics = computeMetrics(trades)
  const equityPoints = computeEquityPoints(trades)

  const hasDrawdown = metrics.maxDrawdown > 0
  const drawdownText = hasDrawdown
    ? formatMoney(-metrics.maxDrawdown)
    : formatMoney(0)
  const drawdownHint = hasDrawdown
    ? `${formatPercent(metrics.maxDrawdownPct, 2)} del máximo alcanzado`
    : 'Sin caídas'

  const visibleTrades = trades.filter((trade) => {
    if (filter === 'wins') return tradePnl(trade) > 0
    if (filter === 'losses') return tradePnl(trade) < 0
    return true
  })

  return (
    <div className="page">
      <PageHeader
        title="Estadísticas"
        subtitle="Rendimiento y riesgo de tus operaciones."
      />

      <section className="section">
        <div className="section__header">
          <h2>Evolución del balance</h2>
        </div>

        <EquityChart points={equityPoints} />
      </section>

      <section className="section">
        <div className="section__header">
          <h2>Indicadores de riesgo</h2>
        </div>

        <div className="stats">
          <MetricCard
            label="Tasa de acierto"
            value={formatOrDash(metrics.winRate, (value) =>
              formatPercent(value, 1),
            )}
            hint={`${metrics.wins} ganadoras de ${metrics.totalTrades}`}
          />
          <MetricCard
            label="Factor de beneficio"
            value={formatOrDash(metrics.profitFactor, (value) =>
              value.toFixed(2),
            )}
            hint="Ganancias totales ÷ pérdidas totales"
            tone={toneOf(metrics.profitFactor, 1)}
          />
          <MetricCard
            label="Expectativa por operación"
            value={formatOrDash(metrics.expectancy, formatSignedMoney)}
            hint="Resultado promedio de cada operación"
            tone={toneOf(metrics.expectancy)}
          />
          <MetricCard
            label="Mayor caída"
            value={drawdownText}
            hint={drawdownHint}
            tone={hasDrawdown ? 'negative' : 'neutral'}
          />
          <MetricCard
            label="Ganancia promedio"
            value={formatOrDash(metrics.averageWin, formatSignedMoney)}
            hint="Promedio de las operaciones ganadoras"
            tone={toneOf(metrics.averageWin)}
          />
          <MetricCard
            label="Pérdida promedio"
            value={formatOrDash(metrics.averageLoss, formatSignedMoney)}
            hint="Promedio de las operaciones perdedoras"
            tone={toneOf(metrics.averageLoss)}
          />
          <MetricCard
            label="Mejor operación"
            value={formatOrDash(metrics.bestTrade, formatSignedMoney)}
            hint="La mayor ganancia individual"
            tone={toneOf(metrics.bestTrade)}
          />
          <MetricCard
            label="Peor operación"
            value={formatOrDash(metrics.worstTrade, formatSignedMoney)}
            hint="La mayor pérdida individual"
            tone={toneOf(metrics.worstTrade)}
          />
        </div>

        <p className="disclaimer">
          Calculados con las operaciones de ejemplo. Con tan pocas operaciones,
          estos números no son confiables.
        </p>
      </section>

      <section className="section">
        <div className="section__header">
          <h2>Operaciones ({visibleTrades.length})</h2>

          <div
            className="segmented"
            role="group"
            aria-label="Filtrar operaciones"
          >
            {filterOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`segmented__option ${
                  filter === option.id ? 'segmented__option--active' : ''
                }`}
                aria-pressed={filter === option.id}
                onClick={() => setFilter(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <TradesTable trades={visibleTrades} />
      </section>

      <MarketSection />
    </div>
  )
}

export default Stats
