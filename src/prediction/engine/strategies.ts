/**
 * Executable 8-strategy Polymarket BTC Up/Down portfolio registry (`5m`, `15m`, `1h`).
 * Every strategy passes `evaluateSafetyGates` before emitting intents and prices
 * Polymarket crypto taker fees / maker rebates via `POLYMARKET_FEES.crypto`.
 *
 * Browser-and-server-safe (zero Node-only or `src/server/*` imports).
 */
import {
  POLYMARKET_FEES,
  polymarketFeePerShare,
  type LiquidityRole,
  type MarketCostModel,
} from '../../predictionMarket'
import { computeNestedConditionalYes } from '../nowcast'
import { evaluateSafetyGates } from './gates'
import type {
  EngineBookSideSnapshot,
  EngineOrderBookSnapshot,
  PredictionEngineStrategyId,
  SafetyGateResult,
  StrategyContext,
  StrategyDefinition,
  StrategyIntent,
} from './types'

const EPSILON = 1e-9
const MIN_PROB = 0.0001
const MAX_PROB = 0.9999

const CRYPTO_TAKER_COST: MarketCostModel = {
  spreadCents: 0,
  feePct: 0,
  takerFeeRate: POLYMARKET_FEES.crypto.takerFeeRate,
  makerRebateShare: POLYMARKET_FEES.crypto.makerRebateShare,
  liquidityRole: 'taker',
}

const CRYPTO_MAKER_COST: MarketCostModel = {
  spreadCents: 0,
  feePct: 0,
  takerFeeRate: POLYMARKET_FEES.crypto.takerFeeRate,
  makerRebateShare: POLYMARKET_FEES.crypto.makerRebateShare,
  liquidityRole: 'maker',
}

function clampProb(p: number): number {
  if (!Number.isFinite(p)) return 0.5
  return Math.min(MAX_PROB, Math.max(MIN_PROB, p))
}

function roundPrice(p: number): number {
  return Math.round(p * 10_000) / 10_000
}

function resolveModelYesProbability(ctx: StrategyContext): number {
  if (
    ctx.calibratedPYes !== undefined &&
    ctx.calibratedPYes !== null &&
    Number.isFinite(ctx.calibratedPYes) &&
    ctx.calibratedPYes > 0 &&
    ctx.calibratedPYes < 1
  ) {
    return clampProb(ctx.calibratedPYes)
  }
  return clampProb(ctx.nowcast.pRawYes)
}

function resolveStakeUsd(ctx: StrategyContext): number {
  return ctx.stakeUsd !== undefined &&
    Number.isFinite(ctx.stakeUsd) &&
    ctx.stakeUsd > 0
    ? ctx.stakeUsd
    : 5
}

function deriveBookMidYes(book: EngineOrderBookSnapshot): number | null {
  if (book.yes?.mid !== null && book.yes?.mid !== undefined && Number.isFinite(book.yes.mid)) {
    return clampProb(book.yes.mid)
  }
  if (book.no?.mid !== null && book.no?.mid !== undefined && Number.isFinite(book.no.mid)) {
    return clampProb(1 - book.no.mid)
  }
  return null
}

function isValidAsk(ask: number | null | undefined): ask is number {
  return ask !== null && ask !== undefined && Number.isFinite(ask) && ask > 0 && ask < 1
}

function isValidBid(bid: number | null | undefined): bid is number {
  return bid !== null && bid !== undefined && Number.isFinite(bid) && bid > 0 && bid < 1
}

function costModelForRole(role: LiquidityRole): MarketCostModel {
  return role === 'maker' ? CRYPTO_MAKER_COST : CRYPTO_TAKER_COST
}

type SideCandidate = {
  outcome: 'YES' | 'NO'
  pSide: number
  ask: number
  edge: number
  sideBook: EngineBookSideSnapshot
}

