import { describe, expect, it } from 'vitest'
import { defaultStrategy, isStrategy } from './strategy'

describe('isStrategy', () => {
  it('accepts valid strategy definitions', () => {
    expect(isStrategy(defaultStrategy)).toBe(true)
  })

  it('rejects null and non-object values without throwing', () => {
    expect(isStrategy(null)).toBe(false)
    expect(isStrategy(undefined)).toBe(false)
    expect(isStrategy('BTC/USDT')).toBe(false)
    expect(isStrategy(42)).toBe(false)
  })

  it('rejects invalid pairs or non-finite numeric risk parameters', () => {
    expect(isStrategy({ ...defaultStrategy, pair: 'INVALID/USDT' })).toBe(false)
    expect(isStrategy({ ...defaultStrategy, positionSize: Number.NaN })).toBe(
      false,
    )
    expect(
      isStrategy({ ...defaultStrategy, stopLoss: Number.POSITIVE_INFINITY }),
    ).toBe(false)
  })
})
