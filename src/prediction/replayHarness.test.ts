import { describe, expect, it } from 'vitest'
import {
  applyCalibrator,
  brierSkillScore,
  computeBrierScore,
  fitIsotonicCalibrator,
  type CalibrationSample,
} from './calibration'
import {
  runWindowReplay,
  type CollectedWindowReplayInput,
  type ReplaySnapshotPoint,
} from './replayHarness'

function makeWindow(
  index: number,
  options: {
    resolvedUp: boolean | null
    pModelYes?: number
    yesBid?: number
    yesAsk?: number
    noBid?: number
    noAsk?: number
    markoutYesMid?: number
    startOffsetMs?: number
  },
): CollectedWindowReplayInput {
  const startTimeMs = (options.startOffsetMs ?? index * 300_000) + 1_700_000_000_000
  const endTimeMs = startTimeMs + 300_000
  const slug = `btc-updown-5m-${index}`
  const yesBid = options.yesBid ?? 0.49
  const yesAsk = options.yesAsk ?? 0.5
  const noBid = options.noBid ?? 0.49
  const noAsk = options.noAsk ?? 0.5

  const snapshots: ReplaySnapshotPoint[] = [
    {
      slug,
      capturedAtMs: startTimeMs + 120_000,
      secondsRemaining: 180,
      twapPrice: 95_000,
      binancePrice: 95_000,
      sigma1m: 0.001,
      basisBps: 0,
      yesBid,
      yesAsk,
      yesDepthUsd: 500,
      noBid,
      noAsk,
      noDepthUsd: 500,
      pModelYes: options.pModelYes ?? 0.7,
    },
  ]

  if (options.markoutYesMid !== undefined) {
    snapshots.push({
      slug,
      capturedAtMs: startTimeMs + 150_000,
      secondsRemaining: 150,
      twapPrice: 95_010,
      binancePrice: 95_010,
      sigma1m: 0.001,
      basisBps: 0,
      yesBid: options.markoutYesMid - 0.005,
      yesAsk: options.markoutYesMid + 0.005,
      yesDepthUsd: 500,
      noBid: 1 - options.markoutYesMid - 0.005,
      noAsk: 1 - options.markoutYesMid + 0.005,
      noDepthUsd: 500,
      pModelYes: options.pModelYes ?? 0.7,
    })
  }

  return {
    slug,
    timeframe: '5m',
    resolutionSource: 'chainlink-twap-60s',
    startTimeMs,
    endTimeMs,
    openTwap: 95_000,
    closeTwap: options.resolvedUp === null ? null : options.resolvedUp ? 95_050 : 94_950,
    resolvedUp: options.resolvedUp,
    snapshots,
  }
}

describe('PAV isotonic calibration & Brier scoring', () => {
  it('falls back to identity calibration when < 30 samples and clamps to [0.01, 0.99]', () => {
    const small: CalibrationSample[] = Array.from({ length: 20 }, (_, i) => ({
      pRaw: (i + 1) / 25,
      outcome: i % 2 === 0 ? 1 : 0,
    }))
    const curve = fitIsotonicCalibrator(small)
    expect(curve.mode).toBe('identity')
    expect(curve.sampleCount).toBe(20)
    expect(applyCalibrator(curve, 0.001)).toBe(0.01)
    expect(applyCalibrator(curve, 0.999)).toBe(0.99)
    expect(applyCalibrator(curve, 0.62)).toBeCloseTo(0.62, 10)
    expect(applyCalibrator(curve, Number.NaN)).toBe(0.5)
  })

  it('produces monotone non-decreasing PAV blocks on non-monotone empirical frequencies', () => {
    const samples: CalibrationSample[] = []
    // Non-monotone empirical rates across bins: 0.2 -> 0.80, 0.4 -> 0.20, 0.7 -> 0.90
    for (let i = 0; i < 15; i++) {
      samples.push({ pRaw: 0.2, outcome: i < 12 ? 1 : 0 })
      samples.push({ pRaw: 0.4, outcome: i < 3 ? 1 : 0 })
      samples.push({ pRaw: 0.7, outcome: i < 14 ? 1 : 0 })
    }

    const curve = fitIsotonicCalibrator(samples)
    expect(curve.mode).toBe('pav')
    expect(curve.sampleCount).toBe(45)
    expect(curve.blocks.length).toBe(2)

    for (let i = 1; i < curve.blocks.length; i++) {
      expect(curve.blocks[i].y).toBeGreaterThanOrEqual(curve.blocks[i - 1].y)
    }

    const grid = [0.05, 0.2, 0.3, 0.4, 0.55, 0.7, 0.95]
    const preds = grid.map((p) => applyCalibrator(curve, p))
    for (let i = 1; i < preds.length; i++) {
      expect(preds[i]).toBeGreaterThanOrEqual(preds[i - 1])
    }
    expect(preds[0]).toBeGreaterThanOrEqual(0.01)
    expect(preds[preds.length - 1]).toBeLessThanOrEqual(0.99)
  })

  it('computes Brier score and Brier skill score accurately', () => {
    const modelBrier = computeBrierScore([
      { p: 0.8, outcome: 1 },
      { p: 0.2, outcome: 0 },
    ])
    expect(modelBrier).toBeCloseTo(0.04, 12)

    const marketBrier = computeBrierScore([
      { p: 0.5, outcome: 1 },
      { p: 0.5, outcome: 0 },
    ])
    expect(marketBrier).toBeCloseTo(0.25, 12)
    expect(brierSkillScore(modelBrier, marketBrier)).toBeCloseTo(1 - 0.04 / 0.25, 12)
    expect(computeBrierScore([])).toBe(0)
    expect(brierSkillScore(0.1, 0)).toBe(0)
  })
})

