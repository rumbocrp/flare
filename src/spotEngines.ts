import { atr, ema, rsi, type Series } from './indicators'
import type { Candle, TradeSide } from './types'

export type NewSpotEngineId =
  | 'donchian-breakout'
  | 'support-resistance'
  | 'break-of-structure'

export const MIN_SPOT_ENGINE_WARMUP = 55

export type DonchianParams = {
  channelPeriod: number
  exitPeriod: number
  atrPeriod: number
  atrStopMult: number
  trendFilter: 'ema200' | 'none'
  minAtrPct: number
}

export type SupportResistanceParams = {
  pivotLookback: number
  clusterAtrMult: number
  minTouches: number
  maxLevelAgeBars: number
  touchToleranceAtr: number
  atrStopMult: number
  minLongRsi: number
  maxShortRsi: number
  atrPeriod: number
}

export type BreakOfStructureParams = {
  swingLookback: number
  retestWindowBars: number
  retestToleranceAtr: number
  stopBufferAtr: number
  targetRMultiple: number
  atrPeriod: number
  requireRetest: boolean
}

export type SpotEngineParams = Partial<DonchianParams> &
  Partial<SupportResistanceParams> &
  Partial<BreakOfStructureParams>

export type SpotEngineSignal = {
  index: number
  time: number
  side: TradeSide
  stopPrice?: number
  targetPrice?: number
  reason: string
}

export type SpotEnginePrecomputed = {
  closes: number[]
  ema200: Series
  rsi14: Series
  atrPeriod: number
  atrSeries: Series
}

export const DEFAULT_DONCHIAN_PARAMS: DonchianParams = {
  channelPeriod: 20,
  exitPeriod: 10,
  atrPeriod: 14,
  atrStopMult: 2,
  trendFilter: 'ema200',
  minAtrPct: 0.15,
}

export const DEFAULT_SR_PARAMS: SupportResistanceParams = {
  pivotLookback: 2,
  clusterAtrMult: 0.35,
  minTouches: 2,
  maxLevelAgeBars: 300,
  touchToleranceAtr: 0.25,
  atrStopMult: 1.0,
  minLongRsi: 40,
  maxShortRsi: 60,
  atrPeriod: 14,
}

export const DEFAULT_BOS_PARAMS: BreakOfStructureParams = {
  swingLookback: 2,
  retestWindowBars: 3,
  retestToleranceAtr: 0.5,
  stopBufferAtr: 0.25,
  targetRMultiple: 2.0,
  atrPeriod: 14,
  requireRetest: false,
}

function clampNum(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  roundInt = false,
): number {
  const n = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(n)) return fallback
  const bounded = Math.min(max, Math.max(min, n))
  return roundInt ? Math.round(bounded) : bounded
}

export function clampDonchianParams(
  raw?: Partial<DonchianParams> | null,
): DonchianParams {
  const channelPeriod = clampNum(
    raw?.channelPeriod,
    DEFAULT_DONCHIAN_PARAMS.channelPeriod,
    5,
    100,
    true,
  )
  const exitPeriod = Math.min(
    channelPeriod,
    clampNum(raw?.exitPeriod, DEFAULT_DONCHIAN_PARAMS.exitPeriod, 3, 60, true),
  )
  return {
    channelPeriod,
    exitPeriod,
    atrPeriod: clampNum(
      raw?.atrPeriod,
      DEFAULT_DONCHIAN_PARAMS.atrPeriod,
      5,
      50,
      true,
    ),
    atrStopMult: clampNum(
      raw?.atrStopMult,
      DEFAULT_DONCHIAN_PARAMS.atrStopMult,
      0.5,
      6,
    ),
    trendFilter:
      raw?.trendFilter === 'none' || raw?.trendFilter === 'ema200'
        ? raw.trendFilter
        : DEFAULT_DONCHIAN_PARAMS.trendFilter,
    minAtrPct: clampNum(
      raw?.minAtrPct,
      DEFAULT_DONCHIAN_PARAMS.minAtrPct,
      0,
      5,
    ),
  }
}

