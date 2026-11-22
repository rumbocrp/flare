import { describe, expect, it } from 'vitest'
import type { ExchangeOrderRecord, RuntimeEventRecord } from './api/botClient'
import type { BacktestTrade } from './backtest'
import {
  BOTRUN_SECTIONS_STORAGE_KEY,
  buildClosedTradesCsv,
  buildCsv,
  buildEventsCsv,
  buildOrdersCsv,
  computeClosedTradesSummary,
  computeTradeRMultiple,
  computeVirtualWindow,
  DEFAULT_BOTRUN_SECTIONS,
  formatDurationMs,
  formatRelativeAge,
  formatShortUtcDate,
  formatUtcTimestamp,
  isAuditWindowStale,
  isTimestampStale,
  loadBotRunSectionState,
  saveBotRunSectionState,
  validateHardLimitsDraft,
  validateStrategyParamsDraft,
} from './botRunUtils'

function makeTrade(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    id: 1,
    pair: 'BTC/USDT',
    side: 'buy',
    entryPrice: 60000,
    exitPrice: 61200,
    size: 1000,
    time: '2026-05-01 11:30',
    pnl: 18,
    grossPnl: 20,
    fees: 2,
    entryTime: Date.UTC(2026, 4, 1, 10, 0, 0),
    exitTime: Date.UTC(2026, 4, 1, 11, 30, 0),
    exitReason: 'target',
    balanceAfter: 1018,
    initialStopPrice: 59400, // 1% stop = $10 risk -> +1.8R
    presetName: 'Trend Rider',
    ...overrides,
  }
}

