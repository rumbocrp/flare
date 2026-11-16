import { describe, expect, it } from 'vitest'
import type { PolymarketWindow } from '../server/polymarketAdapter'
import {
  DEFAULT_MAX_EXECUTABLE_SPREAD,
  DEFAULT_QUOTE_MAX_AGE_MS,
  buildQuoteFromPolymarketWindow,
  pickBestOpenPolymarketWindow,
  validateExecutableQuote,
} from './quoteService'

function makeWindow(overrides: Partial<PolymarketWindow> = {}): PolymarketWindow {
  return {
    slug: 'btc-updown-15m-1700000000',
    timeframe: '15m',
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_900_000,
    status: 'open',
    question: 'Will BTC go up?',
    upPriceAtOpen: 0.5,
    upPriceNow: 0.54,
    bestBid: 0.53,
    bestAsk: 0.55,
    resolvedUp: null,
    volume: 12_500,
    ...overrides,
  }
}

describe('quoteService', () => {
  it('picks enclosing open Polymarket window over closed or future windows', () => {
    const now = 1_700_000_300_000
    const closed = makeWindow({
      slug: 'closed-win',
      status: 'closed',
      startTime: now - 100_000,
      endTime: now + 100_000,
    })
    const enclosing = makeWindow({
      slug: 'enclosing-open',
      startTime: now - 60_000,
      endTime: now + 840_000,
    })
    const future = makeWindow({
      slug: 'future-open',
      startTime: now + 900_000,
      endTime: now + 1_800_000,
    })

    expect(pickBestOpenPolymarketWindow([closed, future, enclosing], now)?.slug).toBe(
      'enclosing-open',
    )
    expect(pickBestOpenPolymarketWindow([closed, future], now)?.slug).toBe('future-open')
    expect(pickBestOpenPolymarketWindow([closed], now)).toBeNull()
  })

  it('builds YES and NO quotes from CLOB bestBid/bestAsk and maps Gamma fallback spread', () => {
    const asOfMs = 1_700_000_100_000
    const clobWin = makeWindow({ bestBid: 0.6, bestAsk: 0.64, upPriceNow: 0.62 })

    const yesQuote = buildQuoteFromPolymarketWindow(clobWin, 'YES', asOfMs)
    expect(yesQuote).not.toBeNull()
    expect(yesQuote?.source).toBe('polymarket-clob')
    expect(yesQuote?.bid).toBe(0.6)
    expect(yesQuote?.ask).toBe(0.64)
    expect(yesQuote?.spread).toBe(0.04)

    const noQuote = buildQuoteFromPolymarketWindow(clobWin, 'NO', asOfMs)
    expect(noQuote).not.toBeNull()
    expect(noQuote?.source).toBe('polymarket-clob')
    expect(noQuote?.bid).toBe(0.36)
    expect(noQuote?.ask).toBe(0.4)

    const gammaWin = makeWindow({ bestBid: null, bestAsk: null, upPriceNow: 0.58 })
    const gammaNo = buildQuoteFromPolymarketWindow(gammaWin, 'NO', asOfMs)
    expect(gammaNo).not.toBeNull()
    expect(gammaNo?.source).toBe('polymarket-gamma')
    expect(gammaNo?.bid).toBe(0.41)
    expect(gammaNo?.ask).toBe(0.43)

    expect(
      buildQuoteFromPolymarketWindow(makeWindow({ status: 'closed' }), 'YES', asOfMs),
    ).toBeNull()
    expect(
      buildQuoteFromPolymarketWindow(
        makeWindow({ bestBid: null, bestAsk: null, upPriceNow: null }),
        'YES',
        asOfMs,
      ),
    ).toBeNull()
  })

  it('validates freshness, spread, and fee-adjusted effectiveAsk', () => {
    const now = 1_700_000_500_000

    expect(validateExecutableQuote(null, now)).toMatchObject({
      ok: false,
      code: 'MISSING_QUOTE',
    })

    const baseQuote = buildQuoteFromPolymarketWindow(makeWindow(), 'YES', now - 5_000)!

    expect(
      validateExecutableQuote({ ...baseQuote, asOfMs: now - (DEFAULT_QUOTE_MAX_AGE_MS + 1) }, now),
    ).toMatchObject({ ok: false, code: 'STALE_QUOTE' })

    expect(
      validateExecutableQuote({ ...baseQuote, asOfMs: now + 10_000 }, now),
    ).toMatchObject({ ok: false, code: 'INVALID_QUOTE' })

    expect(
      validateExecutableQuote({ ...baseQuote, bid: 0.7, ask: 0.6 }, now),
    ).toMatchObject({ ok: false, code: 'INVALID_QUOTE' })

    expect(
      validateExecutableQuote(
        {
          ...baseQuote,
          bid: 0.3,
          ask: 0.3 + DEFAULT_MAX_EXECUTABLE_SPREAD + 0.05,
        },
        now,
      ),
    ).toMatchObject({ ok: false, code: 'EXCESSIVE_SPREAD' })

    const valid = validateExecutableQuote(baseQuote, now)
    expect(valid.ok).toBe(true)
    if (valid.ok) {
      expect(valid.feePerShare).toBeGreaterThan(0)
      expect(valid.effectiveAsk).toBeGreaterThan(baseQuote.ask)
      expect(valid.feePctOfStake).toBeGreaterThan(0)
    }
  })
})
