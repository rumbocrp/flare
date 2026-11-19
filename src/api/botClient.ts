import type { BacktestSnapshot } from '../backtest'
import {
  STRATEGY_PRESETS,
  createInitialBotState,
  evaluateBotPresetAccuracy,
  normalizeBotEngineState,
  stepBotEngine,
  trimBotEngineHistory,
  type BotEngineState,
  type BotPresetAccuracyReport,
  type StrategyPreset,
} from '../botEngine'
import { binanceSource } from '../market/binance'
import { availablePairs } from '../strategy'
import type { Candle, Interval, Strategy } from '../types'
import type {
  PolymarketSnapshot,
  PolymarketTimeframe,
} from '../server/polymarketAdapter'

type BackendConnectionMode = 'sse-live' | 'http-server' | 'local-fallback'

type ServerCacheTelemetry = {
  hits: number
  misses: number
  coalescedRequests: number
  binanceErrors: number
  hitRatePct: number
  avgLatencyMs: number
  lastSource: 'binance' | 'binance-cache'
  activeCacheEntries: number
}

type ServerTelemetrySnapshot = {
  uptimeSec: number
  lastTickAt: string | null
  lastTickLatencyMs: number
  tickCount: number
  connectedStreamClients: number
  sseSeq?: number
  lastDataSource?: 'binance' | 'binance-cache' | 'unavailable'
  lastQuoteError?: string | null
  cache: ServerCacheTelemetry
}

export type ExchangeAdapterMode = 'binance-testnet' | 'demo-vault'

export type HardRiskLimits = {
  maxOrderNotionalUsd: number
  maxDailyLossUsd: number
  maxDailyOrders: number
  allowedPairs: string[]
}

export type ExchangeBalance = {
  asset: string
  free: number
  locked: number
}

export type ExchangeOrderStatus =
  | 'FILLED'
  | 'REJECTED_RISK'
  | 'CANCELED_KILLSWITCH'

export type ExchangeOrderRecord = {
  id: string
  timestamp: string
  pair: string
  side: 'BUY' | 'SELL'
  notionalUsd: number
  price: number
  quantity: number
  status: ExchangeOrderStatus
  mode: ExchangeAdapterMode
  source: 'manual' | 'bot-auto'
  clientOrderId?: string
  venueOrderId?: string
  reason?: string
}

export type ExchangeStatusSnapshot = {
  mode: ExchangeAdapterMode
  testnetConfigured: boolean
  autoMirrorBotOrders: boolean
  killSwitchActive: boolean
  killSwitchActivatedAt: string | null
  killSwitchReason: string | null
  hardLimits: HardRiskLimits
  dailyOrderCount: number
  dailyRealizedLossUsd: number
  balances: ExchangeBalance[]
  orders: ExchangeOrderRecord[]
}

export type Mt5Action = 'BUY' | 'SELL' | 'HOLD' | 'CLOSE_ALL'

export type Mt5SignalPacket = {
  signalId: string
  timestamp: string
  magicNumber: number
  presetId: string
  presetName: string
  pair: string
  symbol: string
  timeframe: string
  action: Mt5Action
  killSwitchActive: boolean
  dayHalted: boolean
  stopLossPct: number
  takeProfitPct: number
  positionSizePct: number
  entryPrice: number
  stopPrice: number
  targetPrice: number
  breakevenArmed: boolean
}

export type Mt5TerminalTelemetry = {
  terminalName: string
  symbol: string | null
  pollCount: number
  lastPollAt: string
}

export type Mt5BridgeSnapshot = {
  magicNumber: number
  pollCount: number
  lastPollAt: string | null
  lastTerminalName: string | null
  lastTerminalSymbol: string | null
  terminals?: Mt5TerminalTelemetry[]
  lastPacket: Mt5SignalPacket
}

export type BotServerSnapshot = {
  seq?: number
  frameType?: 'snapshot' | 'delta'
  running: boolean
  preset: StrategyPreset
  presets: StrategyPreset[]
  state: BotEngineState
  telemetry?: ServerTelemetrySnapshot
  exchange?: ExchangeStatusSnapshot
  mt5?: Mt5BridgeSnapshot
  connectionMode?: BackendConnectionMode
}

