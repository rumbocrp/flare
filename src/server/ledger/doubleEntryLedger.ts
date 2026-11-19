/**
 * Immutable double-entry accounting ledger (`P0-4` / `P1-4`).
 *
 * Every financial mutation (initial funding, spot fills, fees, prediction
 * stakes/settlements) produces balanced debit and credit postings per asset:
 *   sum(DEBIT[asset]) === sum(CREDIT[asset])
 *
 * Balances and positions can be derived deterministically from the journal
 * and verified with `verifyLedgerInvariant()`.
 */
import crypto from 'node:crypto'

export type PostingDirection = 'DEBIT' | 'CREDIT'

export type LedgerEntryKind =
  | 'INITIAL_FUNDING'
  | 'SPOT_FILL'
  | 'PREDICTION_STAKE'
  | 'PREDICTION_SETTLEMENT'
  | 'VAULT_RESET'

export type LedgerPosting = {
  account: string
  asset: string
  direction: PostingDirection
  amount: number
}

export type LedgerEntry = {
  id: string
  tenantId: string
  timestamp: string
  kind: LedgerEntryKind
  referenceId: string
  description: string
  postings: LedgerPosting[]
  metadata?: Record<string, string | number | boolean | null>
}

export type LedgerImbalance = {
  entryId: string
  asset: string
  debits: number
  credits: number
  delta: number
}

export type LedgerVerificationReport = {
  balanced: boolean
  entryCount: number
  imbalances: LedgerImbalance[]
}

export class LedgerImbalanceError extends Error {
  readonly imbalances: LedgerImbalance[]

  constructor(imbalances: LedgerImbalance[]) {
    super(
      `Double-entry invariant violation: ${imbalances
        .map(
          (i) =>
            `${i.entryId}[${i.asset}] DR=${i.debits.toFixed(8)} CR=${i.credits.toFixed(8)}`,
        )
        .join(', ')}`,
    )
    this.name = 'LedgerImbalanceError'
    this.imbalances = imbalances
  }
}

const EPSILON = 1e-6

function roundQty(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000
}

export function validateEntryBalance(entry: LedgerEntry): LedgerImbalance[] {
  const totals = new Map<string, { debits: number; credits: number }>()
  for (const posting of entry.postings) {
    if (!Number.isFinite(posting.amount) || posting.amount < 0) {
      return [
        {
          entryId: entry.id,
          asset: posting.asset,
          debits: NaN,
          credits: NaN,
          delta: NaN,
        },
      ]
    }
    const bucket = totals.get(posting.asset) ?? { debits: 0, credits: 0 }
    if (posting.direction === 'DEBIT') {
      bucket.debits += posting.amount
    } else {
      bucket.credits += posting.amount
    }
    totals.set(posting.asset, bucket)
  }

  const imbalances: LedgerImbalance[] = []
  for (const [asset, { debits, credits }] of totals) {
    const delta = Math.abs(debits - credits)
    if (delta > EPSILON) {
      imbalances.push({
        entryId: entry.id,
        asset,
        debits: roundQty(debits),
        credits: roundQty(credits),
        delta: roundQty(delta),
      })
    }
  }
  return imbalances
}

export function createBalancedLedgerEntry(params: {
  tenantId: string
  kind: LedgerEntryKind
  referenceId: string
  description: string
  postings: LedgerPosting[]
  timestamp?: string
  id?: string
  metadata?: Record<string, string | number | boolean | null>
}): LedgerEntry {
  const normalizedPostings = params.postings
    .filter((p) => p.amount > 0)
    .map((p) => ({
      ...p,
      amount: roundQty(p.amount),
    }))

  const entry: LedgerEntry = {
    id: params.id ?? `LED-${crypto.randomUUID()}`,
    tenantId: params.tenantId,
    timestamp: params.timestamp ?? new Date().toISOString(),
    kind: params.kind,
    referenceId: params.referenceId,
    description: params.description,
    postings: normalizedPostings,
    metadata: params.metadata,
  }

  const imbalances = validateEntryBalance(entry)
  if (imbalances.length > 0) {
    throw new LedgerImbalanceError(imbalances)
  }
  return entry
}

