import crypto from 'node:crypto'
import type {
  ExchangePositionMode,
  ExchangePositionRecord,
} from './store/types'

export const BINANCE_TESTNET_BASE_URL = 'https://testnet.binance.vision'
export const BINANCE_LIVE_BASE_URL = 'https://api.binance.com'
const EXCHANGE_INFO_TTL_MS = 3_600_000
const BINANCE_HTTP_TIMEOUT_MS = 6_000

export type ResolvedBinanceVenue = {
  mode: ExchangePositionMode
  baseUrl: string
  apiKey: string
  apiSecret: string
  liveArmed: boolean
}

export type BinanceLiveArmStatus = {
  liveKeysPresent: boolean
  liveFlagEnabled: boolean
  liveArmed: boolean
  protectiveExitsEnabled: boolean
}

export type BinanceSymbolFilters = {
  symbol: string
  minQty: number
  maxQty: number
  stepSize: number
  minPrice: number
  maxPrice: number
  tickSize: number
  minNotional: number
}

export type ProtectiveExitOrderResult = {
  ok: boolean
  protectionOrderId?: string
  kind?: 'oco' | 'stop-loss-limit'
  error?: string
}

const symbolFilterCache = new Map<
  string,
  { fetchedAtMs: number; filters: BinanceSymbolFilters }
>()

export function clearSymbolFilterCacheForTests(): void {
  symbolFilterCache.clear()
}

export function getBinanceLiveArmStatus(): BinanceLiveArmStatus {
  const liveKey = process.env.BINANCE_LIVE_KEY?.trim() ?? ''
  const liveSecret = process.env.BINANCE_LIVE_SECRET?.trim() ?? ''
  const liveKeysPresent = liveKey.length > 8 && liveSecret.length > 8
  const liveFlagEnabled = process.env.FLARE_BINANCE_LIVE?.trim() === 'true'
  const protectiveExitsEnabled =
    process.env.FLARE_BINANCE_PROTECTIVE_EXITS?.trim() !== 'false'
  return {
    liveKeysPresent,
    liveFlagEnabled,
    liveArmed: liveKeysPresent && liveFlagEnabled,
    protectiveExitsEnabled,
  }
}

/**
 * Resolves the active Binance execution venue with strict dual-key arming:
 * - `binance-live` (`api.binance.com`) requires BOTH `BINANCE_LIVE_KEY` /
 *   `BINANCE_LIVE_SECRET` AND explicit `FLARE_BINANCE_LIVE=true`.
 * - Falls back to `binance-testnet` when testnet keys are configured.
 * - Returns `null` (paper mode) when neither venue is armed.
 */
export function resolveBinanceVenueCredentials(): ResolvedBinanceVenue | null {
  const liveKey = process.env.BINANCE_LIVE_KEY?.trim() ?? ''
  const liveSecret = process.env.BINANCE_LIVE_SECRET?.trim() ?? ''
  const liveArmed =
    liveKey.length > 8 &&
    liveSecret.length > 8 &&
    process.env.FLARE_BINANCE_LIVE?.trim() === 'true'

  if (liveArmed) {
    return {
      mode: 'binance-live',
      baseUrl: BINANCE_LIVE_BASE_URL,
      apiKey: liveKey,
      apiSecret: liveSecret,
      liveArmed: true,
    }
  }

  const testnetKey = process.env.BINANCE_TESTNET_KEY?.trim() ?? ''
  const testnetSecret = process.env.BINANCE_TESTNET_SECRET?.trim() ?? ''
  if (testnetKey.length > 8 && testnetSecret.length > 8) {
    return {
      mode: 'binance-testnet',
      baseUrl: BINANCE_TESTNET_BASE_URL,
      apiKey: testnetKey,
      apiSecret: testnetSecret,
      liveArmed: false,
    }
  }

  return null
}

function signBinanceQuery(query: string, apiSecret: string): string {
  return crypto.createHmac('sha256', apiSecret).update(query).digest('hex')
}

