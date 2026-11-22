/**
 * Prediction-market evaluation engine: net edge vs. contract price, binary
 * Kelly sizing, base-rate priors, non-overlapping cooldowns, YES/NO selection,
 * rule confluence, train/test split, and Monte Carlo sequence risk.
 *
 * Conventions:
 * - All probabilities and contract prices live in [0, 1]; a winning contract pays 1.
 * - Effective price = ask (mid + spread/2) plus notional entry fee.
 * - Net edge = calibrated probability - effective entry price.
 */
import type { Candle } from './types'
import {
  buildMarketContext,
  computeWilsonLowerBoundPct,
  type MarketContext,
  type PredictionRule,
} from './predictions'

const PREDICTION_WARMUP = 50
/** Prior weight (in virtual observations) centered on the historical base rate. */
const PRIOR_STRENGTH = 10
const MIN_PRICE = 0.01
const MAX_PRICE = 0.99

type ContractSide = 'YES' | 'NO'
export type SizingMode = 'fixed' | 'quarter-kelly' | 'full-kelly'

/** Fee categories published by Polymarket (2026-11 schedule). */
export type MarketCategory =
  | 'crypto'
  | 'sports'
  | 'politics'
  | 'finance'
  | 'economics'
  | 'culture'
  | 'weather'
  | 'tech'
  | 'mentions'
  | 'geopolitics'
  | 'other'
  | 'combos'

/** Taker pays the fee curve; maker pays zero and may receive a rebate. */
export type LiquidityRole = 'taker' | 'maker'

export type PolymarketFeeSchedule = {
  /** Taker fee rate used in `C x rate x p x (1 - p)`. */
  takerFeeRate: number
  /** Share of the taker fee pool redistributed to makers (0..1). */
  makerRebateShare: number
}

/**
 * Verified against https://docs.polymarket.com/trading/fees on 2026-11-15.
 * Geopolitics is fee-free by design.
 */
export const POLYMARKET_FEES: Record<MarketCategory, PolymarketFeeSchedule> = {
  crypto: { takerFeeRate: 0.07, makerRebateShare: 0.2 },
  sports: { takerFeeRate: 0.05, makerRebateShare: 0.15 },
  politics: { takerFeeRate: 0.04, makerRebateShare: 0.25 },
  finance: { takerFeeRate: 0.04, makerRebateShare: 0.25 },
  economics: { takerFeeRate: 0.05, makerRebateShare: 0.25 },
  culture: { takerFeeRate: 0.05, makerRebateShare: 0.25 },
  weather: { takerFeeRate: 0.05, makerRebateShare: 0.25 },
  tech: { takerFeeRate: 0.04, makerRebateShare: 0.25 },
  mentions: { takerFeeRate: 0.04, makerRebateShare: 0.25 },
  geopolitics: { takerFeeRate: 0, makerRebateShare: 0 },
  other: { takerFeeRate: 0.05, makerRebateShare: 0.25 },
  combos: { takerFeeRate: 0.05, makerRebateShare: 0 },
}

export type MarketCostModel = {
  /** Total bid-ask spread in cents per contract (2 = 0.02). */
  spreadCents: number
  /** Flat entry commission over notional stake, in %. Composes with the curve. */
  feePct: number
  /**
   * Polymarket price-dependent taker fee rate. When omitted the engine keeps the
   * legacy flat-fee behaviour (`feePct` only).
   */
  takerFeeRate?: number
  /** Share of the taker fee pool rebated to makers. Only used when role = maker. */
  makerRebateShare?: number
  /** Defaults to `taker`, matching every existing call site. */
  liquidityRole?: LiquidityRole
}

