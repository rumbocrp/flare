/**
 * Lightweight pub/sub channel for sharing crosshair bar index across
 * CandleChart, RsiPanel, and MacdPanel without triggering re-renders on
 * the parent MarketAnalysis workspace (header, tooltips, left rail, sidebar).
 */
export type CrosshairChannel = {
  get: () => number | null
  set: (next: number | null) => void
  subscribe: (listener: () => void) => () => void
}

export function createCrosshairChannel(): CrosshairChannel {
  let current: number | null = null
  const listeners = new Set<() => void>()

  return {
    get: () => current,
    set: (next: number | null) => {
      if (next === current) return
      current = next
      for (const listener of listeners) {
        listener()
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * Imperative pub/sub channel for syncing sub-pixel GPU `translate3d` pan
 * offsets across CandleChart, RsiPanel, and MacdPanel at 120fps with zero
 * React state updates or re-renders during drag/scroll gestures.
 */
export type PanTransformChannel = {
  get: () => number
  set: (offsetPx: number) => void
  subscribe: (listener: (offsetPx: number) => void) => () => void
}

export function createPanTransformChannel(): PanTransformChannel {
  let current = 0
  const listeners = new Set<(offsetPx: number) => void>()

  return {
    get: () => current,
    set: (offsetPx: number) => {
      const normalized = Math.abs(offsetPx) < 0.05 ? 0 : offsetPx
      if (Math.abs(normalized - current) < 0.02) return
      current = normalized
      for (const listener of listeners) {
        listener(normalized)
      }
    },
    subscribe: (listener: (offsetPx: number) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
