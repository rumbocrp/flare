import { useMemo, useState, type ChangeEvent, type FormEvent } from 'react'
import './Backtest.css'
import PageHeader from '../components/PageHeader'
import NumberField from '../components/NumberField'
import EquityChart from '../components/EquityChart'
import MetricCard from '../components/MetricCard'
import TradesTable from '../components/TradesTable'
import { useCandles } from '../hooks/useCandles'
import { marketDataSource } from '../market'
import { availablePairs } from '../strategy'
import {
  averageOptions,
  defaultSignalParams,
  fastOptions,
  slowOptions,
} from '../signals'
import {
  createBacktestSnapshot,
  exitReasonLabels,
  runBacktest,
  type BacktestConfig,
  type BacktestResult,
  type BacktestSnapshot,
} from '../backtest'
import { computeMetrics } from '../metrics'
import {
  formatDateTime,
  formatMoney,
  formatOrDash,
  formatPercent,
  formatSignedMoney,
} from '../format'
import type {
  AverageKind,
  ChartPoint,
  ExitReason,
  Interval,
  PageId,
  SignalParams,
  Strategy,
  Tone,
} from '../types'

const CANDLE_LIMITS = [200, 500, 1000]

const intervalOptions: { id: Interval; label: string }[] = [
  { id: '15m', label: '15 min' },
  { id: '1h', label: '1 h' },
  { id: '4h', label: '4 h' },
  { id: '1d', label: '1 día' },
]

type FormValues = {
  initialBalance: string
  commissionPct: string
  slippagePct: string
  positionSize: string
  stopLoss: string
  takeProfit: string
  maxDailyRisk: string
}

type FormErrors = Partial<Record<keyof FormValues, string>>

function toFormValues(strategy: Strategy): FormValues {
  return {
    initialBalance: '10000',
    commissionPct: '0.1',
    slippagePct: '0',
    positionSize: String(strategy.positionSize),
    stopLoss: String(strategy.stopLoss),
    takeProfit: String(strategy.takeProfit),
    maxDailyRisk: String(strategy.maxDailyRisk),
  }
}

function numberError(
  text: string,
  min: number,
  max: number,
): string | undefined {
  const value = Number(text)

  if (text.trim() === '' || Number.isNaN(value)) {
    return 'Escribe un número.'
  }
  if (value < min || value > max) {
    return `Debe estar entre ${min} y ${max}.`
  }
  return undefined
}

function validate(values: FormValues): FormErrors {
  return {
    initialBalance: numberError(values.initialBalance, 1, 1_000_000),
    commissionPct: numberError(values.commissionPct, 0, 5),
    slippagePct: numberError(values.slippagePct, 0, 5),
    positionSize: numberError(values.positionSize, 0.1, 100),
    stopLoss: numberError(values.stopLoss, 0.1, 50),
    takeProfit: numberError(values.takeProfit, 0.1, 100),
    maxDailyRisk: numberError(values.maxDailyRisk, 0.1, 100),
  }
}

function toneOf(value: number | null, threshold = 0): Tone {
  if (value === null) return 'neutral'
  if (value > threshold) return 'positive'
  if (value < threshold) return 'negative'
  return 'neutral'
}

type BacktestProps = {
  strategy: Strategy
  onNavigate: (page: PageId) => void
  onSaveResult: (snapshot: BacktestSnapshot) => void
}

