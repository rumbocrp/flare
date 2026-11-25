import crypto from 'node:crypto'
import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import {
  STRATEGY_PRESETS,
  closePaperPositionAtPrice,
  createInitialBotState,
  evaluateBotPresetAccuracy,
  mergePresetPatch,
  normalizeBotEngineState,
  resolvePresetPredictionRule,
  stepBotEngine,
  trimBotEngineHistory,
  type BotEngineState,
  type StrategyPreset,
  type StrategyPresetPatch,
} from '../botEngine'
import { computeClosedTradesSummary } from '../botRunUtils'
import { intervalMs } from '../market/intervals'
import {
  buildQuoteFromPolymarketWindow,
  pickBestOpenPolymarketWindow,
  type ExecutablePredictionQuote,
} from '../market/quoteService'
import { computeMetrics } from '../metrics'
import {
  PREDICTION_ENGINE_STRATEGY_IDS,
  type CanaryRiskConfig,
  type MacroBlackoutWindow,
  type PredictionEngineStrategyId,
  type PromotionTransitionResult,
  type StrategyLifecycleMode,
} from '../prediction/engine/types'
import {
  computeWilsonLowerBoundPct,
  evaluateTimeframePredictions,
} from '../predictions'
import { availablePairs, isStrategy } from '../strategy'
import { computeCanonicalTrainingMetrics } from '../training/runner'
import {
  ENGINE_TEMPLATES,
  getStrategyFamily,
} from '../training/strategyRegistry'
import type {
  TrainingAssumptions,
  TrainingConfig,
  TrainingEquityPoint,
  TrainingFoldResult,
  TrainingLiveShadowResponse,
  TrainingProgress,
  TrainingRunKind,
  TrainingRunMetrics,
  TrainingRunRecord,
  TrainingRunStatus,
  TrainingTradeRecord,
} from '../training/types'
import type { Interval, Strategy } from '../types'
import {
  dispatchRuntimeAlert,
  getAlertDispatcherStatus,
} from './alertDispatcher'
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
  fetchHistoricalCandles,
  fetchOptimizedCandles,
  getCacheMetrics,
  MAX_HISTORY_BARS,
  UpstreamMarketDataError,
  type ServerCacheMetrics,
} from './candleCache'
import {
  cancelExchangeOrder,
  closeBotOwnedTestnetPosition,
  exportExchangeState,
  fetchExchangeAccount,
  fundPaperAccount,
  getExchangeStatusSnapshot,
  getTenantLedgerSnapshot,
  reconcileExchangeVenue,
  resetEmergencyKillSwitch,
  restoreExchangeState,
  setExchangeAutoMirror,
  submitExchangeOrder,
  triggerEmergencyKillSwitch,
  updateHardRiskLimits,
  validateHardRiskLimitsUpdate,
  type HardRiskLimits,
  type PersistedExchangeState,
} from './exchangeAdapter'
import {
  getMarketGateway,
  type MarketGatewayMetrics,
} from './marketData/marketGateway'
import {
  getMt5BridgeSnapshot,
  markMt5ClosePending,
  recordMt5Ack,
  registerMt5Poll,
  type Mt5AckStatus,
  type Mt5Action,
  type Mt5ReportedPosition,
} from './mt5Bridge'
import {
  fetchPolymarketUpDown,
  type PolymarketTimeframe,
} from './polymarketAdapter'
import {
  cancelAllPolymarketOrders,
  cancelPolymarketOrder,
  getPolymarketExecutorStatus,
  isPolymarketLiveArmed,
  reconcilePolymarketAccount,
  submitPolymarketOrder,
  type PolymarketExecutionSide,
  type PolymarketOrderType,
} from './polymarketExecutor'
import {
  closeStateStore,
  getStateStore,
  SqliteStateStore,
  type AuditEventRecord,
  type PersistedTenantEnvelope,
  type RuntimeEventRecord,
  type RuntimeEventSeverity,
  type RuntimeEventType,
  type StoredStrategyState,
  type StrategyAuditRecord,
} from './store'
import { resetClobBookFeed } from './prediction/clobBookFeed'
import { getOracleFeed, stopOracleFeedIfActive } from './prediction/oracleFeed'
import {
  getPredictionRunner,
  stopPredictionRunnerIfActive,
} from './prediction/predictionRunner'