export function clampSupportResistanceParams(
  raw?: Partial<SupportResistanceParams> | null,
): SupportResistanceParams {
  const minLongRsi = clampNum(
    raw?.minLongRsi,
    DEFAULT_SR_PARAMS.minLongRsi,
    20,
    65,
    true,
  )
  const maxShortRsi = Math.max(
    minLongRsi,
    clampNum(raw?.maxShortRsi, DEFAULT_SR_PARAMS.maxShortRsi, 35, 80, true),
  )
  return {
    pivotLookback: clampNum(
      raw?.pivotLookback,
      DEFAULT_SR_PARAMS.pivotLookback,
      1,
      5,
      true,
    ),
    clusterAtrMult: clampNum(
      raw?.clusterAtrMult,
      DEFAULT_SR_PARAMS.clusterAtrMult,
      0.1,
      1.5,
    ),
    minTouches: clampNum(
      raw?.minTouches,
      DEFAULT_SR_PARAMS.minTouches,
      2,
      6,
      true,
    ),
    maxLevelAgeBars: clampNum(
      raw?.maxLevelAgeBars,
      DEFAULT_SR_PARAMS.maxLevelAgeBars,
      40,
      600,
      true,
    ),
    touchToleranceAtr: clampNum(
      raw?.touchToleranceAtr,
      DEFAULT_SR_PARAMS.touchToleranceAtr,
      0.05,
      1.0,
    ),
    atrStopMult: clampNum(
      raw?.atrStopMult,
      DEFAULT_SR_PARAMS.atrStopMult,
      0.3,
      4.0,
    ),
    minLongRsi,
    maxShortRsi,
    atrPeriod: clampNum(
      raw?.atrPeriod,
      DEFAULT_SR_PARAMS.atrPeriod,
      5,
      50,
      true,
    ),
  }
}

export function clampBreakOfStructureParams(
  raw?: Partial<BreakOfStructureParams> | null,
): BreakOfStructureParams {
  return {
    swingLookback: clampNum(
      raw?.swingLookback,
      DEFAULT_BOS_PARAMS.swingLookback,
      1,
      5,
      true,
    ),
    retestWindowBars: clampNum(
      raw?.retestWindowBars,
      DEFAULT_BOS_PARAMS.retestWindowBars,
      0,
      10,
      true,
    ),
    retestToleranceAtr: clampNum(
      raw?.retestToleranceAtr,
      DEFAULT_BOS_PARAMS.retestToleranceAtr,
      0.1,
      1.5,
    ),
    stopBufferAtr: clampNum(
      raw?.stopBufferAtr,
      DEFAULT_BOS_PARAMS.stopBufferAtr,
      0.05,
      1.5,
    ),
    targetRMultiple: clampNum(
      raw?.targetRMultiple,
      DEFAULT_BOS_PARAMS.targetRMultiple,
      1.0,
      5.0,
    ),
    atrPeriod: clampNum(
      raw?.atrPeriod,
      DEFAULT_BOS_PARAMS.atrPeriod,
      5,
      50,
      true,
    ),
    requireRetest:
      typeof raw?.requireRetest === 'boolean'
        ? raw.requireRetest
        : DEFAULT_BOS_PARAMS.requireRetest,
  }
}

export function precomputeSpotEngineSeries(
  candles: Candle[],
  atrPeriod = 14,
): SpotEnginePrecomputed {
  const safeAtrPeriod = clampNum(atrPeriod, 14, 5, 50, true)
  const closes = candles.map((c) => c.close)
  return {
    closes,
    ema200: ema(closes, 200),
    rsi14: rsi(closes, 14),
    atrPeriod: safeAtrPeriod,
    atrSeries: atr(candles, safeAtrPeriod),
  }
}

function getPrecomputed(
  candles: Candle[],
  atrPeriod: number,
  precomputed?: SpotEnginePrecomputed,
): SpotEnginePrecomputed {
  if (
    precomputed &&
    precomputed.closes.length === candles.length &&
    precomputed.atrPeriod === atrPeriod
  ) {
    return precomputed
  }
  return precomputeSpotEngineSeries(candles, atrPeriod)
}