function collectSideCandidates(
  ctx: StrategyContext,
  pYes: number,
): SideCandidate[] {
  const result: SideCandidate[] = []
  const yesBook = ctx.book.yes
  if (yesBook && isValidAsk(yesBook.bestAsk)) {
    const fee = polymarketFeePerShare(yesBook.bestAsk, CRYPTO_TAKER_COST)
    result.push({
      outcome: 'YES',
      pSide: pYes,
      ask: yesBook.bestAsk,
      edge: pYes - yesBook.bestAsk - fee,
      sideBook: yesBook,
    })
  }
  const noBook = ctx.book.no
  if (noBook && isValidAsk(noBook.bestAsk)) {
    const pNo = 1 - pYes
    const fee = polymarketFeePerShare(noBook.bestAsk, CRYPTO_TAKER_COST)
    result.push({
      outcome: 'NO',
      pSide: pNo,
      ask: noBook.bestAsk,
      edge: pNo - noBook.bestAsk - fee,
      sideBook: noBook,
    })
  }
  return result
}

// ---------------------------------------------------------------------------
// 1. c5-late-favorite
// ---------------------------------------------------------------------------
function evaluateC5LateFavorite(ctx: StrategyContext): StrategyIntent[] {
  if (ctx.timeframe !== '5m' || !ctx.nowcast.valid) return []
  if (
    !Number.isFinite(ctx.secondsRemaining) ||
    ctx.secondsRemaining < 30 ||
    ctx.secondsRemaining > 120
  ) {
    return []
  }
  if (!evaluateSafetyGates(ctx, { liquidityRole: 'taker' }).allowed) {
    return []
  }

  const pYes = resolveModelYesProbability(ctx)
  const stakeUsd = resolveStakeUsd(ctx)
  const qualifying = collectSideCandidates(ctx, pYes).filter(
    (c) =>
      c.pSide >= 0.94 - EPSILON &&
      c.ask <= c.pSide - 0.02 + EPSILON &&
      c.ask <= 0.97 + EPSILON &&
      c.edge > 0,
  )
  if (qualifying.length === 0) return []
  const best = qualifying.reduce((a, b) => (b.edge > a.edge ? b : a))

  return [
    {
      strategyId: 'c5-late-favorite',
      lane: 'high-hit-rate',
      slug: ctx.slug,
      timeframe: ctx.timeframe,
      outcome: best.outcome,
      side: 'BUY',
      liquidityRole: 'taker',
      orderType: 'FOK',
      limitPrice: best.ask,
      stakeUsd,
      pModel: best.pSide,
      expectedEdgePerShare: best.edge,
      reason: `5m late favorite ${best.outcome}: pModel=${best.pSide.toFixed(4)}, ask=${best.ask.toFixed(4)}, edge=${best.edge.toFixed(4)}`,
    },
  ]
}

