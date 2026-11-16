import { crossoverSignals } from './signals'
import type {
  Candle,
  ExitReason,
  SignalParams,
  Strategy,
  Trade,
  TradeSide,
} from './types'

export type BacktestSettings = {
  initialBalance: number
  /** Commission per side, in percentage (e.g. 0.1 = 0.1%). */
  commissionPct: number
  /** Adverse slippage per fill, in percentage. */
  slippagePct: number
  /** When false, SELL signals only close existing long positions. */
  allowShort: boolean
}

export type BacktestConfig = {
  pair: string
  params: SignalParams
  strategy: Pick<
    Strategy,
    'positionSize' | 'stopLoss' | 'takeProfit' | 'maxDailyRisk'
  >
  settings: BacktestSettings
}

export type BacktestTrade = Trade & {
  pnl: number
  grossPnl: number
  fees: number
  entryTime: number
  exitTime: number
  exitReason: ExitReason
  balanceAfter: number
}

export type EquityPoint = {
  time: number
  value: number
}

export type BacktestResult = {
  config: BacktestConfig
  candles: { from: number; to: number; count: number }
  trades: BacktestTrade[]
  equity: EquityPoint[]
  initialBalance: number
  finalBalance: number
  netPnl: number
  returnPct: number
  feesPaid: number
  signals: number
  skippedSignals: number
  bankrupt: boolean
  warnings: string[]
}

export type BacktestSnapshot = {
  version: 1
  createdAt: number
  config: BacktestConfig
  candles: { from: number; to: number; count: number }
  trades: BacktestTrade[]
  summary: {
    initialBalance: number
    finalBalance: number
    netPnl: number
    returnPct: number
    feesPaid: number
    bankrupt: boolean
  }
}

/** Minimum fields required to evaluate a simulated position exit. */
type ExitCandidate = {
  side: TradeSide
  stopPrice: number
  targetPrice: number
}

type OpenPosition = ExitCandidate & {
  entryPrice: number
  entryTime: number
  quantity: number
  notional: number
  entryFee: number
}

