import type { BacktestSnapshot } from '../backtest'
import type {
  BotEngineState,
  BotPresetAccuracyReport,
  StrategyPreset,
  StrategyPresetPatch,
} from '../botEngine'
import type {
  CanaryRiskConfig,
  EngineTimeframe,
  MacroBlackoutWindow,
  PredictionEngineStrategyId,
  PromotionTransitionResult,
  StrategyLifecycleMode,
} from '../prediction/engine/types'
import type { PromotionReport } from '../prediction/replayHarness'
import type { Candle, Interval, Strategy } from '../types'
import type {
  BotOwnedTestnetPosition,
  ExchangeAccountResponse,
  ExchangeAdapterMode,
  ExchangeBalance,
  ExchangeOrderRecord,
  ExchangeOrderStatus,
  ExchangeStatusSnapshot,
  HardRiskLimits,
} from '../server/exchangeAdapter'
import type {
  Mt5AckStatus,
  Mt5Action,
  Mt5BridgeSnapshot,
  Mt5ExecutionAck,
  Mt5ExecutionState,
  Mt5ReportedPosition,
  Mt5SignalPacket,
  Mt5TerminalTelemetry,
} from '../server/mt5Bridge'
import type {
  PolymarketSnapshot,
  PolymarketTimeframe,
} from '../server/polymarketAdapter'
import type {
  PredictionCalibratorSummary,
  PredictionEngineStatus,
  PredictionGateTelemetry,
  PredictionStrategyLiveStats,
  PredictionStrategyStatusView,
} from '../server/prediction/predictionRunner'
import type {
  CollectedWindowRecord,
  RuntimeEventRecord,
  RuntimeEventSeverity,
  RuntimeEventType,
  StoredPredictionTrade,
  StoredStrategyState,
  StrategyAuditAssumptions,
  StrategyAuditMetrics,
  StrategyAuditRecord,
} from '../server/store/types'

export type {
  BotOwnedTestnetPosition,
  CanaryRiskConfig,
  CollectedWindowRecord,
  EngineTimeframe,
  ExchangeAccountResponse,
  ExchangeAdapterMode,
  ExchangeBalance,
  ExchangeOrderRecord,
  ExchangeOrderStatus,
  ExchangeStatusSnapshot,
  HardRiskLimits,
  MacroBlackoutWindow,
  Mt5AckStatus,
  Mt5Action,
  Mt5BridgeSnapshot,
  Mt5ExecutionAck,
  Mt5ExecutionState,
  Mt5ReportedPosition,
  Mt5SignalPacket,
  Mt5TerminalTelemetry,
  PredictionCalibratorSummary,
  PredictionEngineStatus,
  PredictionGateTelemetry,
  PredictionEngineStrategyId,
  PredictionStrategyLiveStats,
  PredictionStrategyStatusView,
  PromotionReport,
  PromotionTransitionResult,
  RuntimeEventRecord,
  RuntimeEventSeverity,
  RuntimeEventType,
  StoredPredictionTrade,
  StoredStrategyState,
  StrategyAuditAssumptions,
  StrategyAuditMetrics,
  StrategyAuditRecord,
  StrategyLifecycleMode,
}

export type StreamConnectionStatus =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'offline'

export type BackendConnectionMode = 'sse-live' | 'http-server'

export class BackendApiError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'BackendApiError'
    this.status = status
  }
}

type ServerCacheTelemetry = {
  hits: number
  misses: number
  coalescedRequests: number
  binanceErrors: number
  hitRatePct: number
  avgLatencyMs: number
  lastSource: 'binance' | 'binance-cache' | null
  activeCacheEntries: number
}

export type ServerTelemetrySnapshot = {
  uptimeSec: number
  lastTickAt: string | null
  lastTickLatencyMs: number
  tickCount: number
  connectedStreamClients: number
  sseSeq?: number
  lastDataSource?: 'binance' | 'binance-cache' | 'unavailable' | null
  lastQuoteError?: string | null
  cache: ServerCacheTelemetry
}

export type BotServerSnapshot = {
  seq?: number
  frameType?: 'snapshot' | 'delta'
  running: boolean
  paused?: boolean
  accountMode?: ExchangeAdapterMode
  preset: StrategyPreset
  presets: StrategyPreset[]
  state: BotEngineState
  telemetry?: ServerTelemetrySnapshot
  exchange?: ExchangeStatusSnapshot
  mt5?: Mt5BridgeSnapshot
  connectionMode?: BackendConnectionMode
}

export type BotAccuracyReportItem = BotPresetAccuracyReport & {
  pair?: string
  dataSource: string
  fetchLatencyMs?: number
  fromTimeMs?: number
  toTimeMs?: number
  candles?: number
  assumptions?: StrategyAuditAssumptions
}

