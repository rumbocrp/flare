import { describe, expect, it } from 'vitest'
import { computeEquityPoints, computeMetrics, computeStrategyDiagnostics } from './metrics'
import type { BacktestTrade } from './backtest'
import type { Trade } from './types'

describe('metrics & computeStrategyDiagnostics', () => {
  it('computes payoff ratio, break-even win rate, edge in pp, streaks, pairs, and sides', () => {
    const trades: Trade[] = [
      { id: 1, time: '09:00', pair: 'BTC/USDT', side: 'buy', entryPrice: 100, exitPrice: 110, size: 1000, pnl: 200 },
      { id: 2, time: '10:00', pair: 'BTC/USDT', side: 'buy', entryPrice: 100, exitPrice: 95, size: 1000, pnl: -100 },
      { id: 3, time: '11:00', pair: 'ETH/USDT', side: 'sell', entryPrice: 100, exitPrice: 90, size: 1000, pnl: 200 },
      { id: 4, time: '12:00', pair: 'SOL/USDT', side: 'sell', entryPrice: 100, exitPrice: 105, size: 1000, pnl: -100 },
      { id: 5, time: '13:00', pair: 'BTC/USDT', side: 'buy', entryPrice: 100, exitPrice: 110, size: 1000, pnl: 200 },
    ]

    const base = computeMetrics(trades, 10_000)
    const diag = computeStrategyDiagnostics(trades, 10_000)

    expect(base.winRate).toBe(60)
    expect(diag.netPnl).toBe(400)
    expect(diag.finalBalance).toBe(10_400)
    expect(diag.returnPct).toBeCloseTo(4, 5)
    expect(diag.payoffRatio).toBeCloseTo(2, 5)
    expect(diag.breakEvenWinRatePct).toBeCloseTo(33.333, 2)
    expect(diag.winRateEdgePp).toBeCloseTo(26.666, 2)
    expect(diag.recoveryFactor).toBeCloseTo(4, 5) // maxDrawdown = 100
    expect(diag.expectancyR).toBeCloseTo(0.8, 5) // +80 / 100
    expect(diag.maxWinStreak).toBe(1)
    expect(diag.maxLossStreak).toBe(1)
    expect(diag.currentStreak).toBe(1)
    expect(diag.longs.count).toBe(3)
    expect(diag.longs.netPnl).toBe(300)
    expect(diag.shorts.count).toBe(2)
    expect(diag.shorts.netPnl).toBe(100)
    expect(diag.byPair[0].pair).toBe('BTC/USDT')
    expect(diag.byPair[0].netPnl).toBe(300)
    expect(diag.totalFees).toBeNull()
    expect(diag.exits).toHaveLength(0)
  })

  it('sorts chronologically by exitTime even when input is newest-first and aggregates fees and exit reasons', () => {
    const newestFirst: BacktestTrade[] = [
      {
        id: 2,
        time: '2026-11-14T11:00:00.000Z',
        pair: 'ETH/USDT',
        side: 'sell',
        entryPrice: 3000,
        exitPrice: 2940,
        size: 1000,
        pnl: 40,
        grossPnl: 42,
        fees: 2,
        entryTime: 2000,
        exitTime: 3000,
        exitReason: 'target',
        balanceAfter: 9990,
      },
      {
        id: 1,
        time: '2026-11-14T10:00:00.000Z',
        pair: 'BTC/USDT',
        side: 'buy',
        entryPrice: 60000,
        exitPrice: 59400,
        size: 1000,
        pnl: -50,
        grossPnl: -47,
        fees: 3,
        entryTime: 1000,
        exitTime: 1500,
        exitReason: 'stop',
        balanceAfter: 9950,
      },
    ]

    const points = computeEquityPoints(newestFirst, 10_000, 'Start')
    const diag = computeStrategyDiagnostics(newestFirst, 10_000)

    expect(points.map((p) => p.value)).toEqual([10_000, 9_950, 9_990])
    expect(diag.currentStreak).toBe(1) // latest chronologically closed at target (+40)
    expect(diag.totalFees).toBe(5)
    expect(diag.exits).toEqual([
      { reason: 'stop', count: 1, sharePct: 50, netPnl: -50 },
      { reason: 'target', count: 1, sharePct: 50, netPnl: 40 },
    ])
  })

  it('handles an empty trade series with safe nulls and zeroes', () => {
    const diag = computeStrategyDiagnostics([], 10_000)
    expect(diag.netPnl).toBe(0)
    expect(diag.finalBalance).toBe(10_000)
    expect(diag.payoffRatio).toBeNull()
    expect(diag.breakEvenWinRatePct).toBeNull()
    expect(diag.winRateEdgePp).toBeNull()
    expect(diag.recoveryFactor).toBeNull()
    expect(diag.maxLossStreak).toBe(0)
    expect(diag.currentStreak).toBe(0)
    expect(diag.byPair).toEqual([])
  })
})
