import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import {
  STRATEGY_PRESETS,
  createInitialBotState,
  evaluateBotPresetAccuracy,
  normalizeBotEngineState,
  resolvePresetPredictionRule,
  stepBotEngine,
  trimBotEngineHistory,
  type BotEngineLog,
  type BotEngineState,
  type StrategyPreset,
} from '../botEngine'
import {
  buildQuoteFromPolymarketWindow,
  pickBestOpenPolymarketWindow,
  type ExecutablePredictionQuote,
} from '../market/quoteService'
import { evaluateTimeframePredictions } from '../predictions'
import { isStrategy } from '../strategy'
import type { Interval, Strategy } from '../types'
import {
  fetchOptimizedCandles,
  getCacheMetrics,
  type ServerCacheMetrics,
} from './candleCache'
import {
  exportExchangeState,
  getExchangeStatusSnapshot,
  resetEmergencyKillSwitch,
  resetExchangeDemoVault,
  restoreExchangeState,
  setExchangeAutoMirror,
  submitExchangeOrder,
  triggerEmergencyKillSwitch,
  updateHardRiskLimits,
  type HardRiskLimits,
  type PersistedExchangeState,
} from './exchangeAdapter'
import { getMt5BridgeSnapshot, registerMt5Poll } from './mt5Bridge'
import {
  fetchPolymarketUpDown,
  type PolymarketTimeframe,
} from './polymarketAdapter'

const POLL_INTERVAL_MS = 15_000
const SSE_KEEPALIVE_MS = 25_000
const SSE_MAX_BUFFERED_BYTES = 512 * 1024
const MT5_SSE_MIN_INTERVAL_MS = 15_000
const DATA_GUARD_LOG_THROTTLE_MS = 300_000
const MAX_BODY_BYTES = 64 * 1024
const MAX_RUNTIME_HISTORY_ITEMS = 500
const CANDLE_LOOKBACK_LIMIT = 500
const CURRENT_STATE_SCHEMA_VERSION = 2

function getStateFilePath(): string {
  const custom = process.env.FLARE_STATE_FILE?.trim()
  if (custom) return path.resolve(custom)
  return path.resolve(process.cwd(), 'src', 'server', 'bot-state.json')
}

type RuntimeGlobals = {
  pollTimer?: ReturnType<typeof setInterval>
  keepaliveTimer?: ReturnType<typeof setInterval>
  lastMt5SseBroadcastAt?: number
  lastMt5TerminalKey?: string
}

const RUNTIME_GLOBAL_KEY = Symbol.for('flare.botRuntime.globals')

function getRuntimeGlobals(): RuntimeGlobals {
  const host = globalThis as Record<symbol, RuntimeGlobals | undefined>
  let globals = host[RUNTIME_GLOBAL_KEY]
  if (!globals) {
    globals = {}
    host[RUNTIME_GLOBAL_KEY] = globals
  }
  return globals
}

class PayloadTooLargeError extends Error {
  constructor() {
    super('Request body exceeds 64 KB limit')
  }
}

class InvalidJsonBodyError extends Error {
  constructor() {
    super('Invalid JSON request body')
  }
}

type PersistedEnvelope = {
  schemaVersion?: number
  savedAt?: string
  presetId: string
  customStrategy?: Strategy
  isRunning?: boolean
  state: BotEngineState
  exchange?: PersistedExchangeState
}

type ServerTelemetry = {
  uptimeSec: number
  lastTickAt: string | null
  lastTickLatencyMs: number
  tickCount: number
  connectedStreamClients: number
  sseSeq: number
  lastDataSource: string | null
  lastQuote: ExecutablePredictionQuote | null
  lastQuoteError: string | null
  cache: ServerCacheMetrics
}

let isRunning = false
let activePreset: StrategyPreset = STRATEGY_PRESETS[1]
let engineState: BotEngineState = createInitialBotState(activePreset)
let lastTickAt: string | null = null
let lastTickLatencyMs = 0
let tickCount = 0
let sseSeq = 0
let lastDataSource: string | null = null
let lastDataGuardLogAt = 0
let lastQuote: ExecutablePredictionQuote | null = null
let lastQuoteError: string | null = null
let tickInProgress = false
let moduleWorkerStarted = false
let persistScheduled = false
let persistChain: Promise<void> = Promise.resolve()
const startedAtMs = Date.now()

