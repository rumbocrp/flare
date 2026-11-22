/**
 * FLARE Top-10 Strategy Backtester & Cost-Sensitive ML Loss-Mitigation Pipeline
 *
 * Usage:
 *   npm run ml:meta-filter -- --source benchmark
 *   npm run ml:meta-filter -- --source binance --candles 1000 --top 10 --loss-penalty 4.0
 *   npm run ml:meta-filter -- --source sqlite --db src/server/flare.db --top 10
 *
 * Workflow:
 *   1. Backtests the full FLARE strategy universe (8 Polymarket BTC Up/Down engine strategies,
 *      5 Crypto Spot bot presets, 20 BTC prediction rules, and 16 directional next-candle rules).
 *   2. Ranks every strategy with sufficient sample depth by composite backtest quality
 *      (Wilson 95% LB, Win Rate, Profit Factor, and Expectancy) and selects the Top N (default 10).
 *   3. Extracts strictly backward-looking pre-trade features at decision time `t` (zero lookahead).
 *   4. Performs Purged Chronological Walk-Forward training (Train -> Purge -> Val -> Purge -> Test)
 *      using the 3-model cost-sensitive ensemble (L2 Logistic Regression + Depth-2 Newton GBDT +
 *      Fisher Loss-Centroid Scorer + Interpretable Toxic-Regime Veto Rules + PAV Calibration).
 *   5. Reports Before vs. After Out-of-Sample metrics and saves serialized model artifacts to JSON.
 */
import fs from 'node:fs'
import moduleApi from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Register a synchronous ESM resolve hook so Node's --experimental-strip-types
// resolves extensionless relative `.ts` imports used across FLARE's `src/` tree.
const registerHooksFn = (
  moduleApi as unknown as {
    registerHooks?: (hooks: {
      resolve: (
        specifier: string,
        context: { parentURL?: string },
        nextResolve: (spec: string, ctx: { parentURL?: string }) => { url: string },
      ) => { url: string }
    }) => void
  }
).registerHooks

if (typeof registerHooksFn === 'function') {
  registerHooksFn({
    resolve(specifier, context, nextResolve) {
      if (
        (specifier.startsWith('./') || specifier.startsWith('../')) &&
        !path.extname(specifier) &&
        context.parentURL
      ) {
        const parentDir = path.dirname(fileURLToPath(context.parentURL))
        const tsCandidate = path.resolve(parentDir, `${specifier}.ts`)
        if (fs.existsSync(tsCandidate)) {
          return nextResolve(pathToFileURL(tsCandidate).href, context)
        }
        const indexTsCandidate = path.resolve(parentDir, specifier, 'index.ts')
        if (fs.existsSync(indexTsCandidate)) {
          return nextResolve(pathToFileURL(indexTsCandidate).href, context)
        }
      }
      return nextResolve(specifier, context)
    },
  })
}

import type { StrategyPreset } from '../src/botEngine'
import type {
  MetaBacktestComparison,
  MetaFilterModel,
  MetaSample,
} from '../src/prediction/mlMetaFilter'
import type {
  EngineBookSideSnapshot,
  EngineOrderBookSnapshot,
  NestedParentContext,
  PredictionEngineStrategyId,
  StrategyContext,
} from '../src/prediction/engine/types'
import type {
  CollectedWindowReplayInput,
  ReplaySnapshotPoint,
} from '../src/prediction/replayHarness'
import type { PredictionRule } from '../src/predictions'
import type { Candle, Interval } from '../src/types'

type DataSourceMode = 'binance' | 'sqlite' | 'benchmark'
type StrategyTrack = 'tradable' | 'all'

type CliOptions = {
  source: DataSourceMode
  track: StrategyTrack
  topN: number
  lossPenalty: number
  minRecall: number
  targetWinRate: number
  candleLimit: number
  windowCount: number
  dbPath: string
  outPath: string
}

type RankedStrategyCandidate = {
  id: string
  name: string
  family: 'polymarket-engine' | 'crypto-spot' | 'prediction-rule' | 'directional-rule'
  timeframe: string
  horizonBars: number
  featureNames: readonly string[]
  samples: MetaSample[]
  baselineWinRatePct: number
  baselineWilsonLbPct: number
  baselineProfitFactor: number | null
  baselineNetPnlUsd: number
  compositeScore: number
}