// ---------------------------------------------------------------------------
// 2. c5-nowcast-maker
// ---------------------------------------------------------------------------
function evaluateC5NowcastMaker(ctx: StrategyContext): StrategyIntent[] {
  if (ctx.timeframe !== '5m' || !ctx.nowcast.valid) return []
  if (
    !Number.isFinite(ctx.secondsRemaining) ||
    ctx.secondsRemaining < 90 ||
    ctx.secondsRemaining > 240
  ) {
    return []
  }
  if (!Number.isFinite(ctx.nowcast.z) || Math.abs(ctx.nowcast.z) > 2.5) {
    return []
  }

  const pYes = resolveModelYesProbability(ctx)
  const stakeUsd = resolveStakeUsd(ctx)

  // Rare taker override when mispricing >= 10 cents and depth >= 3 * stakeUsd
  if (evaluateSafetyGates(ctx, { liquidityRole: 'taker' }).allowed) {
    const takerOverrides = collectSideCandidates(ctx, pYes).filter(
      (c) =>
        c.pSide - c.ask >= 0.10 - EPSILON &&
        Number.isFinite(c.sideBook.askDepthUsd) &&
        c.sideBook.askDepthUsd >= 3 * stakeUsd - EPSILON &&
        c.edge > 0,
    )
    if (takerOverrides.length > 0) {
      const best = takerOverrides.reduce((a, b) => (b.edge > a.edge ? b : a))
      return [
        {
          strategyId: 'c5-nowcast-maker',
          lane: 'edge',
          slug: ctx.slug,
          timeframe: ctx.timeframe,
          outcome: best.outcome,
          side: 'BUY',
          liquidityRole: 'taker',
          orderType: 'FOK',
          limitPrice: best.ask,
          stakeUsd,
          pModel: best.pSide,
          expectedEdgePerShare: best.edge,
          reason: `5m nowcast taker override ${best.outcome}: pModel=${best.pSide.toFixed(4)}, ask=${best.ask.toFixed(4)}, askDepth=$${best.sideBook.askDepthUsd.toFixed(0)}`,
        },
      ]
    }
  }

  // Standard two-sided post-only maker quotes
  if (!evaluateSafetyGates(ctx, { liquidityRole: 'maker' }).allowed) {
    return []
  }

  const midYes = deriveBookMidYes(ctx.book)
  if (midYes === null) return []

  const pQuoteYes = clampProb(0.75 * pYes + 0.25 * midYes)
  const sides: {
    outcome: 'YES' | 'NO'
    pQ: number
    pM: number
    sideBook: EngineBookSideSnapshot | null
  }[] = [
    { outcome: 'YES', pQ: pQuoteYes, pM: pYes, sideBook: ctx.book.yes },
    { outcome: 'NO', pQ: 1 - pQuoteYes, pM: 1 - pYes, sideBook: ctx.book.no },
  ]

  const intents: StrategyIntent[] = []
  for (const s of sides) {
    if (
      !s.sideBook ||
      !isValidAsk(s.sideBook.bestAsk) ||
      s.sideBook.spread === null ||
      !Number.isFinite(s.sideBook.spread)
    ) {
      continue
    }
    const feeRef = polymarketFeePerShare(s.pQ, CRYPTO_TAKER_COST)
    const buffer = Math.max(0.015, 0.35 * feeRef)
    const rawBid = s.pQ - buffer - s.sideBook.spread / 2
    let limitPrice = roundPrice(Math.min(rawBid, s.sideBook.bestAsk - 0.0001))
    if (limitPrice >= s.sideBook.bestAsk) {
      limitPrice = roundPrice(s.sideBook.bestAsk - 0.0001)
    }

    if (
      limitPrice < 0.01 ||
      limitPrice > 0.99 ||
      limitPrice >= s.sideBook.bestAsk
    ) {
      continue
    }

    const edge =
      s.pM - limitPrice - polymarketFeePerShare(limitPrice, CRYPTO_MAKER_COST)
    if (edge <= 0) continue

    intents.push({
      strategyId: 'c5-nowcast-maker',
      lane: 'edge',
      slug: ctx.slug,
      timeframe: ctx.timeframe,
      outcome: s.outcome,
      side: 'BUY',
      liquidityRole: 'maker',
      orderType: 'GTC',
      limitPrice,
      stakeUsd,
      pModel: s.pM,
      expectedEdgePerShare: edge,
      cancelAtSecondsRemaining: 20,
      reason: `5m nowcast maker ${s.outcome}: bid=${limitPrice.toFixed(4)}, pQuote=${s.pQ.toFixed(4)}, buffer=${buffer.toFixed(4)}, edge=${edge.toFixed(4)}`,
    })
  }

  return intents
}