function isPivotHigh(candles: Candle[], p: number, k: number): boolean {
  const h = candles[p].high
  for (let d = 1; d <= k; d += 1) {
    if (h <= candles[p - d].high || h <= candles[p + d].high) {
      return false
    }
  }
  return true
}

function isPivotLow(candles: Candle[], p: number, k: number): boolean {
  const l = candles[p].low
  for (let d = 1; d <= k; d += 1) {
    if (l >= candles[p - d].low || l >= candles[p + d].low) {
      return false
    }
  }
  return true
}

type LevelCluster = {
  price: number
  touches: number
}

function clusterPrices(
  prices: number[],
  tolerance: number,
  minTouches: number,
): LevelCluster[] {
  if (prices.length === 0 || tolerance <= 0) return []
  const sorted = [...prices].sort((a, b) => a - b)
  const clusters: { sum: number; count: number; anchor: number }[] = []

  for (const price of sorted) {
    const last = clusters[clusters.length - 1]
    if (last && Math.abs(price - last.anchor) <= tolerance) {
      last.sum += price
      last.count += 1
    } else {
      clusters.push({ sum: price, count: 1, anchor: price })
    }
  }

  return clusters
    .filter((c) => c.count >= minTouches)
    .map((c) => ({ price: c.sum / c.count, touches: c.count }))
}

function evaluateDonchianAt(
  candles: Candle[],
  index: number,
  rawParams?: Partial<DonchianParams> | null,
  precomputed?: SpotEnginePrecomputed,
): SpotEngineSignal | null {
  const p = clampDonchianParams(rawParams)
  if (index < Math.max(MIN_SPOT_ENGINE_WARMUP, p.channelPeriod + 1)) {
    return null
  }
  if (index >= candles.length) return null

  const series = getPrecomputed(candles, p.atrPeriod, precomputed)
  const cur = candles[index]
  const curAtr = series.atrSeries[index]
  if (curAtr === null || curAtr <= 0 || cur.close <= 0) return null

  const atrPct = (curAtr / cur.close) * 100
  if (atrPct < p.minAtrPct) return null

  // Channel strictly excludes bar `index` -> [index - channelPeriod .. index - 1]
  let upper = -Infinity
  let lower = Infinity
  for (let j = index - p.channelPeriod; j < index; j += 1) {
    if (candles[j].high > upper) upper = candles[j].high
    if (candles[j].low < lower) lower = candles[j].low
  }

  const ema200Val = series.ema200[index]
  if (p.trendFilter === 'ema200' && ema200Val === null) {
    return null
  }

  if (
    cur.close > upper &&
    (p.trendFilter === 'none' ||
      (ema200Val !== null && cur.close > ema200Val))
  ) {
    const stopPrice = cur.close - p.atrStopMult * curAtr
    if (stopPrice > 0 && stopPrice < cur.close) {
      return {
        index,
        time: cur.time,
        side: 'buy',
        stopPrice,
        reason: `Donchian(${p.channelPeriod}) bullish breakout above ${upper.toFixed(2)}`,
      }
    }
  }

  if (
    cur.close < lower &&
    (p.trendFilter === 'none' ||
      (ema200Val !== null && cur.close < ema200Val))
  ) {
    const stopPrice = cur.close + p.atrStopMult * curAtr
    if (stopPrice > cur.close) {
      return {
        index,
        time: cur.time,
        side: 'sell',
        stopPrice,
        reason: `Donchian(${p.channelPeriod}) bearish breakdown below ${lower.toFixed(2)}`,
      }
    }
  }

  return null
}

/**
 * Evaluates the Donchian opposite `exitPeriod` channel exit rule on closed bar `index`.
 * Strictly excludes bar `index` from the channel window `[index - exitPeriod .. index - 1]`.
 */
export function evaluateDonchianExit(
  candles: Candle[],
  index: number,
  openSide: TradeSide,
  rawParams?: Partial<DonchianParams> | null,
): boolean {
  const p = clampDonchianParams(rawParams)
  if (index < p.exitPeriod || index >= candles.length) return false

  const cur = candles[index]
  if (openSide === 'buy') {
    let exitLow = Infinity
    for (let j = index - p.exitPeriod; j < index; j += 1) {
      if (candles[j].low < exitLow) exitLow = candles[j].low
    }
    return cur.close < exitLow
  }

  let exitHigh = -Infinity
  for (let j = index - p.exitPeriod; j < index; j += 1) {
    if (candles[j].high > exitHigh) exitHigh = candles[j].high
  }
  return cur.close > exitHigh
}

