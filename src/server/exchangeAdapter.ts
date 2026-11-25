import crypto from 'node:crypto'
import { availablePairs } from '../strategy'
import { dispatchRuntimeAlert } from './alertDispatcher'
import {
  cancelBinanceProtectiveExit,
  computeClosedExchangePositionMetrics,
  estimateFeeUsd,
  fetchBinanceSymbolFilters,
  getBinanceLiveArmStatus,
  placeBinanceProtectiveExit,
  reconcileOpenBinancePositions,
  resolveBinanceVenueCredentials,
  validateAndQuantizeBinanceOrder,
  type BinanceSymbolFilters,
  type VenueReconciliationReport,
} from './binanceLiveProtection'
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
import type { ExchangePositionRecord } from './store/types'

export type ExchangeAdapterMode =
  | 'binance-testnet'
  | 'binance-live'
  | 'paper'
export type ExchangeOrderVenue =
  | ExchangeAdapterMode
  | 'demo-vault'
  | 'polymarket-clob'

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
  | 'NEW'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'EXPIRED'
  | 'LIVE'
  | 'REJECTED_RISK'
  | 'CANCELED_KILLSWITCH'

export type ExchangeOrderRecord = {
  id: string
  clientOrderId?: string
  venueOrderId?: string
  timestamp: string
  updatedAt?: string
  pair: string
  side: 'BUY' | 'SELL'
  notionalUsd: number
  price: number
  avgPrice?: number
  quantity: number
  filledQty?: number
  fee?: number
  feeAsset?: string
  status: ExchangeOrderStatus
  mode: ExchangeOrderVenue
  source: 'manual' | 'bot-auto'
  presetId?: string | null
  reason?: string
}

export type BotOwnedTestnetPosition = {
  pair: string
  side: 'BUY'
  quantity: number
  entryPrice: number
  entryTime: number
  orderId: string
  venueOrderId?: string
  positionId?: string
  presetId?: string | null
  stopPrice?: number | null
  targetPrice?: number | null
  protectionOrderId?: string | null
}

export type PersistedExchangeState = {
  schemaVersion: 1 | 2
  autoMirrorBotOrders: boolean
  killSwitchActive: boolean
  killSwitchActivatedAt: string | null
  killSwitchReason: string | null
  currentUtcDayKey: number
  dailyOrderCount: number
  dailyRealizedLossUsd: number
  hardLimits: HardRiskLimits
  paperFunded?: boolean
  balances: Record<string, { free: number; locked: number }>
  botOwnedPosition?: BotOwnedTestnetPosition | null
  orderHistory: ExchangeOrderRecord[]
  orderCounter: number
  updatedAt?: string | null
}

export type ExchangeStatusSnapshot = {
  mode: ExchangeAdapterMode
  testnetConfigured: boolean
  liveArmed?: boolean
  liveKeysPresent?: boolean
  protectiveExitsEnabled?: boolean
  paperFunded: boolean
  autoMirrorBotOrders: boolean
  killSwitchActive: boolean
  killSwitchActivatedAt: string | null
  killSwitchReason: string | null
  hardLimits: HardRiskLimits
  dailyOrderCount: number
  dailyRealizedLossUsd: number
  balances: ExchangeBalance[]
  orders: ExchangeOrderRecord[]
  botOwnedPosition: BotOwnedTestnetPosition | null
  updatedAt: string | null
}

export type ExchangeAccountResponse =
  | {
      connected: true
      mode: 'binance-testnet' | 'binance-live'
      accountType: string
      canTrade: boolean
      canWithdraw: boolean
      balances: (ExchangeBalance & { usdValue?: number | null })[]
      totalEquityUsd: number | null
      paperFunded: boolean
      paperBalances: ExchangeBalance[]
      updatedAt: string
    }
  | {
      connected: false
      mode: ExchangeAdapterMode
      reason: string
      requiredEnv: readonly string[]
      paperFunded: boolean
      paperBalances: ExchangeBalance[]
      updatedAt: string
    }

export type TenantLedgerSnapshot = {
  tenantId: string
  verification: LedgerVerificationReport
  walletBalances: Record<string, number>
  accountBalances: Record<string, { asset: string; balance: number }>
  entries: LedgerEntry[]
}

const DEFAULT_TENANT_ID = 'default'
const REQUIRED_TESTNET_ENV = [
  'BINANCE_TESTNET_KEY',
  'BINANCE_TESTNET_SECRET',
] as const

export const HARD_LIMIT_BOUNDS = {
  maxOrderNotionalUsd: { min: 10, max: 100_000 },
  maxDailyLossUsd: { min: 10, max: 250_000 },
  maxDailyOrders: { min: 1, max: 500 },
} as const

export const PAPER_FUNDING_BOUNDS = {
  min: 10,
  max: 10_000_000,
} as const

const DEFAULT_HARD_LIMITS: HardRiskLimits = {
  maxOrderNotionalUsd: 500,
  maxDailyLossUsd: 250,
  maxDailyOrders: 12,
  allowedPairs: [...availablePairs],
}

const TESTNET_TIMEOUT_MS = 6_000
const MAX_ORDER_HISTORY = 120
const MAX_IN_MEMORY_LEDGER = 500
const CLIENT_ORDER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

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
  paperFunded: boolean
  paperBalances: Record<string, { free: number; locked: number }>
  botOwnedPosition: BotOwnedTestnetPosition | null
  orderHistory: ExchangeOrderRecord[]
  orderCounter: number
  orderCounterSynced: boolean
  ledgerEntries: LedgerEntry[]
  updatedAt: string | null
}

const tenantContexts = new Map<string, TenantExchangeState>()
const inFlightOrderSubmissions = new Map<
  string,
  Promise<{
    ok: boolean
    error?: string
    order: ExchangeOrderRecord
    snapshot: ExchangeStatusSnapshot
    deduplicated?: boolean
  }>
>()

function createFreshTenantState(tenantId: string): TenantExchangeState {
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
    paperFunded: false,
    paperBalances: {},
    botOwnedPosition: null,
    orderHistory: [],
    orderCounter: 1000,
    orderCounterSynced: false,
    ledgerEntries: [],
    updatedAt: null,
  }
}

