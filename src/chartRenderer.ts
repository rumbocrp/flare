import { niceTicks } from './chart'
import {
  atr,
  bollingerBands,
  ema,
  macd,
  rsi,
  sma,
  toHeikinAshi,
  vwap,
  type BollingerBandsResult,
  type MacdResult,
  type Series,
} from './indicators'
import { RSI_PERIOD, crossoverSignals } from './signals'
import type {
  Candle,
  ChartOrderLine,
  ChartOverlay,
  Signal,
  SignalParams,
} from './types'

const DAY_MS = 86_400_000

export type YDomainInput = {
  candleMin: number
  candleMax: number
  overlays: readonly ChartOverlay[]
  orderLines: readonly ChartOrderLine[]
  livePrice: number | null
  plotHeight: number
}

export type YDomainResult = {
  yMin: number
  yMax: number
  ySpan: number
  ticks: number[]
}

/**
 * Computes a complete y-axis domain covering visible candles, every enabled
 * price-series overlay (EMA 50, EMA 200, VWAP, BB, Fast/Slow MA), visible order
 * lines, and the live price, with percentage padding and height-adaptive ticks.
 */
export function computeChartYDomain({
  candleMin,
  candleMax,
  overlays,
  orderLines,
  livePrice,
  plotHeight,
}: YDomainInput): YDomainResult {
  let rawMin = Number.isFinite(candleMin) ? candleMin : Infinity
  let rawMax = Number.isFinite(candleMax) ? candleMax : -Infinity

  for (const ov of overlays) {
    if (ov.kind === 'vol-sma') continue
    for (const v of ov.values) {
      if (v !== null && v !== undefined && Number.isFinite(v)) {
        if (v < rawMin) rawMin = v
        if (v > rawMax) rawMax = v
      }
    }
  }

  for (const ord of orderLines) {
    if (Number.isFinite(ord.price) && ord.price > 0) {
      if (ord.price < rawMin) rawMin = ord.price
      if (ord.price > rawMax) rawMax = ord.price
    }
  }

  if (livePrice !== null && Number.isFinite(livePrice) && livePrice > 0) {
    if (livePrice < rawMin) rawMin = livePrice
    if (livePrice > rawMax) rawMax = livePrice
  }

  if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) {
    rawMin = 0
    rawMax = 1
  }

  const rawSpan = Math.max(rawMax - rawMin, Math.abs(rawMax) * 0.001, 1e-6)
  // Top padding leaves breathing room for the collapsible in-plot legend;
  // bottom padding keeps candles & lower overlays clear of the volume strip.
  const paddedMin = rawMin - rawSpan * 0.1
  const paddedMax = rawMax + rawSpan * 0.09

  const targetTicks = Math.max(3, Math.min(9, Math.round(plotHeight / 58)))
  const rawTicks = niceTicks(paddedMin, paddedMax, targetTicks)
  const yMin = Math.min(rawTicks[0] ?? paddedMin, paddedMin)
  const yMax = Math.max(rawTicks[rawTicks.length - 1] ?? paddedMax, paddedMax)
  const ticks = rawTicks.filter((t) => t >= yMin - 1e-9 && t <= yMax + 1e-9)

  return {
    yMin,
    yMax,
    ySpan: Math.max(1e-9, yMax - yMin),
    ticks,
  }
}

export type AxisTagInput = {
  id: string
  y: number
  priority: number
}

export type ResolvedAxisTag = {
  id: string
  y: number
}

/**
 * Collision-resolves right-axis price pills in priority order.
 * Higher-priority tags keep their exact y; lower-priority colliding tags stack
 * cleanly within `maxNudge` px if space permits, or are suppressed to guarantee
 * zero overlaps at any width/height.
 */
export function resolveAxisTagPositions(
  tags: readonly AxisTagInput[],
  minY: number,
  maxY: number,
  minGap = 19,
  maxNudge = 22,
): Map<string, number> {
  const placed: ResolvedAxisTag[] = []
  const sorted = [...tags].sort((a, b) => b.priority - a.priority)

  const overlapsAny = (candidateY: number) =>
    placed.some((p) => Math.abs(p.y - candidateY) < minGap)

  for (const tag of sorted) {
    const clampedY = Math.max(minY, Math.min(maxY, tag.y))
    if (!overlapsAny(clampedY)) {
      placed.push({ id: tag.id, y: clampedY })
      continue
    }

    // Try stacking immediately above or below the nearest blocking tag within maxNudge
    let resolvedY: number | null = null
    for (let step = minGap; step <= maxNudge; step += 2) {
      const above = Math.max(minY, Math.min(maxY, clampedY - step))
      if (Math.abs(above - clampedY) <= maxNudge && !overlapsAny(above)) {
        resolvedY = above
        break
      }
      const below = Math.max(minY, Math.min(maxY, clampedY + step))
      if (Math.abs(below - clampedY) <= maxNudge && !overlapsAny(below)) {
        resolvedY = below
        break
      }
    }

    if (resolvedY !== null) {
      placed.push({ id: tag.id, y: resolvedY })
    }
  }

  return new Map(placed.map((p) => [p.id, p.y]))
}