function evaluateSupportResistanceAt(
  candles: Candle[],
  index: number,
  rawParams?: Partial<SupportResistanceParams> | null,
  precomputed?: SpotEnginePrecomputed,
): SpotEngineSignal | null {
  const p = clampSupportResistanceParams(rawParams)
  if (index < MIN_SPOT_ENGINE_WARMUP || index >= candles.length) return null

  const series = getPrecomputed(candles, p.atrPeriod, precomputed)
  const cur = candles[index]
  const curAtr = series.atrSeries[index]
  const curRsi = series.rsi14[index]
  if (curAtr === null || curAtr <= 0 || curRsi === null || cur.close <= 0) {
    return null
  }

  const k = p.pivotLookback
  const windowStart = Math.max(k, index - p.maxLevelAgeBars)
  // Strictly require pivot confirmed before `index - k`: `p + k <= index - 1` -> `p <= index - k - 1`
  const windowEnd = index - k - 1
  if (windowEnd < windowStart) return null

  const pivotPrices: number[] = []
  for (let idx = windowStart; idx <= windowEnd; idx += 1) {
    if (isPivotHigh(candles, idx, k)) {
      pivotPrices.push(candles[idx].high)
    }
    if (isPivotLow(candles, idx, k)) {
      pivotPrices.push(candles[idx].low)
    }
  }

  const clusters = clusterPrices(
    pivotPrices,
    p.clusterAtrMult * curAtr,
    p.minTouches,
  )
  if (clusters.length === 0) return null

  const touchBand = p.touchToleranceAtr * curAtr

  // Bullish support bounce
  if (cur.close > cur.open && curRsi >= p.minLongRsi) {
    let bestSupport: LevelCluster | null = null
    for (const c of clusters) {
      if (cur.low <= c.price + touchBand && cur.close > c.price) {
        if (!bestSupport || c.price > bestSupport.price) {
          bestSupport = c
        }
      }
    }
    if (bestSupport) {
      const stopPrice = bestSupport.price - p.atrStopMult * curAtr
      const risk = cur.close - stopPrice
      if (stopPrice > 0 && risk > 0) {
        const resistanceAbove = clusters.find(
          (c) => c.price > cur.close + risk * 0.5,
        )
        const targetPrice = resistanceAbove
          ? resistanceAbove.price
          : cur.close + 2 * risk
        return {
          index,
          time: cur.time,
          side: 'buy',
          stopPrice,
          targetPrice,
          reason: `Support bounce at ${bestSupport.price.toFixed(2)} (${bestSupport.touches} touches)`,
        }
      }
    }
  }

  // Bearish resistance rejection (mirror)
  if (cur.close < cur.open && curRsi <= p.maxShortRsi) {
    let bestResistance: LevelCluster | null = null
    for (const c of clusters) {
      if (cur.high >= c.price - touchBand && cur.close < c.price) {
        if (!bestResistance || c.price < bestResistance.price) {
          bestResistance = c
        }
      }
    }
    if (bestResistance) {
      const stopPrice = bestResistance.price + p.atrStopMult * curAtr
      const risk = stopPrice - cur.close
      if (risk > 0) {
        const supportsBelow = clusters.filter(
          (c) => c.price < cur.close - risk * 0.5,
        )
        const nearestSupport =
          supportsBelow.length > 0
            ? supportsBelow[supportsBelow.length - 1]
            : null
        const targetPrice = nearestSupport
          ? nearestSupport.price
          : cur.close - 2 * risk
        if (targetPrice > 0) {
          return {
            index,
            time: cur.time,
            side: 'sell',
            stopPrice,
            targetPrice,
            reason: `Resistance rejection at ${bestResistance.price.toFixed(2)} (${bestResistance.touches} touches)`,
          }
        }
      }
    }
  }

  return null
}