// ---------------------------------------------------------------------------
// 3. c15-favorite-carry
// ---------------------------------------------------------------------------
function evaluateC15FavoriteCarry(ctx: StrategyContext): StrategyIntent[] {
  if (ctx.timeframe !== '15m' || !ctx.nowcast.valid) return []
  if (!Number.isFinite(ctx.secondsRemaining) || ctx.secondsRemaining < 300) {
    return []
  }
  if (!evaluateSafetyGates(ctx, { liquidityRole: 'taker' }).allowed) {
    return []
  }

  const pYes = resolveModelYesProbability(ctx)
  const stakeUsd = resolveStakeUsd(ctx)
  const qualifying = collectSideCandidates(ctx, pYes).filter(
    (c) =>
      c.ask >= 0.70 - EPSILON &&
      c.ask <= 0.88 + EPSILON &&
      c.ask <= c.pSide - 0.04 + EPSILON &&
      c.edge > 0,
  )
  if (qualifying.length === 0) return []
  const best = qualifying.reduce((a, b) => (b.edge > a.edge ? b : a))

  return [
    {
      strategyId: 'c15-favorite-carry',
      lane: 'edge',
      slug: ctx.slug,
      timeframe: ctx.timeframe,
      outcome: best.outcome,
      side: 'BUY',
      liquidityRole: 'taker',
      orderType: 'FOK',
      limitPrice: best.ask,
      stakeUsd,
      pModel: best.pSide,
      expectedEdgePerShare: best.edge,
      reason: `15m favorite carry ${best.outcome}: pModel=${best.pSide.toFixed(4)}, ask=${best.ask.toFixed(4)}, edge=${best.edge.toFixed(4)}`,
    },
  ]
}

// ---------------------------------------------------------------------------
// 4. c15-late-favorite-guarded
// ---------------------------------------------------------------------------
function evaluateC15LateFavoriteGuarded(ctx: StrategyContext): StrategyIntent[] {
  if (ctx.timeframe !== '15m' || !ctx.nowcast.valid) return []
  if (
    !Number.isFinite(ctx.secondsRemaining) ||
    ctx.secondsRemaining < 45 ||
    ctx.secondsRemaining > 180
  ) {
    return []
  }
  if (!evaluateSafetyGates(ctx, { liquidityRole: 'taker' }).allowed) {
    return []
  }

  const pYes = resolveModelYesProbability(ctx)
  const stakeUsd = resolveStakeUsd(ctx)
  const qualifying = collectSideCandidates(ctx, pYes).filter(
    (c) =>
      c.pSide >= 0.94 - EPSILON &&
      c.ask <= 0.96 + EPSILON &&
      c.pSide - c.ask >= 0.04 - EPSILON &&
      c.edge > 0,
  )
  if (qualifying.length === 0) return []
  const best = qualifying.reduce((a, b) => (b.edge > a.edge ? b : a))

  return [
    {
      strategyId: 'c15-late-favorite-guarded',
      lane: 'high-hit-rate',
      slug: ctx.slug,
      timeframe: ctx.timeframe,
      outcome: best.outcome,
      side: 'BUY',
      liquidityRole: 'taker',
      orderType: 'FOK',
      limitPrice: best.ask,
      stakeUsd,
      pModel: best.pSide,
      expectedEdgePerShare: best.edge,
      reason: `15m late favorite guarded ${best.outcome}: pModel=${best.pSide.toFixed(4)}, ask=${best.ask.toFixed(4)}, edge=${best.edge.toFixed(4)}`,
    },
  ]
}

// ---------------------------------------------------------------------------
// 5. c1h-late-nowcast
// ---------------------------------------------------------------------------
function evaluateC1hLateNowcast(ctx: StrategyContext): StrategyIntent[] {
  if (ctx.timeframe !== '1h' || !ctx.nowcast.valid) return []
  if (
    !Number.isFinite(ctx.secondsRemaining) ||
    ctx.secondsRemaining < 60 ||
    ctx.secondsRemaining > 600
  ) {
    return []
  }
  if (!Number.isFinite(ctx.nowcast.z) || Math.abs(ctx.nowcast.z) < 2.0) {
    return []
  }
  if (!evaluateSafetyGates(ctx, { liquidityRole: 'taker' }).allowed) {
    return []
  }

  const pYes = resolveModelYesProbability(ctx)
  const stakeUsd = resolveStakeUsd(ctx)
  const qualifying = collectSideCandidates(ctx, pYes).filter(
    (c) =>
      c.pSide >= 0.93 - EPSILON &&
      c.ask <= c.pSide - 0.02 + EPSILON &&
      c.ask <= 0.97 + EPSILON &&
      c.edge > 0,
  )
  if (qualifying.length === 0) return []
  const best = qualifying.reduce((a, b) => (b.edge > a.edge ? b : a))

  return [
    {
      strategyId: 'c1h-late-nowcast',
      lane: 'high-hit-rate',
      slug: ctx.slug,
      timeframe: ctx.timeframe,
      outcome: best.outcome,
      side: 'BUY',
      liquidityRole: 'taker',
      orderType: 'FOK',
      limitPrice: best.ask,
      stakeUsd,
      pModel: best.pSide,
      expectedEdgePerShare: best.edge,
      cancelAtSecondsRemaining: 30,
      reason: `1h late nowcast ${best.outcome}: z=${ctx.nowcast.z.toFixed(2)}, pModel=${best.pSide.toFixed(4)}, ask=${best.ask.toFixed(4)}`,
    },
  ]
}