export type BotAccuracyResponse = {
  evaluatedAt: string
  candleSampleSize: number
  reports: (BotPresetAccuracyReport & {
    dataSource: string
    fetchLatencyMs?: number
  })[]
}

const API_ENDPOINTS = ['/api', 'http://localhost:3001/api']
const SHADOW_STORAGE_KEY = 'lixtrd:shadow-bot-state'

let resolvedBaseUrl: string | null = null

function loadShadowFromLocalStorage(): {
  preset: StrategyPreset
  state: BotEngineState
} {
  try {
    if (typeof window === 'undefined') {
      return {
        preset: STRATEGY_PRESETS[1],
        state: createInitialBotState(STRATEGY_PRESETS[1]),
      }
    }
    const raw = window.localStorage.getItem(SHADOW_STORAGE_KEY)
    if (!raw) {
      return {
        preset: STRATEGY_PRESETS[1],
        state: createInitialBotState(STRATEGY_PRESETS[1]),
      }
    }
    const parsed = JSON.parse(raw) as {
      presetId?: string
      state?: BotEngineState
    }
    const found =
      STRATEGY_PRESETS.find((p) => p.id === parsed.presetId) ??
      STRATEGY_PRESETS[1]
    return {
      preset: found,
      state: parsed.state
        ? normalizeBotEngineState(parsed.state)
        : createInitialBotState(found),
    }
  } catch {
    return {
      preset: STRATEGY_PRESETS[1],
      state: createInitialBotState(STRATEGY_PRESETS[1]),
    }
  }
}

function saveShadowToLocalStorage(
  preset: StrategyPreset,
  state: BotEngineState,
): void {
  try {
    if (typeof window === 'undefined') return
    const compactState = trimBotEngineHistory(state, {
      maxClosedTrades: 200,
      maxResolvedTickets: 200,
    })
    window.localStorage.setItem(
      SHADOW_STORAGE_KEY,
      JSON.stringify({ presetId: preset.id, state: compactState }),
    )
  } catch {
    // Ignore when localStorage is unavailable
  }
}

const initialShadow = loadShadowFromLocalStorage()
let fallbackRunning = false
let fallbackPreset: StrategyPreset = initialShadow.preset
let fallbackState: BotEngineState = initialShadow.state
let fallbackTicks = 0
let fallbackLastLatencyMs = 0
let fallbackMt5Polls = 0
let fallbackMt5LastPollAt: string | null = null

let fallbackExchange: ExchangeStatusSnapshot = {
  mode: 'demo-vault',
  testnetConfigured: false,
  autoMirrorBotOrders: true,
  killSwitchActive: false,
  killSwitchActivatedAt: null,
  killSwitchReason: null,
  hardLimits: {
    maxOrderNotionalUsd: 500,
    maxDailyLossUsd: 250,
    maxDailyOrders: 12,
    allowedPairs: [...availablePairs],
  },
  dailyOrderCount: 0,
  dailyRealizedLossUsd: 0,
  balances: [
    { asset: 'USDT', free: 10000, locked: 0 },
    { asset: 'BTC', free: 0.05, locked: 0 },
    { asset: 'ETH', free: 1, locked: 0 },
    { asset: 'SOL', free: 15, locked: 0 },
    { asset: 'XRP', free: 500, locked: 0 },
    { asset: 'DOGE', free: 2500, locked: 0 },
  ],
  orders: [],
}