export type SimulationConfig = {
  initialBankroll: number
  sizing: SizingMode
  /** Fixed mode: % of initial bankroll allocated per ticket. */
  fixedStakePct: number
  /** Hard cap per ticket as % of current equity. */
  maxStakePct: number
  /** Minimum net edge (percentage points of probability) required to enter. */
  minEdgePct: number
  allowNo: boolean
  /** Minimum concurrent active rules on the same candle (1 = unfiltered). */
  minConfluence: number
  useCooldown: boolean
  /** Share of candles reserved for calibration (0.5 - 0.9). */
  trainRatio: number
  costs: MarketCostModel
  monteCarloRuns: number
  seed: number
}

const DEFAULT_COSTS: MarketCostModel = { spreadCents: 2, feePct: 1 }

export const DEFAULT_SIMULATION_CONFIG: SimulationConfig = {
  initialBankroll: 1000,
  sizing: 'quarter-kelly',
  fixedStakePct: 2,
  maxStakePct: 5,
  minEdgePct: 3,
  allowNo: true,
  minConfluence: 1,
  useCooldown: true,
  trainRatio: 0.7,
  costs: DEFAULT_COSTS,
  monteCarloRuns: 1000,
  seed: 42,
}

// ---------------------------------------------------------------------------
// Pricing and edge math
// ---------------------------------------------------------------------------

function clampPrice(p: number): number {
  if (!Number.isFinite(p)) return 0.5
  return Math.min(MAX_PRICE, Math.max(MIN_PRICE, p))
}

/**
 * Signed fee per share at `price`:
 * - taker: `rate x p x (1 - p)` (always positive)
 * - maker: `-rebateShare x rate x p x (1 - p)` (a rebate credit)
 *
 * Returns 0 when no `takerFeeRate` is configured, preserving legacy behaviour.
 */
export function polymarketFeePerShare(price: number, costs: MarketCostModel): number {
  const p = clampPrice(price)
  const rate = Math.max(0, costs.takerFeeRate ?? 0)
  if (rate === 0) return 0
  const curve = p * (1 - p)
  if ((costs.liquidityRole ?? 'taker') === 'maker') {
    return -Math.max(0, Math.min(1, costs.makerRebateShare ?? 0)) * rate * curve
  }
  return rate * curve
}

/** Fee (or maker rebate) as a % of the USDC stake at `price`. */
export function polymarketFeePctOfStake(
  price: number,
  category: MarketCategory,
  role: LiquidityRole = 'taker',
): number {
  const p = clampPrice(price)
  const schedule = POLYMARKET_FEES[category]
  const rate = schedule.takerFeeRate
  if (role === 'maker') {
    return -schedule.makerRebateShare * rate * (1 - p) * 100
  }
  return rate * (1 - p) * 100
}

/**
 * Cost model using the real Polymarket schedule for a category.
 * `spreadCents` is the observed bid-ask spread, not half of it.
 */
export function costModelForCategory(
  category: MarketCategory,
  role: LiquidityRole = 'taker',
  spreadCents = 1,
): MarketCostModel {
  const schedule = POLYMARKET_FEES[category]
  return {
    spreadCents: Math.max(0, spreadCents),
    feePct: 0,
    takerFeeRate: schedule.takerFeeRate,
    makerRebateShare: schedule.makerRebateShare,
    liquidityRole: role,
  }
}

/**
 * Effective contract entry cost: ask + flat fee + price-dependent Polymarket fee
 * (or maker rebate). Identical to the legacy formula when `takerFeeRate` is unset.
 */
export function effectiveEntryPrice(mid: number, costs: MarketCostModel): number {
  const ask = clampPrice(mid + costs.spreadCents / 200)
  const flat = 1 + Math.max(0, costs.feePct) / 100
  const shaped = polymarketFeePerShare(ask, costs)
  return Math.min(MAX_PRICE, ask * flat + shaped)
}

/** All-in entry cost as a % of the quoted mid (spread + fee, or minus rebate). */
export function entryCostPct(mid: number, costs: MarketCostModel): number {
  const base = clampPrice(mid)
  const allIn = effectiveEntryPrice(base, costs)
  return ((allIn - base) / base) * 100
}

