import crypto from 'node:crypto'
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
import { availablePairs, isStrategy } from '../strategy'
import type { Interval, Strategy } from '../types'
import {
  authenticateRequest,
  authorizePermission,
  checkRateLimit,
  resolveCorsHeaders,
  type AuthPrincipal,
  type Permission,
} from './auth'
import { getSharedStateAdapter } from './cache/sharedState'
import {
  fetchOptimizedCandles,
  getCacheMetrics,
  UpstreamMarketDataError,
  type ServerCacheMetrics,
} from './candleCache'
import {
  exportExchangeState,
  getExchangeStatusSnapshot,
  getTenantLedgerSnapshot,
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
import {
  getMarketGateway,
  type MarketGatewayMetrics,
} from './marketData/marketGateway'
import { getMt5BridgeSnapshot, registerMt5Poll } from './mt5Bridge'
import {
  fetchPolymarketUpDown,
  type PolymarketTimeframe,
} from './polymarketAdapter'
import {
  closeStateStore,
  getStateStore,
  SqliteStateStore,
  type AuditEventRecord,
  type PersistedTenantEnvelope,
} from './store'

const POLL_INTERVAL_MS = 15_000
const SSE_KEEPALIVE_MS = 25_000
const SSE_MAX_BUFFERED_BYTES = 512 * 1024
const MT5_SSE_MIN_INTERVAL_MS = 15_000
const DATA_GUARD_LOG_THROTTLE_MS = 300_000
const MAX_BODY_BYTES = 64 * 1024
const MAX_RUNTIME_HISTORY_ITEMS = 500
const CANDLE_LOOKBACK_LIMIT = 500
const CURRENT_STATE_SCHEMA_VERSION = 2
const DEFAULT_TENANT_ID = 'default'
const VALID_INTERVALS = new Set<Interval>(['5m', '15m', '1h', '4h', '1d'])

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
  tenantId?: string
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
  storeDriver: string
  sharedStateBackend: string
  marketGateway: MarketGatewayMetrics
  cache: ServerCacheMetrics
}

type TenantRuntime = {
  tenantId: string
  isRunning: boolean
  activePreset: StrategyPreset
  engineState: BotEngineState
  lastTickAt: string | null
  lastTickLatencyMs: number
  tickCount: number
  sseSeq: number
  lastDataSource: string | null
  lastDataGuardLogAt: number
  lastQuote: ExecutablePredictionQuote | null
  lastQuoteError: string | null
  tickInProgress: boolean
  sseClients: Set<http.ServerResponse>
  hydrated: boolean
}

const tenantRuntimes = new Map<string, TenantRuntime>()
const marketSseClients = new Set<http.ServerResponse>()
let moduleWorkerStarted = false
let persistScheduled = false
let persistChain: Promise<void> = Promise.resolve()
const startedAtMs = Date.now()

function createFreshTenantRuntime(tenantId: string): TenantRuntime {
  const preset = STRATEGY_PRESETS[1]
  return {
    tenantId,
    isRunning: false,
    activePreset: preset,
    engineState: createInitialBotState(preset),
    lastTickAt: null,
    lastTickLatencyMs: 0,
    tickCount: 0,
    sseSeq: 0,
    lastDataSource: null,
    lastDataGuardLogAt: 0,
    lastQuote: null,
    lastQuoteError: null,
    tickInProgress: false,
    sseClients: new Set(),
    hydrated: false,
  }
}

function applyEnvelopeToTenant(
  rt: TenantRuntime,
  parsed: PersistedEnvelope | BotEngineState,
): boolean {
  if ('state' in parsed && parsed.state && typeof parsed.presetId === 'string') {
    const found = STRATEGY_PRESETS.find((p) => p.id === parsed.presetId)
    if (found) {
      rt.activePreset =
        parsed.customStrategy && isStrategy(parsed.customStrategy)
          ? {
            ...found,
            strategy: parsed.customStrategy,
          }
          : found
    }
    rt.engineState = trimBotEngineHistory(
      normalizeBotEngineState(parsed.state),
      {
        maxClosedTrades: MAX_RUNTIME_HISTORY_ITEMS,
        maxResolvedTickets: MAX_RUNTIME_HISTORY_ITEMS,
      },
    )
    if (parsed.exchange) {
      restoreExchangeState(parsed.exchange, rt.tenantId)
    }
    const exchangeSnap = getExchangeStatusSnapshot(rt.tenantId)
    // Fail closed on startup if kill-switch or daily circuit breaker was tripped
    rt.isRunning =
      Boolean(parsed.isRunning) &&
      !exchangeSnap.killSwitchActive &&
      !rt.engineState.dayHalted
    return true
  }

  if ('balance' in parsed && 'logs' in parsed) {
    rt.engineState = trimBotEngineHistory(normalizeBotEngineState(parsed), {
      maxClosedTrades: MAX_RUNTIME_HISTORY_ITEMS,
      maxResolvedTickets: MAX_RUNTIME_HISTORY_ITEMS,
    })
    return true
  }

  return false
}

function hydrateTenantFromStoreSync(rt: TenantRuntime): void {
  if (rt.hydrated) return
  rt.hydrated = true
  try {
    const store = getStateStore()
    if (store instanceof SqliteStateStore) {
      const snap = store.loadTenantSnapshotSync(rt.tenantId)
      if (snap) {
        applyEnvelopeToTenant(rt, snap)
      }
    }
  } catch (err) {
    console.error(
      `[FLARE Backend] Failed to hydrate tenant ${rt.tenantId} from SQL store:`,
      err,
    )
  }
}

function getTenantRuntime(tenantId = DEFAULT_TENANT_ID): TenantRuntime {
  let rt = tenantRuntimes.get(tenantId)
  if (!rt) {
    rt = createFreshTenantRuntime(tenantId)
    tenantRuntimes.set(tenantId, rt)
    hydrateTenantFromStoreSync(rt)
  }
  return rt
}