function buildFallbackMt5Snapshot(): Mt5BridgeSnapshot {
  const symbol = fallbackPreset.strategy.pair
    .replace('/USDT', 'USD')
    .replace('/', '')
  const pos = fallbackState.openPosition
  const action: Mt5Action =
    fallbackExchange.killSwitchActive || fallbackState.dayHalted
      ? 'CLOSE_ALL'
      : pos
        ? pos.side === 'buy'
          ? 'BUY'
          : 'SELL'
        : 'HOLD'
  const signalId =
    action === 'CLOSE_ALL'
      ? 'KILL-HALT'
      : pos
        ? `SIG-${symbol}-${pos.side.toUpperCase()}-${pos.entryTime}`
        : `HOLD-${symbol}-${fallbackState.lastProcessedCandleTime ?? 0}`

  return {
    magicNumber: 202615,
    pollCount: fallbackMt5Polls,
    lastPollAt: fallbackMt5LastPollAt,
    lastTerminalName: fallbackMt5Polls > 0 ? 'MT5-Terminal-Demo' : null,
    lastTerminalSymbol: fallbackMt5Polls > 0 ? symbol : null,
    terminals:
      fallbackMt5Polls > 0 && fallbackMt5LastPollAt
        ? [
            {
              terminalName: 'MT5-Terminal-Demo',
              symbol,
              pollCount: fallbackMt5Polls,
              lastPollAt: fallbackMt5LastPollAt,
            },
          ]
        : [],
    lastPacket: {
      signalId,
      timestamp: new Date().toISOString(),
      magicNumber: 202615,
      presetId: fallbackPreset.id,
      presetName: fallbackPreset.name,
      pair: fallbackPreset.strategy.pair,
      symbol,
      timeframe: fallbackPreset.timeframe,
      action,
      killSwitchActive: fallbackExchange.killSwitchActive,
      dayHalted: fallbackState.dayHalted,
      stopLossPct: fallbackPreset.strategy.stopLoss,
      takeProfitPct: fallbackPreset.strategy.takeProfit,
      positionSizePct: fallbackPreset.strategy.positionSize,
      entryPrice: pos ? pos.entryPrice : 0,
      stopPrice: pos ? pos.stopPrice : 0,
      targetPrice: pos ? pos.targetPrice : 0,
      breakevenArmed: Boolean(pos?.breakevenArmed),
    },
  }
}

const API_TOKEN_STORAGE_KEY = 'flare:api-token'

export function getApiAuthToken(): string | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const stored = window.localStorage.getItem(API_TOKEN_STORAGE_KEY)?.trim()
      if (stored) return stored
    }
  } catch {
    // Ignore storage access errors
  }
  return null
}

export function setApiAuthToken(token: string | null): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const cleaned = token?.trim() ?? ''
      if (cleaned) {
        window.localStorage.setItem(API_TOKEN_STORAGE_KEY, cleaned)
      } else {
        window.localStorage.removeItem(API_TOKEN_STORAGE_KEY)
      }
    }
  } catch {
    // Ignore storage access errors
  }
}

