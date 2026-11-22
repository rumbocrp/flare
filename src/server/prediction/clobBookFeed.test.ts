import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateExecutableQuote } from '../../market/quoteService'
import type { PolymarketWindow } from '../polymarketAdapter'
import {
  ClobBookFeedService,
  DEFAULT_BOOK_STALE_MS,
  getClobBookFeed,
  isBookSideStale,
  resetClobBookFeed,
  toExecutableQuote,
  type WebSocketLike,
} from './clobBookFeed'

class FakeWebSocket implements WebSocketLike {
  readyState = 0
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  readonly sent: string[] = []
  closed = false

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.readyState = 3
  }

  emitOpen(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data })
  }

  emitClose(): void {
    this.readyState = 3
    this.onclose?.({})
  }
}

function makeOpenWindow(overrides: Partial<PolymarketWindow> = {}): PolymarketWindow {
  return {
    slug: 'btc-updown-15m-1794683700',
    timeframe: '15m',
    startTime: 1_794_683_700_000,
    endTime: 1_794_684_600_000,
    status: 'open',
    question: 'Bitcoin Up or Down?',
    upPriceAtOpen: 0.5,
    upPriceNow: 0.52,
    bestBid: 0.51,
    bestAsk: 0.53,
    resolvedUp: null,
    volume: 1500,
    resolutionSource: 'chainlink-twap-60s',
    conditionId: '0xcond-1',
    upTokenId: 'tok-yes-1',
    downTokenId: 'tok-no-1',
    tickSize: 0.01,
    negRisk: false,
    ...overrides,
  }
}

