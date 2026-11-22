/**
 * Always-on `avoid` exclusions and `G1` / `G2` safety gates for the Polymarket
 * BTC Up/Down prediction engine. All checks fail closed on missing or non-finite data.
 *
 * Browser-and-server-safe (zero Node-only or `src/server/*` imports).
 */
import type { LiquidityRole } from '../../predictionMarket'
import { BITCOIN_20_PREDICTIONS } from '../../predictions'
import type {
  EngineBookSideSnapshot,
  GateFailureCode,
  SafetyGateConfig,
  SafetyGateResult,
  StrategyContext,
} from './types'

const EPSILON = 1e-9

export const DEFAULT_SAFETY_GATE_CONFIG: SafetyGateConfig = {
  macroHalfWindowMs: 30 * 60_000,
  maxVolatilityMultiplier: 3,
  minTop5DepthUsd: 200,
  maxSpread: 0.03,
  maxBookAgeMs: 10_000,
  maxFutureSkewMs: 5_000,
  maxOracleStaleMs: 15_000,
  maxBasisBps: 25,
  first60sBlockSec: 60,
}

/**
 * Legacy FLARE candle rules and explicitly rejected playbook exclusion IDs
 * that must never execute on live Polymarket 5m/15m/1h Up/Down markets.
 */
export const EXCLUDED_RESEARCH_RULE_IDS: ReadonlySet<string> = new Set([
  ...BITCOIN_20_PREDICTIONS.map((rule) => rule.id),
  'c15-signal-avoid',
  'c5-open-ignore',
  'c1d-updown-avoid',
])

export function isExcludedPredictionRuleId(ruleId: string): boolean {
  return EXCLUDED_RESEARCH_RULE_IDS.has(ruleId)
}

export function isEngineBookSideStale(
  side: EngineBookSideSnapshot | null,
  nowMs: number,
  maxAgeMs = DEFAULT_SAFETY_GATE_CONFIG.maxBookAgeMs,
  maxFutureSkewMs = DEFAULT_SAFETY_GATE_CONFIG.maxFutureSkewMs,
): boolean {
  if (!side || !Number.isFinite(side.asOfMs) || !Number.isFinite(nowMs)) {
    return true
  }
  const ageMs = nowMs - side.asOfMs
  return ageMs > maxAgeMs || -ageMs > maxFutureSkewMs
}

function isBookSideValidForSpread(
  side: EngineBookSideSnapshot | null,
  maxSpread: number,
): boolean {
  if (!side) return false
  if (
    side.bestBid === null ||
    side.bestAsk === null ||
    side.spread === null ||
    !Number.isFinite(side.bestBid) ||
    !Number.isFinite(side.bestAsk) ||
    !Number.isFinite(side.spread)
  ) {
    return false
  }
  if (side.bestBid <= 0 || side.bestAsk >= 1 || side.bestAsk < side.bestBid) {
    return false
  }
  const actualSpread = side.bestAsk - side.bestBid
  return (
    side.spread >= -EPSILON &&
    side.spread <= maxSpread + EPSILON &&
    actualSpread <= maxSpread + EPSILON
  )
}

export type EvaluateSafetyGatesOptions = {
  liquidityRole?: LiquidityRole
  candidateRuleId?: string
  config?: Partial<SafetyGateConfig>
}

/**
 * Evaluates `avoid` exclusions, `G1` regime/microstructure, and `G2` oracle/basis
 * integrity without short-circuiting across gate groups so UI telemetry can display
 * independent `avoidPassed`, `g1Passed`, and `g2Passed` states.
 */