function buildAuthHeaders(): Record<string, string> {
  const token = getApiAuthToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function appendStreamAuthToken(url: string): string {
  const token = getApiAuthToken()
  if (!token) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}token=${encodeURIComponent(token)}`
}

async function fetchFromBackend<T>(
  path: string,
  init?: RequestInit,
): Promise<{ data: T; baseUrl: string } | null> {
  const candidates = resolvedBaseUrl
    ? [resolvedBaseUrl, ...API_ENDPOINTS.filter((u) => u !== resolvedBaseUrl)]
    : API_ENDPOINTS

  for (const base of candidates) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3_500)
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
      if (response.ok) {
        const contentType = response.headers.get('content-type') ?? ''
        if (contentType.includes('application/json')) {
          const data = (await response.json()) as T
          resolvedBaseUrl = base
          return { data, baseUrl: base }
        }
      }
    } catch {
      clearTimeout(timeout)
      init?.signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  return null
}

const clientStartedAtMs = Date.now()

async function runFallbackTick(): Promise<void> {
  if (fallbackExchange.killSwitchActive) {
    fallbackRunning = false
    return
  }
  const start = Date.now()
  try {
    const candles = await binanceSource.getCandles({
      pair: fallbackPreset.strategy.pair,
      interval: fallbackPreset.timeframe,
      limit: 300,
    })
    fallbackState = stepBotEngine(fallbackState, candles, fallbackPreset, {
      nowMs: Date.now(),
      requireExecutableQuote: true,
    })
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : 'Live Binance feed unavailable'
    const now = Date.now()
    fallbackState = {
      ...fallbackState,
      logs: [
        {
          id: now,
          timestamp: new Date(now).toISOString(),
          level: 'risk' as const,
          message: `[DATA GUARD] ${detail} — refusing synthetic fallback candles.`,
        },
        ...fallbackState.logs,
      ].slice(0, 80),
    }
  }
  fallbackTicks += 1
  fallbackLastLatencyMs = Math.max(1, Date.now() - start)
  saveShadowToLocalStorage(fallbackPreset, fallbackState)
}

function buildFallbackSnapshot(): BotServerSnapshot {
  return {
    running: fallbackRunning,
    preset: fallbackPreset,
    presets: STRATEGY_PRESETS,
    state: fallbackState,
    exchange: fallbackExchange,
    mt5: buildFallbackMt5Snapshot(),
    connectionMode: 'local-fallback',
    telemetry: {
      uptimeSec: Math.max(0, Math.floor((Date.now() - clientStartedAtMs) / 1000)),
      lastTickAt: fallbackTicks > 0 ? new Date().toISOString() : null,
      lastTickLatencyMs: fallbackLastLatencyMs,
      tickCount: fallbackTicks,
      connectedStreamClients: 0,
      cache: {
        hits: 0,
        misses: fallbackTicks,
        coalescedRequests: 0,
        binanceErrors: 0,
        hitRatePct: 0,
        avgLatencyMs: fallbackLastLatencyMs,
        lastSource: 'binance',
        activeCacheEntries: 0,
      },
    },
  }
}

export async function getBotStatus(): Promise<BotServerSnapshot> {
  const res = await fetchFromBackend<BotServerSnapshot>('/bot/status')
  if (res) {
    saveShadowToLocalStorage(res.data.preset, res.data.state)
    return {
      ...res.data,
      connectionMode: 'http-server',
    }
  }
  return buildFallbackSnapshot()
}

export async function startBotOnServer(params?: {
  presetId?: string
  strategy?: Strategy
}): Promise<BotServerSnapshot> {
  const res = await fetchFromBackend<BotServerSnapshot>('/bot/start', {
    method: 'POST',
    body: JSON.stringify(params ?? {}),
  })
  if (res) {
    saveShadowToLocalStorage(res.data.preset, res.data.state)
    return { ...res.data, connectionMode: 'http-server' }
  }

  if (fallbackExchange.killSwitchActive) {
    return buildFallbackSnapshot()
  }

  if (params?.presetId) {
    const found = STRATEGY_PRESETS.find((p) => p.id === params.presetId)
    if (found) {
      fallbackPreset = found
      fallbackState = createInitialBotState(fallbackPreset)
    }
  }
  if (params?.strategy) {
    fallbackPreset = { ...fallbackPreset, strategy: params.strategy }
  }
  fallbackRunning = true
  await runFallbackTick()
  return buildFallbackSnapshot()
}

export async function stopBotOnServer(): Promise<BotServerSnapshot> {
  const res = await fetchFromBackend<BotServerSnapshot>('/bot/stop', {
    method: 'POST',
  })
  if (res) {
    saveShadowToLocalStorage(res.data.preset, res.data.state)
    return { ...res.data, connectionMode: 'http-server' }
  }

  fallbackRunning = false
  saveShadowToLocalStorage(fallbackPreset, fallbackState)
  return buildFallbackSnapshot()
}

export async function resetBotOnServer(): Promise<BotServerSnapshot> {
  const res = await fetchFromBackend<BotServerSnapshot>('/bot/reset', {
    method: 'POST',
  })
  if (res) {
    saveShadowToLocalStorage(res.data.preset, res.data.state)
    return { ...res.data, connectionMode: 'http-server' }
  }

  fallbackRunning = false
  fallbackState = createInitialBotState(fallbackPreset)
  saveShadowToLocalStorage(fallbackPreset, fallbackState)
  return buildFallbackSnapshot()
}

export async function selectBotPresetOnServer(params: {
  presetId?: string
  strategy?: Strategy
  timeframe?: Interval
}): Promise<BotServerSnapshot> {
  const res = await fetchFromBackend<BotServerSnapshot>('/bot/preset', {
    method: 'POST',
    body: JSON.stringify(params),
  })
  if (res) {
    saveShadowToLocalStorage(res.data.preset, res.data.state)
    return { ...res.data, connectionMode: 'http-server' }
  }

  if (params.presetId) {
    const found = STRATEGY_PRESETS.find((p) => p.id === params.presetId)
    if (found && found.id !== fallbackPreset.id) {
      fallbackPreset = found
      fallbackState = createInitialBotState(fallbackPreset)
    }
  }
  if (params.strategy) {
    fallbackPreset = {
      ...fallbackPreset,
      strategy: params.strategy,
      timeframe: params.timeframe ?? fallbackPreset.timeframe,
    }
  }
  saveShadowToLocalStorage(fallbackPreset, fallbackState)
  return buildFallbackSnapshot()
}

export async function triggerImmediateBotTick(): Promise<BotServerSnapshot> {
  const res = await fetchFromBackend<BotServerSnapshot>('/bot/tick', {
    method: 'POST',
  })
  if (res) {
    saveShadowToLocalStorage(res.data.preset, res.data.state)
    return { ...res.data, connectionMode: 'http-server' }
  }

  await runFallbackTick()
  return buildFallbackSnapshot()
}

export async function submitDemoOrderOnServer(params: {
  pair: string
  side: 'BUY' | 'SELL'
  notionalUsd: number
}): Promise<{
  ok: boolean
  error?: string
  order: ExchangeOrderRecord
  bot: BotServerSnapshot
}> {
  const clientOrderId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetchFromBackend<{
    ok: boolean
    error?: string
    order: ExchangeOrderRecord
    bot: BotServerSnapshot
  }>('/exchange/order', {
    method: 'POST',
    body: JSON.stringify({ ...params, clientOrderId }),
  })
  if (res) {
    saveShadowToLocalStorage(res.data.bot.preset, res.data.bot.state)
    return {
      ...res.data,
      bot: { ...res.data.bot, connectionMode: 'http-server' },
    }
  }

  const offlineReason =
    'Backend server offline — refusing order execution without live exchange price feed.'
  const order: ExchangeOrderRecord = {
    id: `ORD-OFFLINE-${Date.now().toString().slice(-4)}`,
    clientOrderId,
    timestamp: new Date().toISOString(),
    pair: params.pair,
    side: params.side,
    notionalUsd: params.notionalUsd,
    price: 0,
    quantity: 0,
    status: 'REJECTED_RISK',
    mode: 'demo-vault',
    source: 'manual',
    reason: offlineReason,
  }

  fallbackExchange = {
    ...fallbackExchange,
    orders: [order, ...fallbackExchange.orders].slice(0, 40),
  }

  return {
    ok: false,
    error: offlineReason,
    order,
    bot: buildFallbackSnapshot(),
  }
}

export async function toggleExchangeKillSwitchOnServer(params: {
  action: 'engage' | 'reset'
  reason?: string
}): Promise<BotServerSnapshot> {
  const res = await fetchFromBackend<BotServerSnapshot>(
    '/exchange/kill-switch',
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
  )
  if (res) {
    saveShadowToLocalStorage(res.data.preset, res.data.state)
    return { ...res.data, connectionMode: 'http-server' }
  }

  if (params.action === 'reset') {
    fallbackExchange = {
      ...fallbackExchange,
      killSwitchActive: false,
      killSwitchActivatedAt: null,
      killSwitchReason: null,
    }
  } else {
    fallbackRunning = false
    fallbackState = {
      ...fallbackState,
      openPosition: null,
      activeTickets: [],
    }
    fallbackExchange = {
      ...fallbackExchange,
      killSwitchActive: true,
      killSwitchActivatedAt: new Date().toISOString(),
      killSwitchReason:
        params.reason ?? 'Emergency halt triggered by operator',
    }
  }
  saveShadowToLocalStorage(fallbackPreset, fallbackState)
  return buildFallbackSnapshot()
}

export async function updateHardLimitsOnServer(
  limits: Partial<HardRiskLimits> & { autoMirrorBotOrders?: boolean },
): Promise<BotServerSnapshot> {
  const res = await fetchFromBackend<BotServerSnapshot>('/exchange/limits', {
    method: 'POST',
    body: JSON.stringify(limits),
  })
  if (res) {
    saveShadowToLocalStorage(res.data.preset, res.data.state)
    return { ...res.data, connectionMode: 'http-server' }
  }

  fallbackExchange = {
    ...fallbackExchange,
    autoMirrorBotOrders:
      typeof limits.autoMirrorBotOrders === 'boolean'
        ? limits.autoMirrorBotOrders
        : fallbackExchange.autoMirrorBotOrders,
    hardLimits: {
      ...fallbackExchange.hardLimits,
      ...(typeof limits.maxOrderNotionalUsd === 'number'
        ? { maxOrderNotionalUsd: limits.maxOrderNotionalUsd }
        : {}),
      ...(typeof limits.maxDailyLossUsd === 'number'
        ? { maxDailyLossUsd: limits.maxDailyLossUsd }
        : {}),
      ...(typeof limits.maxDailyOrders === 'number'
        ? { maxDailyOrders: limits.maxDailyOrders }
        : {}),
    },
  }
  return buildFallbackSnapshot()
}

export async function resetExchangeVaultOnServer(): Promise<BotServerSnapshot> {
  const res = await fetchFromBackend<BotServerSnapshot>('/exchange/reset', {
    method: 'POST',
  })
  if (res) {
    saveShadowToLocalStorage(res.data.preset, res.data.state)
    return { ...res.data, connectionMode: 'http-server' }
  }

  fallbackExchange = {
    ...fallbackExchange,
    killSwitchActive: false,
    killSwitchActivatedAt: null,
    killSwitchReason: null,
    dailyOrderCount: 0,
    dailyRealizedLossUsd: 0,
    orders: [],
  }
  return buildFallbackSnapshot()
}

export async function simulateMt5PingOnServer(): Promise<{
  packet: Mt5SignalPacket
  bot: BotServerSnapshot
}> {
  const res = await fetchFromBackend<{
    packet: Mt5SignalPacket
    bot: BotServerSnapshot
  }>('/mt5/simulate-ping', {
    method: 'POST',
  })
  if (res) {
    saveShadowToLocalStorage(res.data.bot.preset, res.data.bot.state)
    return {
      packet: res.data.packet,
      bot: { ...res.data.bot, connectionMode: 'http-server' },
    }
  }

  fallbackMt5Polls += 1
  fallbackMt5LastPollAt = new Date().toISOString()
  const snap = buildFallbackSnapshot()
  return {
    packet: snap.mt5!.lastPacket,
    bot: snap,
  }
}

export async function fetchBotAccuracyAudit(
  evaluateAll = true,
): Promise<BotAccuracyResponse> {
  const res = await fetchFromBackend<BotAccuracyResponse>(
    `/bot/accuracy?all=${evaluateAll ? 'true' : 'false'}`,
  )
  if (res) {
    return res.data
  }

  const targetPresets = evaluateAll ? STRATEGY_PRESETS : [fallbackPreset]
  const reports = await Promise.all(
    targetPresets.map(async (preset) => {
      const candles = await binanceSource.getCandles({
        pair: preset.strategy.pair,
        interval: preset.timeframe,
        limit: 300,
      })
      return {
        ...evaluateBotPresetAccuracy(candles, preset),
        dataSource: 'binance',
      }
    }),
  )

  return {
    evaluatedAt: new Date().toISOString(),
    candleSampleSize: 300,
    reports,
  }
}

/**
 * Converts the current Shadow/Backend bot state into a BacktestSnapshot
 * so it can be analyzed directly on the Stats screen (`Stats.tsx`).
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
 * Never returns simulated data if the network or server fails.
 */
export async function fetchPolymarketSnapshot(
  tf: PolymarketTimeframe,
  limit = 48,
): Promise<PolymarketSnapshot> {
  const res = await fetchFromBackend<PolymarketSnapshot>(
    `/predictions/polymarket?tf=${tf}&limit=${limit}`,
  )
  if (!res) {
    throw new Error(
      'Unable to fetch Polymarket data from /api/predictions/polymarket',
    )
  }
  return res.data
}

/**
 * Opens a real-time Server-Sent Events subscription (`/api/bot/stream`).
 * Falls back to periodic polling on transient disconnects while retrying SSE
 * with bounded exponential backoff so live push automatically resumes.
 */
export function subscribeToBotStream(
  onSnapshot: (snapshot: BotServerSnapshot) => void,
): () => void {
  const streamUrl = appendStreamAuthToken(
    `${resolvedBaseUrl ?? '/api'}/bot/stream`,
  )
  let eventSource: EventSource | null = null
  let fallbackInterval: ReturnType<typeof setInterval> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempts = 0
  let lastSeenSeq = -1
  let cachedPresets: StrategyPreset[] = STRATEGY_PRESETS
  let disposed = false

  function stopFallbackPolling(): void {
    if (fallbackInterval) {
      clearInterval(fallbackInterval)
      fallbackInterval = null
    }
  }

  function startFallbackPolling(): void {
    if (disposed || fallbackInterval) return
    fallbackInterval = setInterval(async () => {
      if (disposed) return
      if (fallbackRunning) {
        await runFallbackTick()
      }
      const snap = await getBotStatus()
      if (!disposed) {
        onSnapshot(snap)
      }
    }, 8_000)
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer || typeof EventSource === 'undefined') return
    const baseDelay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempts, 5))
    const jitter = Math.floor(Math.random() * 400)
    reconnectAttempts += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connectSse()
    }, baseDelay + jitter)
  }

  function connectSse(): void {
    if (disposed || typeof EventSource === 'undefined') {
      startFallbackPolling()
      return
    }
    try {
      const es = new EventSource(streamUrl)
      eventSource = es
      es.onopen = () => {
        reconnectAttempts = 0
        stopFallbackPolling()
      }
      es.onmessage = (event) => {
        reconnectAttempts = 0
        stopFallbackPolling()
        try {
          const parsed = JSON.parse(event.data) as Partial<BotServerSnapshot> & {
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
          saveShadowToLocalStorage(merged.preset, merged.state)
          if (!disposed) {
            onSnapshot(merged)
          }
        } catch {
          // Ignore malformed SSE frames
        }
      }
      es.onerror = () => {
        if (eventSource === es) {
          eventSource = null
        }
        es.close()
        startFallbackPolling()
        scheduleReconnect()
      }
    } catch {
      startFallbackPolling()
      scheduleReconnect()
    }
  }

  connectSse()

  return () => {
    disposed = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    stopFallbackPolling()
    eventSource?.close()
    eventSource = null
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
 * Returns `null` when the backend server is unavailable so hooks can degrade gracefully.
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
 * Subscribes to FLARE's shared server-side market-data SSE stream (`/api/market/stream`)
 * to avoid opening duplicate per-tab Binance WebSockets.
 */
export function subscribeToMarketGatewayStream(
  pair: string,
  interval: Interval,
  limit: number,
  onEvent: (event: GatewayMarketStreamEvent) => void,
  onUnavailable: () => void,
): () => void {
  if (typeof EventSource === 'undefined') {
    onUnavailable()
    return () => {}
  }

  const base = resolvedBaseUrl ?? '/api'
  const qs = `pair=${encodeURIComponent(pair)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(String(limit))}`
  const url = appendStreamAuthToken(`${base}/market/stream?${qs}`)
  let disposed = false
  let opened = false
  let es: EventSource | null = null

  try {
    es = new EventSource(url)
    es.onopen = () => {
      opened = true
    }
    es.onmessage = (msg) => {
      if (disposed) return
      opened = true
      try {
        const parsed = JSON.parse(msg.data) as GatewayMarketStreamEvent
        onEvent(parsed)
      } catch {
        // Ignore malformed gateway frame
      }
    }
    es.onerror = () => {
      if (disposed) return
      if (!opened) {
        es?.close()
        es = null
        onUnavailable()
      }
    }
  } catch {
    onUnavailable()
  }

  return () => {
    disposed = true
    es?.close()
    es = null
  }
}

export async function getTenantLedger(): Promise<Record<string, unknown> | null> {
  const res = await fetchFromBackend<Record<string, unknown>>('/ledger', {
    method: 'GET',
  })
  return res?.data ?? null
}

export async function getTenantAudit(
  limit = 100,
): Promise<Record<string, unknown> | null> {
  const res = await fetchFromBackend<Record<string, unknown>>(
    `/audit?limit=${encodeURIComponent(String(limit))}`,
    { method: 'GET' },
  )
  return res?.data ?? null
}