/** Full Kelly fraction for a binary payout of 1 purchased at `price`. */
export function binaryKellyFraction(probability: number, price: number): number {
  if (price <= 0 || price >= 1) return 0
  return Math.max(0, (probability - price) / (1 - price))
}

/**
 * Beta-shrunk probability estimate centered on the base rate:
 * converges toward fair base pricing under small sample sizes (no false edge).
 */
export function shrinkProbability(
  hits: number,
  triggers: number,
  baseRate: number,
  strength = PRIOR_STRENGTH,
): number {
  const base = clampPrice(baseRate)
  if (triggers <= 0) return base
  return (hits + strength * base) / (triggers + strength)
}

type SideDecision = {
  side: ContractSide
  price: number
  probability: number
  edge: number
}

/** Picks whichever contract side yields higher net edge above `minEdge` (fraction). */
export function chooseSide(
  probabilityYes: number,
  marketMidYes: number,
  costs: MarketCostModel,
  minEdge: number,
  allowNo: boolean,
): SideDecision | null {
  const yesPrice = effectiveEntryPrice(marketMidYes, costs)
  const noPrice = effectiveEntryPrice(1 - marketMidYes, costs)
  const yes: SideDecision = {
    side: 'YES',
    price: yesPrice,
    probability: probabilityYes,
    edge: probabilityYes - yesPrice,
  }
  const no: SideDecision = {
    side: 'NO',
    price: noPrice,
    probability: 1 - probabilityYes,
    edge: 1 - probabilityYes - noPrice,
  }
  const candidates = [yes, ...(allowNo ? [no] : [])].filter(
    (c) => c.edge > 0 && c.edge >= minEdge,
  )
  if (candidates.length === 0) return null
  return candidates.reduce((best, c) => (c.edge > best.edge ? c : best))
}

// ---------------------------------------------------------------------------
// Signals, base rate, and per-rule diagnostics
// ---------------------------------------------------------------------------

type RuleSignal = { index: number; resolveIndex: number; hit: boolean }

/** Last entry index whose resolution still falls inside the candle series. */
function lastEntryIndex(length: number, horizonBars: number): number {
  return length - 1 - horizonBars
}

/**
 * Collects rule triggers across `[from, to]`. With cooldown enabled, skips new
 * signals on the same rule until the previous horizon resolves.
 */
export function collectRuleSignals(
  rule: PredictionRule,
  ctx: MarketContext,
  from: number,
  to: number,
  useCooldown: boolean,
): RuleSignal[] {
  const signals: RuleSignal[] = []
  const end = Math.min(to, lastEntryIndex(ctx.candles.length, rule.horizonBars))
  let nextAllowed = from
  for (let i = Math.max(from, 0); i <= end; i++) {
    if (useCooldown && i < nextAllowed) continue
    if (!rule.condition(ctx, i)) continue
    signals.push({
      index: i,
      resolveIndex: i + rule.horizonBars,
      hit: rule.resolve(ctx, i),
    })
    nextAllowed = i + rule.horizonBars
  }
  return signals
}

/** Unconditional YES resolution probability across `[from, to]`. */
function computeBaseRate(
  rule: PredictionRule,
  ctx: MarketContext,
  from: number,
  to: number,
): number {
  const end = Math.min(to, lastEntryIndex(ctx.candles.length, rule.horizonBars))
  let total = 0
  let yes = 0
  for (let i = Math.max(from, 0); i <= end; i++) {
    total++
    if (rule.resolve(ctx, i)) yes++
  }
  return total > 0 ? yes / total : 0.5
}

export type RuleMarketStats = {
  ruleId: string
  number: number
  title: string
  contractQuestion: string
  horizonBars: number
  category: PredictionRule['category']
  triggers: number
  hits: number
  winRatePct: number
  wilsonLowerBoundPct: number
  baseRatePct: number
  /** Win rate minus base rate: value added over always buying YES. */
  liftPct: number
  probabilityPct: number
  marketMidYes: number
  priceSource: 'modeled' | 'real'
  side: ContractSide | null
  entryPrice: number
  netEdgePct: number
  kellyFullPct: number
  kellyQuarterPct: number
  currentlyActive: boolean
  recentOutcomes: boolean[]
}

