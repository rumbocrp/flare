import type { Candle, Interval } from './types'
import { bollingerBands, ema, rsi, sma } from './indicators'

export type PredictionOutcome = 'YES' | 'NO'

export type PredictionRule = {
  id: string
  number: number
  timeframe: Interval
  title: string
  contractQuestion: string
  predictedOutcome: PredictionOutcome
  horizonBars: number
  category: 'reversion' | 'momentum' | 'volatility' | 'structure'
  condition: (ctx: MarketContext, index: number) => boolean
  resolve: (ctx: MarketContext, index: number) => boolean
}

export type MarketContext = {
  candles: Candle[]
  closes: number[]
  volumes: number[]
  returns: number[]
  ranges: number[]
  rsi14: (number | null)[]
  sma20: (number | null)[]
  ema50: (number | null)[]
  ema200: (number | null)[]
  volSma20: (number | null)[]
  bbLower20: (number | null)[]
  bbUpper20: (number | null)[]
}

type PredictionBacktestStats = {
  ruleId: string
  number: number
  timeframe: Interval
  title: string
  contractQuestion: string
  predictedOutcome: PredictionOutcome
  horizonBars: number
  triggers: number
  hits: number
  winRatePct: number
  wilsonLowerBoundPct: number
  edgeVs5050Pct: number
  fairYesPrice: number
  quarterKellyPct: number
  isStatisticallySignificant: boolean
  currentlyActive: boolean
  recentOutcomes: boolean[]
}

/**
 * Computes the lower bound of the Wilson score confidence interval (95%, z = 1.96).
 * Prevents overestimating accuracy on small sample sizes (e.g., 2 hits out of 2 signals).
 */
export function computeWilsonLowerBoundPct(
  hits: number,
  triggers: number,
  z = 1.96,
): number {
  if (triggers <= 0 || hits <= 0) return 0
  const p = Math.min(1, Math.max(0, hits / triggers))
  const z2 = z * z
  const denom = 1 + z2 / triggers
  const center = p + z2 / (2 * triggers)
  const spread =
    z *
    Math.sqrt((p * (1 - p) + z2 / (4 * triggers)) / triggers)
  const lower = Math.max(0, (center - spread) / denom)
  return Math.round(lower * 1000) / 10
}

export function buildMarketContext(candles: Candle[]): MarketContext {
  const closes = candles.map((c) => c.close)
  const volumes = candles.map((c) => c.volume)
  const returns = candles.map((c) =>
    c.open > 0 ? ((c.close - c.open) / c.open) * 100 : 0,
  )
  const ranges = candles.map((c) =>
    c.open > 0 ? ((c.high - c.low) / c.open) * 100 : 0,
  )

  const rsi14 = rsi(closes, 14)
  const ema50 = ema(closes, 50)
  const ema200 = ema(closes, 200)
  const volSma20 = sma(volumes, 20)
  const {
    basis: sma20,
    lower: bbLower20,
    upper: bbUpper20,
  } = bollingerBands(closes, 20, 2)

  return {
    candles,
    closes,
    volumes,
    returns,
    ranges,
    rsi14,
    sma20,
    ema50,
    ema200,
    volSma20,
    bbLower20,
    bbUpper20,
  }
}

function bodyPosition(candle: Candle): number {
  const span = candle.high - candle.low
  if (span <= 0) return 0.5
  return (candle.close - candle.low) / span
}

function lowerWickRatio(candle: Candle): number {
  const span = candle.high - candle.low
  if (span <= 0) return 0
  const bodyLow = Math.min(candle.open, candle.close)
  return (bodyLow - candle.low) / span
}