export function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 6
  const normalized = step.toFixed(10).replace(/0+$/, '')
  const dot = normalized.indexOf('.')
  return dot === -1 ? 0 : normalized.length - dot - 1
}

/**
 * Quantizes a numeric quantity or price cleanly to Binance's `stepSize` / `tickSize`
 * with exact decimal formatting (eliminating IEEE-754 trailing noise).
 */
export function quantizeToStep(
  value: number,
  step: number,
  rounding: 'floor' | 'round' | 'ceil' = 'floor',
): { value: number; text: string } {
  if (!Number.isFinite(value) || value <= 0) {
    return { value: 0, text: '0' }
  }
  if (!Number.isFinite(step) || step <= 0) {
    const rounded = Number(value.toFixed(6))
    return { value: rounded, text: String(rounded) }
  }
  const decimals = stepDecimals(step)
  const scale = 10 ** decimals
  const scaledVal = value * scale
  const scaledStep = Math.round(step * scale)
  if (scaledStep <= 0) {
    const rounded = Number(value.toFixed(decimals))
    return { value: rounded, text: rounded.toFixed(decimals) }
  }
  const units =
    rounding === 'ceil'
      ? Math.ceil(scaledVal / scaledStep - 1e-9)
      : rounding === 'round'
        ? Math.round(scaledVal / scaledStep)
        : Math.floor(scaledVal / scaledStep + 1e-9)
  const quantized = (units * scaledStep) / scale
  const text = quantized.toFixed(decimals)
  return { value: Number(text), text }
}

/**
 * Fetches and caches Binance `/api/v3/exchangeInfo` filters (`LOT_SIZE`, `PRICE_FILTER`,
 * `NOTIONAL` / `MIN_NOTIONAL`) for a pair. Returns `null` if unavailable.
 */
export async function fetchBinanceSymbolFilters(
  baseUrl: string,
  pair: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<BinanceSymbolFilters | null> {
  const symbol = pair.replace('/', '').toUpperCase()
  const cacheKey = `${baseUrl}:${symbol}`
  const cached = symbolFilterCache.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAtMs < EXCHANGE_INFO_TTL_MS) {
    return cached.filters
  }

  try {
    const resp = await fetchImpl(
      `${baseUrl}/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`,
      {
        method: 'GET',
        signal: AbortSignal.timeout(BINANCE_HTTP_TIMEOUT_MS),
      },
    )
    if (!resp.ok) return null
    const payload = (await resp.json().catch(() => null)) as {
      symbols?: {
        symbol?: string
        filters?: Record<string, string | undefined>[]
      }[]
    } | null
    const entry = payload?.symbols?.find((s) => s.symbol === symbol)
    if (!entry || !Array.isArray(entry.filters)) return null

    let minQty = 0
    let maxQty = Number.POSITIVE_INFINITY
    let stepSize = 0
    let minPrice = 0
    let maxPrice = Number.POSITIVE_INFINITY
    let tickSize = 0
    let minNotional = 0

    for (const f of entry.filters) {
      const fType = f.filterType
      if (fType === 'LOT_SIZE') {
        minQty = Number(f.minQty ?? 0)
        maxQty = Number(f.maxQty ?? Number.POSITIVE_INFINITY)
        stepSize = Number(f.stepSize ?? 0)
      } else if (fType === 'PRICE_FILTER') {
        minPrice = Number(f.minPrice ?? 0)
        maxPrice = Number(f.maxPrice ?? Number.POSITIVE_INFINITY)
        tickSize = Number(f.tickSize ?? 0)
      } else if (fType === 'NOTIONAL' || fType === 'MIN_NOTIONAL') {
        minNotional = Math.max(minNotional, Number(f.minNotional ?? 0))
      }
    }

    const filters: BinanceSymbolFilters = {
      symbol,
      minQty: Number.isFinite(minQty) ? minQty : 0,
      maxQty: Number.isFinite(maxQty) && maxQty > 0 ? maxQty : Number.POSITIVE_INFINITY,
      stepSize: Number.isFinite(stepSize) ? stepSize : 0,
      minPrice: Number.isFinite(minPrice) ? minPrice : 0,
      maxPrice: Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : Number.POSITIVE_INFINITY,
      tickSize: Number.isFinite(tickSize) ? tickSize : 0,
      minNotional: Number.isFinite(minNotional) ? minNotional : 0,
    }
    symbolFilterCache.set(cacheKey, { fetchedAtMs: Date.now(), filters })
    return filters
  } catch {
    return null
  }
}