export function evaluateSafetyGates(
  ctx: StrategyContext,
  options?: EvaluateSafetyGatesOptions,
): SafetyGateResult {
  const cfg: SafetyGateConfig = {
    ...DEFAULT_SAFETY_GATE_CONFIG,
    ...options?.config,
  }
  const liquidityRole: LiquidityRole = options?.liquidityRole ?? 'taker'
  const candidateRuleId = options?.candidateRuleId ?? ctx.candidateRuleId

  const codes: GateFailureCode[] = []
  const reasons: string[] = []

  let avoidPassed = true
  let g1Passed = true
  let g2Passed = true

  const failAvoid = (code: GateFailureCode, reason: string) => {
    avoidPassed = false
    codes.push(code)
    reasons.push(reason)
  }

  const failG1 = (code: GateFailureCode, reason: string) => {
    g1Passed = false
    codes.push(code)
    reasons.push(reason)
  }

  const failG2 = (code: GateFailureCode, reason: string) => {
    g2Passed = false
    codes.push(code)
    reasons.push(reason)
  }

  // -------------------------------------------------------------------------
  // Global avoid exclusions
  // -------------------------------------------------------------------------
  if (
    candidateRuleId !== undefined &&
    isExcludedPredictionRuleId(candidateRuleId)
  ) {
    failAvoid(
      'AVOID_EXCLUDED_RULE',
      `Rule '${candidateRuleId}' is excluded from live Polymarket Up/Down execution (research-only / avoid)`,
    )
  }

  if (
    (ctx.timeframe === '5m' || ctx.timeframe === '15m') &&
    liquidityRole !== 'maker' &&
    (!Number.isFinite(ctx.secondsElapsed) ||
      ctx.secondsElapsed < cfg.first60sBlockSec)
  ) {
    failAvoid(
      'AVOID_FIRST_60S',
      `First-${cfg.first60sBlockSec}s taker exclusion on ${ctx.timeframe} window (elapsed=${String(ctx.secondsElapsed)}s)`,
    )
  }

  // -------------------------------------------------------------------------
  // G1: Regime & Microstructure Gate
  // -------------------------------------------------------------------------
  if (!Number.isFinite(ctx.nowMs)) {
    failG1('G1_MACRO_BLACKOUT', 'Current timestamp nowMs is non-finite')
  } else {
    for (const blackout of ctx.macroBlackoutWindows) {
      if (!Number.isFinite(blackout.timestampMs)) continue
      const before =
        blackout.beforeMs !== undefined &&
        Number.isFinite(blackout.beforeMs) &&
        blackout.beforeMs >= 0
          ? blackout.beforeMs
          : cfg.macroHalfWindowMs
      const after =
        blackout.afterMs !== undefined &&
        Number.isFinite(blackout.afterMs) &&
        blackout.afterMs >= 0
          ? blackout.afterMs
          : cfg.macroHalfWindowMs
      if (
        ctx.nowMs >= blackout.timestampMs - before &&
        ctx.nowMs <= blackout.timestampMs + after
      ) {
        const label = blackout.label ? ` (${blackout.label})` : ''
        failG1(
          'G1_MACRO_BLACKOUT',
          `Inside macro blackout window${label} around ${blackout.timestampMs}`,
        )
        break
      }
    }
  }

  const { sigma1m, median24hSigma1m } = ctx.oracle
  if (
    sigma1m === null ||
    !Number.isFinite(sigma1m) ||
    sigma1m <= 0 ||
    median24hSigma1m === null ||
    !Number.isFinite(median24hSigma1m) ||
    median24hSigma1m <= 0
  ) {
    failG1(
      'G1_MISSING_VOLATILITY',
      'Missing or non-positive sigma1m / median24hSigma1m (fail-closed)',
    )
  } else if (sigma1m > cfg.maxVolatilityMultiplier * median24hSigma1m) {
    failG1(
      'G1_VOLATILITY_SPIKE',
      `Volatility spike: sigma1m=${sigma1m.toExponential(3)} > ${cfg.maxVolatilityMultiplier}x median=${median24hSigma1m.toExponential(3)}`,
    )
  }

  if (
    isEngineBookSideStale(
      ctx.book.yes,
      ctx.nowMs,
      cfg.maxBookAgeMs,
      cfg.maxFutureSkewMs,
    ) ||
    isEngineBookSideStale(
      ctx.book.no,
      ctx.nowMs,
      cfg.maxBookAgeMs,
      cfg.maxFutureSkewMs,
    )
  ) {
    failG1(
      'G1_STALE_BOOK',
      `Order book side missing or stale (> ${cfg.maxBookAgeMs}ms) on ${ctx.slug}`,
    )
  }

  if (
    !ctx.book.yes ||
    !ctx.book.no ||
    !Number.isFinite(ctx.book.minTop5DepthUsd) ||
    ctx.book.minTop5DepthUsd < cfg.minTop5DepthUsd ||
    !Number.isFinite(ctx.book.yes.top5DepthUsd) ||
    ctx.book.yes.top5DepthUsd < cfg.minTop5DepthUsd ||
    !Number.isFinite(ctx.book.no.top5DepthUsd) ||
    ctx.book.no.top5DepthUsd < cfg.minTop5DepthUsd
  ) {
    failG1(
      'G1_LOW_DEPTH',
      `Top-5 book depth below $${cfg.minTop5DepthUsd} floor (minTop5DepthUsd=${String(ctx.book.minTop5DepthUsd)})`,
    )
  }

  if (
    !isBookSideValidForSpread(ctx.book.yes, cfg.maxSpread) ||
    !isBookSideValidForSpread(ctx.book.no, cfg.maxSpread)
  ) {
    failG1(
      'G1_EXCESSIVE_SPREAD',
      `Order book spread exceeds ${cfg.maxSpread} or book is crossed/incomplete on ${ctx.slug}`,
    )
  }

  // -------------------------------------------------------------------------
  // G2: Oracle & Basis Integrity Gate
  // -------------------------------------------------------------------------
  if (
    ctx.resolutionSource !== 'chainlink-twap-60s' &&
    ctx.resolutionSource !== 'binance-1h-candle'
  ) {
    failG2(
      'G2_UNKNOWN_RESOLUTION_SOURCE',
      `Resolution source '${ctx.resolutionSource}' is unknown (fail-closed)`,
    )
  } else if (ctx.resolutionSource === 'chainlink-twap-60s') {
    const ageMs =
      ctx.oracle.chainlinkUpdatedAtMs !== null &&
      Number.isFinite(ctx.oracle.chainlinkUpdatedAtMs) &&
      Number.isFinite(ctx.nowMs)
        ? Math.max(
            ctx.oracle.chainlinkStaleMs,
            ctx.nowMs - ctx.oracle.chainlinkUpdatedAtMs,
          )
        : ctx.oracle.chainlinkStaleMs
    if (
      ctx.oracle.chainlinkTwap60s === null ||
      !Number.isFinite(ctx.oracle.chainlinkTwap60s) ||
      ctx.oracle.chainlinkTwap60s <= 0 ||
      !Number.isFinite(ageMs) ||
      ageMs > cfg.maxOracleStaleMs
    ) {
      failG2(
        'G2_STALE_ORACLE',
        `Chainlink TWAP oracle missing or stale (${String(ageMs)}ms > ${cfg.maxOracleStaleMs}ms)`,
      )
    }
  } else {
    const ageMs =
      ctx.oracle.binanceUpdatedAtMs !== null &&
      Number.isFinite(ctx.oracle.binanceUpdatedAtMs) &&
      Number.isFinite(ctx.nowMs)
        ? Math.max(
            ctx.oracle.binanceStaleMs,
            ctx.nowMs - ctx.oracle.binanceUpdatedAtMs,
          )
        : ctx.oracle.binanceStaleMs
    if (
      ctx.oracle.binancePrice === null ||
      !Number.isFinite(ctx.oracle.binancePrice) ||
      ctx.oracle.binancePrice <= 0 ||
      !Number.isFinite(ageMs) ||
      ageMs > cfg.maxOracleStaleMs
    ) {
      failG2(
        'G2_STALE_ORACLE',
        `Binance 1h reference oracle missing or stale (${String(ageMs)}ms > ${cfg.maxOracleStaleMs}ms)`,
      )
    }
  }

  if (
    ctx.oracle.basisBps === null ||
    !Number.isFinite(ctx.oracle.basisBps)
  ) {
    failG2(
      'G2_MISSING_BASIS',
      'Cross-venue oracle basisBps is missing or non-finite (fail-closed)',
    )
  } else if (Math.abs(ctx.oracle.basisBps) > cfg.maxBasisBps) {
    failG2(
      'G2_BASIS_DIVERGENCE',
      `Oracle basis divergence ${Math.abs(ctx.oracle.basisBps).toFixed(2)} bps > ${cfg.maxBasisBps} bps`,
    )
  }

  return {
    allowed: codes.length === 0,
    avoidPassed,
    g1Passed,
    g2Passed,
    codes,
    reasons,
  }
}
