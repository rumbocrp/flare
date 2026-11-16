import { crossoverSignals } from './signals'
import type { Candle, SignalParams } from './types'

export type Series = (number | null)[]

export function sma(values: number[], period: number): Series {
  const result: Series = new Array(values.length).fill(null)
  if (period < 1) return result

  let sum = 0
  for (let index = 0; index < values.length; index++) {
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

export type BollingerBandsResult = {
  basis: Series
  upper: Series
  lower: Series
}

export function bollingerBands(
  values: number[],
  period = 20,
  multiplier = 2,
): BollingerBandsResult {
  const basis = sma(values, period)
  const upper: Series = new Array(values.length).fill(null)
  const lower: Series = new Array(values.length).fill(null)
  if (period < 1) return { basis, upper, lower }

  for (let i = period - 1; i < values.length; i++) {
    const mean = basis[i]
    if (mean === null) continue
    let sqSum = 0
    for (let j = i - period + 1; j <= i; j++) {
      const diff = values[j] - mean
      sqSum += diff * diff
    }
    const std = Math.sqrt(sqSum / period)
    upper[i] = mean + multiplier * std
    lower[i] = mean - multiplier * std
  }

  return { basis, upper, lower }
}

export type MacdResult = {
  macd: Series
  signal: Series
  histogram: Series
}

export function macd(
  values: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  const fastEma = ema(values, fastPeriod)
  const slowEma = ema(values, slowPeriod)
  const macdLine: Series = new Array(values.length).fill(null)
  const signalLine: Series = new Array(values.length).fill(null)
  const histogram: Series = new Array(values.length).fill(null)

  const validValues: number[] = []
  const validIndices: number[] = []

  for (let i = 0; i < values.length; i++) {
    const f = fastEma[i]
    const s = slowEma[i]
    if (f !== null && s !== null) {
      const diff = f - s
      macdLine[i] = diff
      validValues.push(diff)
      validIndices.push(i)
    }
  }

  if (validValues.length >= signalPeriod) {
    const sigSeries = ema(validValues, signalPeriod)
    for (let k = 0; k < sigSeries.length; k++) {
      const sigVal = sigSeries[k]
      if (sigVal !== null) {
        const origIdx = validIndices[k]
        signalLine[origIdx] = sigVal
        const mVal = macdLine[origIdx]
        if (mVal !== null) {
          histogram[origIdx] = mVal - sigVal
        }
      }
    }
  }

  return { macd: macdLine, signal: signalLine, histogram }
}

const DAY_MS = 86_400_000

/**
 * Computes intraday session VWAP resetting at each UTC day boundary.
 */
export function vwap(candles: Candle[]): Series {
  const result: Series = new Array(candles.length).fill(null)
  let currentDay = -1
  let cumPv = 0
  let cumVol = 0

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const day = Math.floor(c.time / DAY_MS)
    if (day !== currentDay) {
      currentDay = day
      cumPv = 0
      cumVol = 0
    }
    const typical = (c.high + c.low + c.close) / 3
    const vol = Math.max(0, c.volume)
    cumPv += typical * vol
    cumVol += vol
    result[i] = cumVol > 0 ? cumPv / cumVol : typical
  }

  return result
}

export function atr(candles: Candle[], period = 14): Series {
  const result: Series = new Array(candles.length).fill(null)
  if (period < 1 || candles.length < period + 1) return result

  const trueRanges: number[] = new Array(candles.length).fill(0)
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i]
    const prevClose = candles[i - 1].close
    trueRanges[i] = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose),
    )
  }

  let sum = 0
  for (let i = 1; i <= period; i++) {
    sum += trueRanges[i]
  }
  let currentAtr = sum / period
  result[period] = currentAtr

  for (let i = period + 1; i < candles.length; i++) {
    currentAtr = (currentAtr * (period - 1) + trueRanges[i]) / period
    result[i] = currentAtr
  }

  return result
}

export function toHeikinAshi(candles: Candle[]): Candle[] {
  if (candles.length === 0) return []
  const out: Candle[] = new Array(candles.length)

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const haClose = (c.open + c.high + c.low + c.close) / 4
    const haOpen =
      i === 0 ? (c.open + c.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2
    const haHigh = Math.max(c.high, haOpen, haClose)
    const haLow = Math.min(c.low, haOpen, haClose)
    out[i] = {
      time: c.time,
      open: haOpen,
      high: haHigh,
      low: haLow,
      close: haClose,
      volume: c.volume,
    }
  }

  return out
}

export type TechnicalBias = 'bull' | 'bear' | 'neutral'

export type TechnicalReading = {
  name: string
  value: string
  bias: TechnicalBias
}

export type TechnicalSummary = {
  score: number
  label: 'Strong Buy' | 'Buy' | 'Neutral' | 'Sell' | 'Strong Sell'
  bullCount: number
  bearCount: number
  neutralCount: number
  oscillators: TechnicalReading[]
  movingAverages: TechnicalReading[]
}