export const BITCOIN_20_PREDICTIONS: PredictionRule[] = [
  // ======================== 5 MINUTES (5m) ========================
  {
    id: 'm5-ema50-bear-cap',
    number: 1,
    timeframe: '5m',
    title: 'EMA 50 cap during bearish trend (5m)',
    contractQuestion:
      'Will BTC close below the 5m EMA 50 on at least 2 of the next 3 candles when EMA50 < EMA200?',
    predictedOutcome: 'YES',
    horizonBars: 3,
    category: 'structure',
    condition: (ctx, i) => {
      const e50 = ctx.ema50[i]
      const e200 = ctx.ema200[i]
      const s20 = ctx.sma20[i]
      return (
        e50 !== null &&
        e200 !== null &&
        s20 !== null &&
        e50 < e200 &&
        ctx.candles[i].close >= s20 &&
        ctx.candles[i].close <= e50 * 1.001
      )
    },
    resolve: (ctx, i) => {
      const e50 = ctx.ema50[i]
      if (e50 === null) return false
      let belowCount = 0
      for (let k = 1; k <= 3; k++) {
        if (ctx.candles[i + k].close < e50) belowCount++
      }
      return belowCount >= 2
    },
  },
  {
    id: 'm5-3red-oversold-bounce',
    number: 2,
    timeframe: '5m',
    title: 'Micro reversion after 3 red candles + RSI < 32 (5m)',
    contractQuestion:
      'After 3 red 5m candles with RSI(14) < 32, will any of the next 3 candles close above the current close?',
    predictedOutcome: 'YES',
    horizonBars: 3,
    category: 'reversion',
    condition: (ctx, i) => {
      const r = ctx.rsi14[i]
      return (
        i >= 2 &&
        r !== null &&
        r < 32 &&
        ctx.returns[i] < 0 &&
        ctx.returns[i - 1] < 0 &&
        ctx.returns[i - 2] < 0
      )
    },
    resolve: (ctx, i) =>
      Math.max(
        ctx.candles[i + 1].close,
        ctx.candles[i + 2].close,
        ctx.candles[i + 3].close,
      ) > ctx.candles[i].close,
  },
  {
    id: 'm5-strong-body-follow',
    number: 3,
    timeframe: '5m',
    title: 'Immediate continuation on top-15% close (5m)',
    contractQuestion:
      'When a 5m candle (range > 0.25%) closes in its top 15%, will the next candle make a higher high?',
    predictedOutcome: 'YES',
    horizonBars: 1,
    category: 'momentum',
    condition: (ctx, i) =>
      ctx.ranges[i] > 0.25 && bodyPosition(ctx.candles[i]) > 0.85,
    resolve: (ctx, i) => ctx.candles[i + 1].high > ctx.candles[i].high,
  },
  {
    id: 'm5-vol-climax-wick-hold',
    number: 4,
    timeframe: '5m',
    title: 'Low sweep defense after volume-climax wick (5m)',
    contractQuestion:
      'With volume > 2.2x average and lower wick > 45%, do the next 2 candles close above the sweep low?',
    predictedOutcome: 'YES',
    horizonBars: 2,
    category: 'reversion',
    condition: (ctx, i) => {
      const avgV = ctx.volSma20[i]
      return (
        avgV !== null &&
        ctx.volumes[i] > 2.2 * avgV &&
        lowerWickRatio(ctx.candles[i]) > 0.45
      )
    },
    resolve: (ctx, i) =>
      Math.min(ctx.candles[i + 1].close, ctx.candles[i + 2].close) >
      ctx.candles[i].low,
  },

  // ======================== 15 MINUTES (15m) ========================
  {
    id: 'm15-sma20-bear-hold',
    number: 5,
    timeframe: '15m',
    title: 'Cap below SMA 20 with RSI < 45 (15m)',
    contractQuestion:
      'With price below the 15m SMA 20 and RSI(14) < 45, will the next 15m candle close below SMA 20?',
    predictedOutcome: 'YES',
    horizonBars: 1,
    category: 'structure',
    condition: (ctx, i) => {
      const s20 = ctx.sma20[i]
      const prevS20 = ctx.sma20[i - 1]
      const r = ctx.rsi14[i]
      return (
        s20 !== null &&
        prevS20 !== null &&
        r !== null &&
        r < 45 &&
        ctx.candles[i].close < s20 &&
        ctx.candles[i - 1].close < prevS20
      )
    },
    resolve: (ctx, i) => {
      const s20 = ctx.sma20[i]
      return s20 !== null && ctx.candles[i + 1].close < s20
    },
  },
  {
    id: 'm15-inside-bar-breakout',
    number: 6,
    timeframe: '15m',
    title: 'Inside Bar breakout within 30 min (15m)',
    contractQuestion:
      'After an Inside Bar forms on 15m, will price break its high or low within the next 2 candles?',
    predictedOutcome: 'YES',
    horizonBars: 2,
    category: 'volatility',
    condition: (ctx, i) =>
      i >= 1 &&
      ctx.candles[i].high < ctx.candles[i - 1].high &&
      ctx.candles[i].low > ctx.candles[i - 1].low,
    resolve: (ctx, i) =>
      Math.max(ctx.candles[i + 1].high, ctx.candles[i + 2].high) >
        ctx.candles[i].high ||
      Math.min(ctx.candles[i + 1].low, ctx.candles[i + 2].low) <
        ctx.candles[i].low,
  },
  {
    id: 'm15-weak-close-lower-low',
    number: 7,
    timeframe: '15m',
    title: 'Bearish follow-through after bottom-15% close (15m)',
    contractQuestion:
      'If a 15m candle (range > 0.40%) closes in its bottom 15%, will the next candle make a lower low?',
    predictedOutcome: 'YES',
    horizonBars: 1,
    category: 'momentum',
    condition: (ctx, i) =>
      ctx.ranges[i] > 0.4 && bodyPosition(ctx.candles[i]) < 0.15,
    resolve: (ctx, i) => ctx.candles[i + 1].low < ctx.candles[i].low,
  },
  {
    id: 'm15-oversold-relief',
    number: 8,
    timeframe: '15m',
    title: 'Technical bounce >= +0.30% after RSI < 28 oversold (15m)',
    contractQuestion:
      'When 15m RSI(14) drops below 28, will the high rise at least +0.30% within the next 4 candles (1h)?',
    predictedOutcome: 'YES',
    horizonBars: 4,
    category: 'reversion',
    condition: (ctx, i) => {
      const r = ctx.rsi14[i]
      return r !== null && r < 28
    },
    resolve: (ctx, i) =>
      Math.max(
        ctx.candles[i + 1].high,
        ctx.candles[i + 2].high,
        ctx.candles[i + 3].high,
        ctx.candles[i + 4].high,
      ) >=
      ctx.candles[i].close * 1.003,
  },

  // ======================== 1 HOUR (1h) ========================
  {
    id: 'h1-ny-open-volatility',
    number: 9,
    timeframe: '1h',
    title: 'Range expansion > 0.45% at NY open 13:00-15:00 UTC (1h)',
    contractQuestion:
      'At the Wall Street open (13:00-14:00 UTC), will the hourly range exceed 0.45% in that candle or the next?',
    predictedOutcome: 'YES',
    horizonBars: 1,
    category: 'volatility',
    condition: (ctx, i) => {
      const hour = new Date(ctx.candles[i].time).getUTCHours()
      return hour === 13 || hour === 14
    },
    resolve: (ctx, i) => Math.max(ctx.ranges[i], ctx.ranges[i + 1]) > 0.45,
  },
  {
    id: 'h1-3red-bounce',
    number: 10,
    timeframe: '1h',
    title: 'Bullish relief within 2h after 3 red hourly candles (1h)',
    contractQuestion:
      'After 3 consecutive red 1h candles with RSI(14) < 48, will either of the next 2 hours close above the current close?',
    predictedOutcome: 'YES',
    horizonBars: 2,
    category: 'reversion',
    condition: (ctx, i) => {
      const r = ctx.rsi14[i]
      return (
        i >= 2 &&
        r !== null &&
        r < 48 &&
        ctx.returns[i] < 0 &&
        ctx.returns[i - 1] < 0 &&
        ctx.returns[i - 2] < 0
      )
    },
    resolve: (ctx, i) =>
      ctx.candles[i + 1].close > ctx.candles[i].close ||
      ctx.candles[i + 2].close > ctx.candles[i].close,
  },
  {
    id: 'h1-rsi-over70-pullback',
    number: 11,
    timeframe: '1h',
    title: '4-hour cool-down after RSI > 70 overbought (1h)',
    contractQuestion:
      'When 1h RSI(14) exceeds 70, will price be below the current close 4 hours later?',
    predictedOutcome: 'YES',
    horizonBars: 4,
    category: 'reversion',
    condition: (ctx, i) => {
      const r = ctx.rsi14[i]
      return r !== null && r > 70
    },
    resolve: (ctx, i) => ctx.candles[i + 4].close < ctx.candles[i].close,
  },
  {
    id: 'h1-sell-climax-bounce',
    number: 12,
    timeframe: '1h',
    title: 'Selling exhaustion after Vol > 2.5x climax (1h)',
    contractQuestion:
      'After a > -0.50% 1h drop on volume > 2.5x average, will the high rebound >= +0.35% within 3 hours?',
    predictedOutcome: 'YES',
    horizonBars: 3,
    category: 'reversion',
    condition: (ctx, i) => {
      const avgV = ctx.volSma20[i]
      return (
        avgV !== null && ctx.volumes[i] > 2.5 * avgV && ctx.returns[i] < -0.5
      )
    },
    resolve: (ctx, i) =>
      Math.max(
        ctx.candles[i + 1].high,
        ctx.candles[i + 2].high,
        ctx.candles[i + 3].high,
      ) >=
      ctx.candles[i].close * 1.0035,
  },

  // ======================== 4 HOURS (4h) ========================
  {
    id: 'h4-strong-close-higher-high',
    number: 13,
    timeframe: '4h',
    title: 'Bullish continuation after top-15% range close (4h)',
    contractQuestion:
      'If a 4h candle (range > 0.80%) closes in its top 15%, will the next 4h candle exceed that high?',
    predictedOutcome: 'YES',
    horizonBars: 1,
    category: 'momentum',
    condition: (ctx, i) =>
      ctx.ranges[i] > 0.8 && bodyPosition(ctx.candles[i]) > 0.85,
    resolve: (ctx, i) => ctx.candles[i + 1].high > ctx.candles[i].high,
  },
  {
    id: 'h4-inside-bar-breakout',
    number: 14,
    timeframe: '4h',
    title: 'Inside Bar breakout within 8 hours (4h)',
    contractQuestion:
      'When an Inside Bar forms on 4h, is its high or low broken within the next 2 candles (8h)?',
    predictedOutcome: 'YES',
    horizonBars: 2,
    category: 'volatility',
    condition: (ctx, i) =>
      i >= 1 &&
      ctx.candles[i].high < ctx.candles[i - 1].high &&
      ctx.candles[i].low > ctx.candles[i - 1].low,
    resolve: (ctx, i) =>
      Math.max(ctx.candles[i + 1].high, ctx.candles[i + 2].high) >
        ctx.candles[i].high ||
      Math.min(ctx.candles[i + 1].low, ctx.candles[i + 2].low) <
        ctx.candles[i].low,
  },
  {
    id: 'h4-weak-close-lower-low',
    number: 15,
    timeframe: '4h',
    title: 'Bearish continuation after bottom-15% close (4h)',
    contractQuestion:
      'If a 4h candle (range > 0.80%) closes in its bottom 15%, will the next 4h candle make a lower low?',
    predictedOutcome: 'YES',
    horizonBars: 1,
    category: 'momentum',
    condition: (ctx, i) =>
      ctx.ranges[i] > 0.8 && bodyPosition(ctx.candles[i]) < 0.15,
    resolve: (ctx, i) => ctx.candles[i + 1].low < ctx.candles[i].low,
  },
  {
    id: 'h4-hammer-support-hold',
    number: 16,
    timeframe: '4h',
    title: '8h support defense after >50% hammer wick (4h)',
    contractQuestion:
      'When a 4h candle (range > 1%) leaves a lower wick > 50%, do the next 2 candles (8h) close above that low?',
    predictedOutcome: 'YES',
    horizonBars: 2,
    category: 'structure',
    condition: (ctx, i) =>
      ctx.ranges[i] > 1.0 && lowerWickRatio(ctx.candles[i]) > 0.5,
    resolve: (ctx, i) =>
      Math.min(ctx.candles[i + 1].close, ctx.candles[i + 2].close) >
      ctx.candles[i].low,
  },

  // ======================== 1 DAY (1d) ========================
  {
    id: 'd1-bollinger-lower-reversion',
    number: 17,
    timeframe: '1d',
    title: 'Rebound >= +1.5% within 3 days after Lower Bollinger close (1d)',
    contractQuestion:
      'When BTC closes the day below its Lower Bollinger Band (20, 2σ), does it gain >= +1.5% within 3 days?',
    predictedOutcome: 'YES',
    horizonBars: 3,
    category: 'reversion',
    condition: (ctx, i) => {
      const bbl = ctx.bbLower20[i]
      return bbl !== null && ctx.candles[i].close < bbl
    },
    resolve: (ctx, i) =>
      Math.max(
        ctx.candles[i + 1].high,
        ctx.candles[i + 2].high,
        ctx.candles[i + 3].high,
      ) >
      ctx.candles[i].close * 1.015,
  },
  {
    id: 'd1-bear-regime-sma20-cap',
    number: 18,
    timeframe: '1d',
    title: 'Daily SMA 20 resistance in deep bear regime (1d)',
    contractQuestion:
      'If BTC is > 5% below its daily SMA 20 and prints a green day, does tomorrow still close below SMA 20?',
    predictedOutcome: 'YES',
    horizonBars: 1,
    category: 'structure',
    condition: (ctx, i) => {
      const s20 = ctx.sma20[i]
      return (
        s20 !== null &&
        ctx.candles[i].close < s20 * 0.95 &&
        ctx.returns[i] > 0.5
      )
    },
    resolve: (ctx, i) => {
      const s20 = ctx.sma20[i]
      return s20 !== null && ctx.candles[i + 1].close < s20
    },
  },
  {
    id: 'd1-3red-days-relief',
    number: 19,
    timeframe: '1d',
    title: 'At least 1 green day within 48h after 3 red days (1d)',
    contractQuestion:
      'After 3 consecutive red daily candles, will at least 1 of the next 2 days close green?',
    predictedOutcome: 'YES',
    horizonBars: 2,
    category: 'reversion',
    condition: (ctx, i) =>
      i >= 2 &&
      ctx.returns[i] < 0 &&
      ctx.returns[i - 1] < 0 &&
      ctx.returns[i - 2] < 0,
    resolve: (ctx, i) => ctx.returns[i + 1] > 0 || ctx.returns[i + 2] > 0,
  },
  {
    id: 'd1-above-sma20-hold-low',
    number: 20,
    timeframe: '1d',
    title: 'Daily low defense when Close > SMA 20 (1d)',
    contractQuestion:
      'When the daily close sits above SMA 20, will tomorrow close above today’s low?',
    predictedOutcome: 'YES',
    horizonBars: 1,
    category: 'structure',
    condition: (ctx, i) => {
      const s20 = ctx.sma20[i]
      return s20 !== null && ctx.candles[i].close > s20
    },
    resolve: (ctx, i) => ctx.candles[i + 1].close > ctx.candles[i].low,
  },
]

