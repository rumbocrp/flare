# FLARE Prediction-Market Playbook

**Scope:** BTC / ETH / SOL UP-DOWN at 5m, 15m, 1h and 1d; non-popular sports; popular
sports in unpopular leagues; politics.
**Venue:** Polymarket CLOB, binary YES/NO contracts, USDC collateral.
**Status of this document:** research + implementation spec. Every claim carries an
evidence label. Nothing here is financial advice, and nothing here should be traded
live before it passes the paper-trade gates in §6.

Evidence labels used throughout:

| Label | Meaning |
| --- | --- |
| **Measured** | Computed from raw data pulled for this study (Binance klines, Polymarket Gamma/CLOB, 24h of 5m/15m windows). |
| **Published** | From peer-reviewed or arXiv research cited in §10. |
| **Structural** | Derived from the market mechanism, fee schedule or order-book snapshot; not a backtest. |
| **Hypothesis** | A reasoned edge that has not been validated. Trade only as research size. |

---

## 0. The one-paragraph version

The only durable edges available to a FLARE-sized participant are **liquidity
provision where quotes are stale**, **information that is public but not yet parsed**
(lineups, resolution rules, new deadline legs), and **structural carry in the
favorite tail**. Pure directional prediction from Binance indicators does **not**
transfer to Polymarket's Chainlink-resolved crypto windows (§4.3), and the 7% crypto
taker fee turns a 55% win rate at 50¢ into a ~1.5% edge before spread. Therefore:
**make, don't take**, in 5m/15m crypto; **price the ladder, don't bet the candle**, in
1d crypto; **anchor to sharp odds**, in sports; and **sell expensive tails / buy cheap
favorites**, in politics.

---

## 1. What you are actually trading

A binary contract is an Arrow–Debreu security paying $1 if an event resolves YES.
Its price is therefore a **risk-neutral probability** with three wedges between it and
the physical probability:

```
price = physical_probability
      + risk_premium          (who is on the other side, and why)
      + fee_and_spread        (the house's cut and the liquidity rent)
      - information_edge      (what you know that the marginal quote does not)
```

Every strategy in this playbook attacks exactly one of those wedges. A strategy that
cannot name its wedge is a coin flip with extra steps.

Three consequences drive the whole design:

1. **Fees are price-dependent.** Polymarket charges `rate × p × (1-p)` per share.
   At 50¢ the crypto fee is 1.75¢/share = **3.5% of the stake**; at 90¢ it is 0.63¢/share
   = **0.7% of the stake**. The same strategy can be dead at 50¢ and alive at 90¢.
2. **The payoff is bounded and skewed.** Buying a 5¢ longshot risks 5¢ to make 95¢. The
   sign edge can be real while the dollar edge is negative, which is exactly what the
   Binance scan found (§4.1). Binary contracts isolate the sign; they do not remove the
   skew.
3. **Resolution is part of the game.** Crypto UP/DOWN resolves on a Chainlink 60-second
   TWAP stream, not on Binance's candle. Sports and politics resolve through UMA with
   rule text that can be gamed or misread. A 2¢ mispricing is irrelevant if the rule can
   resolve the other way.

---

## 2. Game theory review

### 2.1 The five games inside every prediction market

Prediction markets are usually described as "information aggregation". That is only one
of five games running simultaneously. FLARE strategies are classified against this
taxonomy.

| # | Game | What is being fought over | Canonical model | Observable signature |
| --- | --- | --- | --- | --- |
| G1 | **Information vs. nature** | Who has the better estimate of the true probability | Bayesian updating, Kyle (1985) | Price converges to truth as information arrives; edge decays with time-to-resolution |
| G2 | **Liquidity / adverse selection** | Who pays for immediacy, and who is picked off | Glosten–Milgrom (1985), inventory models | Spread widens with informed flow; fills cluster before price jumps |
| G3 | **Attention / behavioural** | Who overpays for lottery-like or identity-linked outcomes | Favorite–longshot bias, prospect theory, limits to arbitrage | Longshot tails rich, favorite tails cheap; persists because shorting is costly |
| G4 | **Mechanism / resolution** | Who understands the rule, oracle and deadline better | Mechanism design, oracle games | Price dislocated from the literal rule; convergence at deadline, not at news |
| G5 | **Coordination / competition** | Who gets the fill, the rebate, and the queue position | All-pay auctions, war of attrition, congestion games | Spread floors, quote clustering, alpha decay after a strategy is published |

**Mapping to the requested markets:**

| Market family | Dominant games | Secondary games |
| --- | --- | --- |
| BTC/ETH/SOL 5m | G5 speed/queue, G2 liquidity | G4 oracle (TWAP) |
| BTC/ETH/SOL 15m | G2 liquidity, G1 nowcast | G5 |
| BTC/ETH/SOL 1h | G1 information, G2 | G3 small tails |
| BTC/ETH/SOL 1d | G4 barrier/ladder structure | G3 tail richness |
| Non-popular sports | G1 local information, G2 wide spreads | G4 void rules |
| Popular sports / unpopular leagues | G3 brand bias, G1 lineups | G2 thin books |
| Politics | G3 favorite–longshot, G4 rules | G5 crowded carry |

### 2.2 Classical results that actually bind

**Kyle (1985).** A market maker facing informed flow sets price impact `λ` proportional
to the ratio of informed to noise variance. In prediction markets the "informed" trader
is whoever saw the lineup, the exit poll, or the oracle update first. Implication: the
maker's spread must exceed `P(informed) × information advantage`, or the maker is
donating. This is why quoting a 1¢ spread in a thin sports market is not "earning the
spread"; it is selling a free option to the one person who knows the goalkeeper is out.

**Glosten–Milgrom (1985).** The bid–ask spread is exactly the compensation for adverse
selection. A market with zero spread and positive adverse selection is a negative-EV
business. Implication: **measure markouts, not spread capture.** If your fills are
followed by a 4¢ move against you within 30 seconds, the spread you "earned" was the
price of being wrong.

**Grossman–Stiglitz (1980).** If prices were perfectly informative, nobody would pay to
become informed. Equilibrium leaves just enough profit to compensate the information
cost. Implication: an edge must be protected by something that does not arbitrage away —
speed, proprietary data, a structural constraint, or a behavioural bias that is itself
consumption. "I computed RSI" is not a barrier.

**Favorite–longshot bias (FLB).** The 2026 Polymarket study (588M trades, 2.48M wallets)
finds dollar-weighted longshots below 10¢ lose **19.35%**, while favorites at or above
90¢ earn **0.83%**. Equal-weighted child markets: longshots **−6.30%**, favorites
**+0.277%**. The two-sided pattern is robust in **crypto and politics** and **absent in
sports**, where longshots are slightly positive (+2.43%, not significant). Implication:
the tail-sell trade is a politics and crypto trade, **not** a generic sports trade.

**Limits to arbitrage.** The FLB persists because fading a 3¢ longshot requires locking
up 97¢ of capital to earn 3¢, with a small chance of losing 97¢. That is a leveraged
short-volatility position. It is profitable on average and catastrophic occasionally.
Position sizing, not signal quality, is what keeps it alive.

### 2.3 Agentic game theory: what changes when the other side is a bot

Classical game theory assumes fixed strategy spaces. Agentic markets add learning,
opponent modelling and delegation.

1. **Best-response convergence, not Nash uniqueness.** Multi-agent RL converges to
   coarse correlated equilibria in imperfect-information games. In a CLOB this shows up
   as **spread floors** and **quote clustering**: independent bots learn the same
   inventory-aversion rule and stop undercutting below a threshold. The 2026
   microstructure study finds ~32 effective makers median even in active markets, which
   is consistent with a small number of strategies, not a fragmented crowd.