// ---------------------------------------------------------------------------
// 6. c1h-exhaustion-limit
// ---------------------------------------------------------------------------
function evaluateC1hExhaustionLimit(ctx: StrategyContext): StrategyIntent[] {
  if (ctx.timeframe !== '1h' || !ctx.hourlyIndicators) return []
  const { consecutiveRedHours, rsi14 } = ctx.hourlyIndicators
  const exhausted =
    consecutiveRedHours >= 3 ||
    (rsi14 !== null && Number.isFinite(rsi14) && rsi14 < 35)
  if (!exhausted) return []

  if (!Number.isFinite(ctx.secondsRemaining) || ctx.secondsRemaining <= 3000) {
    return []
  }

  const yesAsk = ctx.book.yes?.bestAsk
  if (!isValidAsk(yesAsk) || yesAsk > 0.54 + EPSILON) {
    return []
  }

  const limitPrice = roundPrice(Math.min(0.52, yesAsk))
  const liquidityRole: LiquidityRole = limitPrice < yesAsk ? 'maker' : 'taker'
  if (!evaluateSafetyGates(ctx, { liquidityRole }).allowed) {
    return []
  }

  const pModel = 0.55
  const fee = polymarketFeePerShare(limitPrice, costModelForRole(liquidityRole))
  const edge = pModel - limitPrice - fee
  if (edge <= 0) return []

  const stakeUsd = resolveStakeUsd(ctx)
  return [
    {
      strategyId: 'c1h-exhaustion-limit',
      lane: 'edge',
      slug: ctx.slug,
      timeframe: ctx.timeframe,
      outcome: 'YES',
      side: 'BUY',
      liquidityRole,
      orderType: 'GTC',
      limitPrice,
      stakeUsd,
      pModel,
      expectedEdgePerShare: edge,
      cancelAtSecondsRemaining: 3000,
      reason: `1h exhaustion limit YES: redHours=${consecutiveRedHours}, rsi14=${String(rsi14)}, limit=${limitPrice.toFixed(4)} (${liquidityRole})`,
    },
  ]
}