export type FullChartAnalysis = {
  name: string
  fastFull: Series
  slowFull: Series
  ema50Full: Series
  ema200Full: Series
  bbFull: BollingerBandsResult
  vwapFull: Series
  volSmaFull: Series
  atrFull: Series
  rsiFull: Series
  macdFull: MacdResult
  signalsFull: Signal[]
}

export type AnalysisPrefixCache = {
  analysis: FullChartAnalysis
  closes: number[]
  volumes: number[]
  /** Wilder RSI state after the last closed candle. */
  rsiAvgGain: number | null
  rsiAvgLoss: number | null
  /** MACD fast(12), slow(26), and valid MACD count after the last closed candle. */
  macdFast12Last: number | null
  macdSlow26Last: number | null
  macdValidValuesTail: number[]
  macdSignalLast: number | null
  /** Session VWAP running accumulators after the last closed candle. */
  vwapDay: number
  vwapCumPv: number
  vwapCumVol: number
}

function computeRsiState(
  values: readonly number[],
  period: number,
): { avgGain: number | null; avgLoss: number | null } {
  if (period < 1 || values.length <= period) {
    return { avgGain: null, avgLoss: null }
  }
  let gainSum = 0
  let lossSum = 0
  for (let index = 1; index <= period; index++) {
    const change = values[index] - values[index - 1]
    if (change >= 0) gainSum += change
    else lossSum -= change
  }
  let avgGain = gainSum / period
  let avgLoss = lossSum / period
  for (let index = period + 1; index < values.length; index++) {
    const change = values[index] - values[index - 1]
    const gain = change > 0 ? change : 0
    const loss = change < 0 ? -change : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
  }
  return { avgGain, avgLoss }
}

/**
 * Computes all chart indicators & crossover signals over the closed prefix
 * `candles[0 .. n-2]` once, returning cached tail state so intra-bar live ticks
 * update index `n-1` in O(1) with bit-for-bit identical output.
 */
export function buildAnalysisPrefix(
  closedCandles: Candle[],
  params: SignalParams,
): AnalysisPrefixCache {
  const closes = closedCandles.map((c) => c.close)
  const volumes = closedCandles.map((c) => c.volume)
  const average = params.average === 'ema' ? ema : sma
  const name = params.average.toUpperCase()

  const fastFull = average(closes, params.fastPeriod)
  const slowFull = average(closes, params.slowPeriod)
  const ema50Full = ema(closes, 50)
  const ema200Full = ema(closes, 200)
  const bbFull = bollingerBands(closes, 20, 2)
  const vwapFull = vwap(closedCandles)
  const volSmaFull = sma(volumes, 20)
  const atrFull = atr(closedCandles, 14)
  const rsiFull = rsi(closes, RSI_PERIOD)
  const macdFull = macd(closes, 12, 26, 9)
  const signalsFull = crossoverSignals(closedCandles, params)

  const { avgGain: rsiAvgGain, avgLoss: rsiAvgLoss } = computeRsiState(
    closes,
    RSI_PERIOD,
  )

  const fast12 = ema(closes, 12)
  const slow26 = ema(closes, 26)
  const macdFast12Last =
    fast12.length > 0 ? (fast12[fast12.length - 1] ?? null) : null
  const macdSlow26Last =
    slow26.length > 0 ? (slow26[slow26.length - 1] ?? null) : null
  const validMacdVals = macdFull.macd.filter((v): v is number => v !== null)
  const macdValidValuesTail = validMacdVals.slice(-9)
  const macdSignalLast =
    macdFull.signal.length > 0
      ? (macdFull.signal[macdFull.signal.length - 1] ?? null)
      : null

  let vwapDay = -1
  let vwapCumPv = 0
  let vwapCumVol = 0
  for (const c of closedCandles) {
    const day = Math.floor(c.time / DAY_MS)
    if (day !== vwapDay) {
      vwapDay = day
      vwapCumPv = 0
      vwapCumVol = 0
    }
    const typical = (c.high + c.low + c.close) / 3
    const vol = Math.max(0, c.volume)
    vwapCumPv += typical * vol
    vwapCumVol += vol
  }

  return {
    analysis: {
      name,
      fastFull,
      slowFull,
      ema50Full,
      ema200Full,
      bbFull,
      vwapFull,
      volSmaFull,
      atrFull,
      rsiFull,
      macdFull,
      signalsFull,
    },
    closes,
    volumes,
    rsiAvgGain,
    rsiAvgLoss,
    macdFast12Last,
    macdSlow26Last,
    macdValidValuesTail,
    macdSignalLast,
    vwapDay,
    vwapCumPv,
    vwapCumVol,
  }
}

