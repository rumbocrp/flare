import { describe, expect, it } from 'vitest'
import {
  createInitialBotState,
  evaluateBotPresetAccuracy,
  mergePresetPatch,
  stepBotEngine,
  STRATEGY_PRESETS,
} from '../botEngine'
import { syntheticSource } from '../market/synthetic'
import {
  evaluateDonchianExit,
  generateSignals,
  MIN_SPOT_ENGINE_WARMUP,
  signalAt,
  type NewSpotEngineId,
} from '../spotEngines'
import type { Candle } from '../types'
import {
  buildTrainingCatalog,
  ENGINE_TEMPLATES,
  getStrategyFamily,
  ORIGINAL_8_PRESET_IDS,
  STRATEGY_FAMILIES,
} from './strategyRegistry'

const HOUR_MS = 3_600_000
const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0)

function makeCandle(
  i: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
): Candle {
  return {
    time: BASE_TIME + i * HOUR_MS,
    open,
    high: Math.max(high, open, close),
    low: Math.min(low, open, close),
    close,
    volume,
  }
}

/**
 * Deterministic 330-bar fixture with EMA200 warmup, bullish breakout above 20-bar
 * high while above EMA200, followed by reversal and bearish breakdown below 20-bar
 * low while below EMA200.
 */
function buildDonchianFixture(): Candle[] {
  const candles: Candle[] = []
  for (let i = 0; i < 330; i += 1) {
    let base: number
    if (i < 205) {
      // Gentle uptrend with mild sine wave so ATR >= 0.5% and EMA200 trails below price
      base = 100 + i * 0.1 + Math.sin(i * 0.45) * 1.2
    } else if (i < 225) {
      // Tight consolidation around 120.5 (below 122)
      base = 120.2 + Math.sin(i * 0.6) * 0.5
    } else if (i < 240) {
      // Clean bullish Donchian breakout above 20-bar high
      base = 123.5 + (i - 225) * 1.1
    } else if (i < 290) {
      // Sharp reversal well below EMA200 (~115) down to ~88
      base = 138 - (i - 240) * 1.05 + Math.sin(i * 0.5) * 0.8
    } else if (i < 312) {
      // Tight range around 86
      base = 86.2 + Math.sin(i * 0.6) * 0.4
    } else {
      // Clean bearish Donchian breakdown below 20-bar low while below EMA200
      base = 83.0 - (i - 312) * 1.1
    }

    const dir = i >= 225 && i < 240 ? 1 : i >= 312 ? -1 : i % 2 === 0 ? 1 : -1
    const open = base - dir * 0.35
    const close = base + dir * 0.35
    const high = Math.max(open, close) + 0.6
    const low = Math.min(open, close) - 0.6
    candles.push(makeCandle(i, open, high, low, close))
  }
  return candles
}

/**
 * Deterministic 130-bar Support & Resistance fixture with repeated k=2 pivot
 * touches around support (~100) and resistance (~110), followed by a clean green
 * support bounce (RSI >= 40) and a clean red resistance rejection (RSI <= 60).
 */
function buildSupportResistanceFixture(): Candle[] {
  const candles: Candle[] = []
  // Sawtooth range between 100 and 110 (period 12 bars: trough at 100, peak at 110)
  for (let i = 0; i < 120; i += 1) {
    const phase = i % 12
    let open: number
    let close: number
    let high: number
    let low: number

    if (i === 72) {
      // Bullish support bounce off ~100 cluster with strong green close
      open = 100.7
      low = 100.05
      close = 102.9
      high = 103.2
    } else if (i === 96) {
      // Bearish resistance rejection off ~110 cluster with strong red close
      open = 109.3
      high = 109.95
      close = 107.1
      low = 106.8
    } else if (phase < 6) {
      const start = 100 + (phase / 6) * 10
      const end = 100 + ((phase + 1) / 6) * 10
      open = start
      close = end
      low = phase === 0 ? 100.0 : Math.min(open, close) - 0.3
      high = Math.max(open, close) + 0.3
    } else {
      const step = phase - 6
      const start = 110 - (step / 6) * 10
      const end = 110 - ((step + 1) / 6) * 10
      open = start
      close = end
      high = step === 0 ? 110.0 : Math.max(open, close) + 0.3
      low = Math.min(open, close) - 0.3
    }

    candles.push(makeCandle(i, open, high, low, close))
  }
  return candles
}

