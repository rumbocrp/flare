/**
 * Store singleton and driver selection (`P0-4`).
 *
 * Uses `SqliteStateStore` (`node:sqlite` WAL) by default, configurable via
 * `FLARE_DB_PATH` (or `:memory:` for ephemeral tests). When a PostgreSQL pool
 * is supplied or `setStateStore()` is invoked with `PostgresStateStore`, all
 * runtime persistence, orders, double-entry ledger, audit events, and archived
 * candles route through PostgreSQL/TimescaleDB identically.
 */
import path from 'node:path'
import { SqliteStateStore } from './sqliteStore'
import type { StateStore } from './types'

export * from './types'
export { POSTGRES_MIGRATIONS } from './postgresMigrations'
export { PostgresStateStore, type PgPoolLike } from './postgresStore'
export { SqliteStateStore } from './sqliteStore'

let activeStore: StateStore | null = null

export function getDefaultSqlitePath(): string {
  const configured = process.env.FLARE_DB_PATH?.trim()
  if (configured) {
    return configured === ':memory:' ? ':memory:' : path.resolve(configured)
  }
  if (process.env.VITEST) {
    return ':memory:'
  }
  return path.resolve(process.cwd(), 'src', 'server', 'flare.db')
}

export function getStateStore(): StateStore {
  if (!activeStore) {
    activeStore = new SqliteStateStore(getDefaultSqlitePath())
  }
  return activeStore
}

export function setStateStore(store: StateStore): void {
  activeStore = store
}

export async function resetStateStore(dbPath?: string): Promise<SqliteStateStore> {
  if (activeStore) {
    await activeStore.close().catch(() => {})
  }
  const next = new SqliteStateStore(dbPath ?? getDefaultSqlitePath())
  activeStore = next
  return next
}

export async function closeStateStore(): Promise<void> {
  if (!activeStore) return
  const current = activeStore
  activeStore = null
  await current.close()
}