export function evaluatePredictionRule(
  rule: PredictionRule,
  candles: Candle[],
): PredictionBacktestStats {
  const ctx = buildMarketContext(candles)
  const warmup = 50
  const maxIndex = candles.length - 1 - rule.horizonBars

  let triggers = 0
  let hits = 0
  const outcomes: boolean[] = []

  for (let i = warmup; i <= maxIndex; i++) {
    if (rule.condition(ctx, i)) {
      triggers++
      const hit = rule.resolve(ctx, i)
      outcomes.push(hit)
      if (hit) {
        hits++
      }
    }
  }

  const winRatePct =
    triggers > 0 ? Math.round((hits / triggers) * 1000) / 10 : 0
  const wilsonLowerBoundPct = computeWilsonLowerBoundPct(hits, triggers)
  const edgeVs5050Pct = Math.round((winRatePct - 50) * 10) / 10
  const fairYesPrice = Math.round(winRatePct) / 100

  // Conservative quarter-Kelly using Wilson lower bound against a 0.50 contract price
  const conservativeProb = wilsonLowerBoundPct / 100
  const fullKelly = Math.max(0, 2 * conservativeProb - 1)
  const quarterKellyPct = Math.round(fullKelly * 0.25 * 1000) / 10
  const isStatisticallySignificant = triggers >= 5 && wilsonLowerBoundPct > 52

  const lastIdx = candles.length - 1
  const currentlyActive =
    lastIdx >= warmup ? rule.condition(ctx, lastIdx) : false

  return {
    ruleId: rule.id,
    number: rule.number,
    timeframe: rule.timeframe,
    title: rule.title,
    contractQuestion: rule.contractQuestion,
    predictedOutcome: rule.predictedOutcome,
    horizonBars: rule.horizonBars,
    triggers,
    hits,
    winRatePct,
    wilsonLowerBoundPct,
    edgeVs5050Pct,
    fairYesPrice,
    quarterKellyPct,
    isStatisticallySignificant,
    currentlyActive,
    recentOutcomes: outcomes.slice(-16),
  }
}

