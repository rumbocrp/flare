import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildHourlySlug,
  classifyResolutionSource,
  clearPolymarketCache,
  fetchPolymarketUpDown,
  parseGammaMarket,
  priceAtOpen,
  recentWindowStarts,
} from './polymarketAdapter'

describe('polymarketAdapter', () => {
  beforeEach(() => {
    clearPolymarketCache()
  })

  it('computes interval-aligned window start timestamps', () => {
    const nowMs = 1_794_683_850_000 // mid 15m window
    const starts = recentWindowStarts('15m', 4, nowMs)
    expect(starts).toHaveLength(4)
    expect(starts[3]).toBe(1_794_683_700)
    expect(starts[3] - starts[2]).toBe(900)
  })

  it('extracts latest quote <= open (+20s grace window) in priceAtOpen', () => {
    const history = [
      { t: 1000, p: 0.48 },
      { t: 1015, p: 0.51 },
      { t: 1030, p: 0.77 }, // outside grace window (+20s)
    ]
    expect(priceAtOpen(history, 1000)).toBe(0.51)
    expect(priceAtOpen([{ t: 1030, p: 0.77 }], 1000)).toBeNull()
  })

  it('parses Gamma markets with JSON-encoded outcomes and clobTokenIds', () => {
    const parsed = parseGammaMarket({
      question: 'Bitcoin Up or Down',
      closed: true,
      outcomes: '["Up", "Down"]',
      clobTokenIds: '["tok-up", "tok-down"]',
      outcomePrices: '["1", "0"]',
      bestBid: 0.49,
      bestAsk: 0.51,
      volume: '123.45',
    })
    expect(parsed).toEqual({
      question: 'Bitcoin Up or Down',
      closed: true,
      conditionId: null,
      upTokenId: 'tok-up',
      downTokenId: 'tok-down',
      upIndex: 0,
      outcomePrices: [1, 0],
      bestBid: 0.49,
      bestAsk: 0.51,
      volume: 123.45,
      tickSize: 0.01,
      negRisk: false,
      resolutionSource: 'unknown',
    })
  })

  it('fetches closed and open windows using mocked fetch and caches settled windows', async () => {
    const nowMs = 1_794_683_850_000
    const currentStart = 1_794_683_700
    const prevStart = currentStart - 900
    const calls: string[] = []

    const mockFetch = async (url: string) => {
      calls.push(url)
      if (url.includes(`btc-updown-15m-${prevStart}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              question: 'Prev window',
              closed: true,
              outcomes: '["Up", "Down"]',
              clobTokenIds: '["tok-prev-up", "tok-prev-down"]',
              outcomePrices: '["0", "1"]',
              volume: '50',
            },
          ],
        }
      }
      if (url.includes(`btc-updown-15m-${currentStart}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              question: 'Current window',
              closed: false,
              outcomes: '["Up", "Down"]',
              clobTokenIds: '["tok-cur-up", "tok-cur-down"]',
              outcomePrices: '["0.52", "0.48"]',
              bestBid: 0.51,
              bestAsk: 0.53,
              volume: '12',
            },
          ],
        }
      }
      if (url.includes('market=tok-prev-up')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ history: [{ t: prevStart - 5, p: 0.49 }] }),
        }
      }
      if (url.includes('market=tok-cur-up')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ history: [{ t: currentStart + 5, p: 0.5 }] }),
        }
      }
      return { ok: true, status: 200, json: async () => [] }
    }

    const snap = await fetchPolymarketUpDown('15m', 4, {
      fetchImpl: mockFetch,
      nowMs,
    })

    expect(snap.source).toBe('polymarket')
    expect(snap.errors).toHaveLength(0)
    expect(snap.windows).toHaveLength(4)

    const prevWin = snap.windows.find((w) => w.startTime === prevStart * 1000)
    expect(prevWin?.status).toBe('closed')
    expect(prevWin?.resolvedUp).toBe(false)
    expect(prevWin?.upPriceAtOpen).toBe(0.49)

    const curWin = snap.windows.find((w) => w.startTime === currentStart * 1000)
    expect(curWin?.status).toBe('open')
    expect(curWin?.upPriceNow).toBeCloseTo(0.52, 6)
    expect(curWin?.upPriceAtOpen).toBe(0.5)

    // Second immediate call: settled and open windows both hit cache
    const callsBefore = calls.length
    await fetchPolymarketUpDown('15m', 4, { fetchImpl: mockFetch, nowMs: nowMs + 1000 })
    expect(calls.length).toBe(callsBefore)
  })

  it('coalesces concurrent cold fetches for identical windows', async () => {
    const nowMs = 1_794_683_850_000
    let fetchCount = 0
    const mockFetch = async () => {
      fetchCount += 1
      await new Promise((resolve) => setTimeout(resolve, 15))
      return { ok: true, status: 200, json: async () => [] }
    }

    const [a, b] = await Promise.all([
      fetchPolymarketUpDown('15m', 4, { fetchImpl: mockFetch, nowMs }),
      fetchPolymarketUpDown('15m', 4, { fetchImpl: mockFetch, nowMs }),
    ])

    expect(a.windows).toHaveLength(4)
    expect(b.windows).toHaveLength(4)
    // 4 missing windows * 2 fallback slug queries = 8 upstream requests total instead of 16
    expect(fetchCount).toBe(8)
  })

  it('computes 3600s-aligned window start timestamps for 1h timeframe', () => {
    const nowMs = Date.parse('2026-07-15T18:25:00Z')
    const starts = recentWindowStarts('1h', 4, nowMs)
    expect(starts).toHaveLength(4)
    expect(starts[3]).toBe(Date.parse('2026-07-15T18:00:00Z') / 1000)
    expect(starts[3] - starts[2]).toBe(3600)
  })

  it('formats DST-safe America/New_York hourly slugs across EST, EDT, and DST transitions', () => {
    // EST (UTC-5)
    expect(buildHourlySlug(Date.parse('2026-01-15T18:00:00Z') / 1000)).toBe(
      'bitcoin-up-or-down-january-15-2026-1pm-et',
    )
    expect(buildHourlySlug(Date.parse('2026-01-15T05:00:00Z') / 1000)).toBe(
      'bitcoin-up-or-down-january-15-2026-12am-et',
    )
    // EDT (UTC-4)
    expect(buildHourlySlug(Date.parse('2026-07-15T18:00:00Z') / 1000)).toBe(
      'bitcoin-up-or-down-july-15-2026-2pm-et',
    )
    expect(buildHourlySlug(Date.parse('2026-07-15T16:00:00Z') / 1000)).toBe(
      'bitcoin-up-or-down-july-15-2026-12pm-et',
    )
    // Spring-forward transition on 2026-03-08 (1am EST -> 3am EDT)
    expect(buildHourlySlug(Date.parse('2026-03-08T06:00:00Z') / 1000)).toBe(
      'bitcoin-up-or-down-march-8-2026-1am-et',
    )
    expect(buildHourlySlug(Date.parse('2026-03-08T07:00:00Z') / 1000)).toBe(
      'bitcoin-up-or-down-march-8-2026-3am-et',
    )
  })

  it('classifies resolutionSource from Gamma resolutionSource and description text', () => {
    expect(
      classifyResolutionSource('https://data.chain.link/streams/btc-usd', ''),
    ).toBe('chainlink-twap-60s')
    expect(
      classifyResolutionSource(
        null,
        'Resolves via Chainlink 60s TWAP price stream',
      ),
    ).toBe('chainlink-twap-60s')
    expect(
      classifyResolutionSource('Binance BTCUSDT', '1h candle close vs open'),
    ).toBe('binance-1h-candle')
    expect(
      classifyResolutionSource('', 'Resolves using the 1 hour BTCUSDT candle'),
    ).toBe('binance-1h-candle')
    expect(classifyResolutionSource(undefined, 'Unspecified oracle')).toBe(
      'unknown',
    )

    const parsed = parseGammaMarket({
      question: 'Bitcoin Up or Down - 1h',
      closed: false,
      outcomes: '["Up", "Down"]',
      clobTokenIds: '["up-1h", "down-1h"]',
      outcomePrices: '["0.55", "0.45"]',
      resolutionSource: 'https://www.binance.com/en/trade/BTC_USDT',
      description: 'Resolves based on Binance 1h candle.',
    })
    expect(parsed?.resolutionSource).toBe('binance-1h-candle')
  })

  it('discovers 1h windows via ET slug, btc-updown-1h fallback, and Gamma events fallback', async () => {
    // 2026-07-15T18:15:00Z -> current 1h start is 18:00Z (2pm ET), prev is 17:00Z (1pm ET), -2h is 16:00Z (12pm ET)
    const nowMs = Date.parse('2026-07-15T18:15:00Z')
    const curStart = Date.parse('2026-07-15T18:00:00Z') / 1000
    const prevStart = curStart - 3600
    const earlierStart = curStart - 7200
    let eventsFetches = 0

    const mockFetch = async (url: string) => {
      if (url.includes('bitcoin-up-or-down-july-15-2026-2pm-et')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              slug: 'bitcoin-up-or-down-july-15-2026-2pm-et',
              question: 'Bitcoin Up or Down - July 15, 2PM ET',
              closed: false,
              outcomes: '["Up", "Down"]',
              clobTokenIds: '["tok-1h-cur-up", "tok-1h-cur-down"]',
              outcomePrices: '["0.61", "0.39"]',
              bestBid: 0.6,
              bestAsk: 0.62,
              volume: '5000',
              resolutionSource: 'https://data.chain.link/streams/btc-usd',
            },
          ],
        }
      }
      if (url.includes(`btc-updown-1h-${prevStart}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              slug: `btc-updown-1h-${prevStart}`,
              question: 'Bitcoin Up or Down - 1h',
              closed: true,
              outcomes: '["Up", "Down"]',
              clobTokenIds: '["tok-1h-prev-up", "tok-1h-prev-down"]',
              outcomePrices: '["1", "0"]',
              volume: '9000',
              description: 'Resolves using Binance BTCUSDT 1h candle.',
            },
          ],
        }
      }
      if (url.includes('/events?tag_slug=bitcoin')) {
        eventsFetches += 1
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              slug: 'bitcoin-up-or-down-july-15-2026-12pm-et-alt',
              markets: [
                {
                  slug: 'bitcoin-up-or-down-july-15-2026-12pm-et-alt',
                  question: 'Bitcoin Up or Down - July 15, 12PM ET',
                  closed: true,
                  eventStartTime: new Date(earlierStart * 1000).toISOString(),
                  endDate: new Date((earlierStart + 3600) * 1000).toISOString(),
                  outcomes: '["Up", "Down"]',
                  clobTokenIds: '["tok-1h-ev-up", "tok-1h-ev-down"]',
                  outcomePrices: '["0", "1"]',
                  volume: '4200',
                  resolutionSource: 'Chainlink TWAP',
                },
              ],
            },
          ],
        }
      }
      if (url.includes('prices-history')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ history: [{ t: curStart, p: 0.5 }] }),
        }
      }
      return { ok: true, status: 200, json: async () => [] }
    }

    const snap = await fetchPolymarketUpDown('1h', 4, {
      fetchImpl: mockFetch,
      nowMs,
    })

    expect(snap.timeframe).toBe('1h')
    expect(snap.errors).toHaveLength(0)
    expect(snap.windows).toHaveLength(4)
    expect(eventsFetches).toBe(1)

    const curWin = snap.windows.find((w) => w.startTime === curStart * 1000)
    expect(curWin?.slug).toBe('bitcoin-up-or-down-july-15-2026-2pm-et')
    expect(curWin?.status).toBe('open')
    expect(curWin?.resolutionSource).toBe('chainlink-twap-60s')
    expect(curWin?.upPriceNow).toBeCloseTo(0.61, 6)

    const prevWin = snap.windows.find((w) => w.startTime === prevStart * 1000)
    expect(prevWin?.slug).toBe(`btc-updown-1h-${prevStart}`)
    expect(prevWin?.status).toBe('closed')
    expect(prevWin?.resolvedUp).toBe(true)
    expect(prevWin?.resolutionSource).toBe('binance-1h-candle')

    const evWin = snap.windows.find((w) => w.startTime === earlierStart * 1000)
    expect(evWin?.slug).toBe('bitcoin-up-or-down-july-15-2026-12pm-et-alt')
    expect(evWin?.status).toBe('closed')
    expect(evWin?.resolvedUp).toBe(false)
    expect(evWin?.resolutionSource).toBe('chainlink-twap-60s')
  })

  it('disambiguates DST fall-back 1am ET collision using UTC start timestamp cache keys', async () => {
    // 2026-11-01T05:00:00Z (1am EDT) and 2026-11-01T06:00:00Z (1am EST) both format to 1am-et
    const nowMs = Date.parse('2026-11-01T06:30:00Z')
    const edt1amStart = Date.parse('2026-11-01T05:00:00Z') / 1000
    const est1amStart = Date.parse('2026-11-01T06:00:00Z') / 1000

    const mockFetch = async (url: string) => {
      if (url.includes('bitcoin-up-or-down-november-1-2026-1am-et')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              slug: 'bitcoin-up-or-down-november-1-2026-1am-et',
              question: '1AM EDT window',
              closed: true,
              eventStartTime: '2026-11-01T05:00:00Z',
              outcomes: '["Up", "Down"]',
              clobTokenIds: '["tok-edt-up", "tok-edt-down"]',
              outcomePrices: '["1", "0"]',
            },
            {
              slug: 'bitcoin-up-or-down-november-1-2026-1am-et',
              question: '1AM EST window',
              closed: false,
              eventStartTime: '2026-11-01T06:00:00Z',
              outcomes: '["Up", "Down"]',
              clobTokenIds: '["tok-est-up", "tok-est-down"]',
              outcomePrices: '["0.52", "0.48"]',
              bestBid: 0.51,
              bestAsk: 0.53,
            },
          ],
        }
      }
      if (url.includes('prices-history')) {
        return { ok: true, status: 200, json: async () => ({ history: [] }) }
      }
      return { ok: true, status: 200, json: async () => [] }
    }

    const snap = await fetchPolymarketUpDown('1h', 4, {
      fetchImpl: mockFetch,
      nowMs,
    })

    const edtWin = snap.windows.find((w) => w.startTime === edt1amStart * 1000)
    const estWin = snap.windows.find((w) => w.startTime === est1amStart * 1000)
    expect(edtWin?.question).toBe('1AM EDT window')
    expect(edtWin?.resolvedUp).toBe(true)
    expect(estWin?.question).toBe('1AM EST window')
    expect(estWin?.status).toBe('open')
  })

  it('rejects empty-string numeric fields, zero tickSize, and null/empty clobTokenIds without CLOB ?market=null calls', async () => {
    const parsed = parseGammaMarket({
      question: 'Empty fields market',
      closed: true,
      outcomes: '["Up", "Down"]',
      clobTokenIds: [null, ''],
      outcomePrices: '["", ""]',
      bestBid: '',
      bestAsk: '   ',
      orderPriceMinTickSize: '',
      volume: '',
    })
    expect(parsed).toMatchObject({
      upTokenId: null,
      downTokenId: null,
      bestBid: null,
      bestAsk: null,
      tickSize: 0.01,
      volume: 0,
    })
    expect(Number.isNaN(parsed?.outcomePrices[0])).toBe(true)
    expect(Number.isNaN(parsed?.outcomePrices[1])).toBe(true)

    const parsedLiterals = parseGammaMarket({
      outcomes: '["Up", "Down"]',
      clobTokenIds: ['null', 'undefined'],
      orderPriceMinTickSize: 0,
    })
    expect(parsedLiterals?.upTokenId).toBeNull()
    expect(parsedLiterals?.downTokenId).toBeNull()
    expect(parsedLiterals?.tickSize).toBe(0.01)

    const parsedNumericTokens = parseGammaMarket({
      outcomes: '["Up", "Down"]',
      clobTokenIds: [12345, '   '],
      orderPriceMinTickSize: -0.05,
    })
    expect(parsedNumericTokens?.upTokenId).toBeNull()
    expect(parsedNumericTokens?.downTokenId).toBeNull()
    expect(parsedNumericTokens?.tickSize).toBe(0.01)

    const nowMs = 1_794_683_850_000
    const currentStart = 1_794_683_700
    const calls: string[] = []
    const mockFetch = async (url: string) => {
      calls.push(url)
      if (url.includes(`btc-updown-15m-${currentStart}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              question: 'Closed but unresolved empty prices',
              closed: true,
              outcomes: '["Up", "Down"]',
              clobTokenIds: [null, ''],
              outcomePrices: '["", ""]',
              bestBid: '',
              bestAsk: '',
              orderPriceMinTickSize: '',
            },
          ],
        }
      }
      return { ok: true, status: 200, json: async () => [] }
    }

    const snap = await fetchPolymarketUpDown('15m', 4, {
      fetchImpl: mockFetch,
      nowMs,
    })

    const curWin = snap.windows.find((w) => w.startTime === currentStart * 1000)
    expect(curWin?.resolvedUp).toBeNull()
    expect(curWin?.tickSize).toBe(0.01)
    expect(curWin?.upTokenId).toBeNull()
    expect(curWin?.downTokenId).toBeNull()
    expect(curWin?.bestBid).toBeNull()
    expect(curWin?.bestAsk).toBeNull()
    expect(calls.some((u) => u.includes('prices-history'))).toBe(false)
    expect(calls.some((u) => u.includes('market=null'))).toBe(false)

    // Unresolved closed window must use short open TTL (15s), not 7-day permanent cache
    const callsBeforeRetry = calls.length
    await fetchPolymarketUpDown('15m', 4, {
      fetchImpl: mockFetch,
      nowMs: nowMs + 16_000,
    })
    expect(calls.length).toBeGreaterThan(callsBeforeRetry)
  })
})
