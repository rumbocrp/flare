import { formatPrice } from './format'
import type { ChartDrawing, Interval } from './types'

export const DRAWINGS_V2_STORAGE_KEY = 'flare:chart-drawings-v2'
export const LEGACY_DRAWINGS_STORAGE_KEY = 'lixtrd:chart-drawings-by-pair'
export const MAX_DRAWING_HISTORY = 40
export const DRAWING_FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const

export type DrawingsByScope = Record<string, ChartDrawing[]>

export type DrawingHistoryState = {
  past: ChartDrawing[][]
  present: ChartDrawing[]
  future: ChartDrawing[][]
}

export type DrawingHitPart = 'body' | 'p1' | 'p2'

export type DrawingHit = {
  drawingId: string
  part: DrawingHitPart
}

const VALID_INTERVALS: readonly Interval[] = ['5m', '15m', '1h', '4h', '1d']
let fallbackCounter = 0

export function drawingScopeKey(pair: string, interval: Interval): string {
  return `${pair}|${interval}`
}

/** Generates a collision-free UUID for chart drawings. */
export function createDrawingId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }
  fallbackCounter += 1
  const rand = Math.random().toString(16).slice(2, 10)
  return `drw-${Date.now().toString(16)}-${fallbackCounter.toString(16)}-${rand}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isInterval(value: unknown): value is Interval {
  return (
    typeof value === 'string' &&
    VALID_INTERVALS.includes(value as Interval)
  )
}

function sanitizeDrawing(
  raw: unknown,
  fallbackPair: string,
  fallbackInterval: Interval,
  now: number,
  forceNewId = false,
): ChartDrawing | null {
  if (!isRecord(raw)) return null
  const id =
    !forceNewId && typeof raw.id === 'string' && raw.id.length > 0
      ? raw.id
      : createDrawingId()
  const pair =
    typeof raw.pair === 'string' && raw.pair.length > 0
      ? raw.pair
      : fallbackPair
  const interval = isInterval(raw.interval) ? raw.interval : fallbackInterval
  const createdAt = isFiniteNum(raw.createdAt) ? raw.createdAt : now
  const updatedAt = isFiniteNum(raw.updatedAt) ? raw.updatedAt : createdAt
  const color = typeof raw.color === 'string' ? raw.color : undefined
  const locked = typeof raw.locked === 'boolean' ? raw.locked : undefined

  if (raw.type === 'horizontal' && isFiniteNum(raw.price)) {
    const label =
      typeof raw.label === 'string' && raw.label.length > 0
        ? raw.label
        : `S/R ${formatPrice(raw.price)}`
    return {
      id,
      type: 'horizontal',
      pair,
      interval,
      createdAt,
      updatedAt,
      price: raw.price,
      label,
      ...(color ? { color } : {}),
      ...(locked !== undefined ? { locked } : {}),
    }
  }

  if (
    (raw.type === 'trendline' || raw.type === 'fib') &&
    isFiniteNum(raw.t1) &&
    isFiniteNum(raw.p1) &&
    isFiniteNum(raw.t2) &&
    isFiniteNum(raw.p2)
  ) {
    const label = typeof raw.label === 'string' ? raw.label : undefined
    return {
      id,
      type: raw.type,
      pair,
      interval,
      createdAt,
      updatedAt,
      t1: raw.t1,
      p1: raw.p1,
      t2: raw.t2,
      p2: raw.p2,
      ...(label ? { label } : {}),
      ...(color ? { color } : {}),
      ...(locked !== undefined ? { locked } : {}),
    }
  }

  return null
}

/**
 * Migrates legacy `lixtrd:chart-drawings-by-pair` entries into the pair+interval
 * scoped v2 map without modifying or removing the legacy key.
 */
export function migrateLegacyDrawings(
  legacyRaw: unknown,
  defaultInterval: Interval,
  now = Date.now(),
): DrawingsByScope {
  if (!isRecord(legacyRaw)) return {}
  const migrated: DrawingsByScope = {}
  for (const [pair, entries] of Object.entries(legacyRaw)) {
    if (!Array.isArray(entries) || entries.length === 0) continue
    const clean: ChartDrawing[] = []
    for (const item of entries) {
      const sanitized = sanitizeDrawing(item, pair, defaultInterval, now, true)
      if (sanitized) clean.push(sanitized)
    }
    if (clean.length > 0) {
      migrated[drawingScopeKey(pair, defaultInterval)] = clean
    }
  }
  return migrated
}

/**
 * Loads drawings scoped by `pair|interval` from `flare:chart-drawings-v2`,
 * migrating legacy entries once if v2 has not yet been initialized.
 */
export function loadDrawingsStore(
  defaultInterval: Interval,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof window !==
  'undefined'
    ? window.localStorage
    : null,
): DrawingsByScope {
  if (!storage) return {}
  const now = Date.now()

  try {
    const rawV2 = storage.getItem(DRAWINGS_V2_STORAGE_KEY)
    if (rawV2 !== null) {
      const parsed: unknown = JSON.parse(rawV2)
      if (isRecord(parsed)) {
        const result: DrawingsByScope = {}
        for (const [scopeKey, entries] of Object.entries(parsed)) {
          if (!Array.isArray(entries)) continue
          const [pairPart, intervalPart] = scopeKey.split('|')
          const fallbackInterval = isInterval(intervalPart)
            ? intervalPart
            : defaultInterval
          const fallbackPair = pairPart || 'BTC/USDT'
          const clean = entries
            .map((entry) =>
              sanitizeDrawing(entry, fallbackPair, fallbackInterval, now, false),
            )
            .filter((entry): entry is ChartDrawing => entry !== null)
          result[scopeKey] = clean
        }
        return result
      }
    }
  } catch {
    // Fall through to legacy migration
  }

  try {
    const rawLegacy = storage.getItem(LEGACY_DRAWINGS_STORAGE_KEY)
    if (rawLegacy !== null) {
      const parsedLegacy: unknown = JSON.parse(rawLegacy)
      const migrated = migrateLegacyDrawings(parsedLegacy, defaultInterval, now)
      try {
        storage.setItem(DRAWINGS_V2_STORAGE_KEY, JSON.stringify(migrated))
      } catch {
        // Storage write optional
      }
      return migrated
    }
  } catch {
    // Ignore malformed legacy storage
  }

  return {}
}

export function saveDrawingsStore(
  store: DrawingsByScope,
  storage: Pick<Storage, 'setItem'> | null = typeof window !== 'undefined'
    ? window.localStorage
    : null,
): void {
  if (!storage) return
  try {
    storage.setItem(DRAWINGS_V2_STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Storage unavailable or full
  }
}

export function createDrawingHistory(
  present: ChartDrawing[],
): DrawingHistoryState {
  return { past: [], present, future: [] }
}

export function pushDrawingHistory(
  state: DrawingHistoryState,
  nextPresent: ChartDrawing[],
  maxDepth = MAX_DRAWING_HISTORY,
): DrawingHistoryState {
  const nextPast = [...state.past, state.present].slice(-maxDepth)
  return {
    past: nextPast,
    present: nextPresent,
    future: [],
  }
}

export function undoDrawingHistory(
  state: DrawingHistoryState,
): DrawingHistoryState {
  if (state.past.length === 0) return state
  const previous = state.past[state.past.length - 1]
  return {
    past: state.past.slice(0, -1),
    present: previous,
    future: [state.present, ...state.future].slice(0, MAX_DRAWING_HISTORY),
  }
}

export function redoDrawingHistory(
  state: DrawingHistoryState,
): DrawingHistoryState {
  if (state.future.length === 0) return state
  const next = state.future[0]
  return {
    past: [...state.past, state.present].slice(-MAX_DRAWING_HISTORY),
    present: next,
    future: state.future.slice(1),
  }
}

export function pointToSegmentDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq <= 1e-6) return Math.hypot(px - x1, py - y1)
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq))
  const projX = x1 + t * dx
  const projY = y1 + t * dy
  return Math.hypot(px - projX, py - projY)
}

export type HitTestProjectors = {
  xOfTime: (timestamp: number) => number | null
  yOfPrice: (price: number) => number
  plotLeft: number
  plotRight: number
  plotTop: number
  plotBottom: number
}

/**
 * Hit-tests drawings at `(px, py)` in SVG pixel space.
 * Checks handles of the currently selected drawing first, then bodies in
 * reverse Z-order so empty canvas clicks return `null` and never steal pan/zoom.
 */
export function hitTestDrawings(
  drawings: readonly ChartDrawing[],
  px: number,
  py: number,
  proj: HitTestProjectors,
  selectedId: string | null,
  hitRadius = 8,
  handleRadius = 11,
): DrawingHit | null {
  if (
    px < proj.plotLeft - handleRadius ||
    px > proj.plotRight + handleRadius ||
    py < proj.plotTop - handleRadius ||
    py > proj.plotBottom + handleRadius
  ) {
    return null
  }

  // 1. Check handles of currently selected drawing first for precision resize
  if (selectedId) {
    const sel = drawings.find((d) => d.id === selectedId)
    if (sel && !sel.locked) {
      if (sel.type === 'trendline' || sel.type === 'fib') {
        const x1 = proj.xOfTime(sel.t1)
        const x2 = proj.xOfTime(sel.t2)
        if (x1 !== null && x2 !== null) {
          const y1 = proj.yOfPrice(sel.p1)
          const y2 = proj.yOfPrice(sel.p2)
          if (Math.hypot(px - x1, py - y1) <= handleRadius) {
            return { drawingId: sel.id, part: 'p1' }
          }
          if (Math.hypot(px - x2, py - y2) <= handleRadius) {
            return { drawingId: sel.id, part: 'p2' }
          }
        }
      } else if (sel.type === 'horizontal') {
        const y = proj.yOfPrice(sel.price)
        if (
          y >= proj.plotTop - hitRadius &&
          y <= proj.plotBottom + hitRadius &&
          Math.abs(py - y) <= handleRadius
        ) {
          return { drawingId: sel.id, part: 'body' }
        }
      }
    }
  }

  // 2. Check all drawings top-to-bottom (reverse array order)
  for (let i = drawings.length - 1; i >= 0; i -= 1) {
    const d = drawings[i]
    if (d.type === 'horizontal') {
      const y = proj.yOfPrice(d.price)
      if (
        y >= proj.plotTop - hitRadius &&
        y <= proj.plotBottom + hitRadius &&
        px >= proj.plotLeft &&
        px <= proj.plotRight &&
        Math.abs(py - y) <= hitRadius
      ) {
        return { drawingId: d.id, part: 'body' }
      }
      continue
    }

    const x1 = proj.xOfTime(d.t1)
    const x2 = proj.xOfTime(d.t2)
    if (x1 === null || x2 === null) continue
    if (Math.max(x1, x2) < proj.plotLeft || Math.min(x1, x2) > proj.plotRight) {
      continue
    }
    const y1 = proj.yOfPrice(d.p1)
    const y2 = proj.yOfPrice(d.p2)

    if (d.type === 'trendline') {
      if (Math.hypot(px - x1, py - y1) <= handleRadius) {
        return { drawingId: d.id, part: 'p1' }
      }
      if (Math.hypot(px - x2, py - y2) <= handleRadius) {
        return { drawingId: d.id, part: 'p2' }
      }
      if (pointToSegmentDistance(px, py, x1, y1, x2, y2) <= hitRadius) {
        return { drawingId: d.id, part: 'body' }
      }
      continue
    }

    if (d.type === 'fib') {
      if (Math.hypot(px - x1, py - y1) <= handleRadius) {
        return { drawingId: d.id, part: 'p1' }
      }
      if (Math.hypot(px - x2, py - y2) <= handleRadius) {
        return { drawingId: d.id, part: 'p2' }
      }
      const leftX = Math.max(proj.plotLeft, Math.min(x1, x2))
      const rightX = Math.min(
        proj.plotRight,
        Math.max(x1, x2, leftX + 75),
      )
      if (pointToSegmentDistance(px, py, x1, y1, x2, y2) <= hitRadius) {
        return { drawingId: d.id, part: 'body' }
      }
      if (px >= leftX - hitRadius && px <= rightX + hitRadius) {
        for (const lvl of DRAWING_FIB_LEVELS) {
          const levelY = proj.yOfPrice(d.p1 + (d.p2 - d.p1) * lvl)
          if (
            levelY >= proj.plotTop - hitRadius &&
            levelY <= proj.plotBottom + hitRadius &&
            Math.abs(py - levelY) <= hitRadius
          ) {
            return { drawingId: d.id, part: 'body' }
          }
        }
      }
    }
  }

  return null
}

export type DrawingDragParams = {
  origin: ChartDrawing
  part: DrawingHitPart
  startTime: number
  startPrice: number
  currentTime: number
  currentPrice: number
  now?: number
}

/** Computes updated drawing geometry for a move (`body`) or handle resize (`p1`/`p2`). */
export function applyDrawingDrag({
  origin,
  part,
  startTime,
  startPrice,
  currentTime,
  currentPrice,
  now = Date.now(),
}: DrawingDragParams): ChartDrawing {
  if (origin.locked) return origin

  if (origin.type === 'horizontal') {
    const nextPrice = Math.max(1e-8, currentPrice)
    const isDefaultLabel = origin.label.startsWith('S/R ')
    return {
      ...origin,
      price: nextPrice,
      label: isDefaultLabel ? `S/R ${formatPrice(nextPrice)}` : origin.label,
      updatedAt: now,
    }
  }

  if (part === 'p1') {
    return {
      ...origin,
      t1: currentTime,
      p1: Math.max(1e-8, currentPrice),
      updatedAt: now,
    }
  }

  if (part === 'p2') {
    return {
      ...origin,
      t2: currentTime,
      p2: Math.max(1e-8, currentPrice),
      updatedAt: now,
    }
  }

  const dt = currentTime - startTime
  const dp = currentPrice - startPrice
  return {
    ...origin,
    t1: origin.t1 + dt,
    t2: origin.t2 + dt,
    p1: Math.max(1e-8, origin.p1 + dp),
    p2: Math.max(1e-8, origin.p2 + dp),
    updatedAt: now,
  }
}