export type BotAccuracyResponse = {
  runId?: string
  evaluatedAt: string
  candleSampleSize: number
  reports: BotAccuracyReportItem[]
}

const API_ENDPOINTS = ['/api', 'http://localhost:3001/api']
const API_TOKEN_STORAGE_KEY = 'flare:api-token'
const API_BASE_URL_STORAGE_KEY = 'flare:api-base-url'
const API_TENANT_STORAGE_KEY = 'flare:api-tenant-id'

let resolvedBaseUrl: string | null = null
let inMemoryApiToken: string | null = null

export function getApiAuthToken(): string | null {
  if (inMemoryApiToken) return inMemoryApiToken
  try {
    if (typeof window !== 'undefined') {
      // Remove any legacy localStorage token to avoid long-lived secret persistence
      if (window.localStorage?.getItem(API_TOKEN_STORAGE_KEY)) {
        window.localStorage.removeItem(API_TOKEN_STORAGE_KEY)
      }
      const stored = window.sessionStorage
        ?.getItem(API_TOKEN_STORAGE_KEY)
        ?.trim()
      if (stored) {
        inMemoryApiToken = stored
        return stored
      }
    }
  } catch {
    // Ignore storage access errors
  }
  return null
}

export function setApiAuthToken(token: string | null): void {
  const cleaned = token?.trim() ?? ''
  inMemoryApiToken = cleaned || null
  try {
    if (typeof window !== 'undefined') {
      window.localStorage?.removeItem(API_TOKEN_STORAGE_KEY)
      if (cleaned) {
        window.sessionStorage?.setItem(API_TOKEN_STORAGE_KEY, cleaned)
      } else {
        window.sessionStorage?.removeItem(API_TOKEN_STORAGE_KEY)
      }
    }
  } catch {
    // Ignore storage access errors
  }
}

export function getApiBaseUrl(): string {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return (
        window.localStorage
          .getItem(API_BASE_URL_STORAGE_KEY)
          ?.trim()
          .replace(/\/+$/, '') ?? ''
      )
    }
  } catch {
    // Ignore storage access errors
  }
  return ''
}

export function setApiBaseUrl(url: string | null): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const cleaned = url?.trim().replace(/\/+$/, '') ?? ''
      if (cleaned) {
        window.localStorage.setItem(API_BASE_URL_STORAGE_KEY, cleaned)
      } else {
        window.localStorage.removeItem(API_BASE_URL_STORAGE_KEY)
      }
      resolvedBaseUrl = cleaned || null
    }
  } catch {
    // Ignore storage access errors
  }
}

export function getApiTenantId(): string {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(API_TENANT_STORAGE_KEY)?.trim() ?? ''
    }
  } catch {
    // Ignore storage access errors
  }
  return ''
}

export function setApiTenantId(tenantId: string | null): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const cleaned = tenantId?.trim() ?? ''
      if (cleaned) {
        window.localStorage.setItem(API_TENANT_STORAGE_KEY, cleaned)
      } else {
        window.localStorage.removeItem(API_TENANT_STORAGE_KEY)
      }
    }
  } catch {
    // Ignore storage access errors
  }
}

function resolveCandidateEndpoints(): string[] {
  const customBase = getApiBaseUrl()
  if (customBase) return [customBase]
  return resolvedBaseUrl
    ? [resolvedBaseUrl, ...API_ENDPOINTS.filter((u) => u !== resolvedBaseUrl)]
    : API_ENDPOINTS
}

function buildAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  const token = getApiAuthToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const tenantId = getApiTenantId()
  if (tenantId) headers['X-Tenant-Id'] = tenantId
  return headers
}

function createClientOrderId(prefix = 'ord'): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export type BackendHealthResult = {
  ok: boolean
  status: number | null
  latencyMs: number
  baseUrl: string
  uptimeSec?: number
  storeDriver?: string
  sharedStateBackend?: string
  error?: string
}

export async function checkBackendHealth(): Promise<BackendHealthResult> {
  const candidates = resolveCandidateEndpoints()
  const started = Date.now()
  let lastError = 'Backend unreachable'
  let lastStatus: number | null = null
  let lastBase = candidates[0] ?? '/api'

  for (const base of candidates) {
    lastBase = base
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3_500)
    try {
      const res = await fetch(`${base}/health`, {
        method: 'GET',
        headers: buildAuthHeaders(),
        signal: controller.signal,
      })
      clearTimeout(timeout)
      lastStatus = res.status
      if (res.ok) {
        const data = (await res.json()) as {
          uptimeSec?: number
          storeDriver?: string
          sharedStateBackend?: string
        }
        resolvedBaseUrl = base
        return {
          ok: true,
          status: res.status,
          latencyMs: Math.max(1, Date.now() - started),
          baseUrl: base,
          uptimeSec: data.uptimeSec,
          storeDriver: data.storeDriver,
          sharedStateBackend: data.sharedStateBackend,
        }
      }
      const errBody = await res.text().catch(() => '')
      lastError = errBody
        ? `HTTP ${res.status}: ${errBody.slice(0, 140)}`
        : `HTTP ${res.status}`
    } catch (err) {
      clearTimeout(timeout)
      lastError = err instanceof Error ? err.message : 'Network error'
    }
  }

  return {
    ok: false,
    status: lastStatus,
    latencyMs: Math.max(1, Date.now() - started),
    baseUrl: lastBase,
    error: lastError,
  }
}

