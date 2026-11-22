/**
 * Pure diffusion nowcast probability model and nested timeframe coherence math.
 * Browser-and-server-safe TypeScript (zero Node-only imports).
 */

const MIN_PROB = 0.0001
const MAX_PROB = 0.9999
const INV_SQRT_2PI = 0.3989422804014327

// Abramowitz & Stegun 26.2.17 constants (max error < 7.5e-8)
const AS_P = 0.2316419
const AS_B1 = 0.31938153
const AS_B2 = -0.356563782
const AS_B3 = 1.781477937
const AS_B4 = -1.821255978
const AS_B5 = 1.330274429

export type NowcastInput = {
  openTwap: number
  currentTwap: number
  secondsRemaining: number
  sigma1m: number
  marketMidYes?: number
  blendWeight?: number
}

export type NowcastEstimate = {
  z: number
  pRawYes: number
  pBlendedYes: number
  remainingMinutes: number
  valid: boolean
}

export type NestedConditionalOptions = {
  parentMarketMid?: number
  childMarketMid?: number
  dislocationThreshold?: number
}

export type NestedConditionalResult = {
  valid: boolean
  correlation: number
  pParentYes: number
  pChildYes: number
  pJointYes: number
  pChildGivenParentYes: number
  pChildGivenParentNo: number
  pChildImpliedByParentMarket: number | null
  dislocation: number
  dislocated: boolean
  recommendedLeg: 'child' | 'parent' | null
  recommendedOutcome: 'YES' | 'NO' | null
}

function clampProb(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(MAX_PROB, Math.max(MIN_PROB, value))
}

/**
 * Standard normal cumulative distribution function Phi(z).
 * Uses Abramowitz & Stegun 26.2.17 (max error < 7.5e-8), clamped safely in
 * [0.0001, 0.9999] to prevent extreme-tail singularities while preserving
 * monotonicity across all finite and infinite inputs.
 */
export function normalCdf(z: number): number {
  if (Number.isNaN(z)) return 0.5
  if (z === 0) return 0.5
  if (z === Infinity) return MAX_PROB
  if (z === -Infinity) return MIN_PROB

  const absZ = Math.abs(z)
  const t = 1 / (1 + AS_P * absZ)
  const pdf = INV_SQRT_2PI * Math.exp(-0.5 * absZ * absZ)
  const poly = ((((AS_B5 * t + AS_B4) * t + AS_B3) * t + AS_B2) * t + AS_B1) * t
  const tail = pdf * poly
  const raw = z >= 0 ? 1 - tail : tail
  return clampProb(raw)
}

/**
 * Driftless log-space diffusion nowcast for a binary UP contract:
 *   z = ln(St / S0) / (sigma1m * sqrt(max(1/60, secondsRemaining / 60)))
 *   pRawYes = Phi(z)
 */
export function computeNowcast(input: NowcastInput): NowcastEstimate {
  if (
    !Number.isFinite(input.openTwap) ||
    input.openTwap <= 0 ||
    !Number.isFinite(input.currentTwap) ||
    input.currentTwap <= 0 ||
    !Number.isFinite(input.sigma1m) ||
    input.sigma1m <= 0 ||
    !Number.isFinite(input.secondsRemaining) ||
    input.secondsRemaining < 0
  ) {
    return {
      z: 0,
      pRawYes: 0.5,
      pBlendedYes: 0.5,
      remainingMinutes: 0,
      valid: false,
    }
  }

  const remainingMinutes = Math.max(1 / 60, input.secondsRemaining / 60)
  const denom = input.sigma1m * Math.sqrt(remainingMinutes)
  if (!Number.isFinite(denom) || denom <= 0) {
    return {
      z: 0,
      pRawYes: 0.5,
      pBlendedYes: 0.5,
      remainingMinutes: 0,
      valid: false,
    }
  }

  const z = Math.log(input.currentTwap / input.openTwap) / denom
  if (!Number.isFinite(z)) {
    return {
      z: 0,
      pRawYes: 0.5,
      pBlendedYes: 0.5,
      remainingMinutes: 0,
      valid: false,
    }
  }

  const pRawYes = normalCdf(z)
  const weight =
    input.blendWeight !== undefined && Number.isFinite(input.blendWeight)
      ? Math.min(1, Math.max(0, input.blendWeight))
      : 0.75

  let pBlendedYes = pRawYes
  if (input.marketMidYes !== undefined && Number.isFinite(input.marketMidYes)) {
    const mid = clampProb(input.marketMidYes)
    pBlendedYes = clampProb(weight * pRawYes + (1 - weight) * mid)
  }

  return {
    z,
    pRawYes,
    pBlendedYes,
    remainingMinutes,
    valid: true,
  }
}

/**
 * Prices nested path consistency when a shorter timeframe window (e.g. 5m)
 * tiles inside a longer parent window (e.g. 15m or 1h) sharing the same BTC path.
 * Computes bivariate normal joint probability P(child YES AND parent YES | St)
 * and conditional probabilities P(child YES | parent YES) / P(child YES | parent NO),
 * flagging dislocation when market prices diverge by >= dislocationThreshold (default 0.04).
 */
