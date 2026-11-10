import { useState, type ChangeEvent, type FormEvent } from 'react'
import PageHeader from '../components/PageHeader'
import NumberField from '../components/NumberField'
import { availablePairs } from '../strategy'
import type { Strategy } from '../types'

type BotConfigProps = {
  strategy: Strategy
  onSave: (strategy: Strategy) => void
}

type FormValues = {
  pair: string
  positionSize: string
  stopLoss: string
  takeProfit: string
  maxDailyRisk: string
}

type FormErrors = Partial<Record<keyof FormValues, string>>

function toFormValues(strategy: Strategy): FormValues {
  return {
    pair: strategy.pair,
    positionSize: String(strategy.positionSize),
    stopLoss: String(strategy.stopLoss),
    takeProfit: String(strategy.takeProfit),
    maxDailyRisk: String(strategy.maxDailyRisk),
  }
}

function toStrategy(values: FormValues): Strategy {
  return {
    pair: values.pair,
    positionSize: Number(values.positionSize),
    stopLoss: Number(values.stopLoss),
    takeProfit: Number(values.takeProfit),
    maxDailyRisk: Number(values.maxDailyRisk),
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
    positionSize: numberError(values.positionSize, 0.1, 100),
    stopLoss: numberError(values.stopLoss, 0.1, 50),
    takeProfit: numberError(values.takeProfit, 0.1, 100),
    maxDailyRisk: numberError(values.maxDailyRisk, 0.1, 100),
  }
}

function sameValues(a: FormValues, b: FormValues): boolean {
  return (
    a.pair === b.pair &&
    a.positionSize === b.positionSize &&
    a.stopLoss === b.stopLoss &&
    a.takeProfit === b.takeProfit &&
    a.maxDailyRisk === b.maxDailyRisk
  )
}

function BotConfig({ strategy, onSave }: BotConfigProps) {
  const [values, setValues] = useState<FormValues>(toFormValues(strategy))

  const savedValues = toFormValues(strategy)
  const errors = validate(values)
  const hasErrors = Object.values(errors).some(
    (message) => message !== undefined,
  )
  const hasChanges = !sameValues(values, savedValues)

  const ratio =
    errors.stopLoss === undefined && errors.takeProfit === undefined
      ? Number(values.takeProfit) / Number(values.stopLoss)
      : null

  function handleChange(
    event: ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) {
    const { name, value } = event.target
    setValues((current) => ({ ...current, [name]: value }))
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (hasErrors) return

    const next = toStrategy(values)
    onSave(next)
    setValues(toFormValues(next))
  }

  function handleReset() {
    setValues(savedValues)
  }

  return (
    <div className="page">
      <PageHeader
        title="Ajustar bot"
        subtitle="Configura la estrategia y los límites de riesgo."
      />

      <form className="form" onSubmit={handleSubmit} noValidate>
        <div className="form__grid">
          <div className="field">
            <label className="field__label" htmlFor="pair">
              Par
            </label>
            <div className="field__control">
              <select
                id="pair"
                name="pair"
                value={values.pair}
                onChange={handleChange}
              >
                {availablePairs.map((pair) => (
                  <option key={pair} value={pair}>
                    {pair}
                  </option>
                ))}
              </select>
            </div>
            <p className="field__help">Mercado en el que opera el bot.</p>
          </div>

          <NumberField
            name="positionSize"
            label="Tamaño de posición"
            unit="%"
            hint="Porcentaje del balance que usa en cada operación."
            value={values.positionSize}
            error={errors.positionSize}
            onChange={handleChange}
          />

          <NumberField
            name="stopLoss"
            label="Stop loss"
            unit="%"
            hint="Pérdida máxima aceptada por operación."
            value={values.stopLoss}
            error={errors.stopLoss}
            onChange={handleChange}
          />

          <NumberField
            name="takeProfit"
            label="Take profit"
            unit="%"
            hint="Ganancia objetivo por operación."
            value={values.takeProfit}
            error={errors.takeProfit}
            onChange={handleChange}
          />

          <NumberField
            name="maxDailyRisk"
            label="Riesgo máximo diario"
            unit="%"
            hint="Pérdida acumulada máxima permitida en un día."
            value={values.maxDailyRisk}
            error={errors.maxDailyRisk}
            onChange={handleChange}
          />
        </div>

        {ratio !== null && (
          <p className="readout">
            Relación riesgo : beneficio — <strong>1 : {ratio.toFixed(1)}</strong>
          </p>
        )}

        <div className="form__actions">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={!hasChanges || hasErrors}
          >
            Guardar
          </button>
          <button
            type="button"
            className="btn"
            disabled={!hasChanges}
            onClick={handleReset}
          >
            Restablecer
          </button>
          <span className="form__status">
            {hasChanges ? 'Tienes cambios sin guardar' : 'Todo guardado'}
          </span>
        </div>
      </form>
    </div>
  )
}

export default BotConfig
