/**
 * Out-of-sample Pool Adjacent Violators (PAV) isotonic probability calibration
 * and Brier / Brier Skill Score (BSS) evaluation.
 * Browser-and-server-safe TypeScript (zero Node-only imports).
 */

const MIN_CALIBRATED_PROB = 0.01
const MAX_CALIBRATED_PROB = 0.99

export type CalibrationSample = {
  pRaw: number
  outcome: 0 | 1
}

export type IsotonicBlock = {
  minX: number
  maxX: number
  y: number
  weight: number
}

export type CalibrationCurve = {
  mode: 'pav' | 'identity'
  sampleCount: number
  blocks: IsotonicBlock[]
}

type PavAccumulator = {
  minX: number
  maxX: number
  sumY: number
  weight: number
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function clampCalibrated(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(MAX_CALIBRATED_PROB, Math.max(MIN_CALIBRATED_PROB, value))
}

/**
 * Fits a monotone non-decreasing step calibration curve via the Pool Adjacent
 * Violators (PAV) algorithm. Falls back to identity calibration when valid
 * training samples < minSamples (default 30).
 */
export function fitIsotonicCalibrator(
  samples: readonly CalibrationSample[],
  minSamples = 30,
): CalibrationCurve {
  const valid: CalibrationSample[] = []
  for (const s of samples) {
    if (!Number.isFinite(s.pRaw)) continue
    if (s.outcome !== 0 && s.outcome !== 1) continue
    valid.push({ pRaw: clampUnit(s.pRaw), outcome: s.outcome })
  }

  if (valid.length < minSamples) {
    return {
      mode: 'identity',
      sampleCount: valid.length,
      blocks: [],
    }
  }

  valid.sort((a, b) => a.pRaw - b.pRaw)

  // Group identical pRaw observations prior to PAV pooling so tie ordering cannot skew blocks.
  const grouped: PavAccumulator[] = []
  for (const item of valid) {
    const last = grouped[grouped.length - 1]
    if (last && item.pRaw === last.maxX) {
      last.sumY += item.outcome
      last.weight += 1
    } else {
      grouped.push({
        minX: item.pRaw,
        maxX: item.pRaw,
        sumY: item.outcome,
        weight: 1,
      })
    }
  }

  const stack: PavAccumulator[] = []
  for (const block of grouped) {
    stack.push({ ...block })
    while (stack.length >= 2) {
      const curr = stack[stack.length - 1]
      const prev = stack[stack.length - 2]
      if (prev.sumY / prev.weight > curr.sumY / curr.weight) {
        prev.maxX = curr.maxX
        prev.sumY += curr.sumY
        prev.weight += curr.weight
        stack.pop()
      } else {
        break
      }
    }
  }

  const blocks: IsotonicBlock[] = stack.map((b) => ({
    minX: b.minX,
    maxX: b.maxX,
    y: b.sumY / b.weight,
    weight: b.weight,
  }))

  return {
    mode: 'pav',
    sampleCount: valid.length,
    blocks,
  }
}

/**
 * Evaluates the fitted isotonic calibration curve at `pRaw`, clamped safely to [0.01, 0.99].
 */
export function applyCalibrator(calibrator: CalibrationCurve, pRaw: number): number {
  if (!Number.isFinite(pRaw)) return 0.5
  if (calibrator.mode === 'identity' || calibrator.blocks.length === 0) {
    return clampCalibrated(pRaw)
  }

  const blocks = calibrator.blocks
  if (pRaw <= blocks[0].maxX) {
    return clampCalibrated(blocks[0].y)
  }
  const last = blocks[blocks.length - 1]
  if (pRaw >= last.minX) {
    return clampCalibrated(last.y)
  }

  for (let i = 0; i < blocks.length - 1; i++) {
    const curr = blocks[i]
    const next = blocks[i + 1]
    if (pRaw <= curr.maxX) {
      return clampCalibrated(curr.y)
    }
    if (pRaw < next.minX) {
      const mid = (curr.maxX + next.minX) / 2
      return clampCalibrated(pRaw < mid ? curr.y : next.y)
    }
  }

  return clampCalibrated(last.y)
}

/**
 * Computes mean squared probability error (Brier score) across valid predictions.
 */
export function computeBrierScore(
  predictions: readonly { p: number; outcome: 0 | 1 }[],
): number {
  let sumSq = 0
  let count = 0
  for (const item of predictions) {
    if (!Number.isFinite(item.p)) continue
    if (item.outcome !== 0 && item.outcome !== 1) continue
    const p = clampUnit(item.p)
    const diff = p - item.outcome
    sumSq += diff * diff
    count++
  }
  return count > 0 ? sumSq / count : 0
}

/**
 * Brier Skill Score relative to a market baseline: 1 - (modelBrier / marketBrier).
 * Positive values indicate the model outperforms market prices.
 */
export function brierSkillScore(modelBrier: number, marketBrier: number): number {
  if (!Number.isFinite(modelBrier) || !Number.isFinite(marketBrier) || marketBrier <= 0) {
    return 0
  }
  return 1 - modelBrier / marketBrier
}