const round1 = (v: number) => Math.round(v * 10) / 10

/**
 * Scores a rule over the full series. Uses the unconditional base rate as the
 * modeled market midpoint unless a live `marketMidOverride` quote is supplied.
 */
function analyzeRuleMarket(
  rule: PredictionRule,
  ctx: MarketContext,
  costs: MarketCostModel,
  useCooldown = true,
  marketMidOverride?: number,
): RuleMarketStats {
  const from = PREDICTION_WARMUP
  const to = lastEntryIndex(ctx.candles.length, rule.horizonBars)
  const signals = collectRuleSignals(rule, ctx, from, to, useCooldown)
  const triggers = signals.length
  const hits = signals.filter((s) => s.hit).length
  const baseRate = computeBaseRate(rule, ctx, from, to)
  const probability = shrinkProbability(hits, triggers, baseRate)
  const marketMid = clampPrice(marketMidOverride ?? baseRate)
  const decision = chooseSide(probability, marketMid, costs, 0, true)
  const kellyFull = decision
    ? binaryKellyFraction(decision.probability, decision.price)
    : 0
  const winRate = triggers > 0 ? hits / triggers : 0
  const lastIdx = ctx.candles.length - 1

  return {
    ruleId: rule.id,
    number: rule.number,
    title: rule.title,
    contractQuestion: rule.contractQuestion,
    horizonBars: rule.horizonBars,
    category: rule.category,
    triggers,
    hits,
    winRatePct: round1(winRate * 100),
    wilsonLowerBoundPct: computeWilsonLowerBoundPct(hits, triggers),
    baseRatePct: round1(baseRate * 100),
    liftPct: triggers > 0 ? round1((winRate - baseRate) * 100) : 0,
    probabilityPct: round1(probability * 100),
    marketMidYes: Math.round(marketMid * 100) / 100,
    priceSource: marketMidOverride === undefined ? 'modeled' : 'real',
    side: decision?.side ?? null,
    entryPrice: decision ? Math.round(decision.price * 1000) / 1000 : 0,
    netEdgePct: decision ? round1(decision.edge * 100) : 0,
    kellyFullPct: round1(kellyFull * 100),
    kellyQuarterPct: round1(kellyFull * 25),
    currentlyActive: lastIdx >= from ? rule.condition(ctx, lastIdx) : false,
    recentOutcomes: signals.slice(-16).map((s) => s.hit),
  }
}

export function analyzeRulesMarket(
  rules: PredictionRule[],
  candles: Candle[],
  costs: MarketCostModel,
  useCooldown = true,
): RuleMarketStats[] {
  if (candles.length <= PREDICTION_WARMUP + 2) return []
  const ctx = buildMarketContext(candles)
  return rules.map((rule) => analyzeRuleMarket(rule, ctx, costs, useCooldown))
}

// ---------------------------------------------------------------------------
// Strategy simulation (train -> test)
// ---------------------------------------------------------------------------

type RuleCalibration = {
  ruleId: string
  number: number
  title: string
  trainTriggers: number
  trainHits: number
  baseRate: number
  probability: number
}

type SimTicket = {
  ruleId: string
  ruleNumber: number
  entryIndex: number
  resolveIndex: number
  entryTime: number
  resolveTime: number
  side: ContractSide
  price: number
  probability: number
  edge: number
  stake: number
  contracts: number
  confluence: number
  won: boolean
  pnl: number
  equityAtEntry: number
}

export type EquityPoint = { time: number; value: number }

type MonteCarloSummary = {
  runs: number
  finalP5: number
  finalP50: number
  finalP95: number
  maxDrawdownP50: number
  maxDrawdownP95: number
  /** % of simulated runs ending below 50% of initial bankroll. */
  ruinPct: number
}

