import { useState } from 'react'
import './EquityChart.css'
import './CandleChart.css'
import MarketAnalysis from './MarketAnalysis'
import { useCandles } from '../hooks/useCandles'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import { marketDataSource } from '../market'
import { availablePairs } from '../strategy'
import {
  averageOptions,
  defaultSignalParams,
  fastOptions,
  isSignalParams,
  slowOptions,
} from '../signals'
import type { Interval, SignalParams } from '../types'

const SIGNAL_PARAMS_KEY = 'lixtrd:signal-params'

const intervalOptions: { id: Interval; label: string }[] = [
  { id: '15m', label: '15 min' },
  { id: '1h', label: '1 h' },
  { id: '4h', label: '4 h' },
  { id: '1d', label: '1 día' },
]

const CANDLE_LIMIT = 100

function MarketSection() {
  const [pair, setPair] = useState<string>(availablePairs[0])
  const [timeframe, setTimeframe] = useState<Interval>('1h')
  const [reloadKey, setReloadKey] = useState(0)

  const [params, setParams] = useLocalStorageState<SignalParams>(
    SIGNAL_PARAMS_KEY,
    defaultSignalParams,
    isSignalParams,
  )

  const state = useCandles(
    marketDataSource,
    pair,
    timeframe,
    CANDLE_LIMIT,
    reloadKey,
  )

  return (
    <section className="section">
      <div className="section__header">
        <h2>Precio del mercado</h2>

        <div className="market__controls">
          <div className="segmented" role="group" aria-label="Par">
            {availablePairs.map((option) => (
              <button
                key={option}
                type="button"
                className={`segmented__option ${
                  pair === option ? 'segmented__option--active' : ''
                }`}
                aria-pressed={pair === option}
                onClick={() => setPair(option)}
              >
                {option}
              </button>
            ))}
          </div>

          <div className="segmented" role="group" aria-label="Temporalidad">
            {intervalOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`segmented__option ${
                  timeframe === option.id ? 'segmented__option--active' : ''
                }`}
                aria-pressed={timeframe === option.id}
                onClick={() => setTimeframe(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="market__params">
        <div className="field">
          <label className="field__label" htmlFor="fast-period">
            Media rápida
          </label>
          <div className="field__control">
            <select
              id="fast-period"
              value={params.fastPeriod}
              onChange={(event) =>
                setParams({ ...params, fastPeriod: Number(event.target.value) })
              }
            >
              {fastOptions.map((option) => (
                <option key={option} value={option}>
                  {option} velas
                </option>
              ))}
            </select>
          </div>
          <p className="field__help">Reacciona rápido a los cambios.</p>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="slow-period">
            Media lenta
          </label>
          <div className="field__control">
            <select
              id="slow-period"
              value={params.slowPeriod}
              onChange={(event) =>
                setParams({ ...params, slowPeriod: Number(event.target.value) })
              }
            >
              {slowOptions.map((option) => (
                <option key={option} value={option}>
                  {option} velas
                </option>
              ))}
            </select>
          </div>
          <p className="field__help">Marca la tendencia de fondo.</p>
        </div>

        <div className="field">
          <span className="field__label" id="average-label">
            Tipo de media
          </span>
          <div className="field__control">
            <div
              className="segmented"
              role="group"
              aria-labelledby="average-label"
            >
              {averageOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`segmented__option ${
                    params.average === option.id
                      ? 'segmented__option--active'
                      : ''
                  }`}
                  aria-pressed={params.average === option.id}
                  onClick={() => setParams({ ...params, average: option.id })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <p className="field__help">
            SMA: promedio simple. EMA: da más peso a lo reciente.
          </p>
        </div>
      </div>

      {state.status === 'loading' && (
        <div className="chart chart__status" role="status">
          Cargando velas…
        </div>
      )}

      {state.status === 'error' && (
        <div className="chart chart__status chart__status--error" role="alert">
          <p>No se pudieron cargar los datos: {state.message}</p>
          <button
            type="button"
            className="btn"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            Reintentar
          </button>
        </div>
      )}

      {state.status === 'success' && (
        <MarketAnalysis candles={state.data} params={params} />
      )}

      <p className="disclaimer">
        Fuente: {marketDataSource.name}. {marketDataSource.description} Horas
        en UTC.
      </p>
    </section>
  )
}

export default MarketSection