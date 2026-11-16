/**
 * Executable quote normalization and freshness validation for binary prediction
 * markets (`P0-1`: eliminate hardcoded 50c assumptions on the runtime path).
 */
import {
  POLYMARKET_FEES,
  polymarketFeePerShare,
  type MarketCategory,
} from '../predictionMarket'
import type { PredictionOutcome } from '../predictions'
import type { PolymarketWindow } from '../server/polymarketAdapter'

export type QuoteSource =
  | 'polymarket-clob'
  | 'polymarket-gamma'
  | 'explicit-quote'

export type ExecutablePredictionQuote = {
  instrumentId: string
  outcome: PredictionOutcome
  bid: number
  ask: number
  mid: number
  spread: number
  asOfMs: number
  source: QuoteSource
  category?: MarketCategory
  takerFeeRate?: number
}

export type QuoteRejectionCode =
  | 'MISSING_QUOTE'
  | 'INVALID_QUOTE'
  | 'STALE_QUOTE'
  | 'EXCESSIVE_SPREAD'

export type QuoteValidationResult =
  | {
      ok: true
      quote: ExecutablePredictionQuote
      feePerShare: number
      effectiveAsk: number
      feePctOfStake: number
    }
  | {
      ok: false
      code: QuoteRejectionCode
      reason: string
    }

export const DEFAULT_QUOTE_MAX_AGE_MS = 30_000
export const DEFAULT_MAX_EXECUTABLE_SPREAD = 0.2
const MAX_FUTURE_SKEW_MS = 5_000
const MIN_PROBABILITY_PRICE = 0.01
const MAX_PROBABILITY_PRICE = 0.99
const SYNTHETIC_GAMMA_HALF_SPREAD = 0.01