export type BackendFetchResult<T> =
  | { ok: true; data: T; status: number; baseUrl: string }
  | { ok: false; status: number | null; error: string; data?: T }

export async function requestBackend<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = 5_000,
): Promise<BackendFetchResult<T>> {
  const candidates = resolveCandidateEndpoints()
  let lastError = 'Backend server unreachable. Start it with `pnpm server`.'
  let lastStatus: number | null = null

  for (const base of candidates) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const onExternalAbort = () => controller.abort()
    init?.signal?.addEventListener('abort', onExternalAbort, { once: true })
    try {
      const response = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...buildAuthHeaders(),
          ...(init?.headers ?? {}),
        },
        signal: controller.signal,
      })
      clearTimeout(timeout)
      init?.signal?.removeEventListener('abort', onExternalAbort)

      const contentType = response.headers.get('content-type') ?? ''
      const isJson = contentType.includes('application/json')

      if (response.ok && isJson) {
        const data = (await response.json()) as T
        resolvedBaseUrl = base
        return { ok: true, data, status: response.status, baseUrl: base }
      }

      // If we hit Vite HTML fallback on `/api` when server middleware isn't mounted, try next candidate
      if (!isJson && base === '/api' && candidates.length > 1) {
        lastStatus = response.status
        continue
      }

      lastStatus = response.status
      if (isJson) {
        const errPayload = (await response.json().catch(() => null)) as
          | (T & { error?: string })
          | null
        const message =
          errPayload?.error ?? `Request failed with HTTP ${response.status}`
        return {
          ok: false,
          status: response.status,
          error: message,
          data: errPayload ?? undefined,
        }
      }
      const errText = await response.text().catch(() => '')
      return {
        ok: false,
        status: response.status,
        error: errText.slice(0, 160) || `HTTP ${response.status}`,
      }
    } catch (err) {
      clearTimeout(timeout)
      init?.signal?.removeEventListener('abort', onExternalAbort)
      if (err instanceof Error && err.name === 'AbortError') {
        lastError = 'Backend request timed out.'
      } else if (err instanceof Error) {
        lastError = err.message
      }
    }
  }

  return { ok: false, status: lastStatus, error: lastError }
}

async function fetchFromBackend<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = 5_000,
): Promise<{ data: T; baseUrl: string } | null> {
  const res = await requestBackend<T>(path, init, timeoutMs)
  if (res.ok) {
    return { data: res.data, baseUrl: res.baseUrl }
  }
  return null
}

/**
 * Fetches current server runtime status. Returns `null` when the backend
 * is offline or unreachable — never fabricates a local fallback snapshot.
 */
export async function getBotStatus(): Promise<BotServerSnapshot | null> {
  const res = await requestBackend<BotServerSnapshot>('/bot/status', {
    method: 'GET',
  })
  if (!res.ok) return null
  return {
    ...res.data,
    connectionMode: 'http-server',
  }
}

export async function startBotOnServer(params?: {
  presetId?: string
  strategy?: Strategy
}): Promise<BotServerSnapshot> {
  const res = await requestBackend<BotServerSnapshot>('/bot/start', {
    method: 'POST',
    body: JSON.stringify(params ?? {}),
  })
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return { ...res.data, connectionMode: 'http-server' }
}

export async function stopBotOnServer(): Promise<BotServerSnapshot> {
  const res = await requestBackend<BotServerSnapshot>('/bot/stop', {
    method: 'POST',
  })
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return { ...res.data, connectionMode: 'http-server' }
}

export async function pauseBotOnServer(): Promise<BotServerSnapshot> {
  const res = await requestBackend<BotServerSnapshot>('/bot/pause', {
    method: 'POST',
  })
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return { ...res.data, connectionMode: 'http-server' }
}

export async function resumeBotOnServer(): Promise<BotServerSnapshot> {
  const res = await requestBackend<BotServerSnapshot>('/bot/resume', {
    method: 'POST',
  })
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return { ...res.data, connectionMode: 'http-server' }
}

export async function resetBotOnServer(): Promise<BotServerSnapshot> {
  const res = await requestBackend<BotServerSnapshot>('/bot/reset', {
    method: 'POST',
  })
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return { ...res.data, connectionMode: 'http-server' }
}

