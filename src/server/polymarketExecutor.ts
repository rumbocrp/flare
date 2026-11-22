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
import crypto from 'node:crypto'
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
import {
  buildPredictionStakeEntry,
  createBalancedLedgerEntry,
} from './ledger/doubleEntryLedger'
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
  source?: 'manual' | 'bot-auto'
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
    deferExec?: boolean,
    postOnly?: boolean,
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
  /** Optional fixed-dollar canary override (enforced against HardRiskLimits.maxOrderNotionalUsd). */
  stakeUsdOverride?: number
  orderType?: PolymarketOrderType
  clientOrderId: string
  nowMs?: number
  source?: 'manual' | 'bot-auto'
}

export type SubmitPolymarketMakerQuoteParams = {
  tenantId?: string
  quote: ExecutablePredictionQuote | null | undefined
  side?: PolymarketExecutionSide
  limitPrice: number
  /** Optional fixed-dollar stake override; defaults to $5.00 canary stake when omitted. */
  stakeUsd?: number
  postOnly?: boolean
  clientOrderId: string
  nowMs?: number
  source?: 'manual' | 'bot-auto'
}

export type SubmitPolymarketOrderResult = {
  ok: boolean
  error?: string
  order: PolymarketOrderRecord
}

export type CancelOrdersForWindowResult = {
  ok: boolean
  canceledCount: number
  canceledOrderIds: string[]
  failedOrderIds: string[]
  error?: string
}

export const DEFAULT_CANARY_STAKE_USD = 5

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
  lastReconciliation: PolymarketReconciliationSnapshot | null
  releasedCanceledEscrowOrderIds: Set<string>
  sqlCancelMutex: Promise<void>
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
      lastReconciliation: null,
      releasedCanceledEscrowOrderIds: new Set<string>(),
      sqlCancelMutex: Promise.resolve(),
    }
    tenantPolyStates.set(tenantId, state)
  }
  return state
}

