import { describe, expect, it } from 'vitest'
import type { Candle } from '../types'
import {
  mergeLiveCandle,
  mergeLiveCandlesBatch,
  parseBinanceKlineEvent,
  toBinanceSymbol,
} from './liveStream'

function makeCandle(time: number, close: number): Candle {
  return {
    time,
    open: close - 10,
    high: close + 15,
    low: close - 20,
    close,
    volume: 100,
  }
}

describe('liveStream helpers', () => {
  it('converts standard pairs to Binance symbols', () => {
    expect(toBinanceSymbol('BTC/USDT')).toBe('BTCUSDT')
    expect(toBinanceSymbol('eth/usdt')).toBe('ETHUSDT')
  })

  it('parses valid Binance WS kline events and rejects malformed payloads', () => {
    const valid = parseBinanceKlineEvent({
      e: 'kline',
      s: 'BTCUSDT',
      k: {
        t: 1_700_000_000_000,
        i: '1h',
        o: '65000.10',
        h: '65120.50',
        l: '64980.00',
        c: '65090.25',
        v: '42.5',
        x: false,
      },
    })

    expect(valid).toEqual({
      symbol: 'BTCUSDT',
      interval: '1h',
      isClosed: false,
      candle: {
        time: 1_700_000_000_000,
        open: 65000.1,
        high: 65120.5,
        low: 64980,
        close: 65090.25,
        volume: 42.5,
      },
    })

    const combined = parseBinanceKlineEvent({
      stream: 'btcusdt@kline_5m',
      data: {
        s: 'BTCUSDT',
        k: {
          t: 1_700_000_300_000,
          i: '5m',
          o: '100',
          h: '105',
          l: '99',
          c: '104',
          v: '10',
          x: true,
        },
      },
    })

    expect(combined?.isClosed).toBe(true)
    expect(combined?.candle.close).toBe(104)

    expect(parseBinanceKlineEvent(null)).toBeNull()
    expect(parseBinanceKlineEvent({ k: { t: 1, c: '-5' } })).toBeNull()
  })

  it('immutably updates the forming candle or appends a new bar respecting maxLimit', () => {
    const base = [
      makeCandle(1_000, 100),
      makeCandle(2_000, 101),
      makeCandle(3_000, 102),
    ]

    // Unchanged tick: returns exact same reference
    const same = mergeLiveCandle(base, makeCandle(3_000, 102), 3)
    expect(same).toBe(base)

    // Intra-candle tick: replaces the last bar without growing the array
    const updated = mergeLiveCandle(base, makeCandle(3_000, 105), 3)
    expect(updated).not.toBe(base)
    expect(updated).toHaveLength(3)
    expect(updated[2].close).toBe(105)
    expect(base[2].close).toBe(102)

    // New candle trims oldest entry to stay within maxLimit
    const rolled = mergeLiveCandle(updated, makeCandle(4_000, 108), 3)
    expect(rolled.map((c) => c.time)).toEqual([2_000, 3_000, 4_000])
    expect(rolled[2].close).toBe(108)

    // Patches a previous bar (REST reconciliation) and ignores stale out-of-range bars
    const reconciled = mergeLiveCandlesBatch(
      rolled,
      [makeCandle(500, 99), makeCandle(3_000, 106), makeCandle(5_000, 110)],
      3,
    )
    expect(reconciled.map((c) => [c.time, c.close])).toEqual([
      [3_000, 106],
      [4_000, 108],
      [5_000, 110],
    ])
  })
})