export async function fundPaperAccountOnServer(
  amountUsd: number,
): Promise<BotServerSnapshot> {
  const res = await requestBackend<BotServerSnapshot>('/paper/fund', {
    method: 'POST',
    body: JSON.stringify({ amountUsd }),
  })
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return { ...res.data, connectionMode: 'http-server' }
}

export async function selectBotPresetOnServer(params: {
  presetId?: string
  strategy?: Strategy
  timeframe?: Interval
  customPreset?: StrategyPresetPatch
  reset?: boolean
}): Promise<BotServerSnapshot> {
  const res = await requestBackend<BotServerSnapshot>('/bot/preset', {
    method: 'POST',
    body: JSON.stringify(params),
  })
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return { ...res.data, connectionMode: 'http-server' }
}

export async function triggerImmediateBotTick(): Promise<BotServerSnapshot> {
  const res = await requestBackend<BotServerSnapshot>(
    '/bot/tick',
    { method: 'POST' },
    10_000,
  )
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return { ...res.data, connectionMode: 'http-server' }
}

export async function fetchExchangeAccount(): Promise<ExchangeAccountResponse | null> {
  const res = await requestBackend<ExchangeAccountResponse>(
    '/exchange/account',
    { method: 'GET' },
    8_000,
  )
  if (!res.ok) return null
  return res.data
}

export async function fetchExchangeOrders(params?: {
  status?: string
  pair?: string
  side?: 'BUY' | 'SELL'
  source?: 'manual' | 'bot-auto'
  limit?: number
  before?: string
}): Promise<ExchangeOrderRecord[]> {
  const qs = new URLSearchParams()
  if (params?.status) qs.set('status', params.status)
  if (params?.pair) qs.set('pair', params.pair)
  if (params?.side) qs.set('side', params.side)
  if (params?.source) qs.set('source', params.source)
  if (params?.limit !== undefined) qs.set('limit', String(params.limit))
  if (params?.before) qs.set('before', params.before)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  const res = await requestBackend<{ orders: ExchangeOrderRecord[] }>(
    `/exchange/orders${suffix}`,
    { method: 'GET' },
  )
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return res.data.orders
}

export async function submitExchangeOrderOnServer(params: {
  pair: string
  side: 'BUY' | 'SELL'
  notionalUsd: number
  clientOrderId?: string
}): Promise<{
  ok: boolean
  error?: string
  deduplicated?: boolean
  order: ExchangeOrderRecord
  bot: BotServerSnapshot
}> {
  const clientOrderId = params.clientOrderId ?? createClientOrderId('manual')
  const res = await requestBackend<{
    ok: boolean
    error?: string
    deduplicated?: boolean
    order: ExchangeOrderRecord
    bot: BotServerSnapshot
  }>(
    '/exchange/order',
    {
      method: 'POST',
      body: JSON.stringify({ ...params, clientOrderId }),
    },
    10_000,
  )
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return {
    ...res.data,
    bot: { ...res.data.bot, connectionMode: 'http-server' },
  }
}

export async function cancelExchangeOrderOnServer(orderId: string): Promise<{
  ok: boolean
  error?: string
  order?: ExchangeOrderRecord
  bot: BotServerSnapshot
}> {
  const res = await requestBackend<{
    ok: boolean
    error?: string
    order?: ExchangeOrderRecord
    bot: BotServerSnapshot
  }>(
    `/exchange/orders/${encodeURIComponent(orderId)}/cancel`,
    { method: 'POST' },
    8_000,
  )
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return {
    ...res.data,
    bot: { ...res.data.bot, connectionMode: 'http-server' },
  }
}

export async function closePositionOnServer(params?: {
  reason?: string
}): Promise<{
  ok: boolean
  paperClosed: boolean
  testnetClosed: boolean
  mt5Pending: boolean
  bot: BotServerSnapshot
}> {
  const res = await requestBackend<{
    ok: boolean
    paperClosed: boolean
    testnetClosed: boolean
    mt5Pending: boolean
    bot: BotServerSnapshot
  }>(
    '/positions/close',
    {
      method: 'POST',
      body: JSON.stringify(params ?? {}),
    },
    10_000,
  )
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return {
    ...res.data,
    bot: { ...res.data.bot, connectionMode: 'http-server' },
  }
}

export async function toggleExchangeKillSwitchOnServer(params: {
  action: 'engage' | 'reset'
  reason?: string
}): Promise<BotServerSnapshot> {
  const res = await requestBackend<BotServerSnapshot>(
    '/exchange/kill-switch',
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
    12_000,
  )
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return { ...res.data, connectionMode: 'http-server' }
}

export async function updateHardLimitsOnServer(
  limits: Partial<HardRiskLimits> & { autoMirrorBotOrders?: boolean },
): Promise<BotServerSnapshot> {
  const res = await requestBackend<BotServerSnapshot>('/exchange/limits', {
    method: 'POST',
    body: JSON.stringify(limits),
  })
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return { ...res.data, connectionMode: 'http-server' }
}

