import { ema, sma } from './indicators'
import type { AverageKind, Candle, Signal, SignalParams } from './types'

export const RSI_PERIOD = 14

export const fastOptions = [5, 9, 12, 21, 50]
export const slowOptions = [20, 26, 50, 55, 100, 200]

export const averageOptions: { id: AverageKind; label: string }[] = [
  { id: 'sma', label: 'SMA' },
  { id: 'ema', label: 'EMA' },
]

export const defaultSignalParams: SignalParams = {
  fastPeriod: 9,
  slowPeriod: 20,
  average: 'sma',
}

export function isSignalParams(value: unknown): value is SignalParams {
  if (typeof value !== 'object' || value === null) return false

  const candidate = value as Record<string, unknown>

  return (
    typeof candidate.fastPeriod === 'number' &&
    fastOptions.includes(candidate.fastPeriod) &&
    typeof candidate.slowPeriod === 'number' &&
    slowOptions.includes(candidate.slowPeriod) &&
    (candidate.average === 'sma' || candidate.average === 'ema')
  )
}

export function crossoverSignals(
  candles: Candle[],
  params: SignalParams,
): Signal[] {
  const closes = candles.map((candle) => candle.close)
  const average = params.average === 'ema' ? ema : sma
  const fast = average(closes, params.fastPeriod)
  const slow = average(closes, params.slowPeriod)
  const name = params.average.toUpperCase()

  const signals: Signal[] = []

  for (let index = 1; index < candles.length; index++) {
    const previousFast = fast[index - 1]
    const previousSlow = slow[index - 1]
    const currentFast = fast[index]
    const currentSlow = slow[index]

    if (
      previousFast === null ||
      previousSlow === null ||
      currentFast === null ||
      currentSlow === null
    ) {
      continue
    }

    const crossedUp = previousFast <= previousSlow && currentFast > currentSlow
    const crossedDown =
      previousFast >= previousSlow && currentFast < currentSlow

    if (crossedUp) {
      signals.push({
        index,
        time: candles[index].time,
        side: 'buy',
        price: candles[index].close,
        reason: `${name} ${params.fastPeriod} cruza por encima de ${name} ${params.slowPeriod}`,
      })
    } else if (crossedDown) {
      signals.push({
        index,
        time: candles[index].time,
        side: 'sell',
        price: candles[index].close,
        reason: `${name} ${params.fastPeriod} cruza por debajo de ${name} ${params.slowPeriod}`,
      })
    }
  }

  return signals
}