2. **Opponent shaping and spoofing.** An agent that can influence others' learning can
   profit from *being imitated*. In practice: quote-stuffing to push competing makers
   out of the queue, then widening. Countermeasure: never infer fair value from the
   displayed book alone; require an independent model.

3. **Mean-field congestion and alpha decay.** When many small agents run the same
   signal, individual price impact stays small but the aggregate edge compresses to the
   fee. This is a **congestion externality**: each additional copy of the strategy
   reduces everyone's edge. Implication: strategies must have a capacity estimate and a
   retirement rule, not just an entry rule.

4. **Algorithmic collusion.** Pricing agents in repeated games can learn supra-competitive
   spreads without communicating (LLM pricing experiments show this explicitly). In
   prediction markets the analogue is **implicit spread coordination** in thin books.
   A new maker undercutting by 1¢ can trigger a spread war that destroys the rent for
   everyone; the equilibrium response is to compete on **queue position and rebates**,
   not on price.

5. **Delegated agents and principal–agent risk.** An LLM or RL agent rewarded for volume
   or rebates will over-trade relative to the principal's utility. This is the single
   most likely way a FLARE bot loses money in production: not a bad model, but a good
   model with a bad objective. Every strategy therefore ships with a hard kill switch
   and a per-family exposure cap.

6. **Correlated LLM errors.** Agents that read the same news feed, apply the same
   heuristic ("sell the longshot"), and share the same training data will herd. That
   creates **crowded carry** and **correlated drawdowns** in exactly the trades that look
   safest. Diversify across *games*, not just across markets.

7. **The negative result that matters.** The 2026 cooperative-MARL market-making paper
   trained makers on real Polymarket books and still could not produce positive
   held-out portfolio value. Adverse selection and delayed consequences dominated the
   learned spread capture. Treat "make markets, earn the spread" as a hypothesis to be
   measured, never as a baseline truth.

### 2.4 Why an edge persists, and how it dies

An edge survives only if at least one of these is true:

- **It is costly to arbitrage** (capital lock-up, shorting constraints, KYC, gas).
- **It requires information that is expensive to produce** (local scouts, lineup
  parsing, oracle monitoring).
- **It is a service, not a bet** (providing immediacy to impatient traders).
- **It is protected by a behavioural bias that is consumption** (lottery demand).

It dies when the cost falls (a new data feed), the service is automated (a better bot),
or the bias is arbitraged (a narrative shift). Every strategy below therefore has an
explicit **kill switch** and a **capacity** estimate.

---

## 3. Market mechanics and the real cost model

### 3.1 Polymarket fee schedule (verified 2026-11-15)

```
fee_in_USDC = C × feeRate × p × (1 - p)
```

where `C` = shares traded and `p` = share price. Makers pay **zero**. Fees are
symmetric around 50¢: the same dollar fee at 30¢ and 70¢.

| Category | Taker rate | Maker fee | Maker rebate |
| --- | --- | --- | --- |
| Crypto | 0.07 | 0 | 20% |
| Sports | 0.05 | 0 | 15% |
| Finance | 0.04 | 0 | 25% |
| Politics | 0.04 | 0 | 25% |
| Economics / Culture / Weather / Other | 0.05 | 0 | 25% |
| Mentions / Tech | 0.04 | 0 | 25% |
| Geopolitics | 0 | 0 | — |
| Combos | 0.05 | 0 | 0% |

**Fee as a % of the stake** (this is the number that matters for position sizing):

| Price | Crypto 7% | Sports 5% | Politics 4% |
| --- | --- | --- | --- |
| 10¢ | 6.30% | 4.50% | 3.60% |
| 30¢ | 4.90% | 3.50% | 2.80% |
| 50¢ | **3.50%** | **2.50%** | **2.00%** |
| 70¢ | 2.10% | 1.50% | 1.20% |
| 90¢ | 0.70% | 0.50% | 0.40% |

FLARE's historical default was `spreadCents: 2, feePct: 1`. At 50¢ crypto that models
**1.0%** of stake; the real taker cost is **3.5%**. The old default understated the
crypto hurdle by 2.5 percentage points — enough to turn a losing strategy into an
apparently profitable one. The engine now supports the real curve via
`takerFeeRate` / `makerRebateShare` / `liquidityRole` in `MarketCostModel`
(§8).

### 3.2 Break-even win rate

Buying YES at an all-in price `q` has positive EV only if your probability estimate
exceeds `q`. Since `q` already contains half-spread and fee, the break-even win rate is
**higher than the quoted price**:

| Quoted YES | All-in (crypto taker, 0¢ spread) | Required win rate |
| --- | --- | --- |
| 30¢ | 31.47¢ | > 31.47% |
| 50¢ | 51.75¢ | > 51.75% |
| 70¢ | 70.47¢ | > 70.47% |
| 90¢ | 90.63¢ | > 90.63% |

This is why "55% win rate" is not automatically a strategy: at 50¢ crypto you need
**51.75%**, and after a 1¢ spread you need roughly **53%** just to break even. A 55%
signal leaves ~2% of stake, not 10%.

### 3.3 Measured market structure (2026-11-15 snapshot)

**Crypto UP/DOWN liquidity:**

| Market | Windows/day | Volume/window | Volume/day | Notes |
| --- | --- | --- | --- | --- |
| BTC 5m | 288 | ~$48.2k | ~$13.8M | deepest crypto prediction market |
| BTC 15m | 96 | ~$34.3k | ~$3.3M | second |
| BTC hourly | 24 | ~$19.1k | ~$458k/day | thinner than 5m/15m, 0.6¢ spread at 99.2¢ |
| BTC daily UP/DOWN | 1 | ~$15.3k | ~$15.3k/day | marginal |
| BTC daily barrier ladder | 1 expiry × 11 strikes | ~$352k event | — | **23× the volume of daily UP/DOWN** |
| ETH/SOL 5m | 288 | small but live | — | same slug pattern, thinner books |

**Sports spreads by league (median, quoted markets):**

| League | Median spread | Median liquidity | Median volume |
| --- | --- | --- | --- |
| MLS | 1.0¢ | $4,571 | $912 |
| Ligue 1 | 1.7¢ | $859 | $568 |
| Super Lig | 1.7¢ | $1,018 | $254 |
| Champions League | 2.2¢ | $2,996 | $1,310 |
| NBA Summer League | 2.3¢ | $1,770 | $225 |
| Europa League | 2.7¢ | $1,127 | $1,385 |
| Serie A | 2.8¢ | $467 | $404 |
| Bundesliga | 3.0¢ | $1,089 | $318 |
| G League | 3.8¢ | $241 | $872 |
| Conference League | **5.8¢** | **$391** | $274 |
| Copa Libertadores | 5.9¢ | $1,953 | $113 |
| Eredivisie | **8.0¢** | $1,754 | $54 |

The pattern is unambiguous: **coverage, not sport, determines efficiency.** A
Conference League match is four times wider than a Champions League match. That is the
rent available to a maker with a good model — and the tax on a taker without one.

**Politics partition structure:**

| Event | Legs quoted | Σ YES ask | Σ YES bid | Overround |
| --- | --- | --- | --- | --- |
| Democratic nominee 2028 | 42 | 0.974 | 0.914 | −2.6¢ (no taker arb) |
| Republican nominee 2028 | 38 | 0.982 | 0.930 | −1.8¢ |
| Presidential winner 2028 | 36 | 0.957 | 0.909 | −4.3¢ |
| French presidential 2027 | 14 | 1.023 | 0.982 | +2.3¢ |
| Rosemont by-election | 4 | **1.159** | 0.929 | **+15.9¢** |
| Laurier by-election | 4 | 1.101 | 0.968 | +10.1¢ |
| Yorkton by-election | 3 | 1.049 | 0.972 | +4.9¢ |

