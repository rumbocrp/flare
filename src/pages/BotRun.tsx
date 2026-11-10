import './BotRun.css'
import PageHeader from '../components/PageHeader'
import { botStatusLabels } from '../botStatus'
import type { BotStatus, Strategy } from '../types'

type BotRunProps = {
  status: BotStatus
  onChangeStatus: (status: BotStatus) => void
  strategy: Strategy
}

function BotRun({ status, onChangeStatus, strategy }: BotRunProps) {
  const isRunning = status === 'running'

  return (
    <div className="page">
      <PageHeader
        title="Ejecutar bot"
        subtitle="Inicia o detén el bot. Por ahora, solo en simulación."
      />

      <section className="run-panel">
        <div className="run-panel__status">
          <span
            className={`run-panel__dot ${isRunning ? 'run-panel__dot--on' : ''}`}
            aria-hidden="true"
          />
          <div>
            <span className="run-panel__label">Estado actual</span>
            <strong className="run-panel__value">
              {botStatusLabels[status]}
            </strong>
          </div>
        </div>

        <div className="run-panel__actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={isRunning}
            onClick={() => onChangeStatus('running')}
          >
            Iniciar
          </button>
          <button
            type="button"
            className="btn"
            disabled={!isRunning}
            onClick={() => onChangeStatus('stopped')}
          >
            Detener
          </button>
        </div>
      </section>

      <section className="run-summary">
        <h2>Estrategia activa</h2>
        <dl className="run-summary__list">
          <div>
            <dt>Par</dt>
            <dd>{strategy.pair}</dd>
          </div>
          <div>
            <dt>Tamaño de posición</dt>
            <dd>{strategy.positionSize}%</dd>
          </div>
          <div>
            <dt>Stop loss</dt>
            <dd>{strategy.stopLoss}%</dd>
          </div>
          <div>
            <dt>Take profit</dt>
            <dd>{strategy.takeProfit}%</dd>
          </div>
          <div>
            <dt>Riesgo máximo diario</dt>
            <dd>{strategy.maxDailyRisk}%</dd>
          </div>
        </dl>
      </section>

      <p className="disclaimer">
        El bot todavía no opera: estos botones solo cambian el estado en
        pantalla. Todo es simulación.
      </p>
    </div>
  )
}

export default BotRun