const POLL_INTERVAL_MS = 15_000
const SSE_KEEPALIVE_MS = 25_000
const SSE_MAX_BUFFERED_BYTES = 512 * 1024
const MT5_SSE_MIN_INTERVAL_MS = 15_000
const DATA_GUARD_LOG_THROTTLE_MS = 300_000
const MAX_BODY_BYTES = 64 * 1024
const MAX_TRAINING_BODY_BYTES = 4 * 1024 * 1024
const MAX_RUNTIME_HISTORY_ITEMS = 500
const CANDLE_LOOKBACK_LIMIT = 500
const CURRENT_STATE_SCHEMA_VERSION = 2
const DEFAULT_TENANT_ID = 'default'
const VALID_INTERVALS = new Set<Interval>(['5m', '15m', '1h', '4h', '1d'])
const VALID_TRAINING_KINDS = new Set<TrainingRunKind>([
  'walk-forward',
  'meta-filter',
  'prediction-market',
])
const VALID_TRAINING_STATUSES = new Set<TrainingRunStatus>([
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])
const TRAINING_METRIC_TOLERANCE = 1e-6

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
  customPreset?: StrategyPreset
  isRunning?: boolean
  isPaused?: boolean
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
  isPaused: boolean
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
    isPaused: false,
    activePreset: preset,
    engineState: createInitialBotState(preset, {
      initialBalance: 0,
      seedLog: false,
    }),
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
    const found =
      STRATEGY_PRESETS.find((p) => p.id === parsed.presetId) ?? rt.activePreset
    if (parsed.customPreset && typeof parsed.customPreset === 'object') {
      rt.activePreset = mergePresetPatch(found, parsed.customPreset)
    } else if (parsed.customStrategy && isStrategy(parsed.customStrategy)) {
      rt.activePreset = {
        ...found,
        strategy: parsed.customStrategy,
      }
    } else {
      rt.activePreset = found
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
    rt.isPaused =
      !rt.isRunning &&
      Boolean(parsed.isPaused) &&
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
    customPreset: rt.activePreset,
    isRunning: rt.isRunning,
    isPaused: rt.isPaused,
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

function recordRuntimeEvent(
  tenantId: string,
  params: {
    type: RuntimeEventType
    severity: RuntimeEventSeverity
    message: string
    source: string
    correlationId?: string | null
    payload?: Record<string, unknown> | null
    timestamp?: string
  },
): RuntimeEventRecord {
  const event: RuntimeEventRecord = {
    id: `EVT-${crypto.randomUUID()}`,
    tenantId,
    timestamp: params.timestamp ?? new Date().toISOString(),
    type: params.type,
    severity: params.severity,
    message: params.message,
    source: params.source,
    correlationId: params.correlationId ?? null,
    payload: params.payload ?? null,
  }
  void getStateStore()
    .appendRuntimeEvent(event)
    .catch(() => { })
  void dispatchRuntimeAlert(event).catch(() => {})
  return event
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
    paused: rt.isPaused,
    accountMode: exchange.mode,
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
    paused: rt.isPaused,
    accountMode: exchange.mode,
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
  const hasOpenExposure =
    rt.engineState.openPosition !== null ||
    rt.engineState.activeTickets.length > 0
  const shouldTick =
    rt.isRunning ||
    (rt.isPaused && hasOpenExposure) ||
    Boolean(options?.forceExecution)
  if (!shouldTick) return
  if (getExchangeStatusSnapshot(tenantId).killSwitchActive) {
    rt.isRunning = false
    rt.isPaused = false
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
        recordRuntimeEvent(tenantId, {
          type: 'ERROR',
          severity: 'error',
          source: 'market-gateway',
          message: `[RISK] ${detail} — blocking evaluation until live market data resumes.`,
        })
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
    const prevBreakevenArmed = Boolean(rt.engineState.openPosition?.breakevenArmed)
    const prevDayHalted = rt.engineState.dayHalted
    const prevClosedCount = rt.engineState.closedTrades.length
    const prevActiveTicketIds = new Set(
      rt.engineState.activeTickets.map((t) => t.id),
    )

    rt.engineState = trimBotEngineHistory(
      stepBotEngine(rt.engineState, candles, rt.activePreset, {
        nowMs,
        predictionQuote,
        requireExecutableQuote: true,
        allowNewEntries: !rt.isPaused,
      }),
      {
        maxClosedTrades: MAX_RUNTIME_HISTORY_ITEMS,
        maxResolvedTickets: MAX_RUNTIME_HISTORY_ITEMS,
      },
    )

    const newPos = rt.engineState.openPosition
    if (newPos && newPos.entryTime !== prevOpenEntryTime) {
      recordRuntimeEvent(tenantId, {
        type: 'SIGNAL',
        severity: 'info',
        source: 'bot-engine',
        message: `[SIGNAL] Opened ${newPos.side.toUpperCase()} ${newPos.pair} @ $${newPos.entryPrice.toFixed(2)} (SL $${newPos.stopPrice.toFixed(2)} / TP $${newPos.targetPrice.toFixed(2)})`,
        payload: {
          presetId: rt.activePreset.id,
          pair: newPos.pair,
          side: newPos.side,
          entryPrice: newPos.entryPrice,
          stopPrice: newPos.stopPrice,
          targetPrice: newPos.targetPrice,
        },
      })
    } else if (
      newPos &&
      newPos.entryTime === prevOpenEntryTime &&
      !prevBreakevenArmed &&
      newPos.breakevenArmed
    ) {
      recordRuntimeEvent(tenantId, {
        type: 'SIGNAL',
        severity: 'info',
        source: 'bot-engine',
        message: `[SIGNAL] Profit-Lock armed on ${newPos.pair}; stop moved to $${newPos.stopPrice.toFixed(2)}.`,
      })
    }

    if (rt.engineState.closedTrades.length > prevClosedCount) {
      const closed = rt.engineState.closedTrades[0]
      if (closed) {
        recordRuntimeEvent(tenantId, {
          type: 'TRADE',
          severity: 'info',
          source: 'bot-engine',
          message: `[FILL] Closed ${closed.side.toUpperCase()} ${closed.pair} via ${closed.exitReason.toUpperCase()} @ $${closed.exitPrice.toFixed(2)} · PnL ${closed.pnl >= 0 ? '+' : ''}$${closed.pnl.toFixed(2)}`,
          payload: {
            tradeId: closed.id,
            pair: closed.pair,
            side: closed.side,
            exitReason: closed.exitReason,
            pnl: closed.pnl,
            fees: closed.fees,
          },
        })
      }
    }

    if (!prevDayHalted && rt.engineState.dayHalted) {
      recordRuntimeEvent(tenantId, {
        type: 'RISK',
        severity: 'warn',
        source: 'bot-engine',
        message: `[RISK] Daily circuit breaker tripped (${rt.activePreset.strategy.maxDailyRisk}% max daily risk). New entries halted for UTC day.`,
      })
    }

    const exchangeSnap = getExchangeStatusSnapshot(tenantId)
    if (exchangeSnap.autoMirrorBotOrders && !exchangeSnap.killSwitchActive) {
      if (
        rt.activePreset.domain === 'prediction-market' &&
        isPolymarketLiveArmed() &&
        predictionQuote
      ) {
        const openedTickets = rt.engineState.activeTickets.filter(
          (t) => !prevActiveTicketIds.has(t.id),
        )
        for (const ticket of openedTickets) {
          const polyRes = await submitPolymarketOrder({
            tenantId,
            quote: predictionQuote,
            side: 'BUY',
            stakeUsd: Math.min(
              ticket.stakeUsd,
              exchangeSnap.hardLimits.maxOrderNotionalUsd,
            ),
            orderType: 'FOK',
            clientOrderId: `poly-auto-${rt.activePreset.id}-${ticket.entryBarTime}-${ticket.id}`,
            nowMs,
            source: 'bot-auto',
          })
          recordRuntimeEvent(tenantId, {
            type: polyRes.ok ? 'TRADE' : 'RISK',
            severity: polyRes.ok ? 'info' : 'warn',
            source: 'polymarket-clob',
            correlationId: polyRes.order.id,
            message: polyRes.ok
              ? `[ORDER] Polymarket BUY ${polyRes.order.outcome} ${polyRes.order.instrumentId} $${polyRes.order.stakeUsd.toFixed(2)} @ ${(polyRes.order.limitPrice * 100).toFixed(1)}c (#${polyRes.order.venueOrderId ?? polyRes.order.id})`
              : `[RISK] Polymarket order blocked: ${polyRes.error}`,
          })
        }
      }

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
          stopPrice: newPos.stopPrice,
          targetPrice: newPos.targetPrice,
          source: 'bot-auto',
          presetId: rt.activePreset.id,
          clientOrderId: `bot-open-${rt.activePreset.id}-${newPos.entryTime}`,
        })
        recordRuntimeEvent(tenantId, {
          type: orderRes.ok ? 'TRADE' : 'RISK',
          severity: orderRes.ok ? 'info' : 'warn',
          source: orderRes.order.mode,
          correlationId: orderRes.order.id,
          message: orderRes.ok
            ? `[FILL] ${orderRes.order.side} ${orderRes.order.pair} $${orderRes.order.notionalUsd.toFixed(2)} @ $${orderRes.order.price.toFixed(2)} (${orderRes.order.mode})`
            : `[RISK] Order ${orderRes.order.id} rejected: ${orderRes.error}`,
          payload: {
            orderId: orderRes.order.id,
            pair: orderRes.order.pair,
            side: orderRes.order.side,
            notionalUsd: orderRes.order.notionalUsd,
            status: orderRes.order.status,
            presetId: rt.activePreset.id,
          },
        })
      } else if (rt.engineState.closedTrades.length > prevClosedCount) {
        const closed = rt.engineState.closedTrades[0]
        if (closed) {
          const botOwnedQty =
            exchangeSnap.botOwnedPosition &&
            exchangeSnap.botOwnedPosition.pair === closed.pair &&
            exchangeSnap.botOwnedPosition.quantity > 0
              ? exchangeSnap.botOwnedPosition.quantity
              : undefined
          const closeOrderRes = await submitExchangeOrder({
            tenantId,
            pair: closed.pair,
            side: closed.side === 'buy' ? 'SELL' : 'BUY',
            notionalUsd: Math.min(
              closed.size,
              exchangeSnap.hardLimits.maxOrderNotionalUsd,
            ),
            exactQuantity: botOwnedQty,
            referencePrice: closed.exitPrice,
            realizedPnlUsd: closed.pnl,
            exitReason: closed.exitReason,
            source: 'bot-auto',
            presetId: closed.presetId ?? rt.activePreset.id,
            bypassRiskForClose: true,
            clientOrderId: `bot-close-${rt.activePreset.id}-${closed.id}-${closed.exitTime}`,
          })
          recordRuntimeEvent(tenantId, {
            type: closeOrderRes.ok ? 'TRADE' : 'RISK',
            severity: closeOrderRes.ok ? 'info' : 'warn',
            source: closeOrderRes.order.mode,
            correlationId: closeOrderRes.order.id,
            message: closeOrderRes.ok
              ? `[FILL] Close ${closeOrderRes.order.side} ${closeOrderRes.order.pair} $${closeOrderRes.order.notionalUsd.toFixed(2)} @ $${closeOrderRes.order.price.toFixed(2)} (${closeOrderRes.order.mode})`
              : `[RISK] Close order ${closeOrderRes.order.id} rejected: ${closeOrderRes.error}`,
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
    recordRuntimeEvent(tenantId, {
      type: 'ERROR',
      severity: 'error',
      source: 'bot-runtime',
      message: `[ERROR] Bot tick failed: ${error instanceof Error ? error.message : String(error)}`,
    })
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
  stopPredictionRunnerIfActive()
  stopOracleFeedIfActive()
  moduleWorkerStarted = false
  for (const tenantId of tenantRuntimes.keys()) {
    flushStateToDiskSync(undefined, tenantId)
  }
}

export async function shutdownRuntime(): Promise<void> {
  stopBackgroundWorker()
  resetClobBookFeed()
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
      const pausedWithOpenPosition =
        rt.isPaused &&
        (rt.engineState.openPosition !== null ||
          rt.engineState.activeTickets.length > 0)
      if (rt.isRunning || pausedWithOpenPosition) {
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

  if (!process.env.VITEST) {
    void getStateStore()
      .markRunningTrainingRunsInterrupted()
      .catch(() => { })
    void getOracleFeed().start()
    getPredictionRunner().start()
  }
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

async function readJsonBody<T>(
  req: http.IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<T | null> {
  const chunks: Buffer[] = []
  let totalBytes = 0

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    totalBytes += buf.byteLength
    if (totalBytes > maxBytes) {
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
  maxBytes = MAX_BODY_BYTES,
): Promise<{ ok: true; data: T | null } | { ok: false }> {
  try {
    const data = await readJsonBody<T>(req, maxBytes)
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

function resolveTrainingPreset(
  presetId: string,
  customPreset?: StrategyPresetPatch | null,
): StrategyPreset | null {
  const fromCatalog =
    STRATEGY_PRESETS.find((p) => p.id === presetId) ??
    ENGINE_TEMPLATES.find((p) => p.id === presetId) ??
    null
  if (fromCatalog) {
    return customPreset ? mergePresetPatch(fromCatalog, customPreset) : fromCatalog
  }
  if (
    (presetId.startsWith('profile-') || presetId.startsWith('custom-')) &&
    customPreset &&
    typeof customPreset === 'object'
  ) {
    const merged = mergePresetPatch(STRATEGY_PRESETS[0], customPreset)
    return { ...merged, id: presetId }
  }
  return null
}

function validateTrainingConfigPayload(
  raw: unknown,
  preset: StrategyPreset,
): { ok: true; config: TrainingConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Missing training config payload.' }
  }
  const c = raw as Partial<TrainingConfig>
  if (!c.kind || !VALID_TRAINING_KINDS.has(c.kind)) {
    return {
      ok: false,
      error: `Invalid training kind "${String(c.kind)}". Expected walk-forward, meta-filter, or prediction-market.`,
    }
  }
  if (c.kind === 'prediction-market' && preset.domain !== 'prediction-market') {
    return {
      ok: false,
      error: `Preset "${preset.id}" is a crypto-spot strategy and cannot run prediction-market training.`,
    }
  }
  if (c.kind !== 'prediction-market' && preset.domain === 'prediction-market') {
    return {
      ok: false,
      error: `Preset "${preset.id}" is a prediction-market strategy and requires kind "prediction-market".`,
    }
  }

  const pair = typeof c.pair === 'string' ? c.pair.trim().toUpperCase() : ''
  if (!pair || !availablePairs.includes(pair)) {
    return {
      ok: false,
      error: `Unsupported trading pair "${pair}". Allowed: ${availablePairs.join(', ')}.`,
    }
  }
  if (!c.timeframe || !VALID_INTERVALS.has(c.timeframe)) {
    return {
      ok: false,
      error: `Unsupported timeframe "${String(c.timeframe)}".`,
    }
  }

  const fromTimeMs = Number(c.fromTimeMs)
  const toTimeMs = Number(c.toTimeMs)
  const stepMs = intervalMs[c.timeframe]
  if (
    !Number.isFinite(fromTimeMs) ||
    !Number.isFinite(toTimeMs) ||
    fromTimeMs < 0 ||
    fromTimeMs >= toTimeMs
  ) {
    return {
      ok: false,
      error: 'Invalid date range: fromTimeMs must be non-negative and strictly less than toTimeMs.',
    }
  }
  if (toTimeMs > Date.now() + stepMs) {
    return {
      ok: false,
      error: 'Training date range cannot end in the future.',
    }
  }
  const estimatedBars = Math.floor((toTimeMs - fromTimeMs) / stepMs) + 1
  if (estimatedBars > MAX_HISTORY_BARS) {
    return {
      ok: false,
      error: `Date range spans ~${estimatedBars} bars, exceeding the ${MAX_HISTORY_BARS}-bar limit.`,
    }
  }

  const foldCount = Number(c.foldCount)
  if (!Number.isInteger(foldCount) || foldCount < 3 || foldCount > 8) {
    return { ok: false, error: 'foldCount must be an integer between 3 and 8.' }
  }
  const foldMode = c.foldMode === 'rolling' ? 'rolling' : c.foldMode === 'anchored' ? 'anchored' : null
  if (!foldMode) {
    return { ok: false, error: 'foldMode must be "anchored" or "rolling".' }
  }

  const trainRatio = Number(c.trainRatio)
  const valRatio = Number(c.valRatio)
  const testRatio = Number(c.testRatio)
  if (
    !Number.isFinite(trainRatio) ||
    !Number.isFinite(valRatio) ||
    !Number.isFinite(testRatio) ||
    trainRatio < 0.3 ||
    valRatio < 0.05 ||
    testRatio < 0.1 ||
    Math.abs(trainRatio + valRatio + testRatio - 1) > 1e-4
  ) {
    return {
      ok: false,
      error: 'trainRatio, valRatio, and testRatio must be valid positive fractions summing to 1.0.',
    }
  }

  const purgeGapBars = Number(c.purgeGapBars)
  if (!Number.isInteger(purgeGapBars) || purgeGapBars < 1 || purgeGapBars > 500) {
    return {
      ok: false,
      error: 'purgeGapBars must be an integer between 1 and 500.',
    }
  }

  const a = c.assumptions as Partial<TrainingAssumptions> | undefined
  if (!a || typeof a !== 'object') {
    return { ok: false, error: 'Training assumptions are required.' }
  }
  const commissionPct = Number(a.commissionPct)
  const slippagePct = Number(a.slippagePct)
  const initialBalance = Number(a.initialBalance)
  if (!Number.isFinite(commissionPct) || commissionPct < 0 || commissionPct > 5) {
    return { ok: false, error: 'commissionPct must be between 0 and 5.' }
  }
  if (!Number.isFinite(slippagePct) || slippagePct < 0 || slippagePct > 5) {
    return { ok: false, error: 'slippagePct must be between 0 and 5.' }
  }
  if (
    !Number.isFinite(initialBalance) ||
    initialBalance < 100 ||
    initialBalance > 10_000_000
  ) {
    return {
      ok: false,
      error: 'initialBalance must be between 100 and 10,000,000.',
    }
  }
  if (typeof a.allowShort !== 'boolean') {
    return { ok: false, error: 'assumptions.allowShort must be a boolean.' }
  }

  return {
    ok: true,
    config: {
      kind: c.kind,
      presetId: preset.id,
      pair,
      timeframe: c.timeframe,
      fromTimeMs: Math.floor(fromTimeMs),
      toTimeMs: Math.floor(toTimeMs),
      foldCount,
      foldMode,
      trainRatio,
      valRatio,
      testRatio,
      purgeGapBars,
      assumptions: {
        commissionPct,
        slippagePct,
        initialBalance,
        allowShort: a.allowShort,
      },
      isResearchVariant:
        pair !== preset.strategy.pair || c.timeframe !== preset.timeframe,
    },
  }
}

function compareMetricNumber(
  label: string,
  submitted: unknown,
  expected: number,
  mismatches: string[],
): void {
  if (typeof submitted !== 'number' || !Number.isFinite(submitted)) {
    mismatches.push(`${label}: expected ${expected}, got ${String(submitted)}`)
    return
  }
  if (Math.abs(submitted - expected) > TRAINING_METRIC_TOLERANCE) {
    mismatches.push(
      `${label}: submitted ${submitted} differs from server-recomputed ${expected}`,
    )
  }
}

function compareNullableMetricNumber(
  label: string,
  submitted: unknown,
  expected: number | null,
  mismatches: string[],
): void {
  if (expected === null) {
    if (submitted !== null && submitted !== undefined) {
      mismatches.push(`${label}: expected null, got ${String(submitted)}`)
    }
    return
  }
  compareMetricNumber(label, submitted, expected, mismatches)
}

function verifySubmittedTrainingMetrics(
  submitted: TrainingRunMetrics,
  recomputed: TrainingRunMetrics,
  tradeCount: number,
): string[] {
  const mismatches: string[] = []
  if (submitted.totalTrades !== tradeCount || submitted.totalTrades !== recomputed.totalTrades) {
    mismatches.push(
      `totalTrades: submitted ${String(submitted.totalTrades)}, trades.length=${tradeCount}, recomputed=${recomputed.totalTrades}`,
    )
  }
  if (submitted.wins !== recomputed.wins) {
    mismatches.push(`wins: submitted ${String(submitted.wins)}, recomputed=${recomputed.wins}`)
  }
  if (submitted.losses !== recomputed.losses) {
    mismatches.push(`losses: submitted ${String(submitted.losses)}, recomputed=${recomputed.losses}`)
  }
  compareNullableMetricNumber('winRate', submitted.winRate, recomputed.winRate, mismatches)
  compareNullableMetricNumber(
    'wilsonLowerBoundPct',
    submitted.wilsonLowerBoundPct,
    recomputed.wilsonLowerBoundPct,
    mismatches,
  )
  compareNullableMetricNumber(
    'profitFactor',
    submitted.profitFactor,
    recomputed.profitFactor,
    mismatches,
  )
  compareMetricNumber('maxDrawdown', submitted.maxDrawdown, recomputed.maxDrawdown, mismatches)
  compareMetricNumber(
    'maxDrawdownPct',
    submitted.maxDrawdownPct,
    recomputed.maxDrawdownPct,
    mismatches,
  )
  compareMetricNumber('netPnl', submitted.netPnl, recomputed.netPnl, mismatches)
  compareMetricNumber('returnPct', submitted.returnPct, recomputed.returnPct, mismatches)
  compareNullableMetricNumber(
    'expectancy',
    submitted.expectancy,
    recomputed.expectancy,
    mismatches,
  )
  compareMetricNumber('feesPaid', submitted.feesPaid, recomputed.feesPaid, mismatches)

  if (submitted.verdict === 'override') {
    const reason = typeof submitted.overrideReason === 'string' ? submitted.overrideReason.trim() : ''
    if (reason.length < 10) {
      mismatches.push('overrideReason: override verdict requires a reason of at least 10 characters')
    }
  }
  if (submitted.verdict !== recomputed.verdict) {
    mismatches.push(
      `verdict: submitted "${String(submitted.verdict)}", server computed "${recomputed.verdict}"`,
    )
  }

  return mismatches
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
  const bucket =
    req.method === 'POST' || req.method === 'PATCH' ? 'write' : 'read'
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

  // 4. GET /api/bot/accuracy -> Accuracy audit across 1 preset (`?presetId=...`), active preset, or all presets (`?all=true`), persisted in strategy_audits
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
    const requestedPresetId = url.searchParams.get('presetId')?.trim() || null
    const requestedRunId = url.searchParams.get('runId')?.trim() || null

    let targetPresets: StrategyPreset[]
    if (requestedPresetId) {
      const found = STRATEGY_PRESETS.find((p) => p.id === requestedPresetId)
      if (!found) {
        sendJson(
          res,
          400,
          { error: `Unknown presetId: "${requestedPresetId}".` },
          responseHeaders,
        )
        return true
      }
      targetPresets = [found]
    } else {
      targetPresets = evaluateAll ? STRATEGY_PRESETS : [rt.activePreset]
    }

    const runId = requestedRunId || `AUDRUN-${crypto.randomUUID()}`
    const evaluatedAt = new Date().toISOString()

    try {
      const reports = await Promise.all(
        targetPresets.map(async (preset) => {
          const { candles, source, latencyMs } = await fetchOptimizedCandles(
            preset.strategy.pair,
            preset.timeframe,
            CANDLE_LOOKBACK_LIMIT,
          )
          const metrics = evaluateBotPresetAccuracy(candles, preset)
          const fromTimeMs = candles[0]?.time ?? 0
          const toTimeMs = candles[candles.length - 1]?.time ?? 0
          const assumptions = {
            commissionPct: preset.execution.commissionPct,
            slippagePct: preset.execution.slippagePct,
            initialBalance: preset.execution.initialBalance,
            allowShort: preset.execution.allowShort,
          }
          const auditRecord: StrategyAuditRecord = {
            id: `SAUD-${crypto.randomUUID()}`,
            tenantId,
            runId,
            createdAt: evaluatedAt,
            presetId: preset.id,
            presetName: preset.name,
            domain: preset.domain,
            pair: preset.strategy.pair,
            timeframe: preset.timeframe,
            fromTimeMs,
            toTimeMs,
            candles: candles.length,
            metrics: {
              totalOperations: metrics.totalOperations,
              wins: metrics.wins,
              losses: metrics.losses,
              winRatePct: metrics.winRatePct,
              wilsonLowerBoundPct: metrics.wilsonLowerBoundPct,
              netPnlUsd: metrics.netPnlUsd,
              returnPct: metrics.returnPct,
              profitFactor: metrics.profitFactor,
              maxDrawdownPct: metrics.maxDrawdownPct,
            },
            assumptions,
            dataSource: source,
          }
          await getStateStore()
            .appendStrategyAudit(auditRecord)
            .catch(() => { })
          return {
            ...metrics,
            pair: preset.strategy.pair,
            dataSource: source,
            fetchLatencyMs: latencyMs,
            fromTimeMs,
            toTimeMs,
            candles: candles.length,
            assumptions,
          }
        }),
      )

      recordAudit(principal, 'bot:accuracy', url.pathname, 'allowed', {
        runId,
        presetCount: reports.length,
        evaluateAll,
        presetId: requestedPresetId,
      })
      if (!requestedPresetId || requestedPresetId === STRATEGY_PRESETS[STRATEGY_PRESETS.length - 1]?.id) {
        recordRuntimeEvent(tenantId, {
          type: 'OPERATOR',
          severity: 'info',
          source: 'strategy-audit',
          correlationId: runId,
          message: `[OPERATOR] Completed strategy audit (${requestedPresetId ? `run ${runId.slice(0, 14)}` : `${reports.length} preset(s)`}, ${CANDLE_LOOKBACK_LIMIT} candles).`,
        })
      }

      sendJson(
        res,
        200,
        {
          runId,
          evaluatedAt,
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

  // 4b. GET /api/bot/accuracy/latest -> Returns persisted strategy_audits from SQL
  if (req.method === 'GET' && url.pathname === '/api/bot/accuracy/latest') {
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
    const rawLimit = Number(url.searchParams.get('limit') ?? 64)
    const audits = await getStateStore().getLatestStrategyAudits(
      tenantId,
      Number.isFinite(rawLimit) ? rawLimit : 64,
    )
    sendJson(res, 200, { tenantId, audits }, responseHeaders)
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
    const tf: PolymarketTimeframe =
      tfParam === '5m' ? '5m' : tfParam === '1h' ? '1h' : '15m'
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
    const exchangeSnap = getExchangeStatusSnapshot(tenantId)
    if (exchangeSnap.killSwitchActive) {
      recordAudit(principal, 'bot:start', url.pathname, 'denied', {
        reason: 'kill-switch-active',
      })
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
    if (!exchangeSnap.testnetConfigured && !exchangeSnap.paperFunded && rt.engineState.balance <= 0) {
      recordAudit(principal, 'bot:start', url.pathname, 'denied', {
        reason: 'account-unfunded',
      })
      sendJson(
        res,
        400,
        {
          error:
            'Account is not connected or funded. Configure BINANCE_TESTNET_KEY / BINANCE_TESTNET_SECRET or fund the PAPER account before starting.',
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
      if (!found) {
        sendJson(
          res,
          400,
          { error: `Unknown presetId: "${parsed.presetId}".` },
          responseHeaders,
        )
        return true
      }
      if (found.id !== rt.activePreset.id) {
        const preservedBalance = rt.engineState.balance
        rt.activePreset = found
        rt.engineState = createInitialBotState(rt.activePreset, {
          initialBalance: preservedBalance,
          seedLog: false,
        })
      }
    }

    if (parsed?.strategy) {
      if (!isStrategy(parsed.strategy)) {
        sendJson(
          res,
          400,
          { error: 'Invalid strategy payload.' },
          responseHeaders,
        )
        return true
      }
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
    rt.isPaused = false
    await tickBot(tenantId, { forceExecution: true })
    saveStateToDisk(tenantId)
    recordAudit(principal, 'bot:start', url.pathname, 'allowed', {
      presetId: rt.activePreset.id,
    })
    recordRuntimeEvent(tenantId, {
      type: 'OPERATOR',
      severity: 'info',
      source: 'operator',
      message: `[OPERATOR] Bot started by ${principal.subject} (preset: ${rt.activePreset.name}, mode: ${exchangeSnap.mode}).`,
      payload: {
        actor: principal.subject,
        presetId: rt.activePreset.id,
        mode: exchangeSnap.mode,
      },
    })
    broadcastSseUpdate(tenantId)
    sendJson(res, 200, getBotStatusSnapshot(tenantId), responseHeaders)
    return true
  }

  // 6b. POST /api/bot/pause -> Halts new entries while continuing to manage open positions
  if (req.method === 'POST' && url.pathname === '/api/bot/pause') {
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
    if (!rt.isRunning && !rt.isPaused) {
      sendJson(
        res,
        409,
        { error: 'Bot is not running; cannot pause.' },
        responseHeaders,
      )
      return true
    }
    rt.isRunning = false
    rt.isPaused = true
    saveStateToDisk(tenantId)
    recordAudit(principal, 'bot:pause', url.pathname, 'allowed', {
      hasOpenPosition: rt.engineState.openPosition !== null,
    })
    recordRuntimeEvent(tenantId, {
      type: 'OPERATOR',
      severity: 'info',
      source: 'operator',
      message: `[OPERATOR] Bot paused by ${principal.subject}. New entries halted; open positions remain managed.`,
      payload: {
        actor: principal.subject,
        hasOpenPosition: rt.engineState.openPosition !== null,
      },
    })
    broadcastSseUpdate(tenantId)
    sendJson(res, 200, getBotStatusSnapshot(tenantId), responseHeaders)
    return true
  }

  // 6c. POST /api/bot/resume -> Resumes a paused bot
  if (req.method === 'POST' && url.pathname === '/api/bot/resume') {
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
            'Emergency Kill-Switch is active. Rearm the Kill-Switch before resuming.',
        },
        responseHeaders,
      )
      return true
    }
    if (!rt.isPaused) {
      sendJson(
        res,
        409,
        { error: 'Bot is not paused.' },
        responseHeaders,
      )
      return true
    }
    rt.isPaused = false
    rt.isRunning = true
    await tickBot(tenantId, { forceExecution: true })
    saveStateToDisk(tenantId)
    recordAudit(principal, 'bot:resume', url.pathname, 'allowed')
    recordRuntimeEvent(tenantId, {
      type: 'OPERATOR',
      severity: 'info',
      source: 'operator',
      message: `[OPERATOR] Bot resumed by ${principal.subject}.`,
      payload: { actor: principal.subject },
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
    rt.isPaused = false
    saveStateToDisk(tenantId)
    recordAudit(principal, 'bot:stop', url.pathname, 'allowed', {
      positionOpen: rt.engineState.openPosition !== null,
    })
    recordRuntimeEvent(tenantId, {
      type: 'OPERATOR',
      severity: 'info',
      source: 'operator',
      message:
        rt.engineState.openPosition !== null
          ? `[OPERATOR] Bot stopped by ${principal.subject} (open position remains on ${rt.engineState.openPosition.pair}).`
          : `[OPERATOR] Bot stopped by ${principal.subject}.`,
      payload: {
        actor: principal.subject,
        positionOpen: rt.engineState.openPosition !== null,
      },
    })
    broadcastSseUpdate(tenantId)
    sendJson(res, 200, getBotStatusSnapshot(tenantId), responseHeaders)
    return true
  }

  // 8. POST /api/bot/reset -> Resets paper session state without inventing a seeded balance
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
    const exchangeSnap = getExchangeStatusSnapshot(tenantId)
    const usdtBal =
      exchangeSnap.paperFunded
        ? (exchangeSnap.balances.find((b) => b.asset === 'USDT')?.free ?? 0)
        : 0
    rt.isRunning = false
    rt.isPaused = false
    rt.engineState = createInitialBotState(rt.activePreset, {
      initialBalance: usdtBal,
      seedLog: false,
    })
    saveStateToDisk(tenantId)
    recordAudit(principal, 'bot:reset', url.pathname, 'allowed', {
      presetId: rt.activePreset.id,
      balanceUsd: usdtBal,
    })
    recordRuntimeEvent(tenantId, {
      type: 'OPERATOR',
      severity: 'info',
      source: 'operator',
      message: `[OPERATOR] Session reset by ${principal.subject} (paper balance: $${usdtBal.toFixed(2)}).`,
      payload: { actor: principal.subject, balanceUsd: usdtBal },
    })
    broadcastSseUpdate(tenantId)
    sendJson(res, 200, getBotStatusSnapshot(tenantId), responseHeaders)
    return true
  }

  // 8b. POST /api/paper/fund -> Explicitly funds the PAPER account with an operator-chosen USD amount
  if (req.method === 'POST' && url.pathname === '/api/paper/fund') {
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
    const body = await readOptionalJsonBody<{ amountUsd?: number }>(
      req,
      res,
      responseHeaders,
    )
    if (!body.ok) return true
    const amountUsd = Number(body.data?.amountUsd)
    const funded = fundPaperAccount(amountUsd, tenantId)
    if (!funded.ok) {
      recordAudit(principal, 'paper:fund', url.pathname, 'denied', {
        amountUsd: Number.isFinite(amountUsd) ? amountUsd : null,
      })
      sendJson(res, 400, { error: funded.error }, responseHeaders)
      return true
    }

    rt.isRunning = false
    rt.isPaused = false
    rt.engineState = createInitialBotState(rt.activePreset, {
      initialBalance: funded.amountUsd,
      seedLog: false,
    })
    saveStateToDisk(tenantId)
    recordAudit(principal, 'paper:fund', url.pathname, 'allowed', {
      amountUsd: funded.amountUsd,
    })
    recordRuntimeEvent(tenantId, {
      type: 'OPERATOR',
      severity: 'info',
      source: 'operator',
      message: `[OPERATOR] PAPER account funded with $${funded.amountUsd.toFixed(2)} USD by ${principal.subject}.`,
      payload: { actor: principal.subject, amountUsd: funded.amountUsd },
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
      customPreset?: StrategyPresetPatch
      reset?: boolean
    }>(req, res, responseHeaders)
    if (!body.ok) return true
    const parsed = body.data

    if (parsed?.presetId !== undefined) {
      const found = STRATEGY_PRESETS.find((p) => p.id === parsed.presetId)
      if (!found) {
        recordAudit(principal, 'bot:preset', url.pathname, 'denied', {
          presetId: String(parsed.presetId),
        })
        sendJson(
          res,
          400,
          { error: `Unknown presetId: "${String(parsed.presetId)}".` },
          responseHeaders,
        )
        return true
      }
    }

    if (
      parsed?.timeframe !== undefined &&
      !VALID_INTERVALS.has(parsed.timeframe)
    ) {
      sendJson(
        res,
        400,
        { error: `Unsupported timeframe: "${String(parsed.timeframe)}".` },
        responseHeaders,
      )
      return true
    }

    if (parsed?.strategy !== undefined) {
      const s = parsed.strategy
      if (
        !isStrategy(s) ||
        !availablePairs.includes(s.pair) ||
        s.positionSize < 0.1 ||
        s.positionSize > 100 ||
        s.stopLoss < 0.1 ||
        s.stopLoss > 50 ||
        s.takeProfit < 0.1 ||
        s.takeProfit > 100 ||
        s.maxDailyRisk < 0.1 ||
        s.maxDailyRisk > 100
      ) {
        sendJson(
          res,
          400,
          {
            error:
              'Invalid strategy parameters (pair must be supported; size/TP/daily risk 0.1–100%, SL 0.1–50%).',
          },
          responseHeaders,
        )
        return true
      }
    }

    if (parsed?.customPreset?.strategy) {
      const cs = parsed.customPreset.strategy
      if (cs.pair !== undefined && !availablePairs.includes(cs.pair)) {
        sendJson(
          res,
          400,
          { error: `Unsupported strategy pair: "${cs.pair}".` },
          responseHeaders,
        )
        return true
      }
      if (
        cs.positionSize !== undefined &&
        (!Number.isFinite(cs.positionSize) ||
          cs.positionSize < 0.1 ||
          cs.positionSize > 100)
      ) {
        sendJson(
          res,
          400,
          { error: 'positionSize must be between 0.1% and 100%.' },
          responseHeaders,
        )
        return true
      }
      if (
        cs.stopLoss !== undefined &&
        (!Number.isFinite(cs.stopLoss) || cs.stopLoss < 0.1 || cs.stopLoss > 50)
      ) {
        sendJson(
          res,
          400,
          { error: 'stopLoss must be between 0.1% and 50%.' },
          responseHeaders,
        )
        return true
      }
      if (
        cs.takeProfit !== undefined &&
        (!Number.isFinite(cs.takeProfit) ||
          cs.takeProfit < 0.1 ||
          cs.takeProfit > 100)
      ) {
        sendJson(
          res,
          400,
          { error: 'takeProfit must be between 0.1% and 100%.' },
          responseHeaders,
        )
        return true
      }
      if (
        cs.maxDailyRisk !== undefined &&
        (!Number.isFinite(cs.maxDailyRisk) ||
          cs.maxDailyRisk < 0.1 ||
          cs.maxDailyRisk > 100)
      ) {
        sendJson(
          res,
          400,
          { error: 'maxDailyRisk must be between 0.1% and 100%.' },
          responseHeaders,
        )
        return true
      }
    }

    const prevPresetId = rt.activePreset.id
    const prevDomain = rt.activePreset.domain
    const prevBalance = rt.engineState.balance
    let shouldResetState = parsed?.reset === true

    if (parsed?.presetId) {
      const found = STRATEGY_PRESETS.find((p) => p.id === parsed.presetId)
      if (found && (found.id !== rt.activePreset.id || parsed.reset === true)) {
        rt.activePreset = found
        shouldResetState = true
      }
    }

    if (parsed?.customPreset && typeof parsed.customPreset === 'object') {
      rt.activePreset = mergePresetPatch(rt.activePreset, parsed.customPreset)
    }

    if (parsed?.strategy && isStrategy(parsed.strategy)) {
      rt.activePreset = {
        ...rt.activePreset,
        strategy: parsed.strategy,
        timeframe: parsed.timeframe ?? rt.activePreset.timeframe,
      }
    } else if (parsed?.timeframe && VALID_INTERVALS.has(parsed.timeframe)) {
      rt.activePreset = {
        ...rt.activePreset,
        timeframe: parsed.timeframe,
      }
    }

    if (shouldResetState || rt.activePreset.domain !== prevDomain) {
      rt.engineState = createInitialBotState(rt.activePreset, {
        initialBalance: prevBalance,
        seedLog: false,
      })
    } else {
      rt.engineState = {
        ...rt.engineState,
        domain: rt.activePreset.domain,
        pair: rt.activePreset.strategy.pair,
        timeframe: rt.activePreset.timeframe,
      }
    }

    saveStateToDisk(tenantId)
    recordAudit(principal, 'bot:preset', url.pathname, 'allowed', {
      prevPresetId,
      presetId: rt.activePreset.id,
      domain: rt.activePreset.domain,
      pair: rt.activePreset.strategy.pair,
      timeframe: rt.activePreset.timeframe,
    })
    recordRuntimeEvent(tenantId, {
      type: 'OPERATOR',
      severity: 'info',
      source: 'operator',
      message: `[OPERATOR] Strategy updated by ${principal.subject}: ${rt.activePreset.name} (${rt.activePreset.strategy.pair} · ${rt.activePreset.timeframe}, SL ${rt.activePreset.strategy.stopLoss}% / TP ${rt.activePreset.strategy.takeProfit}% / Size ${rt.activePreset.strategy.positionSize}%).`,
      payload: {
        actor: principal.subject,
        prevPresetId,
        presetId: rt.activePreset.id,
        strategy: rt.activePreset.strategy,
        timeframe: rt.activePreset.timeframe,
      },
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
    recordAudit(principal, 'bot:tick', url.pathname, 'allowed', {
      presetId: rt.activePreset.id,
    })
    recordRuntimeEvent(tenantId, {
      type: 'OPERATOR',
      severity: 'info',
      source: 'operator',
      message: `[OPERATOR] Manual bar evaluation triggered by ${principal.subject} (${rt.activePreset.strategy.pair} ${rt.activePreset.timeframe}).`,
    })
    sendJson(res, 200, getBotStatusSnapshot(tenantId), responseHeaders)
    return true
  }

  // ============================================================================
  // Exchange Adapter, Account, Orders, Positions, Events, Ledger & Audit
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

  // 11a. GET /api/exchange/account -> Real Binance Spot Testnet /api/v3/account or explicit disconnected status
  if (req.method === 'GET' && url.pathname === '/api/exchange/account') {
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
    const account = await fetchExchangeAccount(tenantId)
    sendJson(res, 200, account, responseHeaders)
    return true
  }

  // 11a2. GET /api/exchange/orders -> SQL-backed orders table with filter & cursor pagination
  if (req.method === 'GET' && url.pathname === '/api/exchange/orders') {
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
    const statusParam = url.searchParams.get('status')?.trim() || undefined
    const pairParam = url.searchParams.get('pair')?.trim() || undefined
    const sideRaw = url.searchParams.get('side')?.trim().toUpperCase()
    const sideParam =
      sideRaw === 'BUY' || sideRaw === 'SELL' ? sideRaw : undefined
    const sourceRaw = url.searchParams.get('source')?.trim()
    const sourceParam =
      sourceRaw === 'manual' || sourceRaw === 'bot-auto' ? sourceRaw : undefined
    const beforeParam = url.searchParams.get('before')?.trim() || undefined
    const rawLimit = Number(url.searchParams.get('limit') ?? 100)
    const orders = await getStateStore().queryOrders(tenantId, {
      status: statusParam,
      pair: pairParam,
      side: sideParam,
      source: sourceParam,
      before: beforeParam,
      limit: Number.isFinite(rawLimit) ? rawLimit : 100,
    })
    sendJson(res, 200, { tenantId, orders }, responseHeaders)
    return true
  }

  // 11a3. GET /api/events -> SQL-backed append-only runtime_events
  if (req.method === 'GET' && url.pathname === '/api/events') {
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
    const validEventTypes = new Set<RuntimeEventType>([
      'SIGNAL',
      'TRADE',
      'RISK',
      'INFO',
      'ERROR',
      'OPERATOR',
    ])
    const typesRaw = url.searchParams.get('types')?.trim() ?? ''
    const types = typesRaw
      ? typesRaw
        .split(',')
        .map((t) => t.trim().toUpperCase() as RuntimeEventType)
        .filter((t) => validEventTypes.has(t))
      : undefined
    const q = url.searchParams.get('q')?.trim() || undefined
    const before = url.searchParams.get('before')?.trim() || undefined
    const rawLimit = Number(url.searchParams.get('limit') ?? 200)
    const events = await getStateStore().getRuntimeEvents(tenantId, {
      types: types && types.length > 0 ? types : undefined,
      q,
      before,
      limit: Number.isFinite(rawLimit) ? rawLimit : 200,
    })
    sendJson(res, 200, { tenantId, events }, responseHeaders)
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

  // 12. POST /api/exchange/order -> Strictly validated order submission with durable idempotency
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
      side?: string
      notionalUsd?: number
      referencePrice?: number
      clientOrderId?: string
    }>(req, res, responseHeaders)
    if (!body.ok) return true
    const parsed = body.data

    if (!parsed || typeof parsed !== 'object') {
      sendJson(
        res,
        400,
        { error: 'Order payload is required (pair, side, notionalUsd).' },
        responseHeaders,
      )
      return true
    }

    const pair = typeof parsed.pair === 'string' ? parsed.pair.trim() : ''
    const sideRaw = typeof parsed.side === 'string' ? parsed.side.trim().toUpperCase() : ''
    const notionalUsd = Number(parsed.notionalUsd)

    if (!pair || !availablePairs.includes(pair)) {
      sendJson(
        res,
        400,
        { error: `Invalid or missing pair "${pair}". Allowed: ${availablePairs.join(', ')}.` },
        responseHeaders,
      )
      return true
    }
    if (sideRaw !== 'BUY' && sideRaw !== 'SELL') {
      sendJson(
        res,
        400,
        { error: `Invalid side "${sideRaw}". Expected BUY or SELL.` },
        responseHeaders,
      )
      return true
    }
    if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {
      sendJson(
        res,
        400,
        { error: 'notionalUsd must be a finite positive number.' },
        responseHeaders,
      )
      return true
    }

    const result = await submitExchangeOrder({
      tenantId,
      pair,
      side: sideRaw,
      notionalUsd,
      referencePrice: parsed.referencePrice,
      source: 'manual',
      clientOrderId: parsed.clientOrderId,
    })

    if (!result.deduplicated) {
      recordRuntimeEvent(tenantId, {
        type: result.ok ? 'TRADE' : 'RISK',
        severity: result.ok ? 'info' : 'warn',
        source: result.order.mode,
        correlationId: result.order.id,
        message: result.ok
          ? `[FILL] ${sideRaw} ${pair} $${result.order.notionalUsd.toFixed(2)} @ $${result.order.price.toFixed(2)} (${result.order.mode}, #${result.order.id})`
          : `[RISK] Order ${result.order.id} rejected: ${result.error}`,
        payload: {
          orderId: result.order.id,
          venueOrderId: result.order.venueOrderId ?? null,
          clientOrderId: result.order.clientOrderId ?? null,
          pair,
          side: sideRaw,
          notionalUsd: result.order.notionalUsd,
          status: result.order.status,
        },
      })
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
        side: sideRaw,
        notionalUsd: result.order.notionalUsd,
        status: result.order.status,
        deduplicated: Boolean(result.deduplicated),
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

  // 12b. POST /api/exchange/orders/:id/cancel -> Cancels an open venue order (or 501 if unsupported)
  const cancelMatch = /^\/api\/exchange\/orders\/([^/]+)\/cancel$/.exec(
    url.pathname,
  )
  if (req.method === 'POST' && cancelMatch) {
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
    const orderId = decodeURIComponent(cancelMatch[1])
    const result = await cancelExchangeOrder(orderId, tenantId)
    recordAudit(
      principal,
      'exchange:cancel',
      url.pathname,
      result.ok ? 'allowed' : 'denied',
      { orderId, statusCode: result.statusCode },
    )
    if (result.ok && result.order) {
      recordRuntimeEvent(tenantId, {
        type: 'OPERATOR',
        severity: 'info',
        source: result.order.mode,
        correlationId: result.order.id,
        message: `[ORDER] Canceled ${result.order.id} (${result.order.pair}) by ${principal.subject}.`,
      })
      saveStateToDisk(tenantId)
      broadcastSseUpdate(tenantId)
    }
    sendJson(
      res,
      result.statusCode,
      {
        ok: result.ok,
        error: result.error,
        order: result.order,
        bot: getBotStatusSnapshot(tenantId),
      },
      responseHeaders,
    )
    return true
  }

  // 12c. POST /api/positions/close -> Closes bot-owned open positions truthfully across paper/testnet/MT5
  if (req.method === 'POST' && url.pathname === '/api/positions/close') {
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
    const body = await readOptionalJsonBody<{ reason?: string }>(
      req,
      res,
      responseHeaders,
    )
    if (!body.ok) return true
    const reasonText =
      body.data?.reason?.trim() || `Manual close by ${principal.subject}`

    const exchangeSnap = getExchangeStatusSnapshot(tenantId)
    const mt5Snap = getMt5BridgeSnapshot(
      rt.engineState,
      rt.activePreset,
      exchangeSnap,
    )
    const hasPaperPos = rt.engineState.openPosition !== null
    const hasTestnetPos = exchangeSnap.botOwnedPosition !== null
    const hasMt5Polled = mt5Snap.pollCount > 0

    if (!hasPaperPos && !hasTestnetPos && !hasMt5Polled) {
      sendJson(
        res,
        409,
        { ok: false, error: 'No open bot position to close.' },
        responseHeaders,
      )
      return true
    }

    let paperClosed = false
    let closedTrade = null
    if (rt.engineState.openPosition) {
      const pos = rt.engineState.openPosition
      let exitPrice = pos.entryPrice
      try {
        const { candles } = await fetchOptimizedCandles(pos.pair, '5m', 5)
        const last = candles[candles.length - 1]
        if (last && Number.isFinite(last.close) && last.close > 0) {
          exitPrice = last.close
        }
      } catch {
        sendJson(
          res,
          503,
          {
            ok: false,
            error: `Live market price unavailable for ${pos.pair}; cannot price manual close.`,
          },
          responseHeaders,
        )
        return true
      }
      const closedRes = closePaperPositionAtPrice(
        rt.engineState,
        exitPrice,
        Date.now(),
        'manual',
        rt.activePreset,
      )
      rt.engineState = closedRes.state
      closedTrade = closedRes.closedTrade
      paperClosed = closedTrade !== null

      if (closedTrade) {
        if (
          exchangeSnap.autoMirrorBotOrders &&
          exchangeSnap.mode === 'paper' &&
          exchangeSnap.paperFunded
        ) {
          const mirrorClose = await submitExchangeOrder({
            tenantId,
            pair: closedTrade.pair,
            side: closedTrade.side === 'buy' ? 'SELL' : 'BUY',
            notionalUsd: closedTrade.size,
            referencePrice: closedTrade.exitPrice,
            realizedPnlUsd: closedTrade.pnl,
            source: 'bot-auto',
            bypassRiskForClose: true,
            clientOrderId: `manual-close-${closedTrade.id}-${closedTrade.exitTime}`,
          })
          recordRuntimeEvent(tenantId, {
            type: mirrorClose.ok ? 'TRADE' : 'RISK',
            severity: mirrorClose.ok ? 'info' : 'warn',
            source: mirrorClose.order.mode,
            correlationId: mirrorClose.order.id,
            message: mirrorClose.ok
              ? `[FILL] Manual close ${mirrorClose.order.side} ${mirrorClose.order.pair} $${mirrorClose.order.notionalUsd.toFixed(2)} @ $${mirrorClose.order.price.toFixed(2)}`
              : `[RISK] Manual close mirror rejected: ${mirrorClose.error}`,
          })
        } else {
          recordRuntimeEvent(tenantId, {
            type: 'TRADE',
            severity: 'info',
            source: 'bot-engine',
            message: `[FILL] Manually closed ${closedTrade.side.toUpperCase()} ${closedTrade.pair} @ $${closedTrade.exitPrice.toFixed(2)} · PnL ${closedTrade.pnl >= 0 ? '+' : ''}$${closedTrade.pnl.toFixed(2)}`,
          })
        }
      }
    }

    let testnetClosed = false
    let testnetError: string | undefined
    if (hasTestnetPos) {
      const closeRes = await closeBotOwnedTestnetPosition(tenantId, {
        reason: reasonText,
      })
      testnetClosed = closeRes.closed
      testnetError = closeRes.error
      if (closeRes.order) {
        recordRuntimeEvent(tenantId, {
          type: closeRes.closed ? 'TRADE' : 'ERROR',
          severity: closeRes.closed ? 'info' : 'error',
          source: 'binance-testnet',
          correlationId: closeRes.order.id,
          message: closeRes.closed
            ? `[FILL] Closed bot-owned Testnet position (${closeRes.order.quantity} ${closeRes.order.pair}) @ $${closeRes.order.price.toFixed(2)}`
            : `[ERROR] Failed to close Testnet position: ${closeRes.error}`,
        })
      }
    }

    let mt5Pending = false
    if (hasMt5Polled) {
      markMt5ClosePending()
      mt5Pending = true
      recordRuntimeEvent(tenantId, {
        type: 'OPERATOR',
        severity: 'info',
        source: 'mt5-bridge',
        message: `[MT5] Close command queued — pending EA ACK.`,
      })
    }

    saveStateToDisk(tenantId)
    recordAudit(principal, 'position:close', url.pathname, 'allowed', {
      paperClosed,
      testnetClosed,
      mt5Pending,
      reason: reasonText,
    })
    recordRuntimeEvent(tenantId, {
      type: 'OPERATOR',
      severity: 'info',
      source: 'operator',
      message: `[OPERATOR] Position close requested by ${principal.subject} (paper=${paperClosed}, testnet=${testnetClosed}, mt5Pending=${mt5Pending}).`,
    })
    broadcastSseUpdate(tenantId)
    sendJson(
      res,
      200,
      {
        ok: !testnetError,
        error: testnetError,
        paperClosed,
        testnetClosed,
        mt5Pending,
        closedTrade,
        bot: getBotStatusSnapshot(tenantId),
      },
      responseHeaders,
    )
    return true
  }

  // 13. POST /api/exchange/limits -> Strictly validated server-side hard limits
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

    if (!parsed || typeof parsed !== 'object') {
      sendJson(
        res,
        400,
        { error: 'Hard limits update payload is required.' },
        responseHeaders,
      )
      return true
    }

    const validation = validateHardRiskLimitsUpdate(parsed)
    if (!validation.ok) {
      recordAudit(principal, 'risk:limits', url.pathname, 'denied', {
        error: validation.error,
      })
      sendJson(res, 400, { error: validation.error }, responseHeaders)
      return true
    }

    const prevLimits = getExchangeStatusSnapshot(tenantId).hardLimits
    updateHardRiskLimits(validation.sanitized, tenantId)
    if (typeof validation.sanitized.autoMirrorBotOrders === 'boolean') {
      setExchangeAutoMirror(validation.sanitized.autoMirrorBotOrders, tenantId)
    }
    saveStateToDisk(tenantId)
    const nextLimits = getExchangeStatusSnapshot(tenantId).hardLimits
    recordAudit(principal, 'risk:limits', url.pathname, 'allowed', {
      maxOrderNotionalUsd: nextLimits.maxOrderNotionalUsd,
      maxDailyLossUsd: nextLimits.maxDailyLossUsd,
      maxDailyOrders: nextLimits.maxDailyOrders,
    })
    recordRuntimeEvent(tenantId, {
      type: 'OPERATOR',
      severity: 'info',
      source: 'operator',
      message: `[OPERATOR] Hard limits updated by ${principal.subject}: cap $${nextLimits.maxOrderNotionalUsd}/order, ${nextLimits.maxDailyOrders} orders/day, $${nextLimits.maxDailyLossUsd} daily loss.`,
      payload: {
        actor: principal.subject,
        before: prevLimits,
        after: nextLimits,
      },
    })

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
      recordAudit(principal, 'risk:killswitch_reset', url.pathname, 'allowed')
      recordRuntimeEvent(tenantId, {
        type: 'OPERATOR',
        severity: 'info',
        source: 'operator',
        message: `[OPERATOR] Emergency Kill-Switch rearmed by ${principal.subject}.`,
        payload: { actor: principal.subject },
      })
    } else {
      const reason = parsed?.reason?.trim() || 'Emergency stop triggered by operator'
      const killResult = await triggerEmergencyKillSwitch(
        reason,
        async () => {
          rt.isRunning = false
          rt.isPaused = false
          if (rt.engineState.openPosition) {
            const pos = rt.engineState.openPosition
            let exitPrice = pos.entryPrice
            try {
              const { candles } = await fetchOptimizedCandles(pos.pair, '5m', 5)
              const last = candles[candles.length - 1]
              if (last && Number.isFinite(last.close) && last.close > 0) {
                exitPrice = last.close
              }
            } catch {
              // Fall back to entry price only if upstream feed is unreachable during emergency halt
            }
            const closedRes = closePaperPositionAtPrice(
              rt.engineState,
              exitPrice,
              Date.now(),
              'kill-switch',
              rt.activePreset,
            )
            rt.engineState = {
              ...closedRes.state,
              activeTickets: [],
            }
          } else {
            rt.engineState = {
              ...rt.engineState,
              openPosition: null,
              activeTickets: [],
            }
          }
          markMt5ClosePending()
        },
        tenantId,
      )
      recordAudit(principal, 'risk:killswitch_engage', url.pathname, 'allowed', {
        reason,
        killOrderId: killResult.killOrder.id,
        canceledVenueOrders: killResult.canceledVenueOrderIds.length,
        closedTestnetOrderId: killResult.closedTestnetOrder?.id ?? null,
      })
      recordRuntimeEvent(tenantId, {
        type: 'RISK',
        severity: 'critical',
        source: 'kill-switch',
        correlationId: killResult.killOrder.id,
        message: `[RISK] KILL-SWITCH ENGAGED by ${principal.subject}: ${reason}. Bot stopped, open venue orders canceled (${killResult.canceledVenueOrderIds.length}), bot positions closed.`,
        payload: {
          actor: principal.subject,
          reason,
          killOrderId: killResult.killOrder.id,
          canceledVenueOrderIds: killResult.canceledVenueOrderIds,
          closedTestnetOrderId: killResult.closedTestnetOrder?.id ?? null,
          venueErrors: killResult.venueErrors,
        },
      })
    }

    saveStateToDisk(tenantId)
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
    const eaVersion = url.searchParams.get('eaVersion')
    const broker = url.searchParams.get('broker')
    const account = url.searchParams.get('account')
    const rawMagic = url.searchParams.get('magic')
    const magicNumber = rawMagic ? Number(rawMagic) : null

    const packet = registerMt5Poll(
      rt.engineState,
      rt.activePreset,
      getExchangeStatusSnapshot(tenantId),
      { terminal, symbol, eaVersion, broker, account, magicNumber },
    )
    const globals = getRuntimeGlobals()
    const terminalKey = `${tenantId}|${terminal}|${symbol ?? ''}|${packet.action}|${packet.signalId}`
    const now = Date.now()
    const changed = terminalKey !== globals.lastMt5TerminalKey
    const intervalElapsed =
      globals.lastMt5SseBroadcastAt === undefined ||
      now - globals.lastMt5SseBroadcastAt >= MT5_SSE_MIN_INTERVAL_MS
    if (changed) {
      recordRuntimeEvent(tenantId, {
        type: 'SIGNAL',
        severity: 'info',
        source: 'mt5-bridge',
        correlationId: packet.signalId,
        message: `[MT5] Served ${packet.action} (${packet.symbol}) to ${terminal}${eaVersion ? ` v${eaVersion}` : ''} (${packet.signalId}).`,
      })
    }
    if (changed || intervalElapsed) {
      globals.lastMt5TerminalKey = terminalKey
      globals.lastMt5SseBroadcastAt = now
      broadcastSseUpdate(tenantId)
    }
    sendJson(res, 200, packet, responseHeaders)
    return true
  }

  // 17. POST /api/mt5/ack -> EA execution acknowledgement reporting fills, closes, or errors
  if (req.method === 'POST' && url.pathname === '/api/mt5/ack') {
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
      signalId?: string
      terminal?: string
      eaVersion?: string
      symbol?: string
      action?: Mt5Action
      status?: Mt5AckStatus
      ticket?: string
      fillPrice?: number
      volume?: number
      error?: string
      broker?: string
      account?: string
      positions?: Mt5ReportedPosition[]
    }>(req, res, responseHeaders)
    if (!body.ok) return true
    const parsed = body.data

    const validStatuses = new Set<Mt5AckStatus>([
      'EXECUTED',
      'CLOSED',
      'REJECTED',
      'ERROR',
      'NOOP',
    ])
    if (
      !parsed?.signalId?.trim() ||
      !parsed.status ||
      !validStatuses.has(parsed.status)
    ) {
      sendJson(
        res,
        400,
        {
          error:
            'MT5 ACK requires non-empty signalId and status (EXECUTED | CLOSED | REJECTED | ERROR | NOOP).',
        },
        responseHeaders,
      )
      return true
    }

    const ack = recordMt5Ack({
      signalId: parsed.signalId,
      terminalName: parsed.terminal,
      eaVersion: parsed.eaVersion,
      symbol: parsed.symbol,
      action: parsed.action ?? null,
      status: parsed.status,
      ticket: parsed.ticket,
      fillPrice: parsed.fillPrice,
      volume: parsed.volume,
      error: parsed.error,
      broker: parsed.broker,
      account: parsed.account,
      positions: parsed.positions ?? null,
    })

    const isErr = ack.status === 'ERROR' || ack.status === 'REJECTED'
    recordRuntimeEvent(tenantId, {
      type: isErr ? 'ERROR' : 'TRADE',
      severity: isErr ? 'error' : 'info',
      source: 'mt5-bridge',
      correlationId: ack.signalId,
      message: isErr
        ? `[MT5] EA ${ack.status} on ${ack.signalId}: ${ack.error ?? 'Unknown MT5 error'}`
        : `[MT5] EA ACK ${ack.status} for ${ack.signalId}${ack.ticket ? ` (ticket #${ack.ticket})` : ''}${ack.fillPrice ? ` @ $${ack.fillPrice}` : ''}.`,
      payload: ack as unknown as Record<string, unknown>,
    })
    recordAudit(principal, 'mt5:ack', url.pathname, isErr ? 'error' : 'allowed', {
      signalId: ack.signalId,
      status: ack.status,
      ticket: ack.ticket,
    })
    broadcastSseUpdate(tenantId)
    sendJson(
      res,
      200,
      {
        ok: true,
        ack,
        mt5: getMt5BridgeSnapshot(
          rt.engineState,
          rt.activePreset,
          getExchangeStatusSnapshot(tenantId),
        ),
      },
      responseHeaders,
    )
    return true
  }

  // ============================================================================
  // Polymarket CLOB Live Execution Endpoints
  // ============================================================================

  // 18. GET /api/polymarket/status -> CLOB executor config, armed flag, orders & last reconciliation
  if (req.method === 'GET' && url.pathname === '/api/polymarket/status') {
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
    sendJson(res, 200, getPolymarketExecutorStatus(tenantId), responseHeaders)
    return true
  }

  // 19. POST /api/polymarket/order -> Submits an EIP-712 + L2 HMAC order to Polymarket CLOB
  if (req.method === 'POST' && url.pathname === '/api/polymarket/order') {
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
      quote?: ExecutablePredictionQuote
      side?: PolymarketExecutionSide
      stakeUsd?: number
      orderType?: PolymarketOrderType
      clientOrderId?: string
    }>(req, res, responseHeaders)
    if (!body.ok) return true
    const parsed = body.data

    const clientOrderId =
      parsed?.clientOrderId?.trim() || `poly-manual-${Date.now()}`
    const stakeUsd = Number(parsed?.stakeUsd ?? 0)
    const side: PolymarketExecutionSide =
      parsed?.side === 'SELL' ? 'SELL' : 'BUY'
    const orderType: PolymarketOrderType =
      parsed?.orderType === 'GTC' ||
        parsed?.orderType === 'GTD' ||
        parsed?.orderType === 'FAK'
        ? parsed.orderType
        : 'FOK'

    const result = await submitPolymarketOrder({
      tenantId,
      quote: parsed?.quote,
      side,
      stakeUsd,
      orderType,
      clientOrderId,
      source: 'manual',
    })

    recordRuntimeEvent(tenantId, {
      type: result.ok ? 'TRADE' : 'RISK',
      severity: result.ok ? 'info' : 'warn',
      source: 'polymarket-clob',
      correlationId: result.order.id,
      message: result.ok
        ? `[ORDER] Polymarket ${side} ${result.order.outcome} ${result.order.instrumentId} $${result.order.stakeUsd.toFixed(2)} @ ${(result.order.limitPrice * 100).toFixed(1)}c (${result.order.status})`
        : `[RISK] Polymarket order rejected: ${result.error}`,
    })
    saveStateToDisk(tenantId)
    recordAudit(
      principal,
      'polymarket:order',
      url.pathname,
      result.ok ? 'allowed' : 'denied',
      {
        orderId: result.order.id,
        venueOrderId: result.order.venueOrderId ?? null,
        instrumentId: result.order.instrumentId,
        stakeUsd: result.order.stakeUsd,
        status: result.order.status,
      },
    )
    broadcastSseUpdate(tenantId)
    sendJson(
      res,
      200,
      {
        ...result,
        polymarket: getPolymarketExecutorStatus(tenantId),
      },
      responseHeaders,
    )
    return true
  }

  // 20. POST /api/polymarket/cancel -> Cancels a specific CLOB order or all open orders
  if (req.method === 'POST' && url.pathname === '/api/polymarket/cancel') {
    if (
      !enforcePermission(
        principal,
        'risk:engage_killswitch',
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }
    const body = await readOptionalJsonBody<{
      orderId?: string
      cancelAll?: boolean
      reason?: string
    }>(req, res, responseHeaders)
    if (!body.ok) return true
    const parsed = body.data

    const result =
      parsed?.cancelAll || !parsed?.orderId
        ? await cancelAllPolymarketOrders(
          tenantId,
          parsed?.reason ?? 'Operator cancel-all',
        )
        : await cancelPolymarketOrder(parsed.orderId, tenantId)

    recordAudit(
      principal,
      'polymarket:cancel',
      url.pathname,
      result.ok ? 'allowed' : 'error',
      {
        orderId: parsed?.orderId ?? null,
        cancelAll: Boolean(parsed?.cancelAll || !parsed?.orderId),
      },
    )
    broadcastSseUpdate(tenantId)
    sendJson(
      res,
      200,
      {
        ...result,
        polymarket: getPolymarketExecutorStatus(tenantId),
      },
      responseHeaders,
    )
    return true
  }

  // 21. POST /api/polymarket/reconcile -> Syncs live USDC.e collateral, open orders & trades
  if (req.method === 'POST' && url.pathname === '/api/polymarket/reconcile') {
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
    try {
      const snapshot = await reconcilePolymarketAccount(tenantId)
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

  // 22. GET /api/prediction-engine/status -> Prediction engine status, oracle, gates, strategies & trades
  if (req.method === 'GET' && url.pathname === '/api/prediction-engine/status') {
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
    const status = await getPredictionRunner().getPredictionEngineStatus(tenantId)
    sendJson(res, 200, status, responseHeaders)
    return true
  }

  // 23. GET /api/prediction-engine/windows -> Recent collected windows, shadow/canary trades & counts
  if (req.method === 'GET' && url.pathname === '/api/prediction-engine/windows') {
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
    const tfParam = url.searchParams.get('tf')
    const timeframe: PolymarketTimeframe | undefined =
      tfParam === '5m' || tfParam === '15m' || tfParam === '1h'
        ? tfParam
        : undefined
    const rawLimit = Number(url.searchParams.get('limit') ?? 50)
    const limit = Number.isFinite(rawLimit)
      ? Math.min(500, Math.max(1, Math.round(rawLimit)))
      : 50
    const store = getStateStore()
    const [windows, trades, c5m, c15m, c1h] = await Promise.all([
      store.getPredictionWindows({ timeframe, order: 'desc', limit }),
      store.getPredictionTrades(tenantId, { timeframe, limit }),
      store.getSettledWindowCount('5m'),
      store.getSettledWindowCount('15m'),
      store.getSettledWindowCount('1h'),
    ])
    sendJson(
      res,
      200,
      {
        timeframe: timeframe ?? null,
        limit,
        settledCountsByTimeframe: { '5m': c5m, '15m': c15m, '1h': c1h },
        windows,
        trades,
      },
      responseHeaders,
    )
    return true
  }

  // 24. POST /api/prediction-engine/mode -> Strategy lifecycle mode, canary risk config & macro blackouts
  if (req.method === 'POST' && url.pathname === '/api/prediction-engine/mode') {
    const body = await readOptionalJsonBody<{
      strategyId?: string
      mode?: string
      forceOverride?: boolean
      overrideReason?: string
      halt?: boolean
      haltedReason?: string
      canaryConfig?: Partial<CanaryRiskConfig>
      macroBlackoutWindows?: MacroBlackoutWindow[]
      addMacroBlackout?: MacroBlackoutWindow
      removeMacroBlackoutTimestampMs?: number
    }>(req, res, responseHeaders)
    if (!body.ok) return true
    const parsed = body.data ?? {}

    const requiresRiskManage =
      parsed.mode === 'canary' ||
      parsed.mode === 'scale' ||
      parsed.forceOverride === true ||
      parsed.canaryConfig !== undefined ||
      parsed.macroBlackoutWindows !== undefined ||
      parsed.addMacroBlackout !== undefined ||
      parsed.removeMacroBlackoutTimestampMs !== undefined

    const requiredPermission: Permission = requiresRiskManage
      ? 'risk:manage'
      : 'trade:execute'

    if (
      !enforcePermission(
        principal,
        requiredPermission,
        res,
        responseHeaders,
        url.pathname,
      )
    ) {
      return true
    }

    const validStrategyIds = new Set<string>(PREDICTION_ENGINE_STRATEGY_IDS)
    if (
      parsed.strategyId !== undefined &&
      !validStrategyIds.has(parsed.strategyId)
    ) {
      sendJson(
        res,
        400,
        { ok: false, error: `Invalid strategyId: ${String(parsed.strategyId)}` },
        responseHeaders,
      )
      return true
    }

    const validModes = new Set<StrategyLifecycleMode>([
      'disabled',
      'research',
      'paper',
      'canary',
      'scale',
    ])
    if (
      parsed.mode !== undefined &&
      !validModes.has(parsed.mode as StrategyLifecycleMode)
    ) {
      sendJson(
        res,
        400,
        { ok: false, error: `Invalid strategy mode: ${String(parsed.mode)}` },
        responseHeaders,
      )
      return true
    }

    const runner = getPredictionRunner()
    const strategyId = parsed.strategyId as
      | PredictionEngineStrategyId
      | undefined
    const targetMode = parsed.mode as StrategyLifecycleMode | undefined

    if (parsed.canaryConfig !== undefined) {
      const updatedCfg = runner.updateCanaryRiskConfig(
        tenantId,
        parsed.canaryConfig,
      )
      recordAudit(
        principal,
        'prediction.canary.config',
        url.pathname,
        'allowed',
        {
          stakeUsd: updatedCfg.stakeUsd,
          maxDailyLosses: updatedCfg.maxDailyLosses,
          maxDailyLossUsd: updatedCfg.maxDailyLossUsd,
          maxConcurrentBtcExposureUsd: updatedCfg.maxConcurrentBtcExposureUsd,
        },
      )
    }

    if (
      parsed.macroBlackoutWindows !== undefined ||
      parsed.addMacroBlackout !== undefined ||
      parsed.removeMacroBlackoutTimestampMs !== undefined
    ) {
      if (Array.isArray(parsed.macroBlackoutWindows)) {
        runner.setMacroBlackoutWindows(parsed.macroBlackoutWindows)
      }
      if (parsed.addMacroBlackout) {
        runner.addMacroBlackoutWindow(parsed.addMacroBlackout)
      }
      if (typeof parsed.removeMacroBlackoutTimestampMs === 'number') {
        runner.removeMacroBlackoutWindow(parsed.removeMacroBlackoutTimestampMs)
      }
      recordAudit(
        principal,
        'prediction.macro.blackouts',
        url.pathname,
        'allowed',
        {
          count: runner.getMacroBlackoutWindows().length,
        },
      )
    }

    let transition:
      | (PromotionTransitionResult & { state: StoredStrategyState })
      | null = null

    if (
      parsed.halt === true ||
      (parsed.haltedReason && targetMode === undefined) ||
      (targetMode === 'disabled' && parsed.haltedReason)
    ) {
      const reason = parsed.haltedReason?.trim() || 'Manual operator halt'
      if (strategyId) {
        await runner.haltStrategy(tenantId, strategyId, reason)
      } else {
        for (const id of PREDICTION_ENGINE_STRATEGY_IDS) {
          await runner.haltStrategy(tenantId, id, reason)
        }
      }
      recordAudit(
        principal,
        'prediction.strategy.halt',
        strategyId ?? url.pathname,
        'allowed',
        { reason },
      )
    } else if (strategyId && targetMode) {
      transition = await runner.setPredictionStrategyMode(
        tenantId,
        strategyId,
        targetMode,
        Boolean(parsed.forceOverride),
        parsed.overrideReason,
      )

      recordAudit(
        principal,
        transition.toMode === 'canary' || transition.toMode === 'scale'
          ? 'prediction.strategy.promote'
          : 'prediction.strategy.mode_change',
        strategyId,
        transition.allowed ? 'allowed' : 'denied',
        {
          fromMode: transition.fromMode,
          toMode: transition.toMode,
          forcedOverride: transition.forcedOverride,
          overrideReason: parsed.overrideReason ?? null,
        },
      )

      if (!transition.allowed) {
        sendJson(
          res,
          422,
          {
            ok: false,
            error:
              transition.failures.join('; ') ||
              'Promotion gate requirements not met',
            transition,
            status: await runner.getPredictionEngineStatus(tenantId),
          },
          responseHeaders,
        )
        return true
      }
    }

    sendJson(
      res,
      200,
      {
        ok: true,
        transition,
        status: await runner.getPredictionEngineStatus(tenantId),
      },
      responseHeaders,
    )
    return true
  }

  // 25. POST /api/prediction-engine/replay -> Deterministic walk-forward replay & promotion report
  if (req.method === 'POST' && url.pathname === '/api/prediction-engine/replay') {
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
    const body = await readOptionalJsonBody<{ strategyId?: string }>(
      req,
      res,
      responseHeaders,
    )
    if (!body.ok) return true
    const rawId = body.data?.strategyId
    const validIds = new Set<string>(PREDICTION_ENGINE_STRATEGY_IDS)
    if (!rawId || !validIds.has(rawId)) {
      sendJson(
        res,
        400,
        { error: 'Invalid or missing strategyId' },
        responseHeaders,
      )
      return true
    }
    const strategyId = rawId as PredictionEngineStrategyId
    const report = await getPredictionRunner().runStrategyReplay(strategyId)
    recordAudit(principal, 'prediction.strategy.replay', strategyId, 'allowed', {
      settledWindowCount: report.settledWindowCount,
      tradeCount: report.tradeCount,
      eligibleForCanary: report.eligibleForCanary,
    })
    sendJson(res, 200, { ok: true, report, ...report }, responseHeaders)
    return true
  }

  // ============================================================================
  // Training Pipeline & Historical Candle Archive API
  // ============================================================================

  // 26. GET /api/market/history?pair=&interval=&from=&to=
  if (req.method === 'GET' && url.pathname === '/api/market/history') {
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
    const rawPair = (url.searchParams.get('pair') ?? '').trim().toUpperCase()
    const rawInterval = (url.searchParams.get('interval') ?? '').trim() as Interval
    const fromParam = url.searchParams.get('from')
    const toParam = url.searchParams.get('to')

    if (!rawPair || !availablePairs.includes(rawPair)) {
      sendJson(
        res,
        400,
        { error: `Invalid or missing pair "${rawPair}". Allowed: ${availablePairs.join(', ')}.` },
        responseHeaders,
      )
      return true
    }
    if (!VALID_INTERVALS.has(rawInterval)) {
      sendJson(
        res,
        400,
        { error: `Invalid or missing interval "${rawInterval}".` },
        responseHeaders,
      )
      return true
    }
    const fromTimeMs = fromParam !== null ? Number(fromParam) : Number.NaN
    const toTimeMs = toParam !== null ? Number(toParam) : Number.NaN
    const stepMs = intervalMs[rawInterval]
    if (
      !Number.isFinite(fromTimeMs) ||
      !Number.isFinite(toTimeMs) ||
      fromTimeMs < 0 ||
      fromTimeMs >= toTimeMs
    ) {
      sendJson(
        res,
        400,
        { error: 'Invalid range: `from` and `to` must be valid timestamps with `from < to`.' },
        responseHeaders,
      )
      return true
    }
    if (toTimeMs > Date.now() + stepMs) {
      sendJson(
        res,
        400,
        { error: 'Historical candle range cannot end in the future.' },
        responseHeaders,
      )
      return true
    }
    const estimatedBars = Math.floor((toTimeMs - fromTimeMs) / stepMs) + 1
    if (estimatedBars > MAX_HISTORY_BARS) {
      sendJson(
        res,
        400,
        {
          error: `Requested range spans ~${estimatedBars} bars, exceeding the ${MAX_HISTORY_BARS}-bar limit.`,
        },
        responseHeaders,
      )
      return true
    }

    try {
      const history = await fetchHistoricalCandles(
        rawPair,
        rawInterval,
        Math.floor(fromTimeMs),
        Math.floor(toTimeMs),
      )
      sendJson(res, 200, history, responseHeaders)
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

  // 27. POST /api/training/runs -> Create a persisted `running` training run (idempotent on clientRunId)
  if (req.method === 'POST' && url.pathname === '/api/training/runs') {
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
    const body = await readOptionalJsonBody<{
      clientRunId?: string
      client_run_id?: string
      config?: unknown
      candleCount?: number
      dataSource?: string
      customPreset?: StrategyPresetPatch
    }>(req, res, responseHeaders)
    if (!body.ok) return true
    const parsed = body.data
    if (!parsed || typeof parsed !== 'object') {
      sendJson(
        res,
        400,
        { error: 'Training run request body is required.' },
        responseHeaders,
      )
      return true
    }

    const clientRunId = String(
      parsed.clientRunId ?? parsed.client_run_id ?? '',
    ).trim()
    if (!clientRunId || !/^[a-zA-Z0-9_-]{1,128}$/.test(clientRunId)) {
      sendJson(
        res,
        400,
        { error: 'clientRunId is required and must be 1–128 alphanumeric, dash, or underscore characters.' },
        responseHeaders,
      )
      return true
    }

    const rawConfig = parsed.config as Partial<TrainingConfig> | undefined
    const presetId =
      typeof rawConfig?.presetId === 'string' ? rawConfig.presetId.trim() : ''
    const resolvedPreset = presetId
      ? resolveTrainingPreset(presetId, parsed.customPreset)
      : null
    if (!resolvedPreset) {
      sendJson(
        res,
        400,
        { error: `Unknown presetId "${presetId}".` },
        responseHeaders,
      )
      return true
    }

    const validated = validateTrainingConfigPayload(rawConfig, resolvedPreset)
    if (!validated.ok) {
      sendJson(res, 400, { error: validated.error }, responseHeaders)
      return true
    }

    const cfg = validated.config
    const candleCount =
      typeof parsed.candleCount === 'number' &&
        Number.isFinite(parsed.candleCount) &&
        parsed.candleCount >= 0
        ? Math.min(MAX_HISTORY_BARS, Math.round(parsed.candleCount))
        : 0
    const dataSource =
      typeof parsed.dataSource === 'string' && parsed.dataSource.trim().length > 0
        ? parsed.dataSource.trim().slice(0, 64)
        : 'binance'

    const nowIso = new Date().toISOString()
    const runId = `TRN-${crypto.randomUUID()}`
    const record: TrainingRunRecord = {
      id: runId,
      tenantId,
      clientRunId,
      kind: cfg.kind,
      presetId: cfg.presetId,
      strategyFamily: getStrategyFamily(resolvedPreset),
      pair: cfg.pair,
      timeframe: cfg.timeframe,
      fromTimeMs: cfg.fromTimeMs,
      toTimeMs: cfg.toTimeMs,
      candleCount,
      status: 'running',
      config: cfg,
      progress: {
        phase: 'preparing',
        foldIndex: 0,
        foldCount: cfg.kind === 'walk-forward' ? cfg.foldCount : 1,
        barIndex: 0,
        barCount: candleCount,
      },
      metrics: null,
      folds: null,
      equity: null,
      trades: null,
      assumptions: cfg.assumptions,
      dataSource,
      error: null,
      createdAt: nowIso,
      completedAt: null,
    }

    const created = await getStateStore().createTrainingRun(record)
    if (created.deduplicated) {
      sendJson(
        res,
        200,
        { run: created.record, deduplicated: true },
        responseHeaders,
      )
      return true
    }

    recordAudit(principal, 'training:create', url.pathname, 'allowed', {
      runId: created.record.id,
      clientRunId,
      kind: cfg.kind,
      presetId: cfg.presetId,
      pair: cfg.pair,
      timeframe: cfg.timeframe,
      foldCount: cfg.foldCount,
    })
    recordRuntimeEvent(tenantId, {
      type: 'OPERATOR',
      severity: 'info',
      source: 'training',
      correlationId: created.record.id,
      message: `[TRAINING] Started ${cfg.kind} run for ${resolvedPreset.name} (${cfg.pair} ${cfg.timeframe}, ${cfg.foldCount} folds).`,
      payload: {
        runId: created.record.id,
        kind: cfg.kind,
        presetId: cfg.presetId,
        pair: cfg.pair,
        timeframe: cfg.timeframe,
      },
    })

    sendJson(
      res,
      201,
      { run: created.record, deduplicated: false },
      responseHeaders,
    )
    return true
  }

  // 28. GET /api/training/runs?presetId=&limit=&reconcileInterrupted=true
  if (req.method === 'GET' && url.pathname === '/api/training/runs') {
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
    let interruptedCount = 0
    if (url.searchParams.get('reconcileInterrupted') === 'true') {
      interruptedCount = await getStateStore().markRunningTrainingRunsInterrupted(
        tenantId,
      )
      if (interruptedCount > 0) {
        recordRuntimeEvent(tenantId, {
          type: 'INFO',
          severity: 'warn',
          source: 'training',
          message: `[TRAINING] Marked ${interruptedCount} unfinished training run(s) as interrupted after reload.`,
          payload: { interruptedCount },
        })
      }
    }
    const presetId = url.searchParams.get('presetId')?.trim() || undefined
    const rawLimit = Number(url.searchParams.get('limit') ?? 50)
    const runs = await getStateStore().listTrainingRuns(tenantId, {
      presetId,
      limit: Number.isFinite(rawLimit) ? rawLimit : 50,
    })
    sendJson(
      res,
      200,
      { tenantId, runs, interruptedCount },
      responseHeaders,
    )
    return true
  }

  // 29. GET /api/training/live?presetId=&from=&to= -> Paper trades + Testnet orders + MT5 unconfirmed
  if (req.method === 'GET' && url.pathname === '/api/training/live') {
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
    const presetId = url.searchParams.get('presetId')?.trim() ?? ''
    if (!presetId) {
      sendJson(
        res,
        400,
        { error: 'Query parameter `presetId` is required.' },
        responseHeaders,
      )
      return true
    }
    const fromRaw = url.searchParams.get('from')
    const toRaw = url.searchParams.get('to')
    const fromMs =
      fromRaw !== null && Number.isFinite(Number(fromRaw))
        ? Number(fromRaw)
        : null
    const toMs =
      toRaw !== null && Number.isFinite(Number(toRaw)) ? Number(toRaw) : null

    const catalogPreset = resolveTrainingPreset(presetId)
    const paperTrades = rt.engineState.closedTrades.filter((t) => {
      if (t.presetId !== presetId) return false
      const ts = t.exitTime ?? t.entryTime ?? Date.parse(t.time)
      if (fromMs !== null && Number.isFinite(ts) && ts < fromMs) return false
      if (toMs !== null && Number.isFinite(ts) && ts > toMs) return false
      return true
    })

    const paperBase = computeMetrics(
      paperTrades,
      catalogPreset?.execution.initialBalance ?? 10_000,
    )
    const paperSummary = computeClosedTradesSummary(
      paperTrades,
      catalogPreset?.strategy.stopLoss,
    )
    const paperWilson =
      paperBase.totalTrades > 0
        ? computeWilsonLowerBoundPct(paperBase.wins, paperBase.totalTrades)
        : null

    const buildVenueActivity = async (
      mode: 'binance-testnet' | 'binance-live',
    ) => {
      const rawOrders = await getStateStore().queryOrders(tenantId, {
        presetId,
        mode,
        limit: 500,
      })
      const orders = rawOrders.filter((o) => {
        const ts = Date.parse(o.timestamp)
        if (fromMs !== null && Number.isFinite(ts) && ts < fromMs) return false
        if (toMs !== null && Number.isFinite(ts) && ts > toMs) return false
        return true
      })
      const filledOrders = orders.filter(
        (o) => o.status === 'FILLED' || o.status === 'PARTIALLY_FILLED',
      )
      const totalNotionalUsd =
        Math.round(
          filledOrders.reduce((acc, o) => acc + o.notionalUsd, 0) * 100,
        ) / 100
      const totalFeesUsd =
        Math.round(
          filledOrders.reduce((acc, o) => acc + (o.fee ?? 0), 0) * 10_000,
        ) / 10_000

      const rawPositions = await getStateStore()
        .queryExchangePositions(tenantId, {
          presetId,
          mode,
          limit: 200,
        })
        .catch(() => [])
      const positions = rawPositions.filter((p) => {
        const ts = Date.parse(p.closedAt ?? p.openedAt)
        if (fromMs !== null && Number.isFinite(ts) && ts < fromMs) return false
        if (toMs !== null && Number.isFinite(ts) && ts > toMs) return false
        return true
      })
      const closedPositions = positions.filter(
        (p) => p.status === 'CLOSED' && p.realizedPnlUsd !== null,
      )
      const openPositionCount = positions.filter(
        (p) => p.status === 'OPEN',
      ).length
      const hasAttributedPnl = closedPositions.length > 0

      let realizedPnlUsd: number | null = null
      let winRatePct: number | null = null
      let profitFactor: number | null = null
      let averageR: number | null = null

      if (hasAttributedPnl) {
        realizedPnlUsd = Number(
          closedPositions
            .reduce((acc, p) => acc + (p.realizedPnlUsd ?? 0), 0)
            .toFixed(4),
        )
        const wins = closedPositions.filter(
          (p) => (p.realizedPnlUsd ?? 0) > 0,
        ).length
        winRatePct = Number(
          ((wins / closedPositions.length) * 100).toFixed(1),
        )
        const grossProfit = closedPositions
          .filter((p) => (p.realizedPnlUsd ?? 0) > 0)
          .reduce((acc, p) => acc + (p.realizedPnlUsd ?? 0), 0)
        const grossLoss = Math.abs(
          closedPositions
            .filter((p) => (p.realizedPnlUsd ?? 0) < 0)
            .reduce((acc, p) => acc + (p.realizedPnlUsd ?? 0), 0),
        )
        profitFactor =
          grossLoss > 1e-9
            ? Number((grossProfit / grossLoss).toFixed(2))
            : grossProfit > 0
              ? 99.99
              : null
        const rValues = closedPositions
          .map((p) => p.rMultiple)
          .filter((r): r is number => typeof r === 'number' && Number.isFinite(r))
        averageR =
          rValues.length > 0
            ? Number(
                (
                  rValues.reduce((acc, r) => acc + r, 0) / rValues.length
                ).toFixed(3),
              )
            : null
      }

      return {
        orderCount: orders.length,
        filledOrderCount: filledOrders.length,
        totalNotionalUsd,
        totalFeesUsd,
        pnlAttributionAvailable: hasAttributedPnl,
        note: hasAttributedPnl
          ? `Realized PnL attributed from ${closedPositions.length} paired ${mode} position(s).`
          : 'PnL attribution not available until exchange position IDs exist. Order-level fills and fees only.',
        closedPositionCount: closedPositions.length,
        openPositionCount,
        realizedPnlUsd,
        winRatePct,
        profitFactor,
        averageR,
        positions: positions.map((p) => ({
          id: p.id,
          mode: p.mode,
          presetId: p.presetId,
          pair: p.pair,
          side: p.side,
          status: p.status,
          entryOrderId: p.entryOrderId,
          entryVenueOrderId: p.entryVenueOrderId,
          exitOrderId: p.exitOrderId,
          exitVenueOrderId: p.exitVenueOrderId,
          entryQty: p.entryQty,
          exitQty: p.exitQty,
          entryAvgPrice: p.entryAvgPrice,
          exitAvgPrice: p.exitAvgPrice,
          totalFeesUsd: Number((p.entryFeeUsd + p.exitFeeUsd).toFixed(6)),
          stopPrice: p.stopPrice,
          targetPrice: p.targetPrice,
          protectionOrderId: p.protectionOrderId,
          realizedPnlUsd: p.realizedPnlUsd,
          rMultiple: p.rMultiple,
          exitReason: p.exitReason,
          openedAt: p.openedAt,
          closedAt: p.closedAt,
        })),
        orders: orders.map((o) => ({
          id: o.id,
          timestamp: o.timestamp,
          pair: o.pair,
          side: o.side,
          notionalUsd: o.notionalUsd,
          filledQty: o.filledQty ?? null,
          avgPrice: o.avgPrice ?? null,
          fee: o.fee ?? null,
          feeAsset: o.feeAsset ?? null,
          status: o.status,
          venueOrderId: o.venueOrderId ?? null,
        })),
      }
    }

    const [testnetActivity, liveActivity] = await Promise.all([
      buildVenueActivity('binance-testnet'),
      buildVenueActivity('binance-live'),
    ])

    const mt5Snap = getMt5BridgeSnapshot(
      rt.engineState,
      rt.activePreset,
      getExchangeStatusSnapshot(tenantId),
    )

    const payload: TrainingLiveShadowResponse = {
      presetId,
      fromTimeMs: fromMs,
      toTimeMs: toMs,
      paper: {
        trades: paperTrades,
        count: paperBase.totalTrades,
        wins: paperBase.wins,
        losses: paperBase.losses,
        winRatePct: paperBase.winRate,
        wilsonLowerBoundPct: paperWilson,
        profitFactor: paperBase.profitFactor,
        netPnlUsd: paperSummary.totalPnlUsd,
        averageR: paperSummary.avgR,
        totalFeesUsd: paperSummary.totalFeesUsd,
      },
      testnet: testnetActivity,
      ...(liveActivity.orderCount > 0 || liveActivity.positions.length > 0
        ? { live: liveActivity }
        : {}),
      mt5: {
        executionState: mt5Snap.executionState,
        signalOnly: true,
        note: 'Signal-only · execution unconfirmed',
        pollCount: mt5Snap.pollCount,
        lastPollAt: mt5Snap.lastPollAt,
      },
    }

    sendJson(res, 200, payload, responseHeaders)
    return true
  }

  // 30. GET /api/exchange/positions -> Durable SQL exchange_positions ledger
  if (req.method === 'GET' && url.pathname === '/api/exchange/positions') {
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
    const modeRaw = url.searchParams.get('mode')?.trim()
    const mode =
      modeRaw === 'binance-testnet' || modeRaw === 'binance-live'
        ? modeRaw
        : undefined
    const statusRaw = url.searchParams.get('status')?.trim().toUpperCase()
    const status =
      statusRaw === 'OPEN' || statusRaw === 'CLOSED' ? statusRaw : undefined
    const presetIdParam = url.searchParams.get('presetId')?.trim() || undefined
    const pairParam = url.searchParams.get('pair')?.trim() || undefined
    const limitParam = Number(url.searchParams.get('limit') ?? 100)
    const positions = await getStateStore().queryExchangePositions(tenantId, {
      mode,
      status,
      presetId: presetIdParam,
      pair: pairParam,
      limit: Number.isFinite(limitParam) ? limitParam : 100,
    })
    sendJson(res, 200, { positions }, responseHeaders)
    return true
  }

  // 31. POST /api/exchange/reconcile -> Reconcile open Binance positions against venue fills
  if (req.method === 'POST' && url.pathname === '/api/exchange/reconcile') {
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
    const report = await reconcileExchangeVenue(tenantId)
    if (!report) {
      sendJson(
        res,
        200,
        {
          reconciled: false,
          reason:
            'No Binance Testnet or armed Binance Live venue credentials configured.',
        },
        responseHeaders,
      )
      return true
    }
    if (report.reconciledClosedPositions.length > 0) {
      for (const pos of report.reconciledClosedPositions) {
        recordRuntimeEvent(tenantId, {
          type: 'TRADE',
          severity: 'info',
          source: report.mode,
          correlationId: pos.id,
          message: `[RECONCILED] ${pos.pair} closed on ${report.mode} (${pos.exitReason ?? 'venue'}) · PnL ${pos.realizedPnlUsd !== null && pos.realizedPnlUsd >= 0 ? '+' : ''}$${(pos.realizedPnlUsd ?? 0).toFixed(2)}`,
        })
      }
      saveStateToDisk(tenantId)
      broadcastSseUpdate(tenantId)
    }
    recordAudit(principal, 'exchange:reconcile', url.pathname, 'allowed', {
      mode: report.mode,
      checked: report.checkedOpenPositions,
      reconciledClosed: report.reconciledClosedPositions.length,
    })
    sendJson(res, 200, { reconciled: true, report }, responseHeaders)
    return true
  }

  // 32. GET /api/alerts/status -> External alert dispatcher configuration & telemetry
  if (req.method === 'GET' && url.pathname === '/api/alerts/status') {
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
    sendJson(res, 200, getAlertDispatcherStatus(), responseHeaders)
    return true
  }

  // 33. POST /api/alerts/test -> Send a forced test alert to verify Telegram/Webhook delivery
  if (req.method === 'POST' && url.pathname === '/api/alerts/test') {
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
    const outcome = await dispatchRuntimeAlert(
      {
        tenantId,
        type: 'OPERATOR',
        severity: 'info',
        source: 'alerts-test',
        correlationId: `test-${Date.now()}`,
        timestamp: new Date().toISOString(),
        message: `[TEST] Operator alert connectivity check triggered by ${principal.subject}.`,
      },
      { force: true },
    )
    recordAudit(principal, 'alerts:test', url.pathname, 'allowed', {
      dispatched: outcome.dispatched,
      channels: outcome.results.length,
    })
    sendJson(
      res,
      200,
      { ...outcome, status: getAlertDispatcherStatus() },
      responseHeaders,
    )
    return true
  }

  // 30. POST /api/training/runs/:id/cancel -> Idempotent run cancellation
  const trainingCancelMatch = /^\/api\/training\/runs\/([^/]+)\/cancel$/.exec(
    url.pathname,
  )
  if (req.method === 'POST' && trainingCancelMatch) {
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
    const runId = decodeURIComponent(trainingCancelMatch[1])
    const existing = await getStateStore().getTrainingRunById(tenantId, runId)
    if (!existing) {
      sendJson(
        res,
        404,
        { error: `Training run "${runId}" not found.` },
        responseHeaders,
      )
      return true
    }
    if (existing.status === 'cancelled') {
      sendJson(
        res,
        200,
        { run: existing, alreadyCancelled: true },
        responseHeaders,
      )
      return true
    }
    if (existing.status === 'completed' || existing.status === 'failed') {
      sendJson(
        res,
        409,
        { error: `Training run "${runId}" is already ${existing.status}.` },
        responseHeaders,
      )
      return true
    }

    const updated = await getStateStore().updateTrainingRun(tenantId, runId, {
      status: 'cancelled',
      error: 'Cancelled by operator',
      completedAt: new Date().toISOString(),
    })
    recordAudit(principal, 'training:cancel', url.pathname, 'allowed', {
      runId,
      presetId: existing.presetId,
    })
    recordRuntimeEvent(tenantId, {
      type: 'OPERATOR',
      severity: 'info',
      source: 'training',
      correlationId: runId,
      message: `[TRAINING] Cancelled run ${runId} (${existing.presetId}) by ${principal.subject}.`,
      payload: { runId, presetId: existing.presetId },
    })

    sendJson(
      res,
      200,
      { run: updated ?? existing, alreadyCancelled: false },
      responseHeaders,
    )
    return true
  }

  // 31. GET & PATCH /api/training/runs/:id
  const trainingRunMatch = /^\/api\/training\/runs\/([^/]+)$/.exec(
    url.pathname,
  )
  if (trainingRunMatch && req.method === 'GET') {
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
    const runId = decodeURIComponent(trainingRunMatch[1])
    const run = await getStateStore().getTrainingRunById(tenantId, runId)
    if (!run) {
      sendJson(
        res,
        404,
        { error: `Training run "${runId}" not found.` },
        responseHeaders,
      )
      return true
    }
    sendJson(res, 200, { run }, responseHeaders)
    return true
  }

  if (trainingRunMatch && req.method === 'PATCH') {
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
    const runId = decodeURIComponent(trainingRunMatch[1])
    const existing = await getStateStore().getTrainingRunById(tenantId, runId)
    if (!existing) {
      sendJson(
        res,
        404,
        { error: `Training run "${runId}" not found.` },
        responseHeaders,
      )
      return true
    }

    const body = await readOptionalJsonBody<{
      status?: TrainingRunStatus
      candleCount?: number
      progress?: TrainingProgress | null
      metrics?: TrainingRunMetrics | null
      folds?: TrainingFoldResult[] | null
      equity?: TrainingEquityPoint[] | null
      trades?: TrainingTradeRecord[] | null
      dataSource?: string
      error?: string | null
    }>(req, res, responseHeaders, MAX_TRAINING_BODY_BYTES)
    if (!body.ok) return true
    const parsed = body.data
    if (!parsed || typeof parsed !== 'object') {
      sendJson(
        res,
        400,
        { error: 'Training run update body is required.' },
        responseHeaders,
      )
      return true
    }

    if (
      parsed.status !== undefined &&
      !VALID_TRAINING_STATUSES.has(parsed.status)
    ) {
      sendJson(
        res,
        400,
        { error: `Invalid training status "${String(parsed.status)}".` },
        responseHeaders,
      )
      return true
    }

    if (existing.status === 'cancelled' && parsed.status === 'completed') {
      sendJson(
        res,
        409,
        { error: `Training run "${runId}" was cancelled and cannot be completed.` },
        responseHeaders,
      )
      return true
    }

    const nowIso = new Date().toISOString()

    if (parsed.status === 'completed') {
      if (!Array.isArray(parsed.trades) || !parsed.metrics || typeof parsed.metrics !== 'object') {
        sendJson(
          res,
          400,
          { error: 'Completing a training run requires `trades` array and `metrics` object.' },
          responseHeaders,
        )
        return true
      }

      for (let i = 0; i < parsed.trades.length; i += 1) {
        const t = parsed.trades[i]
        if (
          !t ||
          typeof t !== 'object' ||
          typeof t.pnl !== 'number' ||
          !Number.isFinite(t.pnl) ||
          typeof t.entryPrice !== 'number' ||
          !Number.isFinite(t.entryPrice) ||
          typeof t.exitPrice !== 'number' ||
          !Number.isFinite(t.exitPrice) ||
          typeof t.size !== 'number' ||
          !Number.isFinite(t.size) ||
          (t.side !== 'buy' && t.side !== 'sell') ||
          typeof t.time !== 'string'
        ) {
          sendJson(
            res,
            400,
            { error: `Invalid trade record at index ${i}.` },
            responseHeaders,
          )
          return true
        }
      }

      const catalogPreset = resolveTrainingPreset(existing.presetId)
      const recomputed = computeCanonicalTrainingMetrics(
        parsed.trades,
        existing.assumptions.initialBalance,
        {
          fallbackStopLossPct: catalogPreset?.strategy.stopLoss,
          overrideReason: parsed.metrics.overrideReason ?? null,
        },
      )

      const mismatches = verifySubmittedTrainingMetrics(
        parsed.metrics,
        recomputed,
        parsed.trades.length,
      )

      if (mismatches.length > 0) {
        recordAudit(principal, 'training:complete', url.pathname, 'denied', {
          runId,
          presetId: existing.presetId,
          mismatchCount: mismatches.length,
        })
        recordRuntimeEvent(tenantId, {
          type: 'ERROR',
          severity: 'error',
          source: 'training',
          correlationId: runId,
          message: `[TRAINING] Rejected tampered/mismatched metrics for run ${runId}: ${mismatches[0]}`,
          payload: { runId, mismatches },
        })
        sendJson(
          res,
          422,
          {
            error: 'Submitted training metrics failed server-side verification.',
            mismatches,
          },
          responseHeaders,
        )
        return true
      }

      const verifiedMetrics: TrainingRunMetrics = {
        ...recomputed,
        ...(parsed.metrics.candidatesEvaluated !== undefined
          ? { candidatesEvaluated: parsed.metrics.candidatesEvaluated }
          : {}),
        ...(parsed.metrics.bestSelectedParams !== undefined
          ? { bestSelectedParams: parsed.metrics.bestSelectedParams }
          : {}),
        ...(parsed.metrics.paramDiffs !== undefined
          ? { paramDiffs: parsed.metrics.paramDiffs }
          : {}),
        ...(parsed.metrics.candidates !== undefined
          ? { candidates: parsed.metrics.candidates }
          : {}),
        ...(parsed.metrics.metaComparison !== undefined
          ? { metaComparison: parsed.metrics.metaComparison }
          : {}),
        ...(parsed.metrics.predictionSummary !== undefined
          ? { predictionSummary: parsed.metrics.predictionSummary }
          : {}),
      }

      const nextCandleCount =
        typeof parsed.candleCount === 'number' &&
          Number.isFinite(parsed.candleCount) &&
          parsed.candleCount > 0
          ? Math.min(MAX_HISTORY_BARS, Math.round(parsed.candleCount))
          : existing.candleCount
      const nextDataSource =
        typeof parsed.dataSource === 'string' && parsed.dataSource.trim().length > 0
          ? parsed.dataSource.trim().slice(0, 64)
          : existing.dataSource

      const updated = await getStateStore().updateTrainingRun(tenantId, runId, {
        status: 'completed',
        candleCount: nextCandleCount,
        progress: {
          phase: 'finalizing',
          foldIndex: existing.config.kind === 'walk-forward' ? existing.config.foldCount : 1,
          foldCount: existing.config.kind === 'walk-forward' ? existing.config.foldCount : 1,
          barIndex: nextCandleCount,
          barCount: nextCandleCount,
        },
        metrics: verifiedMetrics,
        folds: Array.isArray(parsed.folds) ? parsed.folds : existing.folds,
        equity: Array.isArray(parsed.equity) ? parsed.equity : existing.equity,
        trades: parsed.trades,
        dataSource: nextDataSource,
        error: null,
        completedAt: nowIso,
      })

      // Mirror verified OOS summary to `strategy_audits` so Strategy Audit stays unified
      const auditRow: StrategyAuditRecord = {
        id: `SAUD-${crypto.randomUUID()}`,
        tenantId,
        runId,
        createdAt: nowIso,
        presetId: existing.presetId,
        presetName: catalogPreset?.name ?? existing.presetId,
        domain:
          existing.kind === 'prediction-market'
            ? 'prediction-market'
            : 'crypto-spot',
        pair: existing.pair,
        timeframe: existing.timeframe,
        fromTimeMs: existing.fromTimeMs,
        toTimeMs: existing.toTimeMs,
        candles: nextCandleCount,
        metrics: {
          totalOperations: verifiedMetrics.totalTrades,
          wins: verifiedMetrics.wins,
          losses: verifiedMetrics.losses,
          winRatePct:
            verifiedMetrics.winRate !== null
              ? Math.round(verifiedMetrics.winRate * 10) / 10
              : 0,
          wilsonLowerBoundPct: verifiedMetrics.wilsonLowerBoundPct ?? 0,
          netPnlUsd: verifiedMetrics.netPnl,
          returnPct: Math.round(verifiedMetrics.returnPct * 100) / 100,
          profitFactor:
            verifiedMetrics.profitFactor !== null
              ? Math.round(verifiedMetrics.profitFactor * 100) / 100
              : null,
          maxDrawdownPct:
            Math.round(verifiedMetrics.maxDrawdownPct * 100) / 100,
        },
        assumptions: existing.assumptions,
        dataSource: nextDataSource,
      }
      await getStateStore()
        .appendStrategyAudit(auditRow)
        .catch(() => { })

      recordAudit(principal, 'training:complete', url.pathname, 'allowed', {
        runId,
        presetId: existing.presetId,
        kind: existing.kind,
        totalTrades: verifiedMetrics.totalTrades,
        verdict: verifiedMetrics.verdict,
        netPnl: verifiedMetrics.netPnl,
      })
      recordRuntimeEvent(tenantId, {
        type: 'INFO',
        severity: 'info',
        source: 'training',
        correlationId: runId,
        message: `[TRAINING] Completed ${existing.kind} run ${runId} (${existing.presetId}): ${verifiedMetrics.totalTrades} OOS trades, verdict ${verifiedMetrics.verdict}, PnL ${verifiedMetrics.netPnl >= 0 ? '+' : ''}$${verifiedMetrics.netPnl.toFixed(2)}.`,
        payload: {
          runId,
          presetId: existing.presetId,
          verdict: verifiedMetrics.verdict,
          totalTrades: verifiedMetrics.totalTrades,
          netPnl: verifiedMetrics.netPnl,
        },
      })

      sendJson(res, 200, { run: updated ?? existing }, responseHeaders)
      return true
    }

    if (parsed.status === 'failed') {
      const errorMsg =
        typeof parsed.error === 'string' && parsed.error.trim().length > 0
          ? parsed.error.trim().slice(0, 500)
          : 'Training run failed'
      const updated = await getStateStore().updateTrainingRun(tenantId, runId, {
        status: 'failed',
        error: errorMsg,
        completedAt: nowIso,
      })
      recordAudit(principal, 'training:fail', url.pathname, 'error', {
        runId,
        presetId: existing.presetId,
        error: errorMsg,
      })
      recordRuntimeEvent(tenantId, {
        type: 'ERROR',
        severity: 'error',
        source: 'training',
        correlationId: runId,
        message: `[TRAINING] Failed run ${runId} (${existing.presetId}): ${errorMsg}`,
        payload: { runId, error: errorMsg },
      })
      sendJson(res, 200, { run: updated ?? existing }, responseHeaders)
      return true
    }

    if (parsed.status === 'cancelled' || parsed.status === 'interrupted') {
      const reason =
        typeof parsed.error === 'string' && parsed.error.trim().length > 0
          ? parsed.error.trim().slice(0, 500)
          : parsed.status === 'cancelled'
            ? 'Cancelled by operator'
            : 'Run interrupted before completion'
      const updated = await getStateStore().updateTrainingRun(tenantId, runId, {
        status: parsed.status,
        error: reason,
        completedAt: nowIso,
      })
      recordAudit(
        principal,
        `training:${parsed.status}`,
        url.pathname,
        'allowed',
        { runId, presetId: existing.presetId },
      )
      recordRuntimeEvent(tenantId, {
        type: parsed.status === 'cancelled' ? 'OPERATOR' : 'INFO',
        severity: parsed.status === 'cancelled' ? 'info' : 'warn',
        source: 'training',
        correlationId: runId,
        message: `[TRAINING] Run ${runId} (${existing.presetId}) marked ${parsed.status}: ${reason}`,
      })
      sendJson(res, 200, { run: updated ?? existing }, responseHeaders)
      return true
    }

    // Progress-only update while running
    const updated = await getStateStore().updateTrainingRun(tenantId, runId, {
      progress: parsed.progress !== undefined ? parsed.progress : existing.progress,
      candleCount:
        typeof parsed.candleCount === 'number' && Number.isFinite(parsed.candleCount)
          ? Math.min(MAX_HISTORY_BARS, Math.round(parsed.candleCount))
          : undefined,
      dataSource:
        typeof parsed.dataSource === 'string' && parsed.dataSource.trim().length > 0
          ? parsed.dataSource.trim().slice(0, 64)
          : undefined,
    })
    sendJson(res, 200, { run: updated ?? existing }, responseHeaders)
    return true
  }

  sendJson(res, 404, { error: 'API route not found' }, responseHeaders)
  return true
}