type PendingAction = {
  side: TradeSide
  closeFirst: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function dayKey(time: number): number {
  return Math.floor(time / DAY_MS)
}

function toIso(time: number): string {
  return new Date(time).toISOString()
}

function directionOf(side: TradeSide): number {
  return side === 'buy' ? 1 : -1
}

/**
 * Applies adverse slippage:
 * - buy fills higher,
 * - sell fills lower.
 */
function fillPrice(
  price: number,
  side: TradeSide,
  slippagePct: number,
): number {
  return price * (1 + directionOf(side) * (slippagePct / 100))
}

/**
 * Checks whether a candle hits stop loss or take profit.
 * Conservative tie-breaker: if both are reached inside one bar, stop wins.
 * If the bar opens past either level, it fills at the bar open (gap).
 */
export function resolveExit(
  position: ExitCandidate,
  candle: Candle,
): { price: number; reason: ExitReason } | null {
  if (position.side === 'buy') {
    if (candle.open <= position.stopPrice) {
      return { price: candle.open, reason: 'stop' }
    }
    if (candle.open >= position.targetPrice) {
      return { price: candle.open, reason: 'target' }
    }
    if (candle.low <= position.stopPrice) {
      return { price: position.stopPrice, reason: 'stop' }
    }
    if (candle.high >= position.targetPrice) {
      return { price: position.targetPrice, reason: 'target' }
    }
    return null
  }

  if (candle.open >= position.stopPrice) {
    return { price: candle.open, reason: 'stop' }
  }
  if (candle.open <= position.targetPrice) {
    return { price: candle.open, reason: 'target' }
  }
  if (candle.high >= position.stopPrice) {
    return { price: position.stopPrice, reason: 'stop' }
  }
  if (candle.low <= position.targetPrice) {
    return { price: position.targetPrice, reason: 'target' }
  }
  return null
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a number greater than 0.`)
  }
}

function validateConfig(config: BacktestConfig): void {
  const { params, strategy, settings } = config

  assertPositive('Initial balance', settings.initialBalance)
  assertPositive('Position size', strategy.positionSize)
  assertPositive('Stop loss', strategy.stopLoss)
  assertPositive('Take profit', strategy.takeProfit)
  assertPositive('Max daily risk', strategy.maxDailyRisk)

  if (strategy.positionSize > 100) {
    throw new Error('Position size cannot exceed 100%.')
  }
  if (!Number.isFinite(settings.commissionPct) || settings.commissionPct < 0) {
    throw new Error('Commission cannot be negative.')
  }
  if (settings.commissionPct >= 100) {
    throw new Error('Commission must be below 100%.')
  }
  if (!Number.isFinite(settings.slippagePct) || settings.slippagePct < 0) {
    throw new Error('Slippage cannot be negative.')
  }
  if (settings.slippagePct >= 100) {
    throw new Error('Slippage must be below 100%.')
  }
  if (!Number.isInteger(params.fastPeriod) || params.fastPeriod < 1) {
    throw new Error('Fast period must be a positive integer.')
  }
  if (!Number.isInteger(params.slowPeriod) || params.slowPeriod < 1) {
    throw new Error('Slow period must be a positive integer.')
  }
  if (params.average !== 'sma' && params.average !== 'ema') {
    throw new Error('Moving average type must be sma or ema.')
  }
}

/**
 * Runs a deterministic candle-by-candle backtest.
 *
 * Rules:
 * - A signal on candle i executes at candle i + 1 open.
 * - Single position open at a time.
 * - SL/TP checked via high/low; stop triggers first if both are hit on the same bar.
 * - Balance updates only on realized exits.
 * - Any remaining open position is closed at the final candle close.
 */
export function runBacktest(
  candles: Candle[],
  config: BacktestConfig,
): BacktestResult {
  validateConfig(config)

  const data = [...candles].sort((a, b) => a.time - b.time)
  const { strategy, settings, params } = config
  const initialBalance = roundMoney(settings.initialBalance)

  if (data.length < 2) {
    return {
      config,
      candles: {
        from: data[0]?.time ?? 0,
        to: data[data.length - 1]?.time ?? 0,
        count: data.length,
      },
      trades: [],
      equity: [{ time: data[0]?.time ?? 0, value: initialBalance }],
      initialBalance,
      finalBalance: initialBalance,
      netPnl: 0,
      returnPct: 0,
      feesPaid: 0,
      signals: 0,
      skippedSignals: 0,
      bankrupt: false,
      warnings: ['At least 2 candles are required to run a backtest.'],
    }
  }

  const signals = crossoverSignals(data, params)
  const signalByIndex = new Map(
    signals.map((signal) => [signal.index, signal]),
  )
  const lastIndex = data.length - 1

  let balance = initialBalance
  let position: OpenPosition | null = null
  let pending: PendingAction | null = null
  let currentDay = dayKey(data[0].time)
  let dayStartBalance = balance
  let dayHalted = false
  let bankrupt = false
  let skippedSignals = 0
  let feesPaid = 0

  const trades: BacktestTrade[] = []
  const equity: EquityPoint[] = [{ time: data[0].time, value: balance }]
  const warnings: string[] = []

  function closePosition(
    rawPrice: number,
    time: number,
    reason: ExitReason,
  ): void {
    if (!position) return

    const closeSide: TradeSide = position.side === 'buy' ? 'sell' : 'buy'
    const exitPrice = fillPrice(rawPrice, closeSide, settings.slippagePct)
    const exitNotional = exitPrice * position.quantity
    const exitFee = exitNotional * (settings.commissionPct / 100)

    const rawGross =
      (exitPrice - position.entryPrice) *
      position.quantity *
      directionOf(position.side)

    const fees = roundMoney(position.entryFee + exitFee)
    const pnl = roundMoney(rawGross - fees)

    balance = roundMoney(balance + pnl)
    if (balance <= 0) {
      balance = 0
      bankrupt = true
      warnings.push('Account balance reached zero. No new trades will be opened.')
    }

    feesPaid = roundMoney(feesPaid + fees)

    trades.push({
      id: trades.length + 1,
      time: toIso(time),
      pair: config.pair,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice,
      size: roundMoney(position.notional),
      pnl,
      grossPnl: roundMoney(rawGross),
      fees,
      entryTime: position.entryTime,
      exitTime: time,
      exitReason: reason,
      balanceAfter: balance,
    })

    equity.push({ time, value: balance })

    if (dayStartBalance > 0) {
      const lossPct =
        ((dayStartBalance - balance) / dayStartBalance) * 100
      if (lossPct >= strategy.maxDailyRisk) {
        dayHalted = true
      }
    }

    position = null
  }

  function openPosition(
    side: TradeSide,
    rawPrice: number,
    time: number,
  ): void {
    if (balance <= 0 || bankrupt) return

    const entryPrice = fillPrice(rawPrice, side, settings.slippagePct)
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return

    const notional = Math.min(
      balance,
      balance * (strategy.positionSize / 100),
    )
    if (notional <= 0) return

    const quantity = notional / entryPrice
    const direction = directionOf(side)

    position = {
      side,
      entryPrice,
      entryTime: time,
      quantity,
      notional,
      entryFee: notional * (settings.commissionPct / 100),
      stopPrice: roundMoney(entryPrice * (1 - direction * (strategy.stopLoss / 100))),
      targetPrice: roundMoney(entryPrice * (1 + direction * (strategy.takeProfit / 100))),
    }
  }

  for (let index = 0; index < data.length; index++) {
    const candle = data[index]
    const day = dayKey(candle.time)

    // New UTC day: reset daily risk counter.
    if (day !== currentDay) {
      currentDay = day
      dayStartBalance = balance
      dayHalted = false
    }

    // 1) Execute signal confirmed at the previous candle close.
    if (pending) {
      if (position && pending.closeFirst) {
        closePosition(candle.open, candle.time, 'signal')
      }

      if (pending.side && !position) {
        if (dayHalted || bankrupt) {
          skippedSignals++
        } else if (pending.side === 'sell' && !settings.allowShort) {
          skippedSignals++
        } else {
          openPosition(pending.side, candle.open, candle.time)
        }
      }

      pending = null
    }

    // 2) Check intra-candle stop loss / take profit.
    if (position) {
      const exit = resolveExit(position, candle)
      if (exit) {
        closePosition(exit.price, candle.time, exit.reason)
      }
    }

    // 3) Record signal on this candle for execution at the next open.
    const signal = signalByIndex.get(index)

    if (signal) {
      if (index === lastIndex) {
        skippedSignals++
      } else if (!position) {
        if (signal.side === 'sell' && !settings.allowShort) {
          skippedSignals++
        } else {
          pending = { side: signal.side, closeFirst: false }
        }
      } else if ((position as OpenPosition).side !== signal.side) {
        pending = { side: signal.side, closeFirst: true }
      } else {
        skippedSignals++
      }
    }
  }

  // 4) Close any position still open at the end of the dataset.
  if (position) {
    closePosition(data[lastIndex].close, data[lastIndex].time, 'end')
  }

  const finalBalance = roundMoney(balance)
  const netPnl = roundMoney(finalBalance - initialBalance)

  return {
    config,
    candles: {
      from: data[0].time,
      to: data[lastIndex].time,
      count: data.length,
    },
    trades,
    equity,
    initialBalance,
    finalBalance,
    netPnl,
    returnPct:
      initialBalance > 0 ? (netPnl / initialBalance) * 100 : 0,
    feesPaid,
    signals: signals.length,
    skippedSignals,
    bankrupt,
    warnings,
  }
}

export function createBacktestSnapshot(
  result: BacktestResult,
): BacktestSnapshot {
  return {
    version: 1,
    createdAt: Date.now(),
    config: result.config,
    candles: result.candles,
    trades: result.trades,
    summary: {
      initialBalance: result.initialBalance,
      finalBalance: result.finalBalance,
      netPnl: result.netPnl,
      returnPct: result.returnPct,
      feesPaid: result.feesPaid,
      bankrupt: result.bankrupt,
    },
  }
}

function isBacktestTrade(value: unknown): value is BacktestTrade {
  if (typeof value !== 'object' || value === null) return false
  const trade = value as Record<string, unknown>
  return (
    typeof trade.id === 'number' &&
    typeof trade.time === 'string' &&
    typeof trade.pair === 'string' &&
    (trade.side === 'buy' || trade.side === 'sell') &&
    typeof trade.entryPrice === 'number' &&
    typeof trade.exitPrice === 'number' &&
    typeof trade.size === 'number' &&
    typeof trade.pnl === 'number' &&
    typeof trade.balanceAfter === 'number' &&
    typeof trade.entryTime === 'number' &&
    typeof trade.exitTime === 'number' &&
    (trade.exitReason === 'stop' ||
      trade.exitReason === 'target' ||
      trade.exitReason === 'signal' ||
      trade.exitReason === 'end' ||
      trade.exitReason === 'bankrupt')
  )
}

export function isBacktestSnapshot(
  value: unknown,
): value is BacktestSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>

  if (candidate.version !== 1) return false
  if (typeof candidate.createdAt !== 'number') return false
  if (!Array.isArray(candidate.trades)) return false
  if (!candidate.trades.every(isBacktestTrade)) return false
  if (typeof candidate.config !== 'object' || candidate.config === null) {
    return false
  }
  if (typeof candidate.candles !== 'object' || candidate.candles === null) {
    return false
  }
  if (typeof candidate.summary !== 'object' || candidate.summary === null) {
    return false
  }

  const config = candidate.config as Record<string, unknown>
  if (typeof config.pair !== 'string') return false

  const candles = candidate.candles as Record<string, unknown>
  if (typeof candles.count !== 'number') return false

  const summary = candidate.summary as Record<string, unknown>
  return (
    typeof summary.initialBalance === 'number' &&
    typeof summary.finalBalance === 'number' &&
    typeof summary.netPnl === 'number' &&
    typeof summary.returnPct === 'number' &&
    typeof summary.feesPaid === 'number' &&
    typeof summary.bankrupt === 'boolean'
  )
}
