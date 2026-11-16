/**
 * FLARE prediction-market strategy catalog.
 *
 * Every entry is a complete, testable spec: the game being played, the exact
 * entry/exit conditions, sizing, expected edge, capacity, failure modes and the
 * kill switches that retire it. The catalog is the machine-readable twin of
 * `docs/PREDICTION_MARKET_PLAYBOOK.md`.
 *
 * Evidence levels:
 * - `measured`   computed from raw Binance / Polymarket data for this study
 * - `published`  from peer-reviewed or arXiv prediction-market research
 * - `structural` derived from fees, order books or the resolution mechanism
 * - `hypothesis` reasoned but not yet validated; trade at research size only
 */
import {
  costModelForCategory,
  type LiquidityRole,
  type MarketCategory,
  type MarketCostModel,
} from './predictionMarket'

export type PredictionMarketFamilyId =
  | 'crypto-5m'
  | 'crypto-15m'
  | 'crypto-1h'
  | 'crypto-1d'
  | 'sports-nonpopular'
  | 'sports-popular-unpopular-league'
  | 'politics'

export type GameDimension =
  | 'information'
  | 'liquidity'
  | 'attention'
  | 'mechanism'
  | 'coordination'

/** deploy = live-ready; paper = measured but not live-validated; research = unproven. */
export type StrategyStatus = 'deploy' | 'paper' | 'research' | 'avoid'

export type EvidenceLevel = 'measured' | 'published' | 'structural' | 'hypothesis'

export type CryptoAsset = 'BTC' | 'ETH' | 'SOL'
export type StrategyTimeframe = '5m' | '15m' | '1h' | '1d'

export type StrategySizing = {
  /** % of NAV per ticket. */
  perTicketPct: number
  /** Maximum simultaneous exposure for the family, % of NAV. */
  familyCapPct: number
  kelly: 'none' | 'quarter' | 'eighth'
  notes: string
}

export type PredictionStrategy = {
  id: string
  name: string
  family: PredictionMarketFamilyId
  status: StrategyStatus
  evidence: EvidenceLevel
  /** Games the strategy is actually attacking. */
  game: GameDimension[]
  assets?: CryptoAsset[]
  timeframes?: StrategyTimeframe[]
  /** One-sentence reason the edge exists. */
  thesis: string
  /** Who is on the other side and why they are wrong. */
  counterparty: string
  /** Hard, numeric entry conditions. */
  entry: string[]
  exit: string[]
  sizing: StrategySizing
  /** Net edge per ticket after the real Polymarket fee curve. */
  expectedEdge: string
  capacity: string
  risks: string[]
  killSwitches: string[]
  horizon: string
  /** Cost model to plug into `simulatePredictionStrategy`. */
  costModel: MarketCostModel
}

export type StrategyFamily = {
  id: PredictionMarketFamilyId
  label: string
  shortLabel: string
  /** Spanish label for the UI; falls back to `shortLabel`. */
  shortLabelEs?: string
  /** Markets covered by the family. */
  scope: string
  /** Games that dominate this family. */
  games: GameDimension[]
  /** One-line verdict from the playbook. */
  verdict: string
  /** Id of the strategy that carries the family. */
  primaryStrategyId: string
}

const MAKER: LiquidityRole = 'maker'
const TAKER: LiquidityRole = 'taker'

function costs(
  category: MarketCategory,
  role: LiquidityRole,
  spreadCents: number,
): MarketCostModel {
  return costModelForCategory(category, role, spreadCents)
}

export const STRATEGY_FAMILIES: StrategyFamily[] = [
  {
    id: 'crypto-5m',
    label: 'BTC / ETH / SOL 5m UP-DOWN',
    shortLabel: 'Crypto 5m',
    shortLabelEs: 'Cripto 5m',
    scope: 'btc|eth|sol|xrp-updown-5m-{ts}; Chainlink 60s TWAP settlement',
    games: ['liquidity', 'information', 'coordination'],
    verdict: 'Make the last two minutes. Never take a candle signal.',
    primaryStrategyId: 'c5-nowcast-maker',
  },
  {
    id: 'crypto-15m',
    label: 'BTC / ETH / SOL 15m UP-DOWN',
    shortLabel: 'Crypto 15m',
    shortLabelEs: 'Cripto 15m',
    scope: 'btc|eth|sol-updown-15m-{ts}; Chainlink 60s TWAP settlement',
    games: ['liquidity', 'information', 'attention'],
    verdict: 'Buy cheap favorites, make the rest. The nowcast is weaker than 5m.',
    primaryStrategyId: 'c15-favorite-carry',
  },
  {
    id: 'crypto-1h',
    label: 'BTC / ETH / SOL 1h UP-DOWN',
    shortLabel: 'Crypto 1h',
    shortLabelEs: 'Cripto 1h',
    scope: 'bitcoin|ethereum|solana-up-or-down-{month}-{day}-2026-{hour}-et',
    games: ['information', 'liquidity'],
    verdict: 'Thin market, thin edge. Limit-only exhaustion or nothing.',
    primaryStrategyId: 'c1h-exhaustion-limit',
  },
  {
    id: 'crypto-1d',
    label: 'BTC / ETH / SOL 1d UP-DOWN',
    shortLabel: 'Crypto 1d',
    shortLabelEs: 'Cripto 1d',
    scope: 'daily UP-DOWN plus the bitcoin-above-on-{date} barrier ladder',
    games: ['mechanism', 'attention'],
    verdict: 'Trade the barrier ladder, not the UP-DOWN candle.',
    primaryStrategyId: 'c1d-ladder-relative-value',
  },
  {
    id: 'sports-nonpopular',
    label: 'Non-popular sports',
    shortLabel: 'Niche sports',
    shortLabelEs: 'Deportes nicho',
    scope: 'Conference League, Eredivisie, Libertadores, G League, ITF, bilateral cricket',
    games: ['information', 'liquidity', 'mechanism'],
    verdict: 'Anchor to sharp odds and get paid for the wide book.',
    primaryStrategyId: 'sn-consensus-anchor',
  },
  {
    id: 'sports-popular-unpopular-league',
    label: 'Popular sports in unpopular leagues',
    shortLabel: 'Brand vs league',
    shortLabelEs: 'Marca vs liga',
    scope: 'big club in a minor cup/league, friendlies, Summer League, regional cards',
    games: ['attention', 'information'],
    verdict: 'Fade the brand premium and trade the lineup release.',
    primaryStrategyId: 'spu-brand-fade',
  },
  {
    id: 'politics',
    label: 'Politics',
    shortLabel: 'Politics',
    shortLabelEs: 'Política',
    scope: 'elections, nominees, by-elections, nested deadlines, rule-driven markets',
    games: ['attention', 'mechanism', 'liquidity'],
    verdict: 'Buy cheap favorites, sell rich tails, make the local overround.',
    primaryStrategyId: 'pol-favorite-carry',
  },
]

