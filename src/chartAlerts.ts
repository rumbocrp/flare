import { createDrawingId } from './chartDrawings'
import type { ChartAlert, ChartAlertDirection, Interval } from './types'

export const CHART_ALERTS_STORAGE_KEY = 'flare:chart-alerts'

const VALID_INTERVALS: readonly Interval[] = ['5m', '15m', '1h', '4h', '1d']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isInterval(value: unknown): value is Interval {
  return (
    typeof value === 'string' && VALID_INTERVALS.includes(value as Interval)
  )
}

function sanitizeAlert(raw: unknown, now: number): ChartAlert | null {
  if (!isRecord(raw)) return null
  if (typeof raw.pair !== 'string' || raw.pair.length === 0) return null
  if (!isFinitePositive(raw.price)) return null
  if (raw.direction !== 'above' && raw.direction !== 'below') return null

  const id =
    typeof raw.id === 'string' && raw.id.length > 0
      ? raw.id
      : createDrawingId()
  const interval = isInterval(raw.interval) ? raw.interval : '15m'
  const createdAt =
    typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
      ? raw.createdAt
      : now
  const triggeredAt =
    typeof raw.triggeredAt === 'number' && Number.isFinite(raw.triggeredAt)
      ? raw.triggeredAt
      : undefined
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : true
  const note =
    typeof raw.note === 'string' && raw.note.trim().length > 0
      ? raw.note.trim().slice(0, 120)
      : undefined

  return {
    id,
    pair: raw.pair,
    interval,
    price: raw.price,
    direction: raw.direction,
    createdAt,
    ...(triggeredAt !== undefined ? { triggeredAt } : {}),
    enabled,
    ...(note ? { note } : {}),
  }
}

export function loadChartAlerts(
  storage: Pick<Storage, 'getItem'> | null = typeof window !== 'undefined'
    ? window.localStorage
    : null,
): ChartAlert[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(CHART_ALERTS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const now = Date.now()
    return parsed
      .map((item) => sanitizeAlert(item, now))
      .filter((item): item is ChartAlert => item !== null)
  } catch {
    return []
  }
}

export function saveChartAlerts(
  alerts: readonly ChartAlert[],
  storage: Pick<Storage, 'setItem'> | null = typeof window !== 'undefined'
    ? window.localStorage
    : null,
): void {
  if (!storage) return
  try {
    storage.setItem(CHART_ALERTS_STORAGE_KEY, JSON.stringify(alerts))
  } catch {
    // Storage unavailable or full
  }
}

export function inferAlertDirection(
  targetPrice: number,
  livePrice: number | null,
): ChartAlertDirection {
  if (livePrice === null || !Number.isFinite(livePrice)) return 'above'
  return targetPrice >= livePrice ? 'above' : 'below'
}

export function createChartAlert(params: {
  pair: string
  interval: Interval
  price: number
  livePrice: number | null
  direction?: ChartAlertDirection
  note?: string
  now?: number
}): ChartAlert {
  const now = params.now ?? Date.now()
  const direction =
    params.direction ?? inferAlertDirection(params.price, params.livePrice)
  const trimmedNote = params.note?.trim().slice(0, 120)
  return {
    id: createDrawingId(),
    pair: params.pair,
    interval: params.interval,
    price: Math.max(1e-8, params.price),
    direction,
    createdAt: now,
    enabled: true,
    ...(trimmedNote ? { note: trimmedNote } : {}),
  }
}

export type AlertEvaluationResult = {
  nextAlerts: ChartAlert[]
  newlyTriggered: ChartAlert[]
}

/**
 * Evaluates armed client-only alerts for `pair` against live spot price
 * (not candle close). Each alert triggers once until explicitly re-armed.
 */
export function evaluateAlerts(
  alerts: readonly ChartAlert[],
  pair: string,
  livePrice: number | null,
  now = Date.now(),
): AlertEvaluationResult {
  if (
    livePrice === null ||
    !Number.isFinite(livePrice) ||
    alerts.length === 0
  ) {
    return { nextAlerts: alerts as ChartAlert[], newlyTriggered: [] }
  }

  let changed = false
  const newlyTriggered: ChartAlert[] = []
  const nextAlerts = alerts.map((alert) => {
    if (
      !alert.enabled ||
      alert.triggeredAt !== undefined ||
      alert.pair !== pair
    ) {
      return alert
    }
    const crossed =
      alert.direction === 'above'
        ? livePrice >= alert.price
        : livePrice <= alert.price
    if (!crossed) return alert
    changed = true
    const fired: ChartAlert = { ...alert, triggeredAt: now }
    newlyTriggered.push(fired)
    return fired
  })

  return {
    nextAlerts: changed ? nextAlerts : (alerts as ChartAlert[]),
    newlyTriggered,
  }
}

export function toggleAlertEnabled(
  alerts: readonly ChartAlert[],
  id: string,
): ChartAlert[] {
  return alerts.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a))
}

export function rearmAlert(
  alerts: readonly ChartAlert[],
  id: string,
): ChartAlert[] {
  return alerts.map((a) => {
    if (a.id !== id) return a
    const rest = { ...a }
    delete rest.triggeredAt
    return { ...rest, enabled: true }
  })
}

export function removeAlert(
  alerts: readonly ChartAlert[],
  id: string,
): ChartAlert[] {
  return alerts.filter((a) => a.id !== id)
}