const sseClients = new Set<http.ServerResponse>()

function buildEnvelopePayload(): PersistedEnvelope {
  return {
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    presetId: activePreset.id,
    customStrategy: activePreset.strategy,
    isRunning,
    state: engineState,
    exchange: exportExchangeState(),
  }
}

export function loadStateFromDisk(customFilePath?: string): {
  loaded: boolean
  quarantinedFile?: string
} {
  const stateFile = customFilePath ? path.resolve(customFilePath) : getStateFilePath()
  if (!fs.existsSync(stateFile)) {
    return { loaded: false }
  }
  let raw = ''
  try {
    raw = fs.readFileSync(stateFile, 'utf8')
    const parsed = JSON.parse(raw) as BotEngineState | PersistedEnvelope

    if ('state' in parsed && parsed.state && typeof parsed.presetId === 'string') {
      const found = STRATEGY_PRESETS.find((p) => p.id === parsed.presetId)
      if (found) {
        activePreset =
          parsed.customStrategy && isStrategy(parsed.customStrategy)
            ? {
                ...found,
                strategy: parsed.customStrategy,
              }
            : found
      }
      engineState = trimBotEngineHistory(
        normalizeBotEngineState(parsed.state),
        {
          maxClosedTrades: MAX_RUNTIME_HISTORY_ITEMS,
          maxResolvedTickets: MAX_RUNTIME_HISTORY_ITEMS,
        },
      )
      if (parsed.exchange) {
        restoreExchangeState(parsed.exchange)
      }
      const exchangeSnap = getExchangeStatusSnapshot()
      // Fail closed on startup if kill-switch or daily circuit breaker was tripped
      isRunning =
        Boolean(parsed.isRunning) &&
        !exchangeSnap.killSwitchActive &&
        !engineState.dayHalted
      return { loaded: true }
    }

    if ('balance' in parsed && 'logs' in parsed) {
      engineState = trimBotEngineHistory(normalizeBotEngineState(parsed), {
        maxClosedTrades: MAX_RUNTIME_HISTORY_ITEMS,
        maxResolvedTickets: MAX_RUNTIME_HISTORY_ITEMS,
      })
      return { loaded: true }
    }
    return { loaded: false }
  } catch (err) {
    const quarantinePath = `${stateFile}.corrupt.${Date.now()}.json`
    try {
      if (raw.length > 0 && fs.existsSync(stateFile)) {
        fs.renameSync(stateFile, quarantinePath)
      }
    } catch {
      // Best-effort quarantine only
    }
    console.error(
      `[FLARE Backend] Corrupted state file quarantined to ${quarantinePath}:`,
      err,
    )
    return { loaded: false, quarantinedFile: quarantinePath }
  }
}

/**
 * Synchronous atomic disk flush used on startup/shutdown and deterministic tests.
 */
export function flushStateToDiskSync(customFilePath?: string): void {
  const stateFile = customFilePath ? path.resolve(customFilePath) : getStateFilePath()
  try {
    const dir = path.dirname(stateFile)
    fs.mkdirSync(dir, { recursive: true })
    const tmpFile = `${stateFile}.${process.pid}.tmp`
    const json = JSON.stringify(buildEnvelopePayload(), null, 2)
    fs.writeFileSync(tmpFile, json, 'utf8')
    fs.renameSync(tmpFile, stateFile)
  } catch (err) {
    console.error('[FLARE Backend] Failed to flush state synchronously:', err)
  }
}

/**
 * Coalesces concurrent mutations into serialized async atomic `.tmp` -> rename
 * writes so HTTP/SSE ticks never stall the Node event loop (`P0-2`).
 */
function saveStateToDisk(): void {
  if (persistScheduled) return
  persistScheduled = true
  persistChain = persistChain.then(async () => {
    persistScheduled = false
    const stateFile = getStateFilePath()
    try {
      const dir = path.dirname(stateFile)
      await fs.promises.mkdir(dir, { recursive: true })
      const tmpFile = `${stateFile}.${process.pid}.tmp`
      const json = JSON.stringify(buildEnvelopePayload(), null, 2)
      await fs.promises.writeFile(tmpFile, json, 'utf8')
      await fs.promises.rename(tmpFile, stateFile)
    } catch (err) {
      console.error('[FLARE Backend] Failed to persist state:', err)
    }
  })
}