export const PREDICTION_STRATEGIES: PredictionStrategy[] = [
  // -------------------------------------------------------------------------
  // Crypto 5m
  // -------------------------------------------------------------------------
  {
    id: 'c5-nowcast-maker',
    name: 'Late-window TWAP nowcast maker',
    family: 'crypto-5m',
    status: 'paper',
    evidence: 'measured',
    game: ['information', 'liquidity', 'coordination'],
    assets: ['BTC', 'ETH', 'SOL'],
    timeframes: ['5m'],
    thesis:
      'The CLOB last trade is a median 44s old while the window outcome is already 60-90% determined by the 60s TWAP. A maker who prices the TWAP-consistent probability and posts inside the stale quote earns convergence, not direction.',
    counterparty:
      'Impatient takers crossing a stale book, plus makers who quote the last print instead of the TWAP-consistent fair value.',
    entry: [
      'Window: remaining 1.5-4.0 minutes.',
      'S0 = Chainlink 60s TWAP at window open; St = 60s TWAP now.',
      'sigma = stdev of 1m log returns over the prior 60m, floored at 0.35x the 24h median.',
      'z = ln(St/S0) / (sigma * sqrt(remaining_minutes)); P_model = normal CDF(z).',
      'P_quote = 0.75 * P_model + 0.25 * market_mid.',
      'Post YES bid at P_quote - buffer - spread/2 and NO bid at (1-P_quote) - buffer - spread/2, with buffer = max(0.015, 0.35 * fee_per_share).',
      'Reprice when |delta P_model| > 2 cents or every 10s.',
      'Do not quote when |z| > 2.5 or in the final 60s.',
      'Taker override only when |P_model - executable ask| >= 10 cents AND quote age <= 10s AND displayed size >= 3x clip.',
    ],
    exit: [
      'Hold to resolution; the contract is binary and the edge is convergence.',
      'Cancel all resting orders at T-20s.',
      'Flatten inventory before the next window opens (no cross-window carry).',
    ],
    sizing: {
      perTicketPct: 0.5,
      familyCapPct: 2,
      kelly: 'quarter',
      notes:
        'Inventory cap 20 contracts per side. Treat BTC+ETH+SOL as one factor for the family cap.',
    },
    expectedEdge:
      '1.2-2.5% of filled notional from spread capture; maker fee 0; rebate up to 0.7% of notional at 50 cents. Net of adverse selection is unproven.',
    capacity: '~$0.5-1k per window per asset at the top 5 levels; $5-10k/day per asset.',
    risks: [
      'Adverse selection from informed takers in the last 60s.',
      'Chainlink TWAP vs Binance spot basis.',
      'Inventory accumulation in a trending window.',
      'API latency and partial fills.',
    ],
    killSwitches: [
      '30-fill mean markout at +30s worse than -4 cents.',
      '5 consecutive windows with |P_model - outcome| > 0.15.',
      'Fill rate > 40% of quotes (you are being picked off).',
      'Either side of the book showing < $200 depth.',
    ],
    horizon: 'Intraday; 288 windows/day',
    costModel: costs('crypto', MAKER, 1),
  },
  {
    id: 'c5-cross-asset',
    name: 'BTC-led ETH/SOL/XRP repricing',
    family: 'crypto-5m',
    status: 'research',
    evidence: 'hypothesis',
    game: ['information', 'coordination'],
    assets: ['BTC', 'ETH', 'SOL'],
    timeframes: ['5m'],
    thesis:
      'BTC leads alts by 5-30 seconds in fast moves. If BTC moves at least 12 bps in 60s and the alt book has not repriced, the alt fair value has moved by beta times the BTC move.',
    counterparty:
      'Alt books still anchored to a quote that predates the BTC move.',
    entry: [
      'BTC 60s move >= 12 bps.',
      'Alt quote age > 15s and alt book has not moved more than 2 cents.',
      'beta from a 24h regression of alt 5m returns on BTC 5m returns; require R^2 > 0.35 and beta in [0.6, 1.6].',
      'Post maker only, using the same buffer and window as c5-nowcast-maker.',
    ],
    exit: ['Hold to resolution.', 'Cancel if the alt book reprices before fill.'],
    sizing: {
      perTicketPct: 0.25,
      familyCapPct: 1.5,
      kelly: 'eighth',
      notes: 'One factor across BTC/ETH/SOL; never three independent tickets.',
    },
    expectedEdge: '2-5% of notional when the lead is real; unmeasured.',
    capacity: '$200-500 per window per alt.',
    risks: [
      'Reverse causality: the alt may be leading BTC.',
      'A move may be a single-venue print.',
      'Correlated inventory across three books.',
    ],
    killSwitches: [
      '20-trade hit rate < 48%.',
      'Mean markout < -5 cents.',
      'Regression R^2 < 0.35 for two consecutive days.',
    ],
    horizon: 'Intraday; event-driven',
    costModel: costs('crypto', MAKER, 1),
  },
  {
    id: 'c5-open-ignore',
    name: 'Do not trade the first 60 seconds',
    family: 'crypto-5m',
    status: 'avoid',
    evidence: 'measured',
    game: ['coordination', 'information'],
    assets: ['BTC', 'ETH', 'SOL'],
    timeframes: ['5m'],
    thesis:
      'The first 60s has no TWAP information and the widest adverse selection. The Binance prev-red bounce resolves 48.2% UP on real Polymarket 5m windows (n=110), i.e. it reverses.',
    counterparty:
      'Anyone running a Binance indicator bot against Chainlink-resolved windows.',
    entry: [
      'No directional taker entries in [T, T+60s].',
      'No Binance-indicator bot on 5m at any time.',
      'If a signal must be tested, run it as a paper strategy against actual window resolutions.',
    ],
    exit: ['Not applicable: this is an exclusion rule.'],
    sizing: {
      perTicketPct: 0,
      familyCapPct: 0,
      kelly: 'none',
      notes: 'Capital allocation is zero by design.',
    },
    expectedEdge: 'Negative: measured 48.2% UP versus a 51.75% break-even at 50 cents.',
    capacity: 'Not applicable.',
    risks: ['Backtest overfitting to Binance bars.', 'Ignoring the Chainlink TWAP basis.'],
    killSwitches: ['Any proposal to deploy this is rejected by the measured transfer test.'],
    horizon: 'Every window',
    costModel: costs('crypto', TAKER, 1),
  },

  // -------------------------------------------------------------------------
  // Crypto 15m
  // -------------------------------------------------------------------------
  {
    id: 'c15-nowcast-maker',
    name: 'Wider-window nowcast maker',
    family: 'crypto-15m',
    status: 'paper',
    evidence: 'measured',
    game: ['liquidity', 'information'],
    assets: ['BTC', 'ETH', 'SOL'],
    timeframes: ['15m'],
    thesis:
      'The 15m book is smaller and the nowcast is weaker (Brier 0.144 vs market 0.152), so the trade is mostly spread capture with a small informational tilt.',
    counterparty: 'Takers crossing a mid-window book; slower makers.',
    entry: [
      'Window: remaining 4-12 minutes.',
      'P_quote = 0.7 * P_model + 0.3 * market_mid using the same TWAP model as 5m.',
      'buffer = max(0.02, 0.35 * fee_per_share).',
      'Do not quote when |z| > 2.2.',
    ],
    exit: ['Hold to resolution.', 'Cancel at T-90s.'],
    sizing: {
      perTicketPct: 0.75,
      familyCapPct: 2,
      kelly: 'quarter',
      notes: 'One factor across assets.',
    },
    expectedEdge: '1-2% of notional; mostly spread capture.',
    capacity: '$500-1k per window; $3-5k/day per asset.',
    risks: [
      'Model Brier can exceed the market Brier in trending regimes.',
      'Thinner book than 5m.',
    ],
    killSwitches: [
      'Rolling 100-observation model Brier > market Brier.',
      '30-fill markout < -4 cents.',
    ],
    horizon: 'Intraday; 96 windows/day',
    costModel: costs('crypto', MAKER, 1),
  },
  {
    id: 'c15-favorite-carry',
    name: '70-88 cent favorite carry',
    family: 'crypto-15m',
    status: 'paper',
    evidence: 'measured',
    game: ['attention', 'information'],
    assets: ['BTC', 'ETH', 'SOL'],
    timeframes: ['15m'],
    thesis:
      'The 15m 70-80 cent bucket realized 87.2% against a 74.6% average price (+12.6pp, n=78); the 5m 90-100 cent bucket realized 98.9% (+3.6pp, n=89). High-probability crypto windows are under-priced.',
    counterparty:
      'Lottery buyers of the cheap side and makers who do not reprice late-window favorites.',
    entry: [
      'Buy YES at ask <= P_model - 4 cents.',
      'Price band [0.70, 0.88].',
      'Remaining >= 5 minutes, quote age <= 20s, depth >= $200.',
      'No entry if the spread > 3 cents.',
    ],
    exit: ['Hold to resolution.', 'Do not add to a losing window.'],
    sizing: {
      perTicketPct: 0.5,
      familyCapPct: 1.5,
      kelly: 'quarter',
      notes: 'Max 3 concurrent; at least 30 independent tickets before judging the edge.',
    },
    expectedEdge:
      '+6-10pp gross; fee at 78 cents is 1.54% of stake; net +5-9pp. Tail is a 78 cent loss.',
    capacity: '$300-800 per window; $1-3k/day per asset.',
    risks: [
      'The 70-80 bucket may be a 24h sample artifact.',
      'Volatility regime shift.',
      'Correlated losses across BTC/ETH/SOL in the same 15 minutes.',
    ],
    killSwitches: [
      'Rolling 40-ticket hit rate Wilson lower bound < 80% at an average entry of 78 cents.',
      'Two consecutive weeks of negative net P&L.',
    ],
    horizon: 'Intraday',
    costModel: costs('crypto', TAKER, 1),
  },
  {
    id: 'c15-signal-avoid',
    name: 'Binance bounce is rejected on 15m too',
    family: 'crypto-15m',
    status: 'avoid',
    evidence: 'measured',
    game: ['information'],
    assets: ['BTC', 'ETH', 'SOL'],
    timeframes: ['15m'],
    thesis:
      'After a red candle, real 15m Polymarket windows resolved UP 47.1% of the time (n=17), not the 55% the Binance bars imply.',
    counterparty: 'Indicator bots assuming Binance bar statistics transfer to Chainlink windows.',
    entry: [
      'No 3-red, RSI<30 or ATR-shock taker entries on 15m windows.',
      'If testing, compare against actual window resolutions, not Binance candles.',
    ],
    exit: ['Not applicable: exclusion rule.'],
    sizing: {
      perTicketPct: 0,
      familyCapPct: 0,
      kelly: 'none',
      notes: 'Zero allocation.',
    },
    expectedEdge: 'Negative after fees at every price above 47 cents.',
    capacity: 'Not applicable.',
    risks: ['Small conditional sample (n=17) leaves some uncertainty, but no evidence of a positive transfer.'],
    killSwitches: ['Deploy only if a >= 500-window study shows a stable positive lift.'],
    horizon: 'Every window',
    costModel: costs('crypto', TAKER, 1),
  },

  // -------------------------------------------------------------------------
  // Crypto 1h
  // -------------------------------------------------------------------------
  {
    id: 'c1h-exhaustion-limit',
    name: '3-red / RSI exhaustion, limit-only',
    family: 'crypto-1h',
    status: 'paper',
    evidence: 'measured',
    game: ['information', 'liquidity'],
    assets: ['BTC', 'ETH', 'SOL'],
    timeframes: ['1h'],
    thesis:
      'After 3 consecutive red hours or RSI14 < 35, the next hourly bar is UP 54.7-55.9% on Binance (n=1,901 / 874 / 383). The sign edge is real but thin, so entry price discipline is the strategy.',
    counterparty:
      'Momentum sellers hitting the close of a red hour; makers who do not reprice the exhaustion setup.',
    entry: [
      '3+ consecutive red 1h candles OR RSI14 < 35 on the last closed bar.',
      'Buy UP only at limit <= 0.52.',
      'No entry if the market is already > 0.54 or the spread > 3 cents.',
      'No entry within 30 minutes of FOMC, CPI, NFP or a major ETF decision.',
    ],
    exit: ['Hold to resolution.', 'Cancel the limit if unfilled by T+10 minutes.'],
    sizing: {
      perTicketPct: 0.5,
      familyCapPct: 1.5,
      kelly: 'quarter',
      notes: 'Max 3 concurrent across BTC/ETH/SOL.',
    },
    expectedEdge:
      '55% * 1 - 0.5375 all-in = +1.25 cents/share = ~2.3% of stake. Wilson lower bound at n=900 is ~53.3%.',
    capacity: '~$500-1k per hourly window; $1-3k/day per asset.',
    risks: [
      'Macro news invalidates mean reversion.',
      'The hourly book may not have a two-sided quote at 52 cents.',
      'ETH/SOL books are thinner than BTC.',
    ],
    killSwitches: [
      '60-trade rolling hit rate < 52%.',
      'Any single loss > 1% of NAV.',
      'Blackout violation (entry inside a macro window).',
    ],
    horizon: 'Hours',
    costModel: costs('crypto', TAKER, 1),
  },
  {
    id: 'c1h-quiet-maker',
    name: 'Quiet-regime two-sided maker',
    family: 'crypto-1h',
    status: 'research',
    evidence: 'structural',
    game: ['liquidity', 'coordination'],
    assets: ['BTC', 'ETH', 'SOL'],
    timeframes: ['1h'],
    thesis:
      'In quiet regimes the hourly crypto book has predictable flow and no informed catalyst; a maker can earn the spread plus the 20% crypto rebate.',
    counterparty: 'Impatient takers with no informational advantage.',
    entry: [
      'ATR14 in the 30-70th percentile of the last 60 hours.',
      '1h realized vol < 1.5x the 24h median.',
      'No scheduled macro event within 2h.',
      'Quote +/- max(2 cents, 0.5 * ATR%) around P_model; size 25% of normal.',
    ],
    exit: ['Cancel on a 2 sigma move.', 'Flatten before the next hourly open.'],
    sizing: {
      perTicketPct: 0.25,
      familyCapPct: 1,
      kelly: 'eighth',
      notes: 'Inventory-aware quoting only; no directional overlay.',
    },
    expectedEdge: '0.3-0.8% of notional per fill; adverse selection dominates after shocks.',
    capacity: '$300-800 per hour.',
    risks: [
      'A single news shock picks off both sides.',
      'The 20% rebate is fee-curve weighted, so it is largest at 50 cents.',
    ],
    killSwitches: ['Markout < -3 cents over 30 fills.', 'Widen or stop after any macro surprise.'],
    horizon: 'Hours',
    costModel: costs('crypto', MAKER, 2),
  },

  // -------------------------------------------------------------------------
  // Crypto 1d
  // -------------------------------------------------------------------------
  {
    id: 'c1d-ladder-relative-value',
    name: 'Daily barrier-ladder relative value',
    family: 'crypto-1d',
    status: 'paper',
    evidence: 'structural',
    game: ['mechanism', 'attention'],
    assets: ['BTC', 'ETH', 'SOL'],
    timeframes: ['1d'],
    thesis:
      'BTC daily UP/DOWN does ~$15k/day while the same day barrier ladder does ~$352k across 11 strikes. The ladder is fair near the money and rich in the far tails: $70k traded 1.7 cents against a lognormal 0.6 cents in the 2026-11-15 snapshot.',
    counterparty:
      'Lottery buyers of far-tail digital strikes; ladder makers who do not enforce monotonicity.',
    entry: [
      'Fit a lognormal (or 90-day empirical distribution) to expiry spot; compute P(S_T > K) per strike.',
      'Sell tails when market ask >= model + 1.0 cent and ask <= 5 cents; buy NO or post a NO ask.',
      'Buy a strike when ask <= model - 4 cents and the strike is within 1.5 sigma.',
      'Enforce monotonicity: if ask(K1) < ask(K2) for K1 < K2, buy the lower strike / sell the higher strike.',
      'Skip any strike with < $200 depth.',
    ],
    exit: ['Hold to expiry; the digital is path-independent at expiry.', 'No mid-day stop.'],
    sizing: {
      perTicketPct: 0.5,
      familyCapPct: 3,
      kelly: 'quarter',
      notes: 'Max 8 legs per expiry; treat strikes as one correlated exposure.',
    },
    expectedEdge:
      '0.5-1.5% of stake per tail leg (fee at 98 cents is 0.14% of stake); near-the-money dislocations are rarer but larger.',
    capacity: '$1-3k per strike (liquidity $50-90k per strike; stay below 2%).',
    risks: [
      'Fat tails: a 1.7 cent strike can pay.',
      'Sigma model error around macro events.',
      'Expiry-time mismatch between the market and the model.',
    ],
    killSwitches: [
      'Two tail losses in one expiry.',
      'Model-vs-market Brier > 0.02 over 50 strikes.',
      'Any strike with < $200 depth.',
    ],
    horizon: 'Daily expiries',
    costModel: costs('crypto', TAKER, 1),
  },
  {
    id: 'c1d-updown-avoid',
    name: 'No daily indicator trading on UP/DOWN',
    family: 'crypto-1d',
    status: 'avoid',
    evidence: 'measured',
    game: ['information'],
    assets: ['BTC', 'ETH', 'SOL'],
    timeframes: ['1d'],
    thesis:
      'Daily base rates are 50.3% BTC, 51.8% ETH, 49.8% SOL. No 1d signal clears the 53.5% break-even at 50 cents with stability, and the daily UP/DOWN book is thin.',
    counterparty: 'Anyone extrapolating daily technicals into a 3.5% fee.',
    entry: [
      'No technical daily UP/DOWN entries.',
      'Use the barrier ladder for expression, or trade event-driven macro.',
    ],
    exit: ['Not applicable: exclusion rule.'],
    sizing: {
      perTicketPct: 0,
      familyCapPct: 0,
      kelly: 'none',
      notes: 'Zero allocation to daily candle bets.',
    },
    expectedEdge: 'Negative after the crypto taker curve unless the model exceeds 53.5% consistently.',
    capacity: 'Not applicable.',
    risks: ['A single regime (strong trend) can make a 1d signal look real for months.'],
    killSwitches: ['Requires a 500-day out-of-sample Wilson lower bound above 53.5%.'],
    horizon: 'Daily',
    costModel: costs('crypto', TAKER, 1),
  },

  // -------------------------------------------------------------------------
  // Non-popular sports
  // -------------------------------------------------------------------------
  {
    id: 'sn-consensus-anchor',
    name: 'Sharp-consensus devig, taker',
    family: 'sports-nonpopular',
    status: 'paper',
    evidence: 'structural',
    game: ['information', 'liquidity'],
    thesis:
      'Polymarket sports books are set by a thin crowd while sharp bookmakers have already priced the match. Devig two or more sharp books and trade only when Polymarket is at least 6 cents off consensus.',
    counterparty:
      'Casual Polymarket traders pricing from a headline; makers who have not devigged the book.',
    entry: [
      'Collect 2+ bookmaker prices or a sharp exchange for the same market.',
      'Devig each book (proportional or Shin) and take the median; require book disagreement <= 4pp.',
      'Buy YES when ask <= P_fair - 0.06.',
      'Buy NO when 1 - bid <= (1 - P_fair) - 0.06.',
      'Window: after official lineups (T-60m) to T-5m. No in-play in the first 5 minutes.',
    ],
    exit: ['Hold to resolution.', 'No in-play stop for pre-match positions.'],
    sizing: {
      perTicketPct: 0.5,
      familyCapPct: 1.5,
      kelly: 'quarter',
      notes: '1.5% per league-day; 3% total sports.',
    },
    expectedEdge: '2-4% of stake after fees; 55-60% hit rate on a 6 cent buffer.',
    capacity: '$100-500 per match (median liquidity $241-$1,953).',
    risks: [
      'Bookmaker error and limits.',
      'Late lineup scratch.',
      'Void and postponement rules.',
      'Polymarket resolution source differs from the book settlement.',
    ],
    killSwitches: [
      'Brier vs closing line > 0.05 over 50 bets.',
      'Two consecutive weeks negative.',
      'Any league with median spread > 10 cents becomes maker-only.',
    ],
    horizon: 'Pre-match, 24h',
    costModel: costs('sports', TAKER, 6),
  },
  {
    id: 'sn-partition-maker',
    name: 'Make the outright overround',
    family: 'sports-nonpopular',
    status: 'research',
    evidence: 'structural',
    game: ['liquidity', 'mechanism'],
    thesis:
      'Outright and futures markets often show a 5-20 cent overround because one side of each book is a placeholder. Example: Conference League winner had Monaco at 13.2/71.5 and Copenhagen at 2.9/60.5.',
    counterparty:
      'One-sided books with no maker; takers who need immediacy on an obscure future.',
    entry: [
      'Top-5 depth on the opposite side >= $200.',
      'Independent Elo/odds model whose fair values sum to 1.00 +/- 0.02.',
      'Post bids at fair - 1 cent and asks at fair + 1 cent; never cross.',
      'Only markets with a real two-sided quote on at least two legs.',
    ],
    exit: ['Hold to resolution.', 'Cancel on a lineup or bracket change.'],
    sizing: {
      perTicketPct: 0.25,
      familyCapPct: 1,
      kelly: 'eighth',
      notes: 'Max 5 legs per event.',
    },
    expectedEdge: '3-8% of notional per fill; fill rate is low.',
    capacity: '$100-300 per leg.',
    risks: [
      'The placeholder quote signals nobody is there; you may be the only maker and the only taker is informed.',
      'Adverse selection dominates if your model is worse than the market.',
    ],
    killSwitches: ['Markout < -5 cents over 20 fills.', 'Any leg with < $100 depth.'],
    horizon: 'Season-long futures',
    costModel: costs('sports', MAKER, 4),
  },

  // -------------------------------------------------------------------------
  // Popular sports in unpopular leagues
  // -------------------------------------------------------------------------
  {
    id: 'spu-brand-fade',
    name: 'Fade the brand premium',
    family: 'sports-popular-unpopular-league',
    status: 'research',
    evidence: 'hypothesis',
    game: ['attention', 'information'],
    thesis:
      'In low-coverage competitions the popular club is priced on reputation, not on the XI. Rotation, travel, altitude, pitch and motivation are systematically underweighted.',
    counterparty:
      'Public money buying the brand; makers who price the badge instead of the lineup.',
    entry: [
      'Popular club (top-20 global following or top-5 league) in a competition with median spread >= 4 cents.',
      'Market price >= 8pp above a lineup-aware fair value.',
      'OR >= 4 regular starters rested/absent and the market has moved < 3pp since the lineup release.',
      'Buy NO / lay the favorite at 1 - bid when P_fair(no) >= price(no) + 0.07.',
      'Prefer maker orders (0 sports fee + 15% rebate).',
    ],
    exit: ['Hold to resolution.', 'Exit if a red card or injury changes the XI.'],
    sizing: {
      perTicketPct: 0.5,
      familyCapPct: 2.5,
      kelly: 'quarter',
      notes: '1% per competition-day; halve size for friendlies.',
    },
    expectedEdge: '4-8% of stake when the brand premium is >= 8pp; unmeasured on Polymarket.',
    capacity: '$100-400 per match (Conference League median liquidity $391).',
    risks: [
      'The brand may genuinely be better; rotation players are still good.',
      'The market may know the lineup before you.',
      'Void rules and low liquidity exit slippage.',
    ],
    killSwitches: [
      '30-trade hit rate < 50%.',
      'Markout < -6 cents.',
      'Any match with < $150 depth.',
    ],
    horizon: 'Per matchday',
    costModel: costs('sports', TAKER, 4),
  },
  {
    id: 'spu-lineup-lag',
    name: 'Trade the 60-minute lineup release',
    family: 'sports-popular-unpopular-league',
    status: 'research',
    evidence: 'hypothesis',
    game: ['information', 'coordination'],
    thesis:
      'The lineup release is the highest-information, lowest-attention moment in a low-coverage match. A player-impact model can convert the XI into a probability shift faster than the market.',
    counterparty:
      'Casual traders who do not recognize the rotation players; slow makers.',
    entry: [
      'Delta P = sum(minutes_weight * player_impact) versus the expected XI; shrink by 50% for uncertainty.',
      'When |Delta P| >= 6pp and the market has not moved >= 3pp within 90s of the lineup release, take the side with a limit order.',
      'If the market moves first, stand down.',
    ],
    exit: ['Hold to resolution.', 'Cancel unfilled orders 10 minutes after the release.'],
    sizing: {
      perTicketPct: 0.4,
      familyCapPct: 1,
      kelly: 'eighth',
      notes: 'Max 3 entries per slate; treat a slate as one correlated bet.',
    },
    expectedEdge: '3-6% of stake; the edge decays within 5-10 minutes.',
    capacity: '$100-300 per match.',
    risks: [
      'Lineup news leaks before the official release.',
      'The model overweights star players.',
      'The market is right about the replacement quality.',
    ],
    killSwitches: ['20-trade hit rate < 48%.', 'More than 3 simultaneous entries on a slate.'],
    horizon: 'T-60m to kickoff',
    costModel: costs('sports', TAKER, 4),
  },

  // -------------------------------------------------------------------------
  // Politics
  // -------------------------------------------------------------------------
  {
    id: 'pol-favorite-carry',
    name: 'Buy 88-96 cent favorites',
    family: 'politics',
    status: 'deploy',
    evidence: 'published',
    game: ['attention'],
    thesis:
      'Politics favorites at or above 90 cents earn +1.044% dollar-weighted while longshots lose 16.34%. Eight cents of edge on a 92 cent stake is 8.7% over the holding period, or ~50% annualized at 60 days.',
    counterparty:
      'Lottery buyers and narrative traders who overpay for the upset side.',
    entry: [
      'YES ask in [0.88, 0.96].',
      'Liquidity >= $100k, spread <= 1 cent, resolution <= 90 days.',
      'No other position in the same event cluster.',
      'Annualized net edge (1 - price - fee) / price * 365 / days >= 8%.',
    ],
    exit: ['Hold to resolution.', 'Sell only at 99 cents if the annualized edge falls below 3%.'],
    sizing: {
      perTicketPct: 2,
      familyCapPct: 8,
      kelly: 'quarter',
      notes: '8% per event cluster; 25% total politics carry.',
    },
    expectedEdge:
      '+0.5-0.8% of notional, ~8-12% annualized on capital. A carry trade, not a growth engine.',
    capacity: '$5-20k per market (top politics books hold $400k-$1.1M).',
    risks: [
      'A 92 cent favorite losing costs 92 cents.',
      'Correlated clusters (same party sweep) can lose several at once.',
      'Rule clarification or oracle dispute.',
    ],
    killSwitches: [
      'Two cluster losses in one quarter.',
      'Any rule clarification or oracle dispute.',
      'Liquidity < $50k after entry.',
    ],
    horizon: '30-90 days',
    costModel: costs('politics', TAKER, 1),
  },
  {
    id: 'pol-longshot-fade',
    name: 'Sell sub-8 cent longshots via NO',
    family: 'politics',
    status: 'paper',
    evidence: 'published',
    game: ['attention', 'liquidity'],
    thesis:
      'Longshots below 10 cents lose 19.35% dollar-weighted. Buying NO at 92-98 cents is the same trade with a bounded payoff and a 25% maker rebate.',
    counterparty: 'Lottery demand for the upset; narrative buyers.',
    entry: [
      'YES bid <= 8 cents.',
      'Buy NO at 1 - bid, or post a NO bid at 1 - ask + 1 cent as a maker.',
      'Liquidity >= $50k and resolution <= 180 days.',
    ],
    exit: ['Hold to resolution.', 'Exit if the YES price falls below 2 cents and the carry is exhausted.'],
    sizing: {
      perTicketPct: 1,
      familyCapPct: 6,
      kelly: 'quarter',
      notes: '6% per event cluster; 15% total.',
    },
    expectedEdge: '2-6% of stake over the holding period; fee 0 as maker, 25% rebate.',
    capacity: '$2-10k per market.',
    risks: [
      'The 2% tail that hits.',
      'Crowded carry: many bots sell the same tails.',
      'Resolution ambiguity.',
    ],
    killSwitches: ['Two tail hits in one month.', 'Ambiguous rule text.', 'Cluster exposure > 6%.'],
    horizon: '30-180 days',
    costModel: costs('politics', MAKER, 1),
  },
  {
    id: 'pol-partition-maker',
    name: 'Make the local overround',
    family: 'politics',
    status: 'research',
    evidence: 'structural',
    game: ['liquidity', 'mechanism'],
    thesis:
      'National nominee books are tight (sum of asks 0.957-0.982); local by-elections are wide (sum of asks 1.022-1.159, sum of bids 0.929-0.972). The taker arb is gone, but the maker rent is 2-16 cents per partition.',
    counterparty:
      'Impatient local traders and one-sided books with no professional maker.',
    entry: [
      'True partition: mutually exclusive and exhaustive, all legs quoted two-sided.',
      '|sum of mids - 1| >= 3 cents.',
      'Your fair values sum to 1.00 +/- 0.02.',
      'Liquidity $1k-$50k and spread >= 2 cents on at least two legs.',
      'Post bids on cheap legs and asks on rich legs; never cross.',
    ],
    exit: ['Hold to resolution.', 'Cancel if a candidate drops out or a rule changes.'],
    sizing: {
      perTicketPct: 0.25,
      familyCapPct: 1,
      kelly: 'eighth',
      notes: 'Max 6 legs per event; 5% total politics maker.',
    },
    expectedEdge: '2-6% of notional per filled leg; capacity is tiny.',
    capacity: '$100-300 per leg.',
    risks: [
      'The wide book is wide because the event is uncertain.',
      'A single news shock reprices all legs at once.',
      'You may be the only maker and the only taker is informed.',
    ],
    killSwitches: ['Markout < -5 cents over 20 fills.', 'Rule change.', 'Any leg with < $100 depth.'],
    horizon: 'Days to months',
    costModel: costs('politics', MAKER, 3),
  },
  {
    id: 'pol-resolution-rule',
    name: 'Trade the literal rule, not the narrative',
    family: 'politics',
    status: 'paper',
    evidence: 'structural',
    game: ['mechanism'],
    thesis:
      'Politics markets are priced on narrative; resolution is on text. Gaps appear on announce-vs-occur, inclusive deadlines, already-published facts, and newly listed legs.',
    counterparty:
      'Traders pricing the headline; markets that have not re-read the resolution source.',
    entry: [
      'Quote the exact resolution sentence.',
      'Identify the source and the timezone of the deadline.',
      'Check whether the event already happened and the source published it.',
      'Check the no-event-by-date default and early-resolution clause.',
      'Enter only when the literal rule contradicts the price by >= 10 cents and the fact is already public.',
    ],
    exit: ['Hold to resolution, or exit when the market converges to the rule.'],
    sizing: {
      perTicketPct: 1,
      familyCapPct: 3,
      kelly: 'quarter',
      notes: 'No leverage; no correlated cluster.',
    },
    expectedEdge: '10+ cents per dislocation; frequency is very low.',
    capacity: '$1-5k per market.',
    risks: [
      'UMA dispute.',
      'Rule ambiguity with two defensible readings.',
      'The source changes the page.',
    ],
    killSwitches: ['Any active dispute.', 'Any rule clarification.', 'Two defensible readings.'],
    horizon: 'Event-driven',
    costModel: costs('politics', TAKER, 2),
  },
  {
    id: 'pol-nested-monotonicity',
    name: 'New legs and post-news curve trades',
    family: 'politics',
    status: 'research',
    evidence: 'structural',
    game: ['mechanism', 'information'],
    thesis:
      'Nested deadlines must satisfy P(by earlier) <= P(by later). Across 8 event families the top of book was monotone (0 violations), so the naive calendar arb is gone. The residual edge is newly listed legs and news shocks that move one leg but not the curve.',
    counterparty:
      'Slow repricing after a news shock; newly listed legs anchored to the wrong date.',
    entry: [
      'Fit a hazard curve from the existing deadlines.',
      'If a new leg deviates > 6 cents from the curve, trade it against the nearest two legs.',
      'If a shock moves the near leg > 8pp but the far leg < 3pp, buy the far leg / sell the near leg.',
    ],
    exit: ['Hold to resolution.', 'Unwind if the curve realigns.'],
    sizing: {
      perTicketPct: 0.5,
      familyCapPct: 2,
      kelly: 'eighth',
      notes: 'Max 3 legs per event.',
    },
    expectedEdge: '3-6 cents per dislocation; low frequency.',
    capacity: '$500-2k per event.',
    risks: [
      'A persistent violation means the market knows something you do not.',
      'Thin depth on the far leg.',
    ],
    killSwitches: [
      'A violation persists > 60s.',
      'Any event with < $500 depth.',
      'Two consecutive losing curve trades.',
    ],
    horizon: 'Weeks to months',
    costModel: costs('politics', TAKER, 2),
  },
]

export function strategiesForFamily(
  family: PredictionMarketFamilyId,
): PredictionStrategy[] {
  return PREDICTION_STRATEGIES.filter((strategy) => strategy.family === family)
}

export function strategyById(id: string): PredictionStrategy | undefined {
  return PREDICTION_STRATEGIES.find((strategy) => strategy.id === id)
}

export function familyById(id: PredictionMarketFamilyId): StrategyFamily | undefined {
  return STRATEGY_FAMILIES.find((family) => family.id === id)
}

/** Primary strategy for every family, in family order. */
export function primaryStrategies(): PredictionStrategy[] {
  return STRATEGY_FAMILIES.map((family) => strategyById(family.primaryStrategyId)).filter(
    (strategy): strategy is PredictionStrategy => strategy !== undefined,
  )
}

export function countByStatus(): Record<StrategyStatus, number> {
  const counts: Record<StrategyStatus, number> = {
    deploy: 0,
    paper: 0,
    research: 0,
    avoid: 0,
  }
  for (const strategy of PREDICTION_STRATEGIES) counts[strategy.status] += 1
  return counts
}