function roundPrice(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function clampProb(value: number): number {
  return roundPrice(
    Math.min(MAX_PROBABILITY_PRICE, Math.max(MIN_PROBABILITY_PRICE, value)),
  )
}

function isValidProb(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1
}

/**
 * Selects the currently active `'open'` Polymarket window covering `nowMs`,
 * or the closest open window that has not expired yet.
 */
export function pickBestOpenPolymarketWindow(
  windows: readonly PolymarketWindow[],
  nowMs: number,
): PolymarketWindow | null {
  let enclosing: PolymarketWindow | null = null
  let nearestFuture: PolymarketWindow | null = null

  for (const w of windows) {
    if (w.status !== 'open' || w.endTime <= nowMs) continue
    if (w.startTime <= nowMs) {
      if (!enclosing || w.startTime > enclosing.startTime) {
        enclosing = w
      }
    } else if (!nearestFuture || w.startTime < nearestFuture.startTime) {
      nearestFuture = w
    }
  }

  return enclosing ?? nearestFuture
}

/**
 * Converts a Polymarket Up/Down window into a normalized YES/NO executable quote.
 * Returns `null` when the market is closed/missing or has no usable price.
 */
export function buildQuoteFromPolymarketWindow(
  window: PolymarketWindow,
  outcome: PredictionOutcome,
  asOfMs: number,
): ExecutablePredictionQuote | null {
  if (window.status !== 'open') return null

  const hasClobBook =
    isValidProb(window.bestBid) &&
    isValidProb(window.bestAsk) &&
    window.bestAsk >= window.bestBid

  let bid: number
  let ask: number
  let source: QuoteSource

  if (hasClobBook) {
    if (outcome === 'YES') {
      bid = clampProb(window.bestBid!)
      ask = clampProb(window.bestAsk!)
    } else {
      bid = clampProb(1 - window.bestAsk!)
      ask = clampProb(1 - window.bestBid!)
    }
    source = 'polymarket-clob'
  } else if (isValidProb(window.upPriceNow)) {
    const p = outcome === 'YES' ? window.upPriceNow : 1 - window.upPriceNow
    bid = clampProb(p - SYNTHETIC_GAMMA_HALF_SPREAD)
    ask = clampProb(p + SYNTHETIC_GAMMA_HALF_SPREAD)
    source = 'polymarket-gamma'
  } else {
    return null
  }

  if (bid > ask) {
    const swap = bid
    bid = ask
    ask = swap
  }

  const mid = roundPrice((bid + ask) / 2)
  const spread = roundPrice(Math.max(0, ask - bid))

  return {
    instrumentId: window.slug,
    outcome,
    bid,
    ask,
    mid,
    spread,
    asOfMs,
    source,
    category: 'crypto',
    takerFeeRate: POLYMARKET_FEES.crypto.takerFeeRate,
  }
}

/**
 * Validates that a binary prediction quote exists, is well-formed, respects
 * spread bounds, and has not expired past `maxAgeMs`.
 */
export function validateExecutableQuote(
  quote: ExecutablePredictionQuote | null | undefined,
  nowMs: number,
  options?: {
    maxAgeMs?: number
    maxSpread?: number
  },
): QuoteValidationResult {
  if (!quote) {
    return {
      ok: false,
      code: 'MISSING_QUOTE',
      reason: 'Missing executable prediction quote (refusing 50c placeholder).',
    }
  }

  if (
    !Number.isFinite(quote.bid) ||
    !Number.isFinite(quote.ask) ||
    !Number.isFinite(quote.mid) ||
    !Number.isFinite(quote.asOfMs) ||
    quote.ask <= 0 ||
    quote.ask >= 1 ||
    quote.bid < 0 ||
    quote.bid > quote.ask
  ) {
    return {
      ok: false,
      code: 'INVALID_QUOTE',
      reason: `Malformed quote values (bid=${quote.bid}, ask=${quote.ask}).`,
    }
  }

  const maxAgeMs = Math.max(1_000, options?.maxAgeMs ?? DEFAULT_QUOTE_MAX_AGE_MS)
  const ageMs = nowMs - quote.asOfMs
  if (ageMs > maxAgeMs) {
    const ageSec = (ageMs / 1000).toFixed(1)
    const limitSec = (maxAgeMs / 1000).toFixed(1)
    return {
      ok: false,
      code: 'STALE_QUOTE',
      reason: `Stale quote for ${quote.instrumentId} (${ageSec}s old > ${limitSec}s limit).`,
    }
  }

  if (-ageMs > MAX_FUTURE_SKEW_MS) {
    return {
      ok: false,
      code: 'INVALID_QUOTE',
      reason: `Quote timestamp skew exceeds +${MAX_FUTURE_SKEW_MS / 1000}s.`,
    }
  }

  const spread = Math.max(0, quote.ask - quote.bid)
  const maxSpread = options?.maxSpread ?? DEFAULT_MAX_EXECUTABLE_SPREAD
  if (spread > maxSpread) {
    return {
      ok: false,
      code: 'EXCESSIVE_SPREAD',
      reason: `Quote spread ${(spread * 100).toFixed(1)}c exceeds ${(maxSpread * 100).toFixed(1)}c max.`,
    }
  }

  const category = quote.category ?? 'crypto'
  const takerFeeRate =
    quote.takerFeeRate ?? POLYMARKET_FEES[category].takerFeeRate
  const feePerShare = roundPrice(
    polymarketFeePerShare(quote.ask, {
      spreadCents: 0,
      feePct: 0,
      takerFeeRate,
      liquidityRole: 'taker',
    }),
  )
  const effectiveAsk = roundPrice(Math.min(MAX_PROBABILITY_PRICE, quote.ask + feePerShare))
  const feePctOfStake = roundPrice(
    quote.ask > 0 ? (feePerShare / quote.ask) * 100 : 0,
  )

  return {
    ok: true,
    quote: {
      ...quote,
      category,
      takerFeeRate,
      spread: roundPrice(spread),
    },
    feePerShare,
    effectiveAsk,
    feePctOfStake,
  }
}