describe('botRunUtils', () => {
  it('persists and loads collapsible section state safely', () => {
    const store = new Map<string, string>()
    const mockStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    }
    const prevWindow = globalThis.window
    Object.defineProperty(globalThis, 'window', {
      value: { localStorage: mockStorage },
      configurable: true,
    })

    try {
      expect(loadBotRunSectionState()).toEqual(DEFAULT_BOTRUN_SECTIONS)

      const updated = { ...DEFAULT_BOTRUN_SECTIONS, mt5: false, audit: false }
      saveBotRunSectionState(updated)
      expect(store.get(BOTRUN_SECTIONS_STORAGE_KEY)).toBeTruthy()
      expect(loadBotRunSectionState()).toEqual(updated)

      store.set(BOTRUN_SECTIONS_STORAGE_KEY, '{bad-json')
      expect(loadBotRunSectionState()).toEqual(DEFAULT_BOTRUN_SECTIONS)
    } finally {
      Object.defineProperty(globalThis, 'window', {
        value: prevWindow,
        configurable: true,
      })
    }
  })

  it('formats timestamps, relative ages, durations, and staleness thresholds', () => {
    const baseMs = Date.UTC(2026, 4, 1, 12, 0, 0)
    expect(formatUtcTimestamp(baseMs)).toBe('2026-05-01 12:00:00 UTC')
    expect(formatUtcTimestamp(null)).toBe('—')
    expect(formatShortUtcDate(baseMs)).toBe('2026-05-01 12:00')
    expect(formatShortUtcDate(0)).toBe('—')

    expect(formatRelativeAge(baseMs - 12_000, baseMs)).toBe('updated 12s ago')
    expect(formatRelativeAge(baseMs - 120_000, baseMs)).toBe('updated 2m ago')
    expect(formatRelativeAge(null, baseMs)).toBe('no data yet')
    expect(formatRelativeAge(null, baseMs, true)).toBe('sin datos aún')

    expect(isTimestampStale(baseMs - 5_000, 10_000, baseMs)).toBe(false)
    expect(isTimestampStale(baseMs - 25_000, 10_000, baseMs)).toBe(true)
    expect(isAuditWindowStale(baseMs - 30 * 60_000, '5m', baseMs)).toBe(true)
    expect(isAuditWindowStale(baseMs - 5 * 60_000, '5m', baseMs)).toBe(false)

    expect(formatDurationMs(45_000)).toBe('45s')
    expect(formatDurationMs(5 * 60_000 + 12_000)).toBe('5m 12s')
    expect(formatDurationMs(2 * 3600_000 + 15 * 60_000)).toBe('2h 15m')
    expect(formatDurationMs(26 * 3600_000)).toBe('1d 2h')
  })

  it('computes R-multiple and closed trades summary accurately', () => {
    const win = makeTrade({ id: 1, pnl: 20, fees: 2 })
    const loss = makeTrade({
      id: 2,
      pnl: -10,
      fees: 1.5,
      initialStopPrice: undefined,
    })

    // win: 1% stop on $1000 size -> $10 risk -> +2.0R
    expect(computeTradeRMultiple(win)).toBe(2)
    // loss without initialStopPrice uses fallback 2% stop on $1000 -> $20 risk -> -0.5R
    expect(computeTradeRMultiple(loss, 2)).toBe(-0.5)
    expect(computeTradeRMultiple(loss)).toBeNull()

    const summary = computeClosedTradesSummary([win, loss], 2)
    expect(summary).toEqual({
      count: 2,
      wins: 1,
      losses: 1,
      totalPnlUsd: 10,
      winRatePct: 50,
      avgR: 0.75,
      profitFactor: 2,
      totalFeesUsd: 3.5,
    })

    expect(computeClosedTradesSummary([])).toEqual({
      count: 0,
      wins: 0,
      losses: 0,
      totalPnlUsd: 0,
      winRatePct: null,
      avgR: null,
      profitFactor: null,
      totalFeesUsd: 0,
    })
  })

  it('computes virtual scroll windows with overscan and safe clamping', () => {
    expect(
      computeVirtualWindow({
        totalItems: 0,
        scrollTop: 0,
        viewportHeight: 320,
        rowHeight: 52,
      }),
    ).toEqual({ startIndex: 0, endIndex: 0, totalHeight: 0, offsetTop: 0 })

    const top = computeVirtualWindow({
      totalItems: 500,
      scrollTop: 0,
      viewportHeight: 320,
      rowHeight: 50,
      overscan: 4,
    })
    expect(top.startIndex).toBe(0)
    expect(top.endIndex).toBe(11)
    expect(top.totalHeight).toBe(25_000)
    expect(top.offsetTop).toBe(0)

    const mid = computeVirtualWindow({
      totalItems: 500,
      scrollTop: 5_000, // item 100
      viewportHeight: 300, // 6 visible
      rowHeight: 50,
      overscan: 5,
    })
    expect(mid.startIndex).toBe(95)
    expect(mid.endIndex).toBe(111)
    expect(mid.offsetTop).toBe(4_750)
  })

  it('builds RFC-4180 escaped CSVs for events, trades, and orders', () => {
    const csv = buildCsv(['a', 'b'], [['hello, "world"', 'line1\nline2']])
    expect(csv).toBe('a,b\r\n"hello, ""world""","line1\nline2"')

    const events: RuntimeEventRecord[] = [
      {
        id: 'ev-1',
        tenantId: 'default',
        timestamp: '2026-05-01T12:00:00.000Z',
        type: 'ERROR',
        severity: 'error',
        source: 'botRuntime',
        correlationId: 'ord-1',
        message: 'Failed, "retry"',
      },
    ]
    const evCsv = buildEventsCsv(events)
    expect(evCsv).toContain('id,timestamp,type,severity,source,correlation_id,message')
    expect(evCsv).toContain('"Failed, ""retry"""')

    const tradesCsv = buildClosedTradesCsv([makeTrade()], 'Fallback', 2)
    expect(tradesCsv).toContain('BTC/USDT,BUY,1000.00')

    const orders: ExchangeOrderRecord[] = [
      {
        id: 'ORD-1001',
        timestamp: '2026-05-01T12:00:00.000Z',
        pair: 'BTC/USDT',
        side: 'BUY',
        notionalUsd: 200,
        price: 60000,
        avgPrice: 60010,
        quantity: 0.003333,
        filledQty: 0.003333,
        fee: 0.2,
        feeAsset: 'USDT',
        status: 'FILLED',
        mode: 'paper',
        source: 'manual',
      },
    ]
    const ordCsv = buildOrdersCsv(orders)
    expect(ordCsv).toContain('ORD-1001,2026-05-01T12:00:00.000Z,manual,paper,BTC/USDT,BUY,200.00')
  })

  it('validates hard limits and strategy parameter drafts', () => {
    expect(
      validateHardLimitsDraft({
        maxOrderNotionalUsd: '500',
        maxDailyOrders: '20',
        maxDailyLossUsd: '250',
      }),
    ).toEqual({})

    const badLimits = validateHardLimitsDraft({
      maxOrderNotionalUsd: '5',
      maxDailyOrders: '2.5',
      maxDailyLossUsd: '999999',
    })
    expect(badLimits.maxOrderNotionalUsd).toBeTruthy()
    expect(badLimits.maxDailyOrders).toBeTruthy()
    expect(badLimits.maxDailyLossUsd).toBeTruthy()

    const okStrategy = validateStrategyParamsDraft({
      positionSize: '5',
      stopLoss: '2',
      takeProfit: '4',
      maxDailyRisk: '3',
    })
    expect(Object.values(okStrategy).every((v) => v === undefined)).toBe(true)

    const badStrategy = validateStrategyParamsDraft({
      positionSize: '0',
      stopLoss: '60',
      takeProfit: '',
      maxDailyRisk: '120',
    })
    expect(badStrategy.positionSize).toBeTruthy()
    expect(badStrategy.stopLoss).toBeTruthy()
    expect(badStrategy.takeProfit).toBeTruthy()
    expect(badStrategy.maxDailyRisk).toBeTruthy()
  })
})
