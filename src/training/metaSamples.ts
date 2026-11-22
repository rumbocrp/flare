import { resolveExit } from '../backtest'
import type { StrategyPreset } from '../botEngine'
import { computeTradeRMultiple } from '../botRunUtils'
import { ema, rsi, sma } from '../indicators'
import {
  buildCandleFeatureCache,
  extractCandleFeatures,
  type MetaSample,
} from '../prediction/mlMetaFilter'
import { buildMarketContext } from '../predictions'
import { crossoverSignals } from '../signals'
import {
  isNewSpotEngine,
  precomputeSpotEngineSeries,
  signalAt as evaluateNewSpotEngineAt,
} from '../spotEngines'
import type { Candle, ExitReason, TradeSide } from '../types'
import type { TrainingTradeRecord } from './types'

export type SpotSignalCandidate = {
  index: number
  side: TradeSide
  stopPrice?: number
  targetPrice?: number
}

const MIN_SIGNAL_INDEX = 55

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100
}

/**
 * Generates causal entry signals across `[55 .. candles.length - 1]` for any of
 * FLARE's 6 `SpotSignalEngine` modes in O(N) time without lookahead.
 */
export function collectSpotPresetSignals(
  candles: Candle[],
  preset: StrategyPreset,
): SpotSignalCandidate[] {
  if (candles.length <= MIN_SIGNAL_INDEX) return []
  const filters = preset.filters
  const engine = filters?.signalEngine ?? 'crossover'
  const allowShort = preset.execution.allowShort
  const out: SpotSignalCandidate[] = []

  if (isNewSpotEngine(engine)) {
    const pre = precomputeSpotEngineSeries(candles, filters?.atrPeriod ?? 14)
    for (let i = MIN_SIGNAL_INDEX; i < candles.length; i += 1) {
      const sig = evaluateNewSpotEngineAt(engine, candles, i, filters, pre)
      if (!sig) continue
      if (sig.side === 'sell' && !allowShort) continue
      out.push({
        index: i,
        side: sig.side,
        stopPrice: sig.stopPrice,
        targetPrice: sig.targetPrice,
      })
    }
    return out
  }

  const closes = candles.map((c) => c.close)
  const rsiSeries = rsi(closes, 14)
  const sma20Series = sma(closes, 20)
  const ema50Series = ema(closes, 50)

  if (engine === 'crossover') {
    const crossList = crossoverSignals(candles, preset.signalParams)
    for (const sig of crossList) {
      if (sig.index < MIN_SIGNAL_INDEX) continue
      if (sig.side === 'sell' && !allowShort) continue
      const curRsi = rsiSeries[sig.index]
      const curEma50 = ema50Series[sig.index]
      const cur = candles[sig.index]
      if (filters?.avoidRsiExtremes && curRsi !== null) {
        if (sig.side === 'buy' && curRsi > (filters.maxBuyRsi ?? 70)) continue
        if (sig.side === 'sell' && curRsi < (filters.minSellRsi ?? 30)) continue
      }
      if (filters?.requireEma50Alignment && curEma50 !== null) {
        if (sig.side === 'buy' && cur.close < curEma50) continue
        if (sig.side === 'sell' && cur.close > curEma50) continue
      }
      out.push({ index: sig.index, side: sig.side })
    }
    return out
  }

  for (let i = MIN_SIGNAL_INDEX; i < candles.length; i += 1) {
    const cur = candles[i]
    const prev = candles[i - 1]
    const prev2 = candles[i - 2]
    const curRsi = rsiSeries[i]
    const prevRsi = rsiSeries[i - 1]
    const curSma20 = sma20Series[i]
    const curEma50 = ema50Series[i]

    let side: TradeSide | null = null
    if (engine === 'rsi-reversion') {
      const oversold = filters?.oversoldRsi ?? 35
      const overbought = filters?.overboughtRsi ?? 65
      const bullish =
        cur.close > cur.open &&
        cur.close > (prev.open + prev.close) / 2 &&
        ((prevRsi !== null && prevRsi < oversold) ||
          (curRsi !== null && curRsi < oversold) ||
          (prev.close < prev.open &&
            prev2.close < prev2.open &&
            curRsi !== null &&
            curRsi < 42 &&
            curEma50 !== null &&
            cur.close > curEma50 * 0.992))
      if (bullish) {
        side = 'buy'
      } else {
        const bearish =
          cur.close < cur.open &&
          cur.close < (prev.open + prev.close) / 2 &&
          ((prevRsi !== null && prevRsi > overbought) ||
            (curRsi !== null && curRsi > overbought) ||
            (prev.close > prev.open &&
              prev2.close > prev2.open &&
              curRsi !== null &&
              curRsi > 58 &&
              curEma50 !== null &&
              cur.close < curEma50 * 1.008))
        if (bearish) side = 'sell'
      }
    } else {
      // momentum-structure
      if (cur.close > cur.open) {
        const alignedLong =
          !filters?.requireEma50Alignment ||
          (curEma50 !== null && cur.close > curEma50)
        const inUptrendPullback =
          curEma50 !== null &&
          curSma20 !== null &&
          cur.close > curEma50 &&
          prev.close < prev.open &&
          cur.low <= curSma20 * 1.004 &&
          cur.close >= curSma20 &&
          curRsi !== null &&
          curRsi >= 44 &&
          curRsi <= (filters?.maxBuyRsi ?? 66)
        const threeRedExhaustion =
          alignedLong &&
          prev.close < prev.open &&
          prev2.close < prev2.open &&
          cur.close > prev.high &&
          curRsi !== null &&
          curRsi < 45
        if (inUptrendPullback || threeRedExhaustion) side = 'buy'
      } else if (cur.close < cur.open) {
        const alignedShort =
          !filters?.requireEma50Alignment ||
          (curEma50 !== null && cur.close < curEma50)
        const inDowntrendRally =
          curEma50 !== null &&
          curSma20 !== null &&
          cur.close < curEma50 &&
          prev.close > prev.open &&
          cur.high >= curSma20 * 0.996 &&
          cur.close <= curSma20 &&
          curRsi !== null &&
          curRsi <= 56 &&
          curRsi >= (filters?.minSellRsi ?? 34)
        const threeGreenExhaustion =
          alignedShort &&
          prev.close > prev.open &&
          prev2.close > prev2.open &&
          cur.close < prev.low &&
          curRsi !== null &&
          curRsi > 55
        if (inDowntrendRally || threeGreenExhaustion) side = 'sell'
      }
    }

    if (!side) continue
    if (side === 'sell' && !allowShort) continue
    out.push({ index: i, side })
  }

  return out
}

