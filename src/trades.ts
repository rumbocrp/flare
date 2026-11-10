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

export const trades: Trade[] = [
  { id: 1, time: '08:42', pair: 'BTC/USDT', side: 'buy', entryPrice: 60000, exitPrice: 63000, size: 500 },
  { id: 2, time: '09:10', pair: 'ETH/USDT', side: 'sell', entryPrice: 3000, exitPrice: 2880, size: 500 },
  { id: 3, time: '09:35', pair: 'SOL/USDT', side: 'buy', entryPrice: 150, exitPrice: 147, size: 500 },
  { id: 4, time: '10:20', pair: 'BTC/USDT', side: 'sell', entryPrice: 61000, exitPrice: 59170, size: 500 },
  { id: 5, time: '10:55', pair: 'ETH/USDT', side: 'buy', entryPrice: 3000, exitPrice: 3135, size: 500 },
  { id: 6, time: '11:30', pair: 'SOL/USDT', side: 'sell', entryPrice: 150, exitPrice: 153, size: 500 },
  { id: 7, time: '12:15', pair: 'BTC/USDT', side: 'buy', entryPrice: 60000, exitPrice: 62100, size: 500 },
  { id: 8, time: '13:00', pair: 'ETH/USDT', side: 'sell', entryPrice: 3200, exitPrice: 3072, size: 500 },
  { id: 9, time: '13:40', pair: 'SOL/USDT', side: 'buy', entryPrice: 160, exitPrice: 158.4, size: 500 },
  { id: 10, time: '14:25', pair: 'BTC/USDT', side: 'sell', entryPrice: 62000, exitPrice: 63240, size: 500 },
  { id: 11, time: '15:05', pair: 'ETH/USDT', side: 'buy', entryPrice: 3100, exitPrice: 3220.9, size: 500 },
  { id: 12, time: '15:50', pair: 'SOL/USDT', side: 'buy', entryPrice: 150, exitPrice: 156, size: 500 },
]
