import { describe, expect, it } from 'vitest'
import {
  applyZoomPreset,
  compute24hChangePct,
  createDefaultViewport,
  jumpViewportToIndex,
  jumpViewportToLive,
  panViewport,
  resolveViewportRange,
  zoomViewport,
} from './chartViewport'
import { mergeLiveCandle } from './market/liveStream'
import type { Candle } from './types'

function makeCandles(count: number, startTime = 1_700_000_000_000, stepMs = 900_000): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: startTime + i * stepMs,
    open: 100 + i * 0.1,
    high: 101 + i * 0.1,
    low: 99 + i * 0.1,
    close: 100.5 + i * 0.1,
    volume: 10 + i,
  }))
}

describe('chartViewport', () => {
  it('tracks the live edge by default when followLive is true', () => {
    const candles = makeCandles(360)
    const vp = createDefaultViewport(110)
    const resolved = resolveViewportRange(candles, 50, vp)
    expect(resolved.viewStart).toBe(250)
    expect(resolved.viewEnd).toBe(360)
    expect(resolved.visibleCount).toBe(110)
    expect(resolved.isAtLiveEdge).toBe(true)
  })

  it('does not drift when new live candles arrive while followLive is false (including ring-buffer eviction)', () => {
    const initial = makeCandles(360)
    const panned = panViewport(initial, 50, createDefaultViewport(100), 40)
    expect(panned.followLive).toBe(false)

    const before = resolveViewportRange(initial, 50, panned)
    const anchoredStartTime = initial[before.viewStart].time
    const anchoredEndTime = initial[before.viewEnd - 1].time

    // Append 3 new candles via mergeLiveCandle with maxLimit = 360 (evicts 3 oldest)
    let updated = initial
    for (let k = 1; k <= 3; k += 1) {
      const last = updated[updated.length - 1]
      updated = mergeLiveCandle(
        updated,
        {
          time: last.time + 900_000,
          open: last.close,
          high: last.close + 1,
          low: last.close - 1,
          close: last.close + 0.5,
          volume: 42,
        },
        360,
      )
    }

    const after = resolveViewportRange(updated, 50, panned)
    expect(updated[after.viewStart].time).toBe(anchoredStartTime)
    expect(updated[after.viewEnd - 1].time).toBe(anchoredEndTime)
    expect(after.visibleCount).toBe(100)
  })

  it('re-engages followLive on jumpViewportToLive or panning to live edge', () => {
    const candles = makeCandles(360)
    const panned = panViewport(candles, 50, createDefaultViewport(110), 25)
    expect(panned.followLive).toBe(false)

    const jumped = jumpViewportToLive(panned)
    expect(jumped.followLive).toBe(true)
    expect(jumped.leftAnchorTime).toBeNull()
    expect(jumped.visibleCount).toBe(110)

    const pannedBackToEdge = panViewport(candles, 50, panned, -30)
    expect(pannedBackToEdge.followLive).toBe(true)
    expect(pannedBackToEdge.leftAnchorTime).toBeNull()
  })

  it('clamps panning cleanly at warmupBars and live edge', () => {
    const candles = makeCandles(360)
    const farLeft = panViewport(candles, 50, createDefaultViewport(110), 9999)
    const resolvedLeft = resolveViewportRange(candles, 50, farLeft)
    expect(resolvedLeft.viewStart).toBe(50)
    expect(resolvedLeft.viewEnd).toBe(160)

    const farRight = panViewport(candles, 50, farLeft, -9999)
    const resolvedRight = resolveViewportRange(candles, 50, farRight)
    expect(farRight.followLive).toBe(true)
    expect(resolvedRight.viewEnd).toBe(360)
  })

  it('keeps the cursor-anchored bar stable when zooming in or out', () => {
    const candles = makeCandles(360)
    const panned = panViewport(candles, 50, createDefaultViewport(100), 60)
    const before = resolveViewportRange(candles, 50, panned)
    const anchorRatio = 0.5
    const anchorBarBefore = Math.round(
      before.viewStart + anchorRatio * (before.visibleCount - 1),
    )

    const zoomedIn = zoomViewport(candles, 50, panned, -20, anchorRatio)
    const after = resolveViewportRange(candles, 50, zoomedIn)
    const anchorBarAfter = Math.round(
      after.viewStart + anchorRatio * (after.visibleCount - 1),
    )

    expect(after.visibleCount).toBe(80)
    expect(Math.abs(anchorBarAfter - anchorBarBefore)).toBeLessThanOrEqual(1)
    expect(zoomedIn.followLive).toBe(false)
  })

  it('preserves followLive when applying zoom presets from live mode', () => {
    const candles = makeCandles(360)
    const vp = applyZoomPreset(candles, 50, createDefaultViewport(110), 75)
    expect(vp.followLive).toBe(true)
    expect(vp.visibleCount).toBe(75)
    const resolved = resolveViewportRange(candles, 50, vp)
    expect(resolved.viewEnd).toBe(360)
    expect(resolved.viewStart).toBe(285)
  })

  it('jumps to a signal bar and disengages followLive when historical', () => {
    const candles = makeCandles(360)
    const { viewport, localIndex } = jumpViewportToIndex(
      candles,
      50,
      createDefaultViewport(100),
      150,
    )
    expect(viewport.followLive).toBe(false)
    expect(localIndex).not.toBeNull()
    const resolved = resolveViewportRange(candles, 50, viewport)
    expect(resolved.viewStart + (localIndex ?? 0)).toBe(150)
  })

  it('computes accurate 24h change using candle timestamps across intervals', () => {
    // 15m bars: 96 bars = 24h
    const bars15m = makeCandles(120, 1_700_000_000_000, 900_000)
    bars15m[23].close = 100
    bars15m[119].close = 110
    const res = compute24hChangePct(bars15m)
    expect(res).not.toBeNull()
    expect(res?.is24h).toBe(true)
    expect(res?.changePct).toBeCloseTo(10, 5)
  })
})