export type PredictionTriggerEvent = {
  index: number
  time: number
  close: number
  resolveIndex: number
  resolveTime: number
  resolveClose: number
  changePct: number
  won: boolean
  cumulativeWinRatePct: number
}

export type PredictionDetailedAnalysis = {
  stats: PredictionBacktestStats
  events: PredictionTriggerEvent[]
  ctx: MarketContext
}

export function evaluatePredictionRuleDetailed(
  rule: PredictionRule,
  candles: Candle[],
): PredictionDetailedAnalysis {
  const ctx = buildMarketContext(candles)
  const warmup = 50
  const maxIndex = candles.length - 1 - rule.horizonBars

  let triggers = 0
  let hits = 0
  const outcomes: boolean[] = []
  const events: PredictionTriggerEvent[] = []

  for (let i = warmup; i <= maxIndex; i++) {
    if (rule.condition(ctx, i)) {
      triggers++
      const hit = rule.resolve(ctx, i)
      outcomes.push(hit)
      if (hit) hits++

      const entryCandle = candles[i]
      const resolveIndex = i + rule.horizonBars
      const resolveCandle = candles[resolveIndex]
      const changePct =
        entryCandle.close > 0
          ? ((resolveCandle.close - entryCandle.close) / entryCandle.close) * 100
          : 0

      events.push({
        index: i,
        time: entryCandle.time,
        close: entryCandle.close,
        resolveIndex,
        resolveTime: resolveCandle.time,
        resolveClose: resolveCandle.close,
        changePct,
        won: hit,
        cumulativeWinRatePct: Math.round((hits / triggers) * 1000) / 10,
      })
    }
  }

  const winRatePct =
    triggers > 0 ? Math.round((hits / triggers) * 1000) / 10 : 0
  const wilsonLowerBoundPct = computeWilsonLowerBoundPct(hits, triggers)
  const edgeVs5050Pct = Math.round((winRatePct - 50) * 10) / 10
  const fairYesPrice = Math.round(winRatePct) / 100

  const conservativeProb = wilsonLowerBoundPct / 100
  const fullKelly = Math.max(0, 2 * conservativeProb - 1)
  const quarterKellyPct = Math.round(fullKelly * 0.25 * 1000) / 10
  const isStatisticallySignificant = triggers >= 5 && wilsonLowerBoundPct > 52

  const lastIdx = candles.length - 1
  const currentlyActive =
    lastIdx >= warmup ? rule.condition(ctx, lastIdx) : false

  return {
    stats: {
      ruleId: rule.id,
      number: rule.number,
      timeframe: rule.timeframe,
      title: rule.title,
      contractQuestion: rule.contractQuestion,
      predictedOutcome: rule.predictedOutcome,
      horizonBars: rule.horizonBars,
      triggers,
      hits,
      winRatePct,
      wilsonLowerBoundPct,
      edgeVs5050Pct,
      fairYesPrice,
      quarterKellyPct,
      isStatisticallySignificant,
      currentlyActive,
      recentOutcomes: outcomes.slice(-16),
    },
    events,
    ctx,
  }
}

export function evaluateTimeframePredictions(
  timeframe: Interval,
  candles: Candle[],
): PredictionBacktestStats[] {
  return BITCOIN_20_PREDICTIONS.filter((r) => r.timeframe === timeframe).map(
    (rule) => evaluatePredictionRule(rule, candles),
  )
}