National politics books are tight: the naive "sum of YES < 1" arbitrage is **not**
available after 4% fees and 0.5-1¢ per-leg spreads. Local by-elections have 5-16%
overround, but the book is wide on *both* sides, so there is no riskless taker trade —
the opportunity is to **make** the partition, not take it.

**Nested-deadline monotonicity:** across 8 "by [date]" event families, **zero**
top-of-book violations. The obvious calendar arbitrage is already gone. The residual
edge is in newly listed legs and post-news repricing (§5.7).

---

## 4. The empirical evidence base

### 4.1 Binance signal scan (measured)

Data: BTC/ETH/SOL, 5m (120d), 15m (240d), 1h (730d), 1d (2,500d), through 2026-11-15.
Signals: streaks, RSI, ATR shocks, volume spikes, trend, time-of-day, cross-asset lead.

The only robust pattern is **short-horizon mean reversion after a down move**:

| Symbol / TF | Signal | n | Next-bar UP | Lift vs base | Wilson LB |
| --- | --- | --- | --- | --- | --- |
| BTC 15m | down > 1.5 ATR | 354 | **59.9%** | +10.5pp | 54.7% |
| BTC 15m | 3 red | 2,660 | 53.5% | +4.1pp | — |
| BTC 5m | volume > 2× + red | 1,457 | 55.8% | +6.0pp | 53.2% |
| BTC 5m | down > 1.5 ATR | 820 | 55.6% | +5.8pp | 52.2% |
| BTC 1h | 3 red | 1,901 | 54.7% | +4.6pp | — |
| BTC 1h | RSI < 30 | 874 | 55.0% | +4.9pp | — |
| SOL 15m | volume > 2× + red | 906 | **57.6%** | +7.7pp | — |
| SOL 1h | 5 red | 361 | **59.6%** | +9.5pp | — |
| ETH 15m | volume > 2× + red | 1,053 | 55.8% | +6.4pp | — |

Two cautions that the table does not show:

1. **The average next-bar return is negative or zero even when the UP rate is high.**
   BTC 15m `down > 1.5 ATR`: UP 60.1% but average next return **−0.54 bps** (t = −0.30).
   The sign edge is real; the dollar edge is not. Binary contracts are the correct
   wrapper because they pay for the sign, not the magnitude.
2. **The edge is not stable across regimes.** Train/test splits flatter 5m signals
   (e.g. volume-spike-red: +7.2pp train, +3.1pp test) and degrade 15m ATR shocks
   (+12.3pp train, +6.4pp test). Assume the live edge is the lower number.

### 4.2 Real Polymarket 5m/15m windows (measured)

24 hours of real windows: **287 × 5m** and **96 × 15m**, with 1-minute Binance bars for
the same period.

Base rates: 5m UP **50.0%** (n=228 joined), 15m UP **55.6%** (n=36 joined). The 15m
sample is too small to call a base rate; treat 50% as the prior.

**Nowcast model vs. market price (Brier score, lower is better):**

| Time remaining | 5m model | 5m market | 15m model | 15m market |
| --- | --- | --- | --- | --- |
| 4m | 0.178 | 0.243 | — | — |
| 3m | 0.151 | 0.196 | — | — |
| 2m | 0.104 | 0.170 | — | — |
| 1m | **0.064** | **0.118** | — | — |
| overall | **0.124** | **0.181** | **0.144** | **0.152** |

The market lags spot, and the lag is largest in the last two minutes. That is a real
information edge — but see §4.4 before treating it as executable.

**Price calibration (last trade, all observations):**

| Bucket | 5m n | 5m avg → realized | 15m n | 15m avg → realized |
| --- | --- | --- | --- | --- |
| 0-10¢ | 108 | 4.1% → 5.6% | 190 | 3.3% → 2.6% |
| 10-20¢ | 83 | 15.2% → 21.7% | 126 | 15.1% → 14.3% |
| 20-30¢ | 87 | 25.2% → **17.2%** | 118 | 25.2% → **16.9%** |
| 30-40¢ | 138 | 35.2% → 32.6% | 155 | 35.6% → 32.3% |
| 40-60¢ | 349 | 49.3% → 48.4% | 324 | 49.1% → 53.4% |
| 60-70¢ | 130 | 64.6% → 64.6% | 111 | 64.2% → 69.4% |
| 70-80¢ | 82 | 74.5% → 76.8% | 78 | 74.6% → **87.2%** |
| 80-90¢ | 54 | 84.3% → 87.0% | 69 | 85.4% → 85.5% |
| 90-100¢ | 89 | 95.3% → **98.9%** | 151 | 96.5% → 95.4% |

The 20-30¢ bucket is rich in both horizons (−8pp). The 5m 90-100¢ bucket is cheap
(+3.6pp), and the 15m 70-80¢ bucket is cheap (+12.6pp, n=78 — treat as suggestive, not
proven). This is the FLB showing up inside a 24-hour crypto sample, which is a useful
confirmation that the effect is not only a long-horizon artifact.

### 4.3 The transfer test: Binance signals do not survive to Polymarket (measured)

This is the most important negative result in the study. The same signals were scored
against **actual Polymarket window resolutions**, using the last completed Binance bar
before each window opened:

| Signal | 5m windows | 5m UP rate | 15m windows | 15m UP rate |
| --- | --- | --- | --- | --- |
| All | 227 | 50.2% | 36 | 55.6% |
| Previous candle red | 110 | **48.2%** | 17 | **47.1%** |
| 3 red | 25 | 48.0% | 5 | 40.0% |
| 5 red | 7 | 71.4% | 1 | — |
| RSI < 30 | 9 | 44.4% | 0 | — |

The Binance bounce (53-60% UP) becomes a **48% / 47% DOWN continuation** on the
Polymarket windows. The samples are small for the conditional cells, but the direction
is consistent and the base-rate cells are large enough (n=110, n=17) to reject the
naive live bot. Plausible reasons: Chainlink TWAP smoothing changes the effective
sampling, the windows are aligned differently from Binance candles, and the marginal
Polymarket trader is not the Binance mean-reverter.

**Conclusion: do not deploy a technical UP/DOWN taker bot on 5m or 15m.** The signal is
a Binance-bar artifact, not a Polymarket-window edge.

### 4.4 Execution reality: the last trade is not a price (measured)

The nowcast table above uses `prices-history`, which is **last trade**, not a live
quote. Measured quote ages:

| Horizon | Median quote age | p90 | Max | Median time to next trade |
| --- | --- | --- | --- | --- |
| 5m | 44s | 58s | 219s | 60s |
| 15m | 44s | 74s | 281s | 64s |

In the 24h sample, **no window had a next trade within 15 seconds** of the observation
timestamp. The apparent late-window ROI (e.g. +160% per ticket on 63 trades) is
therefore an **upper bound on a stale print**, not an executable backtest. The
microstructure literature explains why: feed-inferred trade direction agrees with
on-chain ground truth only ~59% of the time, and depth decays sharply near resolution.

**Operational rule:** before any taker entry, require `quote_age ≤ 10s` **and**
`displayed_size ≥ 3× clip`. If either fails, post a maker order instead. In practice
this means the 5m/15m edge is a **liquidity-provision** edge, not a sniping edge.

### 4.5 Sports and politics structure (measured + published)

- **Sports FLB is absent.** The 2026 study finds dollar-weighted sports longshots at
  **+2.43%** (CI includes zero) and sports favorites at **−0.230%**. Do not blanket-sell
  sports longshots. The edge in sports is information and spread, not tail bias.
