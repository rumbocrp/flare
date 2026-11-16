import crypto from 'node:crypto'
import { availablePairs } from '../strategy'
import { fetchOptimizedCandles } from './candleCache'

export type ExchangeAdapterMode = 'binance-testnet' | 'demo-vault'

export type HardRiskLimits = {
  /** Maximum capital allowed per single order (USD) */
  maxOrderNotionalUsd: number
  /** Maximum cumulative daily realized loss before auto-lock (USD) */
  maxDailyLossUsd: number
  /** Maximum number of orders allowed per UTC day */
  maxDailyOrders: number
  /** Trading pairs authorized on the broker/exchange */
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
  clientOrderId?: string
  venueOrderId?: string
  timestamp: string
  pair: string
  side: 'BUY' | 'SELL'
  notionalUsd: number
  price: number
  quantity: number
  status: ExchangeOrderStatus
  mode: ExchangeAdapterMode
  source: 'manual' | 'bot-auto'
  reason?: string
}

export type PersistedExchangeState = {
  schemaVersion: 1
  autoMirrorBotOrders: boolean
  killSwitchActive: boolean
  killSwitchActivatedAt: string | null
  killSwitchReason: string | null
  currentUtcDayKey: number
  dailyOrderCount: number
  dailyRealizedLossUsd: number
  hardLimits: HardRiskLimits
  balances: Record<string, { free: number; locked: number }>
  orderHistory: ExchangeOrderRecord[]
  orderCounter: number
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

const TESTNET_BASE_URL = 'https://testnet.binance.vision'

const DEFAULT_HARD_LIMITS: HardRiskLimits = {
  maxOrderNotionalUsd: 500,
  maxDailyLossUsd: 250,
  maxDailyOrders: 12,
  allowedPairs: [...availablePairs],
}

const INITIAL_DEMO_BALANCES: Record<string, { free: number; locked: number }> = {
  USDT: { free: 10_000, locked: 0 },
  BTC: { free: 0.05, locked: 0 },
  ETH: { free: 1.0, locked: 0 },
  SOL: { free: 15.0, locked: 0 },
  XRP: { free: 500.0, locked: 0 },
  DOGE: { free: 2500.0, locked: 0 },
}

let hardLimits: HardRiskLimits = { ...DEFAULT_HARD_LIMITS }
let autoMirrorBotOrders = true
let killSwitchActive = false
let killSwitchActivatedAt: string | null = null
let killSwitchReason: string | null = null

let currentUtcDayKey = Math.floor(Date.now() / 86_400_000)
let dailyOrderCount = 0
let dailyRealizedLossUsd = 0

let demoBalances: Record<string, { free: number; locked: number }> =
  structuredClone(INITIAL_DEMO_BALANCES)
let orderHistory: ExchangeOrderRecord[] = []
let orderCounter = 1000

function syncDailyCounters(): void {
  const todayKey = Math.floor(Date.now() / 86_400_000)
  if (todayKey !== currentUtcDayKey) {
    currentUtcDayKey = todayKey
    dailyOrderCount = 0
    dailyRealizedLossUsd = 0
  }
}

function getTestnetCredentials(): { apiKey: string; apiSecret: string } | null {
  const apiKey = process.env.BINANCE_TESTNET_KEY?.trim() ?? ''
  const apiSecret = process.env.BINANCE_TESTNET_SECRET?.trim() ?? ''
  if (apiKey.length > 8 && apiSecret.length > 8) {
    return { apiKey, apiSecret }
  }
  return null
}

function signQuery(queryString: string, apiSecret: string): string {
  return crypto
    .createHmac('sha256', apiSecret)
    .update(queryString)
    .digest('hex')
}

function getBalancesList(): ExchangeBalance[] {
  return Object.entries(demoBalances).map(([asset, bal]) => ({
    asset,
    free: Number(bal.free.toFixed(asset === 'USDT' ? 2 : 6)),
    locked: Number(bal.locked.toFixed(asset === 'USDT' ? 2 : 6)),
  }))
}

export function getExchangeStatusSnapshot(): ExchangeStatusSnapshot {
  syncDailyCounters()
  const creds = getTestnetCredentials()
  return {
    mode: creds ? 'binance-testnet' : 'demo-vault',
    testnetConfigured: Boolean(creds),
    autoMirrorBotOrders,
    killSwitchActive,
    killSwitchActivatedAt,
    killSwitchReason,
    hardLimits: { ...hardLimits },
    dailyOrderCount,
    dailyRealizedLossUsd: Number(dailyRealizedLossUsd.toFixed(2)),
    balances: getBalancesList(),
    orders: orderHistory.slice(0, 40),
  }
}

/**
 * Enforces Hard Risk Limits before submitting any order.
 * Returns `null` when compliant, or a human-readable rejection reason otherwise.
 */
function validateHardRiskLimits(params: {
  pair: string
  side: 'BUY' | 'SELL'
  notionalUsd: number
}): string | null {
  syncDailyCounters()

  if (killSwitchActive) {
    return `Emergency Kill-Switch ACTIVE (${killSwitchReason ?? 'Manual lock'}). Reset the Kill-Switch before trading.`
  }

  if (!hardLimits.allowedPairs.includes(params.pair)) {
    return `Pair not authorized by hard risk limits: ${params.pair}. Allowed: ${hardLimits.allowedPairs.join(', ')}`
  }

  if (!Number.isFinite(params.notionalUsd) || params.notionalUsd <= 0) {
    return 'Order notional amount must be greater than $0 USD.'
  }

  if (params.notionalUsd > hardLimits.maxOrderNotionalUsd) {
    return `Order rejected by hard risk limit: $${params.notionalUsd.toFixed(2)} USD exceeds the max allowed per order ($${hardLimits.maxOrderNotionalUsd.toFixed(2)} USD).`
  }

  if (dailyOrderCount >= hardLimits.maxDailyOrders) {
    return `Daily hard risk limit reached: ${dailyOrderCount}/${hardLimits.maxDailyOrders} orders executed today.`
  }

  if (dailyRealizedLossUsd >= hardLimits.maxDailyLossUsd) {
    return `Daily loss hard risk limit reached ($${dailyRealizedLossUsd.toFixed(2)} / $${hardLimits.maxDailyLossUsd.toFixed(2)} USD).`
  }

  return null
}

const TESTNET_TIMEOUT_MS = 6_000
const MAX_ORDER_HISTORY = 60

async function resolveExecutionPrice(
  pair: string,
  referencePrice?: number,
): Promise<{ price: number; isSynthetic: boolean }> {
  if (referencePrice && Number.isFinite(referencePrice) && referencePrice > 0) {
    return { price: referencePrice, isSynthetic: false }
  }
  try {
    const { candles, source } = await fetchOptimizedCandles(pair, '15m', 5)
    const last = candles[candles.length - 1]
    if (last && last.close > 0) {
      return { price: last.close, isSynthetic: source === 'synthetic-fallback' }
    }
  } catch {
    // Deterministic fallback price strictly for Demo Vault when network is offline
  }
  if (pair.startsWith('BTC')) return { price: 85_000, isSynthetic: true }
  if (pair.startsWith('ETH')) return { price: 2_800, isSynthetic: true }
  if (pair.startsWith('SOL')) return { price: 175, isSynthetic: true }
  return { price: 100, isSynthetic: true }
}

function recordRejectedOrder(params: {
  pair: string
  side: 'BUY' | 'SELL'
  notionalUsd: number
  price: number
  quantity: number
  mode: ExchangeAdapterMode
  source: 'manual' | 'bot-auto'
  reason: string
  clientOrderId?: string
}): {
  ok: false
  error: string
  order: ExchangeOrderRecord
  snapshot: ExchangeStatusSnapshot
} {
  orderCounter += 1
  const rejectedOrder: ExchangeOrderRecord = {
    id: `ORD-${orderCounter}`,
    clientOrderId: params.clientOrderId,
    timestamp: new Date().toISOString(),
    pair: params.pair,
    side: params.side,
    notionalUsd: Number(params.notionalUsd.toFixed(2)),
    price: Number(params.price.toFixed(2)),
    quantity: params.quantity,
    status: 'REJECTED_RISK',
    mode: params.mode,
    source: params.source,
    reason: params.reason,
  }
  orderHistory = [rejectedOrder, ...orderHistory].slice(0, MAX_ORDER_HISTORY)
  return {
    ok: false,
    error: params.reason,
    order: rejectedOrder,
    snapshot: getExchangeStatusSnapshot(),
  }
}

/**
 * Submits an order to the Demo exchange adapter (Binance Spot Testnet or local Demo Vault)
 * after enforcing strict Hard Risk Limits and idempotency keys.
 */
export async function submitExchangeOrder(params: {
  pair: string
  side: 'BUY' | 'SELL'
  notionalUsd: number
  referencePrice?: number
  realizedPnlUsd?: number
  source?: 'manual' | 'bot-auto'
  clientOrderId?: string
  fetchImpl?: typeof fetch
}): Promise<{
  ok: boolean
  error?: string
  order: ExchangeOrderRecord
  snapshot: ExchangeStatusSnapshot
}> {
  syncDailyCounters()

  if (params.clientOrderId) {
    const existing = orderHistory.find(
      (o) => o.clientOrderId === params.clientOrderId,
    )
    if (existing) {
      return {
        ok: existing.status === 'FILLED',
        error: existing.status === 'FILLED' ? undefined : existing.reason,
        order: existing,
        snapshot: getExchangeStatusSnapshot(),
      }
    }
  }

  const creds = getTestnetCredentials()
  const mode: ExchangeAdapterMode = creds ? 'binance-testnet' : 'demo-vault'
  const source = params.source ?? 'manual'
  const resolved = await resolveExecutionPrice(params.pair, params.referencePrice)
  let fillPrice = resolved.price
  let quantity =
    fillPrice > 0 ? Number((params.notionalUsd / fillPrice).toFixed(6)) : 0

  const rejectionReason = validateHardRiskLimits({
    pair: params.pair,
    side: params.side,
    notionalUsd: params.notionalUsd,
  })

  if (rejectionReason) {
    return recordRejectedOrder({
      pair: params.pair,
      side: params.side,
      notionalUsd: params.notionalUsd,
      price: fillPrice,
      quantity,
      mode,
      source,
      reason: rejectionReason,
      clientOrderId: params.clientOrderId,
    })
  }

  if (creds && resolved.isSynthetic && !params.referencePrice) {
    return recordRejectedOrder({
      pair: params.pair,
      side: params.side,
      notionalUsd: params.notionalUsd,
      price: fillPrice,
      quantity,
      mode,
      source,
      reason: 'Rejected: synthetic fallback market data cannot execute on Binance Testnet.',
      clientOrderId: params.clientOrderId,
    })
  }

  const baseAsset = params.pair.split('/')[0] ?? 'BTC'
  if (!demoBalances[baseAsset]) {
    demoBalances[baseAsset] = { free: 0, locked: 0 }
  }

  let executionNote = resolved.isSynthetic
    ? 'Executed in Local Demo Vault (Synthetic Offline Reference)'
    : 'Executed in Local Demo Vault (Spot Simulation)'
  let venueOrderId: string | undefined

  if (creds) {
    const fetchFn = params.fetchImpl ?? globalThis.fetch
    try {
      const symbol = params.pair.replace('/', '')
      const cidParam = params.clientOrderId
        ? `&newClientOrderId=${encodeURIComponent(params.clientOrderId)}`
        : ''
      const query = `symbol=${symbol}&side=${params.side}&type=MARKET&quoteOrderQty=${params.notionalUsd.toFixed(2)}${cidParam}&timestamp=${Date.now()}`
      const signature = signQuery(query, creds.apiSecret)
      const response = await fetchFn(
        `${TESTNET_BASE_URL}/api/v3/order?${query}&signature=${signature}`,
        {
          method: 'POST',
          headers: { 'X-MBX-APIKEY': creds.apiKey },
          signal: AbortSignal.timeout(TESTNET_TIMEOUT_MS),
        },
      )
      const payload = (await response.json().catch(() => null)) as {
        orderId?: number | string
        status?: string
        executedQty?: string
        cummulativeQuoteQty?: string
        msg?: string
      } | null

      if (!response.ok || !payload) {
        return recordRejectedOrder({
          pair: params.pair,
          side: params.side,
          notionalUsd: params.notionalUsd,
          price: fillPrice,
          quantity,
          mode,
          source,
          reason: `Binance Testnet HTTP ${response.status}: ${payload?.msg ?? 'Order rejected by venue'}`,
          clientOrderId: params.clientOrderId,
        })
      }

      if (payload.status && payload.status !== 'FILLED' && payload.status !== 'PARTIALLY_FILLED') {
        return recordRejectedOrder({
          pair: params.pair,
          side: params.side,
          notionalUsd: params.notionalUsd,
          price: fillPrice,
          quantity,
          mode,
          source,
          reason: `Binance Testnet returned unacknowledged status: ${payload.status}`,
          clientOrderId: params.clientOrderId,
        })
      }

      const execQty = Number(payload.executedQty ?? 0)
      const execQuote = Number(payload.cummulativeQuoteQty ?? 0)
      if (Number.isFinite(execQty) && execQty > 0) {
        quantity = Number(execQty.toFixed(6))
        if (Number.isFinite(execQuote) && execQuote > 0) {
          fillPrice = execQuote / execQty
        }
      }
      if (payload.orderId !== undefined) {
        venueOrderId = String(payload.orderId)
      }
      executionNote = `Executed & reconciled on Binance Spot Testnet (#${venueOrderId ?? 'ack'})`
    } catch (err) {
      return recordRejectedOrder({
        pair: params.pair,
        side: params.side,
        notionalUsd: params.notionalUsd,
        price: fillPrice,
        quantity,
        mode,
        source,
        reason: `Binance Testnet reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
        clientOrderId: params.clientOrderId,
      })
    }
  }

  // Update balances in the local Demo Vault
  if (params.side === 'BUY') {
    if (demoBalances.USDT.free < params.notionalUsd) {
      return recordRejectedOrder({
        pair: params.pair,
        side: params.side,
        notionalUsd: params.notionalUsd,
        price: fillPrice,
        quantity,
        mode,
        source,
        reason: `Insufficient USDT balance in Demo Vault ($${demoBalances.USDT.free.toFixed(2)} < $${params.notionalUsd.toFixed(2)} USD).`,
        clientOrderId: params.clientOrderId,
      })
    }
    demoBalances.USDT.free -= params.notionalUsd
    demoBalances[baseAsset].free += quantity
  } else {
    // On SELL, credit USDT and debit base asset (or simulate position close)
    demoBalances[baseAsset].free = Math.max(0, demoBalances[baseAsset].free - quantity)
    demoBalances.USDT.free += params.notionalUsd
  }

  dailyOrderCount += 1
  if (typeof params.realizedPnlUsd === 'number' && params.realizedPnlUsd < 0) {
    dailyRealizedLossUsd += Math.abs(params.realizedPnlUsd)
  }

  orderCounter += 1
  const filledOrder: ExchangeOrderRecord = {
    id: `ORD-${orderCounter}`,
    clientOrderId: params.clientOrderId,
    venueOrderId,
    timestamp: new Date().toISOString(),
    pair: params.pair,
    side: params.side,
    notionalUsd: Number(params.notionalUsd.toFixed(2)),
    price: Number(fillPrice.toFixed(2)),
    quantity,
    status: 'FILLED',
    mode,
    source,
    reason: executionNote,
  }
  orderHistory = [filledOrder, ...orderHistory].slice(0, MAX_ORDER_HISTORY)

  return {
    ok: true,
    order: filledOrder,
    snapshot: getExchangeStatusSnapshot(),
  }
}

/**
 * Triggers the emergency Kill-Switch:
 * 1. Immediately blocks any future orders.
 * 2. Cancels open orders on Binance Testnet when configured.
 * 3. Invokes `onHaltBot` to stop the autonomous engine and close open positions.
 */
export async function triggerEmergencyKillSwitch(
  reason = 'Emergency stop triggered by operator',
  onHaltBot?: () => void,
): Promise<ExchangeStatusSnapshot> {
  killSwitchActive = true
  killSwitchActivatedAt = new Date().toISOString()
  killSwitchReason = reason

  if (onHaltBot) {
    onHaltBot()
  }

  const creds = getTestnetCredentials()
  if (creds) {
    for (const pair of hardLimits.allowedPairs) {
      try {
        const symbol = pair.replace('/', '')
        const query = `symbol=${symbol}&timestamp=${Date.now()}`
        const signature = signQuery(query, creds.apiSecret)
        await fetch(
          `${TESTNET_BASE_URL}/api/v3/openOrders?${query}&signature=${signature}`,
          {
            method: 'DELETE',
            headers: { 'X-MBX-APIKEY': creds.apiKey },
          },
        )
      } catch {
        // Ignore network errors while canceling open orders in emergency mode
      }
    }
  }

  orderCounter += 1
  const killRecord: ExchangeOrderRecord = {
    id: `KILL-${orderCounter}`,
    timestamp: killSwitchActivatedAt,
    pair: 'ALL/USDT',
    side: 'SELL',
    notionalUsd: 0,
    price: 0,
    quantity: 0,
    status: 'CANCELED_KILLSWITCH',
    mode: creds ? 'binance-testnet' : 'demo-vault',
    source: 'manual',
    reason: `KILL-SWITCH: ${reason}`,
  }
  orderHistory = [killRecord, ...orderHistory].slice(0, 60)

  return getExchangeStatusSnapshot()
}

export function resetEmergencyKillSwitch(): ExchangeStatusSnapshot {
  killSwitchActive = false
  killSwitchActivatedAt = null
  killSwitchReason = null
  return getExchangeStatusSnapshot()
}

export function updateHardRiskLimits(
  partial: Partial<HardRiskLimits>,
): ExchangeStatusSnapshot {
  if (
    typeof partial.maxOrderNotionalUsd === 'number' &&
    partial.maxOrderNotionalUsd >= 10
  ) {
    hardLimits.maxOrderNotionalUsd = partial.maxOrderNotionalUsd
  }
  if (
    typeof partial.maxDailyLossUsd === 'number' &&
    partial.maxDailyLossUsd >= 10
  ) {
    hardLimits.maxDailyLossUsd = partial.maxDailyLossUsd
  }
  if (
    typeof partial.maxDailyOrders === 'number' &&
    partial.maxDailyOrders >= 1
  ) {
    hardLimits.maxDailyOrders = Math.round(partial.maxDailyOrders)
  }
  if (Array.isArray(partial.allowedPairs) && partial.allowedPairs.length > 0) {
    const valid = partial.allowedPairs.filter((p) => availablePairs.includes(p))
    if (valid.length > 0) {
      hardLimits.allowedPairs = valid
    }
  }
  return getExchangeStatusSnapshot()
}

export function setExchangeAutoMirror(enabled: boolean): ExchangeStatusSnapshot {
  autoMirrorBotOrders = Boolean(enabled)
  return getExchangeStatusSnapshot()
}

/**
 * Serializes kill-switch, daily risk counters, limits, balances, and monotonic
 * order counter so process restarts never wipe limits or reuse order IDs (`P0-2`).
 */
export function exportExchangeState(): PersistedExchangeState {
  syncDailyCounters()
  return {
    schemaVersion: 1,
    autoMirrorBotOrders,
    killSwitchActive,
    killSwitchActivatedAt,
    killSwitchReason,
    currentUtcDayKey,
    dailyOrderCount,
    dailyRealizedLossUsd: Number(dailyRealizedLossUsd.toFixed(2)),
    hardLimits: {
      ...hardLimits,
      allowedPairs: [...hardLimits.allowedPairs],
    },
    balances: structuredClone(demoBalances),
    orderHistory: orderHistory.slice(0, MAX_ORDER_HISTORY),
    orderCounter,
  }
}

/**
 * Restores persisted exchange/risk state on startup while keeping monotonic IDs
 * strictly above any previously recorded orders and respecting UTC day rollovers.
 */
export function restoreExchangeState(
  persisted?: Partial<PersistedExchangeState> | null,
): ExchangeStatusSnapshot {
  if (!persisted || typeof persisted !== 'object') {
    return getExchangeStatusSnapshot()
  }

  if (typeof persisted.autoMirrorBotOrders === 'boolean') {
    autoMirrorBotOrders = persisted.autoMirrorBotOrders
  }
  if (typeof persisted.killSwitchActive === 'boolean') {
    killSwitchActive = persisted.killSwitchActive
    killSwitchActivatedAt = persisted.killSwitchActivatedAt ?? null
    killSwitchReason = persisted.killSwitchReason ?? null
  }

  if (persisted.hardLimits) {
    updateHardRiskLimits(persisted.hardLimits)
  }

  const todayKey = Math.floor(Date.now() / 86_400_000)
  if (persisted.currentUtcDayKey === todayKey) {
    currentUtcDayKey = todayKey
    dailyOrderCount =
      typeof persisted.dailyOrderCount === 'number' &&
      Number.isFinite(persisted.dailyOrderCount)
        ? Math.max(0, Math.round(persisted.dailyOrderCount))
        : 0
    dailyRealizedLossUsd =
      typeof persisted.dailyRealizedLossUsd === 'number' &&
      Number.isFinite(persisted.dailyRealizedLossUsd)
        ? Math.max(0, persisted.dailyRealizedLossUsd)
        : 0
  } else {
    currentUtcDayKey = todayKey
    dailyOrderCount = 0
    dailyRealizedLossUsd = 0
  }

  if (persisted.balances && typeof persisted.balances === 'object') {
    const nextBalances: Record<string, { free: number; locked: number }> = {}
    for (const [asset, bal] of Object.entries(persisted.balances)) {
      if (
        bal &&
        typeof bal.free === 'number' &&
        Number.isFinite(bal.free) &&
        typeof bal.locked === 'number' &&
        Number.isFinite(bal.locked)
      ) {
        nextBalances[asset] = {
          free: Math.max(0, bal.free),
          locked: Math.max(0, bal.locked),
        }
      }
    }
    if (nextBalances.USDT) {
      demoBalances = nextBalances
    }
  }

  const restoredOrders = Array.isArray(persisted.orderHistory)
    ? persisted.orderHistory.slice(0, MAX_ORDER_HISTORY)
    : []
  orderHistory = restoredOrders

  let maxOrderNum = 1000
  for (const ord of restoredOrders) {
    const match = /^(?:ORD|KILL)-(\d+)$/.exec(ord.id)
    if (match) {
      const n = Number(match[1])
      if (Number.isFinite(n) && n > maxOrderNum) {
        maxOrderNum = n
      }
    }
  }
  const persistedCounter =
    typeof persisted.orderCounter === 'number' &&
    Number.isFinite(persisted.orderCounter)
      ? persisted.orderCounter
      : 1000
  orderCounter = Math.max(orderCounter, persistedCounter, maxOrderNum, 1000)

  return getExchangeStatusSnapshot()
}

export function resetExchangeDemoVault(): ExchangeStatusSnapshot {
  killSwitchActive = false
  killSwitchActivatedAt = null
  killSwitchReason = null
  dailyOrderCount = 0
  dailyRealizedLossUsd = 0
  hardLimits = { ...DEFAULT_HARD_LIMITS, allowedPairs: [...availablePairs] }
  demoBalances = structuredClone(INITIAL_DEMO_BALANCES)
  orderHistory = []
  return getExchangeStatusSnapshot()
}