export async function fetchRuntimeEvents(params?: {
  types?: RuntimeEventType[]
  q?: string
  limit?: number
  before?: string
}): Promise<RuntimeEventRecord[]> {
  const qs = new URLSearchParams()
  if (params?.types && params.types.length > 0) {
    qs.set('types', params.types.join(','))
  }
  if (params?.q && params.q.trim().length > 0) {
    qs.set('q', params.q.trim())
  }
  if (params?.limit !== undefined) qs.set('limit', String(params.limit))
  if (params?.before) qs.set('before', params.before)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  const res = await requestBackend<{ events: RuntimeEventRecord[] }>(
    `/events${suffix}`,
    { method: 'GET' },
  )
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return res.data.events
}

export async function fetchBotAccuracyAudit(
  evaluateAll = true,
): Promise<BotAccuracyResponse> {
  const res = await requestBackend<BotAccuracyResponse>(
    `/bot/accuracy?all=${evaluateAll ? 'true' : 'false'}`,
    { method: 'GET' },
    30_000,
  )
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return res.data
}

export async function fetchSinglePresetAccuracyAudit(
  presetId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<BotAccuracyResponse> {
  const qs = new URLSearchParams({ presetId, runId }).toString()
  const res = await requestBackend<BotAccuracyResponse>(
    `/bot/accuracy?${qs}`,
    { method: 'GET', signal },
    20_000,
  )
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return res.data
}

export async function fetchLatestBotAccuracyAudit(): Promise<StrategyAuditRecord[]> {
  const res = await requestBackend<{ audits: StrategyAuditRecord[] }>(
    '/bot/accuracy/latest',
    { method: 'GET' },
  )
  if (!res.ok) return []
  return res.data.audits
}

/**
 * Converts a live backend bot state into a BacktestSnapshot so it can be
 * analyzed on the Stats screen (`Stats.tsx`).
 */
export function buildBacktestSnapshotFromBot(
  snapshot: BotServerSnapshot,
): BacktestSnapshot {
  const { preset, state } = snapshot
  const chronologicalTrades = [...state.closedTrades].reverse()
  const initialBalance = state.initialBalance
  const finalBalance = state.balance
  const netPnl = finalBalance - initialBalance
  const returnPct =
    initialBalance > 0 ? (netPnl / initialBalance) * 100 : 0
  const feesPaid = chronologicalTrades.reduce(
    (sum, t) => sum + (t.fees ?? 0),
    0,
  )
  const firstTime =
    chronologicalTrades.length > 0
      ? chronologicalTrades[0].entryTime
      : Date.now() - 3600_000
  const lastTime =
    chronologicalTrades.length > 0
      ? chronologicalTrades[chronologicalTrades.length - 1].exitTime
      : Date.now()

  return {
    version: 1,
    createdAt: Date.now(),
    label: preset.name,
    timeframe: preset.timeframe,
    config: {
      pair: preset.strategy.pair,
      params: preset.signalParams,
      strategy: {
        positionSize: preset.strategy.positionSize,
        stopLoss: preset.strategy.stopLoss,
        takeProfit: preset.strategy.takeProfit,
        maxDailyRisk: preset.strategy.maxDailyRisk,
      },
      settings: preset.execution,
    },
    candles: {
      from: firstTime,
      to: lastTime,
      count: Math.max(100, state.closedTrades.length + 100),
    },
    trades: chronologicalTrades,
    summary: {
      initialBalance,
      finalBalance,
      netPnl,
      returnPct,
      feesPaid,
      bankrupt: finalBalance <= 0,
    },
  }
}

/**
 * Fetches recent "Bitcoin Up or Down" Polymarket windows via the backend.
 */
export async function fetchPolymarketSnapshot(
  tf: PolymarketTimeframe,
  limit = 48,
): Promise<PolymarketSnapshot> {
  const res = await requestBackend<PolymarketSnapshot>(
    `/predictions/polymarket?tf=${tf}&limit=${limit}`,
    { method: 'GET' },
    10_000,
  )
  if (!res.ok) {
    throw new BackendApiError(
      res.error || 'Unable to fetch Polymarket data from /api/predictions/polymarket',
      res.status,
    )
  }
  return res.data
}

async function consumeFetchSseStream(
  url: string,
  signal: AbortSignal,
  onOpen: () => void,
  onData: (raw: string) => void,
): Promise<void> {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      ...buildAuthHeaders(),
    },
    signal,
  })
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok || !contentType.includes('text/event-stream') || !response.body) {
    throw new Error(`SSE stream unavailable (HTTP ${response.status})`)
  }
  onOpen()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (!signal.aborted) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split(/\r?\n\r?\n/)
    buffer = parts.pop() ?? ''
    for (const block of parts) {
      const dataLines = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
      if (dataLines.length > 0) {
        onData(dataLines.join('\n'))
      }
    }
  }
}