export type BuiltSpotMetaDataset = {
  samples: MetaSample[]
  trades: TrainingTradeRecord[]
}

/**
 * Builds deterministic triple-barrier labeled `MetaSample[]` and 1-to-1 aligned
 * `TrainingTradeRecord[]` from a spot preset's own signals using FLARE's canonical
 * 19-feature `extractCandleFeatures`.
 */
export function buildSpotMetaSamples(
  candles: Candle[],
  preset: StrategyPreset,
  options?: { maxHoldBars?: number },
): BuiltSpotMetaDataset {
  const maxHoldBars = Math.max(4, Math.min(120, options?.maxHoldBars ?? 24))
  if (candles.length <= MIN_SIGNAL_INDEX + 2) {
    return { samples: [], trades: [] }
  }

  const signals = collectSpotPresetSignals(candles, preset)
  if (signals.length === 0) return { samples: [], trades: [] }

  const ctx = buildMarketContext(candles)
  const featureCache = buildCandleFeatureCache(ctx)
  const { strategy, execution, filters } = preset
  const initialBal = Math.max(100, execution.initialBalance)
  const stakeUsd = round2(initialBal * (strategy.positionSize / 100))

  const samples: MetaSample[] = []
  const trades: TrainingTradeRecord[] = []
  let nextAllowedEntry = MIN_SIGNAL_INDEX
  let tradeId = 1

  for (const sig of signals) {
    if (sig.index < nextAllowedEntry) continue
    if (sig.index >= candles.length - 1) break

    const entryCandle = candles[sig.index]
    const dir: 1 | -1 = sig.side === 'buy' ? 1 : -1
    const entryPrice =
      entryCandle.close * (1 + dir * (execution.slippagePct / 100))
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue

    const defaultStop = entryPrice * (1 - dir * (strategy.stopLoss / 100))
    const defaultTarget = entryPrice * (1 + dir * (strategy.takeProfit / 100))

    const stopPrice =
      sig.stopPrice !== undefined &&
      ((sig.side === 'buy' && sig.stopPrice < entryPrice && sig.stopPrice > 0) ||
        (sig.side === 'sell' && sig.stopPrice > entryPrice))
        ? sig.stopPrice
        : defaultStop

    let targetPrice =
      sig.targetPrice !== undefined &&
      ((sig.side === 'buy' && sig.targetPrice > entryPrice) ||
        (sig.side === 'sell' && sig.targetPrice < entryPrice && sig.targetPrice > 0))
        ? sig.targetPrice
        : defaultTarget

    if (
      filters?.signalEngine === 'break-of-structure' &&
      sig.targetPrice !== undefined
    ) {
      targetPrice =
        sig.side === 'buy'
          ? Math.min(targetPrice, defaultTarget)
          : Math.max(targetPrice, defaultTarget)
    }

    const lastHorizon = Math.min(candles.length - 1, sig.index + maxHoldBars)
    let exitIdx = lastHorizon
    let rawExitPrice = candles[lastHorizon].close
    let exitReason: ExitReason = 'end'

    for (let j = sig.index + 1; j <= lastHorizon; j += 1) {
      const hit = resolveExit(
        { side: sig.side, stopPrice, targetPrice },
        candles[j],
      )
      if (hit) {
        exitIdx = j
        rawExitPrice = hit.price
        exitReason = hit.reason
        break
      }
    }

    const closeDir = -dir
    const exitPrice = rawExitPrice * (1 + closeDir * (execution.slippagePct / 100))
    const quantity = stakeUsd / entryPrice
    const entryFee = stakeUsd * (execution.commissionPct / 100)
    const exitFee = exitPrice * quantity * (execution.commissionPct / 100)
    const fees = round2(entryFee + exitFee)
    const grossPnl = round2((exitPrice - entryPrice) * quantity * dir)
    const netPnl = round2(grossPnl - fees)

    const featureVector = extractCandleFeatures(ctx, featureCache, sig.index, dir)
    samples.push({
      timestampMs: entryCandle.time,
      featureVector,
      outcome: netPnl > 0 ? 1 : 0,
      netPnlUsd: netPnl,
      stakeUsd,
      entryPrice: round2(entryPrice),
    })

    const trade: TrainingTradeRecord = {
      id: tradeId++,
      time: new Date(candles[exitIdx].time).toISOString(),
      pair: strategy.pair,
      side: sig.side,
      entryPrice: round2(entryPrice),
      exitPrice: round2(exitPrice),
      size: stakeUsd,
      pnl: netPnl,
      grossPnl,
      fees,
      entryTime: entryCandle.time,
      exitTime: candles[exitIdx].time,
      exitReason,
      balanceAfter: initialBal,
      presetId: preset.id,
      presetName: preset.name,
      initialStopPrice: round2(stopPrice),
    }
    trade.rMultiple = computeTradeRMultiple(trade, strategy.stopLoss)
    trades.push(trade)

    nextAllowedEntry = exitIdx + 1
  }

  return { samples, trades }
}
