import { beforeEach, describe, expect, it } from 'vitest'
import {
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
      upTokenId: 'tok-up',
      upIndex: 0,
      outcomePrices: [1, 0],
      bestBid: 0.49,
      bestAsk: 0.51,
      volume: 123.45,
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
})