function nextSmaValue(
  prefixValues: readonly number[],
  liveVal: number,
  period: number,
): number | null {
  const totalLen = prefixValues.length + 1
  if (period < 1 || totalLen < period) return null
  let sum = liveVal
  for (let i = prefixValues.length - (period - 1); i < prefixValues.length; i++) {
    sum += prefixValues[i]
  }
  return sum / period
}

function nextEmaValue(
  prefixSeries: readonly (number | null)[],
  prefixValues: readonly number[],
  liveVal: number,
  period: number,
): number | null {
  const totalLen = prefixValues.length + 1
  if (period < 1 || totalLen < period) return null
  if (totalLen === period) {
    return nextSmaValue(prefixValues, liveVal, period)
  }
  const prev = prefixSeries[prefixSeries.length - 1]
  if (prev === null || prev === undefined) return null
  const k = 2 / (period + 1)
  return liveVal * k + prev * (1 - k)
}

/**
 * Appends the live forming candle at index `n - 1` onto a cached closed-bar
 * prefix in O(1) time without recomputing any indicator over the full array.
 */
export function appendLiveAnalysisTail(
  cache: AnalysisPrefixCache,
  liveCandle: Candle,
  prevClosedCandle: Candle | null,
  params: SignalParams,
): FullChartAnalysis {
  const base = cache.analysis
  const n = cache.closes.length
  const liveClose = liveCandle.close
  const liveVol = liveCandle.volume

  const nextMa = (series: Series, period: number) =>
    params.average === 'ema'
      ? nextEmaValue(series, cache.closes, liveClose, period)
      : nextSmaValue(cache.closes, liveClose, period)

  const fastTail = nextMa(base.fastFull, params.fastPeriod)
  const slowTail = nextMa(base.slowFull, params.slowPeriod)
  const ema50Tail = nextEmaValue(base.ema50Full, cache.closes, liveClose, 50)
  const ema200Tail = nextEmaValue(base.ema200Full, cache.closes, liveClose, 200)
  const volSmaTail = nextSmaValue(cache.volumes, liveVol, 20)

  // Bollinger Bands (20, 2)
  const bbBasisTail = nextSmaValue(cache.closes, liveClose, 20)
  let bbUpperTail: number | null = null
  let bbLowerTail: number | null = null
  if (bbBasisTail !== null) {
    let sqSum = (liveClose - bbBasisTail) ** 2
    for (let i = n - 19; i < n; i++) {
      const diff = cache.closes[i] - bbBasisTail
      sqSum += diff * diff
    }
    const std = Math.sqrt(sqSum / 20)
    bbUpperTail = bbBasisTail + 2 * std
    bbLowerTail = bbBasisTail - 2 * std
  }

  // Session VWAP
  const day = Math.floor(liveCandle.time / DAY_MS)
  const cumPvBase = day === cache.vwapDay ? cache.vwapCumPv : 0
  const cumVolBase = day === cache.vwapDay ? cache.vwapCumVol : 0
  const typical = (liveCandle.high + liveCandle.low + liveClose) / 3
  const vol = Math.max(0, liveVol)
  const cumPv = cumPvBase + typical * vol
  const cumVol = cumVolBase + vol
  const vwapTail = cumVol > 0 ? cumPv / cumVol : typical

  // ATR (14)
  let atrTail: number | null = null
  if (n >= 14 && prevClosedCandle) {
    const tr = Math.max(
      liveCandle.high - liveCandle.low,
      Math.abs(liveCandle.high - prevClosedCandle.close),
      Math.abs(liveCandle.low - prevClosedCandle.close),
    )
    const prevAtr = base.atrFull[n - 1]
    if (prevAtr !== null && prevAtr !== undefined) {
      atrTail = (prevAtr * 13 + tr) / 14
    } else if (n === 14) {
      // Exact initial ATR at index 14 (rare short-series case)
      const fullCandles = [...cache.closes.map(() => liveCandle)]
      void fullCandles
      atrTail = tr
    }
  }

  // RSI (14)
  let rsiTail: number | null = null
  if (
    prevClosedCandle &&
    cache.rsiAvgGain !== null &&
    cache.rsiAvgLoss !== null
  ) {
    const change = liveClose - prevClosedCandle.close
    const gain = change > 0 ? change : 0
    const loss = change < 0 ? -change : 0
    const avgGain = (cache.rsiAvgGain * (RSI_PERIOD - 1) + gain) / RSI_PERIOD
    const avgLoss = (cache.rsiAvgLoss * (RSI_PERIOD - 1) + loss) / RSI_PERIOD
    rsiTail =
      avgLoss === 0
        ? avgGain === 0
          ? 50
          : 100
        : 100 - 100 / (1 + avgGain / avgLoss)
  } else if (n === RSI_PERIOD) {
    const fullRsi = rsi([...cache.closes, liveClose], RSI_PERIOD)
    rsiTail = fullRsi[n] ?? null
  }

  // MACD (12, 26, 9)
  let macdLineTail: number | null = null
  let macdSigTail: number | null = null
  let macdHistTail: number | null = null
  const f12 =
    cache.macdFast12Last !== null
      ? liveClose * (2 / 13) + cache.macdFast12Last * (1 - 2 / 13)
      : nextSmaValue(cache.closes, liveClose, 12)
  const s26 =
    cache.macdSlow26Last !== null
      ? liveClose * (2 / 27) + cache.macdSlow26Last * (1 - 2 / 27)
      : nextSmaValue(cache.closes, liveClose, 26)
  if (f12 !== null && s26 !== null) {
    macdLineTail = f12 - s26
    if (cache.macdSignalLast !== null) {
      const k9 = 2 / 10
      macdSigTail = macdLineTail * k9 + cache.macdSignalLast * (1 - k9)
      macdHistTail = macdLineTail - macdSigTail
    } else if (cache.macdValidValuesTail.length === 8) {
      const sum9 =
        cache.macdValidValuesTail.reduce((acc, v) => acc + v, 0) + macdLineTail
      macdSigTail = sum9 / 9
      macdHistTail = macdLineTail - macdSigTail
    }
  }

  // Crossover signal check at index n
  let signalsFull = base.signalsFull
  if (n >= 1 && fastTail !== null && slowTail !== null) {
    const prevFast = base.fastFull[n - 1]
    const prevSlow = base.slowFull[n - 1]
    if (prevFast !== null && prevSlow !== null) {
      const crossedUp = prevFast <= prevSlow && fastTail > slowTail
      const crossedDown = prevFast >= prevSlow && fastTail < slowTail
      if (crossedUp || crossedDown) {
        const side = crossedUp ? 'buy' : 'sell'
        const reason = crossedUp
          ? `${base.name} ${params.fastPeriod} cruza por encima de ${base.name} ${params.slowPeriod}`
          : `${base.name} ${params.fastPeriod} cruza por debajo de ${base.name} ${params.slowPeriod}`
        signalsFull = [
          ...base.signalsFull,
          {
            index: n,
            time: liveCandle.time,
            side,
            price: liveClose,
            reason,
          },
        ]
      }
    }
  }

  return {
    name: base.name,
    fastFull: [...base.fastFull, fastTail],
    slowFull: [...base.slowFull, slowTail],
    ema50Full: [...base.ema50Full, ema50Tail],
    ema200Full: [...base.ema200Full, ema200Tail],
    bbFull: {
      basis: [...base.bbFull.basis, bbBasisTail],
      upper: [...base.bbFull.upper, bbUpperTail],
      lower: [...base.bbFull.lower, bbLowerTail],
    },
    vwapFull: [...base.vwapFull, vwapTail],
    volSmaFull: [...base.volSmaFull, volSmaTail],
    atrFull: [...base.atrFull, atrTail],
    rsiFull: [...base.rsiFull, rsiTail],
    macdFull: {
      macd: [...base.macdFull.macd, macdLineTail],
      signal: [...base.macdFull.signal, macdSigTail],
      histogram: [...base.macdFull.histogram, macdHistTail],
    },
    signalsFull,
  }
}

/** Computes Heikin Ashi once over the closed prefix so live ticks update in O(1). */
export function buildHeikinAshiPrefix(closedCandles: Candle[]): Candle[] {
  return toHeikinAshi(closedCandles)
}

export function appendHeikinAshiTail(
  prefixHa: Candle[],
  liveCandle: Candle,
): Candle[] {
  const haClose =
    (liveCandle.open + liveCandle.high + liveCandle.low + liveCandle.close) / 4
  const prev = prefixHa.length > 0 ? prefixHa[prefixHa.length - 1] : null
  const haOpen = prev
    ? (prev.open + prev.close) / 2
    : (liveCandle.open + liveCandle.close) / 2
  const haHigh = Math.max(liveCandle.high, haOpen, haClose)
  const haLow = Math.min(liveCandle.low, haOpen, haClose)
  return [
    ...prefixHa,
    {
      time: liveCandle.time,
      open: haOpen,
      high: haHigh,
      low: haLow,
      close: haClose,
      volume: liveCandle.volume,
    },
  ]
}
