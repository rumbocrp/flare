import type { Candle, ChartViewport } from './types'

export const DEFAULT_VISIBLE_COUNT = 110
export const MIN_VISIBLE_COUNT = 25
export const ZOOM_PRESETS = [35, 75, 140, 240, 310] as const

export type ResolvedViewport = {
  viewStart: number
  viewEnd: number
  visibleCount: number
  navigableTotal: number
  maxStart: number
  isAtLiveEdge: boolean
}

export function createDefaultViewport(
  visibleCount: number = DEFAULT_VISIBLE_COUNT,
): ChartViewport {
  return {
    leftAnchorTime: null,
    visibleCount,
    followLive: true,
  }
}

/**
 * Resolves an absolute timestamp-anchored viewport into clamped [viewStart, viewEnd)
 * slice bounds over `candles`, never dipping into the warm-up buffer or past live.
 */
export function resolveViewportRange(
  candles: readonly Candle[],
  warmupBars: number,
  viewport: ChartViewport,
): ResolvedViewport {
  const total = candles.length
  if (total === 0) {
    return {
      viewStart: 0,
      viewEnd: 0,
      visibleCount: 0,
      navigableTotal: 0,
      maxStart: 0,
      isAtLiveEdge: true,
    }
  }

  const safeWarmup = Math.max(0, Math.min(warmupBars, Math.max(0, total - 1)))
  const navigableTotal = Math.max(1, total - safeWarmup)
  const minCount = Math.min(MIN_VISIBLE_COUNT, navigableTotal)
  const visibleCount = Math.min(
    navigableTotal,
    Math.max(minCount, Math.round(viewport.visibleCount)),
  )
  const maxStart = Math.max(safeWarmup, total - visibleCount)

  if (viewport.followLive || viewport.leftAnchorTime === null) {
    return {
      viewStart: maxStart,
      viewEnd: total,
      visibleCount: total - maxStart,
      navigableTotal,
      maxStart,
      isAtLiveEdge: true,
    }
  }

  const anchorTime = viewport.leftAnchorTime
  let anchorIdx: number
  if (anchorTime <= candles[safeWarmup].time) {
    anchorIdx = safeWarmup
  } else if (anchorTime >= candles[maxStart].time) {
    anchorIdx = maxStart
  } else {
    // Binary search for first candle with time >= anchorTime
    let lo = safeWarmup
    let hi = maxStart
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (candles[mid].time < anchorTime) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    anchorIdx = lo
  }

  const viewStart = Math.max(safeWarmup, Math.min(maxStart, anchorIdx))
  const viewEnd = Math.min(total, viewStart + visibleCount)

  return {
    viewStart,
    viewEnd,
    visibleCount: viewEnd - viewStart,
    navigableTotal,
    maxStart,
    isAtLiveEdge: viewEnd >= total,
  }
}

/**
 * Pans the viewport by `deltaBars`.
 * Positive `deltaBars` pans left into history; negative `deltaBars` pans right toward live.
 * Panning left disengages `followLive`; reaching the right edge re-engages `followLive`.
 */
export function panViewport(
  candles: readonly Candle[],
  warmupBars: number,
  viewport: ChartViewport,
  deltaBars: number,
): ChartViewport {
  if (candles.length === 0 || deltaBars === 0) return viewport
  const resolved = resolveViewportRange(candles, warmupBars, viewport)
  const safeWarmup = Math.max(0, candles.length - resolved.navigableTotal)
  const nextStart = Math.max(
    safeWarmup,
    Math.min(resolved.maxStart, resolved.viewStart - deltaBars),
  )

  if (nextStart >= resolved.maxStart) {
    return {
      leftAnchorTime: null,
      visibleCount: resolved.visibleCount,
      followLive: true,
    }
  }

  return {
    leftAnchorTime: candles[nextStart].time,
    visibleCount: resolved.visibleCount,
    followLive: false,
  }
}

/**
 * Zooms the viewport by `deltaBars` (+ zooms out / shows more bars, - zooms in),
 * keeping the bar at `anchorRatio` (0 = left edge, 1 = right edge) stable.
 */