/**
 * Deterministic 130-bar Break of Structure fixture containing:
 * - Bullish Higher-Low + BOS close above confirmed swing high at bar 62,
 *   followed by a clean non-invalidated retest at bar 64.
 * - Bearish Lower-High + BOS close below confirmed swing low at bar 104.
 */
function buildBreakOfStructureFixture(): Candle[] {
  const closes: number[] = []
  for (let i = 0; i < 125; i += 1) {
    if (i < 40) {
      closes.push(100 + Math.sin(i * 0.5) * 1.2)
    } else if (i <= 44) {
      // Swing Low L1 = 96 at i = 44
      closes.push(100 - (i - 40) * 1.0)
    } else if (i <= 50) {
      // Rally to Swing High H1 = 105 at i = 50
      closes.push(96 + ((i - 44) / 6) * 9)
    } else if (i <= 56) {
      // Pullback to Higher Swing Low L2 = 100 at i = 56 (100 > 96)
      closes.push(105 - ((i - 50) / 6) * 5)
    } else if (i <= 61) {
      // Climb below H1 (confirmed L2 at 56+2=58)
      closes.push(100 + ((i - 56) / 5) * 4.5)
    } else if (i === 62) {
      // Fresh Bullish BOS close strictly above H1 (~105.4)
      closes.push(106.8)
    } else if (i === 63) {
      // Hold above broken level
      closes.push(106.9)
    } else if (i === 64) {
      // Retest bar (low dips close to H1, close holds above H1)
      closes.push(107.1)
    } else if (i <= 74) {
      // Continue up to peak H2 = 116 at i = 74
      closes.push(107.1 + ((i - 64) / 10) * 8.9)
    } else if (i <= 84) {
      // Pullback to Swing Low L3 = 106 at i = 84
      closes.push(116 - ((i - 74) / 10) * 10)
    } else if (i <= 92) {
      // Lower Swing High H3 = 112 at i = 92 (112 < 116)
      closes.push(106 + ((i - 84) / 8) * 6)
    } else if (i <= 103) {
      // Drift down approaching L3 (H3 confirmed at 92+2=94)
      closes.push(112 - ((i - 92) / 11) * 5.6)
    } else if (i === 104) {
      // Fresh Bearish BOS close strictly below L3 (~105.6)
      closes.push(104.0)
    } else {
      closes.push(104.0 - (i - 104) * 0.25)
    }
  }

  return closes.map((close, i) => {
    const prev = i > 0 ? closes[i - 1] : close
    const open = prev + (close - prev) * 0.25
    const high = Math.max(open, close) + 0.4
    let low = Math.min(open, close) - 0.4
    if (i === 64) {
      // Explicit retest wick near H1 (~105.4)
      low = 105.55
    }
    return makeCandle(i, open, high, low, close)
  })
}

