import { describe, expect, it } from 'vitest'
import {
  resolveExit,
  runBacktest,
  type BacktestConfig,
} from './backtest'
import { computeMetrics } from './metrics'
import type { Candle } from './types'

const HOUR = 3_600_000

function candle(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
): Candle {
  return { time, open, high, low, close, volume: 0 }
}

const params = {
  fastPeriod: 1,
  slowPeriod: 2,
  average: 'sma' as const,
}

function makeConfig(overrides: {
  strategy?: Partial<BacktestConfig['strategy']>
  settings?: Partial<BacktestConfig['settings']>
} = {}): BacktestConfig {
  return {
    pair: 'BTC/USDT',
    params,
    strategy: {
      positionSize: 100,
      stopLoss: 5,
      takeProfit: 10,
      maxDailyRisk: 50,
      ...overrides.strategy,
    },
    settings: {
      initialBalance: 1000,
      commissionPct: 0,
      slippagePct: 0,
      allowShort: false,
      ...overrides.settings,
    },
  }
}

/**
 * Base candle fixture producing a BUY signal at index 3.
 * Closes: 100, 100, 90, 110, ...
 * Entry fills at the open of index 4.
 */
function buySignalCandles(): Candle[] {
  return [
    candle(0 * HOUR, 100, 101, 99, 100),
    candle(1 * HOUR, 100, 101, 99, 100),
    candle(2 * HOUR, 90, 91, 89, 90),
    candle(3 * HOUR, 110, 111, 109, 110),
    candle(4 * HOUR, 100, 101, 99, 110),
    candle(5 * HOUR, 105, 111, 104, 108),
    candle(6 * HOUR, 108, 109, 107, 108),
  ]
}

describe('resolveExit', () => {
  it('on a long position, stop wins if both stop and target touch in the same bar', () => {
    const exit = resolveExit(
      { side: 'buy', stopPrice: 95, targetPrice: 110 },
      candle(0, 100, 111, 94, 100),
    )
    expect(exit).toEqual({ price: 95, reason: 'stop' })
  })

  it('on a long position, a gap open below stop fills at open', () => {
    const exit = resolveExit(
      { side: 'buy', stopPrice: 95, targetPrice: 110 },
      candle(0, 90, 91, 89, 90),
    )
    expect(exit).toEqual({ price: 90, reason: 'stop' })
  })

  it('on a short position, target hits on the candle low', () => {
    const exit = resolveExit(
      { side: 'sell', stopPrice: 105, targetPrice: 90 },
      candle(0, 100, 101, 89, 95),
    )
    expect(exit).toEqual({ price: 90, reason: 'target' })
  })

  it('returns null when neither level is reached', () => {
    const exit = resolveExit(
      { side: 'buy', stopPrice: 95, targetPrice: 110 },
      candle(0, 100, 105, 99, 102),
    )
    expect(exit).toBeNull()
  })
})

