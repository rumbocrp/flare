/**
 * "Next-candle Up/Down" directional prediction rules.
 *
 * Contract semantics match live Polymarket "Bitcoin Up or Down" markets:
 * the window starting at the close of candle `i` is candle `i + 1`, resolving
 * UP when `close >= open`. Because both share the exact same contract, these
 * rules can be scored directly against live market prices, unlike FLARE's
 * 20 custom multi-horizon setups.
 *
 * Every rule frames YES = UP; the prediction engine buys NO (= DOWN)
 * whenever net edge favors the downside.
 */
import type { PredictionRule, MarketContext } from './predictions'

export type DirectionalTimeframe = '5m' | '15m'

function bodyPosition(ctx: MarketContext, i: number): number {
  const c = ctx.candles[i]
  const span = c.high - c.low
  return span > 0 ? (c.close - c.low) / span : 0.5
}

const resolveNextUp: PredictionRule['resolve'] = (ctx, i) => {
  const next = ctx.candles[i + 1]
  return next.close >= next.open
}

type DirectionalSpec = {
  key: string
  number: number
  title: string
  question: string
  category: PredictionRule['category']
  condition: PredictionRule['condition']
}

const SPECS: DirectionalSpec[] = [
  {
    key: 'streak-up',
    number: 101,
    title: '3-green candle streak',
    question: 'After 3 consecutive green candles, does the next candle close above its open?',
    category: 'momentum',
    condition: (ctx, i) =>
      i >= 2 && ctx.returns[i] > 0 && ctx.returns[i - 1] > 0 && ctx.returns[i - 2] > 0,
  },
  {
    key: 'streak-down',
    number: 102,
    title: '3-red candle streak',
    question: 'After 3 consecutive red candles, does the next candle close above its open?',
    category: 'reversion',
    condition: (ctx, i) =>
      i >= 2 && ctx.returns[i] < 0 && ctx.returns[i - 1] < 0 && ctx.returns[i - 2] < 0,
  },
  {
    key: 'rsi-oversold',
    number: 103,
    title: 'RSI(14) below 30',
    question: 'With RSI(14) below 30, does the next candle close above its open?',
    category: 'reversion',
    condition: (ctx, i) => {
      const r = ctx.rsi14[i]
      return r !== null && r < 30
    },
  },
  {
    key: 'rsi-overbought',
    number: 104,
    title: 'RSI(14) above 70',
    question: 'With RSI(14) above 70, does the next candle close above its open?',
    category: 'momentum',
    condition: (ctx, i) => {
      const r = ctx.rsi14[i]
      return r !== null && r > 70
    },
  },
  {
    key: 'strong-close',
    number: 105,
    title: 'Close in top 15% of range',
    question: 'If the candle closes in the top 15% of its range, does the next close above its open?',
    category: 'momentum',
    condition: (ctx, i) => bodyPosition(ctx, i) > 0.85 && ctx.ranges[i] > 0.1,
  },
  {
    key: 'weak-close',
    number: 106,
    title: 'Close in bottom 15% of range',
    question: 'If the candle closes in the bottom 15% of its range, does the next close above its open?',
    category: 'reversion',
    condition: (ctx, i) => bodyPosition(ctx, i) < 0.15 && ctx.ranges[i] > 0.1,
  },
  {
    key: 'trend-up',
    number: 107,
    title: 'Uptrend: close above SMA 20 & EMA 50',
    question: 'With close above SMA 20 and SMA 20 above EMA 50, does the next candle close above its open?',
    category: 'structure',
    condition: (ctx, i) => {
      const s = ctx.sma20[i]
      const e = ctx.ema50[i]
      return s !== null && e !== null && ctx.closes[i] > s && s > e
    },
  },
  {
    key: 'volume-spike-red',
    number: 108,
    title: 'Red candle with >2x average volume',
    question: 'After a red candle with volume above 2x average, does the next close above its open?',
    category: 'volatility',
    condition: (ctx, i) => {
      const v = ctx.volSma20[i]
      return v !== null && ctx.volumes[i] > 2 * v && ctx.returns[i] < 0
    },
  },
]

export function buildDirectionalRules(tf: DirectionalTimeframe): PredictionRule[] {
  return SPECS.map((spec) => ({
    id: `dir-${tf}-${spec.key}`,
    number: spec.number,
    timeframe: tf,
    title: spec.title,
    contractQuestion: spec.question,
    predictedOutcome: 'YES',
    horizonBars: 1,
    category: spec.category,
    condition: spec.condition,
    resolve: resolveNextUp,
  }))
}