- **Politics FLB is two-sided and strong.** Longshots **−16.34%**, favorites
  **+1.044%** dollar-weighted. This is the cleanest tail trade in the venue.
- **Sports liquidity is coverage-driven.** Conference League / Eredivisie / G League
  books are 4-8× wider than Champions League / MLS books (§3.3). The wide book is both
  the opportunity (maker) and the tax (taker).
- **Politics partitions are tight at the top, wide at the bottom.** National nominee
  books sum to 0.96-0.98 on the ask; local by-elections sum to 1.02-1.16. The taker arb
  is gone; the maker rent is in the local tails.

---

## 5. Strategy catalog

Each strategy is a complete spec. `Sizing` is % of NAV per ticket and the family cap is
the maximum simultaneous exposure. `Status` follows the gates in §6:
**deploy** = measured + paper-traded + kill switch tested; **paper** = measured but not
yet live-validated; **research** = structural/hypothesis, not measured; **avoid** =
tested and rejected.

### 5.1 BTC / ETH / SOL — 5-minute UP/DOWN

The 5m market is the deepest crypto prediction market (~$48k per window, ~$13.8M/day on
BTC alone). It is also the fastest and the most adversarially selected near resolution.
The edge is **not** in predicting the candle; it is in **quoting the last two minutes
better than a stale book**.

#### `c5-nowcast-maker` — Late-window TWAP nowcast maker

- **Game:** G1 information (nowcast) + G2 liquidity + G5 queue.
- **Thesis:** the CLOB's last trade is a median 44s old, while the window outcome is
  already 60-90% determined by the 60s TWAP. A maker who prices the TWAP-consistent
  probability and posts inside the stale quote earns the convergence, not a directional
  bet.
- **Fair value:**
  - `S0` = Chainlink BTC/USD 60s TWAP at window open.
  - `St` = 60s TWAP at time `t` (average the last 60 one-second prints; if unavailable,
    use an EMA-60s of the mid).
  - `σ` = stdev of 1-minute log returns over the prior 60 minutes, floored at 0.35× the
    24h median.
  - `z = ln(St / S0) / (σ × √remaining_minutes)`, `P_model = Φ(z)`.
  - `P_quote = 0.75 × P_model + 0.25 × market_mid` (shrink to the market to hedge model
    error).
- **Entry (maker only):**
  - Window: `remaining ∈ [1.5, 4.0]` min for 5m; `[4, 12]` min for 15m.
  - Post YES bid at `P_quote − buffer − spread/2`, NO bid at `(1−P_quote) − buffer − spread/2`.
  - `buffer = max(0.015, 0.35 × fee_per_share)`.
  - Reprice when `|ΔP_model| > 2¢` or every 10s.
  - **Do not quote** when `|z| > 2.5` (outcome effectively decided) or in the last 60s
    (TWAP already locked in; only informed takers remain).
- **Taker override (rare):** `|P_model − executable_ask| ≥ 10¢` **and** quote age ≤ 10s
  **and** displayed size ≥ 3× clip. Measured fill probability: ~0/day in the 24h sample.
  Do not build a bot that depends on this.
- **Exit:** hold to resolution; no mid-window stop (the contract is binary and the
  remaining edge is in convergence, not in stop-losses).
- **Sizing:** 0.5% NAV per window per asset; 2% gross across all 5m markets; inventory
  cap 20 contracts per side.
- **Expected edge:** 1.2-2.5% of filled notional per round trip from spread capture;
  maker fee 0; rebate up to **0.7% of notional at 50¢** (0.35¢ per share = 20% × 1.75¢).
  Net after adverse selection: **unknown until paper-traded**.
- **Capacity:** ~$0.5-1k per window per asset at the top 5 levels (estimate from
  $48k/window volume at 1-2% participation); $5-10k/day per asset.
- **Risks:** adverse selection from informed takers in the last 60s; oracle/spot basis
  (Chainlink vs Binance); inventory accumulation in a trending window; API latency.
- **Kill switches:** 30-fill mean markout at +30s worse than −4¢; 5 consecutive windows
  with `|P_model − outcome| > 0.15`; fill rate > 40% of quotes (you are being picked
  off); any window where the book shows < $200 depth on both sides.
- **Status:** **paper**. Evidence: measured nowcast Brier + structural book staleness.

#### `c5-cross-asset` — BTC-led ETH/SOL/XRP repricing

- **Game:** G1 information (lead-lag) + G5 speed.
- **Thesis:** BTC leads alts by 5-30 seconds in fast moves. If BTC moves ≥ 12 bps in
  60s and the alt's 5m book has not repriced (quote age > 15s), the alt's fair value has
  moved by `β × BTC move`.
- **Fair value:** `β` from a 24h regression of alt 5m returns on BTC 5m returns; require
  `R² > 0.35` and `β ∈ [0.6, 1.6]`. Otherwise no trade.
- **Entry:** maker only, same window and buffer as `c5-nowcast-maker`; require the alt
  quote age > 15s and the BTC move to be in the last 60s.
- **Sizing:** 0.25% NAV per trade; 1.5% gross across BTC+ETH+SOL (one factor).
- **Expected edge:** 2-5% of notional when the lead is real; unmeasured.
- **Risks:** the alt may be leading BTC (reverse causality); correlated inventory across
  three books; the move may be a single-venue print.
- **Kill switch:** 20-trade hit rate < 48% or markout < −5¢.
- **Status:** **research**.

#### `c5-open-ignore` — Do not trade the first 60 seconds

- **Game:** G5 (queue) / G1 (no information).
- **Thesis:** the first 60s has no TWAP information and the widest adverse selection;
  the Binance "prev red" signal actually resolves 48.2% UP on Polymarket (n=110).
- **Rule:** no directional taker entries in `[T, T+60s]`; no Binance-indicator bot on
  5m at any time.
- **Status:** **avoid**. Evidence: measured transfer test.

### 5.2 BTC / ETH / SOL — 15-minute UP/DOWN

The 15m market is smaller (~$34k per window, ~$3.3M/day on BTC) and the nowcast edge is
materially weaker (Brier 0.144 vs 0.152). The 70-80¢ bucket is the only calibration
anomaly that looks exploitable, and it is based on n=78.

#### `c15-nowcast-maker` — Wider-window nowcast maker

- **Game:** G2 liquidity + G1 weak nowcast.
- **Entry:** `remaining ∈ [4, 12]` min; `P_quote = 0.7 × P_model + 0.3 × market_mid`;
  buffer `max(0.02, 0.35 × fee_per_share)`; do not quote when `|z| > 2.2`.
- **Sizing:** 0.75% NAV per window; 2% gross.
- **Expected edge:** 1-2% of notional; mostly spread capture.
- **Kill switch:** same markout test as `c5-nowcast-maker`; additionally retire if the
  model Brier exceeds the market Brier over a rolling 100 observations.
- **Status:** **paper**.

#### `c15-favorite-carry` — 70-88¢ favorite carry

- **Game:** G3 behavioural (FLB inside crypto) + G1 confirmation.
- **Thesis:** the 70-80¢ bucket realized **87.2%** vs a 74.6% average price (+12.6pp,
  n=78); the 90-100¢ bucket realized **98.9%** on 5m (+3.6pp, n=89). The market
  under-prices high-probability crypto windows.
- **Entry:** buy YES at ask ≤ `P_model − 4¢`, price band **[0.70, 0.88]**, remaining
  ≥ 5 min, quote age ≤ 20s, depth ≥ $200.
- **Exit:** hold to resolution. Do not add to a losing window.
- **Sizing:** 0.5% NAV per ticket; 1.5% gross; max 3 concurrent.
- **Expected edge:** +6-10pp gross, fee at 78¢ = **1.54% of stake**, net **+5-9pp**; but the
  tail is a 78¢ loss, so the strategy needs ≥ 30 independent tickets to be statistically
  meaningful.