type ConfirmedSwing = {
  index: number
  price: number
}

function collectSwingsUpTo(
  candles: Candle[],
  maxPivotIndex: number,
  k: number,
  lookbackLimit = 300,
): { highs: ConfirmedSwing[]; lows: ConfirmedSwing[] } {
  const start = Math.max(k, maxPivotIndex - lookbackLimit)
  const highs: ConfirmedSwing[] = []
  const lows: ConfirmedSwing[] = []
  for (let p = start; p <= maxPivotIndex; p += 1) {
    if (isPivotHigh(candles, p, k)) {
      highs.push({ index: p, price: candles[p].high })
    }
    if (isPivotLow(candles, p, k)) {
      lows.push({ index: p, price: candles[p].low })
    }
  }
  return { highs, lows }
}

function evaluateBreakOfStructureAt(
  candles: Candle[],
  index: number,
  rawParams?: Partial<BreakOfStructureParams> | null,
  precomputed?: SpotEnginePrecomputed,
): SpotEngineSignal | null {
  const p = clampBreakOfStructureParams(rawParams)
  if (index < MIN_SPOT_ENGINE_WARMUP || index >= candles.length) return null

  const series = getPrecomputed(candles, p.atrPeriod, precomputed)
  const cur = candles[index]
  const prev = candles[index - 1]
  const curAtr = series.atrSeries[index]
  if (curAtr === null || curAtr <= 0 || cur.close <= 0) return null

  const k = p.swingLookback
  // Strictly confirmed before bar `index`: p + k <= index - 1 -> p <= index - k - 1
  const maxPivot = index - k - 1
  if (maxPivot < k) return null

  const { highs, lows } = collectSwingsUpTo(candles, maxPivot, k)

  // 1. Bullish BOS: close > lastConfirmedSwingHigh AND prior swing low > swing low before it
  if (highs.length >= 1 && lows.length >= 2) {
    const lastHigh = highs[highs.length - 1]
    const lastLow = lows[lows.length - 1]
    const prevLow = lows[lows.length - 2]

    if (lastLow.price > prevLow.price) {
      const freshBosClose =
        cur.close > lastHigh.price && prev.close <= lastHigh.price

      if (freshBosClose && !p.requireRetest) {
        const stopPrice = lastLow.price - p.stopBufferAtr * curAtr
        const risk = cur.close - stopPrice
        if (stopPrice > 0 && risk > 0) {
          return {
            index,
            time: cur.time,
            side: 'buy',
            stopPrice,
            targetPrice: cur.close + p.targetRMultiple * risk,
            reason: `Bullish BOS close above ${lastHigh.price.toFixed(2)} (HL ${lastLow.price.toFixed(2)})`,
          }
        }
      }

      // Retest within `retestWindowBars` after a recent BOS break of the same swing high
      if (p.retestWindowBars > 0 && cur.close > lastHigh.price) {
        const minBosBar = Math.max(lastHigh.index + k + 1, index - p.retestWindowBars)
        for (let b = index - 1; b >= minBosBar; b -= 1) {
          if (
            candles[b].close > lastHigh.price &&
            candles[b - 1].close <= lastHigh.price
          ) {
            // Check invalidation: any bar between b+1 and index-1 closed back below broken level
            let invalidated = false
            for (let m = b + 1; m < index; m += 1) {
              if (candles[m].close < lastHigh.price) {
                invalidated = true
                break
              }
            }
            if (
              !invalidated &&
              cur.low <= lastHigh.price + p.retestToleranceAtr * curAtr
            ) {
              const stopPrice = lastLow.price - p.stopBufferAtr * curAtr
              const risk = cur.close - stopPrice
              if (stopPrice > 0 && risk > 0) {
                return {
                  index,
                  time: cur.time,
                  side: 'buy',
                  stopPrice,
                  targetPrice: cur.close + p.targetRMultiple * risk,
                  reason: `Bullish BOS retest of ${lastHigh.price.toFixed(2)} (HL ${lastLow.price.toFixed(2)})`,
                }
              }
            }
            break
          }
        }
      }
    }
  }

  // 2. Bearish BOS (exact mirror): close < lastConfirmedSwingLow AND prior swing high < swing high before it
  if (lows.length >= 1 && highs.length >= 2) {
    const lastLow = lows[lows.length - 1]
    const lastHigh = highs[highs.length - 1]
    const prevHigh = highs[highs.length - 2]

    if (lastHigh.price < prevHigh.price) {
      const freshBosClose =
        cur.close < lastLow.price && prev.close >= lastLow.price

      if (freshBosClose && !p.requireRetest) {
        const stopPrice = lastHigh.price + p.stopBufferAtr * curAtr
        const risk = stopPrice - cur.close
        if (risk > 0) {
          const targetPrice = cur.close - p.targetRMultiple * risk
          if (targetPrice > 0) {
            return {
              index,
              time: cur.time,
              side: 'sell',
              stopPrice,
              targetPrice,
              reason: `Bearish BOS close below ${lastLow.price.toFixed(2)} (LH ${lastHigh.price.toFixed(2)})`,
            }
          }
        }
      }

      if (p.retestWindowBars > 0 && cur.close < lastLow.price) {
        const minBosBar = Math.max(lastLow.index + k + 1, index - p.retestWindowBars)
        for (let b = index - 1; b >= minBosBar; b -= 1) {
          if (
            candles[b].close < lastLow.price &&
            candles[b - 1].close >= lastLow.price
          ) {
            let invalidated = false
            for (let m = b + 1; m < index; m += 1) {
              if (candles[m].close > lastLow.price) {
                invalidated = true
                break
              }
            }
            if (
              !invalidated &&
              cur.high >= lastLow.price - p.retestToleranceAtr * curAtr
            ) {
              const stopPrice = lastHigh.price + p.stopBufferAtr * curAtr
              const risk = stopPrice - cur.close
              if (risk > 0) {
                const targetPrice = cur.close - p.targetRMultiple * risk
                if (targetPrice > 0) {
                  return {
                    index,
                    time: cur.time,
                    side: 'sell',
                    stopPrice,
                    targetPrice,
                    reason: `Bearish BOS retest of ${lastLow.price.toFixed(2)} (LH ${lastHigh.price.toFixed(2)})`,
                  }
                }
              }
            }
            break
          }
        }
      }
    }
  }

  return null
}