export function zoomViewport(
  candles: readonly Candle[],
  warmupBars: number,
  viewport: ChartViewport,
  deltaBars: number,
  anchorRatio?: number,
): ChartViewport {
  if (candles.length === 0 || deltaBars === 0) return viewport
  const resolved = resolveViewportRange(candles, warmupBars, viewport)
  const safeWarmup = Math.max(0, candles.length - resolved.navigableTotal)
  const minCount = Math.min(MIN_VISIBLE_COUNT, resolved.navigableTotal)
  const nextCount = Math.min(
    resolved.navigableTotal,
    Math.max(minCount, resolved.visibleCount + deltaBars),
  )

  if (nextCount === resolved.visibleCount) return viewport

  const nextMaxStart = Math.max(safeWarmup, candles.length - nextCount)
  const effectiveAnchor = anchorRatio ?? (viewport.followLive ? 1 : 0.5)

  if (viewport.followLive && effectiveAnchor >= 0.9) {
    return {
      leftAnchorTime: null,
      visibleCount: nextCount,
      followLive: true,
    }
  }

  const anchorIndex =
    resolved.viewStart + effectiveAnchor * Math.max(0, resolved.visibleCount - 1)
  const rawNextStart = Math.round(
    anchorIndex - effectiveAnchor * Math.max(0, nextCount - 1),
  )
  const nextStart = Math.max(safeWarmup, Math.min(nextMaxStart, rawNextStart))

  if (nextStart >= nextMaxStart && (viewport.followLive || effectiveAnchor >= 0.9)) {
    return {
      leftAnchorTime: null,
      visibleCount: nextCount,
      followLive: true,
    }
  }

  return {
    leftAnchorTime: candles[nextStart].time,
    visibleCount: nextCount,
    followLive: false,
  }
}

/**
 * Applies a discrete zoom preset (35/75/140/240/310).
 * Keeps follow-live engaged when already following live or selecting "All".
 */
export function applyZoomPreset(
  candles: readonly Candle[],
  warmupBars: number,
  viewport: ChartViewport,
  presetBars: number,
): ChartViewport {
  if (candles.length === 0) {
    return { ...viewport, visibleCount: presetBars }
  }
  const resolved = resolveViewportRange(candles, warmupBars, viewport)
  const isAll = presetBars >= resolved.navigableTotal
  const targetCount = isAll ? resolved.navigableTotal : presetBars

  if (isAll || viewport.followLive) {
    return {
      leftAnchorTime: null,
      visibleCount: targetCount,
      followLive: true,
    }
  }

  const delta = targetCount - resolved.visibleCount
  return zoomViewport(candles, warmupBars, viewport, delta, 0.5)
}

/** Re-engages follow-live and anchors to the newest bar without changing zoom. */
export function jumpViewportToLive(viewport: ChartViewport): ChartViewport {
  return {
    leftAnchorTime: null,
    visibleCount: viewport.visibleCount,
    followLive: true,
  }
}

/** Jumps the viewport so `globalIndex` lands cleanly in view (~65% from left edge). */
export function jumpViewportToIndex(
  candles: readonly Candle[],
  warmupBars: number,
  viewport: ChartViewport,
  globalIndex: number,
): { viewport: ChartViewport; localIndex: number | null } {
  if (candles.length === 0) {
    return { viewport, localIndex: null }
  }
  const resolved = resolveViewportRange(candles, warmupBars, viewport)
  const safeWarmup = Math.max(0, candles.length - resolved.navigableTotal)
  const desiredStart = Math.round(globalIndex - resolved.visibleCount * 0.65)
  const nextStart = Math.max(
    safeWarmup,
    Math.min(resolved.maxStart, desiredStart),
  )
  const atLive = nextStart >= resolved.maxStart
  const nextViewport: ChartViewport = {
    leftAnchorTime: atLive ? null : candles[nextStart].time,
    visibleCount: resolved.visibleCount,
    followLive: atLive,
  }
  const localIdx = globalIndex - nextStart
  return {
    viewport: nextViewport,
    localIndex:
      localIdx >= 0 && localIdx < resolved.visibleCount ? localIdx : null,
  }
}

/**
 * Computes the true ~24h percentage change from raw candles using candle timestamps,
 * returning both the delta percentage and whether a full 24h lookback was available.
 */
export function compute24hChangePct(
  candles: readonly Candle[],
): { changePct: number; is24h: boolean } | null {
  if (candles.length < 2) return null
  const last = candles[candles.length - 1]
  if (!last || last.close <= 0) return null
  const targetTime = last.time - 86_400_000

  let refIndex = 0
  let has24h = false
  for (let i = candles.length - 2; i >= 0; i -= 1) {
    refIndex = i
    if (candles[i].time <= targetTime) {
      has24h = true
      break
    }
  }
  const refCandle = candles[refIndex]
  if (!refCandle || refCandle.close <= 0) return null
  return {
    changePct: ((last.close - refCandle.close) / refCandle.close) * 100,
    is24h: has24h,
  }
}
