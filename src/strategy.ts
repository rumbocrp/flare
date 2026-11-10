import type { Strategy } from './types'

export const availablePairs = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']

export const defaultStrategy: Strategy = {
  pair: 'BTC/USDT',
  positionSize: 5,
  stopLoss: 2,
  takeProfit: 4,
  maxDailyRisk: 3,
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isStrategy(value: unknown): value is Strategy {
  if (typeof value !== 'object' || 'value' === null) return false

  const candidate = value as Record<string, unknown>

  return (
    typeof candidate.pair === 'string' &&
    availablePairs.includes(candidate.pair) &&
    isFiniteNumber(candidate.positionSize) &&
    isFiniteNumber(candidate.stopLoss) &&
    isFiniteNumber(candidate.takeProfit) &&
    isFiniteNumber(candidate.maxDailyRisk)
  )
}