- **Risks:** the bucket edge may be a 24h sample artifact; regime shift to high
  volatility; correlated losses across BTC/ETH/SOL in the same 15 minutes.
- **Kill switch:** rolling 40-ticket hit rate Wilson lower bound < 80% at an average
  entry of 78¢; two consecutive weeks of negative net P&L.
- **Status:** **paper**. Evidence: measured calibration, small n.

#### `c15-signal-avoid` — Binance bounce is rejected here too

- **Rule:** no 3-red / RSI<30 / ATR-shock taker entries on 15m Polymarket windows.
- **Evidence:** measured 47.1% UP after a red candle (n=17); 40.0% after 3 red (n=5).
  Binance says 55.4% the other way. The samples are small, but there is no evidence of
  transfer and a clear mechanism for why not (TWAP + different window alignment).
- **Status:** **avoid**.

### 5.3 BTC / ETH / SOL — 1-hour UP/DOWN

The hourly UP/DOWN market is **smaller than 5m/15m but not thin**. Measured across 24
closed windows: BTC ~$458k/day, ETH ~$106k/day, SOL ~$23k/day. The spread at 99¢ is
0.6¢ (tight in cents, wide in relative terms). This is a **small-capacity** information
game relative to the $13.8M/day 5m book, not a volume business.

#### `c1h-exhaustion-limit` — 3-red / RSI exhaustion, limit-only

- **Game:** G1 information (mean reversion) + G2 (limit order).
- **Thesis:** after 3 consecutive red hours (or RSI14 < 35), the next hourly bar is UP
  54.7-55.9% on Binance (n=1,901 / 874 / 383). The effect is real in sign but thin in
  dollars; buying only at ≤ 52¢ preserves the edge.
- **Entry:** 3+ consecutive red 1h candles **or** RSI14 < 35 on the last closed bar; buy
  UP only at limit ≤ **0.52**; no entry if the market is already > 54¢ or if the spread
  > 3¢.
- **Exit:** hold to resolution; cancel the limit if unfilled by T+10 min.
- **Sizing:** 0.5% NAV per ticket; 1.5% gross; max 3 concurrent (BTC/ETH/SOL).
- **Expected edge:** 55% × 1 − 0.5375 all-in ≈ **+1.25¢ per share ≈ 2.3% of stake**;
  Wilson lower bound on 55% with n≈900 is ~53.3%, so the edge is positive but thin.
- **Capacity:** ~$500-1,000 per hourly window; $1-3k/day per asset.
- **Risks:** macro news (FOMC/CPI/NFP) invalidates the mean-reversion; the hourly market
  may not have a two-sided quote at 52¢; ETH/SOL books are thinner than BTC.
- **Kill switch:** 60-trade rolling hit rate < 52%; any single loss > 1% NAV; blackout
  ±30 min around scheduled macro releases.
- **Status:** **paper**.

#### `c1h-quiet-maker` — Quiet-regime two-sided maker

- **Game:** G2 liquidity + G5 rebate.
- **Thesis:** in quiet regimes, hourly crypto markets have predictable flow and no
  informed catalyst; a maker can earn the spread plus the 20% rebate.
- **Regime filter:** ATR14 in the 30-70th percentile of the last 60 hours; no scheduled
  macro event within 2h; 1h realized vol < 1.5× the 24h median.
- **Quotes:** ± `max(2¢, 0.5 × ATR%)` around `P_model` (same TWAP model, remaining in
  minutes); size 25% of normal; cancel on a 2σ move.
- **Sizing:** 0.25% NAV per side; 1% gross.
- **Expected edge:** 0.3-0.8% of notional per fill; dominated by adverse selection in
  the first hour after a news shock.
- **Kill switch:** markout < −3¢ over 30 fills; widen or stop.
- **Status:** **research**.

### 5.4 BTC / ETH / SOL — 1-day UP/DOWN

**The daily UP/DOWN market is the wrong market.** BTC's daily UP/DOWN does ~$15k/day;
the same day's **barrier ladder** ("Bitcoin above ___ on November 16?") does ~$352k
across 11 strikes — 23× the volume. The ladder is a set of digital options, and digital
options have a hard no-arbitrage structure (monotonicity in strike, sum-to-one across a
partition). That is where the edge is.

#### `c1d-ladder-relative-value` — Price the digital ladder, not the candle

- **Game:** G4 mechanism (barrier/ladder) + G3 tail richness.
- **Thesis:** the ladder is well calibrated near the money and **rich in the far tails**.
  Snapshot 2026-11-15 (spot ~$64.9k, ~21h to expiry, σ≈3.2%/day):
  - $66k strike: market 29.2¢ vs lognormal 29.5¢ — fair.
  - $68k strike: market 7.0¢ vs lognormal 6.2¢ — 0.8¢ rich.
  - $70k strike: market 1.7¢ vs lognormal 0.6¢ — **1.1¢ rich**.
  The far-tail richness is the FLB in digital form.
- **Entry:**
  - Fit a lognormal (or an empirical distribution from the last 90 days) to the expiry
    spot; compute `P(S_T > K)` for every strike.
  - **Sell** the tail when `market_ask ≥ model + 1.0¢` and `market_ask ≤ 5¢`; buy NO
    (or post a NO ask) rather than shorting YES.
  - **Buy** a strike when `market_ask ≤ model − 4¢` and the strike is within 1.5σ.
  - Enforce monotonicity: if `ask(K1) < ask(K2)` for `K1 < K2`, buy the lower strike /
    sell the higher strike (the ladder was monotone at top-of-book in the snapshot, so
    this is a monitoring rule, not a core trade).
- **Exit:** hold to expiry; the digital is path-independent at expiry.
- **Sizing:** 0.5% NAV per leg; 3% per expiry; max 8 legs.
- **Expected edge:** 0.5-1.5% of stake per tail leg (fee at 98¢ is 0.14% of stake);
  near-the-money dislocations are rarer but larger.
- **Capacity:** $1-3k per strike (liquidity $50-90k per strike; stay < 2%).
- **Risks:** fat tails (a 1.7¢ strike can pay), model error in σ, expiry-time mismatch,
  oracle source (Chainlink vs Binance).
- **Kill switch:** two tail losses in one expiry; model-vs-market Brier > 0.02 over 50
  strikes; any strike with < $200 depth.
- **Status:** **paper**.

#### `c1d-updown-avoid` — No daily indicator trading

- **Thesis:** daily base rates are 50.3% BTC, 51.8% ETH, 49.8% SOL; no 1d signal in the
  scan clears the 53.5% break-even at 50¢ with stability. The daily UP/DOWN book is
  thin, so the spread is wide relative to the edge.
- **Rule:** no technical daily UP/DOWN entries. Use the ladder for expression, or trade
  event-driven macro around FOMC/CPI/ETF decisions.
- **Status:** **avoid**. Evidence: measured scan + structural liquidity.

### 5.5 Non-popular sports

Definition: leagues and events with **low coverage**, not low skill — Conference League,
Eredivisie, Copa Libertadores, G League, ITF/Challenger tennis, bilateral cricket,
lower-tier MMA, college sports outside the power conferences.

The structural fact: median spread 3.8-8.0¢ and median liquidity $241-$1,953, versus
2.2¢ / $3k in the Champions League. Wide books are the rent.

#### `sn-consensus-anchor` — Sharp-consensus devig, taker