export function validateAndQuantizeBinanceOrder(
  filters: BinanceSymbolFilters,
  params: { price: number; quantity: number },
):
  | { ok: true; quantity: number; quantityText: string; notionalUsd: number }
  | { ok: false; error: string } {
  const q = quantizeToStep(params.quantity, filters.stepSize, 'floor')
  if (q.value <= 0 || q.value < filters.minQty) {
    return {
      ok: false,
      error: `Order quantity ${q.text} below Binance LOT_SIZE minQty (${filters.minQty}) for ${filters.symbol}.`,
    }
  }
  if (q.value > filters.maxQty) {
    return {
      ok: false,
      error: `Order quantity ${q.text} exceeds Binance LOT_SIZE maxQty (${filters.maxQty}) for ${filters.symbol}.`,
    }
  }
  const notionalUsd = Number((q.value * params.price).toFixed(2))
  if (filters.minNotional > 0 && notionalUsd < filters.minNotional) {
    return {
      ok: false,
      error: `Order notional $${notionalUsd.toFixed(2)} below Binance MIN_NOTIONAL ($${filters.minNotional}) for ${filters.symbol}.`,
    }
  }
  return { ok: true, quantity: q.value, quantityText: q.text, notionalUsd }
}

/**
 * Places an exchange-native protective exit order immediately after a spot BUY entry:
 * - OCO (`POST /api/v3/orderList/oco`) when both `stopPrice` and `targetPrice` are valid.
 * - `STOP_LOSS_LIMIT` (`POST /api/v3/order`) when only `stopPrice` is provided.
 */
