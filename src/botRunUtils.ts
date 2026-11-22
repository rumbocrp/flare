import type {
  ExchangeOrderRecord,
  RuntimeEventRecord,
} from './api/botClient'
import type { BacktestTrade } from './backtest'
import { intervalMs } from './market/intervals'
import type { Interval } from './types'

export const BOTRUN_SECTIONS_STORAGE_KEY = 'flare:botrun-sections'

export type BotRunSectionId =
  | 'account'
  | 'positions'
  | 'orders'
  | 'risk'
  | 'mt5'
  | 'audit'
  | 'events'
  | 'trades'

export type BotRunSectionState = Record<BotRunSectionId, boolean>

export const DEFAULT_BOTRUN_SECTIONS: BotRunSectionState = {
  account: true,
  positions: true,
  orders: true,
  risk: true,
  mt5: true,
  audit: true,
  events: true,
  trades: true,
}

export function loadBotRunSectionState(): BotRunSectionState {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return { ...DEFAULT_BOTRUN_SECTIONS }
    }
    const raw = window.localStorage.getItem(BOTRUN_SECTIONS_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_BOTRUN_SECTIONS }
    const parsed = JSON.parse(raw) as Partial<Record<BotRunSectionId, unknown>>
    const next = { ...DEFAULT_BOTRUN_SECTIONS }
    for (const key of Object.keys(DEFAULT_BOTRUN_SECTIONS) as BotRunSectionId[]) {
      if (typeof parsed[key] === 'boolean') {
        next[key] = parsed[key]
      }
    }
    return next
  } catch {
    return { ...DEFAULT_BOTRUN_SECTIONS }
  }
}

export function saveBotRunSectionState(state: BotRunSectionState): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(BOTRUN_SECTIONS_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Ignore storage errors
  }
}

export function formatUtcTimestamp(isoOrMs: string | number | null | undefined): string {
  if (isoOrMs === null || isoOrMs === undefined) return '—'
  const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs)
  if (Number.isNaN(d.getTime())) return String(isoOrMs)
  return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

export function formatShortUtcDate(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) {
    return '—'
  }
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

export function formatRelativeAge(
  updatedAtIso: string | number | null | undefined,
  nowMs: number,
  isEs = false,
): string {
  if (updatedAtIso === null || updatedAtIso === undefined) {
    return isEs ? 'sin datos aún' : 'no data yet'
  }
  const ts =
    typeof updatedAtIso === 'number' ? updatedAtIso : Date.parse(updatedAtIso)
  if (!Number.isFinite(ts)) {
    return isEs ? 'sin datos aún' : 'no data yet'
  }
  const sec = Math.max(0, Math.floor((nowMs - ts) / 1000))
  if (sec < 60) {
    return isEs ? `hace ${sec}s` : `updated ${sec}s ago`
  }
  const min = Math.floor(sec / 60)
  if (min < 60) {
    return isEs ? `hace ${min}m` : `updated ${min}m ago`
  }
  const hr = Math.floor(min / 60)
  if (hr < 24) {
    return isEs ? `hace ${hr}h` : `updated ${hr}h ago`
  }
  const days = Math.floor(hr / 24)
  return isEs ? `hace ${days}d` : `updated ${days}d ago`
}

export function isTimestampStale(
  updatedAtIso: string | number | null | undefined,
  expectedIntervalMs: number,
  nowMs: number,
): boolean {
  if (updatedAtIso === null || updatedAtIso === undefined) return false
  const ts =
    typeof updatedAtIso === 'number' ? updatedAtIso : Date.parse(updatedAtIso)
  if (!Number.isFinite(ts)) return false
  return nowMs - ts > expectedIntervalMs * 2
}