describe('runWindowReplay', () => {
  it('enforces chronological sort and strict train/test isolation (zero future leakage)', () => {
    // 40 settled windows + 2 unsettled windows, intentionally shuffled
    const baseWindows: CollectedWindowReplayInput[] = Array.from({ length: 40 }, (_, idx) =>
      makeWindow(idx, {
        resolvedUp: idx % 2 === 0,
        pModelYes: 0.3 + (idx % 5) * 0.1,
      }),
    )
    baseWindows.push(makeWindow(998, { resolvedUp: null }))
    baseWindows.push(makeWindow(999, { resolvedUp: null }))

    const shuffled = [...baseWindows].reverse()
    const mutatedTest = shuffled.map((w) => {
      const idx = Number(w.slug.split('-').pop())
      // Mutate outcomes ONLY for windows in the test split (idx >= 28)
      if (w.resolvedUp !== null && idx >= 28) {
        return { ...w, resolvedUp: true }
      }
      return w
    })

    const evaluator = () => ({
      outcome: 'YES' as const,
      liquidityRole: 'taker' as const,
    })

    const reportA = runWindowReplay(shuffled, evaluator, { trainRatio: 0.7 })
    const reportB = runWindowReplay(mutatedTest, evaluator, { trainRatio: 0.7 })

    expect(reportA.settledWindowCount).toBe(40)
    expect(reportA.trainWindowCount).toBe(28)
    expect(reportA.testWindowCount).toBe(12)
    expect(reportA.tradeCount).toBe(12)

    // Calibrator fitted strictly on train windows must be byte-for-byte identical
    expect(reportB.calibrator).toEqual(reportA.calibrator)
    // Out-of-sample test metrics reflect the mutated test outcomes
    expect(reportB.wins).toBe(12)
    expect(reportA.wins).toBe(6)
  })

  it('computes exact POLYMARKET_FEES.crypto taker fees, maker rebates, break-even %, +30s markout, and drawdown', () => {
    // 10 windows -> 7 train, 3 test. Test outcomes: [true, false, true]
    const windows: CollectedWindowReplayInput[] = []
    for (let i = 0; i < 7; i++) {
      windows.push(makeWindow(i, { resolvedUp: i % 2 === 0 }))
    }
    windows.push(
      makeWindow(7, {
        resolvedUp: true,
        yesBid: 0.48,
        yesAsk: 0.5,
        markoutYesMid: 0.55,
      }),
    )
    windows.push(
      makeWindow(8, {
        resolvedUp: false,
        yesBid: 0.48,
        yesAsk: 0.5,
        markoutYesMid: 0.45,
      }),
    )
    windows.push(
      makeWindow(9, {
        resolvedUp: true,
        yesBid: 0.48,
        yesAsk: 0.5,
        markoutYesMid: 0.53,
      }),
    )

    const takerReport = runWindowReplay(
      windows,
      () => ({ outcome: 'YES', liquidityRole: 'taker' }),
      { stakeUsd: 5, initialBankrollUsd: 1000 },
    )

    // At 0.50 taker: feePerShare = 0.07 * 0.5 * 0.5 = 0.0175 -> breakEven = 51.75%
    expect(takerReport.avgEntryPrice).toBeCloseTo(0.5, 10)
    expect(takerReport.avgFeePerShare).toBeCloseTo(0.0175, 10)
    expect(takerReport.avgBreakEvenPct).toBeCloseTo(51.75, 10)
    // Shares = 5 / 0.5 = 10; feeUsd = 0.175/trade; spreadDrag = 10 * 0.01 = 0.10/trade
    // Win1: +10 - 5 - 0.175 = +4.825; Loss2: -5 - 0.175 = -5.175; Win3: +4.825 -> total = +4.475
    expect(takerReport.netPnlUsd).toBeCloseTo(4.475, 6)
    expect(takerReport.totalFeesUsd).toBeCloseTo(0.525, 6)
    expect(takerReport.totalSpreadDragUsd).toBeCloseTo(0.3, 6)
    expect(takerReport.maxDrawdownUsd).toBeCloseTo(5.175, 6)
    expect(takerReport.maxDrawdownPct).toBeCloseTo((5.175 / 1004.825) * 100, 6)
    expect(takerReport.markoutSampleCount).toBe(3)
    expect(takerReport.meanMarkout30s).toBeCloseTo((0.05 + -0.05 + 0.03) / 3, 10)

    const makerReport = runWindowReplay(
      windows,
      () => ({ outcome: 'YES', liquidityRole: 'maker', limitPrice: 0.5 }),
      { stakeUsd: 5, initialBankrollUsd: 1000 },
    )
    // At 0.50 maker: feePerShare = -0.20 * 0.07 * 0.25 = -0.0035 -> breakEven = 49.65%
    expect(makerReport.avgFeePerShare).toBeCloseTo(-0.0035, 10)
    expect(makerReport.avgBreakEvenPct).toBeCloseTo(49.65, 10)
    expect(makerReport.totalSpreadDragUsd).toBe(0)
    expect(makerReport.netPnlUsd).toBeGreaterThan(takerReport.netPnlUsd)
  })

  it('enforces n >= 500, Wilson LB >= breakEven + 1pp, positive PnL, and markout >= -0.02 gates deterministically', () => {
    const smallSet = Array.from({ length: 200 }, (_, i) =>
      makeWindow(i, { resolvedUp: true, yesBid: 0.49, yesAsk: 0.5, markoutYesMid: 0.52 }),
    )
    const underSampled = runWindowReplay(smallSet, () => ({
      outcome: 'YES',
      liquidityRole: 'taker',
    }))
    expect(underSampled.eligibleForCanary).toBe(false)
    expect(underSampled.eligibleForPaperLive).toBe(false)
    expect(underSampled.sampleProgressText).toBe('200 / 500')
    expect(underSampled.sampleWarning).toContain('200 / 500')

    // 500 windows (350 train, 150 test)
    const build500 = (
      testWinRateMod: (testIdx: number) => boolean,
      markoutMid: number,
      yesAsk = 0.5,
    ) =>
      Array.from({ length: 500 }, (_, i) => {
        const isTrain = i < 350
        const resolvedUp = isTrain ? i % 2 === 0 : testWinRateMod(i - 350)
        return makeWindow(i, {
          resolvedUp,
          yesBid: yesAsk - 0.01,
          yesAsk,
          markoutYesMid: markoutMid,
        })
      })

    // 1) All 4 gates pass (80% win rate at 0.50 ask, markout +0.02)
    const passing = build500((idx) => idx % 5 !== 0, 0.52)
    const passA = runWindowReplay(passing, () => ({
      outcome: 'YES',
      liquidityRole: 'taker',
    }))
    const passB = runWindowReplay(passing, () => ({
      outcome: 'YES',
      liquidityRole: 'taker',
    }))
    expect(passA).toEqual(passB)
    expect(passA.eligibleForCanary).toBe(true)
    expect(passA.eligibleForPaperLive).toBe(true)
    expect(passA.sampleWarning).toBeNull()
    expect(passA.gateFailures).toEqual([])

    // 2) Fails Wilson LB < breakEven + 1pp (52% raw wins on 150 test trades -> Wilson LB ~44% < 52.75%)
    const lowWilson = build500((idx) => idx < 78, 0.52)
    const failWilson = runWindowReplay(lowWilson, () => ({
      outcome: 'YES',
      liquidityRole: 'taker',
    }))
    expect(failWilson.eligibleForCanary).toBe(false)
    expect(failWilson.eligibleForPaperLive).toBe(false)
    expect(failWilson.gateFailures.some((f) => f.includes('Wilson'))).toBe(true)

    // 3) Fails negative markout < -0.02
    const badMarkout = build500((idx) => idx % 5 !== 0, 0.45)
    const failMarkout = runWindowReplay(badMarkout, () => ({
      outcome: 'YES',
      liquidityRole: 'taker',
    }))
    expect(failMarkout.eligibleForCanary).toBe(false)
    expect(failMarkout.gateFailures.some((f) => f.includes('markout'))).toBe(true)

    // 4) Fails non-positive netPnlUsd
    const losing = build500((idx) => idx < 30, 0.52)
    const failPnl = runWindowReplay(losing, () => ({
      outcome: 'YES',
      liquidityRole: 'taker',
    }))
    expect(failPnl.eligibleForCanary).toBe(false)
    expect(failPnl.gateFailures.some((f) => f.includes('net PnL'))).toBe(true)
  })
})