// ---------------------------------------------------------------------------
// 7. cx-nested-coherence
// ---------------------------------------------------------------------------
function evaluateCxNestedCoherence(ctx: StrategyContext): StrategyIntent[] {
  const parent = ctx.nestedParent
  if (!parent) return []
  if (
    parent.resolutionSource !== 'chainlink-twap-60s' &&
    parent.resolutionSource !== 'binance-1h-candle'
  ) {
    return []
  }
  if (
    ctx.openTwap === null ||
    !Number.isFinite(ctx.openTwap) ||
    ctx.openTwap <= 0 ||
    !Number.isFinite(parent.openTwap) ||
    parent.openTwap <= 0
  ) {
    return []
  }

  const activeOraclePrice =
    ctx.resolutionSource === 'binance-1h-candle'
      ? ctx.oracle.binancePrice
      : ctx.oracle.chainlinkTwap60s
  const sigma1m = ctx.oracle.sigma1m
  if (
    activeOraclePrice === null ||
    !Number.isFinite(activeOraclePrice) ||
    activeOraclePrice <= 0 ||
    sigma1m === null ||
    !Number.isFinite(sigma1m) ||
    sigma1m <= 0
  ) {
    return []
  }

  if (
    parent.slug === ctx.slug ||
    !Number.isFinite(ctx.secondsRemaining) ||
    !Number.isFinite(parent.secondsRemaining) ||
    ctx.secondsRemaining < 0 ||
    parent.secondsRemaining <= 0 ||
    parent.secondsRemaining <= ctx.secondsRemaining
  ) {
    return []
  }

  if (!evaluateSafetyGates(ctx, { liquidityRole: 'taker' }).allowed) {
    return []
  }

  const buildParentContext = (
    parentBook: EngineOrderBookSnapshot,
  ): StrategyContext => ({
    ...ctx,
    slug: parent.slug,
    timeframe: parent.timeframe,
    resolutionSource: parent.resolutionSource,
    openTwap: parent.openTwap,
    secondsRemaining: parent.secondsRemaining,
    secondsElapsed: parent.secondsElapsed ?? 0,
    book: parentBook,
  })

  const childMarketMid = deriveBookMidYes(ctx.book)
  let parentMarketMid: number | null = null
  let parentGate: SafetyGateResult | null = null

  if (
    parent.marketMidYes !== undefined &&
    parent.marketMidYes !== null &&
    Number.isFinite(parent.marketMidYes)
  ) {
    parentMarketMid = clampProb(parent.marketMidYes)
  } else if (parent.book) {
    parentGate = evaluateSafetyGates(buildParentContext(parent.book), {
      liquidityRole: 'taker',
    })
    if (!parentGate.g1Passed || !parentGate.g2Passed) {
      return []
    }
    parentMarketMid = deriveBookMidYes(parent.book)
  }

  const nested = computeNestedConditionalYes(
    parent.openTwap,
    ctx.openTwap,
    activeOraclePrice,
    parent.secondsRemaining,
    ctx.secondsRemaining,
    sigma1m,
    {
      parentMarketMid: parentMarketMid ?? undefined,
      childMarketMid: childMarketMid ?? undefined,
      dislocationThreshold: 0.04,
    },
  )

  if (
    !nested.valid ||
    !nested.dislocated ||
    nested.recommendedLeg === null ||
    nested.recommendedOutcome === null
  ) {
    return []
  }

  let targetBook: EngineOrderBookSnapshot = ctx.book
  let targetSlug = ctx.slug
  let targetTimeframe = ctx.timeframe
  let pYesTarget = nested.pChildImpliedByParentMarket ?? nested.pChildYes

  if (nested.recommendedLeg === 'parent') {
    if (!parent.book) return []
    const effectiveParentGate =
      parentGate ??
      evaluateSafetyGates(buildParentContext(parent.book), {
        liquidityRole: 'taker',
      })
    if (!effectiveParentGate.allowed) {
      return []
    }
    targetBook = parent.book
    targetSlug = parent.slug
    targetTimeframe = parent.timeframe
    pYesTarget = nested.pParentYes
  }

  const outcome = nested.recommendedOutcome
  const pSide = outcome === 'YES' ? pYesTarget : 1 - pYesTarget
  const sideBook = outcome === 'YES' ? targetBook.yes : targetBook.no
  const ask = sideBook?.bestAsk
  if (!isValidAsk(ask)) return []

  const fee = polymarketFeePerShare(ask, CRYPTO_TAKER_COST)
  const edge = pSide - ask - fee
  if (edge <= 0) return []

  const stakeUsd = resolveStakeUsd(ctx)
  return [
    {
      strategyId: 'cx-nested-coherence',
      lane: 'edge',
      slug: targetSlug,
      timeframe: targetTimeframe,
      outcome,
      side: 'BUY',
      liquidityRole: 'taker',
      orderType: 'FOK',
      limitPrice: ask,
      stakeUsd,
      pModel: pSide,
      expectedEdgePerShare: edge,
      cancelAtSecondsRemaining: 30,
      reason: `Nested coherence ${nested.recommendedLeg} ${outcome}: dislocation=${nested.dislocation.toFixed(4)}, corr=${nested.correlation.toFixed(3)}, ask=${ask.toFixed(4)}`,
    },
  ]
}