type SimulationMetrics = {
  finalBankroll: number
  roiPct: number
  maxDrawdownPct: number
  tickets: number
  wins: number
  winRatePct: number
  avgEdgePct: number
  avgStake: number
  profitFactor: number | null
  longestLosingStreak: number
  yesTickets: number
  noTickets: number
  skippedNoEdge: number
  skippedConfluence: number
  /** Signals with no available real market quote or unresolved outcome (real mode only). */
  skippedNoMarket: number
}

/** Live contract quote for `rule` opened at candle `entryIndex`. */
type MarketQuote = { mid: number; resolvedYes: boolean | null }
export type QuoteProvider = (rule: PredictionRule, entryIndex: number) => MarketQuote | null

export type SimulationResult = {
  insufficientData: boolean
  priceSource: 'modeled' | 'real'
  trainFromTime: number | null
  testFromTime: number | null
  testToTime: number | null
  calibration: RuleCalibration[]
  tickets: SimTicket[]
  equity: EquityPoint[]
  metrics: SimulationMetrics
  monteCarlo: MonteCarloSummary | null
}

const EMPTY_METRICS = (bankroll: number): SimulationMetrics => ({
  finalBankroll: bankroll,
  roiPct: 0,
  maxDrawdownPct: 0,
  tickets: 0,
  wins: 0,
  winRatePct: 0,
  avgEdgePct: 0,
  avgStake: 0,
  profitFactor: null,
  longestLosingStreak: 0,
  yesTickets: 0,
  noTickets: 0,
  skippedNoEdge: 0,
  skippedConfluence: 0,
  skippedNoMarket: 0,
})

/** Index of the first out-of-sample test candle. */
export function splitBoundary(length: number, trainRatio: number): number {
  const ratio = Math.min(0.9, Math.max(0.5, trainRatio))
  const usable = length - PREDICTION_WARMUP
  return PREDICTION_WARMUP + Math.floor(usable * ratio)
}

export function maxDrawdownPct(values: number[]): number {
  let peak = -Infinity
  let maxDd = 0
  for (const v of values) {
    if (v > peak) peak = v
    if (peak > 0) maxDd = Math.max(maxDd, (peak - v) / peak)
  }
  return round1(maxDd * 100)
}

function computeStake(
  config: SimulationConfig,
  decision: SideDecision,
  equity: number,
  cash: number,
): number {
  let stake: number
  if (config.sizing === 'fixed') {
    stake = (config.fixedStakePct / 100) * config.initialBankroll
  } else {
    const k = binaryKellyFraction(decision.probability, decision.price)
    stake = k * (config.sizing === 'quarter-kelly' ? 0.25 : 1) * equity
  }
  stake = Math.min(stake, (config.maxStakePct / 100) * equity, cash)
  return stake >= 0.01 ? Math.floor(stake * 100) / 100 : 0
}