function parseCliArgs(argv: readonly string[]): CliOptions {
  const map = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      map.set(key, next)
      i++
    } else {
      map.set(key, 'true')
    }
  }

  const rawSource = map.get('source') ?? 'binance'
  const source: DataSourceMode =
    rawSource === 'binance' || rawSource === 'sqlite' || rawSource === 'benchmark'
      ? rawSource
      : 'binance'

  const rawTrack = map.get('track') ?? 'tradable'
  const track: StrategyTrack = rawTrack === 'all' ? 'all' : 'tradable'

  return {
    source,
    track,
    topN: Math.max(1, Math.min(25, Number(map.get('top') ?? 10) || 10)),
    lossPenalty: Math.max(1, Math.min(12, Number(map.get('loss-penalty') ?? 4.0) || 4.0)),
    minRecall: Math.max(0.1, Math.min(0.85, Number(map.get('min-recall') ?? 0.35) || 0.35)),
    targetWinRate: Math.max(0.6, Math.min(0.99, Number(map.get('target-win-rate') ?? 0.92) || 0.92)),
    candleLimit: Math.max(300, Math.min(4000, Number(map.get('candles') ?? 2000) || 2000)),
    windowCount: Math.max(200, Math.min(3000, Number(map.get('windows') ?? 800) || 800)),
    dbPath: map.get('db') ?? 'src/server/flare.db',
    outPath: map.get('out') ?? 'artifacts/ml-meta-filter-models.json',
  }
}

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussianNoise(rng: () => number): number {
  const u1 = Math.max(1e-9, rng())
  const u2 = rng()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/**
 * Fetches paginated real historical OHLCV candles from Binance Public REST API (no keys required).
 */
async function fetchBinanceHistoricalCandles(
  pair: string,
  interval: Interval,
  totalLimit: number,
  stepMs: number,
): Promise<Candle[]> {
  const symbol = encodeURIComponent(pair.replace('/', ''))
  const collected: Candle[] = []
  let endTime: number | undefined

  while (collected.length < totalLimit) {
    const batch = Math.min(1000, totalLimit - collected.length)
    const qs = new URLSearchParams({
      symbol,
      interval,
      limit: String(batch),
    })
    if (endTime !== undefined) qs.set('endTime', String(endTime))

    const url = `https://api.binance.com/api/v3/klines?${qs.toString()}`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Binance API HTTP ${response.status} for ${pair} ${interval}`)
    }
    const rows = (await response.json()) as unknown[]
    if (!Array.isArray(rows) || rows.length === 0) break

    const parsed: Candle[] = rows
      .filter((r): r is unknown[] => Array.isArray(r) && r.length >= 6)
      .map((r) => ({
        time: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
      }))

    if (parsed.length === 0) break
    collected.unshift(...parsed)
    endTime = parsed[0].time - stepMs
    if (parsed.length < batch) break
  }

  return collected
    .sort((a, b) => a.time - b.time)
    .slice(-totalLimit)
}

/**
 * Explicit opt-in benchmark generator (`--source benchmark` only).
 * Simulates realistic multi-regime crypto market dynamics (trending, mean-reverting,
 * and high-volatility whipsaw/stop-hunt regimes) so the ML meta-filter has genuine
 * learnable loss regimes to detect and mitigate out-of-sample.
 */
function generateMultiRegimeCandles(
  pair: string,
  interval: Interval,
  limit: number,
  stepMs: number,
): Candle[] {
  const seed = `${pair}|${interval}|multi-regime`
    .split('')
    .reduce((acc, ch) => Math.imul(acc, 31) + ch.charCodeAt(0), 17)
  const rng = mulberry32(seed >>> 0)

  const basePrices: Record<string, number> = {
    'BTC/USDT': 92_000,
    'ETH/USDT': 3_200,
    'SOL/USDT': 185,
  }
  const baseVols: Record<Interval, number> = {
    '5m': 0.0014,
    '15m': 0.0028,
    '1h': 0.0055,
    '4h': 0.011,
    '1d': 0.024,
  }

  let price = basePrices[pair] ?? 1_000
  const baseVol = baseVols[interval]
  const endTime = Date.UTC(2026, 10, 1)
  const candles: Candle[] = []

  // Regime state: 0 = steady trend up, 1 = steady trend down, 2 = calm range, 3 = toxic whipsaw spike
  let regime = 0
  let regimeBarsLeft = 45
  let prevRet = 0

  for (let i = 0; i < limit; i++) {
    if (regimeBarsLeft <= 0) {
      const r = rng()
      regime = r < 0.34 ? 0 : r < 0.62 ? 1 : r < 0.82 ? 2 : 3
      regimeBarsLeft = regime === 3 ? 12 + Math.floor(rng() * 14) : 35 + Math.floor(rng() * 45)
    }
    regimeBarsLeft--

    const drift =
      regime === 0 ? 0.24 * baseVol : regime === 1 ? -0.22 * baseVol : 0
    const volMult = regime === 3 ? 2.85 : regime === 2 ? 0.65 : 1.0
    const autocorr =
      regime === 0 || regime === 1 ? 0.28 : regime === 3 ? -0.45 : -0.15

    const ret = drift + autocorr * prevRet + gaussianNoise(rng) * baseVol * volMult
    prevRet = ret

    const open = price
    const close = Math.max(1, open * (1 + ret))
    const wickScale = baseVol * volMult * (regime === 3 ? 1.6 : 0.65)
    const high = Math.max(open, close) * (1 + Math.abs(gaussianNoise(rng)) * wickScale)
    const low = Math.max(
      0.5,
      Math.min(open, close) * (1 - Math.abs(gaussianNoise(rng)) * wickScale),
    )
    const volume =
      (regime === 3 ? 2.4 : 1.0) * (350 + rng() * 650 + Math.abs(ret / baseVol) * 280)

    candles.push({
      time: endTime - (limit - i) * stepMs,
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume: Math.round(volume),
    })
    price = close
  }

  return candles
}

function makeBookSide(
  tokenId: string,
  bestBid: number,
  bestAsk: number,
  asOfMs: number,
  depthUsd: number,
): EngineBookSideSnapshot {
  const b = Math.max(0.01, Math.min(0.98, Math.round(bestBid * 10_000) / 10_000))
  const a = Math.max(
    b + 0.01,
    Math.min(0.99, Math.round(bestAsk * 10_000) / 10_000),
  )
  return {
    tokenId,
    bestBid: b,
    bestAsk: a,
    mid: Math.round(((b + a) / 2) * 10_000) / 10_000,
    spread: Math.round((a - b) * 10_000) / 10_000,
    bidDepthUsd: depthUsd,
    askDepthUsd: depthUsd,
    top5DepthUsd: depthUsd * 2,
    asOfMs,
    source: 'clob-ws',
  }
}

function buildEngineBook(
  slug: string,
  snap: ReplaySnapshotPoint,
): EngineOrderBookSnapshot {
  const yes = makeBookSide(
    `${slug}-yes`,
    snap.yesBid ?? 0.49,
    snap.yesAsk ?? 0.51,
    snap.capturedAtMs,
    snap.yesDepthUsd ?? 500,
  )
  const no = makeBookSide(
    `${slug}-no`,
    snap.noBid ?? 0.49,
    snap.noAsk ?? 0.51,
    snap.capturedAtMs,
    snap.noDepthUsd ?? 500,
  )
  return {
    slug,
    upTokenId: `${slug}-yes`,
    downTokenId: `${slug}-no`,
    yes,
    no,
    minTop5DepthUsd: Math.min(yes.top5DepthUsd, no.top5DepthUsd),
    capturedAtMs: snap.capturedAtMs,
  }
}

/**
 * Generates multi-regime Polymarket BTC Up/Down windows strictly for `--source benchmark`.
 * Includes realistic toxic loss clusters (basis divergence, vol shocks, wide spread / thin
 * depth adverse selection, and pre-entry reversal drift) that slip past basic G1/G2 thresholds.
 */
function generateBenchmarkPolymarketWindows(
  strategyId: PredictionEngineStrategyId,
  count: number,
  computeNowcastFn: (params: {
    openTwap: number
    currentTwap: number
    secondsRemaining: number
    sigma1m: number
  }) => { z: number; pRawYes: number; pBlendedYes: number; remainingMinutes: number; valid: boolean },
): {
  windows: CollectedWindowReplayInput[]
  parentByChildSlug: Map<string, NestedParentContext>
  preEntrySpotBySlug: Map<string, number>
} {
  const seed = `${strategyId}|poly-regime-v2`
    .split('')
    .reduce((acc, ch) => Math.imul(acc, 31) + ch.charCodeAt(0), 19)
  const rng = mulberry32(seed >>> 0)

  const windows: CollectedWindowReplayInput[] = []
  const parentByChildSlug = new Map<string, NestedParentContext>()
  const preEntrySpotBySlug = new Map<string, number>()

  const tf: '5m' | '15m' | '1h' =
    strategyId === 'c15-favorite-carry' || strategyId === 'c15-late-favorite-guarded'
      ? '15m'
      : strategyId === 'c1h-late-nowcast' || strategyId === 'c1h-exhaustion-limit'
        ? '1h'
        : '5m'

  const durationMs = tf === '5m' ? 300_000 : tf === '15m' ? 900_000 : 3_600_000
  const baseStart = 1_760_000_000_000

  for (let i = 0; i < count; i++) {
    const startTimeMs = baseStart + i * durationMs
    const endTimeMs = startTimeMs + durationMs
    const slug = `btc-updown-${tf}-${i}`
    const openTwap = 95_000

    // Inject ~26% toxic microstructure regimes that remain inside hard G1/G2 limits
    // (e.g., sigma 1.7x-2.4x median, basis 13-24 bps, spread 3-5c, adverse pre-entry drift)
    const regimeRoll = rng()
    const isVolShock = regimeRoll < 0.11
    const isAdverseBasis = regimeRoll >= 0.11 && regimeRoll < 0.20
    const isThinWideSpread = regimeRoll >= 0.20 && regimeRoll < 0.28
    const isToxic = isVolShock || isAdverseBasis || isThinWideSpread

    const baseSigma = 0.0011
    const sigma1m = isVolShock
      ? baseSigma * (1.85 + rng() * 0.55)
      : baseSigma * (0.85 + rng() * 0.35)
    const basisBps = isAdverseBasis
      ? (14 + rng() * 10) * (rng() < 0.5 ? 1 : -1)
      : (rng() * 7 - 3.5)
    const spread = isThinWideSpread ? 0.035 + rng() * 0.015 : 0.01 + rng() * 0.01
    const depthUsd = isThinWideSpread ? 115 + rng() * 65 : 520 + rng() * 480

    let secondsRemaining = 90
    let currentTwap = 95_210
    let favIsYes = i % 2 === 0
    let yesBid = 0.88
    let yesAsk = 0.90
    let noBid = 0.09
    let noAsk = 0.11
    let cleanWinProb = 0.93
    let toxicWinProb = 0.28

    if (strategyId === 'c5-late-favorite') {
      secondsRemaining = 65 + Math.floor(rng() * 35)
      favIsYes = i % 3 !== 0
      const dist = isVolShock ? 310 : 230
      currentTwap = favIsYes ? openTwap + dist : openTwap - dist
      const ask = 0.91 + rng() * 0.02
      yesAsk = favIsYes ? ask : 1 - ask + spread
      yesBid = Math.max(0.01, yesAsk - spread)
      noAsk = favIsYes ? 1 - ask + spread : ask
      noBid = Math.max(0.01, noAsk - spread)
      cleanWinProb = 0.975
      toxicWinProb = 0.48
    } else if (strategyId === 'c5-nowcast-maker') {
      secondsRemaining = 130 + Math.floor(rng() * 80)
      favIsYes = i % 2 === 0
      currentTwap = favIsYes ? openTwap + 145 : openTwap - 145
      const ask = 0.65 + rng() * 0.04
      yesAsk = favIsYes ? ask : 1 - ask + spread
      yesBid = Math.max(0.01, yesAsk - spread)
      noAsk = favIsYes ? 1 - ask + spread : ask
      noBid = Math.max(0.01, noAsk - spread)
      cleanWinProb = 0.84
      toxicWinProb = 0.25
    } else if (strategyId === 'c15-favorite-carry') {
      secondsRemaining = 360 + Math.floor(rng() * 200)
      favIsYes = i % 2 === 0
      currentTwap = favIsYes ? openTwap + 275 : openTwap - 275
      const ask = 0.74 + rng() * 0.06
      yesAsk = favIsYes ? ask : 1 - ask + spread
      yesBid = Math.max(0.01, yesAsk - spread)
      noAsk = favIsYes ? 1 - ask + spread : ask
      noBid = Math.max(0.01, noAsk - spread)
      cleanWinProb = 0.89
      toxicWinProb = 0.30
    } else if (strategyId === 'c15-late-favorite-guarded') {
      secondsRemaining = 70 + Math.floor(rng() * 70)
      favIsYes = i % 3 !== 1
      const dist = isVolShock ? 380 : 290
      currentTwap = favIsYes ? openTwap + dist : openTwap - dist
      const ask = 0.89 + rng() * 0.03
      yesAsk = favIsYes ? ask : 1 - ask + spread
      yesBid = Math.max(0.01, yesAsk - spread)
      noAsk = favIsYes ? 1 - ask + spread : ask
      noBid = Math.max(0.01, noAsk - spread)
      cleanWinProb = 0.975
      toxicWinProb = 0.44
    } else if (strategyId === 'c1h-late-nowcast') {
      secondsRemaining = 120 + Math.floor(rng() * 300)
      favIsYes = i % 2 === 0
      // Ensure |z| >= 2.1 even under elevated sigma
      const dist = Math.max(460, openTwap * sigma1m * Math.sqrt(secondsRemaining / 60) * 2.45)
      currentTwap = favIsYes ? openTwap + dist : openTwap - dist
      const ask = 0.89 + rng() * 0.03
      yesAsk = favIsYes ? ask : 1 - ask + spread
      yesBid = Math.max(0.01, yesAsk - spread)
      noAsk = favIsYes ? 1 - ask + spread : ask
      noBid = Math.max(0.01, noAsk - spread)
      cleanWinProb = 0.965
      toxicWinProb = 0.42
    } else if (strategyId === 'c1h-exhaustion-limit') {
      secondsRemaining = 3150 + Math.floor(rng() * 300)
      favIsYes = true
      currentTwap = openTwap + 25
      yesAsk = 0.50 + rng() * 0.03
      yesBid = Math.max(0.01, yesAsk - spread)
      noAsk = 0.51
      noBid = Math.max(0.01, noAsk - spread)
      cleanWinProb = 0.72
      toxicWinProb = 0.24
    } else if (strategyId === 'cx-nested-coherence') {
      secondsRemaining = 100 + Math.floor(rng() * 60)
      favIsYes = true
      currentTwap = openTwap + 215
      yesAsk = 0.74 + rng() * 0.03
      yesBid = Math.max(0.01, yesAsk - spread)
      noAsk = 0.27
      noBid = Math.max(0.01, noAsk - spread)
      cleanWinProb = 0.91
      toxicWinProb = 0.30
    } else if (strategyId === 'c5-15-longshot-fade') {
      secondsRemaining = 120 + Math.floor(rng() * 90)
      favIsYes = i % 2 === 0
      currentTwap = favIsYes ? openTwap + 205 : openTwap - 205
      const favAsk = 0.74 + rng() * 0.04
      const oppBid = 0.23 + rng() * 0.04
      yesAsk = favIsYes ? favAsk : oppBid + spread
      yesBid = favIsYes ? favAsk - spread : oppBid
      noAsk = favIsYes ? oppBid + spread : favAsk
      noBid = favIsYes ? oppBid : favAsk - spread
      cleanWinProb = 0.89
      toxicWinProb = 0.31
    }

    const nc = computeNowcastFn({
      openTwap,
      currentTwap,
      secondsRemaining,
      sigma1m,
    })

    const capturedAtMs = endTimeMs - secondsRemaining * 1000
    // Backward-looking pre-entry drift: toxic regimes show adverse reversal drift right before entry
    const preEntryDriftSign = favIsYes ? 1 : -1
    const preEntrySpot = isToxic
      ? currentTwap + preEntryDriftSign * (55 + rng() * 45) // price already pulling back against side
      : currentTwap - preEntryDriftSign * (20 + rng() * 30) // steady favorable drift into entry
    preEntrySpotBySlug.set(slug, preEntrySpot)

    const snap: ReplaySnapshotPoint = {
      slug,
      capturedAtMs,
      secondsRemaining,
      twapPrice: currentTwap,
      binancePrice: currentTwap * (1 + basisBps / 10_000),
      sigma1m,
      basisBps,
      yesBid,
      yesAsk,
      yesDepthUsd: depthUsd,
      noBid,
      noAsk,
      noDepthUsd: depthUsd,
      pModelYes: strategyId === 'c1h-exhaustion-limit' ? 0.58 : nc.pRawYes,
    }

    if (strategyId === 'cx-nested-coherence') {
      const parentSlug = `btc-updown-15m-parent-${i}`
      const parentSnap: ReplaySnapshotPoint = {
        ...snap,
        slug: parentSlug,
        yesBid: 0.88,
        yesAsk: 0.90,
        noBid: 0.09,
        noAsk: 0.11,
      }
      parentByChildSlug.set(slug, {
        slug: parentSlug,
        timeframe: '15m',
        resolutionSource: 'chainlink-twap-60s',
        openTwap,
        secondsRemaining: 360,
        secondsElapsed: 540,
        marketMidYes: 0.89,
        book: buildEngineBook(parentSlug, parentSnap),
      })
    }

    const favWins = rng() < (isToxic ? toxicWinProb : cleanWinProb)
    const resolvedUp = favIsYes ? favWins : !favWins

    windows.push({
      slug,
      timeframe: tf,
      resolutionSource: tf === '1h' ? 'binance-1h-candle' : 'chainlink-twap-60s',
      startTimeMs,
      endTimeMs,
      openTwap,
      closeTwap: resolvedUp ? openTwap + 260 : openTwap - 260,
      resolvedUp,
      snapshots: [snap],
    })
  }

  return { windows, parentByChildSlug, preEntrySpotBySlug }
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2))

  const [
    { createInitialBotState, stepBotEngine, STRATEGY_PRESETS },
    { buildDirectionalRules },
    { intervalMs },
    { computeMetrics },
    { POLYMARKET_FEES, polymarketFeePerShare },
    { computeNowcast },
    { getStrategyDefinition, STRATEGY_REGISTRY },
    {
      buildCandleFeatureCache,
      CANDLE_FEATURE_NAMES,
      extractCandleFeatures,
      extractPolymarketWindowFeatures,
      POLYMARKET_FEATURE_NAMES,
      summarizeSamples,
      trainAndEvaluateMetaFilter,
    },
    { BITCOIN_20_PREDICTIONS, buildMarketContext, computeWilsonLowerBoundPct },
  ] = await Promise.all([
    import('../src/botEngine.ts'),
    import('../src/directionalRules.ts'),
    import('../src/market/intervals.ts'),
    import('../src/metrics.ts'),
    import('../src/predictionMarket.ts'),
    import('../src/prediction/nowcast.ts'),
    import('../src/prediction/engine/strategies.ts'),
    import('../src/prediction/mlMetaFilter.ts'),
    import('../src/predictions.ts'),
  ])

  console.log('\n================================================================================')
  console.log(' FLARE — Top-10 Strategy Backtester & Cost-Sensitive ML Loss-Mitigation Pipeline')
  console.log('================================================================================')
  console.log(
    `Source: ${opts.source} | Track: ${opts.track} | Top-N: ${opts.topN} | Loss Penalty: ${opts.lossPenalty}x | ` +
      `Min Recall: ${(opts.minRecall * 100).toFixed(0)}% | Target WR: ${(opts.targetWinRate * 100).toFixed(0)}%`,
  )

  const candidates: RankedStrategyCandidate[] = []

  // -------------------------------------------------------------------------
  // Track A: Polymarket BTC Up/Down Prediction Engine Strategies (8 strategies)
  // -------------------------------------------------------------------------
  let sqliteWindowsByTf: Record<'5m' | '15m' | '1h', CollectedWindowReplayInput[]> | null =
    null

  if (opts.source === 'sqlite' || (opts.source === 'binance' && fs.existsSync(opts.dbPath))) {
    try {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(opts.dbPath, { open: true, readOnly: true })
      const winRows = db
        .prepare(
          `SELECT slug, timeframe, resolution_source, start_time_ms, end_time_ms,
                  open_twap, close_twap, resolved_up
           FROM prediction_windows
           WHERE resolved_up IS NOT NULL
           ORDER BY start_time_ms ASC`,
        )
        .all() as {
        slug: string
        timeframe: '5m' | '15m' | '1h'
        resolution_source: 'chainlink-twap-60s' | 'binance-1h-candle' | 'unknown'
        start_time_ms: number
        end_time_ms: number
        open_twap: number | null
        close_twap: number | null
        resolved_up: number | null
      }[]

      if (winRows.length > 0) {
        sqliteWindowsByTf = { '5m': [], '15m': [], '1h': [] }
        const snapStmt = db.prepare(
          `SELECT slug, captured_at_ms, seconds_remaining, twap_price, binance_price,
                  sigma_1m, basis_bps, yes_bid, yes_ask, yes_depth_usd, no_bid, no_ask, no_depth_usd
           FROM prediction_window_snapshots
           WHERE slug = ?
           ORDER BY captured_at_ms ASC`,
        )
        for (const w of winRows) {
          const snaps = snapStmt.all(w.slug) as {
            slug: string
            captured_at_ms: number
            seconds_remaining: number
            twap_price: number | null
            binance_price: number | null
            sigma_1m: number | null
            basis_bps: number | null
            yes_bid: number | null
            yes_ask: number | null
            yes_depth_usd: number | null
            no_bid: number | null
            no_ask: number | null
            no_depth_usd: number | null
          }[]
          sqliteWindowsByTf[w.timeframe].push({
            slug: w.slug,
            timeframe: w.timeframe,
            resolutionSource: w.resolution_source,
            startTimeMs: w.start_time_ms,
            endTimeMs: w.end_time_ms,
            openTwap: w.open_twap,
            closeTwap: w.close_twap,
            resolvedUp: w.resolved_up === 1,
            snapshots: snaps.map((s) => ({
              slug: s.slug,
              capturedAtMs: s.captured_at_ms,
              secondsRemaining: s.seconds_remaining,
              twapPrice: s.twap_price,
              binancePrice: s.binance_price,
              sigma1m: s.sigma_1m,
              basisBps: s.basis_bps,
              yesBid: s.yes_bid,
              yesAsk: s.yes_ask,
              yesDepthUsd: s.yes_depth_usd,
              noBid: s.no_bid,
              noAsk: s.no_ask,
              noDepthUsd: s.no_depth_usd,
            })),
          })
        }
        console.log(
          `Loaded SQLite settled Polymarket windows: 5m=${sqliteWindowsByTf['5m'].length}, 15m=${sqliteWindowsByTf['15m'].length}, 1h=${sqliteWindowsByTf['1h'].length}`,
        )
      }
      db.close()
    } catch (err) {
      if (opts.source === 'sqlite') {
        throw new Error(
          `Failed reading SQLite database at ${opts.dbPath}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        )
      }
    }
  }

  for (const def of STRATEGY_REGISTRY) {
    let windows: CollectedWindowReplayInput[] = []
    let parentByChildSlug = new Map<string, NestedParentContext>()
    let preEntrySpotBySlug = new Map<string, number>()

    if (opts.source === 'benchmark') {
      const gen = generateBenchmarkPolymarketWindows(
        def.id,
        opts.windowCount,
        computeNowcast,
      )
      windows = gen.windows
      parentByChildSlug = gen.parentByChildSlug
      preEntrySpotBySlug = gen.preEntrySpotBySlug
    } else if (sqliteWindowsByTf) {
      for (const tf of def.timeframes) {
        windows.push(...sqliteWindowsByTf[tf])
      }
      windows.sort((a, b) => a.startTimeMs - b.startTimeMs)
    }

    if (windows.length < 40) continue

    const samples: MetaSample[] = []
    let lossStreak = 0

    for (const win of windows) {
      if (win.resolvedUp === null || win.openTwap === null || win.snapshots.length === 0) {
        continue
      }
      for (let sIdx = 0; sIdx < win.snapshots.length; sIdx++) {
        const snap = win.snapshots[sIdx]
        const activeSpot =
          win.resolutionSource === 'binance-1h-candle'
            ? (snap.binancePrice ?? snap.twapPrice ?? 0)
            : (snap.twapPrice ?? 0)
        if (activeSpot <= 0 || !snap.sigma1m || snap.sigma1m <= 0) continue

        const nc = computeNowcast({
          openTwap: win.openTwap,
          currentTwap: activeSpot,
          secondsRemaining: snap.secondsRemaining,
          sigma1m: snap.sigma1m,
        })

        const ctx: StrategyContext = {
          slug: win.slug,
          timeframe: win.timeframe,
          resolutionSource: win.resolutionSource,
          startTimeMs: win.startTimeMs,
          endTimeMs: win.endTimeMs,
          openTwap: win.openTwap,
          secondsRemaining: snap.secondsRemaining,
          secondsElapsed: Math.max(0, (snap.capturedAtMs - win.startTimeMs) / 1000),
          oracle: {
            nowMs: snap.capturedAtMs,
            chainlinkPrice: snap.twapPrice,
            chainlinkTwap60s: snap.twapPrice,
            chainlinkUpdatedAtMs: snap.capturedAtMs,
            chainlinkStaleMs: 0,
            binancePrice: snap.binancePrice ?? snap.twapPrice,
            binanceUpdatedAtMs: snap.capturedAtMs,
            binanceStaleMs: 0,
            basisBps: snap.basisBps ?? 0,
            sigma1m: snap.sigma1m,
            median24hSigma1m: 0.0011,
            connectedRtds: true,
            connectedBinance: true,
          },
          book: buildEngineBook(win.slug, snap),
          nowcast: nc,
          hourlyIndicators:
            def.id === 'c1h-exhaustion-limit'
              ? { consecutiveRedHours: 3, rsi14: 32 }
              : undefined,
          nestedParent: parentByChildSlug.get(win.slug),
          macroBlackoutWindows: [],
          nowMs: snap.capturedAtMs,
          stakeUsd: 5,
        }

        const intents = getStrategyDefinition(def.id)
          .evaluate(ctx)
          .filter((intent) => intent.slug === win.slug)
        if (intents.length === 0) continue

        const best = intents.reduce((a, b) =>
          b.expectedEdgePerShare > a.expectedEdgePerShare ? b : a,
        )
        const stakeUsd = best.stakeUsd ?? 5
        const entryPrice = best.limitPrice
        const feePerShare = polymarketFeePerShare(entryPrice, {
          spreadCents: 0,
          feePct: 0,
          takerFeeRate: POLYMARKET_FEES.crypto.takerFeeRate,
          makerRebateShare: POLYMARKET_FEES.crypto.makerRebateShare,
          liquidityRole: best.liquidityRole,
        })
        const shares = stakeUsd / entryPrice
        const feeUsd = shares * feePerShare
        const won =
          (best.outcome === 'YES' && win.resolvedUp) ||
          (best.outcome === 'NO' && !win.resolvedUp)
        const netPnlUsd = won ? shares - stakeUsd - feeUsd : -stakeUsd - feeUsd

        const prevSnapSpot =
          sIdx > 0
            ? (win.snapshots[sIdx - 1].twapPrice ?? win.snapshots[sIdx - 1].binancePrice)
            : preEntrySpotBySlug.get(win.slug) ?? null

        const featureVector = extractPolymarketWindowFeatures({
          snapshot: snap,
          window: win,
          nowcast: nc,
          outcome: best.outcome,
          entryPrice,
          feePerShare,
          median24hSigma1m: 0.0011,
          preEntrySpotPrice: prevSnapSpot,
          recentLossStreak: lossStreak,
        })

        samples.push({
          timestampMs: snap.capturedAtMs,
          featureVector,
          outcome: won ? 1 : 0,
          netPnlUsd,
          stakeUsd,
          entryPrice,
          breakEvenPct: (entryPrice + feePerShare) * 100,
        })

        lossStreak = won ? 0 : lossStreak + 1
        break // One trade per window
      }
    }

    if (samples.length >= 40) {
      const summary = summarizeSamples(samples, samples.length)
      const pfScore = Math.min(4, summary.profitFactor ?? 0) * 10
      const compositeScore =
        summary.wilson95LbPct * 0.7 +
        summary.winRatePct * 0.25 +
        pfScore +
        Math.min(12, Math.log10(samples.length) * 4)

      candidates.push({
        id: def.id,
        name: def.name,
        family: 'polymarket-engine',
        timeframe: def.timeframes.join('/'),
        horizonBars: 1,
        featureNames: POLYMARKET_FEATURE_NAMES,
        samples,
        baselineWinRatePct: summary.winRatePct,
        baselineWilsonLbPct: summary.wilson95LbPct,
        baselineProfitFactor: summary.profitFactor,
        baselineNetPnlUsd: summary.netPnlUsd,
        compositeScore,
      })
    }
  }

  // -------------------------------------------------------------------------
  // Track B: Candle Strategies (Crypto Spot Presets + 20 Rules + 16 Directional)
  // -------------------------------------------------------------------------
  if (opts.source !== 'sqlite') {
    const candleCacheMap = new Map<string, Candle[]>()
    const getCandlesFor = async (pair: string, interval: Interval): Promise<Candle[]> => {
      const key = `${pair}|${interval}`
      const existing = candleCacheMap.get(key)
      if (existing) return existing

      const stepMs = intervalMs[interval]
      const data =
        opts.source === 'binance'
          ? await fetchBinanceHistoricalCandles(pair, interval, opts.candleLimit, stepMs)
          : generateMultiRegimeCandles(pair, interval, opts.candleLimit, stepMs)

      candleCacheMap.set(key, data)
      return data
    }

    // B1. Crypto Spot Presets via actual stepBotEngine (momentum-structure + EMA50 + breakevenAtOneR)
    const spotPresets: StrategyPreset[] = STRATEGY_PRESETS.filter(
      (p) => p.domain === 'crypto-spot',
    )
    for (const preset of spotPresets) {
      const candles = await getCandlesFor(preset.strategy.pair, preset.timeframe)
      const ctx = buildMarketContext(candles)
      const featCache = buildCandleFeatureCache(ctx)
      const timeToIdx = new Map(candles.map((c, idx) => [c.time, idx]))

      let botState = createInitialBotState(preset)
      for (let end = 56; end <= candles.length; end++) {
        botState = stepBotEngine(botState, candles.slice(0, end), preset)
      }

      const closedTrades = [...botState.closedTrades].sort(
        (a, b) => a.entryTime - b.entryTime,
      )
      const samples: MetaSample[] = []
      for (const trade of closedTrades) {
        const entryIdx = timeToIdx.get(trade.entryTime)
        if (entryIdx === undefined || entryIdx < 55) continue
        const dir: 1 | -1 = trade.side === 'buy' ? 1 : -1
        const featureVector = extractCandleFeatures(ctx, featCache, entryIdx, dir)
        samples.push({
          timestampMs: candles[entryIdx].time,
          featureVector,
          outcome: trade.pnl > 0 ? 1 : 0,
          netPnlUsd: trade.pnl,
          stakeUsd: trade.size,
        })
      }

      if (samples.length >= 30) {
        const m = computeMetrics(closedTrades, botState.initialBalance)
        const wins = samples.filter((s) => s.outcome === 1).length
        const wr = (wins / samples.length) * 100
        const wilson = computeWilsonLowerBoundPct(wins, samples.length)
        const pf = m.profitFactor !== null ? Math.round(m.profitFactor * 100) / 100 : null
        const netPnl = Math.round((botState.balance - botState.initialBalance) * 100) / 100
        const compositeScore =
          wilson * 0.7 +
          wr * 0.25 +
          Math.min(4, pf ?? 0) * 10 +
          Math.min(10, Math.log10(samples.length) * 3.5)

        candidates.push({
          id: preset.id,
          name: preset.name,
          family: 'crypto-spot',
          timeframe: `${preset.strategy.pair} ${preset.timeframe}`,
          horizonBars: 4,
          featureNames: CANDLE_FEATURE_NAMES,
          samples,
          baselineWinRatePct: Math.round(wr * 100) / 100,
          baselineWilsonLbPct: wilson,
          baselineProfitFactor: pf,
          baselineNetPnlUsd: netPnl,
          compositeScore,
        })
      }
    }

    // B2. Polymarket-compatible Next-Candle Directional Rules (+ 20 research rules when --track all)
    const allCandleRules: {
      rule: PredictionRule
      family: 'prediction-rule' | 'directional-rule'
    }[] = [
      ...buildDirectionalRules('5m').map((rule) => ({
        rule,
        family: 'directional-rule' as const,
      })),
      ...buildDirectionalRules('15m').map((rule) => ({
        rule,
        family: 'directional-rule' as const,
      })),
      ...(opts.track === 'all'
        ? BITCOIN_20_PREDICTIONS.map((rule) => ({
            rule,
            family: 'prediction-rule' as const,
          }))
        : []),
    ]

    for (const { rule, family } of allCandleRules) {
      const candles = await getCandlesFor('BTC/USDT', rule.timeframe)
      const ctx = buildMarketContext(candles)
      const featCache = buildCandleFeatureCache(ctx)
      const maxIndex = candles.length - 1 - rule.horizonBars

      const samples: MetaSample[] = []
      const stakeUsd = 5
      // Realistic 52c entry price with Polymarket taker fee (~1.75c) on research binary rules
      const entryPrice = 0.52
      const feePerShare = polymarketFeePerShare(entryPrice, {
        spreadCents: 0,
        feePct: 0,
        takerFeeRate: POLYMARKET_FEES.crypto.takerFeeRate,
        makerRebateShare: POLYMARKET_FEES.crypto.makerRebateShare,
        liquidityRole: 'taker',
      })
      const shares = stakeUsd / entryPrice
      const feeUsd = shares * feePerShare

      for (let i = 55; i <= maxIndex; i++) {
        if (!rule.condition(ctx, i)) continue
        const won = rule.resolve(ctx, i)
        const dir: 1 | -1 = rule.predictedOutcome === 'YES' ? 1 : -1
        const featureVector = extractCandleFeatures(ctx, featCache, i, dir)
        const netPnlUsd = won ? shares - stakeUsd - feeUsd : -stakeUsd - feeUsd
        samples.push({
          timestampMs: candles[i].time,
          featureVector,
          outcome: won ? 1 : 0,
          netPnlUsd,
          stakeUsd,
          entryPrice,
        })
      }

      if (samples.length >= 45) {
        const summary = summarizeSamples(samples, samples.length)
        const pfScore = Math.min(4, summary.profitFactor ?? 0) * 10
        const compositeScore =
          summary.wilson95LbPct * 0.7 +
          summary.winRatePct * 0.25 +
          pfScore +
          Math.min(10, Math.log10(samples.length) * 3.5)

        candidates.push({
          id: rule.id,
          name: rule.title,
          family,
          timeframe: `BTC/USDT ${rule.timeframe}`,
          horizonBars: rule.horizonBars,
          featureNames: CANDLE_FEATURE_NAMES,
          samples,
          baselineWinRatePct: summary.winRatePct,
          baselineWilsonLbPct: summary.wilson95LbPct,
          baselineProfitFactor: summary.profitFactor,
          baselineNetPnlUsd: summary.netPnlUsd,
          compositeScore,
        })
      }
    }
  }

  if (candidates.length === 0) {
    console.error(
      '\nNo strategies had sufficient historical samples (>= 40). ' +
        'Run with `--source binance` (live Binance OHLCV) or `--source benchmark` (multi-regime stress test).',
    )
    process.exit(1)
  }

  // Sort strictly by composite backtest score and select the Top N strategies
  candidates.sort((a, b) => b.compositeScore - a.compositeScore)
  const topStrategies = candidates.slice(0, opts.topN)

  console.log(
    `\nEvaluated ${candidates.length} strategies with sufficient sample depth. Selected Top ${topStrategies.length}:\n`,
  )

  const results: {
    rank: number
    candidate: RankedStrategyCandidate
    comparison: MetaBacktestComparison
  }[] = []

  for (let idx = 0; idx < topStrategies.length; idx++) {
    const cand = topStrategies[idx]
    const comparison = trainAndEvaluateMetaFilter(cand.samples, {
      strategyId: cand.id,
      featureNames: cand.featureNames,
      trainRatio: 0.55,
      valRatio: 0.20,
      purgeGap: Math.max(1, cand.horizonBars),
      lossPenalty: opts.lossPenalty,
      minRecall: opts.minRecall,
      targetWinRate: opts.targetWinRate,
      maxVetoRules: 3,
    })
    results.push({ rank: idx + 1, candidate: cand, comparison })
  }

  // Print detailed console summary
  console.log(
    'Rank | Strategy ID                 | Family            | TF          | OOS Base WR -> ML WR (Lift)      | Losses (Elim %)    | PF Base -> ML | DD Red % | Base PnL -> ML PnL',
  )
  console.log('-'.repeat(162))

  let aggBaseTrades = 0
  let aggBaseWins = 0
  let aggBaseLosses = 0
  let aggBasePnl = 0
  let aggFiltTrades = 0
  let aggFiltWins = 0
  let aggFiltLosses = 0
  let aggFiltPnl = 0
  let aggSizedPnl = 0

  for (const { rank, candidate, comparison } of results) {
    const b = comparison.baseline
    const f = comparison.filtered
    const d = comparison.delta
    aggBaseTrades += b.trades
    aggBaseWins += b.wins
    aggBaseLosses += b.losses
    aggBasePnl += b.netPnlUsd
    aggFiltTrades += f.trades
    aggFiltWins += f.wins
    aggFiltLosses += f.losses
    aggFiltPnl += f.netPnlUsd
    aggSizedPnl += comparison.filteredSized.netPnlUsd

    const pfBaseStr = b.profitFactor !== null ? b.profitFactor.toFixed(2) : 'N/A'
    const pfFiltStr = f.profitFactor !== null ? f.profitFactor.toFixed(2) : 'N/A'

    console.log(
      `${String(rank).padStart(4)} | ${candidate.id.padEnd(27)} | ${candidate.family.padEnd(17)} | ${candidate.timeframe.padEnd(11)} | ` +
        `${b.winRatePct.toFixed(1).padStart(5)}% -> ${f.winRatePct.toFixed(1).padStart(5)}% (${(d.winRateLiftPp >= 0 ? '+' : '') + d.winRateLiftPp.toFixed(1)}pp)`.padEnd(
          32,
        ) +
        ` | ${String(b.losses).padStart(3)} -> ${String(f.losses).padStart(2)} (-${d.lossEliminationRatePct.toFixed(0).padStart(3)}%)`.padEnd(
          19,
        ) +
        ` | ${pfBaseStr.padStart(5)} -> ${pfFiltStr.padStart(5)} | ${d.drawdownReductionPct.toFixed(1).padStart(7)}% | ` +
        `$${b.netPnlUsd.toFixed(2).padStart(7)} -> $${f.netPnlUsd.toFixed(2).padStart(7)}`,
    )
  }

  console.log('-'.repeat(162))
  const aggBaseWr = aggBaseTrades > 0 ? (aggBaseWins / aggBaseTrades) * 100 : 0
  const aggFiltWr = aggFiltTrades > 0 ? (aggFiltWins / aggFiltTrades) * 100 : 0
  const aggElimPct =
    aggBaseLosses > 0
      ? ((aggBaseLosses - aggFiltLosses) / aggBaseLosses) * 100
      : 100

  console.log(
    `AGGREGATE OUT-OF-SAMPLE (Top ${results.length}): ` +
      `WR ${aggBaseWr.toFixed(2)}% -> ${aggFiltWr.toFixed(2)}% (+${(aggFiltWr - aggBaseWr).toFixed(2)}pp) | ` +
      `Negative Outcomes ${aggBaseLosses} -> ${aggFiltLosses} (${aggElimPct.toFixed(1)}% eliminated) | ` +
      `Recall ${((aggFiltTrades / Math.max(1, aggBaseTrades)) * 100).toFixed(1)}% | ` +
      `Net PnL $${aggBasePnl.toFixed(2)} -> $${aggFiltPnl.toFixed(2)} (Meta-Sized: $${aggSizedPnl.toFixed(2)})`,
  )

  // Print top loss drivers & learned veto rules per strategy
  console.log('\nLearned Toxic-Regime Veto Rules & Top Loss-Driving Features (strictly from Train/Val):')
  for (const { rank, candidate, comparison } of results) {
    const topFeats = comparison.model.featureImportanceRanking
      .slice(0, 3)
      .map(
        (x) =>
          `${x.feature} (imp ${(x.importance * 100).toFixed(1)}%, lossCorr ${x.lossCorrelation >= 0 ? '+' : ''}${x.lossCorrelation.toFixed(2)})`,
      )
      .join(', ')
    const vetos =
      comparison.model.hardVetoRules.length > 0
        ? comparison.model.hardVetoRules
            .map(
              (v) =>
                `${v.featureName} ${v.operator} ${v.threshold} (loss ${v.trainLossRatePct}%)`,
            )
            .join(' ; ')
        : 'Ensemble probability gate only'
    console.log(
      `  #${rank} ${candidate.id} [score*=${comparison.model.scoreThreshold.toFixed(3)}, pCal*=${comparison.model.probabilityThreshold.toFixed(2)}, trees=${comparison.model.gbdt.trees.length}]:`,
    )
    console.log(`      Top Drivers: ${topFeats}`)
    console.log(`      Hard Vetoes: ${vetos}`)
  }

  // Persist JSON artifact for live runtime scoring & inspection
  const artifact: {
    generatedAt: string
    source: DataSourceMode
    config: CliOptions
    aggregateOutOfSample: {
      baselineTrades: number
      baselineWins: number
      baselineLosses: number
      baselineWinRatePct: number
      filteredTrades: number
      filteredWins: number
      filteredLosses: number
      filteredWinRatePct: number
      winRateLiftPp: number
      lossesEliminated: number
      lossEliminationRatePct: number
      recallPct: number
      baselineNetPnlUsd: number
      filteredNetPnlUsd: number
      metaSizedNetPnlUsd: number
    }
    strategies: {
      rank: number
      id: string
      name: string
      family: string
      timeframe: string
      totalSamples: number
      split: { train: number; val: number; test: number; purgeGap: number }
      baseline: MetaBacktestComparison['baseline']
      filtered: MetaBacktestComparison['filtered']
      filteredSized: MetaBacktestComparison['filteredSized']
      delta: MetaBacktestComparison['delta']
      model: MetaFilterModel
    }[]
  } = {
    generatedAt: new Date().toISOString(),
    source: opts.source,
    config: opts,
    aggregateOutOfSample: {
      baselineTrades: aggBaseTrades,
      baselineWins: aggBaseWins,
      baselineLosses: aggBaseLosses,
      baselineWinRatePct: Math.round(aggBaseWr * 100) / 100,
      filteredTrades: aggFiltTrades,
      filteredWins: aggFiltWins,
      filteredLosses: aggFiltLosses,
      filteredWinRatePct: Math.round(aggFiltWr * 100) / 100,
      winRateLiftPp: Math.round((aggFiltWr - aggBaseWr) * 100) / 100,
      lossesEliminated: aggBaseLosses - aggFiltLosses,
      lossEliminationRatePct: Math.round(aggElimPct * 10) / 10,
      recallPct:
        Math.round((aggFiltTrades / Math.max(1, aggBaseTrades)) * 1000) / 10,
      baselineNetPnlUsd: Math.round(aggBasePnl * 100) / 100,
      filteredNetPnlUsd: Math.round(aggFiltPnl * 100) / 100,
      metaSizedNetPnlUsd: Math.round(aggSizedPnl * 100) / 100,
    },
    strategies: results.map(({ rank, candidate, comparison }) => ({
      rank,
      id: candidate.id,
      name: candidate.name,
      family: candidate.family,
      timeframe: candidate.timeframe,
      totalSamples: comparison.totalSamples,
      split: {
        train: comparison.trainSamples,
        val: comparison.valSamples,
        test: comparison.testSamples,
        purgeGap: comparison.purgeGapUsed,
      },
      baseline: comparison.baseline,
      filtered: comparison.filtered,
      filteredSized: comparison.filteredSized,
      delta: comparison.delta,
      model: comparison.model,
    })),
  }

  const resolvedOut = path.resolve(opts.outPath)
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true })
  fs.writeFileSync(resolvedOut, JSON.stringify(artifact, null, 2), 'utf-8')
  console.log(`\nSaved Top-10 ML Meta-Filter model artifact -> ${resolvedOut}\n`)
}

main().catch((err) => {
  console.error('[ml-meta-filter] Fatal error:', err)
  process.exit(1)
})