describe('Phase 1 — New Spot Engines (Donchian, Support/Resistance, Break of Structure)', () => {
  const cases: {
    engine: NewSpotEngineId
    build: () => Candle[]
  }[] = [
    { engine: 'donchian-breakout', build: buildDonchianFixture },
    { engine: 'support-resistance', build: buildSupportResistanceFixture },
    { engine: 'break-of-structure', build: buildBreakOfStructureFixture },
  ]

  it.each(cases)(
    '$engine is deterministic, enforces warmup (<55 bars), and produces both long and short signals',
    ({ engine, build }) => {
      const candles = build()

      // Warmup: strictly null before 55 bars
      for (let i = 0; i < MIN_SPOT_ENGINE_WARMUP; i += 1) {
        expect(signalAt(engine, candles, i)).toBeNull()
      }

      // Determinism: two runs produce identical signals
      const runA = generateSignals(engine, candles)
      const runB = generateSignals(engine, candles)
      expect(runA).toEqual(runB)

      const longs = runA.filter((s) => s.side === 'buy')
      const shorts = runA.filter((s) => s.side === 'sell')
      expect(longs.length).toBeGreaterThanOrEqual(1)
      expect(shorts.length).toBeGreaterThanOrEqual(1)

      for (const sig of longs) {
        const bar = candles[sig.index]
        if (sig.stopPrice !== undefined) {
          expect(sig.stopPrice).toBeLessThan(bar.close)
        }
        if (sig.targetPrice !== undefined) {
          expect(sig.targetPrice).toBeGreaterThan(bar.close)
        }
      }
      for (const sig of shorts) {
        const bar = candles[sig.index]
        if (sig.stopPrice !== undefined) {
          expect(sig.stopPrice).toBeGreaterThan(bar.close)
        }
        if (sig.targetPrice !== undefined) {
          expect(sig.targetPrice).toBeLessThan(bar.close)
        }
      }
    },
  )

  it.each(cases)(
    '$engine has zero lookahead: mutating candles after index i never changes signalAt(i)',
    ({ engine, build }) => {
      const candles = build()
      const allSignals = generateSignals(engine, candles)
      expect(allSignals.length).toBeGreaterThan(0)

      // Check both signal bars and non-signal bars
      const probeIndices = new Set<number>([
        MIN_SPOT_ENGINE_WARMUP,
        MIN_SPOT_ENGINE_WARMUP + 10,
        Math.floor(candles.length / 2),
        candles.length - 5,
        ...allSignals.slice(0, 6).map((s) => s.index),
      ])

      for (const idx of probeIndices) {
        if (idx >= candles.length - 1) continue
        const baseline = signalAt(engine, candles, idx)
        const mutated = candles.map((c, j) =>
          j > idx
            ? {
                ...c,
                open: c.open * 4,
                high: c.high * 5,
                low: c.low * 0.2,
                close: c.close * 3,
              }
            : c,
        )
        const afterMutation = signalAt(engine, mutated, idx)
        expect(afterMutation).toEqual(baseline)
      }
    },
  )

  it('Donchian channel excludes bar i and evaluateDonchianExit triggers on opposite exitPeriod break', () => {
    const candles = buildDonchianFixture()
    // Build a small tail where bar drops below prior 10-bar low
    const exitCheckIdx = 248
    const prior10Low = Math.min(
      ...candles.slice(exitCheckIdx - 10, exitCheckIdx).map((c) => c.low),
    )
    const modified = candles.map((c, i) =>
      i === exitCheckIdx ? { ...c, close: prior10Low - 0.5 } : c,
    )
    expect(evaluateDonchianExit(modified, exitCheckIdx, 'buy', { exitPeriod: 10 })).toBe(
      true,
    )
    expect(
      evaluateDonchianExit(modified, exitCheckIdx, 'sell', { exitPeriod: 10 }),
    ).toBe(false)
  })

  it('Break of Structure triggers retest entry when holding above level and invalidates on close back below broken level', () => {
    const candles = buildBreakOfStructureFixture()
    const retestSig = signalAt('break-of-structure', candles, 64, {
      requireRetest: true,
      retestWindowBars: 3,
      retestToleranceAtr: 0.8,
    })
    expect(retestSig?.side).toBe('buy')

    // Invalidate BOS by closing bar 63 strictly below H1 (~105.4)
    const invalidated = candles.map((c, i) =>
      i === 63 ? { ...c, close: 104.2, low: 104.0 } : c,
    )
    const afterInvalidation = signalAt('break-of-structure', invalidated, 64, {
      requireRetest: true,
      retestWindowBars: 3,
      retestToleranceAtr: 0.8,
    })
    expect(afterInvalidation).toBeNull()
  })
})