export async function placeBinanceProtectiveExit(
  venue: ResolvedBinanceVenue,
  params: {
    pair: string
    quantity: number
    entryPrice: number
    stopPrice: number
    targetPrice?: number | null
    filters?: BinanceSymbolFilters | null
    fetchImpl?: typeof fetch
  },
): Promise<ProtectiveExitOrderResult> {
  const fetchFn = params.fetchImpl ?? globalThis.fetch
  const symbol = params.pair.replace('/', '').toUpperCase()
  const filters =
    params.filters ??
    (await fetchBinanceSymbolFilters(venue.baseUrl, params.pair, fetchFn))

  const tickSize = filters?.tickSize ?? 0.01
  const stepSize = filters?.stepSize ?? 0.000001

  const qtyQ = quantizeToStep(params.quantity, stepSize, 'floor')
  if (qtyQ.value <= 0) {
    return { ok: false, error: 'Quantized protective exit quantity is zero.' }
  }

  const stopQ = quantizeToStep(params.stopPrice, tickSize, 'floor')
  const stopLimitRaw = params.stopPrice * 0.997
  const stopLimitQ = quantizeToStep(
    Math.min(stopLimitRaw, stopQ.value),
    tickSize,
    'floor',
  )

  const hasValidTarget =
    typeof params.targetPrice === 'number' &&
    Number.isFinite(params.targetPrice) &&
    params.targetPrice > params.entryPrice &&
    stopQ.value < params.entryPrice

  try {
    if (hasValidTarget && params.targetPrice) {
      const targetQ = quantizeToStep(params.targetPrice, tickSize, 'ceil')
      const query =
        `symbol=${symbol}&side=SELL&quantity=${qtyQ.text}` +
        `&aboveType=LIMIT_MAKER&abovePrice=${targetQ.text}` +
        `&belowType=STOP_LOSS_LIMIT&belowStopPrice=${stopQ.text}&belowPrice=${stopLimitQ.text}&belowTimeInForce=GTC` +
        `&timestamp=${Date.now()}`
      const sig = signBinanceQuery(query, venue.apiSecret)
      const resp = await fetchFn(
        `${venue.baseUrl}/api/v3/orderList/oco?${query}&signature=${sig}`,
        {
          method: 'POST',
          headers: { 'X-MBX-APIKEY': venue.apiKey },
          signal: AbortSignal.timeout(BINANCE_HTTP_TIMEOUT_MS),
        },
      )
      const payload = (await resp.json().catch(() => null)) as {
        orderListId?: number | string
        msg?: string
      } | null
      if (resp.ok && payload && payload.orderListId !== undefined) {
        return {
          ok: true,
          kind: 'oco',
          protectionOrderId: `oco:${payload.orderListId}`,
        }
      }
      // Fall back to standalone STOP_LOSS_LIMIT if OCO endpoint rejected (e.g. tight spread)
    }

    const slQuery =
      `symbol=${symbol}&side=SELL&type=STOP_LOSS_LIMIT&timeInForce=GTC` +
      `&quantity=${qtyQ.text}&stopPrice=${stopQ.text}&price=${stopLimitQ.text}` +
      `&timestamp=${Date.now()}`
    const slSig = signBinanceQuery(slQuery, venue.apiSecret)
    const slResp = await fetchFn(
      `${venue.baseUrl}/api/v3/order?${slQuery}&signature=${slSig}`,
      {
        method: 'POST',
        headers: { 'X-MBX-APIKEY': venue.apiKey },
        signal: AbortSignal.timeout(BINANCE_HTTP_TIMEOUT_MS),
      },
    )
    const slPayload = (await slResp.json().catch(() => null)) as {
      orderId?: number | string
      msg?: string
    } | null
    if (!slResp.ok || !slPayload || slPayload.orderId === undefined) {
      return {
        ok: false,
        error: `Protective stop placement failed (HTTP ${slResp.status}): ${slPayload?.msg ?? 'Rejected by Binance'}`,
      }
    }
    return {
      ok: true,
      kind: 'stop-loss-limit',
      protectionOrderId: `ord:${slPayload.orderId}`,
    }
  } catch (err) {
    return {
      ok: false,
      error: `Protective exit placement error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export async function cancelBinanceProtectiveExit(
  venue: ResolvedBinanceVenue,
  pair: string,
  protectionOrderId: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ ok: boolean; error?: string }> {
  const symbol = pair.replace('/', '').toUpperCase()
  try {
    if (protectionOrderId.startsWith('oco:')) {
      const orderListId = protectionOrderId.slice(4)
      const query = `symbol=${symbol}&orderListId=${encodeURIComponent(orderListId)}&timestamp=${Date.now()}`
      const sig = signBinanceQuery(query, venue.apiSecret)
      const resp = await fetchImpl(
        `${venue.baseUrl}/api/v3/orderList?${query}&signature=${sig}`,
        {
          method: 'DELETE',
          headers: { 'X-MBX-APIKEY': venue.apiKey },
          signal: AbortSignal.timeout(BINANCE_HTTP_TIMEOUT_MS),
        },
      )
      return resp.ok
        ? { ok: true }
        : { ok: false, error: `HTTP ${resp.status} canceling OCO ${orderListId}` }
    }
    const orderId = protectionOrderId.startsWith('ord:')
      ? protectionOrderId.slice(4)
      : protectionOrderId
    const query = `symbol=${symbol}&orderId=${encodeURIComponent(orderId)}&timestamp=${Date.now()}`
    const sig = signBinanceQuery(query, venue.apiSecret)
    const resp = await fetchImpl(
      `${venue.baseUrl}/api/v3/order?${query}&signature=${sig}`,
      {
        method: 'DELETE',
        headers: { 'X-MBX-APIKEY': venue.apiKey },
        signal: AbortSignal.timeout(BINANCE_HTTP_TIMEOUT_MS),
      },
    )
    return resp.ok
      ? { ok: true }
      : { ok: false, error: `HTTP ${resp.status} canceling protective order ${orderId}` }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function estimateFeeUsd(
  fee: number | undefined,
  feeAsset: string | undefined,
  pair: string,
  fillPrice: number,
): number {
  if (typeof fee !== 'number' || !Number.isFinite(fee) || fee <= 0) return 0
  const asset = feeAsset?.toUpperCase() ?? ''
  if (asset === 'USDT' || asset === 'USDC' || asset === 'BUSD' || asset === 'FDUSD') {
    return Number(fee.toFixed(6))
  }
  const baseAsset = pair.split('/')[0]?.toUpperCase()
  if (asset && baseAsset && asset === baseAsset && Number.isFinite(fillPrice) && fillPrice > 0) {
    return Number((fee * fillPrice).toFixed(6))
  }
  return 0
}

export function computeClosedExchangePositionMetrics(params: {
  side: 'LONG' | 'SHORT'
  entryQty: number
  exitQty: number
  entryAvgPrice: number
  exitAvgPrice: number
  entryFeeUsd: number
  exitFeeUsd: number
  stopPrice: number | null
}): { realizedPnlUsd: number; rMultiple: number | null } {
  const matchedQty = Math.min(params.entryQty, params.exitQty)
  const dir = params.side === 'LONG' ? 1 : -1
  const grossPnl = dir * (params.exitAvgPrice - params.entryAvgPrice) * matchedQty
  const realizedPnlUsd = Number(
    (grossPnl - params.entryFeeUsd - params.exitFeeUsd).toFixed(4),
  )

  let rMultiple: number | null = null
  if (
    params.stopPrice !== null &&
    Number.isFinite(params.stopPrice) &&
    params.stopPrice > 0 &&
    matchedQty > 0
  ) {
    const riskUsd = Math.abs(params.entryAvgPrice - params.stopPrice) * matchedQty
    if (riskUsd > 1e-6) {
      rMultiple = Number((realizedPnlUsd / riskUsd).toFixed(3))
    }
  }

  return { realizedPnlUsd, rMultiple }
}

export type VenueReconciliationReport = {
  mode: ExchangePositionMode
  checkedOpenPositions: number
  reconciledClosedPositions: ExchangePositionRecord[]
  openVenueOrdersCount: number
  errors: string[]
  reconciledAt: string
}

/**
 * Reconciles durable SQL `OPEN` exchange positions against Binance open orders & recent
 * fills (`GET /api/v3/openOrders` + `GET /api/v3/myTrades`). If a protective OCO/stop-loss
 * filled while the server was offline, closes the position with exact realized PnL.
 */
export async function reconcileOpenBinancePositions(
  venue: ResolvedBinanceVenue,
  openPositions: readonly ExchangePositionRecord[],
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<VenueReconciliationReport> {
  const reconciledClosedPositions: ExchangePositionRecord[] = []
  const errors: string[] = []
  let openVenueOrdersCount = 0

  try {
    const ooQuery = `timestamp=${Date.now()}`
    const ooSig = signBinanceQuery(ooQuery, venue.apiSecret)
    const ooResp = await fetchImpl(
      `${venue.baseUrl}/api/v3/openOrders?${ooQuery}&signature=${ooSig}`,
      {
        method: 'GET',
        headers: { 'X-MBX-APIKEY': venue.apiKey },
        signal: AbortSignal.timeout(BINANCE_HTTP_TIMEOUT_MS),
      },
    )
    if (ooResp.ok) {
      const openOrders = (await ooResp.json().catch(() => [])) as unknown[]
      if (Array.isArray(openOrders)) {
        openVenueOrdersCount = openOrders.length
      }
    } else {
      errors.push(`GET /api/v3/openOrders returned HTTP ${ooResp.status}`)
    }
  } catch (err) {
    errors.push(
      `GET /api/v3/openOrders failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  for (const pos of openPositions) {
    if (pos.mode !== venue.mode || pos.status !== 'OPEN') continue
    const symbol = pos.pair.replace('/', '').toUpperCase()
    const openedMs = Date.parse(pos.openedAt)
    try {
      const startTimeParam = Number.isFinite(openedMs)
        ? `&startTime=${Math.max(0, Math.floor(openedMs))}`
        : ''
      const trQuery = `symbol=${symbol}${startTimeParam}&limit=50&timestamp=${Date.now()}`
      const trSig = signBinanceQuery(trQuery, venue.apiSecret)
      const trResp = await fetchImpl(
        `${venue.baseUrl}/api/v3/myTrades?${trQuery}&signature=${trSig}`,
        {
          method: 'GET',
          headers: { 'X-MBX-APIKEY': venue.apiKey },
          signal: AbortSignal.timeout(BINANCE_HTTP_TIMEOUT_MS),
        },
      )
      if (!trResp.ok) {
        errors.push(`GET /api/v3/myTrades (${symbol}) HTTP ${trResp.status}`)
        continue
      }
      const trades = (await trResp.json().catch(() => [])) as {
        orderId?: number | string
        isBuyer?: boolean
        price?: string
        qty?: string
        commission?: string
        commissionAsset?: string
        time?: number
      }[]
      if (!Array.isArray(trades)) continue

      // Look for SELL fills after entry that aren't the entry order itself
      const exitFills = trades.filter(
        (tr) =>
          tr.isBuyer === false &&
          String(tr.orderId ?? '') !== (pos.entryVenueOrderId ?? ''),
      )
      if (exitFills.length === 0) continue

      let totalExitQty = 0
      let weightedQuote = 0
      let exitFeeUsd = 0
      let lastExitOrderId: string | null = null
      let lastExitTimeMs = Date.now()

      for (const fill of exitFills) {
        const qty = Number(fill.qty ?? 0)
        const price = Number(fill.price ?? 0)
        if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) {
          continue
        }
        totalExitQty += qty
        weightedQuote += qty * price
        exitFeeUsd += estimateFeeUsd(
          Number(fill.commission ?? 0),
          fill.commissionAsset,
          pos.pair,
          price,
        )
        if (fill.orderId !== undefined) {
          lastExitOrderId = String(fill.orderId)
        }
        if (typeof fill.time === 'number' && Number.isFinite(fill.time)) {
          lastExitTimeMs = fill.time
        }
      }

      if (totalExitQty >= pos.entryQty * 0.98 && weightedQuote > 0) {
        const exitAvgPrice = Number((weightedQuote / totalExitQty).toFixed(4))
        const { realizedPnlUsd, rMultiple } = computeClosedExchangePositionMetrics({
          side: pos.side,
          entryQty: pos.entryQty,
          exitQty: totalExitQty,
          entryAvgPrice: pos.entryAvgPrice,
          exitAvgPrice,
          entryFeeUsd: pos.entryFeeUsd,
          exitFeeUsd,
          stopPrice: pos.stopPrice,
        })
        reconciledClosedPositions.push({
          ...pos,
          status: 'CLOSED',
          exitOrderId: `VENUE-${lastExitOrderId ?? 'reconciled'}`,
          exitVenueOrderId: lastExitOrderId,
          exitQty: Number(totalExitQty.toFixed(6)),
          exitAvgPrice,
          exitFeeUsd: Number(exitFeeUsd.toFixed(6)),
          realizedPnlUsd,
          rMultiple,
          exitReason: 'exchange-protective-exit',
          closedAt: new Date(lastExitTimeMs).toISOString(),
        })
      }
    } catch (err) {
      errors.push(
        `Reconcile ${pos.pair} (${pos.id}) error: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return {
    mode: venue.mode,
    checkedOpenPositions: openPositions.filter(
      (p) => p.mode === venue.mode && p.status === 'OPEN',
    ).length,
    reconciledClosedPositions,
    openVenueOrdersCount,
    errors,
    reconciledAt: new Date().toISOString(),
  }
}
