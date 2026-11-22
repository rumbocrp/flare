import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PANE_HEIGHT,
  MIN_PANE_HEIGHT,
  clampPaneHeight,
  createDefaultPanes,
  normalizeChartPanes,
  sanitizeMacdSettings,
  sanitizeRsiSettings,
} from './chartPanes'

describe('chartPanes', () => {
  it('migrates legacy prefs without panes array cleanly', () => {
    const panes = normalizeChartPanes(undefined, true, true)
    expect(panes).toHaveLength(2)
    expect(panes[0].kind).toBe('rsi')
    expect(panes[0].visible).toBe(true)
    expect(panes[1].kind).toBe('macd')
    expect(panes[1].visible).toBe(true)
  })

  it('clamps pane height between MIN_PANE_HEIGHT and 40% while preserving main chart minimum', () => {
    // At 514px stack height, 40% is 205px; main chart budget with 1 pane is 514 - 200 - 8 = 306px
    expect(clampPaneHeight(40, 514, 0, 1)).toBe(MIN_PANE_HEIGHT)
    expect(clampPaneHeight(350, 514, 0, 1)).toBe(205)

    // With another pane already taking 180px on a 460px stack, main chart budget = 460 - 200 - 180 - 16 = 64 -> clamped at MIN_PANE_HEIGHT
    expect(clampPaneHeight(220, 460, 180, 2)).toBe(MIN_PANE_HEIGHT)

    // Within valid range passes through cleanly
    expect(clampPaneHeight(140, 620, 0, 1)).toBe(140)
  })

  it('sanitizes RSI settings within valid display bounds', () => {
    expect(sanitizeRsiSettings({ period: 1, overbought: 120, oversold: 1 })).toEqual({
      period: 2,
      overbought: 95,
      oversold: 5,
    })
    expect(sanitizeRsiSettings({ period: 21, overbought: 65, oversold: 35 })).toEqual({
      period: 21,
      overbought: 65,
      oversold: 35,
    })
  })

  it('sanitizes MACD settings so slowPeriod always stays strictly above fastPeriod', () => {
    const sanitized = sanitizeMacdSettings({
      fastPeriod: 20,
      slowPeriod: 15,
      signalPeriod: 9,
    })
    expect(sanitized.fastPeriod).toBe(20)
    expect(sanitized.slowPeriod).toBe(21)
    expect(sanitized.signalPeriod).toBe(9)
  })

  it('creates defaults with RSI visible and MACD hidden at DEFAULT_PANE_HEIGHT', () => {
    const defaults = createDefaultPanes()
    expect(defaults[0].height).toBe(DEFAULT_PANE_HEIGHT)
    expect(defaults[0].visible).toBe(true)
    expect(defaults[1].visible).toBe(false)
  })
})
