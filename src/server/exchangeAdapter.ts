import crypto from 'node:crypto'
import { availablePairs } from '../strategy'
import { fetchOptimizedCandles } from './candleCache'
import {
  buildInitialFundingEntry,
  buildSpotFillEntry,
  deriveAccountBalances,
  deriveWalletBalances,
  verifyLedgerInvariant,
  type LedgerEntry,
  type LedgerVerificationReport,
} from './ledger/doubleEntryLedger'
import { getStateStore } from './store'

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

export type TenantLedgerSnapshot = {
  tenantId: string
  verification: LedgerVerificationReport
  walletBalances: Record<string, number>
  accountBalances: Record<string, { asset: string; balance: number }>
  entries: LedgerEntry[]
}

const TESTNET_BASE_URL = 'https://testnet.binance.vision'
const DEFAULT_TENANT_ID = 'default'

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

const TESTNET_TIMEOUT_MS = 6_000
const MAX_ORDER_HISTORY = 120
const MAX_IN_MEMORY_LEDGER = 500

type TenantExchangeState = {
  tenantId: string
  hardLimits: HardRiskLimits
  autoMirrorBotOrders: boolean
  killSwitchActive: boolean
  killSwitchActivatedAt: string | null
  killSwitchReason: string | null
  currentUtcDayKey: number
  dailyOrderCount: number
  dailyRealizedLossUsd: number
  demoBalances: Record<string, { free: number; locked: number }>
  orderHistory: ExchangeOrderRecord[]
  orderCounter: number
  ledgerEntries: LedgerEntry[]
}

const tenantContexts = new Map<string, TenantExchangeState>()

function createFreshTenantState(tenantId: string): TenantExchangeState {
  const initialBalances = structuredClone(INITIAL_DEMO_BALANCES)
  const bootstrapEntry = buildInitialFundingEntry(
    tenantId,
    initialBalances,
    `bootstrap-${tenantId}`,
  )
  return {
    tenantId,
    hardLimits: {
      ...DEFAULT_HARD_LIMITS,
      allowedPairs: [...availablePairs],
    },
    autoMirrorBotOrders: true,
    killSwitchActive: false,
    killSwitchActivatedAt: null,
    killSwitchReason: null,
    currentUtcDayKey: Math.floor(Date.now() / 86_400_000),
    dailyOrderCount: 0,
    dailyRealizedLossUsd: 0,
    demoBalances: initialBalances,
    orderHistory: [],
    orderCounter: 1000,
    ledgerEntries: [bootstrapEntry],
  }
}

function getTenantCtx(tenantId = DEFAULT_TENANT_ID): TenantExchangeState {
  let ctx = tenantContexts.get(tenantId)
  if (!ctx) {
    ctx = createFreshTenantState(tenantId)
    tenantContexts.set(tenantId, ctx)
  }
  return ctx
}

