/**
 * Dedicated browser Web Worker offloading heavy CPU-bound backtests and
 * prediction-market walk-forward simulations off the React UI thread.
 */
import {
  runBacktest,
  type BacktestConfig,
  type BacktestResult,
} from '../backtest'
import {
  buildDirectionalRules,
  type DirectionalTimeframe,
} from '../directionalRules'
import {
  simulatePredictionStrategy,
  type SimulationConfig,
  type SimulationResult,
} from '../predictionMarket'
import { BITCOIN_20_PREDICTIONS } from '../predictions'
import type { Candle, Interval } from '../types'

export type WorkerJobRequest =
  | {
      id: number
      type: 'backtest'
      candles: Candle[]
      config: BacktestConfig
    }
  | {
      id: number
      type: 'prediction-sim'
      candles: Candle[]
      ruleFamily: 'bitcoin20' | 'directional'
      timeframe: Interval
      config: SimulationConfig
    }

export type WorkerJobResponse =
  | {
      id: number
      ok: true
      type: 'backtest'
      result: BacktestResult
      durationMs: number
    }
  | {
      id: number
      ok: true
      type: 'prediction-sim'
      result: SimulationResult
      durationMs: number
    }
  | {
      id: number
      ok: false
      error: string
    }

function resolveRules(
  ruleFamily: 'bitcoin20' | 'directional',
  timeframe: Interval,
) {
  if (ruleFamily === 'directional') {
    const dirTf: DirectionalTimeframe = timeframe === '5m' ? '5m' : '15m'
    return buildDirectionalRules(dirTf)
  }
  return BITCOIN_20_PREDICTIONS.filter((r) => r.timeframe === timeframe)
}

self.onmessage = (event: MessageEvent<WorkerJobRequest>) => {
  const req = event.data
  const started = performance.now()
  try {
    if (req.type === 'backtest') {
      const result = runBacktest(req.candles, req.config)
      const response: WorkerJobResponse = {
        id: req.id,
        ok: true,
        type: 'backtest',
        result,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
      }
      self.postMessage(response)
      return
    }

    if (req.type === 'prediction-sim') {
      const rules = resolveRules(req.ruleFamily, req.timeframe)
      const result = simulatePredictionStrategy(req.candles, rules, req.config)
      const response: WorkerJobResponse = {
        id: req.id,
        ok: true,
        type: 'prediction-sim',
        result,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
      }
      self.postMessage(response)
    }
  } catch (err) {
    const response: WorkerJobResponse = {
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
    self.postMessage(response)
  }
}