async function withTenantSqlCancelLock<T>(
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const state = getTenantPolyState(tenantId)
  const prev = state.sqlCancelMutex
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  state.sqlCancelMutex = current
  await prev
  try {
    return await fn()
  } finally {
    release()
  }
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

function toExchangeOrderRecord(
  order: PolymarketOrderRecord,
  source: 'manual' | 'bot-auto' = order.source ?? 'bot-auto',
): ExchangeOrderRecord {
  return {
    id: order.id,
    clientOrderId:
      order.status === 'REJECTED' ? undefined : order.clientOrderId,
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
}

async function persistOrderToStore(
  order: PolymarketOrderRecord,
  source: 'manual' | 'bot-auto' = order.source ?? 'bot-auto',
): Promise<void> {
  try {
    await getStateStore().appendOrder(
      order.tenantId,
      toExchangeOrderRecord(order, source),
    )
  } catch {
    // Store persistence errors must not mask venue execution state
  }
}

function recordPolymarketOrder(
  state: TenantPolymarketState,
  order: PolymarketOrderRecord,
  source: 'manual' | 'bot-auto' = 'bot-auto',
): void {
  const storedOrder: PolymarketOrderRecord = { ...order, source }
  const deduped = state.orders.filter(
    (o) =>
      o.id !== storedOrder.id &&
      !(
        o.clientOrderId === storedOrder.clientOrderId &&
        o.status === 'REJECTED'
      ),
  )
  state.orders = [storedOrder, ...deduped].slice(0, MAX_POLY_ORDER_HISTORY)
  void persistOrderToStore(storedOrder, source)
}

function releaseCanceledBuyEscrow(params: {
  tenantId: string
  orderId: string
  instrumentId: string
  stakeUsd: number
  reason: string
}): void {
  const stake = Number(params.stakeUsd.toFixed(2))
  if (!Number.isFinite(stake) || stake <= 0) return
  const cleanTenant = params.tenantId.trim() || DEFAULT_TENANT_ID
  const state = getTenantPolyState(cleanTenant)
  if (state.releasedCanceledEscrowOrderIds.has(params.orderId)) return
  state.releasedCanceledEscrowOrderIds.add(params.orderId)
  appendTenantLedgerEntry(
    cleanTenant,
    createBalancedLedgerEntry({
      tenantId: cleanTenant,
      kind: 'PREDICTION_SETTLEMENT',
      referenceId: params.orderId,
      description: `Canceled BUY order escrow release $${stake.toFixed(2)} (${params.instrumentId}): ${params.reason}`,
      postings: [
        {
          account: 'wallet:USDT',
          asset: 'USDT',
          direction: 'DEBIT',
          amount: stake,
        },
        {
          account: 'escrow:prediction:USDT',
          asset: 'USDT',
          direction: 'CREDIT',
          amount: stake,
        },
      ],
      metadata: {
        instrumentId: params.instrumentId,
        canceled: true,
      },
    }),
  )
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
  const source: 'manual' | 'bot-auto' = params.source ?? 'bot-auto'
  const effectiveStakeUsd =
    params.stakeUsdOverride !== undefined
      ? params.stakeUsdOverride
      : params.stakeUsd

  // 1. Idempotency check
  const existing = state.orders.find(
    (o) => o.clientOrderId === params.clientOrderId,
  )
  if (existing && existing.status !== 'REJECTED') {
    const ok = existing.status === 'LIVE' || existing.status === 'MATCHED'
    return {
      ok,
      error: ok ? undefined : existing.reason,
      order: existing,
    }
  }

  const nextId = () => `POLY-${crypto.randomUUID()}`

  const makeRejected = (reason: string): SubmitPolymarketOrderResult => {
    const safeStake = Number.isFinite(effectiveStakeUsd)
      ? Number(Math.max(0, effectiveStakeUsd).toFixed(2))
      : 0
    const order: PolymarketOrderRecord = {
      id: existing?.status === 'REJECTED' ? existing.id : nextId(),
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
      stakeUsd: safeStake,
      feeUsd: 0,
      status: 'REJECTED',
      source,
      reason,
    }
    recordPolymarketOrder(state, order, source)
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
  if (!Number.isFinite(effectiveStakeUsd) || effectiveStakeUsd <= 0) {
    return makeRejected('Order stakeUsd must be greater than $0 USD.')
  }
  if (Number(effectiveStakeUsd.toFixed(2)) < 0.01) {
    return makeRejected('Order stakeUsd must be at least $0.01 USD.')
  }
  if (effectiveStakeUsd > risk.hardLimits.maxOrderNotionalUsd) {
    return makeRejected(
      `Stake $${effectiveStakeUsd.toFixed(2)} exceeds HardRiskLimits maxOrderNotionalUsd ($${risk.hardLimits.maxOrderNotionalUsd.toFixed(2)}).`,
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
      ? Number((effectiveStakeUsd / limitPrice).toFixed(4))
      : 0
  if (shares <= 0) {
    return makeRejected('Computed share size must be greater than 0.')
  }

  const feeUsd = Number(
    (effectiveStakeUsd * (quoteCheck.feePctOfStake / 100)).toFixed(4),
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
            ? Number(effectiveStakeUsd.toFixed(2))
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
      stakeUsd: Number(effectiveStakeUsd.toFixed(2)),
      feeUsd,
      status,
      source,
      transactionHashes: Array.isArray(resp.transactionsHashes)
        ? resp.transactionsHashes
        : undefined,
      reason: `Polymarket CLOB ${status} (#${resp.orderID})`,
    }
    recordPolymarketOrder(state, acceptedOrder, source)
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

/**
 * Submits a resting GTC post-only maker limit quote on Polymarket CLOB at an
 * explicit `limitPrice` rounded to `tickSize` with `$0` upfront maker fee.
 */
export async function submitPolymarketMakerQuote(
  params: SubmitPolymarketMakerQuoteParams,
): Promise<SubmitPolymarketOrderResult> {
  const tenantId = params.tenantId ?? DEFAULT_TENANT_ID
  const state = getTenantPolyState(tenantId)
  const nowMs = params.nowMs ?? Date.now()
  const side: PolymarketExecutionSide = params.side ?? 'BUY'
  const postOnly = params.postOnly ?? true
  const source: 'manual' | 'bot-auto' = params.source ?? 'bot-auto'
  const effectiveStakeUsd =
    params.stakeUsd !== undefined ? params.stakeUsd : DEFAULT_CANARY_STAKE_USD

  // 1. Idempotency check
  const existing = state.orders.find(
    (o) => o.clientOrderId === params.clientOrderId,
  )
  if (existing && existing.status !== 'REJECTED') {
    const ok = existing.status === 'LIVE' || existing.status === 'MATCHED'
    return {
      ok,
      error: ok ? undefined : existing.reason,
      order: existing,
    }
  }

  const nextId = () => `POLY-${crypto.randomUUID()}`

  const makeRejected = (reason: string): SubmitPolymarketOrderResult => {
    const safeStake = Number.isFinite(effectiveStakeUsd)
      ? Number(Math.max(0, effectiveStakeUsd).toFixed(2))
      : 0
    const safePrice = Number.isFinite(params.limitPrice) ? params.limitPrice : 0
    const order: PolymarketOrderRecord = {
      id: existing?.status === 'REJECTED' ? existing.id : nextId(),
      clientOrderId: params.clientOrderId,
      timestamp: new Date(nowMs).toISOString(),
      tenantId,
      instrumentId: params.quote?.instrumentId ?? 'unknown',
      tokenId: params.quote?.tokenId ?? '',
      outcome: params.quote?.outcome ?? 'YES',
      side,
      orderType: 'GTC',
      limitPrice: safePrice,
      shares: 0,
      stakeUsd: safeStake,
      feeUsd: 0,
      status: 'REJECTED',
      source,
      reason,
    }
    recordPolymarketOrder(state, order, source)
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
  if (!Number.isFinite(effectiveStakeUsd) || effectiveStakeUsd <= 0) {
    return makeRejected('Order stakeUsd must be greater than $0 USD.')
  }
  if (Number(effectiveStakeUsd.toFixed(2)) < 0.01) {
    return makeRejected('Order stakeUsd must be at least $0.01 USD.')
  }
  if (effectiveStakeUsd > risk.hardLimits.maxOrderNotionalUsd) {
    return makeRejected(
      `Stake $${effectiveStakeUsd.toFixed(2)} exceeds HardRiskLimits maxOrderNotionalUsd ($${risk.hardLimits.maxOrderNotionalUsd.toFixed(2)}).`,
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

  // 4. Limit price & executable quote validation
  if (
    !Number.isFinite(params.limitPrice) ||
    params.limitPrice <= 0 ||
    params.limitPrice >= 1
  ) {
    return makeRejected(
      `Maker limitPrice (${String(params.limitPrice)}) must be strictly inside (0, 1).`,
    )
  }

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
  const tick = Number(tickSize)
  let limitPrice = roundPriceToTick(params.limitPrice, tickSize)

  if (postOnly) {
    if (side === 'BUY') {
      if (params.limitPrice >= quoteCheck.quote.ask) {
        return makeRejected(
          `Post-only BUY limitPrice ${params.limitPrice.toFixed(4)} crosses or meets ask ${quoteCheck.quote.ask.toFixed(4)}.`,
        )
      }
      if (limitPrice >= quoteCheck.quote.ask) {
        const steppedDown = roundPriceToTick(
          quoteCheck.quote.ask - tick,
          tickSize,
        )
        if (
          quoteCheck.quote.ask - tick < tick - 1e-12 ||
          steppedDown >= quoteCheck.quote.ask
        ) {
          return makeRejected(
            `Post-only BUY rounded price ${limitPrice.toFixed(4)} cannot sit passively below ask ${quoteCheck.quote.ask.toFixed(4)} at tickSize ${tickSize}.`,
          )
        }
        limitPrice = steppedDown
      }
    } else {
      if (params.limitPrice <= quoteCheck.quote.bid) {
        return makeRejected(
          `Post-only SELL limitPrice ${params.limitPrice.toFixed(4)} crosses or meets bid ${quoteCheck.quote.bid.toFixed(4)}.`,
        )
      }
      if (limitPrice <= quoteCheck.quote.bid) {
        const steppedUp = roundPriceToTick(
          quoteCheck.quote.bid + tick,
          tickSize,
        )
        if (
          quoteCheck.quote.bid + tick > 1 - tick + 1e-12 ||
          steppedUp <= quoteCheck.quote.bid
        ) {
          return makeRejected(
            `Post-only SELL rounded price ${limitPrice.toFixed(4)} cannot sit passively above bid ${quoteCheck.quote.bid.toFixed(4)} at tickSize ${tickSize}.`,
          )
        }
        limitPrice = steppedUp
      }
    }
  }

  const shares =
    limitPrice > 0
      ? Number((effectiveStakeUsd / limitPrice).toFixed(4))
      : 0
  if (shares <= 0) {
    return makeRejected('Computed share size must be greater than 0.')
  }

  // Makers pay $0 upfront fee (doubleEntryLedger forbids negative postings)
  const feeUsd = 0
  const sdkSide = side === 'SELL' ? Side.SELL : Side.BUY
  const options: Partial<CreateOrderOptions> = {
    tickSize,
    negRisk: Boolean(quoteCheck.quote.negRisk),
  }

  // 5. Sign & submit GTC postOnly order via Polymarket CLOB client
  try {
    const client = await resolveClobClient()
    const limitOrder: UserOrder = {
      tokenID: tokenId,
      price: limitPrice,
      size: shares,
      side: sdkSide,
    }
    const resp = await client.createAndPostOrder(
      limitOrder,
      options,
      OrderType.GTC,
      false,
      postOnly,
    )

    if (!resp || resp.success === false || !resp.orderID) {
      return makeRejected(
        `Polymarket CLOB rejected maker order: ${resp?.errorMsg || 'Missing order acknowledgment'}`,
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
      orderType: 'GTC',
      limitPrice,
      shares,
      stakeUsd: Number(effectiveStakeUsd.toFixed(2)),
      feeUsd,
      status,
      source,
      transactionHashes: Array.isArray(resp.transactionsHashes)
        ? resp.transactionsHashes
        : undefined,
      reason: `Polymarket CLOB maker ${status} (#${resp.orderID})`,
    }
    recordPolymarketOrder(state, acceptedOrder, source)
    recordExternalVenueOrderCount(tenantId)

    // 6. Post balanced double-entry accounting entry on BUY stake
    if (side === 'BUY') {
      appendTenantLedgerEntry(
        tenantId,
        buildPredictionStakeEntry({
          tenantId,
          ticketId: acceptedOrder.id,
          stakeUsd: acceptedOrder.stakeUsd,
          feeUsd: 0,
          instrumentId: acceptedOrder.instrumentId,
        }),
      )
    }

    return { ok: true, order: acceptedOrder }
  } catch (err) {
    return makeRejected(
      `Polymarket CLOB maker submission failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export type SyncPolymarketOrderStatusesResult = {
  syncedCount: number
  matchedOrderIds: string[]
}

function extractMatchedVenueOrderIds(
  openOrders: readonly OpenOrder[],
  trades: readonly Trade[],
): {
  matchedIds: Set<string>
  txHashesByOrderId: Map<string, string[]>
} {
  const matchedIds = new Set<string>()
  const txHashesByOrderId = new Map<string, string[]>()

  const addTxHash = (orderId: string, txHash: string | undefined) => {
    if (!txHash) return
    const existing = txHashesByOrderId.get(orderId) ?? []
    if (!existing.includes(txHash)) {
      existing.push(txHash)
      txHashesByOrderId.set(orderId, existing)
    }
  }

  for (const trade of trades) {
    const statusUpper = String(trade.status ?? '').toUpperCase()
    if (statusUpper === 'FAILED' || statusUpper === 'CANCELED') {
      continue
    }
    const txHash =
      typeof trade.transaction_hash === 'string' && trade.transaction_hash
        ? trade.transaction_hash
        : undefined

    if (typeof trade.taker_order_id === 'string' && trade.taker_order_id) {
      matchedIds.add(trade.taker_order_id)
      addTxHash(trade.taker_order_id, txHash)
    }
    if (Array.isArray(trade.maker_orders)) {
      for (const mo of trade.maker_orders) {
        const raw = mo as unknown as Record<string, unknown>
        const makerOrderId =
          (typeof raw.order_id === 'string' && raw.order_id) ||
          (typeof raw.orderID === 'string' && raw.orderID) ||
          (typeof raw.id === 'string' && raw.id) ||
          ''
        if (makerOrderId) {
          matchedIds.add(makerOrderId)
          addTxHash(makerOrderId, txHash)
        }
      }
    }
  }

  for (const openOrder of openOrders) {
    const statusUpper = String(openOrder.status ?? '').toUpperCase()
    const orig = Number(openOrder.original_size)
    const matched = Number(openOrder.size_matched)
    const fullyFilled =
      Number.isFinite(orig) &&
      orig > 0 &&
      Number.isFinite(matched) &&
      matched >= orig - 1e-9
    if (
      openOrder.id &&
      (statusUpper === 'MATCHED' || statusUpper === 'FILLED' || fullyFilled)
    ) {
      matchedIds.add(openOrder.id)
    }
  }

  return { matchedIds, txHashesByOrderId }
}

async function applyMatchedOrderStatuses(
  tenantId: string,
  openOrders: readonly OpenOrder[],
  trades: readonly Trade[],
): Promise<SyncPolymarketOrderStatusesResult> {
  const cleanTenant = tenantId.trim() || DEFAULT_TENANT_ID
  const { matchedIds, txHashesByOrderId } = extractMatchedVenueOrderIds(
    openOrders,
    trades,
  )
  if (matchedIds.size === 0) {
    return { syncedCount: 0, matchedOrderIds: [] }
  }

  const state = getTenantPolyState(cleanTenant)
  const syncedVenueIds = new Set<string>()
  const matchedOrderIds: string[] = []

  const liveLocalIds = state.orders
    .filter(
      (o) =>
        o.status === 'LIVE' &&
        Boolean(o.venueOrderId) &&
        matchedIds.has(o.venueOrderId!),
    )
    .map((o) => o.id)

  for (const localId of liveLocalIds) {
    const freshIndex = state.orders.findIndex((o) => o.id === localId)
    if (freshIndex < 0) continue
    const current = state.orders[freshIndex]
    if (current.status !== 'LIVE' || !current.venueOrderId) continue
    if (!matchedIds.has(current.venueOrderId)) continue

    const txHashes = txHashesByOrderId.get(current.venueOrderId)
    const updated: PolymarketOrderRecord = {
      ...current,
      status: 'MATCHED',
      transactionHashes:
        txHashes && txHashes.length > 0
          ? Array.from(
              new Set([...(current.transactionHashes ?? []), ...txHashes]),
            )
          : current.transactionHashes,
      reason: `Polymarket CLOB MATCHED (#${current.venueOrderId})`,
    }
    state.orders[freshIndex] = updated
    await persistOrderToStore(updated)
    if (!syncedVenueIds.has(current.venueOrderId)) {
      syncedVenueIds.add(current.venueOrderId)
      matchedOrderIds.push(current.venueOrderId)
    }
  }

  try {
    const sqlOrders = await getStateStore().getOrders(cleanTenant, 1_000)
    for (const sqlOrder of sqlOrders) {
      if (
        sqlOrder.status === 'LIVE' &&
        sqlOrder.venueOrderId &&
        matchedIds.has(sqlOrder.venueOrderId)
      ) {
        const updatedSql: ExchangeOrderRecord = {
          ...sqlOrder,
          status: 'FILLED',
          reason: `Polymarket CLOB MATCHED (#${sqlOrder.venueOrderId})`,
        }
        await getStateStore().appendOrder(cleanTenant, updatedSql)
        if (!syncedVenueIds.has(sqlOrder.venueOrderId)) {
          syncedVenueIds.add(sqlOrder.venueOrderId)
          matchedOrderIds.push(sqlOrder.venueOrderId)
        }
      }
    }
  } catch {
    // SQL persistence errors must not break caller
  }

  return {
    syncedCount: matchedOrderIds.length,
    matchedOrderIds,
  }
}

/**
 * Polls Polymarket CLOB open orders and trades to transition matched resting
 * GTC `LIVE` orders to `'MATCHED'` in memory and `'FILLED'` in SQL storage.
 */
export async function syncPolymarketOrderStatuses(
  tenantId = DEFAULT_TENANT_ID,
): Promise<SyncPolymarketOrderStatusesResult> {
  if (!isPolymarketConfigured()) {
    return { syncedCount: 0, matchedOrderIds: [] }
  }
  let client: PolymarketClobClientLike
  try {
    client = await resolveClobClient()
  } catch {
    return { syncedCount: 0, matchedOrderIds: [] }
  }

  let openOrders: OpenOrder[] = []
  let trades: Trade[] = []
  try {
    if (typeof client.getOpenOrders === 'function') {
      const res = await client.getOpenOrders()
      if (Array.isArray(res)) openOrders = res
    }
  } catch {
    // Ignore transient openOrders fetch failure
  }
  try {
    if (typeof client.getTrades === 'function') {
      const res = await client.getTrades()
      if (Array.isArray(res)) trades = res
    }
  } catch {
    // Ignore transient trades fetch failure
  }

  return applyMatchedOrderStatuses(tenantId, openOrders, trades)
}

export async function cancelOrdersForWindow(
  tenantId: string,
  instrumentId: string,
  options?: {
    reason?: string
    conditionId?: string
    tokenIds?: readonly string[]
  },
): Promise<CancelOrdersForWindowResult> {
  const cleanTenant = tenantId.trim() || DEFAULT_TENANT_ID
  const cleanInstrument = instrumentId.trim()
  if (!cleanInstrument) {
    return {
      ok: true,
      canceledCount: 0,
      canceledOrderIds: [],
      failedOrderIds: [],
    }
  }

  const state = getTenantPolyState(cleanTenant)
  const cancelReason = options?.reason ?? 'Window cancellation sweep'

  const seenVenueIds = new Set<string>()
  const targets: { venueOrderId: string; localOrderId: string | null }[] = []

  for (const o of state.orders) {
    if (
      o.instrumentId === cleanInstrument &&
      o.status === 'LIVE' &&
      o.venueOrderId
    ) {
      if (!seenVenueIds.has(o.venueOrderId)) {
        seenVenueIds.add(o.venueOrderId)
        targets.push({ venueOrderId: o.venueOrderId, localOrderId: o.id })
      }
    }
  }

  const hasRemoteFilter =
    Boolean(options?.conditionId) ||
    Boolean(options?.tokenIds && options.tokenIds.length > 0)

  if (
    targets.length === 0 &&
    (!hasRemoteFilter || !isPolymarketConfigured())
  ) {
    return {
      ok: true,
      canceledCount: 0,
      canceledOrderIds: [],
      failedOrderIds: [],
    }
  }

  if (!isPolymarketConfigured()) {
    return {
      ok: false,
      canceledCount: 0,
      canceledOrderIds: [],
      failedOrderIds: targets.map((t) => t.venueOrderId),
      error: 'Polymarket CLOB signer not configured.',
    }
  }

  let client: PolymarketClobClientLike
  try {
    client = await resolveClobClient()
  } catch (err) {
    return {
      ok: false,
      canceledCount: 0,
      canceledOrderIds: [],
      failedOrderIds: targets.map((t) => t.venueOrderId),
      error: err instanceof Error ? err.message : String(err),
    }
  }

  if (hasRemoteFilter) {
    try {
      const openOrders = await client.getOpenOrders()
      const tokenSet = new Set(options?.tokenIds ?? [])
      for (const remote of openOrders ?? []) {
        const matchesCondition =
          Boolean(options?.conditionId) &&
          remote.market === options?.conditionId
        const matchesToken = tokenSet.has(remote.asset_id)
        if (
          (matchesCondition || matchesToken) &&
          remote.id &&
          !seenVenueIds.has(remote.id)
        ) {
          seenVenueIds.add(remote.id)
          targets.push({
            venueOrderId: remote.id,
            localOrderId: null,
          })
        }
      }
    } catch {
      // Fall back to tracked local orders if getOpenOrders fails
    }
  }

  if (targets.length === 0) {
    return {
      ok: true,
      canceledCount: 0,
      canceledOrderIds: [],
      failedOrderIds: [],
    }
  }

  const canceledOrderIds: string[] = []
  const failedOrderIds: string[] = []
  let firstError: string | undefined

  for (const target of targets) {
    try {
      await client.cancelOrder({ orderID: target.venueOrderId })
      canceledOrderIds.push(target.venueOrderId)

      // Resolve index fresh after await so concurrent prepends cannot shift indices
      const freshIndex = state.orders.findIndex(
        (o) =>
          (target.localOrderId !== null && o.id === target.localOrderId) ||
          o.venueOrderId === target.venueOrderId,
      )

      if (freshIndex >= 0) {
        const current = state.orders[freshIndex]
        if (current.status === 'LIVE') {
          const updated: PolymarketOrderRecord = {
            ...current,
            status: 'CANCELED',
            reason: cancelReason,
          }
          state.orders[freshIndex] = updated
          if (current.side === 'BUY' && current.stakeUsd > 0) {
            releaseCanceledBuyEscrow({
              tenantId: cleanTenant,
              orderId: updated.id,
              instrumentId: updated.instrumentId,
              stakeUsd: updated.stakeUsd,
              reason: cancelReason,
            })
          }
          await persistOrderToStore(updated)
        }
      } else {
        await withTenantSqlCancelLock(cleanTenant, async () => {
          try {
            const persistedOrders = await getStateStore().getOrders(
              cleanTenant,
              1_000,
            )
            const persisted = persistedOrders.find(
              (o) => o.venueOrderId === target.venueOrderId,
            )
            if (
              persisted &&
              persisted.status === 'LIVE' &&
              !state.releasedCanceledEscrowOrderIds.has(persisted.id)
            ) {
              const updatedPersisted: ExchangeOrderRecord = {
                ...persisted,
                status: 'CANCELED_KILLSWITCH',
                reason: cancelReason,
              }
              await getStateStore().appendOrder(cleanTenant, updatedPersisted)

              if (persisted.side === 'BUY' && persisted.notionalUsd > 0) {
                const instId = persisted.pair.split('/')[0] || cleanInstrument
                releaseCanceledBuyEscrow({
                  tenantId: cleanTenant,
                  orderId: persisted.id,
                  instrumentId: instId,
                  stakeUsd: persisted.notionalUsd,
                  reason: cancelReason,
                })
              }
            }
          } catch {
            // Store lookup/update errors must not mask CLOB cancellation result
          }
        })
      }
    } catch (err) {
      failedOrderIds.push(target.venueOrderId)
      if (!firstError) {
        firstError = err instanceof Error ? err.message : String(err)
      }
    }
  }

  return {
    ok: failedOrderIds.length === 0,
    canceledCount: canceledOrderIds.length,
    canceledOrderIds,
    failedOrderIds,
    ...(firstError ? { error: firstError } : {}),
  }
}

export async function cancelPolymarketOrder(
  orderId: string,
  tenantId = DEFAULT_TENANT_ID,
): Promise<{ ok: boolean; error?: string }> {
  if (!isPolymarketConfigured()) {
    return { ok: false, error: 'Polymarket CLOB signer not configured.' }
  }
  const cleanTenant = tenantId.trim() || DEFAULT_TENANT_ID
  try {
    const client = await resolveClobClient()
    await client.cancelOrder({ orderID: orderId })
    const state = getTenantPolyState(cleanTenant)
    const cancelReason = 'Canceled by operator'
    const matchingIds = state.orders
      .filter((o) => o.venueOrderId === orderId || o.id === orderId)
      .map((o) => o.id)

    for (const targetId of matchingIds) {
      const freshIndex = state.orders.findIndex((o) => o.id === targetId)
      if (freshIndex < 0) continue
      const current = state.orders[freshIndex]
      const wasLive = current.status === 'LIVE'
      if (current.status === 'MATCHED') continue
      const updated: PolymarketOrderRecord = {
        ...current,
        status: 'CANCELED',
        reason: cancelReason,
      }
      state.orders[freshIndex] = updated
      if (wasLive && current.side === 'BUY' && current.stakeUsd > 0) {
        releaseCanceledBuyEscrow({
          tenantId: cleanTenant,
          orderId: updated.id,
          instrumentId: updated.instrumentId,
          stakeUsd: updated.stakeUsd,
          reason: cancelReason,
        })
      }
      await persistOrderToStore(updated)
    }

    if (matchingIds.length === 0) {
      await withTenantSqlCancelLock(cleanTenant, async () => {
        try {
          const persistedOrders = await getStateStore().getOrders(
            cleanTenant,
            1_000,
          )
          const persisted = persistedOrders.find(
            (o) => o.venueOrderId === orderId || o.id === orderId,
          )
          if (
            persisted &&
            persisted.status === 'LIVE' &&
            !state.releasedCanceledEscrowOrderIds.has(persisted.id)
          ) {
            await getStateStore().appendOrder(cleanTenant, {
              ...persisted,
              status: 'CANCELED_KILLSWITCH',
              reason: cancelReason,
            })
            if (persisted.side === 'BUY' && persisted.notionalUsd > 0) {
              releaseCanceledBuyEscrow({
                tenantId: cleanTenant,
                orderId: persisted.id,
                instrumentId: persisted.pair.split('/')[0] || persisted.pair,
                stakeUsd: persisted.notionalUsd,
                reason: cancelReason,
              })
            }
          }
        } catch {
          // Ignore store lookup failure
        }
      })
    }
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
  const cleanTenant = tenantId.trim() || DEFAULT_TENANT_ID
  try {
    const client = await resolveClobClient()
    await client.cancelAll()
    const state = getTenantPolyState(cleanTenant)
    const cancelReason = `CANCELED: ${reason}`
    const liveIds = state.orders
      .filter((o) => o.status === 'LIVE')
      .map((o) => o.id)
    const handledOrderIds = new Set<string>()

    for (const targetId of liveIds) {
      const freshIndex = state.orders.findIndex((o) => o.id === targetId)
      if (freshIndex < 0) continue
      const current = state.orders[freshIndex]
      if (current.status !== 'LIVE') continue
      const updated: PolymarketOrderRecord = {
        ...current,
        status: 'CANCELED',
        reason: cancelReason,
      }
      state.orders[freshIndex] = updated
      handledOrderIds.add(updated.id)
      if (current.side === 'BUY' && current.stakeUsd > 0) {
        releaseCanceledBuyEscrow({
          tenantId: cleanTenant,
          orderId: updated.id,
          instrumentId: updated.instrumentId,
          stakeUsd: updated.stakeUsd,
          reason: cancelReason,
        })
      }
      await persistOrderToStore(updated)
    }

    await withTenantSqlCancelLock(cleanTenant, async () => {
      try {
        const persistedOrders = await getStateStore().getOrders(
          cleanTenant,
          1_000,
        )
        for (const persisted of persistedOrders) {
          if (
            persisted.mode === 'polymarket-clob' &&
            persisted.status === 'LIVE' &&
            !handledOrderIds.has(persisted.id) &&
            !state.releasedCanceledEscrowOrderIds.has(persisted.id)
          ) {
            await getStateStore().appendOrder(cleanTenant, {
              ...persisted,
              status: 'CANCELED_KILLSWITCH',
              reason: cancelReason,
            })
            if (persisted.side === 'BUY' && persisted.notionalUsd > 0) {
              releaseCanceledBuyEscrow({
                tenantId: cleanTenant,
                orderId: persisted.id,
                instrumentId: persisted.pair.split('/')[0] || persisted.pair,
                stakeUsd: persisted.notionalUsd,
                reason: cancelReason,
              })
            }
          }
        }
      } catch {
        // Ignore store lookup failure
      }
    })

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

  await applyMatchedOrderStatuses(tenantId, openOrders ?? [], trades ?? [])

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
