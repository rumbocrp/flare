/**
 * Live Polymarket CLOB Execution Connector (`src/server/polymarketExecutor.ts`).
 *
 * Deep module placed behind the `PolymarketClobClientLike` seam:
 * - Production adapter wraps `@polymarket/clob-client` + `viem` (`Chain.POLYGON`, EIP-712 + L2 HMAC).
 * - Dual-key arming: live orders require BOTH valid wallet/API credentials AND
 *   explicit `FLARE_POLYMARKET_LIVE=true`.
 * - Pre-trade guards enforced inside `submitPolymarketOrder`:
 *   1. Tenant kill-switch & `HardRiskLimits` (notional, daily count, daily loss)
 *   2. Idempotent `clientOrderId` deduplication
 *   3. Executable quote freshness, spread, and fee validation (`validateExecutableQuote`)
 *   4. Tick-size price rounding & share sizing
 *   5. Venue acknowledgment verification (`success && orderID`)
 *   6. Balanced double-entry ledger posting (`buildPredictionStakeEntry`) & SQL persistence
 * - Automatically registers a venue kill-switch handler with `exchangeAdapter`
 *   so Emergency Kill-Switch cancels open Polymarket CLOB orders too.
 */
import {
  AssetType,
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureType,
  type ApiKeyCreds,
  type BalanceAllowanceResponse,
  type CreateOrderOptions,
  type OpenOrder,
  type OrderResponse,
  type TickSize,
  type Trade,
  type UserMarketOrder,
  type UserOrder,
} from '@polymarket/clob-client'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon, polygonAmoy } from 'viem/chains'
import {
  validateExecutableQuote,
  type ExecutablePredictionQuote,
} from '../market/quoteService'
import {
  appendTenantLedgerEntry,
  getExchangeStatusSnapshot,
  recordExternalVenueOrderCount,
  registerKillSwitchHandler,
  type ExchangeOrderRecord,
} from './exchangeAdapter'
import { buildPredictionStakeEntry } from './ledger/doubleEntryLedger'
import { getStateStore } from './store'

export type PolymarketOrderType = 'GTC' | 'GTD' | 'FOK' | 'FAK'

export type PolymarketExecutionSide = 'BUY' | 'SELL'

export type PolymarketOrderStatus =
  | 'LIVE'
  | 'MATCHED'
  | 'CANCELED'
  | 'REJECTED'

export type PolymarketOrderRecord = {
  id: string
  clientOrderId: string
  venueOrderId?: string
  timestamp: string
  tenantId: string
  instrumentId: string
  tokenId: string
  outcome: 'YES' | 'NO'
  side: PolymarketExecutionSide
  orderType: PolymarketOrderType
  limitPrice: number
  shares: number
  stakeUsd: number
  feeUsd: number
  status: PolymarketOrderStatus
  transactionHashes?: string[]
  reason?: string
}