export function buildInitialFundingEntry(
  tenantId: string,
  balances: Record<string, { free: number; locked: number }>,
  referenceId = 'bootstrap',
): LedgerEntry {
  const postings: LedgerPosting[] = []
  for (const [asset, bal] of Object.entries(balances)) {
    const total = roundQty((bal.free ?? 0) + (bal.locked ?? 0))
    if (total <= 0) continue
    postings.push(
      { account: `wallet:${asset}`, asset, direction: 'DEBIT', amount: total },
      { account: `equity:initial:${asset}`, asset, direction: 'CREDIT', amount: total },
    )
  }
  return createBalancedLedgerEntry({
    tenantId,
    kind: 'INITIAL_FUNDING',
    referenceId,
    description: `Initial demo vault funding (${Object.keys(balances).join(', ')})`,
    postings,
  })
}

export function buildSpotFillEntry(params: {
  tenantId: string
  orderId: string
  venueOrderId?: string
  pair: string
  side: 'BUY' | 'SELL'
  quantity: number
  price: number
  notionalUsd: number
  feeUsd?: number
  mode: string
}): LedgerEntry {
  const [baseAsset = 'BTC', quoteAsset = 'USDT'] = params.pair.split('/')
  const qty = roundQty(params.quantity)
  const notional = roundQty(params.notionalUsd)
  const fee = roundQty(Math.max(0, params.feeUsd ?? 0))

  const postings: LedgerPosting[] = []
  if (params.side === 'BUY') {
    postings.push(
      // Base asset received into wallet vs trade clearing
      { account: `wallet:${baseAsset}`, asset: baseAsset, direction: 'DEBIT', amount: qty },
      { account: `clearing:spot:${baseAsset}`, asset: baseAsset, direction: 'CREDIT', amount: qty },
      // Quote asset spent from wallet to trade clearing
      { account: `clearing:spot:${quoteAsset}`, asset: quoteAsset, direction: 'DEBIT', amount: notional },
      { account: `wallet:${quoteAsset}`, asset: quoteAsset, direction: 'CREDIT', amount: notional },
    )
  } else {
    postings.push(
      // Base asset delivered from wallet to trade clearing
      { account: `clearing:spot:${baseAsset}`, asset: baseAsset, direction: 'DEBIT', amount: qty },
      { account: `wallet:${baseAsset}`, asset: baseAsset, direction: 'CREDIT', amount: qty },
      // Quote asset credited into wallet from trade clearing
      { account: `wallet:${quoteAsset}`, asset: quoteAsset, direction: 'DEBIT', amount: notional },
      { account: `clearing:spot:${quoteAsset}`, asset: quoteAsset, direction: 'CREDIT', amount: notional },
    )
  }

  if (fee > 0) {
    postings.push(
      { account: `expense:fees:${quoteAsset}`, asset: quoteAsset, direction: 'DEBIT', amount: fee },
      { account: `wallet:${quoteAsset}`, asset: quoteAsset, direction: 'CREDIT', amount: fee },
    )
  }

  return createBalancedLedgerEntry({
    tenantId: params.tenantId,
    kind: 'SPOT_FILL',
    referenceId: params.orderId,
    description: `${params.side} ${qty} ${params.pair} @ ${params.price.toFixed(4)} (${params.mode})`,
    postings,
    metadata: {
      pair: params.pair,
      side: params.side,
      price: params.price,
      mode: params.mode,
      venueOrderId: params.venueOrderId ?? null,
    },
  })
}

