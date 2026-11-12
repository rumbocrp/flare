import { tradePnl } from './trades'
import type { ChartPoint, Trade } from './types'

export const startingBalance = 10000

export type Metrics = {
  totalTrades: number
  wins: number
  losses: number
  winRate: number | null
  averageWin: number | null
  averageLoss: number | null
  bestTrade: number | null
  worstTrade: number | null
  profitFactor: number | null
  expectancy: number | null
  maxDrawdown: number
  maxDrawdownPct: number
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return sum(values) / values.length
}

export function computeMetrics(
  trades: Trade[],
  initialBalance = startingBalance,
): Metrics {
  const ordered = [...trades].sort((a, b) => a.time.localeCompare(b.time))
  const results = ordered.map((trade) => tradePnl(trade))

  const winResults = results.filter((pnl) => pnl > 0)
  const lossResults = results.filter((pnl) => pnl < 0)

  const grossProfit = sum(winResults)
  const grossLoss = Math.abs(sum(lossResults))

  let balance = initialBalance
  let peak = initialBalance
  let maxDrawdown = 0
  let maxDrawdownPct = 0

  for (const pnl of results) {
    balance += pnl
    if (balance > peak) {
      peak = balance
    }

    const drawdown = peak - balance
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown
      maxDrawdownPct = (drawdown / peak) * 100
    }
  }

  return {
    totalTrades: results.length,
    wins: winResults.length,
    losses: lossResults.length,
    winRate:
      results.length > 0 ? (winResults.length / results.length) * 100 : null,
    averageWin: average(winResults),
    averageLoss: average(lossResults),
    bestTrade: results.length > 0 ? Math.max(...results) : null,
    worstTrade: results.length > 0 ? Math.min(...results) : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    expectancy: average(results),
    maxDrawdown,
    maxDrawdownPct,
  }
}

export function computeEquityPoints(
  trades: Trade[],
  initialBalance = startingBalance,
): ChartPoint[] {
  const ordered = [...trades].sort((a, b) => a.time.localeCompare(b.time))

  const points: ChartPoint[] = [{ label: 'Start', value: initialBalance }]
  let balance = initialBalance

  for (const trade of ordered) {
    balance = Math.round((balance + tradePnl(trade)) * 100) / 100
    points.push({ label: trade.time, value: balance })
  }

return points
}