// ---------------------------------------------------------------------------
// 8. c5-15-longshot-fade
// ---------------------------------------------------------------------------
function evaluateC515LongshotFade(ctx: StrategyContext): StrategyIntent[] {
  if ((ctx.timeframe !== '5m' && ctx.timeframe !== '15m') || !ctx.nowcast.valid) {
    return []
  }
  if (!evaluateSafetyGates(ctx, { liquidityRole: 'taker' }).allowed) {
    return []
  }

  const pYes = resolveModelYesProbability(ctx)
  const pNo = 1 - pYes
  const stakeUsd = resolveStakeUsd(ctx)

  const yesBid = ctx.book.yes?.bestBid
  const yesAsk = ctx.book.yes?.bestAsk
  const noBid = ctx.book.no?.bestBid
  const noAsk = ctx.book.no?.bestAsk

  const candidates: {
    outcome: 'YES' | 'NO'
    ask: number
    pFav: number
    edge: number
    oppositeBid: number
  }[] = []

  // Orientation A: NO is overpriced [0.20, 0.30] -> buy YES favorite [0.70, 0.80]
  if (
    isValidBid(noBid) &&
    isValidAsk(yesAsk) &&
    noBid >= 0.20 - EPSILON &&
    noBid <= 0.30 + EPSILON &&
    noBid >= pNo + 0.05 - EPSILON &&
    yesAsk >= 0.70 - EPSILON &&
    yesAsk <= 0.80 + EPSILON &&
    yesAsk <= pYes - 0.03 + EPSILON
  ) {
    const edge = pYes - yesAsk - polymarketFeePerShare(yesAsk, CRYPTO_TAKER_COST)
    if (edge > 0) {
      candidates.push({
        outcome: 'YES',
        ask: yesAsk,
        pFav: pYes,
        edge,
        oppositeBid: noBid,
      })
    }
  }

  // Orientation B: YES is overpriced [0.20, 0.30] -> buy NO favorite [0.70, 0.80]
  if (
    isValidBid(yesBid) &&
    isValidAsk(noAsk) &&
    yesBid >= 0.20 - EPSILON &&
    yesBid <= 0.30 + EPSILON &&
    yesBid >= pYes + 0.05 - EPSILON &&
    noAsk >= 0.70 - EPSILON &&
    noAsk <= 0.80 + EPSILON &&
    noAsk <= pNo - 0.03 + EPSILON
  ) {
    const edge = pNo - noAsk - polymarketFeePerShare(noAsk, CRYPTO_TAKER_COST)
    if (edge > 0) {
      candidates.push({
        outcome: 'NO',
        ask: noAsk,
        pFav: pNo,
        edge,
        oppositeBid: yesBid,
      })
    }
  }

  if (candidates.length === 0) return []
  const best = candidates.reduce((a, b) => (b.edge > a.edge ? b : a))

  return [
    {
      strategyId: 'c5-15-longshot-fade',
      lane: 'edge',
      slug: ctx.slug,
      timeframe: ctx.timeframe,
      outcome: best.outcome,
      side: 'BUY',
      liquidityRole: 'taker',
      orderType: 'FOK',
      limitPrice: best.ask,
      stakeUsd,
      pModel: best.pFav,
      expectedEdgePerShare: best.edge,
      reason: `Longshot fade -> buy ${best.outcome} at ${best.ask.toFixed(4)} (opposite bid=${best.oppositeBid.toFixed(4)}, pFav=${best.pFav.toFixed(4)})`,
    },
  ]
}