async function allocateNextOrderNumber(
  ctx: TenantExchangeState,
): Promise<number> {
  if (!ctx.orderCounterSynced) {
    ctx.orderCounterSynced = true
    try {
      const persistedOrders = await getStateStore().getOrders(
        ctx.tenantId,
        1_000,
      )
      for (const ord of persistedOrders) {
        const match = /^(?:ORD|KILL)-(\d+)$/.exec(ord.id)
        if (match) {
          const n = Number(match[1])
          if (Number.isFinite(n) && n > ctx.orderCounter) {
            ctx.orderCounter = n
          }
        }
      }
    } catch {
      // Keep current monotonic counter if store read fails
    }
  }
  ctx.orderCounter += 1
  return ctx.orderCounter
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

export function getTestnetCredentials(): {
  apiKey: string
  apiSecret: string
} | null {
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

function getPaperBalancesList(ctx: TenantExchangeState): ExchangeBalance[] {
  if (!ctx.paperFunded) return []
  return Object.entries(ctx.paperBalances).map(([asset, bal]) => ({
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
  const venue = resolveBinanceVenueCredentials()
  const armStatus = getBinanceLiveArmStatus()
  const mode: ExchangeAdapterMode = venue ? venue.mode : 'paper'
  return {
    mode,
    testnetConfigured: Boolean(venue),
    liveArmed: armStatus.liveArmed,
    liveKeysPresent: armStatus.liveKeysPresent,
    protectiveExitsEnabled: armStatus.protectiveExitsEnabled,
    paperFunded: ctx.paperFunded,
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
    balances: mode === 'paper' ? getPaperBalancesList(ctx) : [],
    orders: ctx.orderHistory.slice(0, 40),
    botOwnedPosition: ctx.botOwnedPosition ? { ...ctx.botOwnedPosition } : null,
    updatedAt: ctx.updatedAt,
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

export function recordExternalVenueOrderCount(
  tenantId = DEFAULT_TENANT_ID,
): number {
  const ctx = getTenantCtx(tenantId)
  syncDailyCounters(ctx)
  ctx.dailyOrderCount += 1
  ctx.updatedAt = new Date().toISOString()
  return ctx.dailyOrderCount
}

export function fundPaperAccount(
  amountUsd: number,
  tenantId = DEFAULT_TENANT_ID,
):
  | { ok: true; snapshot: ExchangeStatusSnapshot; amountUsd: number }
  | { ok: false; error: string } {
  if (
    typeof amountUsd !== 'number' ||
    !Number.isFinite(amountUsd) ||
    amountUsd < PAPER_FUNDING_BOUNDS.min ||
    amountUsd > PAPER_FUNDING_BOUNDS.max
  ) {
    return {
      ok: false,
      error: `Paper funding amount must be between $${PAPER_FUNDING_BOUNDS.min} and $${PAPER_FUNDING_BOUNDS.max.toLocaleString('en-US')} USD.`,
    }
  }
  const rounded = Number(amountUsd.toFixed(2))
  const ctx = getTenantCtx(tenantId)
  ctx.paperFunded = true
  ctx.paperBalances = {
    USDT: { free: rounded, locked: 0 },
  }
  ctx.updatedAt = new Date().toISOString()
  const entry = buildInitialFundingEntry(
    tenantId,
    ctx.paperBalances,
    `paper-fund-${Date.now()}`,
  )
  appendTenantLedgerEntry(tenantId, entry)
  return {
    ok: true,
    amountUsd: rounded,
    snapshot: getExchangeStatusSnapshot(tenantId),
  }
}

export async function fetchExchangeAccount(
  tenantId = DEFAULT_TENANT_ID,
  options?: { fetchImpl?: typeof fetch },
): Promise<ExchangeAccountResponse> {
  const ctx = getTenantCtx(tenantId)
  const nowIso = new Date().toISOString()
  const paperBalances = getPaperBalancesList(ctx)
  const venue = resolveBinanceVenueCredentials()

  if (!venue) {
    return {
      connected: false,
      mode: 'paper',
      reason:
        'Binance Spot Testnet credentials are not configured in server environment variables.',
      requiredEnv: REQUIRED_TESTNET_ENV,
      paperFunded: ctx.paperFunded,
      paperBalances,
      updatedAt: nowIso,
    }
  }

  const venueLabel =
    venue.mode === 'binance-live' ? 'Binance Spot Live' : 'Binance Spot Testnet'
  const fetchFn = options?.fetchImpl ?? globalThis.fetch
  try {
    const query = `timestamp=${Date.now()}&recvWindow=5000`
    const signature = signQuery(query, venue.apiSecret)
    const response = await fetchFn(
      `${venue.baseUrl}/api/v3/account?${query}&signature=${signature}`,
      {
        method: 'GET',
        headers: { 'X-MBX-APIKEY': venue.apiKey },
        signal: AbortSignal.timeout(TESTNET_TIMEOUT_MS),
      },
    )

    const payload = (await response.json().catch(() => null)) as {
      accountType?: string
      canTrade?: boolean
      canWithdraw?: boolean
      balances?: { asset?: string; free?: string; locked?: string }[]
      msg?: string
      code?: number
    } | null

    if (!response.ok || !payload || !Array.isArray(payload.balances)) {
      return {
        connected: false,
        mode: venue.mode,
        reason: `${venueLabel} HTTP ${response.status}: ${payload?.msg ?? 'Failed to fetch account balances.'}`,
        requiredEnv: REQUIRED_TESTNET_ENV,
        paperFunded: ctx.paperFunded,
        paperBalances,
        updatedAt: nowIso,
      }
    }

    const trackedAssets = new Set<string>([
      'USDT',
      ...ctx.hardLimits.allowedPairs.map((p) => p.split('/')[0] ?? ''),
    ])

    const rawBalances = payload.balances
      .map((item) => ({
        asset: String(item.asset ?? '').toUpperCase(),
        free: Number(item.free ?? 0),
        locked: Number(item.locked ?? 0),
      }))
      .filter(
        (b) =>
          b.asset.length > 0 &&
          Number.isFinite(b.free) &&
          Number.isFinite(b.locked) &&
          (b.free > 0 || b.locked > 0 || trackedAssets.has(b.asset)),
      )

    // Value tracked non-USDT spot holdings at live Binance prices
    let totalEquityUsd: number | null = 0
    const valuedBalances: (ExchangeBalance & { usdValue?: number | null })[] =
      []
    for (const bal of rawBalances) {
      const totalQty = bal.free + bal.locked
      if (bal.asset === 'USDT' || bal.asset === 'USDC' || bal.asset === 'FDUSD') {
        const usdValue = Number(totalQty.toFixed(2))
        valuedBalances.push({ ...bal, usdValue })
        if (totalEquityUsd !== null) totalEquityUsd += usdValue
      } else if (totalQty > 0 && availablePairs.includes(`${bal.asset}/USDT`)) {
        const livePrice = await resolveExecutionPrice(`${bal.asset}/USDT`)
        if (livePrice !== null) {
          const usdValue = Number((totalQty * livePrice).toFixed(2))
          valuedBalances.push({ ...bal, usdValue })
          if (totalEquityUsd !== null) totalEquityUsd += usdValue
        } else {
          valuedBalances.push({ ...bal, usdValue: null })
          totalEquityUsd = null
        }
      } else {
        valuedBalances.push({ ...bal, usdValue: totalQty === 0 ? 0 : null })
      }
    }

    ctx.updatedAt = nowIso
    return {
      connected: true,
      mode: venue.mode,
      accountType: payload.accountType ?? 'SPOT',
      canTrade: Boolean(payload.canTrade),
      canWithdraw: Boolean(payload.canWithdraw),
      balances: valuedBalances,
      totalEquityUsd:
        totalEquityUsd !== null ? Number(totalEquityUsd.toFixed(2)) : null,
      paperFunded: ctx.paperFunded,
      paperBalances,
      updatedAt: nowIso,
    }
  } catch (err) {
    return {
      connected: false,
      mode: venue.mode,
      reason: `${venueLabel} unreachable: ${err instanceof Error ? err.message : String(err)}`,
      requiredEnv: REQUIRED_TESTNET_ENV,
      paperFunded: ctx.paperFunded,
      paperBalances,
      updatedAt: nowIso,
    }
  }
}

export function validateHardRiskLimitsUpdate(
  partial: Partial<HardRiskLimits> & { autoMirrorBotOrders?: boolean },
):
  | {
      ok: true
      sanitized: Partial<HardRiskLimits> & { autoMirrorBotOrders?: boolean }
    }
  | { ok: false; error: string } {
  const sanitized: Partial<HardRiskLimits> & {
    autoMirrorBotOrders?: boolean
  } = {}

  if (partial.maxOrderNotionalUsd !== undefined) {
    if (
      typeof partial.maxOrderNotionalUsd !== 'number' ||
      !Number.isFinite(partial.maxOrderNotionalUsd) ||
      partial.maxOrderNotionalUsd < HARD_LIMIT_BOUNDS.maxOrderNotionalUsd.min ||
      partial.maxOrderNotionalUsd > HARD_LIMIT_BOUNDS.maxOrderNotionalUsd.max
    ) {
      return {
        ok: false,
        error: `maxOrderNotionalUsd must be between $${HARD_LIMIT_BOUNDS.maxOrderNotionalUsd.min} and $${HARD_LIMIT_BOUNDS.maxOrderNotionalUsd.max.toLocaleString('en-US')} USD.`,
      }
    }
    sanitized.maxOrderNotionalUsd = Number(
      partial.maxOrderNotionalUsd.toFixed(2),
    )
  }

  if (partial.maxDailyLossUsd !== undefined) {
    if (
      typeof partial.maxDailyLossUsd !== 'number' ||
      !Number.isFinite(partial.maxDailyLossUsd) ||
      partial.maxDailyLossUsd < HARD_LIMIT_BOUNDS.maxDailyLossUsd.min ||
      partial.maxDailyLossUsd > HARD_LIMIT_BOUNDS.maxDailyLossUsd.max
    ) {
      return {
        ok: false,
        error: `maxDailyLossUsd must be between $${HARD_LIMIT_BOUNDS.maxDailyLossUsd.min} and $${HARD_LIMIT_BOUNDS.maxDailyLossUsd.max.toLocaleString('en-US')} USD.`,
      }
    }
    sanitized.maxDailyLossUsd = Number(partial.maxDailyLossUsd.toFixed(2))
  }

  if (partial.maxDailyOrders !== undefined) {
    if (
      typeof partial.maxDailyOrders !== 'number' ||
      !Number.isFinite(partial.maxDailyOrders) ||
      !Number.isInteger(partial.maxDailyOrders) ||
      partial.maxDailyOrders < HARD_LIMIT_BOUNDS.maxDailyOrders.min ||
      partial.maxDailyOrders > HARD_LIMIT_BOUNDS.maxDailyOrders.max
    ) {
      return {
        ok: false,
        error: `maxDailyOrders must be an integer between ${HARD_LIMIT_BOUNDS.maxDailyOrders.min} and ${HARD_LIMIT_BOUNDS.maxDailyOrders.max}.`,
      }
    }
    sanitized.maxDailyOrders = partial.maxDailyOrders
  }

  if (partial.allowedPairs !== undefined) {
    if (!Array.isArray(partial.allowedPairs) || partial.allowedPairs.length === 0) {
      return {
        ok: false,
        error: 'allowedPairs must contain at least one authorized trading pair.',
      }
    }
    const invalid = partial.allowedPairs.filter(
      (p) => typeof p !== 'string' || !availablePairs.includes(p),
    )
    if (invalid.length > 0) {
      return {
        ok: false,
        error: `Unsupported trading pair(s): ${invalid.join(', ')}. Allowed: ${availablePairs.join(', ')}.`,
      }
    }
    sanitized.allowedPairs = Array.from(new Set(partial.allowedPairs))
  }

  if (partial.autoMirrorBotOrders !== undefined) {
    if (typeof partial.autoMirrorBotOrders !== 'boolean') {
      return {
        ok: false,
        error: 'autoMirrorBotOrders must be a boolean.',
      }
    }
    sanitized.autoMirrorBotOrders = partial.autoMirrorBotOrders
  }

  return { ok: true, sanitized }
}

function validateHardRiskLimits(
  ctx: TenantExchangeState,
  params: {
    pair: string
    side: 'BUY' | 'SELL'
    notionalUsd: number
    clientOrderId?: string
  },
): string | null {
  syncDailyCounters(ctx)

  if (ctx.killSwitchActive) {
    return `Emergency Kill-Switch ACTIVE (${ctx.killSwitchReason ?? 'Manual lock'}). Reset the Kill-Switch before trading.`
  }

  if (
    params.clientOrderId !== undefined &&
    !CLIENT_ORDER_ID_PATTERN.test(params.clientOrderId)
  ) {
    return 'Invalid clientOrderId format (expected 1-64 alphanumeric, dash, or underscore characters).'
  }

  if (!availablePairs.includes(params.pair)) {
    return `Unsupported trading pair: ${params.pair}.`
  }

  if (!ctx.hardLimits.allowedPairs.includes(params.pair)) {
    return `Pair not authorized by hard risk limits: ${params.pair}. Allowed: ${ctx.hardLimits.allowedPairs.join(', ')}`
  }

  if (params.side !== 'BUY' && params.side !== 'SELL') {
    return `Invalid order side: ${String(params.side)}. Expected BUY or SELL.`
  }

  if (!Number.isFinite(params.notionalUsd) || params.notionalUsd <= 0) {
    return 'Order notional amount must be greater than $0 USD.'
  }

  if (params.notionalUsd < HARD_LIMIT_BOUNDS.maxOrderNotionalUsd.min) {
    return `Order notional must be at least $${HARD_LIMIT_BOUNDS.maxOrderNotionalUsd.min} USD.`
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

async function recordRejectedOrder(
  ctx: TenantExchangeState,
  params: {
    pair: string
    side: 'BUY' | 'SELL'
    notionalUsd: number
    price: number
    quantity: number
    mode: ExchangeAdapterMode
    source: 'manual' | 'bot-auto'
    presetId?: string | null
    reason: string
    clientOrderId?: string
  },
): Promise<{
  ok: false
  error: string
  order: ExchangeOrderRecord
  snapshot: ExchangeStatusSnapshot
}> {
  const nextOrdNum = await allocateNextOrderNumber(ctx)
  const nowIso = new Date().toISOString()
  const rejectedOrder: ExchangeOrderRecord = {
    id: `ORD-${nextOrdNum}`,
    clientOrderId: params.clientOrderId,
    timestamp: nowIso,
    updatedAt: nowIso,
    pair: params.pair,
    side: params.side,
    notionalUsd: Number(params.notionalUsd.toFixed(2)),
    price: Number(params.price.toFixed(2)),
    quantity: params.quantity,
    filledQty: 0,
    status: 'REJECTED_RISK',
    mode: params.mode,
    source: params.source,
    ...(params.source === 'bot-auto' && params.presetId
      ? { presetId: params.presetId }
      : {}),
    reason: params.reason,
  }
  ctx.orderHistory = [rejectedOrder, ...ctx.orderHistory].slice(
    0,
    MAX_ORDER_HISTORY,
  )
  ctx.updatedAt = nowIso
  await getStateStore()
    .appendOrder(ctx.tenantId, rejectedOrder)
    .catch(() => {})
  return {
    ok: false,
    error: params.reason,
    order: rejectedOrder,
    snapshot: getExchangeStatusSnapshot(ctx.tenantId),
  }
}

function normalizeVenueOrderStatus(raw?: string): ExchangeOrderStatus {
  switch (raw?.toUpperCase()) {
    case 'NEW':
      return 'NEW'
    case 'PARTIALLY_FILLED':
      return 'PARTIALLY_FILLED'
    case 'FILLED':
      return 'FILLED'
    case 'CANCELED':
    case 'CANCELLED':
      return 'CANCELED'
    case 'EXPIRED':
      return 'EXPIRED'
    default:
      return 'REJECTED_RISK'
  }
}

function extractBinanceFillsSummary(
  fills?: { commission?: string; commissionAsset?: string }[],
): { fee?: number; feeAsset?: string } {
  if (!Array.isArray(fills) || fills.length === 0) return {}
  let total = 0
  let feeAsset: string | undefined
  for (const fill of fills) {
    const c = Number(fill.commission ?? 0)
    if (Number.isFinite(c) && c > 0) {
      total += c
      if (!feeAsset && fill.commissionAsset) {
        feeAsset = fill.commissionAsset
      }
    }
  }
  if (total <= 0) return {}
  return {
    fee: Number(total.toFixed(8)),
    feeAsset,
  }
}

/**
 * Submits an order to Binance Spot Testnet or the operator-funded Paper ledger
 * after enforcing tenant-scoped Hard Risk Limits, durable SQL idempotency,
 * and double-entry ledger posting.
 */
export async function submitExchangeOrder(params: {
  tenantId?: string
  pair: string
  side: 'BUY' | 'SELL'
  notionalUsd: number
  exactQuantity?: number
  referencePrice?: number
  realizedPnlUsd?: number
  stopPrice?: number | null
  targetPrice?: number | null
  exitReason?: string | null
  source?: 'manual' | 'bot-auto'
  presetId?: string | null
  clientOrderId?: string
  bypassRiskForClose?: boolean
  fetchImpl?: typeof fetch
}): Promise<{
  ok: boolean
  error?: string
  order: ExchangeOrderRecord
  snapshot: ExchangeStatusSnapshot
  deduplicated?: boolean
}> {
  const tenantId = params.tenantId ?? DEFAULT_TENANT_ID
  const dedupeKey = params.clientOrderId
    ? `${tenantId}:${params.clientOrderId}`
    : null

  if (dedupeKey) {
    const pending = inFlightOrderSubmissions.get(dedupeKey)
    if (pending) {
      return pending
    }
  }

  const run = executeOrderSubmission(tenantId, params)
  if (dedupeKey) {
    inFlightOrderSubmissions.set(dedupeKey, run)
  }
  try {
    return await run
  } finally {
    if (dedupeKey) {
      inFlightOrderSubmissions.delete(dedupeKey)
    }
  }
}

async function executeOrderSubmission(
  tenantId: string,
  params: {
    pair: string
    side: 'BUY' | 'SELL'
    notionalUsd: number
    exactQuantity?: number
    referencePrice?: number
    realizedPnlUsd?: number
    stopPrice?: number | null
    targetPrice?: number | null
    exitReason?: string | null
    source?: 'manual' | 'bot-auto'
    presetId?: string | null
    clientOrderId?: string
    bypassRiskForClose?: boolean
    fetchImpl?: typeof fetch
  },
): Promise<{
  ok: boolean
  error?: string
  order: ExchangeOrderRecord
  snapshot: ExchangeStatusSnapshot
  deduplicated?: boolean
}> {
  const ctx = getTenantCtx(tenantId)
  syncDailyCounters(ctx)

  // Durable idempotency: check in-memory AND SQL store before submitting to any venue
  if (params.clientOrderId) {
    const memExisting = ctx.orderHistory.find(
      (o) => o.clientOrderId === params.clientOrderId,
    )
    const existing =
      memExisting ??
      (await getStateStore().findOrderByClientOrderId(
        tenantId,
        params.clientOrderId,
      ))
    if (existing) {
      if (!memExisting) {
        ctx.orderHistory = [existing, ...ctx.orderHistory].slice(
          0,
          MAX_ORDER_HISTORY,
        )
      }
      const isSuccess =
        existing.status === 'FILLED' ||
        existing.status === 'PARTIALLY_FILLED' ||
        existing.status === 'NEW' ||
        existing.status === 'LIVE'
      return {
        ok: isSuccess,
        error: isSuccess ? undefined : existing.reason,
        order: existing,
        snapshot: getExchangeStatusSnapshot(tenantId),
        deduplicated: true,
      }
    }
  }

  const venue = resolveBinanceVenueCredentials()
  const mode: ExchangeAdapterMode = venue ? venue.mode : 'paper'
  const venueLabel =
    mode === 'binance-live' ? 'Binance Spot Live' : 'Binance Spot Testnet'
  const source = params.source ?? 'manual'
  const resolvedPrice = await resolveExecutionPrice(
    params.pair,
    params.referencePrice,
  )

  if (!params.bypassRiskForClose) {
    const rejectionReason = validateHardRiskLimits(ctx, {
      pair: params.pair,
      side: params.side,
      notionalUsd: params.notionalUsd,
      clientOrderId: params.clientOrderId,
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
        presetId: params.presetId,
        reason: rejectionReason,
        clientOrderId: params.clientOrderId,
      })
    }
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
      presetId: params.presetId,
      reason:
        'Rejected: live upstream market price unavailable (refusing hardcoded or simulated fallback price).',
      clientOrderId: params.clientOrderId,
    })
  }

  let fillPrice = resolvedPrice
  let quantity =
    typeof params.exactQuantity === 'number' &&
    Number.isFinite(params.exactQuantity) &&
    params.exactQuantity > 0
      ? Number(params.exactQuantity.toFixed(6))
      : Number((params.notionalUsd / fillPrice).toFixed(6))
  let filledQty = quantity
  let finalNotionalUsd = Number((quantity * fillPrice).toFixed(2))
  if (params.exactQuantity === undefined) {
    finalNotionalUsd = Number(params.notionalUsd.toFixed(2))
  }
  let fee: number | undefined
  let feeAsset: string | undefined
  let finalStatus: ExchangeOrderStatus = 'FILLED'
  let executionNote = 'Paper order filled at live market price'
  let venueOrderId: string | undefined
  let cachedFilters: BinanceSymbolFilters | null = null

  if (venue) {
    const fetchFn = params.fetchImpl ?? globalThis.fetch
    // Fetch Binance symbol filters (`LOT_SIZE`, `PRICE_FILTER`, `NOTIONAL`)
    // Live mainnet fails closed if symbol filters cannot be validated; Testnet enforces when available.
    cachedFilters = await fetchBinanceSymbolFilters(
      venue.baseUrl,
      params.pair,
      fetchFn,
    )
    if (venue.mode === 'binance-live' && !cachedFilters) {
      return recordRejectedOrder(ctx, {
        pair: params.pair,
        side: params.side,
        notionalUsd: finalNotionalUsd,
        price: fillPrice,
        quantity,
        mode,
        source,
        presetId: params.presetId,
        reason: `Rejected: unable to load Binance Live exchangeInfo filters for ${params.pair} (fail-closed).`,
        clientOrderId: params.clientOrderId,
      })
    }

    let quantizedQtyText: string | null = null
    if (cachedFilters) {
      const check = validateAndQuantizeBinanceOrder(cachedFilters, {
        price: fillPrice,
        quantity,
      })
      if (!check.ok) {
        return recordRejectedOrder(ctx, {
          pair: params.pair,
          side: params.side,
          notionalUsd: finalNotionalUsd,
          price: fillPrice,
          quantity,
          mode,
          source,
          presetId: params.presetId,
          reason: check.error,
          clientOrderId: params.clientOrderId,
        })
      }
      quantity = check.quantity
      quantizedQtyText = check.quantityText
      if (params.exactQuantity !== undefined) {
        finalNotionalUsd = check.notionalUsd
      }
    }

    // Cancel any open protective OCO / STOP_LOSS_LIMIT order before closing the position
    if (
      params.side === 'SELL' &&
      source === 'bot-auto' &&
      ctx.botOwnedPosition &&
      ctx.botOwnedPosition.pair === params.pair &&
      ctx.botOwnedPosition.protectionOrderId
    ) {
      await cancelBinanceProtectiveExit(
        venue,
        params.pair,
        ctx.botOwnedPosition.protectionOrderId,
        fetchFn,
      )
      ctx.botOwnedPosition = {
        ...ctx.botOwnedPosition,
        protectionOrderId: null,
      }
    }

    try {
      const symbol = params.pair.replace('/', '')
      const cidParam = params.clientOrderId
        ? `&newClientOrderId=${encodeURIComponent(params.clientOrderId)}`
        : ''
      const qtyParam =
        typeof params.exactQuantity === 'number' &&
        Number.isFinite(params.exactQuantity) &&
        params.exactQuantity > 0
          ? `quantity=${quantizedQtyText ?? Number(params.exactQuantity.toFixed(6))}`
          : venue.mode === 'binance-live' && quantizedQtyText
            ? `quantity=${quantizedQtyText}`
            : `quoteOrderQty=${params.notionalUsd.toFixed(2)}`
      const query = `symbol=${symbol}&side=${params.side}&type=MARKET&${qtyParam}${cidParam}&timestamp=${Date.now()}`
      const signature = signQuery(query, venue.apiSecret)
      const response = await fetchFn(
        `${venue.baseUrl}/api/v3/order?${query}&signature=${signature}`,
        {
          method: 'POST',
          headers: { 'X-MBX-APIKEY': venue.apiKey },
          signal: AbortSignal.timeout(TESTNET_TIMEOUT_MS),
        },
      )
      const payload = (await response.json().catch(() => null)) as {
        orderId?: number | string
        status?: string
        executedQty?: string
        origQty?: string
        cummulativeQuoteQty?: string
        fills?: { commission?: string; commissionAsset?: string }[]
        msg?: string
      } | null

      if (!response.ok || !payload) {
        return recordRejectedOrder(ctx, {
          pair: params.pair,
          side: params.side,
          notionalUsd: finalNotionalUsd,
          price: fillPrice,
          quantity,
          mode,
          source,
          presetId: params.presetId,
          reason: `${venueLabel} HTTP ${response.status}: ${payload?.msg ?? 'Order rejected by venue'}`,
          clientOrderId: params.clientOrderId,
        })
      }

      const venueStatus = normalizeVenueOrderStatus(payload.status)
      if (
        venueStatus !== 'FILLED' &&
        venueStatus !== 'PARTIALLY_FILLED' &&
        venueStatus !== 'NEW'
      ) {
        return recordRejectedOrder(ctx, {
          pair: params.pair,
          side: params.side,
          notionalUsd: finalNotionalUsd,
          price: fillPrice,
          quantity,
          mode,
          source,
          presetId: params.presetId,
          reason: `${venueLabel} returned status: ${payload.status ?? 'UNKNOWN'}`,
          clientOrderId: params.clientOrderId,
        })
      }

      finalStatus = venueStatus
      const execQty = Number(payload.executedQty ?? 0)
      const origQty = Number(payload.origQty ?? 0)
      const execQuote = Number(payload.cummulativeQuoteQty ?? 0)
      if (Number.isFinite(origQty) && origQty > 0) {
        quantity = Number(origQty.toFixed(6))
      }
      if (Number.isFinite(execQty) && execQty > 0) {
        filledQty = Number(execQty.toFixed(6))
        if (origQty <= 0) quantity = filledQty
        if (Number.isFinite(execQuote) && execQuote > 0) {
          fillPrice = execQuote / execQty
          finalNotionalUsd = Number(execQuote.toFixed(2))
        }
      } else {
        filledQty = 0
      }

      const feeSummary = extractBinanceFillsSummary(payload.fills)
      fee = feeSummary.fee
      feeAsset = feeSummary.feeAsset

      if (payload.orderId !== undefined) {
        venueOrderId = String(payload.orderId)
      }
      executionNote = `Reconciled on ${venueLabel} (#${venueOrderId ?? 'ack'})`
    } catch (err) {
      return recordRejectedOrder(ctx, {
        pair: params.pair,
        side: params.side,
        notionalUsd: finalNotionalUsd,
        price: fillPrice,
        quantity,
        mode,
        source,
        presetId: params.presetId,
        reason: `${venueLabel} reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
        clientOrderId: params.clientOrderId,
      })
    }
  } else {
    // Operator-funded Paper mode — never use silently seeded balances
    if (!ctx.paperFunded) {
      return recordRejectedOrder(ctx, {
        pair: params.pair,
        side: params.side,
        notionalUsd: finalNotionalUsd,
        price: fillPrice,
        quantity,
        mode,
        source,
        presetId: params.presetId,
        reason:
          'Paper account is not funded. Fund the paper account or configure BINANCE_TESTNET_KEY / BINANCE_TESTNET_SECRET.',
        clientOrderId: params.clientOrderId,
      })
    }

    const baseAsset = params.pair.split('/')[0] ?? 'BTC'
    if (!ctx.paperBalances.USDT) {
      ctx.paperBalances.USDT = { free: 0, locked: 0 }
    }
    if (!ctx.paperBalances[baseAsset]) {
      ctx.paperBalances[baseAsset] = { free: 0, locked: 0 }
    }

    if (params.side === 'BUY') {
      if (ctx.paperBalances.USDT.free < finalNotionalUsd) {
        return recordRejectedOrder(ctx, {
          pair: params.pair,
          side: params.side,
          notionalUsd: finalNotionalUsd,
          price: fillPrice,
          quantity,
          mode,
          source,
          presetId: params.presetId,
          reason: `Insufficient paper USDT balance ($${ctx.paperBalances.USDT.free.toFixed(2)} < $${finalNotionalUsd.toFixed(2)} USD).`,
          clientOrderId: params.clientOrderId,
        })
      }
      ctx.paperBalances.USDT.free = Number(
        (ctx.paperBalances.USDT.free - finalNotionalUsd).toFixed(2),
      )
      ctx.paperBalances[baseAsset].free = Number(
        (ctx.paperBalances[baseAsset].free + quantity).toFixed(8),
      )
    } else {
      if (
        source === 'manual' &&
        !params.bypassRiskForClose &&
        ctx.paperBalances[baseAsset].free + 1e-8 < quantity
      ) {
        return recordRejectedOrder(ctx, {
          pair: params.pair,
          side: params.side,
          notionalUsd: finalNotionalUsd,
          price: fillPrice,
          quantity,
          mode,
          source,
          presetId: params.presetId,
          reason: `Insufficient paper ${baseAsset} balance (${ctx.paperBalances[baseAsset].free.toFixed(6)} < ${quantity.toFixed(6)} ${baseAsset}).`,
          clientOrderId: params.clientOrderId,
        })
      }
      ctx.paperBalances[baseAsset].free = Math.max(
        0,
        Number((ctx.paperBalances[baseAsset].free - quantity).toFixed(8)),
      )
      ctx.paperBalances.USDT.free = Number(
        (ctx.paperBalances.USDT.free + finalNotionalUsd).toFixed(2),
      )
    }
  }

  if (!params.bypassRiskForClose) {
    ctx.dailyOrderCount += 1
  }
  if (typeof params.realizedPnlUsd === 'number' && params.realizedPnlUsd < 0) {
    ctx.dailyRealizedLossUsd += Math.abs(params.realizedPnlUsd)
  }

  const nextOrdNum = await allocateNextOrderNumber(ctx)
  const nowIso = new Date().toISOString()
  const recordedOrder: ExchangeOrderRecord = {
    id: `ORD-${nextOrdNum}`,
    clientOrderId: params.clientOrderId,
    venueOrderId,
    timestamp: nowIso,
    updatedAt: nowIso,
    pair: params.pair,
    side: params.side,
    notionalUsd: finalNotionalUsd,
    price: Number(fillPrice.toFixed(2)),
    avgPrice: filledQty > 0 ? Number(fillPrice.toFixed(2)) : undefined,
    quantity,
    filledQty,
    fee,
    feeAsset,
    status: finalStatus,
    mode,
    source,
    ...(source === 'bot-auto' && params.presetId
      ? { presetId: params.presetId }
      : {}),
    reason: executionNote,
  }

  // Track bot-owned exchange position, place exchange-native protective exit (OCO/SL),
  // and persist durable `exchange_positions` entry/exit rows for real PnL attribution.
  if (
    venue &&
    source === 'bot-auto' &&
    (finalStatus === 'FILLED' || finalStatus === 'PARTIALLY_FILLED') &&
    filledQty > 0
  ) {
    const fetchFn = params.fetchImpl ?? globalThis.fetch
    const fillFeeUsd = estimateFeeUsd(fee, feeAsset, params.pair, fillPrice)

    if (params.side === 'BUY') {
      const existing =
        ctx.botOwnedPosition && ctx.botOwnedPosition.pair === params.pair
          ? ctx.botOwnedPosition
          : null
      const nextQty = Number(((existing?.quantity ?? 0) + filledQty).toFixed(6))
      const positionId = existing?.positionId ?? `POS-${recordedOrder.id}`

      let protectionOrderId: string | null =
        existing?.protectionOrderId ?? null
      const stopPrice =
        typeof params.stopPrice === 'number' &&
        Number.isFinite(params.stopPrice) &&
        params.stopPrice > 0
          ? params.stopPrice
          : null
      const targetPrice =
        typeof params.targetPrice === 'number' &&
        Number.isFinite(params.targetPrice) &&
        params.targetPrice > 0
          ? params.targetPrice
          : null

      if (stopPrice !== null && getBinanceLiveArmStatus().protectiveExitsEnabled) {
        const protRes = await placeBinanceProtectiveExit(venue, {
          pair: params.pair,
          quantity: filledQty,
          entryPrice: fillPrice,
          stopPrice,
          targetPrice,
          filters: cachedFilters,
          fetchImpl: fetchFn,
        })
        if (protRes.ok && protRes.protectionOrderId) {
          protectionOrderId = protRes.protectionOrderId
        } else if (venue.mode === 'binance-live') {
          void dispatchRuntimeAlert({
            tenantId,
            type: 'ERROR',
            severity: 'error',
            source: 'binance-live',
            correlationId: recordedOrder.id,
            timestamp: nowIso,
            message: `[PROTECTIVE-EXIT-FAILED] ${params.pair} live BUY filled (#${venueOrderId ?? recordedOrder.id}) but protective stop failed: ${protRes.error ?? 'unknown error'}`,
          })
        }
      }

      ctx.botOwnedPosition = {
        pair: params.pair,
        side: 'BUY',
        quantity: nextQty,
        entryPrice: Number(fillPrice.toFixed(4)),
        entryTime: Date.now(),
        orderId: recordedOrder.id,
        venueOrderId,
        positionId,
        presetId: params.presetId ?? null,
        stopPrice,
        targetPrice,
        protectionOrderId,
      }

      const openRecord: ExchangePositionRecord = {
        id: positionId,
        tenantId,
        mode: venue.mode,
        presetId: params.presetId ?? null,
        pair: params.pair,
        side: 'LONG',
        status: 'OPEN',
        entryOrderId: recordedOrder.id,
        entryVenueOrderId: venueOrderId ?? null,
        exitOrderId: null,
        exitVenueOrderId: null,
        entryQty: nextQty,
        exitQty: null,
        entryAvgPrice: Number(fillPrice.toFixed(4)),
        exitAvgPrice: null,
        entryFeeUsd: fillFeeUsd,
        exitFeeUsd: 0,
        stopPrice,
        targetPrice,
        protectionOrderId,
        realizedPnlUsd: null,
        rMultiple: null,
        exitReason: null,
        openedAt: nowIso,
        closedAt: null,
      }
      await getStateStore()
        .upsertExchangePosition(openRecord)
        .catch(() => {})
    } else if (params.side === 'SELL') {
      const openRows = await getStateStore()
        .queryExchangePositions(tenantId, {
          mode: venue.mode,
          pair: params.pair,
          status: 'OPEN',
          limit: 1,
        })
        .catch(() => [])
      const openPos = openRows[0] ?? null

      if (openPos) {
        const { realizedPnlUsd, rMultiple } =
          computeClosedExchangePositionMetrics({
            side: openPos.side,
            entryQty: openPos.entryQty,
            exitQty: filledQty,
            entryAvgPrice: openPos.entryAvgPrice,
            exitAvgPrice: fillPrice,
            entryFeeUsd: openPos.entryFeeUsd,
            exitFeeUsd: fillFeeUsd,
            stopPrice: openPos.stopPrice,
          })
        if (realizedPnlUsd < 0) {
          ctx.dailyRealizedLossUsd += Math.abs(realizedPnlUsd)
        }
        await getStateStore()
          .upsertExchangePosition({
            ...openPos,
            status: 'CLOSED',
            exitOrderId: recordedOrder.id,
            exitVenueOrderId: venueOrderId ?? null,
            exitQty: filledQty,
            exitAvgPrice: Number(fillPrice.toFixed(4)),
            exitFeeUsd: fillFeeUsd,
            realizedPnlUsd,
            rMultiple,
            exitReason: params.exitReason ?? 'bot-exit',
            closedAt: nowIso,
          })
          .catch(() => {})
      }

      if (ctx.botOwnedPosition && ctx.botOwnedPosition.pair === params.pair) {
        const remaining = Number(
          (ctx.botOwnedPosition.quantity - filledQty).toFixed(6),
        )
        ctx.botOwnedPosition =
          remaining > 1e-6
            ? { ...ctx.botOwnedPosition, quantity: remaining }
            : null
      }
    }
  }

  ctx.orderHistory = [recordedOrder, ...ctx.orderHistory].slice(
    0,
    MAX_ORDER_HISTORY,
  )
  ctx.updatedAt = nowIso

  if (filledQty > 0) {
    const ledgerEntry = buildSpotFillEntry({
      tenantId,
      orderId: recordedOrder.id,
      venueOrderId,
      pair: recordedOrder.pair,
      side: recordedOrder.side,
      quantity: filledQty,
      price: recordedOrder.price,
      notionalUsd: recordedOrder.notionalUsd,
      feeUsd: feeAsset === 'USDT' ? fee : 0,
      mode: recordedOrder.mode,
    })
    appendTenantLedgerEntry(tenantId, ledgerEntry)
  }

  await getStateStore()
    .appendOrder(tenantId, recordedOrder)
    .catch(() => {})

  return {
    ok: true,
    order: recordedOrder,
    snapshot: getExchangeStatusSnapshot(tenantId),
  }
}

export async function cancelExchangeOrder(
  orderId: string,
  tenantId = DEFAULT_TENANT_ID,
  options?: { fetchImpl?: typeof fetch },
): Promise<{
  ok: boolean
  statusCode: number
  error?: string
  order?: ExchangeOrderRecord
  snapshot: ExchangeStatusSnapshot
}> {
  const ctx = getTenantCtx(tenantId)
  const existing =
    (await getStateStore().findOrderById(tenantId, orderId)) ??
    ctx.orderHistory.find((o) => o.id === orderId) ??
    null

  if (!existing) {
    return {
      ok: false,
      statusCode: 404,
      error: `Order "${orderId}" not found.`,
      snapshot: getExchangeStatusSnapshot(tenantId),
    }
  }

  if (existing.mode !== 'binance-testnet' && existing.mode !== 'binance-live') {
    return {
      ok: false,
      statusCode: 501,
      error:
        'Venue cancellation is not supported for paper market orders (they fill immediately).',
      order: existing,
      snapshot: getExchangeStatusSnapshot(tenantId),
    }
  }

  if (
    existing.status !== 'NEW' &&
    existing.status !== 'PARTIALLY_FILLED' &&
    existing.status !== 'LIVE'
  ) {
    return {
      ok: false,
      statusCode: 409,
      error: `Order ${existing.id} is already ${existing.status} and cannot be canceled.`,
      order: existing,
      snapshot: getExchangeStatusSnapshot(tenantId),
    }
  }

  const venue = resolveBinanceVenueCredentials()
  if (!venue || venue.mode !== existing.mode) {
    return {
      ok: false,
      statusCode: 503,
      error:
        'Binance venue credentials are not configured for this order mode; cannot cancel venue order.',
      order: existing,
      snapshot: getExchangeStatusSnapshot(tenantId),
    }
  }

  if (!existing.venueOrderId) {
    return {
      ok: false,
      statusCode: 409,
      error: `Order ${existing.id} has no venueOrderId to cancel on ${venue.mode}.`,
      order: existing,
      snapshot: getExchangeStatusSnapshot(tenantId),
    }
  }

  const venueLabel =
    venue.mode === 'binance-live' ? 'Binance Spot Live' : 'Binance Spot Testnet'
  const fetchFn = options?.fetchImpl ?? globalThis.fetch
  try {
    const symbol = existing.pair.replace('/', '')
    const query = `symbol=${symbol}&orderId=${encodeURIComponent(existing.venueOrderId)}&timestamp=${Date.now()}`
    const signature = signQuery(query, venue.apiSecret)
    const response = await fetchFn(
      `${venue.baseUrl}/api/v3/order?${query}&signature=${signature}`,
      {
        method: 'DELETE',
        headers: { 'X-MBX-APIKEY': venue.apiKey },
        signal: AbortSignal.timeout(TESTNET_TIMEOUT_MS),
      },
    )
    const payload = (await response.json().catch(() => null)) as {
      status?: string
      executedQty?: string
      msg?: string
    } | null

    if (!response.ok) {
      return {
        ok: false,
        statusCode: 502,
        error: `${venueLabel} cancel failed (HTTP ${response.status}): ${payload?.msg ?? 'Venue rejected cancel'}`,
        order: existing,
        snapshot: getExchangeStatusSnapshot(tenantId),
      }
    }

    const nowIso = new Date().toISOString()
    const updated: ExchangeOrderRecord = {
      ...existing,
      status: 'CANCELED',
      filledQty:
        payload?.executedQty !== undefined &&
        Number.isFinite(Number(payload.executedQty))
          ? Number(payload.executedQty)
          : existing.filledQty,
      updatedAt: nowIso,
      reason: `Canceled on ${venueLabel} by operator`,
    }
    ctx.orderHistory = ctx.orderHistory.map((o) =>
      o.id === updated.id ? updated : o,
    )
    ctx.updatedAt = nowIso
    await getStateStore()
      .appendOrder(tenantId, updated)
      .catch(() => {})

    return {
      ok: true,
      statusCode: 200,
      order: updated,
      snapshot: getExchangeStatusSnapshot(tenantId),
    }
  } catch (err) {
    return {
      ok: false,
      statusCode: 502,
      error: `${venueLabel} cancel error: ${err instanceof Error ? err.message : String(err)}`,
      order: existing,
      snapshot: getExchangeStatusSnapshot(tenantId),
    }
  }
}

export async function closeBotOwnedTestnetPosition(
  tenantId = DEFAULT_TENANT_ID,
  options?: {
    reason?: string
    referencePrice?: number
    fetchImpl?: typeof fetch
  },
): Promise<{
  attempted: boolean
  closed: boolean
  order?: ExchangeOrderRecord
  error?: string
}> {
  const ctx = getTenantCtx(tenantId)
  const pos = ctx.botOwnedPosition
  const venue = resolveBinanceVenueCredentials()
  if (!pos || !venue || pos.quantity <= 0) {
    return { attempted: false, closed: false }
  }

  const price =
    (await resolveExecutionPrice(pos.pair, options?.referencePrice)) ??
    pos.entryPrice
  const estimatedNotional = Number((pos.quantity * price).toFixed(2))
  const res = await submitExchangeOrder({
    tenantId,
    pair: pos.pair,
    side: 'SELL',
    notionalUsd: estimatedNotional,
    exactQuantity: pos.quantity,
    referencePrice: price,
    source: 'bot-auto',
    presetId: pos.presetId ?? null,
    exitReason: options?.reason ?? 'bot-close',
    bypassRiskForClose: true,
    clientOrderId: `bot-close-pos-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    fetchImpl: options?.fetchImpl,
  })

  if (res.ok) {
    ctx.botOwnedPosition = null
    return { attempted: true, closed: true, order: res.order }
  }
  return {
    attempted: true,
    closed: false,
    order: res.order,
    error: res.error ?? 'Failed to close bot-owned Binance position.',
  }
}

export async function reconcileExchangeVenue(
  tenantId = DEFAULT_TENANT_ID,
  options?: { fetchImpl?: typeof fetch },
): Promise<VenueReconciliationReport | null> {
  const venue = resolveBinanceVenueCredentials()
  if (!venue) return null
  const openPositions = await getStateStore()
    .queryExchangePositions(tenantId, {
      mode: venue.mode,
      status: 'OPEN',
      limit: 100,
    })
    .catch(() => [])
  const report = await reconcileOpenBinancePositions(
    venue,
    openPositions,
    options?.fetchImpl ?? globalThis.fetch,
  )
  const ctx = getTenantCtx(tenantId)
  for (const closedPos of report.reconciledClosedPositions) {
    await getStateStore()
      .upsertExchangePosition(closedPos)
      .catch(() => {})
    if (
      ctx.botOwnedPosition &&
      (ctx.botOwnedPosition.positionId === closedPos.id ||
        ctx.botOwnedPosition.pair === closedPos.pair)
    ) {
      ctx.botOwnedPosition = null
    }
    if (
      typeof closedPos.realizedPnlUsd === 'number' &&
      closedPos.realizedPnlUsd < 0
    ) {
      ctx.dailyRealizedLossUsd += Math.abs(closedPos.realizedPnlUsd)
    }
  }
  return report
}

type KillSwitchVenueHandler = (tenantId: string, reason: string) => Promise<void>
const killSwitchHandlers = new Map<string, KillSwitchVenueHandler>()

export function registerKillSwitchHandler(
  name: string,
  handler: KillSwitchVenueHandler,
): void {
  killSwitchHandlers.set(name, handler)
}

export type KillSwitchResult = {
  snapshot: ExchangeStatusSnapshot
  killOrder: ExchangeOrderRecord
  canceledVenueOrderIds: string[]
  closedTestnetOrder: ExchangeOrderRecord | null
  venueErrors: string[]
}

export async function triggerEmergencyKillSwitch(
  reason = 'Emergency stop triggered by operator',
  onHaltBot?: () => void | Promise<void>,
  tenantId = DEFAULT_TENANT_ID,
  options?: { fetchImpl?: typeof fetch },
): Promise<KillSwitchResult> {
  const ctx = getTenantCtx(tenantId)
  const nowIso = new Date().toISOString()
  ctx.killSwitchActive = true
  ctx.killSwitchActivatedAt = nowIso
  ctx.killSwitchReason = reason
  ctx.updatedAt = nowIso

  if (onHaltBot) {
    await onHaltBot()
  }

  const venueErrors: string[] = []
  for (const [name, handler] of killSwitchHandlers.entries()) {
    try {
      await handler(tenantId, reason)
    } catch (err) {
      venueErrors.push(
        `Venue handler ${name}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const canceledVenueOrderIds: string[] = []
  const venue = resolveBinanceVenueCredentials()
  const fetchFn = options?.fetchImpl ?? globalThis.fetch
  if (venue) {
    for (const pair of ctx.hardLimits.allowedPairs) {
      try {
        const symbol = pair.replace('/', '')
        const query = `symbol=${symbol}&timestamp=${Date.now()}`
        const signature = signQuery(query, venue.apiSecret)
        const resp = await fetchFn(
          `${venue.baseUrl}/api/v3/openOrders?${query}&signature=${signature}`,
          {
            method: 'DELETE',
            headers: { 'X-MBX-APIKEY': venue.apiKey },
            signal: AbortSignal.timeout(TESTNET_TIMEOUT_MS),
          },
        )
        if (resp.ok) {
          const canceled = (await resp.json().catch(() => [])) as {
            orderId?: number | string
          }[]
          if (Array.isArray(canceled)) {
            for (const item of canceled) {
              if (item.orderId !== undefined) {
                canceledVenueOrderIds.push(String(item.orderId))
              }
            }
          }
        }
      } catch (err) {
        venueErrors.push(
          `Cancel open orders ${pair}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // Mark any tracked open Binance orders in SQL as CANCELED_KILLSWITCH
    const sqlOrders = await getStateStore()
      .queryOrders(tenantId, { limit: 100 })
      .catch(() => [])
    for (const ord of sqlOrders) {
      if (
        (ord.mode === 'binance-testnet' || ord.mode === 'binance-live') &&
        (ord.status === 'NEW' ||
          ord.status === 'PARTIALLY_FILLED' ||
          ord.status === 'LIVE')
      ) {
        const canceledOrd: ExchangeOrderRecord = {
          ...ord,
          status: 'CANCELED_KILLSWITCH',
          updatedAt: nowIso,
          reason: `Canceled by Kill-Switch: ${reason}`,
        }
        await getStateStore()
          .appendOrder(tenantId, canceledOrd)
          .catch(() => {})
        ctx.orderHistory = ctx.orderHistory.map((o) =>
          o.id === canceledOrd.id ? canceledOrd : o,
        )
      }
    }
  }

  // Close bot-owned Binance position if one is open
  let closedTestnetOrder: ExchangeOrderRecord | null = null
  if (venue && ctx.botOwnedPosition && ctx.botOwnedPosition.quantity > 0) {
    const closeRes = await closeBotOwnedTestnetPosition(tenantId, {
      reason: `Kill-Switch: ${reason}`,
      fetchImpl: fetchFn,
    })
    if (closeRes.order) {
      closedTestnetOrder = closeRes.order
    }
    if (closeRes.error) {
      venueErrors.push(closeRes.error)
    }
  }

  const nextKillNum = await allocateNextOrderNumber(ctx)
  const killRecord: ExchangeOrderRecord = {
    id: `KILL-${nextKillNum}`,
    timestamp: nowIso,
    updatedAt: nowIso,
    pair: 'ALL/USDT',
    side: 'SELL',
    notionalUsd: 0,
    price: 0,
    quantity: 0,
    filledQty: 0,
    status: 'CANCELED_KILLSWITCH',
    mode: venue ? venue.mode : 'paper',
    source: 'manual',
    reason: `KILL-SWITCH: ${reason}`,
  }
  ctx.orderHistory = [killRecord, ...ctx.orderHistory].slice(0, 60)
  await getStateStore()
    .appendOrder(tenantId, killRecord)
    .catch(() => {})

  void dispatchRuntimeAlert({
    tenantId,
    type: 'RISK',
    severity: 'critical',
    source: venue ? venue.mode : 'paper',
    correlationId: killRecord.id,
    timestamp: nowIso,
    message: `[KILL-SWITCH] ${reason} (canceledVenueOrders=${canceledVenueOrderIds.length}, closedPosition=${closedTestnetOrder ? closedTestnetOrder.id : 'none'})`,
  }).catch(() => {})

  return {
    snapshot: getExchangeStatusSnapshot(tenantId),
    killOrder: killRecord,
    canceledVenueOrderIds,
    closedTestnetOrder,
    venueErrors,
  }
}

export function resetEmergencyKillSwitch(
  tenantId = DEFAULT_TENANT_ID,
): ExchangeStatusSnapshot {
  const ctx = getTenantCtx(tenantId)
  ctx.killSwitchActive = false
  ctx.killSwitchActivatedAt = null
  ctx.killSwitchReason = null
  ctx.updatedAt = new Date().toISOString()
  return getExchangeStatusSnapshot(tenantId)
}

export function updateHardRiskLimits(
  partial: Partial<HardRiskLimits>,
  tenantId = DEFAULT_TENANT_ID,
): ExchangeStatusSnapshot {
  const check = validateHardRiskLimitsUpdate(partial)
  if (!check.ok) {
    throw new Error(check.error)
  }
  const ctx = getTenantCtx(tenantId)
  if (check.sanitized.maxOrderNotionalUsd !== undefined) {
    ctx.hardLimits.maxOrderNotionalUsd = check.sanitized.maxOrderNotionalUsd
  }
  if (check.sanitized.maxDailyLossUsd !== undefined) {
    ctx.hardLimits.maxDailyLossUsd = check.sanitized.maxDailyLossUsd
  }
  if (check.sanitized.maxDailyOrders !== undefined) {
    ctx.hardLimits.maxDailyOrders = check.sanitized.maxDailyOrders
  }
  if (check.sanitized.allowedPairs !== undefined) {
    ctx.hardLimits.allowedPairs = check.sanitized.allowedPairs
  }
  ctx.updatedAt = new Date().toISOString()
  return getExchangeStatusSnapshot(tenantId)
}

export function setExchangeAutoMirror(
  enabled: boolean,
  tenantId = DEFAULT_TENANT_ID,
): ExchangeStatusSnapshot {
  const ctx = getTenantCtx(tenantId)
  ctx.autoMirrorBotOrders = Boolean(enabled)
  ctx.updatedAt = new Date().toISOString()
  return getExchangeStatusSnapshot(tenantId)
}

export function exportExchangeState(
  tenantId = DEFAULT_TENANT_ID,
): PersistedExchangeState {
  const ctx = getTenantCtx(tenantId)
  syncDailyCounters(ctx)
  return {
    schemaVersion: 2,
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
    paperFunded: ctx.paperFunded,
    balances: structuredClone(ctx.paperBalances),
    botOwnedPosition: ctx.botOwnedPosition ? { ...ctx.botOwnedPosition } : null,
    orderHistory: ctx.orderHistory.slice(0, MAX_ORDER_HISTORY),
    orderCounter: ctx.orderCounter,
    updatedAt: ctx.updatedAt,
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
    const check = validateHardRiskLimitsUpdate(persisted.hardLimits)
    if (check.ok) {
      if (check.sanitized.maxOrderNotionalUsd !== undefined) {
        ctx.hardLimits.maxOrderNotionalUsd = check.sanitized.maxOrderNotionalUsd
      }
      if (check.sanitized.maxDailyLossUsd !== undefined) {
        ctx.hardLimits.maxDailyLossUsd = check.sanitized.maxDailyLossUsd
      }
      if (check.sanitized.maxDailyOrders !== undefined) {
        ctx.hardLimits.maxDailyOrders = check.sanitized.maxDailyOrders
      }
      if (check.sanitized.allowedPairs !== undefined) {
        ctx.hardLimits.allowedPairs = check.sanitized.allowedPairs
      }
    }
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

  // Only restore balances when explicitly operator-funded (schema v2 paperFunded === true)
  if (
    persisted.paperFunded === true &&
    persisted.balances &&
    typeof persisted.balances === 'object'
  ) {
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
    ctx.paperFunded = true
    ctx.paperBalances = nextBalances
  } else {
    ctx.paperFunded = false
    ctx.paperBalances = {}
  }

  ctx.botOwnedPosition =
    persisted.botOwnedPosition &&
    typeof persisted.botOwnedPosition === 'object' &&
    typeof persisted.botOwnedPosition.quantity === 'number' &&
    persisted.botOwnedPosition.quantity > 0
      ? { ...persisted.botOwnedPosition }
      : null

  ctx.updatedAt =
    typeof persisted.updatedAt === 'string' ? persisted.updatedAt : null

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

/**
 * Test-only reset helper. Never exposed via any HTTP route or UI button.
 */
export function resetExchangeStateForTests(
  tenantId = DEFAULT_TENANT_ID,
  options?: {
    fundPaperUsd?: number
    seedBalances?: Record<string, { free: number; locked: number }>
  },
): ExchangeStatusSnapshot {
  const fresh = createFreshTenantState(tenantId)
  if (options?.seedBalances) {
    fresh.paperFunded = true
    fresh.paperBalances = structuredClone(options.seedBalances)
    fresh.ledgerEntries = [
      buildInitialFundingEntry(
        tenantId,
        fresh.paperBalances,
        `test-seed-${Date.now()}`,
      ),
    ]
  } else if (
    typeof options?.fundPaperUsd === 'number' &&
    options.fundPaperUsd > 0
  ) {
    fresh.paperFunded = true
    fresh.paperBalances = {
      USDT: { free: options.fundPaperUsd, locked: 0 },
    }
    fresh.ledgerEntries = [
      buildInitialFundingEntry(
        tenantId,
        fresh.paperBalances,
        `test-fund-${Date.now()}`,
      ),
    ]
  }
  tenantContexts.set(tenantId, fresh)
  return getExchangeStatusSnapshot(tenantId)
}

export function clearAllTenantExchangeStates(): void {
  tenantContexts.clear()
}
