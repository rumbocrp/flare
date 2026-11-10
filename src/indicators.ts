export type Series = (number | null)[]

export function sma(values: number[], period: number): Series {
  const result: Series = new Array(values.length).fill(null)
  if (period < 1) return result

  let sum = 0
  for (let index = 0; index < values.length; index ++) {
    sum += values[index]
    if (index >= period) sum -= values[index - period]
    if (index >= period - 1) result[index] = sum / period
  }

  return result
}

export function ema(values: number[], period: number): Series {
  const result: Series = new Array(values.length).fill(null)
  if (period < 1 || values.length < period) return result

  const k = 2 / (period + 1)
  let previous =
    values.slice(0, period).reduce((total, value) => total + value, 0) / period
  result[period - 1] = previous

  for (let index = period; index < values.length; index++) {
    previous = values[index] * k + previous * (1 - k)
    result[index] = previous
  }

  return result
}

function toRsi(averageGain: number, averageLoss: number): number {
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100
  return 100 - 100 / (1 + averageGain / averageLoss)
}

export function rsi(values: number[], period = 14): Series {
  const result: Series = new Array(values.length).fill(null)
  if (period < 1 || values.length <= period) return result

  let gainSum = 0
  let lossSum = 0
  for (let index = 1; index <= period; index++) {
    const change = values[index] - values[index - 1]
    if (change >= 0) gainSum += change
    else lossSum -= change
  }

  let averageGain = gainSum / period
  let averageLoss = lossSum / period
  result[period] = toRsi(averageGain, averageLoss)

  for (let index = period + 1; index < values.length; index++) {
    const change = values[index] - values[index - 1]
    const gain = change > 0 ? change : 0
    const loss = change < 0 ? -change : 0

    averageGain = (averageGain * (period - 1) + gain) / period
    averageLoss = (averageLoss * (period - 1) + loss) / period
    result[index] = toRsi(averageGain, averageLoss)
  }
  
  return result
}