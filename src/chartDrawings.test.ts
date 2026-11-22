import { describe, expect, it } from 'vitest'
import {
  DRAWINGS_V2_STORAGE_KEY,
  LEGACY_DRAWINGS_STORAGE_KEY,
  applyDrawingDrag,
  createDrawingHistory,
  createDrawingId,
  drawingScopeKey,
  hitTestDrawings,
  loadDrawingsStore,
  migrateLegacyDrawings,
  pushDrawingHistory,
  redoDrawingHistory,
  undoDrawingHistory,
} from './chartDrawings'
import type { ChartDrawing } from './types'

function createMemoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    dump: () => Object.fromEntries(map.entries()),
  }
}

describe('chartDrawings', () => {
  it('generates collision-free unique drawing IDs even in tight loops', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createDrawingId()))
    expect(ids.size).toBe(50)
  })

  it('migrates legacy lixtrd:chart-drawings-by-pair to flare:chart-drawings-v2 without deleting legacy key', () => {
    const legacy = {
      'BTC/USDT': [
        { id: 'hz-1', type: 'horizontal', price: 62000, label: 'S/R 62,000.00' },
        {
          id: 'tl-1',
          type: 'trendline',
          t1: 1000,
          p1: 60000,
          t2: 2000,
          p2: 63000,
        },
      ],
    }
    const storage = createMemoryStorage({
      [LEGACY_DRAWINGS_STORAGE_KEY]: JSON.stringify(legacy),
    })

    const store = loadDrawingsStore('15m', storage)
    const btc15m = store[drawingScopeKey('BTC/USDT', '15m')]
    expect(btc15m).toHaveLength(2)
    expect(btc15m[0].pair).toBe('BTC/USDT')
    expect(btc15m[0].interval).toBe('15m')
    expect(btc15m[0].id).not.toBe('hz-1')
    expect(btc15m[0].createdAt).toBeGreaterThan(0)
    // Legacy key left completely untouched for rollback
    expect(storage.getItem(LEGACY_DRAWINGS_STORAGE_KEY)).toBe(
      JSON.stringify(legacy),
    )
    // New key persisted
    expect(storage.getItem(DRAWINGS_V2_STORAGE_KEY)).not.toBeNull()
  })

  it('scopes drawings strictly by pair + interval', () => {
    const migrated = migrateLegacyDrawings(
      {
        'BTC/USDT': [{ id: 'a', type: 'horizontal', price: 60000, label: 'S/R 60k' }],
      },
      '1h',
    )
    expect(migrated[drawingScopeKey('BTC/USDT', '1h')]).toHaveLength(1)
    expect(migrated[drawingScopeKey('BTC/USDT', '15m')]).toBeUndefined()
    expect(migrated[drawingScopeKey('ETH/USDT', '1h')]).toBeUndefined()
  })

  it('supports undo and redo with capped history depth', () => {
    const d1: ChartDrawing = {
      id: '1',
      type: 'horizontal',
      pair: 'BTC/USDT',
      interval: '15m',
      price: 60000,
      label: 'S/R 60,000.00',
      createdAt: 1,
      updatedAt: 1,
    }
    const d2: ChartDrawing = { ...d1, id: '2', price: 61000 }

    let history = createDrawingHistory([])
    history = pushDrawingHistory(history, [d1])
    history = pushDrawingHistory(history, [d1, d2])
    expect(history.present).toHaveLength(2)

    history = undoDrawingHistory(history)
    expect(history.present).toEqual([d1])
    expect(history.future).toHaveLength(1)

    history = redoDrawingHistory(history)
    expect(history.present).toEqual([d1, d2])

    // Cap test
    let capped = createDrawingHistory([])
    for (let i = 0; i < 60; i++) {
      capped = pushDrawingHistory(capped, [{ ...d1, id: `d-${i}` }], 10)
    }
    expect(capped.past.length).toBe(10)
  })

  it('hit-tests trendline endpoints, trendline body, horizontal lines, and ignores empty canvas', () => {
    const drawings: ChartDrawing[] = [
      {
        id: 'hz',
        type: 'horizontal',
        pair: 'BTC/USDT',
        interval: '15m',
        price: 100,
        label: 'S/R 100.00',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'tl',
        type: 'trendline',
        pair: 'BTC/USDT',
        interval: '15m',
        t1: 100,
        p1: 50,
        t2: 300,
        p2: 150,
        createdAt: 1,
        updatedAt: 1,
      },
    ]

    const proj = {
      xOfTime: (t: number) => t,
      yOfPrice: (p: number) => 200 - p,
      plotLeft: 10,
      plotRight: 500,
      plotTop: 10,
      plotBottom: 250,
    }

    // Endpoint p1 of trendline at (100, 150)
    expect(hitTestDrawings(drawings, 102, 149, proj, 'tl')).toEqual({
      drawingId: 'tl',
      part: 'p1',
    })
    // Midpoint of trendline at (200, 100) — trendline sits above horizontal in Z-order
    expect(hitTestDrawings(drawings, 200, 100, proj, null)).toEqual({
      drawingId: 'tl',
      part: 'body',
    })
    // Horizontal line away from trendline at (420, 100)
    expect(hitTestDrawings(drawings, 420, 102, proj, null)).toEqual({
      drawingId: 'hz',
      part: 'body',
    })
    // Empty canvas returns null so pan/zoom works unimpeded
    expect(hitTestDrawings(drawings, 420, 30, proj, null)).toBeNull()
  })

  it('moves and resizes trendline, horizontal, and fib drawings accurately', () => {
    const tl: ChartDrawing = {
      id: 'tl',
      type: 'trendline',
      pair: 'BTC/USDT',
      interval: '15m',
      t1: 1000,
      p1: 100,
      t2: 2000,
      p2: 120,
      createdAt: 1,
      updatedAt: 1,
    }

    const moved = applyDrawingDrag({
      origin: tl,
      part: 'body',
      startTime: 1500,
      startPrice: 110,
      currentTime: 1800,
      currentPrice: 115,
      now: 99,
    })
    expect(moved.type === 'trendline' && moved.t1).toBe(1300)
    expect(moved.type === 'trendline' && moved.t2).toBe(2300)
    expect(moved.type === 'trendline' && moved.p1).toBe(105)
    expect(moved.type === 'trendline' && moved.p2).toBe(125)

    const resized = applyDrawingDrag({
      origin: tl,
      part: 'p2',
      startTime: 2000,
      startPrice: 120,
      currentTime: 2400,
      currentPrice: 140,
      now: 100,
    })
    expect(resized.type === 'trendline' && resized.t1).toBe(1000)
    expect(resized.type === 'trendline' && resized.t2).toBe(2400)
    expect(resized.type === 'trendline' && resized.p2).toBe(140)
  })
})