- **Game:** G1 information (odds market) + G2 (wide Polymarket book).
- **Thesis:** Polymarket's sports book is set by a thin crowd; sharp bookmakers have
  already priced the match. Devig two or more sharp books and trade only when
  Polymarket is ≥ 6¢ off the consensus.
- **Fair value:**
  - Collect 2+ bookmaker prices (or a sharp exchange) for the same market.
  - Devig each book (proportional or Shin) → `P_fair`.
  - Require book disagreement ≤ 4pp; otherwise no trade.
  - Median across books.
- **Entry:** buy YES when `ask ≤ P_fair − 0.06`; buy NO when
  `1 − bid ≤ (1 − P_fair) − 0.06`. The 6¢ buffer covers the 5% sports fee (2.5% of
  stake at 50¢, 3.5% at 30¢), the spread, and model error.
- **Window:** after official lineups (T-60m) and before T-5m. No in-play in the first
  5 minutes (red cards, injuries, weather delays).
- **Exit:** hold to resolution; no in-play stop for pre-match positions.
- **Sizing:** 0.5% NAV per ticket; 1.5% per league-day; 3% total sports.
- **Expected edge:** 2-4% of stake per trade after fees; 55-60% hit rate on a 6¢ buffer.
- **Capacity:** $100-500 per match (median liquidity $241-$1,953).
- **Risks:** bookmaker error/limits; lineup late scratch; void/postponement rules;
  Polymarket resolution source differs from the book's settlement.
- **Kill switch:** Brier vs closing line > 0.05 over 50 bets; two consecutive weeks
  negative; any league with median spread > 10¢ is maker-only.
- **Status:** **paper**. Evidence: structural spread data + published sports FLB absence
  (so the edge must come from information, not tail bias).

#### `sn-partition-maker` — Make the outright overround

- **Game:** G2 liquidity + G4 partition structure.
- **Thesis:** outright/futures markets (league winner, top scorer, qualification) often
  show a 5-20¢ overround because one side of each book is a placeholder. Example
  snapshot: Conference League winner — Monaco 13.2/71.5, Copenhagen 2.9/60.5, Freiburg
  0.2/12.9. Those are not two-sided quotes; they are wide, one-sided books.
- **Entry:** only where (a) top-5 depth on the opposite side ≥ $200, (b) you have an
  independent model (Elo/odds), (c) the sum of your fair values = 1.00 ± 0.02.
  Post bids at `fair − 1¢`, asks at `fair + 1¢`; do not cross.
- **Sizing:** 0.25% NAV per leg; 1% per event.
- **Expected edge:** 3-8% of notional per fill; fill rate is low.
- **Risks:** the "placeholder" quote is a signal that nobody is there; you may be the
  only maker and the only taker is informed. Adverse selection dominates if your model
  is worse than the market's.
- **Kill switch:** markout < −5¢ over 20 fills; any leg with < $100 depth.
- **Status:** **research**.

### 5.6 Popular sports in unpopular leagues

Definition: a globally followed club or athlete competing in a low-coverage competition
— a top-5 league club in the Conference League or a domestic cup, a big brand in a
minor league or friendly, a famous fighter on a regional card, a national team in a
minor tournament.

Two distinct edges:

1. **Brand bias (cross-sectional).** Public money buys the brand regardless of lineup,
   motivation, travel or pitch. The market overprices the favourite and underprices the
   underdog/draw.
2. **Lineup lag (temporal).** The official lineup is released ~60 minutes before
   kickoff. Casual bettors do not know the rotation players; the market reprices slowly.

#### `spu-brand-fade` — Fade the brand premium

- **Game:** G3 attention/behavioural + G1 lineups.
- **Thesis:** in low-coverage competitions, the popular club is priced on reputation,
  not on the XI. Rotation, travel, altitude, pitch and motivation are systematically
  underweighted.
- **Trigger:**
  - Popular club (top-20 global following, or from a top-5 league) in a competition with
    median spread ≥ 4¢.
  - Market price ≥ 8pp above a lineup-aware fair value.
  - **Or** ≥ 4 regular starters are rested/absent and the market has moved < 3pp since
    the lineup release.
- **Entry:** buy NO / lay the favourite at `1 − bid` when
  `P_fair(no) ≥ price(no) + 0.07`. Prefer maker orders (5% sports fee; maker 0 + 15%
  rebate).
- **Competition-specific rules:**
  - **Two-legged ties:** the "to qualify" market and the 90-minute market disagree; the
    second leg has draw-as-a-live-outcome dynamics. Buy the qualification leg when the
    90-minute draw is priced as a loss.
  - **Friendlies / preseason:** motivation is unobservable; reduce size by 50% or skip.
  - **Cup ties:** draw at 90 minutes is a real outcome; do not treat the favourite's
    "win" price as a qualification price.
- **Sizing:** 0.5% NAV per ticket; 1% per competition-day; 2.5% total.
- **Expected edge:** 4-8% of stake when the brand premium is ≥ 8pp; unmeasured on
  Polymarket, but consistent with the sports-betting brand-bias literature.
- **Capacity:** $100-400 per match (Conference League median liquidity $391).
- **Risks:** the brand may genuinely be better (rotation players are still good); the
  market may know the lineup before you; void rules; low liquidity → exit slippage.
- **Kill switch:** 30-trade hit rate < 50%; markout < −6¢; any match with < $150 depth.
- **Status:** **research**. Evidence: structural spread data + attention literature;
  needs a lineup-aware model before live.

#### `spu-lineup-lag` — Trade the 60-minute information event

- **Game:** G1 information (lineups) + G5 speed.
- **Thesis:** the lineup release is the highest-information, lowest-attention moment in
  a low-coverage match. A player-impact model can convert the XI into a probability
  shift faster than the market.
- **Fair value:** `ΔP = Σ (minutes_weight × player_impact)` relative to the expected XI;
  calibrate player impact from market value or plus/minus, and shrink by 50% for
  uncertainty.
- **Entry:** when `|ΔP| ≥ 6pp` and the market has not moved ≥ 3pp within 90s of the
  lineup release, take the side with a limit order. If the market moves first, stand
  down.
- **Sizing:** 0.4% NAV per ticket; 1% per slate.
- **Expected edge:** 3-6% of stake; the edge decays within 5-10 minutes.
- **Risks:** lineup news leaks before the official release; the model overweights
  star players; the market is right and you are wrong about the replacement quality.
- **Kill switch:** 20-trade hit rate < 48%; any slate with > 3 simultaneous entries
  (correlation).
- **Status:** **research**.

### 5.7 Politics

Politics is the cleanest behavioural trade in the venue: two-sided FLB (−16.34% on
longshots, +1.044% on favorites, dollar-weighted), deep books at the top, and a
mechanism layer (rules, deadlines, oracles) that creates a second, uncorrelated edge.

#### `pol-favorite-carry` — Buy 88-96¢ favorites

- **Game:** G3 behavioural (FLB) + carry.
- **Thesis:** favorites at or above 90¢ earn +0.83% dollar-weighted and +1.044% in
  politics. The return on capital is much larger than the return on notional: 8¢ of edge
  on a 92¢ stake is 8.7% over the holding period. At 60 days that is ~50% annualized
  gross, before the 4% fee (**0.32% of stake at 92¢**).
- **Entry:**
  - YES ask in **[0.88, 0.96]**.
  - Liquidity ≥ $100k, spread ≤ 1¢, resolution ≤ 90 days.
  - No other position in the same event cluster (same election, same party, same
    nominee).
  - Annualized net edge `(1 − price − fee) / price × 365 / days ≥ 8%`.
- **Exit:** hold to resolution. Sell only if the price reaches 99¢ and the annualized
  edge falls below 3%.