/**
 * Opens a real-time Server-Sent Events subscription (`/api/bot/stream`).
 * Emits explicit connection statuses (`connecting | live | reconnecting | offline`)
 * and never falls back to a client-side simulator.
 */
export function subscribeToBotStream(
  onSnapshot: (snapshot: BotServerSnapshot) => void,
  options?: {
    onStatusChange?: (status: StreamConnectionStatus) => void
  },
): () => void {
  let disposed = false
  let abortController: AbortController | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempts = 0
  let everConnected = false
  let lastSeenSeq = -1
  let cachedPresets: StrategyPreset[] = []

  const emitStatus = (status: StreamConnectionStatus) => {
    if (!disposed) {
      options?.onStatusChange?.(status)
    }
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer) return
    const nextStatus: StreamConnectionStatus =
      everConnected && reconnectAttempts < 3 ? 'reconnecting' : 'offline'
    emitStatus(nextStatus)
    const baseDelay = Math.min(30_000, 1_500 * 2 ** Math.min(reconnectAttempts, 4))
    const jitter = Math.floor(Math.random() * 400)
    reconnectAttempts += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, baseDelay + jitter)
  }

  async function connect(): Promise<void> {
    if (disposed) return
    emitStatus(everConnected ? 'reconnecting' : 'connecting')
    const candidates = resolveCandidateEndpoints()

    for (const base of candidates) {
      if (disposed) return
      const controller = new AbortController()
      abortController = controller
      try {
        await consumeFetchSseStream(
          `${base}/bot/stream`,
          controller.signal,
          () => {
            resolvedBaseUrl = base
            everConnected = true
            reconnectAttempts = 0
            emitStatus('live')
          },
          (raw) => {
            try {
              const parsed = JSON.parse(raw) as Partial<BotServerSnapshot> & {
                seq?: number
              }
              if (typeof parsed.seq === 'number') {
                if (parsed.seq <= lastSeenSeq) return
                lastSeenSeq = parsed.seq
              }
              if (Array.isArray(parsed.presets) && parsed.presets.length > 0) {
                cachedPresets = parsed.presets
              }
              if (!parsed.preset || !parsed.state) return
              const merged: BotServerSnapshot = {
                ...(parsed as BotServerSnapshot),
                presets:
                  Array.isArray(parsed.presets) && parsed.presets.length > 0
                    ? parsed.presets
                    : cachedPresets,
                connectionMode: 'sse-live',
              }
              if (!disposed) {
                onSnapshot(merged)
              }
            } catch {
              // Ignore malformed SSE frames
            }
          },
        )
        if (!disposed) {
          scheduleReconnect()
        }
        return
      } catch {
        if (disposed) return
        // Try next candidate endpoint
      }
    }

    if (!disposed) {
      scheduleReconnect()
    }
  }

  void connect()

  return () => {
    disposed = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    abortController?.abort()
    abortController = null
  }
}

export type GatewayMarketCandlesResponse = {
  pair: string
  interval: Interval
  candles: Candle[]
  source: 'binance' | 'binance-cache'
  latencyMs: number
}

export type GatewayMarketStreamEvent =
  | {
      type: 'snapshot'
      pair: string
      interval: Interval
      source: 'binance' | 'binance-cache'
      candles: Candle[]
      status: string
    }
  | {
      type: 'candle'
      pair: string
      interval: Interval
      candle: Candle
      isClosed: boolean
      gapRecovered?: boolean
    }
  | {
      type: 'status'
      pair: string
      interval: Interval
      status: string
    }

/**
 * Fetches candles through FLARE's shared server-side market-data gateway (`/api/market/candles`).
 */
export async function fetchMarketCandlesFromGateway(
  pair: string,
  interval: Interval,
  limit: number,
  signal?: AbortSignal,
): Promise<GatewayMarketCandlesResponse | null> {
  const qs = `pair=${encodeURIComponent(pair)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(String(limit))}`
  const res = await fetchFromBackend<GatewayMarketCandlesResponse>(
    `/market/candles?${qs}`,
    { method: 'GET', signal },
  )
  if (!res || !Array.isArray(res.data.candles) || res.data.candles.length === 0) {
    return null
  }
  return res.data
}

/**
 * Subscribes to FLARE's shared server-side market-data SSE stream (`/api/market/stream`).
 */