export function isAuditWindowStale(
  toTimeMs: number,
  timeframe: Interval,
  nowMs: number,
): boolean {
  if (!Number.isFinite(toTimeMs) || toTimeMs <= 0) return false
  const stepMs = intervalMs[timeframe]
  return nowMs - toTimeMs > stepMs * 2
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  if (hr < 24) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`
  const days = Math.floor(hr / 24)
  const remHr = hr % 24
  return remHr > 0 ? `${days}d ${remHr}h` : `${days}d`
}

export function computeTradeRMultiple(
  trade: BacktestTrade,
  fallbackStopLossPct?: number,
): number | null {
  if (!Number.isFinite(trade.entryPrice) || trade.entryPrice <= 0) return null
  if (!Number.isFinite(trade.size) || trade.size <= 0) return null
  let riskUsd: number | null = null
  if (
    typeof trade.initialStopPrice === 'number' &&
    Number.isFinite(trade.initialStopPrice) &&
    trade.initialStopPrice > 0
  ) {
    const stopDistPct =
      Math.abs(trade.entryPrice - trade.initialStopPrice) / trade.entryPrice
    if (stopDistPct > 0) {
      riskUsd = trade.size * stopDistPct
    }
  } else if (
    typeof fallbackStopLossPct === 'number' &&
    Number.isFinite(fallbackStopLossPct) &&
    fallbackStopLossPct > 0
  ) {
    riskUsd = trade.size * (fallbackStopLossPct / 100)
  }
  if (riskUsd === null || riskUsd <= 0) return null
  return Number((trade.pnl / riskUsd).toFixed(2))
}

export type ClosedTradesSummary = {
  count: number
  wins: number
  losses: number
  totalPnlUsd: number
  winRatePct: number | null
  avgR: number | null
  profitFactor: number | null
  totalFeesUsd: number
}

export function computeClosedTradesSummary(
  trades: readonly BacktestTrade[],
  fallbackStopLossPct?: number,
): ClosedTradesSummary {
  if (trades.length === 0) {
    return {
      count: 0,
      wins: 0,
      losses: 0,
      totalPnlUsd: 0,
      winRatePct: null,
      avgR: null,
      profitFactor: null,
      totalFeesUsd: 0,
    }
  }
  let wins = 0
  let losses = 0
  let totalPnlUsd = 0
  let grossWin = 0
  let grossLoss = 0
  let totalFeesUsd = 0
  let rSum = 0
  let rCount = 0

  for (const t of trades) {
    totalPnlUsd += t.pnl
    totalFeesUsd += t.fees ?? 0
    if (t.pnl > 0) {
      wins += 1
      grossWin += t.pnl
    } else if (t.pnl < 0) {
      losses += 1
      grossLoss += Math.abs(t.pnl)
    }
    const r = computeTradeRMultiple(t, fallbackStopLossPct)
    if (r !== null) {
      rSum += r
      rCount += 1
    }
  }

  return {
    count: trades.length,
    wins,
    losses,
    totalPnlUsd: Number(totalPnlUsd.toFixed(2)),
    winRatePct: Number(((wins / trades.length) * 100).toFixed(1)),
    avgR: rCount > 0 ? Number((rSum / rCount).toFixed(2)) : null,
    profitFactor:
      grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : null,
    totalFeesUsd: Number(totalFeesUsd.toFixed(2)),
  }
}

export function computeVirtualWindow(params: {
  totalItems: number
  scrollTop: number
  viewportHeight: number
  rowHeight: number
  overscan?: number
}): {
  startIndex: number
  endIndex: number
  totalHeight: number
  offsetTop: number
} {
  const { totalItems, scrollTop, viewportHeight, rowHeight } = params
  const overscan = params.overscan ?? 6
  if (totalItems <= 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: 0, totalHeight: 0, offsetTop: 0 }
  }
  const safeScrollTop = Math.max(0, scrollTop)
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight))
  const rawStart = Math.floor(safeScrollTop / rowHeight)
  const startIndex = Math.max(0, rawStart - overscan)
  const endIndex = Math.min(totalItems, rawStart + visibleCount + overscan)
  return {
    startIndex,
    endIndex,
    totalHeight: totalItems * rowHeight,
    offsetTop: startIndex * rowHeight,
  }
}

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

export function buildCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(escapeCsvCell).join(',')]
  for (const row of rows) {
    lines.push(row.map(escapeCsvCell).join(','))
  }
  return lines.join('\r\n')
}

export function buildEventsCsv(events: readonly RuntimeEventRecord[]): string {
  return buildCsv(
    [
      'id',
      'timestamp',
      'type',
      'severity',
      'source',
      'correlation_id',
      'message',
    ],
    events.map((e) => [
      e.id,
      e.timestamp,
      e.type,
      e.severity,
      e.source,
      e.correlationId ?? '',
      e.message,
    ]),
  )
}

export function buildClosedTradesCsv(
  trades: readonly BacktestTrade[],
  fallbackPresetName?: string,
  fallbackStopLossPct?: number,
): string {
  return buildCsv(
    [
      'id',
      'entry_time',
      'exit_time',
      'duration',
      'pair',
      'side',
      'size_usd',
      'entry_price',
      'exit_price',
      'fees_usd',
      'pnl_usd',
      'r_multiple',
      'exit_reason',
      'strategy_preset',
    ],
    trades.map((t) => [
      t.id,
      new Date(t.entryTime).toISOString(),
      new Date(t.exitTime).toISOString(),
      formatDurationMs(t.exitTime - t.entryTime),
      t.pair,
      t.side.toUpperCase(),
      t.size.toFixed(2),
      t.entryPrice.toFixed(2),
      t.exitPrice.toFixed(2),
      t.fees.toFixed(4),
      t.pnl.toFixed(2),
      computeTradeRMultiple(t, fallbackStopLossPct) ?? '',
      t.exitReason,
      t.presetName ?? fallbackPresetName ?? '',
    ]),
  )
}

export function buildOrdersCsv(orders: readonly ExchangeOrderRecord[]): string {
  return buildCsv(
    [
      'id',
      'timestamp',
      'source',
      'mode',
      'pair',
      'side',
      'notional_usd',
      'quantity',
      'filled_qty',
      'avg_price',
      'fee',
      'fee_asset',
      'status',
      'venue_order_id',
      'client_order_id',
      'reason',
    ],
    orders.map((o) => [
      o.id,
      o.timestamp,
      o.source,
      o.mode,
      o.pair,
      o.side,
      o.notionalUsd.toFixed(2),
      o.quantity,
      o.filledQty ?? '',
      o.avgPrice ?? o.price,
      o.fee ?? '',
      o.feeAsset ?? '',
      o.status,
      o.venueOrderId ?? '',
      o.clientOrderId ?? '',
      o.reason ?? '',
    ]),
  )
}

export function downloadTextFile(
  filename: string,
  content: string,
  mimeType = 'text/csv;charset=utf-8;',
): void {
  if (typeof document === 'undefined') return
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export type HardLimitsValidationErrors = {
  maxOrderNotionalUsd?: string
  maxDailyOrders?: string
  maxDailyLossUsd?: string
}

export function validateHardLimitsDraft(draft: {
  maxOrderNotionalUsd: string
  maxDailyOrders: string
  maxDailyLossUsd: string
}): HardLimitsValidationErrors {
  const errors: HardLimitsValidationErrors = {}
  const cap = Number(draft.maxOrderNotionalUsd.trim())
  if (
    draft.maxOrderNotionalUsd.trim() === '' ||
    !Number.isFinite(cap) ||
    cap < 10 ||
    cap > 100_000
  ) {
    errors.maxOrderNotionalUsd = 'Must be between $10 and $100,000 USD.'
  }

  const dailyOrders = Number(draft.maxDailyOrders.trim())
  if (
    draft.maxDailyOrders.trim() === '' ||
    !Number.isFinite(dailyOrders) ||
    !Number.isInteger(dailyOrders) ||
    dailyOrders < 1 ||
    dailyOrders > 500
  ) {
    errors.maxDailyOrders = 'Must be a whole number between 1 and 500.'
  }

  const dailyLoss = Number(draft.maxDailyLossUsd.trim())
  if (
    draft.maxDailyLossUsd.trim() === '' ||
    !Number.isFinite(dailyLoss) ||
    dailyLoss < 10 ||
    dailyLoss > 250_000
  ) {
    errors.maxDailyLossUsd = 'Must be between $10 and $250,000 USD.'
  }

  return errors
}

export type StrategyParamsValidationErrors = {
  positionSize?: string
  stopLoss?: string
  takeProfit?: string
  maxDailyRisk?: string
}

export function validateStrategyParamsDraft(draft: {
  positionSize: string
  stopLoss: string
  takeProfit: string
  maxDailyRisk: string
}): StrategyParamsValidationErrors {
  const errors: StrategyParamsValidationErrors = {}
  const check = (raw: string, min: number, max: number) => {
    const n = Number(raw.trim())
    if (raw.trim() === '' || !Number.isFinite(n) || n < min || n > max) {
      return `Must be between ${min}% and ${max}%.`
    }
    return undefined
  }
  errors.positionSize = check(draft.positionSize, 0.1, 100)
  errors.stopLoss = check(draft.stopLoss, 0.1, 50)
  errors.takeProfit = check(draft.takeProfit, 0.1, 100)
  errors.maxDailyRisk = check(draft.maxDailyRisk, 0.1, 100)
  return errors
}