function buildEnvelopePayload(
  tenantId = DEFAULT_TENANT_ID,
): PersistedTenantEnvelope {
  const rt = getTenantRuntime(tenantId)
  return {
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    tenantId,
    presetId: rt.activePreset.id,
    customStrategy: rt.activePreset.strategy,
    isRunning: rt.isRunning,
    state: rt.engineState,
    exchange: exportExchangeState(tenantId),
  }
}

export function loadStateFromDisk(
  customFilePath?: string,
  tenantId = DEFAULT_TENANT_ID,
): {
  loaded: boolean
  quarantinedFile?: string
} {
  const rt = getTenantRuntime(tenantId)
  const stateFile = customFilePath
    ? path.resolve(customFilePath)
    : getStateFilePath()
  if (!fs.existsSync(stateFile)) {
    return { loaded: false }
  }
  let raw = ''
  try {
    raw = fs.readFileSync(stateFile, 'utf8')
    const parsed = JSON.parse(raw) as BotEngineState | PersistedEnvelope
    const applied = applyEnvelopeToTenant(rt, parsed)
    if (applied) {
      const env = buildEnvelopePayload(tenantId)
      void getStateStore()
        .saveTenantSnapshot(env)
        .catch(() => { })
    }
    return { loaded: applied }
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
 * Synchronous atomic flush to SQL store (and optional JSON snapshot file when
 * `customFilePath` or `FLARE_STATE_FILE` is specified).
 */
export function flushStateToDiskSync(
  customFilePath?: string,
  tenantId = DEFAULT_TENANT_ID,
): void {
  const envelope = buildEnvelopePayload(tenantId)
  try {
    const store = getStateStore()
    if (store instanceof SqliteStateStore) {
      store.saveTenantSnapshotSync(envelope)
    }
  } catch (err) {
    console.error('[FLARE Backend] Failed to flush state to SQL store:', err)
  }

  const shouldWriteJsonFile = Boolean(
    customFilePath || process.env.FLARE_STATE_FILE?.trim(),
  )
  if (!shouldWriteJsonFile) return

  const stateFile = customFilePath
    ? path.resolve(customFilePath)
    : getStateFilePath()
  try {
    const dir = path.dirname(stateFile)
    fs.mkdirSync(dir, { recursive: true })
    const tmpFile = `${stateFile}.${process.pid}.tmp`
    const json = JSON.stringify(envelope, null, 2)
    fs.writeFileSync(tmpFile, json, 'utf8')
    fs.renameSync(tmpFile, stateFile)
  } catch (err) {
    console.error('[FLARE Backend] Failed to flush state synchronously:', err)
  }
}

function saveStateToDisk(tenantId = DEFAULT_TENANT_ID): void {
  const envelope = buildEnvelopePayload(tenantId)
  try {
    const store = getStateStore()
    if (store instanceof SqliteStateStore) {
      store.saveTenantSnapshotSync(envelope)
    } else {
      persistChain = persistChain.then(async () => {
        await store.saveTenantSnapshot(envelope).catch((err) => {
          console.error('[FLARE Backend] SQL store save failed:', err)
        })
      })
    }
  } catch (err) {
    console.error('[FLARE Backend] Failed to persist tenant state:', err)
  }

  const customJson = process.env.FLARE_STATE_FILE?.trim()
  if (!customJson) return

  if (persistScheduled) return
  persistScheduled = true
  persistChain = persistChain.then(async () => {
    persistScheduled = false
    const stateFile = getStateFilePath()
    try {
      const dir = path.dirname(stateFile)
      await fs.promises.mkdir(dir, { recursive: true })
      const tmpFile = `${stateFile}.${process.pid}.tmp`
      const json = JSON.stringify(buildEnvelopePayload(tenantId), null, 2)
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

function recordAudit(
  principal: AuthPrincipal,
  action: string,
  resource: string,
  outcome: AuditEventRecord['outcome'],
  details?: Record<string, string | number | boolean | null>,
): void {
  const event: AuditEventRecord = {
    id: `AUD-${crypto.randomUUID()}`,
    tenantId: principal.tenantId,
    timestamp: new Date().toISOString(),
    actor: principal.subject,
    role: principal.role,
    action,
    resource,
    outcome,
    details,
  }
  void getStateStore()
    .appendAuditEvent(event)
    .catch(() => { })
}

// Bootstrap default tenant from SQL store (and one-time legacy JSON fallback if present)
{
  const defaultRt = getTenantRuntime(DEFAULT_TENANT_ID)
  const store = getStateStore()
  const hasSqlSnapshot =
    store instanceof SqliteStateStore
      ? store.loadTenantSnapshotSync(DEFAULT_TENANT_ID) !== null
      : false
  if (!hasSqlSnapshot && fs.existsSync(getStateFilePath())) {
    loadStateFromDisk(undefined, DEFAULT_TENANT_ID)
  }
  defaultRt.hydrated = true
}

export function getTelemetry(tenantId = DEFAULT_TENANT_ID): ServerTelemetry {
  const rt = getTenantRuntime(tenantId)
  return {
    uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000),
    lastTickAt: rt.lastTickAt,
    lastTickLatencyMs: rt.lastTickLatencyMs,
    tickCount: rt.tickCount,
    connectedStreamClients: rt.sseClients.size,
    sseSeq: rt.sseSeq,
    lastDataSource: rt.lastDataSource,
    lastQuote: rt.lastQuote,
    lastQuoteError: rt.lastQuoteError,
    storeDriver: getStateStore().driver,
    sharedStateBackend: getSharedStateAdapter().backend,
    marketGateway: getMarketGateway().getMetrics(),
    cache: getCacheMetrics(),
  }
}

export function getBotStatusSnapshot(tenantId = DEFAULT_TENANT_ID) {
  const rt = getTenantRuntime(tenantId)
  const exchange = getExchangeStatusSnapshot(tenantId)
  return {
    seq: rt.sseSeq,
    frameType: 'snapshot' as const,
    tenantId,
    running: rt.isRunning,
    preset: rt.activePreset,
    presets: STRATEGY_PRESETS,
    state: rt.engineState,
    telemetry: getTelemetry(tenantId),
    exchange,
    mt5: getMt5BridgeSnapshot(rt.engineState, rt.activePreset, exchange),
  }
}

function getBotDeltaSnapshot(tenantId = DEFAULT_TENANT_ID) {
  const rt = getTenantRuntime(tenantId)
  const exchange = getExchangeStatusSnapshot(tenantId)
  return {
    seq: rt.sseSeq,
    frameType: 'delta' as const,
    tenantId,
    running: rt.isRunning,
    preset: rt.activePreset,
    state: rt.engineState,
    telemetry: getTelemetry(tenantId),
    exchange,
    mt5: getMt5BridgeSnapshot(rt.engineState, rt.activePreset, exchange),
  }
}

function writeSseFrame(
  client: http.ServerResponse,
  payload: string,
  clientSet: Set<http.ServerResponse>,
): void {
  if (client.writableEnded || client.destroyed) {
    clientSet.delete(client)
    return
  }
  if (
    client.writableNeedDrain ||
    (typeof client.writableLength === 'number' &&
      client.writableLength > SSE_MAX_BUFFERED_BYTES)
  ) {
    clientSet.delete(client)
    try {
      client.end()
    } catch {
      // Ignore already-closed stream errors
    }
    return
  }
  try {
    const ok = client.write(payload)
    if (
      !ok &&
      typeof client.writableLength === 'number' &&
      client.writableLength > SSE_MAX_BUFFERED_BYTES
    ) {
      clientSet.delete(client)
      client.end()
    }
  } catch {
    clientSet.delete(client)
  }
}

function broadcastSseUpdate(tenantId = DEFAULT_TENANT_ID): void {
  const rt = getTenantRuntime(tenantId)
  rt.sseSeq += 1
  if (rt.sseClients.size === 0) return
  const payload = `id: ${rt.sseSeq}\ndata: ${JSON.stringify(getBotDeltaSnapshot(tenantId))}\n\n`
  for (const client of Array.from(rt.sseClients)) {
    writeSseFrame(client, payload, rt.sseClients)
  }
}

async function resolvePredictionQuoteForPreset(
  preset: StrategyPreset,
  nowMs: number,
): Promise<{ quote: ExecutablePredictionQuote | null; error: string | null }> {
  const rule = resolvePresetPredictionRule(preset)
  if (!rule) {
    return { quote: null, error: 'No prediction rule configured for preset.' }
  }
  if (rule.timeframe !== '5m' && rule.timeframe !== '15m') {
    return {
      quote: null,
      error: `No live Polymarket CLOB feed for ${rule.timeframe} contracts (${rule.id}).`,
    }
  }
  try {
    const snapshot = await fetchPolymarketUpDown(rule.timeframe, 6)
    const openWindow = pickBestOpenPolymarketWindow(snapshot.windows, nowMs)
    if (!openWindow) {
      return {
        quote: null,
        error: `No open Polymarket ${rule.timeframe} window found.`,
      }
    }
    const asOfMs = Date.parse(snapshot.fetchedAt) || nowMs
    const quote = buildQuoteFromPolymarketWindow(
      openWindow,
      rule.predictedOutcome,
      asOfMs,
    )
    if (!quote) {
      return {
        quote: null,
        error: `Open window ${openWindow.slug} has no executable bid/ask quote.`,
      }
    }
    return { quote, error: null }
  } catch (err) {
    return {
      quote: null,
      error: `Polymarket quote fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

async function tickBot(
  tenantId = DEFAULT_TENANT_ID,
  options?: {
    forceExecution?: boolean
    forceCandleRefresh?: boolean
  },
): Promise<void> {
  const rt = getTenantRuntime(tenantId)
  if (rt.tickInProgress) return
  if (!rt.isRunning && !options?.forceExecution) return
  if (getExchangeStatusSnapshot(tenantId).killSwitchActive) {
    rt.isRunning = false
    return
  }

  rt.tickInProgress = true

  const tickStart = Date.now()
  try {
    let candles
    let source
    let latencyMs: number
    try {
      const fetched = await getMarketGateway().getCandles(
        rt.activePreset.strategy.pair,
        rt.activePreset.timeframe,
        CANDLE_LOOKBACK_LIMIT,
        { forceRefresh: options?.forceCandleRefresh },
      )
      candles = fetched.candles
      source = fetched.source
      latencyMs = fetched.latencyMs
      rt.lastDataSource = source
    } catch (err) {
      rt.lastDataSource = 'unavailable'
      const now = Date.now()
      if (now - rt.lastDataGuardLogAt >= DATA_GUARD_LOG_THROTTLE_MS) {
        rt.lastDataGuardLogAt = now
        const detail =
          err instanceof Error ? err.message : 'Upstream market feed offline'
        const guardLog: BotEngineLog = {
          id: now,
          timestamp: new Date(now).toISOString(),
          level: 'risk',
          message: `[DATA GUARD] ${detail} — blocking evaluation until live market data resumes.`,
        }
        rt.engineState = {
          ...rt.engineState,
          logs: [guardLog, ...rt.engineState.logs].slice(0, 80),
        }
        saveStateToDisk(tenantId)
      }
      broadcastSseUpdate(tenantId)
      return
    }

    const nowMs = Date.now()
    let predictionQuote: ExecutablePredictionQuote | null = null
    if (rt.activePreset.domain === 'prediction-market') {
      const fetched = await resolvePredictionQuoteForPreset(
        rt.activePreset,
        nowMs,
      )
      predictionQuote = fetched.quote
      rt.lastQuote = fetched.quote
      rt.lastQuoteError = fetched.error
    } else {
      rt.lastQuote = null
      rt.lastQuoteError = null
    }

    const prevTime = rt.engineState.lastProcessedCandleTime
    const prevOpenEntryTime = rt.engineState.openPosition?.entryTime ?? null
    const prevClosedCount = rt.engineState.closedTrades.length

    rt.engineState = trimBotEngineHistory(
      stepBotEngine(rt.engineState, candles, rt.activePreset, {
        nowMs,
        predictionQuote,
        requireExecutableQuote: true,
      }),
      {
        maxClosedTrades: MAX_RUNTIME_HISTORY_ITEMS,
        maxResolvedTickets: MAX_RUNTIME_HISTORY_ITEMS,
      },
    )

    const exchangeSnap = getExchangeStatusSnapshot(tenantId)
    if (exchangeSnap.autoMirrorBotOrders && !exchangeSnap.killSwitchActive) {
      const newPos = rt.engineState.openPosition
      if (newPos && newPos.entryTime !== prevOpenEntryTime) {
        const orderRes = await submitExchangeOrder({
          tenantId,
          pair: newPos.pair,
          side: newPos.side === 'buy' ? 'BUY' : 'SELL',
          notionalUsd: Math.min(
            newPos.notional,
            exchangeSnap.hardLimits.maxOrderNotionalUsd,
          ),
          referencePrice: newPos.entryPrice,
          source: 'bot-auto',
          clientOrderId: `bot-open-${rt.activePreset.id}-${newPos.entryTime}`,
        })
        const mirrorLog: BotEngineLog = {
          id: Date.now(),
          timestamp: new Date().toISOString(),
          level: orderRes.ok ? 'trade' : 'risk',
          message: orderRes.ok
            ? `[BROKER AUTO-MIRROR] ${orderRes.order.side} ${orderRes.order.pair} $${orderRes.order.notionalUsd.toFixed(2)} USD (${orderRes.order.mode})`
            : `[BROKER BLOCKED] ${orderRes.error}`,
        }
        rt.engineState = {
          ...rt.engineState,
          logs: [mirrorLog, ...rt.engineState.logs].slice(0, 80),
        }
      } else if (rt.engineState.closedTrades.length > prevClosedCount) {
        const closed = rt.engineState.closedTrades[0]
        if (closed) {
          await submitExchangeOrder({
            tenantId,
            pair: closed.pair,
            side: closed.side === 'buy' ? 'SELL' : 'BUY',
            notionalUsd: Math.min(
              closed.size,
              exchangeSnap.hardLimits.maxOrderNotionalUsd,
            ),
            referencePrice: closed.exitPrice,
            realizedPnlUsd: closed.pnl,
            source: 'bot-auto',
            clientOrderId: `bot-close-${rt.activePreset.id}-${closed.id}-${closed.exitTime}`,
          })
        }
      }
    }

    rt.tickCount += 1
    rt.lastTickAt = new Date().toISOString()
    rt.lastTickLatencyMs = Math.max(latencyMs, Date.now() - tickStart)

    if (
      rt.engineState.lastProcessedCandleTime !== prevTime ||
      options?.forceExecution
    ) {
      saveStateToDisk(tenantId)
    }

    broadcastSseUpdate(tenantId)
  } catch (error) {
    console.error(`[FLARE Backend] Bot tick error (${tenantId}):`, error)
  } finally {
    rt.tickInProgress = false
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
  for (const tenantId of tenantRuntimes.keys()) {
    flushStateToDiskSync(undefined, tenantId)
  }
}

export async function shutdownRuntime(): Promise<void> {
  stopBackgroundWorker()
  await flushStatePersistence()
  getMarketGateway().closeAll()
  await closeStateStore()
}

export function resetAllTenantRuntimes(): void {
  for (const rt of tenantRuntimes.values()) {
    for (const client of rt.sseClients) {
      try {
        client.end()
      } catch {
        // Ignore close errors
      }
    }
    rt.sseClients.clear()
  }
  tenantRuntimes.clear()
}

export function ensureBackgroundWorker(): void {
  if (moduleWorkerStarted) return
  moduleWorkerStarted = true

  const globals = getRuntimeGlobals()
  if (globals.pollTimer) clearInterval(globals.pollTimer)
  if (globals.keepaliveTimer) clearInterval(globals.keepaliveTimer)

  const pollTimer = setInterval(() => {
    for (const [tenantId, rt] of tenantRuntimes) {
      if (rt.isRunning) {
        void tickBot(tenantId)
      }
    }
  }, POLL_INTERVAL_MS)
  pollTimer.unref?.()
  globals.pollTimer = pollTimer

  const keepaliveTimer = setInterval(() => {
    for (const rt of tenantRuntimes.values()) {
      for (const client of Array.from(rt.sseClients)) {
        writeSseFrame(client, ': keepalive\n\n', rt.sseClients)
      }
    }
    for (const client of Array.from(marketSseClients)) {
      writeSseFrame(client, ': keepalive\n\n', marketSseClients)
    }
  }, SSE_KEEPALIVE_MS)
  keepaliveTimer.unref?.()
  globals.keepaliveTimer = keepaliveTimer
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(payload === null ? undefined : JSON.stringify(payload))
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
  corsHeaders: Record<string, string>,
): Promise<{ ok: true; data: T | null } | { ok: false }> {
  try {
    const data = await readJsonBody<T>(req)
    return { ok: true, data }
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendJson(res, 413, { error: error.message }, corsHeaders)
      return { ok: false }
    }
    if (error instanceof InvalidJsonBodyError) {
      sendJson(res, 400, { error: error.message }, corsHeaders)
      return { ok: false }
    }
    sendJson(res, 400, { error: 'Failed to read request body' }, corsHeaders)
    return { ok: false }
  }
}

function enforcePermission(
  principal: AuthPrincipal,
  permission: Permission,
  res: http.ServerResponse,
  headers: Record<string, string>,
  resource: string,
): boolean {
  const check = authorizePermission(principal, permission)
  if (!check.ok) {
    recordAudit(principal, 'rbac:denied', resource, 'denied', {
      requiredPermission: permission,
    })
    sendJson(res, check.status, { error: check.error }, headers)
    return false
  }
  return true
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

  const cors = resolveCorsHeaders(req)

  if (req.method === 'OPTIONS') {
    if (!cors.allowed) {
      sendJson(res, 403, { error: 'CORS origin not allowed' }, cors.headers)
      return true
    }
    sendJson(res, 204, null, cors.headers)
    return true
  }

  const url = new URL(rawUrl, 'http://localhost')

  // 1. GET /api/health -> Public liveness + authenticated tenant diagnostics
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const auth = authenticateRequest(req, url)
    if (!auth.ok) {
      sendJson(
        res,
        200,
        {
          status: 'ok',
          storeDriver: getStateStore().driver,
          sharedStateBackend: getSharedStateAdapter().backend,
          marketGateway: getMarketGateway().getMetrics(),
        },
        cors.headers,
      )
      return true
    }
    const tenantId = auth.principal.tenantId
    const rt = getTenantRuntime(tenantId)
    sendJson(
      res,
      200,
      {
        status: 'ok',
        tenantId,
        running: rt.isRunning,
        activePresetId: rt.activePreset.id,
        telemetry: getTelemetry(tenantId),
        exchange: getExchangeStatusSnapshot(tenantId),
      },
      cors.headers,
    )
    return true
  }

  // Authenticate all non-health API requests (`P0-3`)
  const auth = authenticateRequest(req, url)
  if (!auth.ok) {
    sendJson(res, auth.status, { error: auth.error }, cors.headers)
    return true
  }
  const principal = auth.principal
  const tenantId = principal.tenantId

  // Enforce per-principal sliding-window rate limits (`P0-3`)
  const bucket = req.method === 'POST' ? 'write' : 'read'
  const rl = await checkRateLimit(req, principal, bucket)
  const responseHeaders: Record<string, string> = {
    ...cors.headers,
    'X-RateLimit-Limit': String(rl.limit),
    'X-RateLimit-Remaining': String(rl.remaining),
    'X-Tenant-Id': tenantId,
  }
  if (!rl.allowed) {
    recordAudit(principal, 'rate_limit:exceeded', url.pathname, 'denied', {
      bucket,
      limit: rl.limit,
    })
    sendJson(
      res,
      429,
      {
        error: `Rate limit exceeded (${rl.limit} ${bucket} req/min). Retry in ${rl.retryAfterSec}s.`,
      },
      {
        ...responseHeaders,
        'Retry-After': String(rl.retryAfterSec),
      },
    )
    return true
  }

  const rt = getTenantRuntime(tenantId)

  // 2. GET /api/bot/status -> Tenant-scoped bot status, telemetry, demo exchange, and MT5 bridge
  if (req.method === 'GET' && url.pathname === '/api/bot/status') {
    if (
      !enforcePermission(
        principal,
        'read:state',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    sendJson(res, 200, getBotStatusSnapshot(tenantId), responseHeaders)
    return true
  }

  // 3. GET /api/bot/stream -> Tenant-scoped real-time SSE (`snapshot` + `delta` frames)
  if (req.method === 'GET' && url.pathname === '/api/bot/stream') {
    if (
      !enforcePermission(
        principal,
        'read:state',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      ...responseHeaders,
    })
    rt.sseClients.add(res)
    rt.sseSeq += 1
    writeSseFrame(
      res,
      `id: ${rt.sseSeq}\ndata: ${JSON.stringify(getBotStatusSnapshot(tenantId))}\n\n`,
      rt.sseClients,
    )

    const cleanupClient = () => {
      rt.sseClients.delete(res)
    }
    req.on('close', cleanupClient)
    res.on('close', cleanupClient)
    res.on('error', cleanupClient)
    return true
  }

  // 3b. GET /api/market/candles -> Shared backend market-data gateway REST endpoint (`P1-1`)
  if (req.method === 'GET' && url.pathname === '/api/market/candles') {
    if (
      !enforcePermission(
        principal,
        'read:state',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    const rawPair = (url.searchParams.get('pair') ?? 'BTC/USDT').toUpperCase()
    const pair = availablePairs.includes(rawPair) ? rawPair : 'BTC/USDT'
    const rawInterval = (url.searchParams.get('interval') ?? '15m') as Interval
    const interval: Interval = VALID_INTERVALS.has(rawInterval)
      ? rawInterval
      : '15m'
    const limit = Number(url.searchParams.get('limit') ?? 250)
    const forceRefresh = url.searchParams.get('refresh') === 'true'
    try {
      const result = await getMarketGateway().getCandles(
        pair,
        interval,
        Number.isFinite(limit) ? limit : 250,
        { forceRefresh },
      )
      sendJson(
        res,
        200,
        {
          pair,
          interval,
          ...result,
        },
        responseHeaders,
      )
    } catch (err) {
      const status = err instanceof UpstreamMarketDataError ? 503 : 502
      sendJson(
        res,
        status,
        { error: err instanceof Error ? err.message : String(err) },
        responseHeaders,
      )
    }
    return true
  }

  // 3c. GET /api/market/stream -> Shared server-side market-data SSE fanout (`P1-1`)
  if (req.method === 'GET' && url.pathname === '/api/market/stream') {
    if (
      !enforcePermission(
        principal,
        'read:state',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    const rawPair = (url.searchParams.get('pair') ?? 'BTC/USDT').toUpperCase()
    const pair = availablePairs.includes(rawPair) ? rawPair : 'BTC/USDT'
    const rawInterval = (url.searchParams.get('interval') ?? '15m') as Interval
    const interval: Interval = VALID_INTERVALS.has(rawInterval)
      ? rawInterval
      : '15m'
    const limit = Number(url.searchParams.get('limit') ?? 200)

    let initial
    try {
      initial = await getMarketGateway().getCandles(
        pair,
        interval,
        Number.isFinite(limit) ? limit : 200,
      )
    } catch (err) {
      const status = err instanceof UpstreamMarketDataError ? 503 : 502
      sendJson(
        res,
        status,
        { error: err instanceof Error ? err.message : String(err) },
        responseHeaders,
      )
      return true
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      ...responseHeaders,
    })

    marketSseClients.add(res)
    writeSseFrame(
      res,
      `data: ${JSON.stringify({
        type: 'snapshot',
        pair,
        interval,
        source: initial.source,
        candles: initial.candles,
        status: 'live',
      })}\n\n`,
      marketSseClients,
    )

    const unsubscribe = getMarketGateway().subscribe(
      pair,
      interval,
      (event) => {
        writeSseFrame(
          res,
          `data: ${JSON.stringify(event)}\n\n`,
          marketSseClients,
        )
      },
    )

    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      marketSseClients.delete(res)
      unsubscribe()
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
    return true
  }

  // 4. GET /api/bot/accuracy -> Parallel accuracy audit across 1 or all 8 presets
  if (req.method === 'GET' && url.pathname === '/api/bot/accuracy') {
    if (
      !enforcePermission(
        principal,
        'run:research',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    const evaluateAll = url.searchParams.get('all') === 'true'
    const targetPresets = evaluateAll ? STRATEGY_PRESETS : [rt.activePreset]

    try {
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

      sendJson(
        res,
        200,
        {
          evaluatedAt: new Date().toISOString(),
          candleSampleSize: CANDLE_LOOKBACK_LIMIT,
          telemetry: getTelemetry(tenantId),
          reports,
        },
        responseHeaders,
      )
    } catch (err) {
      const status = err instanceof UpstreamMarketDataError ? 503 : 502
      sendJson(
        res,
        status,
        { error: err instanceof Error ? err.message : String(err) },
        responseHeaders,
      )
    }
    return true
  }

  // 5. GET /api/predictions/accuracy?timeframe=15m
  if (req.method === 'GET' && url.pathname === '/api/predictions/accuracy') {
    if (
      !enforcePermission(
        principal,
        'run:research',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    const tf = (url.searchParams.get('timeframe') ?? '15m') as Interval
    try {
      const { candles, source, latencyMs } = await fetchOptimizedCandles(
        'BTC/USDT',
        tf,
        CANDLE_LOOKBACK_LIMIT,
      )
      const rules = evaluateTimeframePredictions(tf, candles)

      sendJson(
        res,
        200,
        {
          evaluatedAt: new Date().toISOString(),
          timeframe: tf,
          dataSource: source,
          fetchLatencyMs: latencyMs,
          candleSampleSize: candles.length,
          rules,
        },
        responseHeaders,
      )
    } catch (err) {
      const status = err instanceof UpstreamMarketDataError ? 503 : 502
      sendJson(
        res,
        status,
        { error: err instanceof Error ? err.message : String(err) },
        responseHeaders,
      )
    }
    return true
  }

  // 5b. GET /api/predictions/polymarket?tf=15m&limit=48
  if (req.method === 'GET' && url.pathname === '/api/predictions/polymarket') {
    if (
      !enforcePermission(
        principal,
        'run:research',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    const tfParam = url.searchParams.get('tf')
    const tf: PolymarketTimeframe = tfParam === '5m' ? '5m' : '15m'
    const limit = Number(url.searchParams.get('limit') ?? 48)
    try {
      const snapshot = await fetchPolymarketUpDown(
        tf,
        Number.isFinite(limit) ? limit : 48,
      )
      sendJson(res, 200, snapshot, responseHeaders)
    } catch (err) {
      sendJson(
        res,
        502,
        { error: err instanceof Error ? err.message : String(err) },
        responseHeaders,
      )
    }
    return true
  }

  // 6. POST /api/bot/start
  if (req.method === 'POST' && url.pathname === '/api/bot/start') {
    if (
      !enforcePermission(
        principal,
        'trade:execute',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    if (getExchangeStatusSnapshot(tenantId).killSwitchActive) {
      sendJson(
        res,
        423,
        {
          error:
            'Emergency Kill-Switch is active. Reset the exchange Kill-Switch before starting the bot.',
          snapshot: getBotStatusSnapshot(tenantId),
        },
        responseHeaders,
      )
      return true
    }

    const body = await readOptionalJsonBody<{
      presetId?: string
      strategy?: Strategy
    }>(req, res, responseHeaders)
    if (!body.ok) return true
    const parsed = body.data

    if (parsed?.presetId) {
      const found = STRATEGY_PRESETS.find((p) => p.id === parsed.presetId)
      if (found && found.id !== rt.activePreset.id) {
        rt.activePreset = found
        rt.engineState = createInitialBotState(rt.activePreset)
      }
    }

    if (parsed?.strategy && isStrategy(parsed.strategy)) {
      rt.activePreset = {
        ...rt.activePreset,
        strategy: parsed.strategy,
      }
      rt.engineState = {
        ...rt.engineState,
        pair: parsed.strategy.pair,
      }
    }

    rt.isRunning = true
    await tickBot(tenantId, { forceExecution: true })
    saveStateToDisk(tenantId)
    recordAudit(principal, 'bot:start', url.pathname, 'allowed', {
      presetId: rt.activePreset.id,
    })
    broadcastSseUpdate(tenantId)
    sendJson(res, 200, getBotStatusSnapshot(tenantId), responseHeaders)
    return true
  }

  // 7. POST /api/bot/stop
  if (req.method === 'POST' && url.pathname === '/api/bot/stop') {
    if (
      !enforcePermission(
        principal,
        'trade:execute',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    rt.isRunning = false
    saveStateToDisk(tenantId)
    recordAudit(principal, 'bot:stop', url.pathname, 'allowed')
    broadcastSseUpdate(tenantId)
    sendJson(res, 200, getBotStatusSnapshot(tenantId), responseHeaders)
    return true
  }

  // 8. POST /api/bot/reset
  if (req.method === 'POST' && url.pathname === '/api/bot/reset') {
    if (
      !enforcePermission(
        principal,
        'trade:execute',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    rt.isRunning = false
    rt.engineState = createInitialBotState(rt.activePreset)
    saveStateToDisk(tenantId)
    recordAudit(principal, 'bot:reset', url.pathname, 'allowed', {
      presetId: rt.activePreset.id,
    })
    broadcastSseUpdate(tenantId)
    sendJson(res, 200, getBotStatusSnapshot(tenantId), responseHeaders)
    return true
  }

  // 9. POST /api/bot/preset
  if (req.method === 'POST' && url.pathname === '/api/bot/preset') {
    if (
      !enforcePermission(
        principal,
        'trade:execute',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    const body = await readOptionalJsonBody<{
      presetId?: string
      strategy?: Strategy
      timeframe?: Interval
      reset?: boolean
    }>(req, res, responseHeaders)
    if (!body.ok) return true
    const parsed = body.data

    if (parsed?.presetId) {
      const found = STRATEGY_PRESETS.find((p) => p.id === parsed.presetId)
      if (found && (found.id !== rt.activePreset.id || parsed.reset === true)) {
        rt.activePreset = found
        rt.engineState = createInitialBotState(rt.activePreset)
      }
    }

    if (parsed?.strategy && isStrategy(parsed.strategy)) {
      rt.activePreset = {
        ...rt.activePreset,
        strategy: parsed.strategy,
        timeframe: parsed.timeframe ?? rt.activePreset.timeframe,
      }
      rt.engineState = {
        ...rt.engineState,
        pair: parsed.strategy.pair,
        timeframe: rt.activePreset.timeframe,
      }
    }

    saveStateToDisk(tenantId)
    recordAudit(principal, 'bot:preset', url.pathname, 'allowed', {
      presetId: rt.activePreset.id,
      pair: rt.activePreset.strategy.pair,
    })
    broadcastSseUpdate(tenantId)
    sendJson(res, 200, getBotStatusSnapshot(tenantId), responseHeaders)
    return true
  }

  // 10. POST /api/bot/tick
  if (req.method === 'POST' && url.pathname === '/api/bot/tick') {
    if (
      !enforcePermission(
        principal,
        'trade:execute',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    await tickBot(tenantId, { forceExecution: true, forceCandleRefresh: true })
    saveStateToDisk(tenantId)
    sendJson(res, 200, getBotStatusSnapshot(tenantId), responseHeaders)
    return true
  }

  // ============================================================================
  // Exchange Adapter, Ledger & Audit Endpoints
  // ============================================================================

  // 11. GET /api/exchange/status
  if (req.method === 'GET' && url.pathname === '/api/exchange/status') {
    if (
      !enforcePermission(
        principal,
        'read:state',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    sendJson(res, 200, getExchangeStatusSnapshot(tenantId), responseHeaders)
    return true
  }

  // 11b. GET /api/ledger -> Tenant-scoped double-entry accounting ledger (`P0-4` / `P1-4`)
  if (req.method === 'GET' && url.pathname === '/api/ledger') {
    if (
      !enforcePermission(
        principal,
        'ledger:read',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    const ledger = getTenantLedgerSnapshot(tenantId)
    const persistedOrders = await getStateStore().getOrders(tenantId, 100)
    sendJson(
      res,
      200,
      {
        ...ledger,
        persistedOrderCount: persistedOrders.length,
        storeDriver: getStateStore().driver,
      },
      responseHeaders,
    )
    return true
  }

  // 11c. GET /api/audit -> Tenant-scoped immutable audit trail (`P0-3`)
  if (req.method === 'GET' && url.pathname === '/api/audit') {
    if (
      !enforcePermission(
        principal,
        'audit:read',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    const limit = Number(url.searchParams.get('limit') ?? 100)
    const events = await getStateStore().getAuditEvents(
      tenantId,
      Number.isFinite(limit) ? limit : 100,
    )
    sendJson(res, 200, { tenantId, events }, responseHeaders)
    return true
  }

  // 11d. POST /api/admin/retention -> Prunes expired records beyond retention window (`P0-4`)
  if (req.method === 'POST' && url.pathname === '/api/admin/retention') {
    if (
      !enforcePermission(
        principal,
        'admin:manage',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    const body = await readOptionalJsonBody<{ retentionDays?: number }>(
      req,
      res,
      responseHeaders,
    )
    if (!body.ok) return true
    const report = await getStateStore().pruneRetention(
      body.data?.retentionDays ?? 90,
    )
    recordAudit(principal, 'admin:retention', url.pathname, 'allowed', {
      retentionDays: report.retentionDays,
      deletedOrders: report.deletedOrders,
      deletedAuditEvents: report.deletedAuditEvents,
      deletedCandles: report.deletedCandles,
    })
    sendJson(res, 200, report, responseHeaders)
    return true
  }

  // 12. POST /api/exchange/order
  if (req.method === 'POST' && url.pathname === '/api/exchange/order') {
    if (
      !enforcePermission(
        principal,
        'trade:execute',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    const body = await readOptionalJsonBody<{
      pair?: string
      side?: 'BUY' | 'SELL'
      notionalUsd?: number
      referencePrice?: number
      clientOrderId?: string
    }>(req, res, responseHeaders)
    if (!body.ok) return true
    const parsed = body.data

    const pair = parsed?.pair ?? rt.activePreset.strategy.pair
    const side = parsed?.side === 'SELL' ? 'SELL' : 'BUY'
    const notionalUsd = Number(parsed?.notionalUsd ?? 100)

    const result = await submitExchangeOrder({
      tenantId,
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

    rt.engineState = {
      ...rt.engineState,
      logs: [newLog, ...rt.engineState.logs].slice(0, 80),
    }
    saveStateToDisk(tenantId)
    recordAudit(
      principal,
      'exchange:order',
      url.pathname,
      result.ok ? 'allowed' : 'denied',
      {
        orderId: result.order.id,
        pair,
        side,
        notionalUsd,
        status: result.order.status,
      },
    )
    broadcastSseUpdate(tenantId)

    sendJson(
      res,
      200,
      {
        ...result,
        bot: getBotStatusSnapshot(tenantId),
      },
      responseHeaders,
    )
    return true
  }

  // 13. POST /api/exchange/limits
  if (req.method === 'POST' && url.pathname === '/api/exchange/limits') {
    if (
      !enforcePermission(
        principal,
        'risk:manage',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    const body = await readOptionalJsonBody<
      Partial<HardRiskLimits> & { autoMirrorBotOrders?: boolean }
    >(req, res, responseHeaders)
    if (!body.ok) return true
    const parsed = body.data

    if (parsed) {
      updateHardRiskLimits(parsed, tenantId)
      if (typeof parsed.autoMirrorBotOrders === 'boolean') {
        setExchangeAutoMirror(parsed.autoMirrorBotOrders, tenantId)
      }
      saveStateToDisk(tenantId)
      recordAudit(principal, 'risk:limits', url.pathname, 'allowed', {
        maxOrderNotionalUsd: parsed.maxOrderNotionalUsd ?? null,
        maxDailyLossUsd: parsed.maxDailyLossUsd ?? null,
        maxDailyOrders: parsed.maxDailyOrders ?? null,
      })
    }

    broadcastSseUpdate(tenantId)
    sendJson(res, 200, getBotStatusSnapshot(tenantId), responseHeaders)
    return true
  }

  // 14. POST /api/exchange/kill-switch
  if (req.method === 'POST' && url.pathname === '/api/exchange/kill-switch') {
    const body = await readOptionalJsonBody<{
      action?: 'engage' | 'reset'
      reason?: string
    }>(req, res, responseHeaders)
    if (!body.ok) return true
    const parsed = body.data
    const isReset = parsed?.action === 'reset'

    if (
      !enforcePermission(
        principal,
        isReset ? 'risk:manage' : 'risk:engage_killswitch',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }

    if (isReset) {
      resetEmergencyKillSwitch(tenantId)
      const rearmLog: BotEngineLog = {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        level: 'info',
        message: 'Emergency Kill-Switch reset by operator. System ready.',
      }
      rt.engineState = {
        ...rt.engineState,
        logs: [rearmLog, ...rt.engineState.logs].slice(0, 80),
      }
      recordAudit(principal, 'risk:killswitch_reset', url.pathname, 'allowed')
    } else {
      const reason = parsed?.reason ?? 'Emergency stop triggered by operator'
      await triggerEmergencyKillSwitch(
        reason,
        () => {
          rt.isRunning = false
          const killLog: BotEngineLog = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            level: 'risk',
            message: `KILL-SWITCH TRIGGERED: ${reason}. Bot stopped, orders canceled, and positions closed.`,
          }
          rt.engineState = {
            ...rt.engineState,
            openPosition: null,
            activeTickets: [],
            logs: [killLog, ...rt.engineState.logs].slice(0, 80),
          }
        },
        tenantId,
      )
      recordAudit(principal, 'risk:killswitch_engage', url.pathname, 'allowed', {
        reason,
      })
    }

    saveStateToDisk(tenantId)
    broadcastSseUpdate(tenantId)
    sendJson(res, 200, getBotStatusSnapshot(tenantId), responseHeaders)
    return true
  }

  // 15. POST /api/exchange/reset
  if (req.method === 'POST' && url.pathname === '/api/exchange/reset') {
    if (
      !enforcePermission(
        principal,
        'trade:execute',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    resetExchangeDemoVault(tenantId)
    saveStateToDisk(tenantId)
    recordAudit(principal, 'exchange:reset', url.pathname, 'allowed')
    broadcastSseUpdate(tenantId)
    sendJson(res, 200, getBotStatusSnapshot(tenantId), responseHeaders)
    return true
  }

  // ============================================================================
  // MetaTrader 5 Bridge Endpoints (MQL5 Expert Advisor)
  // ============================================================================

  // 16. GET /api/mt5/signal
  if (req.method === 'GET' && url.pathname === '/api/mt5/signal') {
    if (
      !enforcePermission(
        principal,
        'read:state',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    const terminal = url.searchParams.get('terminal') ?? 'MT5-ExpertAdvisor'
    const symbol = url.searchParams.get('symbol')
    const packet = registerMt5Poll(
      rt.engineState,
      rt.activePreset,
      getExchangeStatusSnapshot(tenantId),
      { terminal, symbol },
    )
    const globals = getRuntimeGlobals()
    const terminalKey = `${tenantId}|${terminal}|${symbol ?? ''}|${packet.action}`
    const now = Date.now()
    const changed = terminalKey !== globals.lastMt5TerminalKey
    const intervalElapsed =
      globals.lastMt5SseBroadcastAt === undefined ||
      now - globals.lastMt5SseBroadcastAt >= MT5_SSE_MIN_INTERVAL_MS
    if (changed || intervalElapsed) {
      globals.lastMt5TerminalKey = terminalKey
      globals.lastMt5SseBroadcastAt = now
      broadcastSseUpdate(tenantId)
    }
    sendJson(res, 200, packet, responseHeaders)
    return true
  }

  // 17. POST /api/mt5/simulate-ping
  if (req.method === 'POST' && url.pathname === '/api/mt5/simulate-ping') {
    if (
      !enforcePermission(
        principal,
        'trade:execute',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    const packet = registerMt5Poll(
      rt.engineState,
      rt.activePreset,
      getExchangeStatusSnapshot(tenantId),
      {
        terminal: 'MT5-Terminal-Demo',
        symbol: rt.activePreset.strategy.pair.replace('/USDT', 'USD'),
      },
    )
    const mt5Log: BotEngineLog = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      level: 'signal',
      message: `[MT5 BRIDGE] Poll received from ${packet.symbol} (Magic #${packet.magicNumber}) -> Action: ${packet.action} (${packet.signalId})`,
    }
    rt.engineState = {
      ...rt.engineState,
      logs: [mt5Log, ...rt.engineState.logs].slice(0, 80),
    }
    saveStateToDisk(tenantId)
    broadcastSseUpdate(tenantId)
    sendJson(
      res,
      200,
      {
        packet,
        bot: getBotStatusSnapshot(tenantId),
      },
      responseHeaders,
    )
    return true
  }

  sendJson(res, 404, { error: 'API route not found' }, responseHeaders)
  return true
}