describe('Phase 1 — Presets, Bot Engine Delegation & Unified Strategy Registry', () => {
  it('preserves all 8 original preset IDs at indices 0..7 and wires the 3 new real presets', async () => {
    for (let i = 0; i < ORIGINAL_8_PRESET_IDS.length; i += 1) {
      expect(STRATEGY_PRESETS[i].id).toBe(ORIGINAL_8_PRESET_IDS[i])
    }

    const newIds = [
      'btc-donchian-breakout-1h',
      'eth-support-resistance-1h',
      'sol-bos-structure-15m',
    ]
    for (const id of newIds) {
      const preset = STRATEGY_PRESETS.find((p) => p.id === id)
      expect(preset).toBeDefined()
      expect(preset?.domain).toBe('crypto-spot')
    }

    // Verify new presets clamp cleanly via mergePresetPatch
    const donchianPreset = STRATEGY_PRESETS.find(
      (p) => p.id === 'btc-donchian-breakout-1h',
    )!
    const clamped = mergePresetPatch(donchianPreset, {
      filters: {
        channelPeriod: 200,
        exitPeriod: 99,
        atrStopMult: 15,
        trendFilter: 'none',
      },
    })
    expect(clamped.filters?.channelPeriod).toBe(100)
    expect(clamped.filters?.exitPeriod).toBe(60)
    expect(clamped.filters?.atrStopMult).toBe(6)
    expect(clamped.filters?.trendFilter).toBe('none')

    // Verify stepBotEngine executes a trade cleanly on a new engine fixture
    const srPreset = STRATEGY_PRESETS.find(
      (p) => p.id === 'eth-support-resistance-1h',
    )!
    const srCandles = buildSupportResistanceFixture()
    let state = createInitialBotState(srPreset)
    for (let end = 56; end <= srCandles.length; end += 1) {
      state = stepBotEngine(state, srCandles.slice(0, end), srPreset)
    }
    expect(
      state.closedTrades.length + (state.openPosition ? 1 : 0),
    ).toBeGreaterThanOrEqual(1)

    // Verify evaluateBotPresetAccuracy succeeds across all presets including new ones
    const sampleCandles = await syntheticSource.getCandles({
      pair: 'BTC/USDT',
      interval: '1h',
      limit: 240,
    })
    for (const id of newIds) {
      const preset = STRATEGY_PRESETS.find((p) => p.id === id)!
      const report = evaluateBotPresetAccuracy(sampleCandles, preset)
      expect(report.presetId).toBe(id)
      expect(report.winRatePct).toBeGreaterThanOrEqual(0)
      expect(report.winRatePct).toBeLessThanOrEqual(100)
    }
  })

  it('derives unified Training catalog from STRATEGY_PRESETS + 2 templates + custom profiles', () => {
    const catalog = buildTrainingCatalog()
    expect(catalog).toHaveLength(
      STRATEGY_PRESETS.length + ENGINE_TEMPLATES.length,
    )

    const coveredFamilies = new Set(catalog.map((item) => item.family))
    for (const fam of STRATEGY_FAMILIES) {
      expect(coveredFamilies.has(fam.id)).toBe(true)
    }

    // Verify Trend / Momentum ("Trade") includes momentum-structure + crossover template
    const trendItems = catalog.filter((i) => i.family === 'trend-momentum')
    expect(
      trendItems.some((i) => i.preset.filters?.signalEngine === 'momentum-structure'),
    ).toBe(true)
    expect(
      trendItems.some((i) => i.preset.filters?.signalEngine === 'crossover'),
    ).toBe(true)

    // Verify getStrategyFamily classification
    expect(
      getStrategyFamily(
        STRATEGY_PRESETS.find((p) => p.id === 'btc-donchian-breakout-1h')!,
      ),
    ).toBe('donchian-breakout')
    expect(
      getStrategyFamily(
        STRATEGY_PRESETS.find((p) => p.id === 'eth-support-resistance-1h')!,
      ),
    ).toBe('support-resistance')
    expect(
      getStrategyFamily(
        STRATEGY_PRESETS.find((p) => p.id === 'sol-bos-structure-15m')!,
      ),
    ).toBe('break-of-structure')
  })
})