- **Sizing:** 2% NAV per market; 8% per event cluster; 25% total politics carry.
- **Expected edge:** +0.5-0.8% of notional, ~8-12% annualized on capital; **this is a
  carry trade, not a growth engine**.
- **Tail risk:** a 92¢ favorite losing costs 92¢. With 25 uncorrelated positions, one
  loss is ~3.7% of the carry sleeve. Correlated clusters (same party sweep) can lose
  several at once — hence the 8% cluster cap.
- **Kill switch:** two cluster losses in one quarter; any market with a rule clarification
  or oracle dispute; liquidity < $50k after entry.
- **Status:** **deploy** (small size). Evidence: published FLB + measured partition
  tightness.

#### `pol-longshot-fade` — Sell sub-8¢ longshots via NO

- **Game:** G3 behavioural + G2 maker rebate.
- **Thesis:** longshots below 10¢ lose 19.35% dollar-weighted. Buying NO at 92-98¢ is the
  same trade with a bounded payoff and a 25% maker rebate.
- **Entry:** YES bid ≤ 8¢; buy NO at `1 − bid` (equivalently post a NO bid at
  `1 − ask + 1¢` as a maker); require liquidity ≥ $50k and a resolution ≤ 180 days.
- **Sizing:** 1% NAV per market; 6% per event cluster; 15% total.
- **Expected edge:** 2-6% of stake over the holding period; fee 0 as maker, rebate 25%
  of the taker fee pool.
- **Risks:** the 2% tail that hits; crowded carry (many bots sell the same tails);
  resolution ambiguity (a "no" that should have been "yes").
- **Kill switch:** two tail hits in one month; any market where the rule text is
  ambiguous; cluster exposure > 6%.
- **Status:** **paper**. Evidence: published FLB; needs live markout.

#### `pol-partition-maker` — Make the local overround

- **Game:** G2 liquidity + G4 partition structure.
- **Thesis:** national nominee books are tight (Σ ask 0.957-0.982); local by-elections
  are wide (Σ ask 1.022-1.159, Σ bid 0.929-0.972). The taker arb is gone, but the maker
  rent is 2-16¢ per partition.
- **Entry:**
  - True partition (mutually exclusive, exhaustive), all legs quoted two-sided.
  - `|Σ mid − 1| ≥ 3¢`.
  - Your fair values sum to 1.00 ± 0.02.
  - Liquidity $1k-$50k; spread ≥ 2¢ on at least two legs.
  - Post bids on the cheap legs and asks on the rich legs; do not cross.
- **Sizing:** 0.25% NAV per leg; 1% per event; 5% total.
- **Expected edge:** 2-6% of notional per filled leg; capacity is tiny.
- **Risks:** the wide book is wide because the event is uncertain; a single news shock
  reprices all legs at once; you may be the only maker and the only taker is informed.
- **Kill switch:** markout < −5¢ over 20 fills; any event with a rule change; any leg
  with < $100 depth.
- **Status:** **research**.

#### `pol-resolution-rule` — Trade the literal rule, not the narrative

- **Game:** G4 mechanism/oracle.
- **Thesis:** politics markets are priced on narrative; resolution is on text. Gaps
  appear when the rule says "announce" but the market trades "occur", when a deadline is
  inclusive/exclusive, when the source has already published but the market has not
  resolved, or when a new deadline leg is listed.
- **Checklist before entry:**
  1. Quote the exact resolution sentence.
  2. Identify the source and the timezone of the deadline.
  3. Check whether the event has already happened and the source has published.
  4. Check the "no event by date" default.
  5. Check whether the market can resolve early.
- **Entry:** only when the literal rule contradicts the price by ≥ 10¢ and the fact is
  **already public**. Size 1% NAV; no leverage; no correlated cluster.
- **Exit:** hold to resolution, or exit when the market converges to the rule.
- **Risks:** UMA dispute; rule ambiguity; the source changes the page; the market
  resolves on a different source than you read.
- **Kill switch:** any active dispute; any rule clarification; any market where two
  readings are both defensible.
- **Status:** **paper**. Highest edge per trade, lowest frequency, highest operational
  risk.

#### `pol-nested-monotonicity` — New legs and post-news curve trades

- **Game:** G4 mechanism + G1 information.
- **Thesis:** nested deadlines must satisfy `P(by earlier) ≤ P(by later)`. Across 8 event
  families the top-of-book was **monotone** (0 violations), so the naive calendar arb is
  gone. The residual edge is (a) a newly listed leg that prices off the wrong anchor,
  and (b) a news shock that moves one leg but not the curve.
- **Entry:**
  - Fit a hazard rate from the existing curve: `P(by t) = 1 − exp(−λt)` or a stepwise
    empirical curve.
  - If a new leg deviates > 6¢ from the curve, trade it against the nearest two legs.
  - If a shock moves the near leg > 8pp but the far leg < 3pp, buy the far leg / sell the
    near leg.
- **Sizing:** 0.5% NAV per leg; 2% per event.
- **Expected edge:** 3-6¢ per dislocation; frequency low.
- **Kill switch:** any violation that persists > 60s (means the market knows something
  you do not); any event with < $500 depth.
- **Status:** **research**.

---

## 6. Shared risk and execution overlay

These rules apply to every strategy. They are not optional.

### 6.1 Sizing ladder

| Level | Per ticket | Per family | Total |
| --- | --- | --- | --- |
| Research | 0.1% NAV | 0.5% | 1% |
| Paper | 0 (simulated) | — | — |
| Deploy | 0.5-2% NAV | 5-8% | 25% |

- Use **quarter-Kelly** on the calibrated probability, never full Kelly.
- Cap the stake at 2% NAV even if Kelly says more; binary tails violate the Kelly
  assumptions.
- Correlated positions (same factor, same event, same party) count as one exposure.

### 6.2 Paper-trade gates

A strategy moves from `paper` to `deploy` only if:

1. ≥ **100 paper tickets** (or 30 for low-frequency sports/politics).
2. Net P&L positive after the real fee model, not the old 1% model.
3. **Wilson lower bound** on the hit rate > the break-even rate.
4. Mean markout at +30s (maker) or +5m (taker) is not negative.
5. Max drawdown < 10% of the paper bankroll.
6. The kill switch has been tested at least once in simulation.

### 6.3 Kill-switch ladder

| Trigger | Action |
| --- | --- |
| −3% NAV in a day | Halve size, review fills |
| −8% NAV in a week | Stop new entries, keep exits |
| −12% NAV from peak | Full stop, manual review |
| 3 consecutive losing days on one strategy | Retire the strategy, not the family |
| Markout < −5¢ over 30 fills | Stop the maker; you are the liquidity |
| Rule clarification / oracle dispute | Freeze the market immediately |

### 6.4 Blackout calendar

No new entries in the ±30 minutes around:

- FOMC decision, CPI, NFP, GDP, PCE.
- ETF approval/denial windows and major options expiry (quarterly).
- Election-night vote counts and certification deadlines.
- Official lineup releases for sports (enter *after*, not before).
- Any market with an active UMA dispute.

### 6.5 The anti-playbook (what not to do)

1. **Do not run a Binance indicator bot on Polymarket 5m/15m.** Measured: the edge
   reverses (48.2% / 47.1% UP after a red candle).
2. **Do not taker-trade a stale last print.** Median quote age 44s; no next trade within
   15s in the sample. The apparent ROI is not executable.
3. **Do not blanket-sell sports longshots.** Sports FLB is absent (+2.43%, CI includes
   zero). You will be selling insurance at the wrong price.
4. **Do not take the sum-to-one "arb" in national politics books.** Σ ask is 0.957-0.982,
   but 36-42 legs × 0.5-1¢ spread + 4% fees eats it. The arb is a maker trade in local
   partitions, not a taker trade.