export async function flushStatePersistence(): Promise<void> {
  await persistChain
}

loadStateFromDisk()

export function getTelemetry(): ServerTelemetry {
  return {
    uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000),
    lastTickAt,
    lastTickLatencyMs,
    tickCount,
    connectedStreamClients: sseClients.size,
    sseSeq,
    lastDataSource,
    lastQuote,
    lastQuoteError,
    cache: getCacheMetrics(),
  }
}

export function getBotStatusSnapshot() {
  const exchange = getExchangeStatusSnapshot()
  return {
    seq: sseSeq,
    frameType: 'snapshot' as const,
    running: isRunning,
    preset: activePreset,
    presets: STRATEGY_PRESETS,
    state: engineState,
    telemetry: getTelemetry(),
    exchange,
    mt5: getMt5BridgeSnapshot(engineState, activePreset, exchange),
  }
}

function getBotDeltaPayload() {
  const exchange = getExchangeStatusSnapshot()
  return {
    seq: sseSeq,
    frameType: 'delta' as const,
    running: isRunning,
    preset: activePreset,
    state: engineState,
    telemetry: getTelemetry(),
    exchange,
    mt5: getMt5BridgeSnapshot(engineState, activePreset, exchange),
  }
}

function writeSseFrame(client: http.ServerResponse, frame: string): boolean {
  if (client.destroyed || client.writableEnded) {
    sseClients.delete(client)
    return false
  }
  try {
    const ok = client.write(frame)
    if (!ok && client.writableLength > SSE_MAX_BUFFERED_BYTES) {
      sseClients.delete(client)
      try {
        client.destroy()
      } catch {
        // Ignore cleanup failures on slow/stalled streams
      }
      return false
    }
    return true
  } catch {
    sseClients.delete(client)
    return false
  }
}

function broadcastSseUpdate(): void {
  if (sseClients.size === 0) return
  sseSeq += 1
  const data = `id: ${sseSeq}\ndata: ${JSON.stringify(getBotDeltaPayload())}\n\n`
  for (const client of sseClients) {
    writeSseFrame(client, data)
  }
}