describe('clobBookFeed', () => {
  afterEach(() => {
    vi.useRealTimers()
    resetClobBookFeed()
  })

  it('hydrates REST /book snapshots, sorts levels, and aggregates top-5 USD depth', async () => {
    let now = 1_794_683_750_000
    const mockFetch = async (url: string) => {
      if (url.includes('token_id=tok-yes-1')) {
        // Deliberately unsorted bids and asks with 6 levels each (6th level excluded from top-5)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            bids: [
              { price: '0.45', size: '1000' }, // 6th best bid (excluded)
              { price: '0.50', size: '100' }, // 2nd
              { price: '0.51', size: '200' }, // bestBid = 0.51
              { price: '0.47', size: '100' }, // 5th
              { price: '0.49', size: '100' }, // 3rd
              { price: '0.48', size: '100' }, // 4th
            ],
            asks: [
              { price: '0.58', size: '1000' }, // 6th best ask (excluded)
              { price: '0.54', size: '100' }, // 2nd
              { price: '0.53', size: '200' }, // bestAsk = 0.53
              { price: '0.57', size: '100' }, // 5th
              { price: '0.55', size: '100' }, // 3rd
              { price: '0.56', size: '100' }, // 4th
            ],
          }),
        }
      }
      if (url.includes('token_id=tok-no-1')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            bids: [{ price: '0.46', size: '100' }],
            asks: [{ price: '0.48', size: '100' }],
          }),
        }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }

    const feed = new ClobBookFeedService({
      fetchImpl: mockFetch,
      nowMs: () => now,
    })

    const win = makeOpenWindow()
    const snap = await feed.hydrateWindow(win)

    expect(snap.slug).toBe(win.slug)
    expect(snap.yes).not.toBeNull()
    expect(snap.yes?.source).toBe('clob-rest')
    expect(snap.yes?.bestBid).toBe(0.51)
    expect(snap.yes?.bestAsk).toBe(0.53)
    expect(snap.yes?.mid).toBe(0.52)
    expect(snap.yes?.spread).toBe(0.02)

    // Top-5 bid USD = 0.51*200 + (0.50+0.49+0.48+0.47)*100 = 102 + 194 = 296
    // Top-5 ask USD = 0.53*200 + (0.54+0.55+0.56+0.57)*100 = 106 + 222 = 328
    expect(snap.yes?.bidDepthUsd).toBe(296)
    expect(snap.yes?.askDepthUsd).toBe(328)
    expect(snap.yes?.top5DepthUsd).toBe(624)

    // NO top-5 = 0.46*100 + 0.48*100 = 94 -> minTop5DepthUsd = 94
    expect(snap.no?.top5DepthUsd).toBe(94)
    expect(snap.minTop5DepthUsd).toBe(94)
    expect(snap.capturedAtMs).toBe(now)

    // REST failure returns null without inventing fallback quotes
    now += 1000
    expect(await feed.hydrateToken('missing-token')).toBeNull()
    feed.close()
  })

  it('subscribes via CLOB Market WS, handles PONG, book snapshots, and price_change deltas', () => {
    vi.useFakeTimers()
    let now = 1_794_683_800_000
    const sockets: FakeWebSocket[] = []

    const feed = new ClobBookFeedService({
      wsFactory: () => {
        const ws = new FakeWebSocket()
        sockets.push(ws)
        return ws
      },
      nowMs: () => now,
      pingIntervalMs: 5_000,
    })

    const win = makeOpenWindow()
    feed.subscribeWindows([win])
    expect(sockets).toHaveLength(1)

    const ws = sockets[0]
    ws.emitOpen()

    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0])).toEqual({
      assets_ids: ['tok-yes-1', 'tok-no-1'],
      type: 'market',
    })

    // Ping interval sends PING and PONG is ignored cleanly
    vi.advanceTimersByTime(5_000)
    expect(ws.sent).toContain('PING')
    ws.emitMessage('PONG')
    expect(feed.getTokenSnapshot('tok-yes-1')).toBeNull()

    // Full WS book snapshot
    now += 1_000
    ws.emitMessage(
      JSON.stringify({
        event_type: 'book',
        asset_id: 'tok-yes-1',
        bids: [
          { price: '0.52', size: '100' },
          { price: '0.50', size: '50' },
        ],
        asks: [
          { price: '0.54', size: '100' },
          { price: '0.56', size: '50' },
        ],
      }),
    )

    let yes = feed.getTokenSnapshot('tok-yes-1')
    expect(yes?.source).toBe('clob-ws')
    expect(yes?.bestBid).toBe(0.52)
    expect(yes?.bestAsk).toBe(0.54)
    expect(yes?.asOfMs).toBe(now)

    // price_change (new array format) deletes 0.52 bid and inserts 0.53 ask
    now += 500
    ws.emitMessage(
      JSON.stringify({
        event_type: 'price_change',
        price_changes: [
          { asset_id: 'tok-yes-1', price: '0.52', size: '0', side: 'BUY' },
          { asset_id: 'tok-yes-1', price: '0.53', size: '80', side: 'SELL' },
        ],
      }),
    )

    yes = feed.getTokenSnapshot('tok-yes-1')
    expect(yes?.bestBid).toBe(0.5)
    expect(yes?.bestAsk).toBe(0.53)
    expect(yes?.spread).toBe(0.03)
    expect(yes?.asOfMs).toBe(now)

    // price_change (legacy changes format) updates NO token
    now += 500
    ws.emitMessage(
      JSON.stringify([
        {
          event_type: 'price_change',
          asset_id: 'tok-no-1',
          changes: [
            { price: '0.47', size: '100', side: 'BUY' },
            { price: '0.49', size: '100', side: 'SELL' },
          ],
        },
      ]),
    )
    const no = feed.getTokenSnapshot('tok-no-1')
    expect(no?.bestBid).toBe(0.47)
    expect(no?.bestAsk).toBe(0.49)
    expect(no?.mid).toBe(0.48)

    // Dynamic subscription when WS is already open
    feed.subscribeTokens(['tok-extra-1'])
    expect(JSON.parse(ws.sent[ws.sent.length - 1])).toEqual({
      assets_ids: ['tok-extra-1'],
      operation: 'subscribe',
    })

    feed.close()
  })

  it('reconnects with re-subscription on close and stops cleanly after close()', () => {
    vi.useFakeTimers()
    const sockets: FakeWebSocket[] = []

    const feed = new ClobBookFeedService({
      wsFactory: () => {
        const ws = new FakeWebSocket()
        sockets.push(ws)
        return ws
      },
      reconnectMinMs: 1_000,
      reconnectMaxMs: 4_000,
    })

    feed.subscribeTokens(['tok-yes-1'])
    expect(sockets).toHaveLength(1)
    sockets[0].emitOpen()

    // Unexpected close triggers reconnect
    sockets[0].emitClose()
    vi.advanceTimersByTime(1_200)
    expect(sockets).toHaveLength(2)
    sockets[1].emitOpen()
    expect(JSON.parse(sockets[1].sent[0])).toEqual({
      assets_ids: ['tok-yes-1'],
      type: 'market',
    })

    // Explicit close stops further reconnects even if socket closes afterward
    feed.close()
    sockets[1].emitClose()
    vi.advanceTimersByTime(10_000)
    expect(sockets).toHaveLength(2)
  })

  it('produces ExecutablePredictionQuote compatible with validateExecutableQuote and fails closed on stale/crossed/closed books', () => {
    const now = 1_794_683_800_000
    const feed = new ClobBookFeedService({ nowMs: () => now })
    const win = makeOpenWindow()

    feed.ingestWsMessage(
      JSON.stringify({
        event_type: 'book',
        asset_id: 'tok-yes-1',
        bids: [{ price: '0.55', size: '100' }],
        asks: [{ price: '0.57', size: '100' }],
      }),
      now,
    )
    feed.ingestWsMessage(
      JSON.stringify({
        event_type: 'book',
        asset_id: 'tok-no-1',
        bids: [{ price: '0.43', size: '100' }],
        asks: [{ price: '0.45', size: '100' }],
      }),
      now,
    )

    const bookSnap = feed.getWindowSnapshot(win)
    expect(isBookSideStale(bookSnap.yes, now, DEFAULT_BOOK_STALE_MS)).toBe(false)
    expect(
      isBookSideStale(bookSnap.yes, now + DEFAULT_BOOK_STALE_MS + 1, DEFAULT_BOOK_STALE_MS),
    ).toBe(true)

    const yesQuote = toExecutableQuote(win, 'YES', bookSnap, now)
    expect(yesQuote).not.toBeNull()
    expect(yesQuote?.source).toBe('polymarket-clob')
    expect(yesQuote?.tokenId).toBe('tok-yes-1')
    expect(validateExecutableQuote(yesQuote, now).ok).toBe(true)

    const noQuote = toExecutableQuote(win, 'NO', bookSnap, now)
    expect(noQuote).not.toBeNull()
    expect(noQuote?.tokenId).toBe('tok-no-1')
    expect(validateExecutableQuote(noQuote, now).ok).toBe(true)

    // Closed window -> null
    expect(
      toExecutableQuote({ ...win, status: 'closed' }, 'YES', bookSnap, now),
    ).toBeNull()

    // Stale quote (> DEFAULT_BOOK_STALE_MS without options) -> null; at exact boundary -> valid
    expect(
      toExecutableQuote(win, 'YES', bookSnap, now + DEFAULT_BOOK_STALE_MS),
    ).not.toBeNull()
    expect(
      toExecutableQuote(win, 'YES', bookSnap, now + DEFAULT_BOOK_STALE_MS + 1),
    ).toBeNull()

    // Mismatched bookSnapshot.slug -> null
    expect(
      toExecutableQuote(
        win,
        'YES',
        { ...bookSnap, slug: 'btc-updown-15m-other' },
        now,
      ),
    ).toBeNull()

    // Crossed book -> mid/spread null and toExecutableQuote returns null
    feed.ingestWsMessage(
      JSON.stringify({
        event_type: 'book',
        asset_id: 'tok-yes-1',
        bids: [{ price: '0.60', size: '50' }],
        asks: [{ price: '0.55', size: '50' }],
      }),
      now,
    )
    const crossedSnap = feed.getWindowSnapshot(win)
    expect(crossedSnap.yes?.mid).toBeNull()
    expect(crossedSnap.yes?.spread).toBeNull()
    expect(toExecutableQuote(win, 'YES', crossedSnap, now)).toBeNull()

    // Singleton helper works cleanly
    const singleton = getClobBookFeed()
    expect(getClobBookFeed()).toBe(singleton)
    resetClobBookFeed()
    feed.close()
  })

  it('prevents an in-flight REST hydrateToken from overwriting a fresher clob-ws book', async () => {
    let now = 1_794_683_800_000
    let resolveFetch!: (res: {
      ok: boolean
      status: number
      json: () => Promise<unknown>
    }) => void

    const feed = new ClobBookFeedService({
      nowMs: () => now,
      fetchImpl: () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        }),
    })

    // Start REST /book hydration at t = 0
    const hydratePromise = feed.hydrateToken('tok-yes-1')

    // Fresher WS book update arrives at t = +250ms while REST is still in flight
    now += 250
    feed.ingestWsMessage(
      JSON.stringify({
        event_type: 'book',
        asset_id: 'tok-yes-1',
        bids: [{ price: '0.60', size: '150' }],
        asks: [{ price: '0.62', size: '150' }],
      }),
      now,
    )

    // REST /book resolves later at t = +500ms with stale 0.40/0.42 levels
    now += 250
    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({
        bids: [{ price: '0.40', size: '100' }],
        asks: [{ price: '0.42', size: '100' }],
      }),
    })

    const returned = await hydratePromise
    const current = feed.getTokenSnapshot('tok-yes-1')

    expect(returned?.source).toBe('clob-ws')
    expect(returned?.bestBid).toBe(0.6)
    expect(returned?.bestAsk).toBe(0.62)
    expect(current?.source).toBe('clob-ws')
    expect(current?.bestBid).toBe(0.6)
    expect(current?.bestAsk).toBe(0.62)
    expect(current?.asOfMs).toBe(1_794_683_800_250)

    feed.close()
  })
})
