import { describe, expect, it } from 'vitest'
import {
  computeNestedConditionalYes,
  computeNowcast,
  normalCdf,
} from './nowcast'

describe('normalCdf', () => {
  it('returns exact 0.5 at z = 0 and NaN, and respects symmetry', () => {
    expect(normalCdf(0)).toBe(0.5)
    expect(normalCdf(Number.NaN)).toBe(0.5)

    for (const z of [0.25, 0.5, 1, 1.5, 1.96, 2.5, 3]) {
      expect(normalCdf(-z) + normalCdf(z)).toBeCloseTo(1, 12)
    }
  })

  it('matches standard normal reference values within < 1e-7 error', () => {
    const refs: [number, number][] = [
      [0.5, 0.6914624612740131],
      [1.0, 0.8413447460685429],
      [1.96, 0.9750021048517796],
      [2.0, 0.9772498680518208],
      [3.0, 0.9986501019683699],
      [-1.96, 0.0249978951482204],
    ]
    for (const [z, expected] of refs) {
      expect(Math.abs(normalCdf(z) - expected)).toBeLessThan(1e-7)
    }
  })

  it('handles extreme |z| > 8 and infinities safely in [0.0001, 0.9999] while staying monotonic', () => {
    expect(normalCdf(9)).toBe(0.9999)
    expect(normalCdf(-9)).toBe(0.0001)
    expect(normalCdf(15)).toBe(0.9999)
    expect(normalCdf(-15)).toBe(0.0001)
    expect(normalCdf(Infinity)).toBe(0.9999)
    expect(normalCdf(-Infinity)).toBe(0.0001)

    expect(normalCdf(3)).toBeLessThan(normalCdf(5))
    expect(normalCdf(5)).toBeLessThanOrEqual(normalCdf(10))
    expect(normalCdf(-10)).toBeLessThanOrEqual(normalCdf(-5))
    expect(normalCdf(-5)).toBeLessThan(normalCdf(-3))
  })
})

describe('computeNowcast', () => {
  it('returns z = 0 and pRawYes = 0.5 when St === S0', () => {
    const est = computeNowcast({
      openTwap: 95_000,
      currentTwap: 95_000,
      secondsRemaining: 120,
      sigma1m: 0.001,
    })
    expect(est.valid).toBe(true)
    expect(est.z).toBe(0)
    expect(est.pRawYes).toBe(0.5)
    expect(est.pBlendedYes).toBe(0.5)
    expect(est.remainingMinutes).toBe(2)
  })

  it('responds monotonically as currentTwap rises above or falls below openTwap', () => {
    const prices = [94_500, 94_800, 95_000, 95_200, 95_500]
    const probs = prices.map(
      (currentTwap) =>
        computeNowcast({
          openTwap: 95_000,
          currentTwap,
          secondsRemaining: 180,
          sigma1m: 0.0015,
        }).pRawYes,
    )

    for (let i = 1; i < probs.length; i++) {
      expect(probs[i]).toBeGreaterThan(probs[i - 1])
    }
  })

  it('blends pRawYes with marketMidYes using default 0.75 weight or custom blendWeight', () => {
    const base = computeNowcast({
      openTwap: 95_000,
      currentTwap: 95_100,
      secondsRemaining: 120,
      sigma1m: 0.001,
      marketMidYes: 0.6,
    })
    expect(base.valid).toBe(true)
    expect(base.pBlendedYes).toBeCloseTo(0.75 * base.pRawYes + 0.25 * 0.6, 10)

    const custom = computeNowcast({
      openTwap: 95_000,
      currentTwap: 95_100,
      secondsRemaining: 120,
      sigma1m: 0.001,
      marketMidYes: 0.6,
      blendWeight: 0.5,
    })
    expect(custom.pBlendedYes).toBeCloseTo(0.5 * custom.pRawYes + 0.5 * 0.6, 10)
  })

  it('handles secondsRemaining = 0 safely using 1/60 minute floor and rejects invalid inputs without NaNs', () => {
    const atExpiry = computeNowcast({
      openTwap: 95_000,
      currentTwap: 95_050,
      secondsRemaining: 0,
      sigma1m: 0.001,
    })
    expect(atExpiry.valid).toBe(true)
    expect(atExpiry.remainingMinutes).toBeCloseTo(1 / 60, 12)
    expect(Number.isFinite(atExpiry.z)).toBe(true)
    expect(atExpiry.pRawYes).toBeGreaterThan(0.5)

    const invalids = [
      { openTwap: 0, currentTwap: 95_000, secondsRemaining: 60, sigma1m: 0.001 },
      { openTwap: -10, currentTwap: 95_000, secondsRemaining: 60, sigma1m: 0.001 },
      { openTwap: 95_000, currentTwap: 0, secondsRemaining: 60, sigma1m: 0.001 },
      { openTwap: 95_000, currentTwap: 95_000, secondsRemaining: 60, sigma1m: 0 },
      { openTwap: 95_000, currentTwap: 95_000, secondsRemaining: -5, sigma1m: 0.001 },
      {
        openTwap: Number.NaN,
        currentTwap: 95_000,
        secondsRemaining: 60,
        sigma1m: 0.001,
      },
    ]
    for (const input of invalids) {
      const res = computeNowcast(input)
      expect(res.valid).toBe(false)
      expect(Number.isNaN(res.z)).toBe(false)
      expect(Number.isNaN(res.pRawYes)).toBe(false)
      expect(Number.isNaN(res.pBlendedYes)).toBe(false)
    }
  })
})