export function simulatePredictionStrategy(
  candles: Candle[],
  rules: PredictionRule[],
  config: SimulationConfig = DEFAULT_SIMULATION_CONFIG,
  quoteProvider?: QuoteProvider,
): SimulationResult {
  const bankroll = config.initialBankroll
  const maxHorizon = rules.reduce((m, r) => Math.max(m, r.horizonBars), 0)
  const boundary = splitBoundary(candles.length, config.trainRatio)
  const testEnd = candles.length - 1

  if (
    rules.length === 0 ||
    candles.length < PREDICTION_WARMUP + 40 ||
    boundary - 1 - maxHorizon <= PREDICTION_WARMUP ||
    testEnd - maxHorizon <= boundary
  ) {
    return {
      insufficientData: true,
      priceSource: quoteProvider ? 'real' : 'modeled',
      trainFromTime: null,
      testFromTime: null,
      testToTime: null,
      calibration: [],
      tickets: [],
      equity: [],
      metrics: EMPTY_METRICS(bankroll),
      monteCarlo: null,
    }
  }

  const ctx = buildMarketContext(candles)

  // 1) Calibration: only training candles whose resolution completes before split boundary.
  const calibration: RuleCalibration[] = rules.map((rule) => {
    const trainTo = boundary - 1 - rule.horizonBars
    const signals = collectRuleSignals(
      rule,
      ctx,
      PREDICTION_WARMUP,
      trainTo,
      config.useCooldown,
    )
    const trainHits = signals.filter((s) => s.hit).length
    const baseRate = computeBaseRate(rule, ctx, PREDICTION_WARMUP, trainTo)
    return {
      ruleId: rule.id,
      number: rule.number,
      title: rule.title,
      trainTriggers: signals.length,
      trainHits,
      baseRate,
      probability: shrinkProbability(trainHits, signals.length, baseRate),
    }
  })

  // 2) Out-of-sample walk-forward simulation with shared bankroll.
  const nextAllowed = rules.map(() => boundary)
  const open: SimTicket[] = []
  const tickets: SimTicket[] = []
  const equity: EquityPoint[] = [
    { time: candles[boundary - 1].time, value: bankroll },
  ]
  let cash = bankroll
  let skippedNoEdge = 0
  let skippedConfluence = 0
  let skippedNoMarket = 0
  const minEdge = Math.max(0, config.minEdgePct) / 100
  const minConfluence = Math.max(1, Math.round(config.minConfluence))

  for (let t = boundary; t <= testEnd; t++) {
    // a) Settle contracts resolving on this candle.
    for (let k = open.length - 1; k >= 0; k--) {
      const ticket = open[k]
      if (ticket.resolveIndex !== t) continue
      if (ticket.won) cash += ticket.contracts
      open.splice(k, 1)
    }

    // b) Open newly triggered contracts.
    const active = rules.map(
      (rule) => t <= lastEntryIndex(candles.length, rule.horizonBars) && rule.condition(ctx, t),
    )
    const confluence = active.filter(Boolean).length

    rules.forEach((rule, r) => {
      if (!active[r]) return
      if (config.useCooldown && t < nextAllowed[r]) return
      nextAllowed[r] = t + rule.horizonBars
      if (confluence < minConfluence) {
        skippedConfluence++
        return
      }
      const cal = calibration[r]
      let marketMid = clampPrice(cal.baseRate)
      let realResolution: boolean | null = null
      if (quoteProvider) {
        const quote = quoteProvider(rule, t)
        if (!quote || quote.resolvedYes === null) {
          skippedNoMarket++
          return
        }
        marketMid = clampPrice(quote.mid)
        realResolution = quote.resolvedYes
      }
      const decision = chooseSide(
        cal.probability,
        marketMid,
        config.costs,
        minEdge,
        config.allowNo,
      )
      if (!decision) {
        skippedNoEdge++
        return
      }
      const openCost = open.reduce((acc, o) => acc + o.stake, 0)
      const equityNow = cash + openCost
      const stake = computeStake(config, decision, equityNow, cash)
      if (stake <= 0) return
      const hit = realResolution ?? rule.resolve(ctx, t)
      const won = decision.side === 'YES' ? hit : !hit
      const contracts = stake / decision.price
      cash -= stake
      const ticket: SimTicket = {
        ruleId: rule.id,
        ruleNumber: rule.number,
        entryIndex: t,
        resolveIndex: t + rule.horizonBars,
        entryTime: candles[t].time,
        resolveTime: candles[t + rule.horizonBars].time,
        side: decision.side,
        price: decision.price,
        probability: decision.probability,
        edge: decision.edge,
        stake,
        contracts,
        confluence,
        won,
        pnl: won ? contracts - stake : -stake,
        equityAtEntry: equityNow,
      }
      open.push(ticket)
      tickets.push(ticket)
    })

    const openCost = open.reduce((acc, o) => acc + o.stake, 0)
    equity.push({ time: candles[t].time, value: Math.round((cash + openCost) * 100) / 100 })
  }

  const finalBankroll = Math.round(cash * 100) / 100
  const wins = tickets.filter((tk) => tk.won).length
  const grossWin = tickets.filter((tk) => tk.pnl > 0).reduce((a, tk) => a + tk.pnl, 0)
  const grossLoss = tickets.filter((tk) => tk.pnl < 0).reduce((a, tk) => a - tk.pnl, 0)
  let streak = 0
  let longestLosingStreak = 0
  for (const tk of [...tickets].sort((a, b) => a.resolveIndex - b.resolveIndex)) {
    streak = tk.won ? 0 : streak + 1
    longestLosingStreak = Math.max(longestLosingStreak, streak)
  }

  const metrics: SimulationMetrics = {
    finalBankroll,
    roiPct: round1(((finalBankroll - bankroll) / bankroll) * 100),
    maxDrawdownPct: maxDrawdownPct(equity.map((p) => p.value)),
    tickets: tickets.length,
    wins,
    winRatePct: tickets.length > 0 ? round1((wins / tickets.length) * 100) : 0,
    avgEdgePct:
      tickets.length > 0
        ? round1((tickets.reduce((a, tk) => a + tk.edge, 0) / tickets.length) * 100)
        : 0,
    avgStake:
      tickets.length > 0
        ? Math.round((tickets.reduce((a, tk) => a + tk.stake, 0) / tickets.length) * 100) / 100
        : 0,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : null,
    longestLosingStreak,
    yesTickets: tickets.filter((tk) => tk.side === 'YES').length,
    noTickets: tickets.filter((tk) => tk.side === 'NO').length,
    skippedNoEdge,
    skippedConfluence,
    skippedNoMarket,
  }

  return {
    insufficientData: false,
    priceSource: quoteProvider ? 'real' : 'modeled',
    trainFromTime: candles[PREDICTION_WARMUP].time,
    testFromTime: candles[boundary].time,
    testToTime: candles[testEnd].time,
    calibration,
    tickets,
    equity,
    metrics,
    monteCarlo: runMonteCarlo(
      tickets.map((tk) => (tk.equityAtEntry > 0 ? tk.pnl / tk.equityAtEntry : 0)),
      bankroll,
      config.monteCarloRuns,
      config.seed,
    ),
  }
}