function syncDailyCounters(ctx: TenantExchangeState): void {
  const todayKey = Math.floor(Date.now() / 86_400_000)
  if (todayKey !== ctx.currentUtcDayKey) {
    ctx.currentUtcDayKey = todayKey
    ctx.dailyOrderCount = 0
    ctx.dailyRealizedLossUsd = 0
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

function getBalancesList(ctx: TenantExchangeState): ExchangeBalance[] {
  return Object.entries(ctx.demoBalances).map(([asset, bal]) => ({
    asset,
    free: Number(bal.free.toFixed(asset === 'USDT' ? 2 : 6)),
    locked: Number(bal.locked.toFixed(asset === 'USDT' ? 2 : 6)),
  }))
}

export function getExchangeStatusSnapshot(
  tenantId = DEFAULT_TENANT_ID,
): ExchangeStatusSnapshot {
  const ctx = getTenantCtx(tenantId)
  syncDailyCounters(ctx)
  const creds = getTestnetCredentials()
  return {
    mode: creds ? 'binance-testnet' : 'demo-vault',
    testnetConfigured: Boolean(creds),
    autoMirrorBotOrders: ctx.autoMirrorBotOrders,
    killSwitchActive: ctx.killSwitchActive,
    killSwitchActivatedAt: ctx.killSwitchActivatedAt,
    killSwitchReason: ctx.killSwitchReason,
    hardLimits: {
      ...ctx.hardLimits,
      allowedPairs: [...ctx.hardLimits.allowedPairs],
    },
    dailyOrderCount: ctx.dailyOrderCount,
    dailyRealizedLossUsd: Number(ctx.dailyRealizedLossUsd.toFixed(2)),
    balances: getBalancesList(ctx),
    orders: ctx.orderHistory.slice(0, 40),
  }
}

export function getTenantLedgerSnapshot(
  tenantId = DEFAULT_TENANT_ID,
): TenantLedgerSnapshot {
  const ctx = getTenantCtx(tenantId)
  return {
    tenantId,
    verification: verifyLedgerInvariant(ctx.ledgerEntries),
    walletBalances: deriveWalletBalances(ctx.ledgerEntries),
    accountBalances: deriveAccountBalances(ctx.ledgerEntries),
    entries: ctx.ledgerEntries.slice(-100),
  }
}

export function appendTenantLedgerEntry(
  tenantId: string,
  entry: LedgerEntry,
): void {
  const ctx = getTenantCtx(tenantId)
  ctx.ledgerEntries.push(entry)
  if (ctx.ledgerEntries.length > MAX_IN_MEMORY_LEDGER) {
    ctx.ledgerEntries = ctx.ledgerEntries.slice(-MAX_IN_MEMORY_LEDGER)
  }
  void getStateStore()
    .appendLedgerEntry(entry)
    .catch(() => {})
}

function validateHardRiskLimits(
  ctx: TenantExchangeState,
  params: {
    pair: string
    side: 'BUY' | 'SELL'
    notionalUsd: number
  },
): string | null {
  syncDailyCounters(ctx)

  if (ctx.killSwitchActive) {
    return `Emergency Kill-Switch ACTIVE (${ctx.killSwitchReason ?? 'Manual lock'}). Reset the Kill-Switch before trading.`
  }

  if (!ctx.hardLimits.allowedPairs.includes(params.pair)) {
    return `Pair not authorized by hard risk limits: ${params.pair}. Allowed: ${ctx.hardLimits.allowedPairs.join(', ')}`
  }

  if (!Number.isFinite(params.notionalUsd) || params.notionalUsd <= 0) {
    return 'Order notional amount must be greater than $0 USD.'
  }

  if (params.notionalUsd > ctx.hardLimits.maxOrderNotionalUsd) {
    return `Order rejected by hard risk limit: $${params.notionalUsd.toFixed(2)} USD exceeds the max allowed per order ($${ctx.hardLimits.maxOrderNotionalUsd.toFixed(2)} USD).`
  }

  if (ctx.dailyOrderCount >= ctx.hardLimits.maxDailyOrders) {
    return `Daily order limit reached (${ctx.dailyOrderCount}/${ctx.hardLimits.maxDailyOrders} UTC orders).`
  }

  if (ctx.dailyRealizedLossUsd >= ctx.hardLimits.maxDailyLossUsd) {
    return `Daily hard loss limit reached (-$${ctx.dailyRealizedLossUsd.toFixed(2)} >= -$${ctx.hardLimits.maxDailyLossUsd.toFixed(2)} USD).`
  }

  return null
}

async function resolveExecutionPrice(
  pair: string,
  referencePrice?: number,
): Promise<number | null> {
  if (
    typeof referencePrice === 'number' &&
    Number.isFinite(referencePrice) &&
    referencePrice > 0
  ) {
    return referencePrice
  }
  try {
    const { candles } = await fetchOptimizedCandles(pair, '5m', 5)
    const last = candles[candles.length - 1]
    if (last && Number.isFinite(last.close) && last.close > 0) {
      return last.close
    }
  } catch {
    // Upstream price unavailable — never substitute hardcoded simulated prices
  }
  return null
}

function recordRejectedOrder(
  ctx: TenantExchangeState,
  params: {
    pair: string
    side: 'BUY' | 'SELL'
    notionalUsd: number
    price: number
    quantity: number
    mode: ExchangeAdapterMode
    source: 'manual' | 'bot-auto'
    reason: string
    clientOrderId?: string
  },
): {
  ok: false
  error: string
  order: ExchangeOrderRecord
  snapshot: ExchangeStatusSnapshot
} {
  ctx.orderCounter += 1
  const rejectedOrder: ExchangeOrderRecord = {
    id: `ORD-${ctx.orderCounter}`,
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
  ctx.orderHistory = [rejectedOrder, ...ctx.orderHistory].slice(
    0,
    MAX_ORDER_HISTORY,
  )
  void getStateStore()
    .appendOrder(ctx.tenantId, rejectedOrder)
    .catch(() => {})
  return {
    ok: false,
    error: params.reason,
    order: rejectedOrder,
    snapshot: getExchangeStatusSnapshot(ctx.tenantId),
  }
}

/**
 * Submits an order to the Demo exchange adapter (Binance Spot Testnet or local Demo Vault)
 * after enforcing tenant-scoped Hard Risk Limits, idempotency keys, and double-entry ledger posting.
 */
export async function submitExchangeOrder(params: {
  tenantId?: string
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
  const tenantId = params.tenantId ?? DEFAULT_TENANT_ID
  const ctx = getTenantCtx(tenantId)
  syncDailyCounters(ctx)

  if (params.clientOrderId) {
    const existing = ctx.orderHistory.find(
      (o) => o.clientOrderId === params.clientOrderId,
    )
    if (existing) {
      return {
        ok: existing.status === 'FILLED',
        error: existing.status === 'FILLED' ? undefined : existing.reason,
        order: existing,
        snapshot: getExchangeStatusSnapshot(tenantId),
      }
    }
  }

  const creds = getTestnetCredentials()
  const mode: ExchangeAdapterMode = creds ? 'binance-testnet' : 'demo-vault'
  const source = params.source ?? 'manual'
  const resolvedPrice = await resolveExecutionPrice(
    params.pair,
    params.referencePrice,
  )

  const rejectionReason = validateHardRiskLimits(ctx, {
    pair: params.pair,
    side: params.side,
    notionalUsd: params.notionalUsd,
  })

  if (rejectionReason) {
    const price = resolvedPrice ?? 0
    const quantity =
      price > 0 ? Number((params.notionalUsd / price).toFixed(6)) : 0
    return recordRejectedOrder(ctx, {
      pair: params.pair,
      side: params.side,
      notionalUsd: params.notionalUsd,
      price,
      quantity,
      mode,
      source,
      reason: rejectionReason,
      clientOrderId: params.clientOrderId,
    })
  }

  if (resolvedPrice === null) {
    return recordRejectedOrder(ctx, {
      pair: params.pair,
      side: params.side,
      notionalUsd: params.notionalUsd,
      price: 0,
      quantity: 0,
      mode,
      source,
      reason:
        'Rejected: live upstream market price unavailable (refusing hardcoded or simulated fallback price).',
      clientOrderId: params.clientOrderId,
    })
  }

  let fillPrice = resolvedPrice
  let quantity = Number((params.notionalUsd / fillPrice).toFixed(6))

  const baseAsset = params.pair.split('/')[0] ?? 'BTC'
  if (!ctx.demoBalances[baseAsset]) {
    ctx.demoBalances[baseAsset] = { free: 0, locked: 0 }
  }

  let executionNote = 'Executed in Local Demo Vault (Live Market Price)'
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
        return recordRejectedOrder(ctx, {
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

      if (
        payload.status &&
        payload.status !== 'FILLED' &&
        payload.status !== 'PARTIALLY_FILLED'
      ) {
        return recordRejectedOrder(ctx, {
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
      return recordRejectedOrder(ctx, {
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

  // Update balances in the tenant's local Demo Vault
  if (params.side === 'BUY') {
    if (ctx.demoBalances.USDT.free < params.notionalUsd) {
      return recordRejectedOrder(ctx, {
        pair: params.pair,
        side: params.side,
        notionalUsd: params.notionalUsd,
        price: fillPrice,
        quantity,
        mode,
        source,
        reason: `Insufficient USDT balance in Demo Vault ($${ctx.demoBalances.USDT.free.toFixed(2)} < $${params.notionalUsd.toFixed(2)} USD).`,
        clientOrderId: params.clientOrderId,
      })
    }
    ctx.demoBalances.USDT.free -= params.notionalUsd
    ctx.demoBalances[baseAsset].free += quantity
  } else {
    ctx.demoBalances[baseAsset].free = Math.max(
      0,
      ctx.demoBalances[baseAsset].free - quantity,
    )
    ctx.demoBalances.USDT.free += params.notionalUsd
  }

  ctx.dailyOrderCount += 1
  if (typeof params.realizedPnlUsd === 'number' && params.realizedPnlUsd < 0) {
    ctx.dailyRealizedLossUsd += Math.abs(params.realizedPnlUsd)
  }

  ctx.orderCounter += 1
  const filledOrder: ExchangeOrderRecord = {
    id: `ORD-${ctx.orderCounter}`,
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
  ctx.orderHistory = [filledOrder, ...ctx.orderHistory].slice(
    0,
    MAX_ORDER_HISTORY,
  )

  const ledgerEntry = buildSpotFillEntry({
    tenantId,
    orderId: filledOrder.id,
    venueOrderId,
    pair: filledOrder.pair,
    side: filledOrder.side,
    quantity: filledOrder.quantity,
    price: filledOrder.price,
    notionalUsd: filledOrder.notionalUsd,
    mode: filledOrder.mode,
  })
  appendTenantLedgerEntry(tenantId, ledgerEntry)

  void getStateStore()
    .appendOrder(tenantId, filledOrder)
    .catch(() => {})

  return {
    ok: true,
    order: filledOrder,
    snapshot: getExchangeStatusSnapshot(tenantId),
  }
}

export async function triggerEmergencyKillSwitch(
  reason = 'Emergency stop triggered by operator',
  onHaltBot?: () => void,
  tenantId = DEFAULT_TENANT_ID,
): Promise<ExchangeStatusSnapshot> {
  const ctx = getTenantCtx(tenantId)
  ctx.killSwitchActive = true
  ctx.killSwitchActivatedAt = new Date().toISOString()
  ctx.killSwitchReason = reason

  if (onHaltBot) {
    onHaltBot()
  }

  const creds = getTestnetCredentials()
  if (creds) {
    for (const pair of ctx.hardLimits.allowedPairs) {
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

  ctx.orderCounter += 1
  const killRecord: ExchangeOrderRecord = {
    id: `KILL-${ctx.orderCounter}`,
    timestamp: ctx.killSwitchActivatedAt,
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
  ctx.orderHistory = [killRecord, ...ctx.orderHistory].slice(0, 60)
  void getStateStore()
    .appendOrder(tenantId, killRecord)
    .catch(() => {})

  return getExchangeStatusSnapshot(tenantId)
}

export function resetEmergencyKillSwitch(
  tenantId = DEFAULT_TENANT_ID,
): ExchangeStatusSnapshot {
  const ctx = getTenantCtx(tenantId)
  ctx.killSwitchActive = false
  ctx.killSwitchActivatedAt = null
  ctx.killSwitchReason = null
  return getExchangeStatusSnapshot(tenantId)
}

export function updateHardRiskLimits(
  partial: Partial<HardRiskLimits>,
  tenantId = DEFAULT_TENANT_ID,
): ExchangeStatusSnapshot {
  const ctx = getTenantCtx(tenantId)
  if (
    typeof partial.maxOrderNotionalUsd === 'number' &&
    partial.maxOrderNotionalUsd >= 10
  ) {
    ctx.hardLimits.maxOrderNotionalUsd = partial.maxOrderNotionalUsd
  }
  if (
    typeof partial.maxDailyLossUsd === 'number' &&
    partial.maxDailyLossUsd >= 10
  ) {
    ctx.hardLimits.maxDailyLossUsd = partial.maxDailyLossUsd
  }
  if (
    typeof partial.maxDailyOrders === 'number' &&
    partial.maxDailyOrders >= 1
  ) {
    ctx.hardLimits.maxDailyOrders = Math.round(partial.maxDailyOrders)
  }
  if (Array.isArray(partial.allowedPairs) && partial.allowedPairs.length > 0) {
    const valid = partial.allowedPairs.filter((p) => availablePairs.includes(p))
    if (valid.length > 0) {
      ctx.hardLimits.allowedPairs = valid
    }
  }
  return getExchangeStatusSnapshot(tenantId)
}

export function setExchangeAutoMirror(
  enabled: boolean,
  tenantId = DEFAULT_TENANT_ID,
): ExchangeStatusSnapshot {
  const ctx = getTenantCtx(tenantId)
  ctx.autoMirrorBotOrders = Boolean(enabled)
  return getExchangeStatusSnapshot(tenantId)
}

export function exportExchangeState(
  tenantId = DEFAULT_TENANT_ID,
): PersistedExchangeState {
  const ctx = getTenantCtx(tenantId)
  syncDailyCounters(ctx)
  return {
    schemaVersion: 1,
    autoMirrorBotOrders: ctx.autoMirrorBotOrders,
    killSwitchActive: ctx.killSwitchActive,
    killSwitchActivatedAt: ctx.killSwitchActivatedAt,
    killSwitchReason: ctx.killSwitchReason,
    currentUtcDayKey: ctx.currentUtcDayKey,
    dailyOrderCount: ctx.dailyOrderCount,
    dailyRealizedLossUsd: Number(ctx.dailyRealizedLossUsd.toFixed(2)),
    hardLimits: {
      ...ctx.hardLimits,
      allowedPairs: [...ctx.hardLimits.allowedPairs],
    },
    balances: structuredClone(ctx.demoBalances),
    orderHistory: ctx.orderHistory.slice(0, MAX_ORDER_HISTORY),
    orderCounter: ctx.orderCounter,
  }
}

export function restoreExchangeState(
  persisted?: Partial<PersistedExchangeState> | null,
  tenantId = DEFAULT_TENANT_ID,
): ExchangeStatusSnapshot {
  const ctx = getTenantCtx(tenantId)
  if (!persisted || typeof persisted !== 'object') {
    return getExchangeStatusSnapshot(tenantId)
  }

  if (typeof persisted.autoMirrorBotOrders === 'boolean') {
    ctx.autoMirrorBotOrders = persisted.autoMirrorBotOrders
  }
  if (typeof persisted.killSwitchActive === 'boolean') {
    ctx.killSwitchActive = persisted.killSwitchActive
    ctx.killSwitchActivatedAt = persisted.killSwitchActivatedAt ?? null
    ctx.killSwitchReason = persisted.killSwitchReason ?? null
  }

  if (persisted.hardLimits) {
    updateHardRiskLimits(persisted.hardLimits, tenantId)
  }

  const todayKey = Math.floor(Date.now() / 86_400_000)
  if (persisted.currentUtcDayKey === todayKey) {
    ctx.currentUtcDayKey = todayKey
    ctx.dailyOrderCount =
      typeof persisted.dailyOrderCount === 'number' &&
      Number.isFinite(persisted.dailyOrderCount)
        ? Math.max(0, Math.round(persisted.dailyOrderCount))
        : 0
    ctx.dailyRealizedLossUsd =
      typeof persisted.dailyRealizedLossUsd === 'number' &&
      Number.isFinite(persisted.dailyRealizedLossUsd)
        ? Math.max(0, persisted.dailyRealizedLossUsd)
        : 0
  } else {
    ctx.currentUtcDayKey = todayKey
    ctx.dailyOrderCount = 0
    ctx.dailyRealizedLossUsd = 0
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
      ctx.demoBalances = nextBalances
    }
  }

  const restoredOrders = Array.isArray(persisted.orderHistory)
    ? persisted.orderHistory.slice(0, MAX_ORDER_HISTORY)
    : []
  ctx.orderHistory = restoredOrders

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
  ctx.orderCounter = Math.max(
    ctx.orderCounter,
    persistedCounter,
    maxOrderNum,
    1000,
  )

  return getExchangeStatusSnapshot(tenantId)
}

export function resetExchangeDemoVault(
  tenantId = DEFAULT_TENANT_ID,
): ExchangeStatusSnapshot {
  const ctx = getTenantCtx(tenantId)
  ctx.killSwitchActive = false
  ctx.killSwitchActivatedAt = null
  ctx.killSwitchReason = null
  ctx.dailyOrderCount = 0
  ctx.dailyRealizedLossUsd = 0
  ctx.hardLimits = {
    ...DEFAULT_HARD_LIMITS,
    allowedPairs: [...availablePairs],
  }
  ctx.demoBalances = structuredClone(INITIAL_DEMO_BALANCES)
  ctx.orderHistory = []
  const resetEntry = buildInitialFundingEntry(
    tenantId,
    ctx.demoBalances,
    `reset-${Date.now()}`,
  )
  ctx.ledgerEntries = [resetEntry]
  void getStateStore()
    .appendLedgerEntry(resetEntry)
    .catch(() => {})
  return getExchangeStatusSnapshot(tenantId)
}

export function clearAllTenantExchangeStates(): void {
  tenantContexts.clear()
}
