/**
 * Storage contract (`StateStore`) shared across SQLite (`node:sqlite` WAL default)
 * and PostgreSQL / TimescaleDB adapters (`P0-4`).
 */
import type { BotEngineState } from '../../botEngine'
import type { Candle, Interval, Strategy } from '../../types'
import type {
  ExchangeOrderRecord,
  PersistedExchangeState,
} from '../exchangeAdapter'
import type { LedgerEntry } from '../ledger/doubleEntryLedger'

export type StoreDriver = 'sqlite' | 'postgres'

export type PersistedTenantEnvelope = {
  schemaVersion: number
  savedAt: string
  tenantId: string
  presetId: string
  customStrategy?: Strategy
  isRunning: boolean
  state: BotEngineState
  exchange?: PersistedExchangeState
}

export type AuditEventRecord = {
  id: string
  tenantId: string
  timestamp: string
  actor: string
  role: string
  action: string
  resource: string
  outcome: 'allowed' | 'denied' | 'error'
  details?: Record<string, string | number | boolean | null>
}

export type RetentionPruneReport = {
  retentionDays: number
  cutoffIso: string
  deletedOrders: number
  deletedAuditEvents: number
  deletedCandles: number
}

export interface StateStore {
  readonly driver: StoreDriver
  readonly location: string
  migrate(): Promise<number>
  getSchemaVersion(): Promise<number>

  saveTenantSnapshot(envelope: PersistedTenantEnvelope): Promise<void>
  loadTenantSnapshot(tenantId: string): Promise<PersistedTenantEnvelope | null>
  listTenantIds(): Promise<string[]>

  appendOrder(tenantId: string, order: ExchangeOrderRecord): Promise<void>
  getOrders(tenantId: string, limit?: number): Promise<ExchangeOrderRecord[]>
  findOrderByClientOrderId(
    tenantId: string,
    clientOrderId: string,
  ): Promise<ExchangeOrderRecord | null>

  appendLedgerEntry(entry: LedgerEntry): Promise<void>
  getLedgerEntries(tenantId: string, limit?: number): Promise<LedgerEntry[]>

  appendAuditEvent(event: AuditEventRecord): Promise<void>
  getAuditEvents(tenantId: string, limit?: number): Promise<AuditEventRecord[]>

  upsertCandles(
    pair: string,
    interval: Interval,
    candles: readonly Candle[],
  ): Promise<number>
  getCandles(
    pair: string,
    interval: Interval,
    limit: number,
  ): Promise<Candle[]>

  pruneRetention(
    retentionDays?: number,
    nowMs?: number,
  ): Promise<RetentionPruneReport>
  close(): Promise<void>
}