export function buildPredictionStakeEntry(params: {
  tenantId: string
  ticketId: string
  stakeUsd: number
  feeUsd?: number
  instrumentId?: string
}): LedgerEntry {
  const stake = roundQty(params.stakeUsd)
  const fee = roundQty(Math.max(0, params.feeUsd ?? 0))
  const postings: LedgerPosting[] = [
    { account: 'escrow:prediction:USDT', asset: 'USDT', direction: 'DEBIT', amount: stake },
    { account: 'wallet:USDT', asset: 'USDT', direction: 'CREDIT', amount: stake },
  ]
  if (fee > 0) {
    postings.push(
      { account: 'expense:fees:USDT', asset: 'USDT', direction: 'DEBIT', amount: fee },
      { account: 'wallet:USDT', asset: 'USDT', direction: 'CREDIT', amount: fee },
    )
  }
  return createBalancedLedgerEntry({
    tenantId: params.tenantId,
    kind: 'PREDICTION_STAKE',
    referenceId: params.ticketId,
    description: `Prediction stake $${stake.toFixed(2)} (${params.instrumentId ?? params.ticketId})`,
    postings,
  })
}

export function buildPredictionSettlementEntry(params: {
  tenantId: string
  ticketId: string
  stakeUsd: number
  payoutUsd: number
  won: boolean
}): LedgerEntry {
  const stake = roundQty(params.stakeUsd)
  const payout = roundQty(Math.max(0, params.payoutUsd))
  const postings: LedgerPosting[] = []

  if (params.won && payout >= stake) {
    const profit = roundQty(payout - stake)
    postings.push(
      { account: 'wallet:USDT', asset: 'USDT', direction: 'DEBIT', amount: payout },
      { account: 'escrow:prediction:USDT', asset: 'USDT', direction: 'CREDIT', amount: stake },
    )
    if (profit > 0) {
      postings.push({
        account: 'income:realized_pnl:USDT',
        asset: 'USDT',
        direction: 'CREDIT',
        amount: profit,
      })
    }
  } else {
    const loss = roundQty(Math.max(0, stake - payout))
    if (payout > 0) {
      postings.push({
        account: 'wallet:USDT',
        asset: 'USDT',
        direction: 'DEBIT',
        amount: payout,
      })
    }
    if (loss > 0) {
      postings.push({
        account: 'expense:realized_loss:USDT',
        asset: 'USDT',
        direction: 'DEBIT',
        amount: loss,
      })
    }
    postings.push({
      account: 'escrow:prediction:USDT',
      asset: 'USDT',
      direction: 'CREDIT',
      amount: stake,
    })
  }

  return createBalancedLedgerEntry({
    tenantId: params.tenantId,
    kind: 'PREDICTION_SETTLEMENT',
    referenceId: params.ticketId,
    description: `Prediction ${params.won ? 'WON' : 'LOST'} payout $${payout.toFixed(2)} vs stake $${stake.toFixed(2)}`,
    postings,
  })
}

/**
 * Derives signed account balances (`DEBIT - CREDIT`) across all journal entries.
 * Asset/wallet/expense accounts carry positive debit balances; equity/income carry negative (credit) balances.
 */
export function deriveAccountBalances(
  entries: readonly LedgerEntry[],
): Record<string, { asset: string; balance: number }> {
  const map: Record<string, { asset: string; balance: number }> = {}
  for (const entry of entries) {
    for (const p of entry.postings) {
      const existing = map[p.account] ?? { asset: p.asset, balance: 0 }
      existing.balance = roundQty(
        existing.balance + (p.direction === 'DEBIT' ? p.amount : -p.amount),
      )
      map[p.account] = existing
    }
  }
  return map
}

export function deriveWalletBalances(
  entries: readonly LedgerEntry[],
): Record<string, number> {
  const accounts = deriveAccountBalances(entries)
  const wallets: Record<string, number> = {}
  for (const [account, info] of Object.entries(accounts)) {
    if (account.startsWith('wallet:')) {
      wallets[info.asset] = info.balance
    }
  }
  return wallets
}

export function verifyLedgerInvariant(
  entries: readonly LedgerEntry[],
): LedgerVerificationReport {
  const imbalances: LedgerImbalance[] = []
  for (const entry of entries) {
    imbalances.push(...validateEntryBalance(entry))
  }
  return {
    balanced: imbalances.length === 0,
    entryCount: entries.length,
    imbalances,
  }
}