export function subscribeToMarketGatewayStream(
  pair: string,
  interval: Interval,
  limit: number,
  onEvent: (event: GatewayMarketStreamEvent) => void,
  onUnavailable: () => void,
): () => void {
  const base = getApiBaseUrl() || resolvedBaseUrl || '/api'
  const qs = `pair=${encodeURIComponent(pair)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(String(limit))}`
  const url = `${base}/market/stream?${qs}`
  let disposed = false
  let opened = false
  const controller = new AbortController()

  void consumeFetchSseStream(
    url,
    controller.signal,
    () => {
      opened = true
    },
    (raw) => {
      if (disposed) return
      opened = true
      try {
        const parsed = JSON.parse(raw) as GatewayMarketStreamEvent
        onEvent(parsed)
      } catch {
        // Ignore malformed gateway frame
      }
    },
  ).catch(() => {
    if (!disposed && !opened) {
      onUnavailable()
    }
  })

  return () => {
    disposed = true
    controller.abort()
  }
}

export type TenantLedgerView = {
  tenantId: string
  verification: {
    balanced: boolean
    entryCount: number
    unbalancedEntryIds: string[]
  }
  walletBalances: Record<string, number>
  entries: {
    id: string
    timestamp: string
    kind: string
    referenceId: string
    description: string
  }[]
}

export type AuditEventView = {
  id: string
  tenantId: string
  timestamp: string
  actor: string
  role: string
  action: string
  resource: string
  outcome: 'allowed' | 'denied' | 'error'
}

export type TenantAuditView = {
  tenantId: string
  events: AuditEventView[]
}

export type PolymarketReconciliationView = {
  syncedAt: string
  collateralUsd: number
  allowanceUsd: number
  openOrdersCount: number
  recentTradesCount: number
  openOrders: {
    id: string
    market: string
    assetId: string
    side: string
    price: number
    originalSize: number
    sizeMatched: number
    status: string
  }[]
  recentTrades: {
    id: string
    market: string
    assetId: string
    side: string
    price: number
    size: number
    status: string
    matchTime: string
    txHash: string
  }[]
}

export type PolymarketExecutorStatusView = {
  configured: boolean
  liveArmed: boolean
  mode: 'live-clob' | 'read-only'
  host: string
  chainId: number
  signerAddress: string | null
  funderAddress: string | null
  signatureType: number
  hasL2Creds: boolean
  orderCount: number
  recentOrders: {
    id: string
    clientOrderId: string
    venueOrderId?: string
    timestamp: string
    instrumentId: string
    outcome: 'YES' | 'NO'
    side: 'BUY' | 'SELL'
    orderType: 'GTC' | 'GTD' | 'FOK' | 'FAK'
    limitPrice: number
    shares: number
    stakeUsd: number
    feeUsd: number
    status: 'LIVE' | 'MATCHED' | 'CANCELED' | 'REJECTED'
    reason?: string
  }[]
  lastReconciliation: PolymarketReconciliationView | null
}

export type RetentionPruneReportView = {
  retentionDays: number
  cutoffIso: string
  deletedOrders: number
  deletedAuditEvents: number
  deletedCandles: number
}

export async function getTenantLedger(): Promise<TenantLedgerView | null> {
  const res = await fetchFromBackend<TenantLedgerView>('/ledger', {
    method: 'GET',
  })
  return res?.data ?? null
}

export async function getTenantAudit(
  limit = 40,
): Promise<TenantAuditView | null> {
  const res = await fetchFromBackend<TenantAuditView>(
    `/audit?limit=${encodeURIComponent(String(limit))}`,
    { method: 'GET' },
  )
  return res?.data ?? null
}

export async function pruneRetentionOnServer(
  retentionDays = 90,
): Promise<{
  ok: boolean
  report?: RetentionPruneReportView
  error?: string
}> {
  const res = await requestBackend<RetentionPruneReportView>(
    '/admin/retention',
    {
      method: 'POST',
      body: JSON.stringify({ retentionDays }),
    },
    5_000,
  )
  if (res.ok) {
    return { ok: true, report: res.data }
  }
  return { ok: false, error: res.error }
}

export async function getPolymarketExecutionStatus(): Promise<PolymarketExecutorStatusView | null> {
  const res = await fetchFromBackend<PolymarketExecutorStatusView>(
    '/polymarket/status',
    { method: 'GET' },
  )
  return res?.data ?? null
}

export async function submitPolymarketOrderOnServer(params: {
  instrumentId: string
  tokenId: string
  outcome: 'YES' | 'NO'
  bid: number
  ask: number
  asOfMs: number
  source?: 'polymarket-clob' | 'polymarket-gamma' | 'explicit-quote'
  tickSize?: number
  negRisk?: boolean
  side?: 'BUY' | 'SELL'
  stakeUsd: number
  orderType?: 'GTC' | 'GTD' | 'FOK' | 'FAK'
  clientOrderId?: string
}): Promise<Record<string, unknown>> {
  const clientOrderId =
    params.clientOrderId ?? createClientOrderId('poly-manual')
  const res = await requestBackend<Record<string, unknown>>(
    '/polymarket/order',
    {
      method: 'POST',
      body: JSON.stringify({
        clientOrderId,
        side: params.side ?? 'BUY',
        stakeUsd: params.stakeUsd,
        orderType: params.orderType ?? 'FOK',
        quote: {
          instrumentId: params.instrumentId,
          tokenId: params.tokenId,
          outcome: params.outcome,
          bid: params.bid,
          ask: params.ask,
          mid: Number(((params.bid + params.ask) / 2).toFixed(4)),
          spread: Number(Math.max(0, params.ask - params.bid).toFixed(4)),
          asOfMs: params.asOfMs,
          source: params.source ?? 'polymarket-clob',
          tickSize: params.tickSize ?? 0.01,
          negRisk: params.negRisk ?? false,
        },
      }),
    },
  )
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return res.data
}