describe('runBacktest', () => {
  it('enters at next candle open rather than signal close', () => {
    const candles = [
      candle(0 * HOUR, 100, 101, 99, 100),
      candle(1 * HOUR, 100, 101, 99, 100),
      candle(2 * HOUR, 90, 91, 89, 90),
      candle(3 * HOUR, 110, 111, 109, 110), // BUY signal at close
      candle(4 * HOUR, 20, 116, 19.5, 115), // gap open
      candle(5 * HOUR, 115, 116, 114, 120),
      candle(6 * HOUR, 120, 126, 119, 125),
    ]

    const result = runBacktest(candles, makeConfig())

    expect(result.trades).toHaveLength(1)
    expect(result.trades[0].entryPrice).toBe(20)
    expect(result.trades[0].entryTime).toBe(4 * HOUR)
  })

  it('takes profit at target and charges round-trip commissions', () => {
    const result = runBacktest(
      buySignalCandles(),
      makeConfig({ settings: { commissionPct: 0.1 } }),
    )

    expect(result.trades).toHaveLength(1)

    const trade = result.trades[0]
    expect(trade.exitReason).toBe('target')
    expect(trade.entryPrice).toBe(100)
    expect(trade.exitPrice).toBe(110)
    expect(trade.grossPnl).toBe(100)
    expect(trade.fees).toBe(2.1)
    expect(trade.pnl).toBe(97.9)
    expect(result.finalBalance).toBe(1097.9)
    expect(result.feesPaid).toBe(2.1)
  })

  it('prioritizes stop loss over target when both touch on one bar', () => {
    const candles = buySignalCandles()
    candles[5] = candle(5 * HOUR, 105, 111, 94, 100)

    const result = runBacktest(
      candles,
      makeConfig({ settings: { commissionPct: 0 } }),
    )

    expect(result.trades[0].exitReason).toBe('stop')
    expect(result.trades[0].exitPrice).toBe(95)
    expect(result.trades[0].pnl).toBe(-50)
    expect(result.finalBalance).toBe(950)
  })

  it('opens short positions when allowShort is true', () => {
    const candles = [
      candle(0 * HOUR, 90, 91, 89, 90),
      candle(1 * HOUR, 100, 101, 99, 100),
      candle(2 * HOUR, 110, 111, 109, 110),
      candle(3 * HOUR, 90, 91, 89, 90), // SELL signal
      candle(4 * HOUR, 100, 101, 89, 90), // entry 100, target 90
      candle(5 * HOUR, 90, 91, 89, 90),
      candle(6 * HOUR, 90, 91, 89, 90),
    ]

    const result = runBacktest(
      candles,
      makeConfig({ settings: { allowShort: true } }),
    )

    expect(result.trades).toHaveLength(1)
    expect(result.trades[0].side).toBe('sell')
    expect(result.trades[0].exitReason).toBe('target')
    expect(result.trades[0].exitPrice).toBe(90)
    expect(result.trades[0].pnl).toBe(100)
  })

  it('ignores SELL signals while flat when allowShort is false', () => {
    const candles = [
      candle(0 * HOUR, 90, 91, 89, 90),
      candle(1 * HOUR, 100, 101, 99, 100),
      candle(2 * HOUR, 110, 111, 109, 110),
      candle(3 * HOUR, 90, 91, 89, 90),
      candle(4 * HOUR, 100, 101, 99, 100),
    ]

    const result = runBacktest(candles, makeConfig())
    expect(result.trades).toHaveLength(0)
    expect(result.skippedSignals).toBeGreaterThan(0)
  })

  it('halts new entries for the rest of the day once maxDailyRisk is breached', () => {
    const candles = [
      candle(0 * HOUR, 100, 101, 99, 100),
      candle(1 * HOUR, 100, 101, 99, 100),
      candle(2 * HOUR, 90, 91, 89, 90),
      candle(3 * HOUR, 110, 111, 109, 110), // BUY
      candle(4 * HOUR, 100, 101, 99, 110), // entry 100
      candle(5 * HOUR, 100, 101, 97, 100), // stop 98
      candle(6 * HOUR, 100, 101, 99, 100),
      candle(7 * HOUR, 100, 101, 99, 100),
      candle(8 * HOUR, 100, 101, 89, 90), // SELL discarded
      candle(9 * HOUR, 90, 111, 89, 110), // BUY
      candle(10 * HOUR, 110, 111, 109, 110), // already halted
    ]

    const result = runBacktest(
      candles,
      makeConfig({
        strategy: { stopLoss: 2, maxDailyRisk: 2 },
        settings: { allowShort: false },
      }),
    )

    expect(result.trades).toHaveLength(1)
    expect(result.trades[0].exitReason).toBe('stop')
    expect(result.trades[0].pnl).toBe(-20)
    expect(result.finalBalance).toBe(980)
    expect(result.skippedSignals).toBeGreaterThan(0)
  })

  it('closes any remaining open position at the final candle close', () => {
    const candles = [
      candle(0 * HOUR, 100, 101, 99, 100),
      candle(1 * HOUR, 100, 101, 99, 100),
      candle(2 * HOUR, 90, 91, 89, 90),
      candle(3 * HOUR, 110, 111, 109, 110), // BUY
      candle(4 * HOUR, 100, 101, 99, 115), // entry 100
      candle(5 * HOUR, 115, 116, 114, 120),
      candle(6 * HOUR, 120, 126, 119, 125),
    ]

    const result = runBacktest(
      candles,
      makeConfig({
        strategy: { stopLoss: 50, takeProfit: 50 },
      }),
    )

    expect(result.trades).toHaveLength(1)
    expect(result.trades[0].exitReason).toBe('end')
    expect(result.trades[0].exitPrice).toBe(125)
    expect(result.trades[0].pnl).toBe(250)
  })

  it('applies adverse slippage on long entry fills', () => {
    const candles = [
      candle(0 * HOUR, 100, 101, 99, 100),
      candle(1 * HOUR, 100, 101, 99, 100),
      candle(2 * HOUR, 90, 91, 89, 90),
      candle(3 * HOUR, 110, 111, 109, 110),
      candle(4 * HOUR, 100, 101, 99, 115),
      candle(5 * HOUR, 115, 116, 114, 120),
      candle(6 * HOUR, 120, 126, 119, 125),
    ]

    const result = runBacktest(
      candles,
      makeConfig({
        strategy: { stopLoss: 50, takeProfit: 50 },
        settings: { slippagePct: 1 },
      }),
    )

    expect(result.trades[0].entryPrice).toBeCloseTo(101, 6)
  })

  it('does not mutate input candles', () => {
    const candles = buySignalCandles()
    const before = JSON.stringify(candles)

    runBacktest(candles, makeConfig())

    expect(JSON.stringify(candles)).toBe(before)
  })

  it('returns an empty result with warning when fewer than 2 candles exist', () => {
    const result = runBacktest(
      [candle(0, 100, 101, 99, 100)],
      makeConfig(),
    )

    expect(result.trades).toHaveLength(0)
    expect(result.finalBalance).toBe(1000)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('computes metrics from the configured initial balance', () => {
    const candles = buySignalCandles()
    const result = runBacktest(candles, makeConfig())

    const metrics = computeMetrics(result.trades, result.initialBalance)

    expect(metrics.totalTrades).toBe(1)
    expect(metrics.wins).toBe(1)
    expect(metrics.winRate).toBe(100)
    expect(metrics.maxDrawdown).toBe(0)
  })
})
