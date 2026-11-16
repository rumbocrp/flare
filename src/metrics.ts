import { tradePnl } from './trades'
import type { ChartPoint, ExitReason, Trade } from './types'

export const startingBalance = 10000

type Metrics = {
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

type SideStats = {
  count: number
  wins: number
  losses: number
  winRate: number | null
  netPnl: number
}

type PairStats = {
  pair: string
  count: number
  wins: number
  winRate: number | null
  netPnl: number
  profitFactor: number | null
}

type ExitStats = {
  reason: ExitReason
  count: number
  sharePct: number
  netPnl: number
}

type StrategyDiagnostics = {
  netPnl: number
  returnPct: number
  finalBalance: number
  grossProfit: number
  grossLoss: number
  totalFees: number | null
  payoffRatio: number | null
  breakEvenWinRatePct: number | null
  winRateEdgePp: number | null
  recoveryFactor: number | null
  expectancyR: number | null
  maxWinStreak: number
  maxLossStreak: number
  currentStreak: number
  longs: SideStats
  shorts: SideStats
  byPair: PairStats[]
  exits: ExitStats[]
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return sum(values) / values.length
}

function sortTradesChronologically(trades: Trade[]): Trade[] {
  return [...trades].sort((a, b) => {
    const tA = a.exitTime ?? a.entryTime
    const tB = b.exitTime ?? b.entryTime
    if (typeof tA === 'number' && typeof tB === 'number' && tA !== tB) {
      return tA - tB
    }
    return a.time.localeCompare(b.time)
  })
}

function summarizeSubset(subset: Trade[]) {
  const results = subset.map((trade) => tradePnl(trade))
  const winResults = results.filter((pnl) => pnl > 0)
  const lossResults = results.filter((pnl) => pnl < 0)
  const grossProfit = sum(winResults)
  const grossLoss = Math.abs(sum(lossResults))
  const netPnl = round2(sum(results))

  return {
    results,
    winResults,
    lossResults,
    count: results.length,
    wins: winResults.length,
    losses: lossResults.length,
    winRate:
      results.length > 0 ? (winResults.length / results.length) * 100 : null,
    grossProfit,
    grossLoss,
    netPnl,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
  }
}

export function computeMetrics(
  trades: Trade[],
  initialBalance = startingBalance,
): Metrics {
  const ordered = sortTradesChronologically(trades)
  const stats = summarizeSubset(ordered)

  let balance = initialBalance
  let peak = initialBalance
  let maxDrawdown = 0
  let maxDrawdownPct = 0

  for (const pnl of stats.results) {
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
    totalTrades: stats.count,
    wins: stats.wins,
    losses: stats.losses,
    winRate: stats.winRate,
    averageWin: average(stats.winResults),
    averageLoss: average(stats.lossResults),
    bestTrade: stats.count > 0 ? Math.max(...stats.results) : null,
    worstTrade: stats.count > 0 ? Math.min(...stats.results) : null,
    profitFactor: stats.profitFactor,
    expectancy: average(stats.results),
    maxDrawdown,
    maxDrawdownPct,
  }
}

export function computeStrategyDiagnostics(
  trades: Trade[],
  initialBalance = startingBalance,
): StrategyDiagnostics {
  const ordered = sortTradesChronologically(trades)
  const base = computeMetrics(ordered, initialBalance)
  const total = summarizeSubset(ordered)

  const finalBalance = round2(initialBalance + total.netPnl)
  const returnPct =
    initialBalance > 0 ? (total.netPnl / initialBalance) * 100 : 0

  let feeSum = 0
  let hasFees = false
  let maxWinStreak = 0
  let maxLossStreak = 0
  let winRun = 0
  let lossRun = 0
  let currentStreak = 0

  const byPairMap = new Map<string, Trade[]>()
  const exitMap = new Map<ExitReason, { count: number; netPnl: number }>()
  let exitCount = 0

  ordered.forEach((trade, idx) => {
    const pnl = total.results[idx]
    if (pnl > 0) {
      winRun += 1
      lossRun = 0
      maxWinStreak = Math.max(maxWinStreak, winRun)
      currentStreak = winRun
    } else if (pnl < 0) {
      lossRun += 1
      winRun = 0
      maxLossStreak = Math.max(maxLossStreak, lossRun)
      currentStreak = -lossRun
    }

    if (
      'fees' in trade &&
      typeof trade.fees === 'number' &&
      Number.isFinite(trade.fees)
    ) {
      feeSum += trade.fees
      hasFees = true
    }

    const pairTrades = byPairMap.get(trade.pair) ?? []
    pairTrades.push(trade)
    byPairMap.set(trade.pair, pairTrades)

    if (trade.exitReason) {
      exitCount += 1
      const current = exitMap.get(trade.exitReason) ?? { count: 0, netPnl: 0 }
      exitMap.set(trade.exitReason, {
        count: current.count + 1,
        netPnl: round2(current.netPnl + pnl),
      })
    }
  })

  const payoffRatio =
    base.averageWin !== null &&
    base.averageLoss !== null &&
    base.averageLoss < 0
      ? base.averageWin / Math.abs(base.averageLoss)
      : null

  const breakEvenWinRatePct =
    payoffRatio !== null && payoffRatio > 0
      ? (1 / (1 + payoffRatio)) * 100
      : null

  const winRateEdgePp =
    base.winRate !== null && breakEvenWinRatePct !== null
      ? base.winRate - breakEvenWinRatePct
      : null

  const recoveryFactor =
    base.maxDrawdown > 0 ? total.netPnl / base.maxDrawdown : null

  const expectancyR =
    base.expectancy !== null &&
    base.averageLoss !== null &&
    base.averageLoss < 0
      ? base.expectancy / Math.abs(base.averageLoss)
      : null

  const longStats = summarizeSubset(ordered.filter((t) => t.side === 'buy'))
  const shortStats = summarizeSubset(ordered.filter((t) => t.side === 'sell'))

  const byPair: PairStats[] = [...byPairMap.entries()]
    .map(([pair, list]) => {
      const s = summarizeSubset(list)
      return {
        pair,
        count: s.count,
        wins: s.wins,
        winRate: s.winRate,
        netPnl: s.netPnl,
        profitFactor: s.profitFactor,
      }
    })
    .sort((a, b) => b.netPnl - a.netPnl)

  const exits: ExitStats[] = [...exitMap.entries()]
    .map(([reason, entry]) => ({
      reason,
      count: entry.count,
      sharePct: exitCount > 0 ? (entry.count / exitCount) * 100 : 0,
      netPnl: entry.netPnl,
    }))
    .sort((a, b) => b.count - a.count)

  return {
    netPnl: total.netPnl,
    returnPct,
    finalBalance,
    grossProfit: round2(total.grossProfit),
    grossLoss: round2(total.grossLoss),
    totalFees: hasFees ? round2(feeSum) : null,
    payoffRatio,
    breakEvenWinRatePct,
    winRateEdgePp,
    recoveryFactor,
    expectancyR,
    maxWinStreak,
    maxLossStreak,
    currentStreak,
    longs: {
      count: longStats.count,
      wins: longStats.wins,
      losses: longStats.losses,
      winRate: longStats.winRate,
      netPnl: longStats.netPnl,
    },
    shorts: {
      count: shortStats.count,
      wins: shortStats.wins,
      losses: shortStats.losses,
      winRate: shortStats.winRate,
      netPnl: shortStats.netPnl,
    },
    byPair,
    exits,
  }
}

export function computeEquityPoints(
  trades: Trade[],
  initialBalance = startingBalance,
  startLabel = 'Start',
): ChartPoint[] {
  const ordered = sortTradesChronologically(trades)

  const points: ChartPoint[] = [{ label: startLabel, value: initialBalance }]
  let balance = initialBalance

  for (const trade of ordered) {
    balance = Math.round((balance + tradePnl(trade)) * 100) / 100
    points.push({ label: trade.time, value: balance })
  }

  return points
}