export async function cancelPolymarketOrderOnServer(params: {
  orderId?: string
  cancelAll?: boolean
  reason?: string
}): Promise<{
  ok: boolean
  error?: string
  polymarket?: PolymarketExecutorStatusView
} | null> {
  const res = await fetchFromBackend<{
    ok: boolean
    error?: string
    polymarket?: PolymarketExecutorStatusView
  }>('/polymarket/cancel', {
    method: 'POST',
    body: JSON.stringify(params),
  })
  return res?.data ?? null
}

export async function reconcilePolymarketAccountOnServer(): Promise<{
  ok: boolean
  snapshot?: PolymarketReconciliationView
  error?: string
}> {
  const res = await requestBackend<PolymarketReconciliationView>(
    '/polymarket/reconcile',
    { method: 'POST' },
    8_000,
  )
  if (res.ok) {
    return { ok: true, snapshot: res.data }
  }
  return { ok: false, error: res.error }
}

export type PredictionEngineWindowsResponse = {
  timeframe: PolymarketTimeframe | null
  limit: number
  settledCountsByTimeframe: Record<PolymarketTimeframe, number>
  windows: CollectedWindowRecord[]
  trades: StoredPredictionTrade[]
}

export type PredictionEngineModeResponse = {
  ok: boolean
  error?: string
  transition?:
    | (PromotionTransitionResult & { state: StoredStrategyState })
    | null
  status?: PredictionEngineStatus
}

export async function getPredictionEngineStatus(): Promise<PredictionEngineStatus | null> {
  const res = await fetchFromBackend<PredictionEngineStatus>(
    '/prediction-engine/status',
    { method: 'GET' },
  )
  return res?.data ?? null
}

export async function getPredictionEngineWindows(
  timeframe?: PolymarketTimeframe,
  limit = 50,
): Promise<PredictionEngineWindowsResponse | null> {
  const qs = new URLSearchParams()
  if (timeframe) qs.set('tf', timeframe)
  qs.set('limit', String(limit))
  const res = await fetchFromBackend<PredictionEngineWindowsResponse>(
    `/prediction-engine/windows?${qs.toString()}`,
    { method: 'GET' },
  )
  return res?.data ?? null
}

export async function setPredictionEngineMode(params: {
  strategyId?: PredictionEngineStrategyId
  mode?: StrategyLifecycleMode
  forceOverride?: boolean
  overrideReason?: string
  halt?: boolean
  haltedReason?: string
  canaryConfig?: Partial<CanaryRiskConfig>
  macroBlackoutWindows?: MacroBlackoutWindow[]
  addMacroBlackout?: MacroBlackoutWindow
  removeMacroBlackoutTimestampMs?: number
}): Promise<PredictionEngineModeResponse> {
  const res = await requestBackend<PredictionEngineModeResponse>(
    '/prediction-engine/mode',
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
    8_000,
  )
  if (res.ok) {
    return res.data
  }
  return {
    ok: false,
    error: res.error,
    transition: res.data?.transition ?? null,
    status: res.data?.status,
  }
}

export async function runPredictionEngineReplay(
  strategyId: PredictionEngineStrategyId,
): Promise<{
  ok: boolean
  report?: PromotionReport
  error?: string
}> {
  const res = await requestBackend<{
    ok?: boolean
    report?: PromotionReport
    error?: string
  }>(
    '/prediction-engine/replay',
    {
      method: 'POST',
      body: JSON.stringify({ strategyId }),
    },
    15_000,
  )
  if (res.ok) {
    return {
      ok: true,
      report: res.data.report ?? (res.data as unknown as PromotionReport),
    }
  }
  return { ok: false, error: res.error }
}

export async function runPredictionReplay(
  strategyId: PredictionEngineStrategyId,
): Promise<PromotionReport> {
  const res = await runPredictionEngineReplay(strategyId)
  if (!res.ok || !res.report) {
    throw new BackendApiError(
      res.error ?? 'Failed to run prediction strategy replay.',
    )
  }
  return res.report
}

export const updatePredictionStrategyMode = setPredictionEngineMode
export const updatePredictionCanaryConfig = setPredictionEngineMode