export type PolymarketReconciliationSnapshot = {
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

export type PolymarketExecutorStatus = {
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
  recentOrders: PolymarketOrderRecord[]
  lastReconciliation: PolymarketReconciliationSnapshot | null
}

/**
 * Minimal CLOB client seam satisfied by `@polymarket/clob-client`'s `ClobClient`
 * and clean test doubles.
 */
export interface PolymarketClobClientLike {
  createOrDeriveApiKey(nonce?: number): Promise<ApiKeyCreds>
  createAndPostOrder(
    userOrder: UserOrder,
    options?: Partial<CreateOrderOptions>,
    orderType?: OrderType.GTC | OrderType.GTD,
  ): Promise<Partial<OrderResponse>>
  createAndPostMarketOrder(
    userMarketOrder: UserMarketOrder,
    options?: Partial<CreateOrderOptions>,
    orderType?: OrderType.FOK | OrderType.FAK,
  ): Promise<Partial<OrderResponse>>
  cancelOrder(payload: { orderID: string }): Promise<unknown>
  cancelAll(): Promise<unknown>
  getOpenOrders(): Promise<OpenOrder[]>
  getTrades(): Promise<Trade[]>
  getBalanceAllowance(params?: {
    asset_type: AssetType
    token_id?: string
  }): Promise<BalanceAllowanceResponse>
}

export type SubmitPolymarketOrderParams = {
  tenantId?: string
  quote: ExecutablePredictionQuote | null | undefined
  side?: PolymarketExecutionSide
  stakeUsd: number
  orderType?: PolymarketOrderType
  clientOrderId: string
  nowMs?: number
  source?: 'manual' | 'bot-auto'
}

export type SubmitPolymarketOrderResult = {
  ok: boolean
  error?: string
  order: PolymarketOrderRecord
}

const DEFAULT_CLOB_HOST = 'https://clob.polymarket.com'
const DEFAULT_POLYGON_RPC = 'https://polygon-rpc.com'
const DEFAULT_TENANT_ID = 'default'
const USDC_DECIMALS = 1_000_000
const MAX_POLY_ORDER_HISTORY = 100
const VALID_TICK_SIZES: readonly TickSize[] = ['0.1', '0.01', '0.001', '0.0001']

type ParsedPolymarketEnv = {
  host: string
  rpcUrl: string
  chainId: Chain
  privateKey: `0x${string}` | null
  signerAddress: string | null
  funderAddress: string | null
  signatureType: SignatureType
  creds: ApiKeyCreds | null
  liveArmed: boolean
}

type TenantPolymarketState = {
  orders: PolymarketOrderRecord[]
  orderCounter: number
  lastReconciliation: PolymarketReconciliationSnapshot | null
}

const tenantPolyStates = new Map<string, TenantPolymarketState>()
let cachedProdClient: {
  cacheKey: string
  client: PolymarketClobClientLike
} | null = null
let injectedClient: PolymarketClobClientLike | null = null

function getTenantPolyState(
  tenantId = DEFAULT_TENANT_ID,
): TenantPolymarketState {
  let state = tenantPolyStates.get(tenantId)
  if (!state) {
    state = {
      orders: [],
      orderCounter: 1,
      lastReconciliation: null,
    }
    tenantPolyStates.set(tenantId, state)
  }
  return state
}

function normalizePrivateKey(raw?: string): `0x${string}` | null {
  const cleaned = raw?.trim()
  if (!cleaned) return null
  const prefixed = cleaned.startsWith('0x') ? cleaned : `0x${cleaned}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(prefixed)) return null
  return prefixed as `0x${string}`
}

function parseSignatureType(raw?: string): SignatureType {
  const num = Number(raw)
  if (num === SignatureType.POLY_PROXY) return SignatureType.POLY_PROXY
  if (num === SignatureType.POLY_GNOSIS_SAFE) {
    return SignatureType.POLY_GNOSIS_SAFE
  }
  return SignatureType.EOA
}

function readPolymarketEnv(): ParsedPolymarketEnv {
  const host = process.env.POLY_CLOB_HOST?.trim() || DEFAULT_CLOB_HOST
  const rpcUrl = process.env.POLY_POLYGON_RPC?.trim() || DEFAULT_POLYGON_RPC
  const chainId =
    Number(process.env.POLY_CHAIN_ID) === Chain.AMOY
      ? Chain.AMOY
      : Chain.POLYGON
  const privateKey = normalizePrivateKey(process.env.POLY_PRIVATE_KEY)

  let signerAddress: string | null = null
  if (privateKey) {
    try {
      signerAddress = privateKeyToAccount(privateKey).address
    } catch {
      signerAddress = null
    }
  }

  const funderRaw = process.env.POLY_FUNDER_ADDRESS?.trim()
  const funderAddress =
    funderRaw && /^0x[0-9a-fA-F]{40}$/.test(funderRaw)
      ? funderRaw
      : signerAddress

  const key = process.env.POLY_API_KEY?.trim()
  const secret = process.env.POLY_API_SECRET?.trim()
  const passphrase = process.env.POLY_API_PASSPHRASE?.trim()
  const creds: ApiKeyCreds | null =
    key && secret && passphrase ? { key, secret, passphrase } : null

  return {
    host,
    rpcUrl,
    chainId,
    privateKey,
    signerAddress,
    funderAddress,
    signatureType: parseSignatureType(process.env.POLY_SIGNATURE_TYPE),
    creds,
    liveArmed: process.env.FLARE_POLYMARKET_LIVE === 'true',
  }
}

export function isPolymarketConfigured(): boolean {
  if (injectedClient) return true
  const env = readPolymarketEnv()
  return Boolean(env.privateKey && env.signerAddress)
}

export function isPolymarketLiveArmed(): boolean {
  const env = readPolymarketEnv()
  return env.liveArmed && isPolymarketConfigured()
}

export function normalizeTickSize(raw?: number | string | null): TickSize {
  const num = Number(raw)
  if (num >= 0.05) return '0.1'
  if (num >= 0.005 || !Number.isFinite(num) || num <= 0) return '0.01'
  if (num >= 0.0005) return '0.001'
  return '0.0001'
}

export function roundPriceToTick(price: number, tickSize: TickSize): number {
  const tick = Number(tickSize)
  const decimals = tickSize.includes('.') ? tickSize.split('.')[1].length : 2
  const rounded = Math.round(price / tick) * tick
  const clamped = Math.min(1 - tick, Math.max(tick, rounded))
  return Number(clamped.toFixed(decimals))
}

function parseUsdcUnits(raw: string | undefined): number {
  const n = Number(raw ?? 0)
  if (!Number.isFinite(n) || n < 0) return 0
  // Polymarket CLOB returns collateral in base 6-decimal USDC units (e.g., "100000000" = $100)
  return Math.round((n / USDC_DECIMALS) * 100) / 100
}

/**
 * Sets a custom CLOB client implementation (used in tests or alternative signers).
 */
export function setPolymarketClobClient(
  client: PolymarketClobClientLike | null,
): void {
  injectedClient = client
  cachedProdClient = null
}

async function resolveClobClient(): Promise<PolymarketClobClientLike> {
  if (injectedClient) return injectedClient

  const env = readPolymarketEnv()
  if (!env.privateKey || !env.signerAddress) {
    throw new Error(
      'Polymarket CLOB signer not configured (set POLY_PRIVATE_KEY).',
    )
  }

  const cacheKey = `${env.host}|${env.chainId}|${env.signerAddress}|${env.funderAddress ?? ''}|${env.signatureType}|${env.creds?.key ?? 'derive'}`
  if (cachedProdClient && cachedProdClient.cacheKey === cacheKey) {
    return cachedProdClient.client
  }

  const account = privateKeyToAccount(env.privateKey)
  const walletClient = createWalletClient({
    account,
    chain: env.chainId === Chain.AMOY ? polygonAmoy : polygon,
    transport: http(env.rpcUrl),
  })

  let creds = env.creds
  if (!creds) {
    const l1Client = new ClobClient(
      env.host,
      env.chainId,
      walletClient,
      undefined,
      env.signatureType,
      env.funderAddress ?? undefined,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    )
    creds = await l1Client.createOrDeriveApiKey()
  }

  const client = new ClobClient(
    env.host,
    env.chainId,
    walletClient,
    creds,
    env.signatureType,
    env.funderAddress ?? undefined,
    undefined,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  )

  cachedProdClient = { cacheKey, client }
  return client
}

/**
 * One-time helper to derive L2 Polymarket API credentials (`key`, `secret`,
 * `passphrase`) from `POLY_PRIVATE_KEY`.
 */
export async function derivePolymarketApiCredentials(): Promise<ApiKeyCreds> {
  const client = await resolveClobClient()
  return client.createOrDeriveApiKey()
}

export function getPolymarketExecutorStatus(
  tenantId = DEFAULT_TENANT_ID,
): PolymarketExecutorStatus {
  const env = readPolymarketEnv()
  const state = getTenantPolyState(tenantId)
  const configured = isPolymarketConfigured()
  const liveArmed = env.liveArmed && configured
  return {
    configured,
    liveArmed,
    mode: liveArmed ? 'live-clob' : 'read-only',
    host: env.host,
    chainId: env.chainId,
    signerAddress: env.signerAddress,
    funderAddress: env.funderAddress,
    signatureType: env.signatureType,
    hasL2Creds: Boolean(env.creds),
    orderCount: state.orders.length,
    recentOrders: state.orders.slice(0, 40),
    lastReconciliation: state.lastReconciliation,
  }
}

function recordPolymarketOrder(
  state: TenantPolymarketState,
  order: PolymarketOrderRecord,
  source: 'manual' | 'bot-auto' = 'bot-auto',
): void {
  state.orders = [order, ...state.orders].slice(0, MAX_POLY_ORDER_HISTORY)
  const storeOrder: ExchangeOrderRecord = {
    id: order.id,
    clientOrderId: order.clientOrderId,
    venueOrderId: order.venueOrderId,
    timestamp: order.timestamp,
    pair: `${order.instrumentId}/${order.outcome}`,
    side: order.side,
    notionalUsd: order.stakeUsd,
    price: order.limitPrice,
    quantity: order.shares,
    status:
      order.status === 'REJECTED'
        ? 'REJECTED_RISK'
        : order.status === 'CANCELED'
          ? 'CANCELED_KILLSWITCH'
          : order.status === 'LIVE'
            ? 'LIVE'
            : 'FILLED',
    mode: 'polymarket-clob',
    source,
    reason: order.reason,
  }
  void getStateStore()
    .appendOrder(order.tenantId, storeOrder)
    .catch(() => {})
}

/**
 * Submits a live binary prediction order to Polymarket CLOB after enforcing
 * dual-key arming, kill-switch, HardRiskLimits, idempotency, executable quote
 * validation, tick-size alignment, venue acknowledgment, and double-entry ledger.
 */
export async function submitPolymarketOrder(
  params: SubmitPolymarketOrderParams,
): Promise<SubmitPolymarketOrderResult> {
  const tenantId = params.tenantId ?? DEFAULT_TENANT_ID
  const state = getTenantPolyState(tenantId)
  const nowMs = params.nowMs ?? Date.now()
  const side: PolymarketExecutionSide = params.side ?? 'BUY'
  const orderType: PolymarketOrderType = params.orderType ?? 'FOK'

  // 1. Idempotency check
  const existing = state.orders.find(
    (o) => o.clientOrderId === params.clientOrderId,
  )
  if (existing) {
    const ok = existing.status === 'LIVE' || existing.status === 'MATCHED'
    return {
      ok,
      error: ok ? undefined : existing.reason,
      order: existing,
    }
  }

  const nextId = () => {
    const id = `POLY-${state.orderCounter}`
    state.orderCounter += 1
    return id
  }

  const makeRejected = (reason: string): SubmitPolymarketOrderResult => {
    const order: PolymarketOrderRecord = {
      id: nextId(),
      clientOrderId: params.clientOrderId,
      timestamp: new Date(nowMs).toISOString(),
      tenantId,
      instrumentId: params.quote?.instrumentId ?? 'unknown',
      tokenId: params.quote?.tokenId ?? '',
      outcome: params.quote?.outcome ?? 'YES',
      side,
      orderType,
      limitPrice: params.quote?.ask ?? 0,
      shares: 0,
      stakeUsd: Number(Math.max(0, params.stakeUsd).toFixed(2)),
      feeUsd: 0,
      status: 'REJECTED',
      reason,
    }
    recordPolymarketOrder(state, order, params.source ?? 'bot-auto')
    return { ok: false, error: reason, order }
  }

  // 2. Dual-key live arming check
  const env = readPolymarketEnv()
  if (!env.liveArmed) {
    return makeRejected(
      'Polymarket live execution is disarmed (set FLARE_POLYMARKET_LIVE=true to arm).',
    )
  }
  if (!isPolymarketConfigured()) {
    return makeRejected(
      'Polymarket CLOB signer not configured (set POLY_PRIVATE_KEY).',
    )
  }

  // 3. Tenant Kill-Switch & Hard Risk Limits check
  const risk = getExchangeStatusSnapshot(tenantId)
  if (risk.killSwitchActive) {
    return makeRejected(
      `Emergency Kill-Switch ACTIVE (${risk.killSwitchReason ?? 'Manual lock'}).`,
    )
  }
  if (!Number.isFinite(params.stakeUsd) || params.stakeUsd <= 0) {
    return makeRejected('Order stakeUsd must be greater than $0 USD.')
  }
  if (params.stakeUsd > risk.hardLimits.maxOrderNotionalUsd) {
    return makeRejected(
      `Stake $${params.stakeUsd.toFixed(2)} exceeds HardRiskLimits maxOrderNotionalUsd ($${risk.hardLimits.maxOrderNotionalUsd.toFixed(2)}).`,
    )
  }
  if (risk.dailyOrderCount >= risk.hardLimits.maxDailyOrders) {
    return makeRejected(
      `Daily hard order count reached (${risk.dailyOrderCount}/${risk.hardLimits.maxDailyOrders}).`,
    )
  }
  if (risk.dailyRealizedLossUsd >= risk.hardLimits.maxDailyLossUsd) {
    return makeRejected(
      `Daily hard loss limit reached (-$${risk.dailyRealizedLossUsd.toFixed(2)} >= -$${risk.hardLimits.maxDailyLossUsd.toFixed(2)}).`,
    )
  }

  // 4. Executable quote & tokenId validation (`P0-1`)
  const quoteCheck = validateExecutableQuote(params.quote, nowMs)
  if (!quoteCheck.ok) {
    return makeRejected(`[QUOTE GUARD] ${quoteCheck.reason}`)
  }
  const tokenId = quoteCheck.quote.tokenId?.trim()
  if (!tokenId) {
    return makeRejected(
      `Missing Polymarket CLOB tokenId for ${quoteCheck.quote.instrumentId} (${quoteCheck.quote.outcome}).`,
    )
  }

  const tickSize = normalizeTickSize(quoteCheck.quote.tickSize)
  if (!VALID_TICK_SIZES.includes(tickSize)) {
    return makeRejected(`Unsupported Polymarket tickSize: ${tickSize}`)
  }
  const rawTargetPrice =
    side === 'BUY' ? quoteCheck.quote.ask : quoteCheck.quote.bid
  const limitPrice = roundPriceToTick(rawTargetPrice, tickSize)
  const shares =
    limitPrice > 0
      ? Number((params.stakeUsd / limitPrice).toFixed(4))
      : 0
  if (shares <= 0) {
    return makeRejected('Computed share size must be greater than 0.')
  }

  const feeUsd = Number(
    (params.stakeUsd * (quoteCheck.feePctOfStake / 100)).toFixed(4),
  )
  const sdkSide = side === 'SELL' ? Side.SELL : Side.BUY
  const options: Partial<CreateOrderOptions> = {
    tickSize,
    negRisk: Boolean(quoteCheck.quote.negRisk),
  }

  // 5. Sign & submit via Polymarket CLOB client
  try {
    const client = await resolveClobClient()
    let resp: Partial<OrderResponse>

    if (orderType === 'FOK' || orderType === 'FAK') {
      const marketOrder: UserMarketOrder = {
        tokenID: tokenId,
        price: limitPrice,
        amount:
          side === 'BUY'
            ? Number(params.stakeUsd.toFixed(2))
            : shares,
        side: sdkSide,
        orderType: orderType === 'FAK' ? OrderType.FAK : OrderType.FOK,
      }
      resp = await client.createAndPostMarketOrder(
        marketOrder,
        options,
        orderType === 'FAK' ? OrderType.FAK : OrderType.FOK,
      )
    } else {
      const limitOrder: UserOrder = {
        tokenID: tokenId,
        price: limitPrice,
        size: shares,
        side: sdkSide,
      }
      resp = await client.createAndPostOrder(
        limitOrder,
        options,
        orderType === 'GTD' ? OrderType.GTD : OrderType.GTC,
      )
    }

    if (!resp || resp.success === false || !resp.orderID) {
      return makeRejected(
        `Polymarket CLOB rejected order: ${resp?.errorMsg || 'Missing order acknowledgment'}`,
      )
    }

    const rawStatus = String(resp.status ?? '').toUpperCase()
    const status: PolymarketOrderStatus =
      rawStatus === 'MATCHED' || rawStatus === 'FILLED' ? 'MATCHED' : 'LIVE'

    const acceptedOrder: PolymarketOrderRecord = {
      id: nextId(),
      clientOrderId: params.clientOrderId,
      venueOrderId: String(resp.orderID),
      timestamp: new Date(nowMs).toISOString(),
      tenantId,
      instrumentId: quoteCheck.quote.instrumentId,
      tokenId,
      outcome: quoteCheck.quote.outcome,
      side,
      orderType,
      limitPrice,
      shares,
      stakeUsd: Number(params.stakeUsd.toFixed(2)),
      feeUsd,
      status,
      transactionHashes: Array.isArray(resp.transactionsHashes)
        ? resp.transactionsHashes
        : undefined,
      reason: `Polymarket CLOB ${status} (#${resp.orderID})`,
    }
    recordPolymarketOrder(state, acceptedOrder, params.source ?? 'bot-auto')
    recordExternalVenueOrderCount(tenantId)

    // 6. Post balanced double-entry accounting entry on BUY stake
    if (side === 'BUY') {
      appendTenantLedgerEntry(
        tenantId,
        buildPredictionStakeEntry({
          tenantId,
          ticketId: acceptedOrder.id,
          stakeUsd: acceptedOrder.stakeUsd,
          feeUsd: acceptedOrder.feeUsd,
          instrumentId: acceptedOrder.instrumentId,
        }),
      )
    }

    return { ok: true, order: acceptedOrder }
  } catch (err) {
    return makeRejected(
      `Polymarket CLOB submission failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export async function cancelPolymarketOrder(
  orderId: string,
  tenantId = DEFAULT_TENANT_ID,
): Promise<{ ok: boolean; error?: string }> {
  if (!isPolymarketConfigured()) {
    return { ok: false, error: 'Polymarket CLOB signer not configured.' }
  }
  try {
    const client = await resolveClobClient()
    await client.cancelOrder({ orderID: orderId })
    const state = getTenantPolyState(tenantId)
    state.orders = state.orders.map((o) =>
      o.venueOrderId === orderId || o.id === orderId
        ? { ...o, status: 'CANCELED', reason: 'Canceled by operator' }
        : o,
    )
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function cancelAllPolymarketOrders(
  tenantId = DEFAULT_TENANT_ID,
  reason = 'Emergency kill-switch',
): Promise<{ ok: boolean; canceled: boolean; error?: string }> {
  if (!isPolymarketConfigured()) {
    return { ok: true, canceled: false }
  }
  try {
    const client = await resolveClobClient()
    await client.cancelAll()
    const state = getTenantPolyState(tenantId)
    state.orders = state.orders.map((o) =>
      o.status === 'LIVE'
        ? { ...o, status: 'CANCELED', reason: `CANCELED: ${reason}` }
        : o,
    )
    return { ok: true, canceled: true }
  } catch (err) {
    return {
      ok: false,
      canceled: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Queries live collateral balance/allowance, open orders, and recent fills
 * directly from Polymarket CLOB for startup/periodic reconciliation.
 */
export async function reconcilePolymarketAccount(
  tenantId = DEFAULT_TENANT_ID,
): Promise<PolymarketReconciliationSnapshot> {
  const client = await resolveClobClient()
  const [balRes, openOrders, trades] = await Promise.all([
    client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
    client.getOpenOrders(),
    client.getTrades(),
  ])

  const snapshot: PolymarketReconciliationSnapshot = {
    syncedAt: new Date().toISOString(),
    collateralUsd: parseUsdcUnits(balRes?.balance),
    allowanceUsd: parseUsdcUnits(balRes?.allowance),
    openOrdersCount: Array.isArray(openOrders) ? openOrders.length : 0,
    recentTradesCount: Array.isArray(trades) ? trades.length : 0,
    openOrders: (openOrders ?? []).slice(0, 50).map((o) => ({
      id: o.id,
      market: o.market,
      assetId: o.asset_id,
      side: o.side,
      price: Number(o.price),
      originalSize: Number(o.original_size),
      sizeMatched: Number(o.size_matched),
      status: o.status,
    })),
    recentTrades: (trades ?? []).slice(0, 50).map((t) => ({
      id: t.id,
      market: t.market,
      assetId: t.asset_id,
      side: t.side,
      price: Number(t.price),
      size: Number(t.size),
      status: t.status,
      matchTime: t.match_time,
      txHash: t.transaction_hash,
    })),
  }

  const state = getTenantPolyState(tenantId)
  state.lastReconciliation = snapshot
  return snapshot
}

export function resetPolymarketExecutorState(): void {
  tenantPolyStates.clear()
  cachedProdClient = null
}

// Automatically wire Emergency Kill-Switch cancellation across all tenants
registerKillSwitchHandler('polymarket-clob', async (tenantId, reason) => {
  await cancelAllPolymarketOrders(tenantId, reason)
})