export function computeTechnicalSummary(
  candles: Candle[],
  params: SignalParams,
): TechnicalSummary | null {
  if (candles.length < 30) return null

  const closes = candles.map((c) => c.close)
  const lastIdx = closes.length - 1
  const lastClose = closes[lastIdx]

  const rsiSeries = rsi(closes, 14)
  const macdRes = macd(closes, 12, 26, 9)
  const bb = bollingerBands(closes, 20, 2)
  const vwapSeries = vwap(candles)
  const maFn = params.average === 'ema' ? ema : sma
  const fastSeries = maFn(closes, params.fastPeriod)
  const slowSeries = maFn(closes, params.slowPeriod)
  const ema50Series = ema(closes, 50)
  const ema200Series = ema(closes, 200)
  const sigs = crossoverSignals(candles, params)
  const latestSignal = sigs[sigs.length - 1]

  const lastRsi = rsiSeries[lastIdx]
  const rsiBias: TechnicalBias =
    lastRsi === null
      ? 'neutral'
      : lastRsi >= 62
        ? 'bull'
        : lastRsi <= 38
          ? 'bear'
          : lastRsi >= 52
            ? 'bull'
            : lastRsi <= 48
              ? 'bear'
              : 'neutral'

  const lastMacd = macdRes.macd[lastIdx]
  const lastHist = macdRes.histogram[lastIdx]
  const macdBias: TechnicalBias =
    lastHist === null
      ? 'neutral'
      : lastHist > 0
        ? 'bull'
        : lastHist < 0
          ? 'bear'
          : 'neutral'

  const lastUpper = bb.upper[lastIdx]
  const lastLower = bb.lower[lastIdx]
  const bbPctB =
    lastUpper !== null && lastLower !== null && lastUpper > lastLower
      ? ((lastClose - lastLower) / (lastUpper - lastLower)) * 100
      : null
  const bbBias: TechnicalBias =
    bbPctB === null
      ? 'neutral'
      : bbPctB >= 80
        ? 'bear'
        : bbPctB <= 20
          ? 'bull'
          : bbPctB >= 55
            ? 'bull'
            : bbPctB <= 45
              ? 'bear'
              : 'neutral'

  const lastVwap = vwapSeries[lastIdx]
  const vwapBias: TechnicalBias =
    lastVwap === null
      ? 'neutral'
      : lastClose > lastVwap
        ? 'bull'
        : lastClose < lastVwap
          ? 'bear'
          : 'neutral'

  const lastFast = fastSeries[lastIdx]
  const lastSlow = slowSeries[lastIdx]
  const maCrossBias: TechnicalBias =
    lastFast !== null && lastSlow !== null
      ? lastFast > lastSlow
        ? 'bull'
        : lastFast < lastSlow
          ? 'bear'
          : 'neutral'
      : 'neutral'

  const lastEma50 = ema50Series[lastIdx]
  const ema50Bias: TechnicalBias =
    lastEma50 === null
      ? 'neutral'
      : lastClose > lastEma50
        ? 'bull'
        : 'bear'

  const lastEma200 = ema200Series[lastIdx]
  const ema200Bias: TechnicalBias =
    lastEma200 === null
      ? 'neutral'
      : lastClose > lastEma200
        ? 'bull'
        : 'bear'

  const oscillators: TechnicalReading[] = [
    {
      name: 'RSI (14)',
      value: lastRsi !== null ? lastRsi.toFixed(1) : '—',
      bias: rsiBias,
    },
    {
      name: 'MACD Hist',
      value:
        lastHist !== null && lastMacd !== null
          ? `${lastHist >= 0 ? '+' : ''}${lastHist.toFixed(2)}`
          : '—',
      bias: macdBias,
    },
    {
      name: 'BB %B (20,2)',
      value: bbPctB !== null ? `${bbPctB.toFixed(0)}%` : '—',
      bias: bbBias,
    },
    {
      name: 'Session VWAP',
      value:
        lastVwap !== null
          ? `${((lastClose - lastVwap) / lastVwap) * 100 >= 0 ? '+' : ''}${(((lastClose - lastVwap) / lastVwap) * 100).toFixed(2)}%`
          : '—',
      bias: vwapBias,
    },
  ]

  const maSpreadPct =
    lastFast !== null && lastSlow !== null && lastSlow > 0
      ? ((lastFast - lastSlow) / lastSlow) * 100
      : null

  const movingAverages: TechnicalReading[] = [
    {
      name: `${params.average.toUpperCase()} ${params.fastPeriod}/${params.slowPeriod}`,
      value:
        maSpreadPct !== null
          ? `${maSpreadPct >= 0 ? '+' : ''}${maSpreadPct.toFixed(2)}%`
          : latestSignal
            ? latestSignal.side.toUpperCase()
            : 'FLAT',
      bias: maCrossBias,
    },
    {
      name: 'EMA 50',
      value:
        lastEma50 !== null
          ? `${(((lastClose - lastEma50) / lastEma50) * 100 >= 0 ? '+' : '') + (((lastClose - lastEma50) / lastEma50) * 100).toFixed(2)}%`
          : '—',
      bias: ema50Bias,
    },
    {
      name: 'EMA 200',
      value:
        lastEma200 !== null
          ? `${(((lastClose - lastEma200) / lastEma200) * 100 >= 0 ? '+' : '') + (((lastClose - lastEma200) / lastEma200) * 100).toFixed(2)}%`
          : '—',
      bias: ema200Bias,
    },
  ]

  const allReadings = [...oscillators, ...movingAverages]
  let bullCount = 0
  let bearCount = 0
  let neutralCount = 0
  for (const item of allReadings) {
    if (item.bias === 'bull') bullCount += 1
    else if (item.bias === 'bear') bearCount += 1
    else neutralCount += 1
  }

  const score = Math.round(
    ((bullCount - bearCount) / Math.max(1, allReadings.length)) * 100,
  )
  const label: TechnicalSummary['label'] =
    score >= 45
      ? 'Strong Buy'
      : score >= 15
        ? 'Buy'
        : score <= -45
          ? 'Strong Sell'
          : score <= -15
            ? 'Sell'
            : 'Neutral'

  return {
    score,
    label,
    bullCount,
    bearCount,
    neutralCount,
    oscillators,
    movingAverages,
  }
}