// ---------------------------------------------------------------------------
// Monte Carlo
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) for reproducible Monte Carlo resampling. */
function createRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[idx]
}

/**
 * Shuffles per-ticket returns (fraction of equity at entry) and compounds bankroll
 * to measure sensitivity to trade sequence ordering.
 */
export function runMonteCarlo(
  returns: number[],
  initialBankroll: number,
  runs: number,
  seed: number,
): MonteCarloSummary | null {
  if (returns.length < 2 || runs < 1) return null
  const rng = createRng(seed)
  const finals: number[] = []
  const dds: number[] = []
  const seq = [...returns]
  for (let run = 0; run < runs; run++) {
    for (let i = seq.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      const tmp = seq[i]
      seq[i] = seq[j]
      seq[j] = tmp
    }
    let value = initialBankroll
    let peak = value
    let dd = 0
    for (const r of seq) {
      value = Math.max(0, value * (1 + r))
      if (value > peak) peak = value
      if (peak > 0) dd = Math.max(dd, (peak - value) / peak)
    }
    finals.push(value)
    dds.push(dd * 100)
  }
  finals.sort((a, b) => a - b)
  dds.sort((a, b) => a - b)
  const money = (v: number) => Math.round(v * 100) / 100
  return {
    runs,
    finalP5: money(percentile(finals, 5)),
    finalP50: money(percentile(finals, 50)),
    finalP95: money(percentile(finals, 95)),
    maxDrawdownP50: round1(percentile(dds, 50)),
    maxDrawdownP95: round1(percentile(dds, 95)),
    ruinPct: round1(
      (finals.filter((v) => v < initialBankroll * 0.5).length / runs) * 100,
    ),
  }
}