// ---------------------------------------------------------------------------
// Canonical 8-Strategy Registry
// ---------------------------------------------------------------------------
export const STRATEGY_REGISTRY: readonly StrategyDefinition[] = [
  {
    id: 'c5-late-favorite',
    name: '5m Late Favorite Sweep',
    lane: 'high-hit-rate',
    timeframes: ['5m'],
    defaultMode: 'paper',
    defaultRole: 'taker',
    description:
      'Buys high-conviction 5m favorites (pModel >= 0.94, ask <= min(0.97, pModel - 0.02)) in the final 30-120s.',
    evaluate: evaluateC5LateFavorite,
  },
  {
    id: 'c5-nowcast-maker',
    name: '5m TWAP Nowcast Maker',
    lane: 'edge',
    timeframes: ['5m'],
    defaultMode: 'paper',
    defaultRole: 'maker',
    description:
      'Posts two-sided GTC maker bids around blended diffusion fair value in 90-240s remaining when |z| <= 2.5, with rare >=10c taker override.',
    evaluate: evaluateC5NowcastMaker,
  },
  {
    id: 'c15-favorite-carry',
    name: '15m 70-88c Favorite Carry',
    lane: 'edge',
    timeframes: ['15m'],
    defaultMode: 'paper',
    defaultRole: 'taker',
    description:
      'Buys 15m favorites priced in [0.70, 0.88] with >= 4c discount to pModel and >= 300s remaining.',
    evaluate: evaluateC15FavoriteCarry,
  },
  {
    id: 'c15-late-favorite-guarded',
    name: '15m Late Favorite Guarded',
    lane: 'high-hit-rate',
    timeframes: ['15m'],
    defaultMode: 'research',
    defaultRole: 'taker',
    description:
      'High-hit-rate 15m late favorite entry (45-180s remaining) requiring pModel >= 0.94, ask <= 0.96, and strict 4c edge floor.',
    evaluate: evaluateC15LateFavoriteGuarded,
  },
  {
    id: 'c1h-late-nowcast',
    name: '1h Late Nowcast Taker',
    lane: 'high-hit-rate',
    timeframes: ['1h'],
    defaultMode: 'research',
    defaultRole: 'taker',
    description:
      'Buys high-conviction 1h Binance-resolved favorites in final 60-600s when |z| >= 2.0 and pModel >= 0.93.',
    evaluate: evaluateC1hLateNowcast,
  },
  {
    id: 'c1h-exhaustion-limit',
    name: '1h Exhaustion Reversal Limit',
    lane: 'edge',
    timeframes: ['1h'],
    defaultMode: 'paper',
    defaultRole: 'maker',
    description:
      'After >= 3 consecutive red hours or RSI14 < 35, posts GTC BUY YES limit at min(0.52, ask) if ask <= 0.54, canceling at T+10m.',
    evaluate: evaluateC1hExhaustionLimit,
  },
  {
    id: 'cx-nested-coherence',
    name: 'Cross-Timeframe Nested Coherence',
    lane: 'edge',
    timeframes: ['5m', '15m', '1h'],
    defaultMode: 'research',
    defaultRole: 'taker',
    description:
      'Detects >= 4c bivariate Gaussian conditional dislocation between nested child and parent timeframes and trades the mispriced leg.',
    evaluate: evaluateCxNestedCoherence,
  },
  {
    id: 'c5-15-longshot-fade',
    name: '5m/15m Longshot Bias Fade',
    lane: 'edge',
    timeframes: ['5m', '15m'],
    defaultMode: 'paper',
    defaultRole: 'taker',
    description:
      'Fades overpriced [0.20, 0.30] longshots (>= 5c over model) by buying the discounted [0.70, 0.80] favorite (>= 3c below model).',
    evaluate: evaluateC515LongshotFade,
  },
] as const

const STRATEGY_BY_ID: ReadonlyMap<PredictionEngineStrategyId, StrategyDefinition> =
  new Map(STRATEGY_REGISTRY.map((def) => [def.id, def]))

export function getStrategyDefinition(
  id: PredictionEngineStrategyId,
): StrategyDefinition {
  const def = STRATEGY_BY_ID.get(id)
  if (!def) {
    throw new Error(`Unknown prediction engine strategy ID: ${String(id)}`)
  }
  return def
}

export function evaluateStrategy(
  id: PredictionEngineStrategyId,
  ctx: StrategyContext,
): StrategyIntent[] {
  return getStrategyDefinition(id).evaluate(ctx)
}

export function evaluateAllStrategies(ctx: StrategyContext): StrategyIntent[] {
  const intents: StrategyIntent[] = []
  for (const def of STRATEGY_REGISTRY) {
    intents.push(...def.evaluate(ctx))
  }
  return intents
}