describe('computeNestedConditionalYes', () => {
  it('yields correlation = 1 and deterministic conditional alignment when child and parent expire together', () => {
    const res = computeNestedConditionalYes(
      95_000,
      95_000,
      95_050,
      300,
      300,
      0.001,
    )
    expect(res.valid).toBe(true)
    expect(res.correlation).toBeCloseTo(1, 10)
    expect(res.pParentYes).toBeCloseTo(res.pChildYes, 10)
    expect(res.pJointYes).toBeCloseTo(res.pChildYes, 10)
    expect(res.pChildGivenParentYes).toBeCloseTo(0.9999, 4)
    expect(res.pChildGivenParentNo).toBeCloseTo(0.0001, 4)
  })

  it('prices tiled 5m-in-15m and 15m-in-1h path coherence with positive dependence', () => {
    const res5In15 = computeNestedConditionalYes(
      95_000,
      95_000,
      95_020,
      900,
      300,
      0.001,
    )
    expect(res5In15.valid).toBe(true)
    expect(res5In15.correlation).toBeCloseTo(Math.sqrt(1 / 3), 8)
    expect(res5In15.pChildGivenParentYes).toBeGreaterThan(res5In15.pChildYes)
    expect(res5In15.pChildYes).toBeGreaterThan(res5In15.pChildGivenParentNo)
    expect(res5In15.pJointYes).toBeLessThanOrEqual(
      Math.min(res5In15.pParentYes, res5In15.pChildYes) + 1e-12,
    )

    const res15In1h = computeNestedConditionalYes(
      95_000,
      95_100,
      95_120,
      3600,
      900,
      0.001,
    )
    expect(res15In1h.valid).toBe(true)
    expect(res15In1h.correlation).toBeCloseTo(0.5, 8)
    expect(res15In1h.pChildGivenParentYes).toBeGreaterThan(res15In1h.pChildYes)
  })

  it('flags >= 0.04 dislocation on whichever leg is mispriced and stays quiet below 0.04', () => {
    const fair = computeNestedConditionalYes(95_000, 95_000, 95_000, 900, 300, 0.001)
    expect(fair.valid).toBe(true)

    const quiet = computeNestedConditionalYes(
      95_000,
      95_000,
      95_000,
      900,
      300,
      0.001,
      {
        parentMarketMid: fair.pParentYes,
        childMarketMid: fair.pChildYes - 0.02,
      },
    )
    expect(quiet.dislocated).toBe(false)
    expect(quiet.recommendedLeg).toBeNull()
    expect(quiet.recommendedOutcome).toBeNull()

    const richChild = computeNestedConditionalYes(
      95_000,
      95_000,
      95_000,
      900,
      300,
      0.001,
      {
        parentMarketMid: fair.pParentYes,
        childMarketMid: fair.pChildYes + 0.08,
      },
    )
    expect(richChild.dislocated).toBe(true)
    expect(richChild.dislocation).toBeGreaterThanOrEqual(0.04)
    expect(richChild.recommendedLeg).toBe('child')
    expect(richChild.recommendedOutcome).toBe('NO')

    const cheapParent = computeNestedConditionalYes(
      95_000,
      95_000,
      95_000,
      900,
      300,
      0.001,
      {
        parentMarketMid: fair.pParentYes - 0.12,
        childMarketMid:
          (fair.pParentYes - 0.12) * fair.pChildGivenParentYes +
          (1 - (fair.pParentYes - 0.12)) * fair.pChildGivenParentNo,
      },
    )
    expect(cheapParent.dislocated).toBe(true)
    expect(cheapParent.recommendedLeg).toBe('parent')
    expect(cheapParent.recommendedOutcome).toBe('YES')
  })

  it('returns valid: false when childRemainingSec > parentRemainingSec or inputs are invalid', () => {
    const invalidOrder = computeNestedConditionalYes(
      95_000,
      95_000,
      95_000,
      300,
      600,
      0.001,
    )
    expect(invalidOrder.valid).toBe(false)

    const invalidZeroParent = computeNestedConditionalYes(
      95_000,
      95_000,
      95_000,
      0,
      0,
      0.001,
    )
    expect(invalidZeroParent.valid).toBe(false)
  })
})