async function resolvePredictionQuoteForPreset(
  preset: StrategyPreset,
  nowMs: number,
): Promise<{ quote: ExecutablePredictionQuote | null; error: string | null }> {
  if (preset.timeframe !== '5m' && preset.timeframe !== '15m') {
    return {
      quote: null,
      error: `No live Polymarket CLOB quote stream for interval ${preset.timeframe}.`,
    }
  }
  try {
    const rule = resolvePresetPredictionRule(preset)
    const outcome = rule?.predictedOutcome ?? 'YES'
    const snap = await fetchPolymarketUpDown(preset.timeframe, 4, { nowMs })
    const window = pickBestOpenPolymarketWindow(snap.windows, nowMs)
    if (!window) {
      return {
        quote: null,
        error:
          snap.errors[0] ??
          `No open Polymarket ${preset.timeframe} market window available.`,
      }
    }
    const quote = buildQuoteFromPolymarketWindow(window, outcome, nowMs)
    if (!quote) {
      return {
        quote: null,
        error: `Polymarket window ${window.slug} has no executable bid/ask quote.`,
      }
    }
    return { quote, error: null }
  } catch (err) {
    return {
      quote: null,
      error: `Quote fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Runs one cycle of the bot engine behind a re-entrancy guard (`tickInProgress`)
 * so concurrent evaluations never overlap.
 */
async function tickBot(options?: {
  forceExecution?: boolean
  forceCandleRefresh?: boolean
}): Promise<void> {
  if ((!isRunning && !options?.forceExecution) || tickInProgress) return

  const exchangeSnap = getExchangeStatusSnapshot()
  if (exchangeSnap.killSwitchActive) {
    isRunning = false
    return
  }

  tickInProgress = true

  const tickStart = Date.now()
  try {
    const { candles, source, latencyMs } = await fetchOptimizedCandles(
      activePreset.strategy.pair,
      activePreset.timeframe,
      CANDLE_LOOKBACK_LIMIT,
      { forceRefresh: options?.forceCandleRefresh },
    )
    lastDataSource = source

    if (!options?.forceExecution && source === 'synthetic-fallback') {
      const now = Date.now()
      if (now - lastDataGuardLogAt >= DATA_GUARD_LOG_THROTTLE_MS) {
        lastDataGuardLogAt = now
        engineState = {
          ...engineState,
          logs: [
            {
              id: now,
              timestamp: new Date(now).toISOString(),
              level: 'risk' as const,
              message:
                '[DATA GUARD] Upstream exchange candles unavailable (synthetic-fallback active); blocking autonomous live evaluation.',
            },
            ...engineState.logs,
          ].slice(0, 80),
        }
        saveStateToDisk()
      }
      broadcastSseUpdate()
      return
    }

    const nowMs = Date.now()
    let predictionQuote: ExecutablePredictionQuote | null = null
    if (activePreset.domain === 'prediction-market') {
      const fetched = await resolvePredictionQuoteForPreset(activePreset, nowMs)
      predictionQuote = fetched.quote
      lastQuote = fetched.quote
      lastQuoteError = fetched.error
    } else {
      lastQuote = null
      lastQuoteError = null
    }

    const prevTime = engineState.lastProcessedCandleTime
    const prevOpenPosition = engineState.openPosition
    const prevLatestTradeId = engineState.closedTrades[0]?.id ?? null
    const prevLatestResolvedId = engineState.resolvedTickets[0]?.id ?? null

    const steppedState = stepBotEngine(engineState, candles, activePreset, {
      // When the user triggers "Evaluate Candle Now", evaluate closed + latest candles;
      // in live autonomous ticks, pass `nowMs` to prevent repainting open candles.
      nowMs: options?.forceExecution ? undefined : nowMs,
      predictionQuote,
      requireExecutableQuote: true,
    })
    engineState = trimBotEngineHistory(steppedState, {
      maxClosedTrades: MAX_RUNTIME_HISTORY_ITEMS,
      maxResolvedTickets: MAX_RUNTIME_HISTORY_ITEMS,
    })

    let exchangeMutated = false
    // Auto-mirror bot fills to the Exchange adapter with deterministic idempotency keys
    if (exchangeSnap.autoMirrorBotOrders) {
      if (!prevOpenPosition && engineState.openPosition) {
        const pos = engineState.openPosition
        const cappedNotional = Math.min(
          pos.notional,
          exchangeSnap.hardLimits.maxOrderNotionalUsd,
        )
        await submitExchangeOrder({
          pair: pos.pair,
          side: pos.side === 'buy' ? 'BUY' : 'SELL',
          notionalUsd: cappedNotional,
          referencePrice: pos.entryPrice,
          source: 'bot-auto',
          clientOrderId: `bot-entry-${pos.pair.replace('/', '')}-${pos.entryTime}`,
        })
        exchangeMutated = true
      } else if (
        engineState.closedTrades[0] &&
        engineState.closedTrades[0].id !== prevLatestTradeId
      ) {
        const latestTrade = engineState.closedTrades[0]
        if (latestTrade) {
          const cappedNotional = Math.min(
            latestTrade.entryPrice * latestTrade.size,
            exchangeSnap.hardLimits.maxOrderNotionalUsd,
          )
          await submitExchangeOrder({
            pair: latestTrade.pair,
            side: latestTrade.side === 'buy' ? 'SELL' : 'BUY',
            notionalUsd: cappedNotional,
            referencePrice: latestTrade.exitPrice,
            realizedPnlUsd: latestTrade.pnl,
            source: 'bot-auto',
            clientOrderId: `bot-exit-${latestTrade.pair.replace('/', '')}-${latestTrade.id}`,
          })
          exchangeMutated = true
        }
      }
    }

    lastTickAt = new Date().toISOString()
    lastTickLatencyMs = latencyMs || Math.max(1, Date.now() - tickStart)
    tickCount += 1

    if (
      exchangeMutated ||
      engineState.lastProcessedCandleTime !== prevTime ||
      (engineState.closedTrades[0]?.id ?? null) !== prevLatestTradeId ||
      (engineState.resolvedTickets[0]?.id ?? null) !== prevLatestResolvedId
    ) {
      saveStateToDisk()
    }

    broadcastSseUpdate()
  } catch (error) {
    console.error('[FLARE Backend] Bot tick error:', error)
  } finally {
    tickInProgress = false
  }
}

export function stopBackgroundWorker(): void {
  const globals = getRuntimeGlobals()
  if (globals.pollTimer) {
    clearInterval(globals.pollTimer)
    globals.pollTimer = undefined
  }
  if (globals.keepaliveTimer) {
    clearInterval(globals.keepaliveTimer)
    globals.keepaliveTimer = undefined
  }
  moduleWorkerStarted = false
  flushStateToDiskSync()
}

export function ensureBackgroundWorker(): void {
  if (moduleWorkerStarted) return
  moduleWorkerStarted = true

  const globals = getRuntimeGlobals()
  if (globals.pollTimer) clearInterval(globals.pollTimer)
  if (globals.keepaliveTimer) clearInterval(globals.keepaliveTimer)

  const pollTimer = setInterval(() => {
    void tickBot()
  }, POLL_INTERVAL_MS)
  pollTimer.unref?.()
  globals.pollTimer = pollTimer

  const keepaliveTimer = setInterval(() => {
    if (sseClients.size === 0) return
    for (const client of sseClients) {
      writeSseFrame(client, ': keepalive\n\n')
    }
  }, SSE_KEEPALIVE_MS)
  keepaliveTimer.unref?.()
  globals.keepaliveTimer = keepaliveTimer
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(JSON.stringify(payload))
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = []
  let totalBytes = 0

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    totalBytes += buf.byteLength
    if (totalBytes > MAX_BODY_BYTES) {
      throw new PayloadTooLargeError()
    }
    chunks.push(buf)
  }

  const body = Buffer.concat(chunks).toString('utf8').trim()
  if (!body) return null

  try {
    return JSON.parse(body) as T
  } catch {
    throw new InvalidJsonBodyError()
  }
}

async function readOptionalJsonBody<T>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<{ ok: true; data: T | null } | { ok: false }> {
  try {
    const data = await readJsonBody<T>(req)
    return { ok: true, data }
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendJson(res, 413, { error: error.message })
      return { ok: false }
    }
    if (error instanceof InvalidJsonBodyError) {
      sendJson(res, 400, { error: error.message })
      return { ok: false }
    }
    sendJson(res, 400, { error: 'Failed to read request body' })
    return { ok: false }
  }
}

/**
 * Unified HTTP request handler for `/api/*`.
 * Mounted in both the standalone server (`src/server/index.ts`) and Vite dev middleware (`vite.config.ts`).
 */
export async function handleBotApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  ensureBackgroundWorker()

  const rawUrl = req.url ?? '/'
  if (!rawUrl.startsWith('/api/')) {
    return false
  }

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, null)
    return true
  }

  const url = new URL(rawUrl, 'http://localhost')

  // 1. GET /api/health -> Server, latency, and cache diagnostics
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, {
      status: 'ok',
      running: isRunning,
      activePresetId: activePreset.id,
      telemetry: getTelemetry(),
      exchange: getExchangeStatusSnapshot(),
    })
    return true
  }

  // 2. GET /api/bot/status -> Full bot status, telemetry, demo exchange, and MT5 bridge
  if (req.method === 'GET' && url.pathname === '/api/bot/status') {
    sendJson(res, 200, getBotStatusSnapshot())
    return true
  }

  // 3. GET /api/bot/stream -> Real-time Server-Sent Events (SSE)
  if (req.method === 'GET' && url.pathname === '/api/bot/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    sseClients.add(res)
    sseSeq += 1
    writeSseFrame(
      res,
      `id: ${sseSeq}\ndata: ${JSON.stringify(getBotStatusSnapshot())}\n\n`,
    )

    const cleanupClient = () => {
      sseClients.delete(res)
    }
    req.on('close', cleanupClient)
    res.on('close', cleanupClient)
    res.on('error', cleanupClient)
    return true
  }

  // 4. GET /api/bot/accuracy -> Parallel accuracy audit across 1 or all 8 presets
  if (req.method === 'GET' && url.pathname === '/api/bot/accuracy') {
    const evaluateAll = url.searchParams.get('all') === 'true'
    const targetPresets = evaluateAll ? STRATEGY_PRESETS : [activePreset]

    const reports = await Promise.all(
      targetPresets.map(async (preset) => {
        const { candles, source, latencyMs } = await fetchOptimizedCandles(
          preset.strategy.pair,
          preset.timeframe,
          CANDLE_LOOKBACK_LIMIT,
        )
        return {
          ...evaluateBotPresetAccuracy(candles, preset),
          dataSource: source,
          fetchLatencyMs: latencyMs,
        }
      }),
    )

    sendJson(res, 200, {
      evaluatedAt: new Date().toISOString(),
      candleSampleSize: CANDLE_LOOKBACK_LIMIT,
      telemetry: getTelemetry(),
      reports,
    })
    return true
  }

  // 5. GET /api/predictions/accuracy?timeframe=15m -> Prediction rule accuracy audit
  if (req.method === 'GET' && url.pathname === '/api/predictions/accuracy') {
    const tf = (url.searchParams.get('timeframe') ?? '15m') as Interval
    const { candles, source, latencyMs } = await fetchOptimizedCandles(
      'BTC/USDT',
      tf,
      CANDLE_LOOKBACK_LIMIT,
    )
    const rules = evaluateTimeframePredictions(tf, candles)

    sendJson(res, 200, {
      evaluatedAt: new Date().toISOString(),
      timeframe: tf,
      dataSource: source,
      fetchLatencyMs: latencyMs,
      candleSampleSize: candles.length,
      rules,
    })
    return true
  }

  // 5b. GET /api/predictions/polymarket?tf=15m&limit=48 -> Live BTC Up/Down market windows
  if (req.method === 'GET' && url.pathname === '/api/predictions/polymarket') {
    const tfParam = url.searchParams.get('tf')
    const tf: PolymarketTimeframe = tfParam === '5m' ? '5m' : '15m'
    const limit = Number(url.searchParams.get('limit') ?? 48)
    try {
      const snapshot = await fetchPolymarketUpDown(
        tf,
        Number.isFinite(limit) ? limit : 48,
      )
      sendJson(res, 200, snapshot)
    } catch (err) {
      sendJson(res, 502, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  // 6. POST /api/bot/start -> Starts the bot (optionally switching preset or strategy)
  if (req.method === 'POST' && url.pathname === '/api/bot/start') {
    if (getExchangeStatusSnapshot().killSwitchActive) {
      sendJson(res, 423, {
        error:
          'Emergency Kill-Switch is active. Reset the exchange Kill-Switch before starting the bot.',
        snapshot: getBotStatusSnapshot(),
      })
      return true
    }

    const body = await readOptionalJsonBody<{
      presetId?: string
      strategy?: Strategy
    }>(req, res)
    if (!body.ok) return true
    const parsed = body.data

    if (parsed?.presetId) {
      const found = STRATEGY_PRESETS.find((p) => p.id === parsed.presetId)
      if (found && found.id !== activePreset.id) {
        activePreset = found
        engineState = createInitialBotState(activePreset)
      }
    }

    if (parsed?.strategy && isStrategy(parsed.strategy)) {
      activePreset = {
        ...activePreset,
        strategy: parsed.strategy,
      }
      engineState = {
        ...engineState,
        pair: parsed.strategy.pair,
      }
    }

    isRunning = true
    await tickBot({ forceExecution: true })
    saveStateToDisk()
    broadcastSseUpdate()
    sendJson(res, 200, getBotStatusSnapshot())
    return true
  }

  // 7. POST /api/bot/stop -> Stops the autonomous loop
  if (req.method === 'POST' && url.pathname === '/api/bot/stop') {
    isRunning = false
    saveStateToDisk()
    broadcastSseUpdate()
    sendJson(res, 200, getBotStatusSnapshot())
    return true
  }

  // 8. POST /api/bot/reset -> Resets balance, positions, and tickets for active preset
  if (req.method === 'POST' && url.pathname === '/api/bot/reset') {
    isRunning = false
    engineState = createInitialBotState(activePreset)
    saveStateToDisk()
    broadcastSseUpdate()
    sendJson(res, 200, getBotStatusSnapshot())
    return true
  }

  // 9. POST /api/bot/preset -> Switches active preset or syncs custom strategy parameters
  if (req.method === 'POST' && url.pathname === '/api/bot/preset') {
    const body = await readOptionalJsonBody<{
      presetId?: string
      strategy?: Strategy
      timeframe?: Interval
      reset?: boolean
    }>(req, res)
    if (!body.ok) return true
    const parsed = body.data

    if (parsed?.presetId) {
      const found = STRATEGY_PRESETS.find((p) => p.id === parsed.presetId)
      if (found && (found.id !== activePreset.id || parsed.reset === true)) {
        activePreset = found
        engineState = createInitialBotState(activePreset)
      }
    }

    if (parsed?.strategy && isStrategy(parsed.strategy)) {
      activePreset = {
        ...activePreset,
        strategy: parsed.strategy,
        timeframe: parsed.timeframe ?? activePreset.timeframe,
      }
      engineState = {
        ...engineState,
        pair: parsed.strategy.pair,
        timeframe: activePreset.timeframe,
      }
    }

    saveStateToDisk()
    broadcastSseUpdate()
    sendJson(res, 200, getBotStatusSnapshot())
    return true
  }

  // 10. POST /api/bot/tick -> Forces immediate evaluation on current candles
  if (req.method === 'POST' && url.pathname === '/api/bot/tick') {
    await tickBot({ forceExecution: true, forceCandleRefresh: true })
    saveStateToDisk()
    sendJson(res, 200, getBotStatusSnapshot())
    return true
  }

  // ============================================================================
  // Exchange Adapter Endpoints (Demo Vault + Hard Risk Limits + Kill-Switch)
  // ============================================================================

  // 11. GET /api/exchange/status -> Demo adapter status, balances, limits, and order history
  if (req.method === 'GET' && url.pathname === '/api/exchange/status') {
    sendJson(res, 200, getExchangeStatusSnapshot())
    return true
  }

  // 12. POST /api/exchange/order -> Submits an order validated against HardRiskLimits
  if (req.method === 'POST' && url.pathname === '/api/exchange/order') {
    const body = await readOptionalJsonBody<{
      pair?: string
      side?: 'BUY' | 'SELL'
      notionalUsd?: number
      referencePrice?: number
      clientOrderId?: string
    }>(req, res)
    if (!body.ok) return true
    const parsed = body.data

    const pair = parsed?.pair ?? activePreset.strategy.pair
    const side = parsed?.side === 'SELL' ? 'SELL' : 'BUY'
    const notionalUsd = Number(parsed?.notionalUsd ?? 100)

    const result = await submitExchangeOrder({
      pair,
      side,
      notionalUsd,
      referencePrice: parsed?.referencePrice,
      source: 'manual',
      clientOrderId: parsed?.clientOrderId,
    })

    const newLog: BotEngineLog = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      level: result.ok ? 'trade' : 'risk',
      message: result.ok
        ? `[DEMO BROKER] ${side} ${pair} order for $${notionalUsd.toFixed(2)} USD filled @ $${result.order.price.toFixed(2)}`
        : `[HARD LIMIT] ${result.error}`,
    }

    engineState = {
      ...engineState,
      logs: [newLog, ...engineState.logs].slice(0, 80),
    }
    saveStateToDisk()
    broadcastSseUpdate()

    sendJson(res, 200, {
      ...result,
      bot: getBotStatusSnapshot(),
    })
    return true
  }

  // 13. POST /api/exchange/limits -> Updates HardRiskLimits or auto-mirror setting
  if (req.method === 'POST' && url.pathname === '/api/exchange/limits') {
    const body = await readOptionalJsonBody<
      Partial<HardRiskLimits> & { autoMirrorBotOrders?: boolean }
    >(req, res)
    if (!body.ok) return true
    const parsed = body.data

    if (parsed) {
      updateHardRiskLimits(parsed)
      if (typeof parsed.autoMirrorBotOrders === 'boolean') {
        setExchangeAutoMirror(parsed.autoMirrorBotOrders)
      }
      saveStateToDisk()
    }

    broadcastSseUpdate()
    sendJson(res, 200, getBotStatusSnapshot())
    return true
  }

  // 14. POST /api/exchange/kill-switch -> Engages or resets the Emergency Kill-Switch
  if (req.method === 'POST' && url.pathname === '/api/exchange/kill-switch') {
    const body = await readOptionalJsonBody<{
      action?: 'engage' | 'reset'
      reason?: string
    }>(req, res)
    if (!body.ok) return true
    const parsed = body.data

    if (parsed?.action === 'reset') {
      resetEmergencyKillSwitch()
      const rearmLog: BotEngineLog = {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        level: 'info',
        message:
          'Emergency Kill-Switch reset by operator. System ready.',
      }
      engineState = {
        ...engineState,
        logs: [rearmLog, ...engineState.logs].slice(0, 80),
      }
    } else {
      const reason =
        parsed?.reason ?? 'Emergency stop triggered by operator'
      await triggerEmergencyKillSwitch(reason, () => {
        isRunning = false
        const killLog: BotEngineLog = {
          id: Date.now(),
          timestamp: new Date().toISOString(),
          level: 'risk',
          message: `KILL-SWITCH TRIGGERED: ${reason}. Bot stopped, orders canceled, and positions closed.`,
        }
        engineState = {
          ...engineState,
          openPosition: null,
          activeTickets: [],
          logs: [killLog, ...engineState.logs].slice(0, 80),
        }
      })
    }

    saveStateToDisk()
    broadcastSseUpdate()
    sendJson(res, 200, getBotStatusSnapshot())
    return true
  }

  // 15. POST /api/exchange/reset -> Restores Demo Vault balances and order history
  if (req.method === 'POST' && url.pathname === '/api/exchange/reset') {
    resetExchangeDemoVault()
    saveStateToDisk()
    broadcastSseUpdate()
    sendJson(res, 200, getBotStatusSnapshot())
    return true
  }

  // ============================================================================
  // MetaTrader 5 Bridge Endpoints (MQL5 Expert Advisor)
  // ============================================================================

  // 16. GET /api/mt5/signal -> Polled by FlareBridgeEA.mq5 via WebRequest()
  if (req.method === 'GET' && url.pathname === '/api/mt5/signal') {
    const terminal = url.searchParams.get('terminal') ?? 'MT5-ExpertAdvisor'
    const symbol = url.searchParams.get('symbol')
    const packet = registerMt5Poll(
      engineState,
      activePreset,
      getExchangeStatusSnapshot(),
      { terminal, symbol },
    )
    const globals = getRuntimeGlobals()
    const terminalKey = `${terminal}|${symbol ?? ''}|${packet.action}`
    const now = Date.now()
    const changed = terminalKey !== globals.lastMt5TerminalKey
    const intervalElapsed =
      globals.lastMt5SseBroadcastAt === undefined ||
      now - globals.lastMt5SseBroadcastAt >= MT5_SSE_MIN_INTERVAL_MS
    if (changed || intervalElapsed) {
      globals.lastMt5TerminalKey = terminalKey
      globals.lastMt5SseBroadcastAt = now
      broadcastSseUpdate()
    }
    sendJson(res, 200, packet)
    return true
  }

  // 17. POST /api/mt5/simulate-ping -> Simulates a poll from MetaTrader 5 in the UI
  if (req.method === 'POST' && url.pathname === '/api/mt5/simulate-ping') {
    const packet = registerMt5Poll(
      engineState,
      activePreset,
      getExchangeStatusSnapshot(),
      {
        terminal: 'MT5-Terminal-Demo',
        symbol: activePreset.strategy.pair.replace('/USDT', 'USD'),
      },
    )
    const mt5Log: BotEngineLog = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      level: 'signal',
      message: `[MT5 BRIDGE] Poll received from ${packet.symbol} (Magic #${packet.magicNumber}) -> Action: ${packet.action} (${packet.signalId})`,
    }
    engineState = {
      ...engineState,
      logs: [mt5Log, ...engineState.logs].slice(0, 80),
    }
    saveStateToDisk()
    broadcastSseUpdate()
    sendJson(res, 200, {
      packet,
      bot: getBotStatusSnapshot(),
    })
    return true
  }

  sendJson(res, 404, { error: 'API route not found' })
  return true
}
