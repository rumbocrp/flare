import type { Trade, TradeSide } from './types'

export const sideLabels: Record<TradeSide, string> = {
  buy: 'BUY',
  sell: 'SELL',
}

export function tradePnl(trade: Trade): number {
  if (typeof trade.pnl === 'number' && Number.isFinite(trade.pnl)) {
    return trade.pnl
  }
  const move = (trade.exitPrice - trade.entryPrice) / trade.entryPrice
  const direction = trade.side === 'buy' ? 1 : -1
  return Math.round(move * direction * trade.size * 100) / 100
}