/**
 * Evaluates one of the three deterministic new spot engines strictly at bar `index`
 * using ONLY candles `0..index` (zero lookahead).
 */
export function signalAt(
  engine: NewSpotEngineId,
  candles: Candle[],
  index: number,
  params?: SpotEngineParams | null,
  precomputed?: SpotEnginePrecomputed,
): SpotEngineSignal | null {
  if (engine === 'donchian-breakout') {
    return evaluateDonchianAt(candles, index, params, precomputed)
  }
  if (engine === 'support-resistance') {
    return evaluateSupportResistanceAt(candles, index, params, precomputed)
  }
  return evaluateBreakOfStructureAt(candles, index, params, precomputed)
}

/**
 * Generates all deterministic signals across a candle series for one of the three
 * new spot engines by calling `signalAt` at every closed bar with shared precomputed
 * causal indicator series.
 */
export function generateSignals(
  engine: NewSpotEngineId,
  candles: Candle[],
  params?: SpotEngineParams | null,
): SpotEngineSignal[] {
  if (candles.length <= MIN_SPOT_ENGINE_WARMUP) return []
  const atrPeriod = clampNum(params?.atrPeriod, 14, 5, 50, true)
  const precomputed = precomputeSpotEngineSeries(candles, atrPeriod)
  const out: SpotEngineSignal[] = []
  for (let i = MIN_SPOT_ENGINE_WARMUP; i < candles.length; i += 1) {
    const sig = signalAt(engine, candles, i, params, precomputed)
    if (sig) out.push(sig)
  }
  return out
}

export function isNewSpotEngine(engine: string | undefined): engine is NewSpotEngineId {
  return (
    engine === 'donchian-breakout' ||
    engine === 'support-resistance' ||
    engine === 'break-of-structure'
  )
}