function Backtest({ strategy, onNavigate, onSaveResult }: BacktestProps) {
  const [pair, setPair] = useState(strategy.pair)
  const [interval, setInterval] = useState<Interval>('1h')
  const [limit, setLimit] = useState(500)
  const [params, setParams] = useState<SignalParams>(defaultSignalParams)
  const [values, setValues] = useState<FormValues>(() =>
    toFormValues(strategy),
  )
  const [allowShort, setAllowShort] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [runError, setRunError] = useState<string | null>(null)

  const state = useCandles(
    marketDataSource,
    pair,
    interval,
    limit,
    reloadKey,
  )

  const errors = validate(values)
  const hasErrors = Object.values(errors).some(
    (message) => message !== undefined,
  )

  const metrics = useMemo(
    () =>
      result
        ? computeMetrics(result.trades, result.initialBalance)
        : null,
    [result],
  )

  const equityPoints: ChartPoint[] = useMemo(
    () =>
      result
        ? result.equity.map((point) => ({
            label: formatDateTime(point.time),
            value: point.value,
          }))
        : [],
    [result],
  )

  const exitCounts = useMemo(() => {
    if (!result) return {} as Partial<Record<ExitReason, number>>

    return result.trades.reduce<Partial<Record<ExitReason, number>>>(
      (counts, trade) => {
        counts[trade.exitReason] = (counts[trade.exitReason] ?? 0) + 1
        return counts
      },
      {},
    )
  }, [result])

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const { name, value } = event.target
    setValues((current) => ({ ...current, [name]: value }))
  }

  function handleRun(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()

    if (state.status !== 'success') {
      setRunError('Espera a que las velas terminen de cargar.')
      return
    }

    if (hasErrors) {
      setRunError('Revisa los campos marcados en rojo.')
      return
    }

    const config: BacktestConfig = {
      pair,
      params,
      strategy: {
        positionSize: Number(values.positionSize),
        stopLoss: Number(values.stopLoss),
        takeProfit: Number(values.takeProfit),
        maxDailyRisk: Number(values.maxDailyRisk),
      },
      settings: {
        initialBalance: Number(values.initialBalance),
        commissionPct: Number(values.commissionPct),
        slippagePct: Number(values.slippagePct),
        allowShort,
      },
    }

    try {
      const next = runBacktest(state.data, config)
      setResult(next)
      setRunError(null)
      onSaveResult(createBacktestSnapshot(next))
    } catch (error) {
      setRunError(
        error instanceof Error
          ? error.message
          : 'No se pudo ejecutar el backtest.',
      )
    }
  }

  const lastConfig = result?.config

  return (
    <div className="page">
      <PageHeader
        title="Backtest"
        subtitle="Simula la estrategia vela por vela con comisiones, stop loss y take profit."
      />

      <form className="form" onSubmit={handleRun} noValidate>
        <section className="section">
          <div className="section__header">
            <h2>Datos</h2>
          </div>

          <div className="backtest__grid">
            <div className="field">
              <label className="field__label" htmlFor="bt-pair">
                Par
              </label>
              <div className="field__control">
                <select
                  id="bt-pair"
                  value={pair}
                  onChange={(event) => setPair(event.target.value)}
                >
                  {availablePairs.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
              <p className="field__help">Mercado que se va a simular.</p>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="bt-interval">
                Temporalidad
              </label>
              <div className="field__control">
                <select
                  id="bt-interval"
                  value={interval}
                  onChange={(event) =>
                    setInterval(event.target.value as Interval)
                  }
                >
                  {intervalOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <p className="field__help">
                No se ofrece 5m hasta corregir `market/intervals.ts`.
              </p>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="bt-limit">
                Velas
              </label>
              <div className="field__control">
                <select
                  id="bt-limit"
                  value={limit}
                  onChange={(event) => setLimit(Number(event.target.value))}
                >
                  {CANDLE_LIMITS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
              <p className="field__help">
                Más velas = más historia y más tiempo de cálculo.
              </p>
            </div>
          </div>

          {state.status === 'loading' && (
            <p className="readout" role="status">
              Cargando velas…
            </p>
          )}

          {state.status === 'error' && (
            <div className="readout" role="alert">
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
            <p className="field__help">
              {state.data.length} velas desde{' '}
              {formatDateTime(state.data[0].time)} hasta{' '}
              {formatDateTime(state.data[state.data.length - 1].time)} UTC.
            </p>
          )}
        </section>

        <section className="section">
          <div className="section__header">
            <h2>Señal</h2>
          </div>

          <div className="backtest__grid">
            <div className="field">
              <label className="field__label" htmlFor="bt-fast">
                Media rápida
              </label>
              <div className="field__control">
                <select
                  id="bt-fast"
                  value={params.fastPeriod}
                  onChange={(event) =>
                    setParams({
                      ...params,
                      fastPeriod: Number(event.target.value),
                    })
                  }
                >
                  {fastOptions.map((option) => (
                    <option key={option} value={option}>
                      {option} velas
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="bt-slow">
                Media lenta
              </label>
              <div className="field__control">
                <select
                  id="bt-slow"
                  value={params.slowPeriod}
                  onChange={(event) =>
                    setParams({
                      ...params,
                      slowPeriod: Number(event.target.value),
                    })
                  }
                >
                  {slowOptions.map((option) => (
                    <option key={option} value={option}>
                      {option} velas
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="field">
              <span className="field__label" id="bt-average-label">
                Tipo de media
              </span>
              <div className="field__control">
                <div
                  className="segmented"
                  role="group"
                  aria-labelledby="bt-average-label"
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
                      onClick={() =>
                        setParams({
                          ...params,
                          average: option.id as AverageKind,
                        })
                      }
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section">
          <div className="section__header">
            <h2>Riesgo y ejecución</h2>
          </div>

          <div className="backtest__grid">
            <NumberField
              name="initialBalance"
              label="Balance inicial"
              unit="USD"
              hint="Capital con el que empieza la simulación."
              value={values.initialBalance}
              error={errors.initialBalance}
              onChange={handleChange}
            />

            <NumberField
              name="positionSize"
              label="Tamaño de posición"
              unit="%"
              hint="Porcentaje del balance usado como nocional."
              value={values.positionSize}
              error={errors.positionSize}
              onChange={handleChange}
            />

            <NumberField
              name="stopLoss"
              label="Stop loss"
              unit="%"
              hint="Distancia desde la entrada hasta el stop."
              value={values.stopLoss}
              error={errors.stopLoss}
              onChange={handleChange}
            />

            <NumberField
              name="takeProfit"
              label="Take profit"
              unit="%"
              hint="Distancia desde la entrada hasta el objetivo."
              value={values.takeProfit}
              error={errors.takeProfit}
              onChange={handleChange}
            />

            <NumberField
              name="maxDailyRisk"
              label="Riesgo máximo diario"
              unit="%"
              hint="Pérdida realizada que bloquea nuevas entradas ese día."
              value={values.maxDailyRisk}
              error={errors.maxDailyRisk}
              onChange={handleChange}
            />

            <NumberField
              name="commissionPct"
              label="Comisión por lado"
              unit="%"
              hint="Se cobra al entrar y al salir. 0.1 = 0.1 %."
              value={values.commissionPct}
              error={errors.commissionPct}
              onChange={handleChange}
            />

            <NumberField
              name="slippagePct"
              label="Slippage"
              unit="%"
              hint="Deslizamiento adverso en entrada y salida."
              value={values.slippagePct}
              error={errors.slippagePct}
              onChange={handleChange}
            />
          </div>

          <label className="backtest__check">
            <input
              type="checkbox"
              checked={allowShort}
              onChange={(event) => setAllowShort(event.target.checked)}
            />
            Permitir cortos: una señal SELL abre una posición short.
          </label>
        </section>

        <div className="form__actions">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={state.status !== 'success' || hasErrors}
          >
            Ejecutar backtest
          </button>
          <span className="form__status">
            {runError
              ? runError
              : hasErrors
                ? 'Corrige los campos marcados.'
                : 'La configuración se aplica al ejecutar.'}
          </span>
        </div>
      </form>

      {result && metrics && (
        <>
          <section className="section">
            <div className="section__header">
              <h2>Resultado</h2>
              <button
                type="button"
                className="btn"
                onClick={() => onNavigate('stats')}
              >
                Ver en Estadísticas
              </button>
            </div>

            <p className="readout">
              <strong>{result.config.pair}</strong> ·{' '}
              {result.config.params.average.toUpperCase()}{' '}
              {result.config.params.fastPeriod}/{result.config.params.slowPeriod} ·{' '}
              {result.candles.count} velas · comisión{' '}
              {result.config.settings.commissionPct}% por lado ·{' '}
              {result.trades.length} operaciones
              {result.bankrupt ? ' · cuenta agotada' : ''}
            </p>

            <div className="stats">
              <MetricCard
                label="PnL neto"
                value={formatSignedMoney(result.netPnl)}
                hint="Después de comisiones y slippage"
                tone={toneOf(result.netPnl)}
              />
              <MetricCard
                label="Retorno"
                value={formatPercent(result.returnPct, 2)}
                hint="Sobre el balance inicial"
                tone={toneOf(result.returnPct)}
              />
              <MetricCard
                label="Balance final"
                value={formatMoney(result.finalBalance)}
                hint={`Inicial ${formatMoney(result.initialBalance)}`}
              />
              <MetricCard
                label="Operaciones"
                value={String(metrics.totalTrades)}
                hint={`${metrics.wins} ganadoras · ${metrics.losses} perdedoras`}
              />
              <MetricCard
                label="Tasa de acierto"
                value={formatOrDash(metrics.winRate, (value) =>
                  formatPercent(value, 1),
                )}
                hint="Ganadoras sobre el total"
              />
              <MetricCard
                label="Factor de beneficio"
                value={formatOrDash(metrics.profitFactor, (value) =>
                  value.toFixed(2),
                )}
                hint="Ganancias ÷ pérdidas"
                tone={toneOf(metrics.profitFactor, 1)}
              />
              <MetricCard
                label="Mayor caída"
                value={formatMoney(-metrics.maxDrawdown)}
                hint={`${formatPercent(metrics.maxDrawdownPct, 2)} del máximo`}
                tone={metrics.maxDrawdown > 0 ? 'negative' : 'neutral'}
              />
              <MetricCard
                label="Comisiones pagadas"
                value={formatMoney(result.feesPaid)}
                hint="Entrada + salida"
                tone={result.feesPaid > 0 ? 'negative' : 'neutral'}
              />
            </div>
          </section>

          <section className="section">
            <div className="section__header">
              <h2>Motivos de salida</h2>
            </div>

            <div className="backtest__reasons">
              {(Object.keys(exitCounts) as ExitReason[]).map((reason) => (
                <span key={reason} className="backtest__reason">
                  {exitReasonLabels[reason]}: {exitCounts[reason]}
                </span>
              ))}
            </div>
          </section>

          <section className="section">
            <div className="section__header">
              <h2>Evolución del balance</h2>
            </div>
            <EquityChart points={equityPoints} />
          </section>

          <section className="section">
            <div className="section__header">
              <h2>Operaciones ({result.trades.length})</h2>
            </div>

            {result.trades.length === 0 ? (
              <p className="placeholder">
                Esta configuración no generó operaciones con estas velas.
                Prueba otro par, temporalidad o períodos de media.
              </p>
            ) : (
              <TradesTable trades={result.trades} />
            )}
          </section>

          {lastConfig && (
            <p className="disclaimer">
              Resultado sobre datos históricos. No incluye liquidez, funding,
              latencia ni cambios de spread. Un backtest no garantiza
              resultados futuros. Comisión configurada: por lado.
            </p>
          )}
        </>
      )}
    </div>
  )
}

export default Backtest