5. **Do not use the daily UP/DOWN market for size.** $15k/day vs $352k on the ladder.
6. **Do not model crypto fees as 1%.** At 50¢ the real taker cost is 3.5%; the old FLARE
   default understated the hurdle by 2.5pp.
7. **Do not ignore the oracle.** Chainlink TWAP ≠ Binance candle; UMA rules ≠ the
   headline. A 2¢ mispricing is noise next to a resolution error.
8. **Do not scale a maker without markouts.** The 2026 MARL result is explicit: spread
   capture can look profitable and still have negative held-out portfolio value.

---

## 7. Expected performance, honestly

| Family | Best strategy | Net edge per ticket | Capacity/day | Confidence |
| --- | --- | --- | --- | --- |
| BTC/ETH/SOL 5m | `c5-nowcast-maker` | 1.2-2.5% of notional | $5-10k/asset | Medium (measured Brier, unmeasured fills) |
| BTC/ETH/SOL 15m | `c15-favorite-carry` | 5-9% of stake | $1-3k/asset | Low-medium (n=78 bucket) |
| BTC/ETH/SOL 1h | `c1h-exhaustion-limit` | 2-3% of stake | $1-3k/asset | Medium (n=900+, thin net) |
| BTC/ETH/SOL 1d | `c1d-ladder-relative-value` | 0.5-1.5% of stake/leg | $1-3k/strike | Medium (structural + snapshot) |
| Non-popular sports | `sn-consensus-anchor` | 2-4% of stake | $100-500/match | Low-medium (structural) |
| Popular / unpopular league | `spu-brand-fade` | 4-8% of stake | $100-400/match | Low (hypothesis) |
| Politics | `pol-favorite-carry` | 8-12% annualized on capital | $5-20k/market | High (published + structural) |

**Portfolio-level expectation:** a diversified book of the four `deploy`/`paper` crypto
strategies plus politics carry can plausibly target **8-15% annualized** on the
prediction sleeve, with the majority of the return coming from politics carry and
liquidity provision, not from directional crypto bets. Anyone promising more than that
from 5m candles is selling a backtest.

---

## 8. Implementation in FLARE

### 8.1 New and changed files

| File | Change |
| --- | --- |
| `src/predictionMarket.ts` | Category-aware Polymarket fee curve: `takerFeeRate`, `makerRebateShare`, `liquidityRole`; `polymarketFeePerShare`, `polymarketFeePctOfStake`, `costModelForCategory`. Legacy `spreadCents`/`feePct` behavior is preserved. |
| `src/predictionStrategies.ts` | Typed catalog of every strategy in §5: family, game, entry/exit rules, sizing, expected edge, capacity, risks, kill switches, status, evidence. |
| `src/predictionStrategies.test.ts` | Catalog integrity, coverage of all seven families, cost-model sanity, status/evidence validity. |
| `src/predictionMarket.test.ts` | Fee math: symmetry at 30¢/70¢, maker rebate, category rates, legacy compatibility. |
| `src/pages/Predictions.tsx` | New **Playbook** tab: strategy cards, cost calculator, family filters. |

### 8.2 Using the real cost model

```ts
import { costModelForCategory, simulatePredictionStrategy } from './predictionMarket'

// Crypto taker: 7% curve, 1¢ spread, no flat fee.
const cryptoCosts = costModelForCategory('crypto', 'taker', 1)

// Crypto maker: 0 fee, 20% rebate share, 1¢ spread.
const cryptoMaker = costModelForCategory('crypto', 'maker', 1)

// Politics taker: 4% curve, 1¢ spread.
const politicsCosts = costModelForCategory('politics', 'taker', 1)
```

`effectiveEntryPrice` now applies the price-dependent fee **in addition to** the legacy
flat `feePct`. With `takerFeeRate` unset, behavior is byte-identical to the old engine.
With it set, the all-in price is:

```
ask = mid + spreadCents / 200
fee_per_share = rate × ask × (1 − ask)        // taker
              = −rebate × rate × ask × (1 − ask)  // maker
all_in = ask × (1 + feePct / 100) + fee_per_share
```

### 8.3 Extending the Polymarket adapter

The current adapter is BTC-only and 5m/15m. The catalog assumes:

- `{asset}-updown-5m-{ts}` for BTC/ETH/SOL/XRP.
- `{asset}-updown-15m-{ts}` for BTC/ETH/SOL.
- `{asset}-updown-4h-{ts}` for BTC/ETH/SOL.
- `bitcoin-up-or-down-{month}-{day}-2026-{hour}{am|pm}-et` for hourly.
- `bitcoin-up-or-down-on-{month}-{day}-2026` for daily UP/DOWN.
- `bitcoin-above-on-{month}-{day}-2026` event with the `Will the price of Bitcoin be
  above $K on ...?` ladder for the daily barrier strategy.

The adapter change is mechanical: parameterize `asset` and `timeframe`, add the
human-readable slug builders, and return the same `PolymarketWindow` shape.

---

## 9. Data provenance

| Dataset | Source | Size | Used for |
| --- | --- | --- | --- |
| Binance klines | `api.binance.com/api/v3/klines` | BTC/ETH/SOL × 5m/15m/1h/1d; 120d/240d/730d/2,500d | Signal scan, base rates, drift check |
| Polymarket windows | Gamma `markets?slug=...`, CLOB `prices-history` | 287 × 5m, 96 × 15m; 24h | Nowcast, calibration, transfer test, quote age |
| Polymarket structure | Gamma `public-search`, `events`, CLOB `book` | live snapshot 2026-11-15 | Spreads, depth, partitions, ladders |
| Fee schedule | `docs.polymarket.com/trading/fees` | verified 2026-11-15 | Cost model |
| FLB study | arXiv 2609.12878 | 588M trades, 2.48M wallets | Category-level tail evidence |
| Microstructure | arXiv 2604.24366 | 30B events | Stale quotes, spread premium, maker landscape |
| MARL market making | arXiv 2610.26789 | Polymarket L2 | Negative result on spread capture |
| Kernel / market maker | arXiv 2510.15205 | — | Logit jump-diffusion, inventory-aware quoting |

---

## 10. References

1. Kyle, A. (1985). Continuous auctions and insider trading. *Econometrica*.
2. Glosten, L. & Milgrom, P. (1985). Bid, ask and transaction prices in a specialist
   market with heterogeneously informed traders. *JFE*.
3. Grossman, S. & Stiglitz, J. (1980). On the impossibility of informationally efficient
   markets. *AER*.
4. Lejmi, S. (2026). Cooperative Multi-Agent Reinforcement Learning for Market Making on
   Prediction-Market Order Books. arXiv:2610.26789.
5. Dubach, P. (2026). The Anatomy of a Decentralized Prediction Market: Microstructure
   Evidence from the Polymarket Order Book. arXiv:2604.24366.
6. (2026). The Favorite–Longshot Bias in Prediction Markets: Evidence from Polymarket.
   arXiv:2609.12878.
7. (2025). Toward Black–Scholes for Prediction Markets: A Unified Kernel and
   Market-Maker's Handbook. arXiv:2510.15205.
8. Polymarket Docs — Fees, Maker Rebates, Taker Rebates, Market Details (2026).
9. Kalshi Research — Calibration in Prediction Markets (2026).
10. Sadoune, I. (2025). Algorithmic Collusion and the Minimum Price Markov Game.
11. Bichler, M. (2025). Algorithmic Pricing and Algorithmic Collusion. *BISE*.
12. Zhang, G. et al. (2026). The Landscape of Agentic Reinforcement Learning for LLMs.

---

*Last updated: 2026-11-15. All market data is a snapshot; re-run the probes before
sizing any strategy.*