export function computeNestedConditionalYes(
  parentOpen: number,
  childOpen: number,
  currentTwap: number,
  parentRemainingSec: number,
  childRemainingSec: number,
  sigma1m: number,
  options?: NestedConditionalOptions,
): NestedConditionalResult {
  if (
    !Number.isFinite(parentOpen) ||
    parentOpen <= 0 ||
    !Number.isFinite(childOpen) ||
    childOpen <= 0 ||
    !Number.isFinite(currentTwap) ||
    currentTwap <= 0 ||
    !Number.isFinite(sigma1m) ||
    sigma1m <= 0 ||
    !Number.isFinite(parentRemainingSec) ||
    parentRemainingSec <= 0 ||
    !Number.isFinite(childRemainingSec) ||
    childRemainingSec < 0 ||
    childRemainingSec > parentRemainingSec
  ) {
    return {
      valid: false,
      correlation: 0,
      pParentYes: 0.5,
      pChildYes: 0.5,
      pJointYes: 0.25,
      pChildGivenParentYes: 0.5,
      pChildGivenParentNo: 0.5,
      pChildImpliedByParentMarket: null,
      dislocation: 0,
      dislocated: false,
      recommendedLeg: null,
      recommendedOutcome: null,
    }
  }

  const parentNow = computeNowcast({
    openTwap: parentOpen,
    currentTwap,
    secondsRemaining: parentRemainingSec,
    sigma1m,
  })
  const childNow = computeNowcast({
    openTwap: childOpen,
    currentTwap,
    secondsRemaining: childRemainingSec,
    sigma1m,
  })

  if (!parentNow.valid || !childNow.valid) {
    return {
      valid: false,
      correlation: 0,
      pParentYes: 0.5,
      pChildYes: 0.5,
      pJointYes: 0.25,
      pChildGivenParentYes: 0.5,
      pChildGivenParentNo: 0.5,
      pChildImpliedByParentMarket: null,
      dislocation: 0,
      dislocated: false,
      recommendedLeg: null,
      recommendedOutcome: null,
    }
  }

  const tp = parentNow.remainingMinutes
  const tc = Math.min(tp, childNow.remainingMinutes)
  const zParent = parentNow.z
  const zChild = childNow.z
  const pParentYes = parentNow.pRawYes
  const pChildYes = childNow.pRawYes
  const correlation = Math.min(1, Math.max(0, Math.sqrt(tc / tp)))

  const lowerFrechet = Math.max(0, pParentYes + pChildYes - 1)
  const upperFrechet = Math.min(pParentYes, pChildYes)

  let pJointYes: number
  if (tp - tc <= 1e-9) {
    pJointYes = upperFrechet
  } else {
    const lowerBound = Math.max(-8, -zChild)
    if (lowerBound >= 8) {
      pJointYes = Math.max(lowerFrechet, Math.min(upperFrechet, MIN_PROB * pParentYes))
    } else {
      const steps = 80
      const du = (8 - lowerBound) / steps
      const sqrtRemaining = Math.sqrt(tp - tc)
      const sqrtTp = Math.sqrt(tp)
      const sqrtTc = Math.sqrt(tc)
      let integral = 0
      for (let i = 0; i < steps; i++) {
        const u = lowerBound + (i + 0.5) * du
        const condZ = (zParent * sqrtTp + u * sqrtTc) / sqrtRemaining
        const phi = INV_SQRT_2PI * Math.exp(-0.5 * u * u)
        integral += phi * normalCdf(condZ) * du
      }
      pJointYes = Math.min(upperFrechet, Math.max(lowerFrechet, integral))
    }
  }

  const pChildGivenParentYes = clampProb(pJointYes / pParentYes)
  const pChildGivenParentNo = clampProb(
    (pChildYes - pJointYes) / Math.max(MIN_PROB, 1 - pParentYes),
  )

  const threshold =
    options?.dislocationThreshold !== undefined &&
    Number.isFinite(options.dislocationThreshold)
      ? Math.max(0, options.dislocationThreshold)
      : 0.04

  const hasParentMid =
    options?.parentMarketMid !== undefined && Number.isFinite(options.parentMarketMid)
  const hasChildMid =
    options?.childMarketMid !== undefined && Number.isFinite(options.childMarketMid)

  const parentMid = hasParentMid ? clampProb(options.parentMarketMid!) : null
  const childMid = hasChildMid ? clampProb(options.childMarketMid!) : null

  const pChildImpliedByParentMarket =
    parentMid !== null
      ? clampProb(
          parentMid * pChildGivenParentYes + (1 - parentMid) * pChildGivenParentNo,
        )
      : null

  const childDiff =
    childMid !== null ? (pChildImpliedByParentMarket ?? pChildYes) - childMid : 0
  const parentDiff = parentMid !== null ? pParentYes - parentMid : 0

  const dislocation = Math.max(Math.abs(childDiff), Math.abs(parentDiff))
  const dislocated = dislocation >= threshold

  let recommendedLeg: 'child' | 'parent' | null = null
  let recommendedOutcome: 'YES' | 'NO' | null = null
  if (dislocated) {
    if (Math.abs(childDiff) >= Math.abs(parentDiff)) {
      recommendedLeg = 'child'
      recommendedOutcome = childDiff >= 0 ? 'YES' : 'NO'
    } else {
      recommendedLeg = 'parent'
      recommendedOutcome = parentDiff >= 0 ? 'YES' : 'NO'
    }
  }

  return {
    valid: true,
    correlation,
    pParentYes,
    pChildYes,
    pJointYes,
    pChildGivenParentYes,
    pChildGivenParentNo,
    pChildImpliedByParentMarket,
    dislocation,
    dislocated,
    recommendedLeg,
    recommendedOutcome,
  }
}
