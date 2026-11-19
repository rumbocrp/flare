import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createInitialBotState, STRATEGY_PRESETS } from '../../botEngine'
import {
  MemorySharedStateAdapter,
  RedisSharedStateAdapter,
  type RedisClientLike,
} from '../cache/sharedState'
import {
  buildInitialFundingEntry,
  buildPredictionSettlementEntry,
  buildPredictionStakeEntry,
  buildSpotFillEntry,
  createBalancedLedgerEntry,
  deriveWalletBalances,
  LedgerImbalanceError,
  verifyLedgerInvariant,
} from '../ledger/doubleEntryLedger'
import {
  POSTGRES_MIGRATIONS,
  PostgresStateStore,
  SqliteStateStore,
  type PgPoolLike,
} from './index'

describe('P0-4 Storage (SQLite WAL + Postgres/Timescale), Double-Entry Ledger & SharedState', () => {
  it('enforces double-entry invariants across spot fills, prediction settlements and rejects imbalances', () => {
    const funding = buildInitialFundingEntry('t1', {
      USDT: { free: 10_000, locked: 0 },
      BTC: { free: 0.05, locked: 0 },
    })
    const buyFill = buildSpotFillEntry({
      tenantId: 't1',
      orderId: 'ORD-1001',
      pair: 'BTC/USDT',
      side: 'BUY',
      quantity: 0.01,
      price: 50_000,
      notionalUsd: 500,
      feeUsd: 0.5,
      mode: 'demo-vault',
    })
    const predStake = buildPredictionStakeEntry({
      tenantId: 't1',
      ticketId: 'TKT-1',
      stakeUsd: 100,
      feeUsd: 1.2,
      instrumentId: 'btc-updown-15m',
    })
    const predWin = buildPredictionSettlementEntry({
      tenantId: 't1',
      ticketId: 'TKT-1',
      stakeUsd: 100,
      payoutUsd: 180,
      won: true,
    })

    const entries = [funding, buyFill, predStake, predWin]
    const verification = verifyLedgerInvariant(entries)
    expect(verification.balanced).toBe(true)
    expect(verification.imbalances).toHaveLength(0)

    const wallets = deriveWalletBalances(entries)
    // 10000 - 500 - 0.5 - 100 - 1.2 + 180 = 9578.3
    expect(wallets.USDT).toBeCloseTo(9_578.3, 4)
    expect(wallets.BTC).toBeCloseTo(0.06, 6)

    expect(() =>
      createBalancedLedgerEntry({
        tenantId: 't1',
        kind: 'SPOT_FILL',
        referenceId: 'BAD-1',
        description: 'Unbalanced test entry',
        postings: [
          { account: 'wallet:USDT', asset: 'USDT', direction: 'DEBIT', amount: 100 },
          { account: 'clearing:spot:USDT', asset: 'USDT', direction: 'CREDIT', amount: 80 },
        ],
      }),
    ).toThrow(LedgerImbalanceError)
  })

  it('persists snapshots, orders, ledger, audit, candles and enforces 90-day retention in SqliteStateStore', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-sqlite-test-'))
    const dbPath = path.join(tmpDir, 'flare.db')
    const store = new SqliteStateStore(dbPath)
    try {
      expect(await store.getSchemaVersion()).toBe(2)
      // Idempotent second migration call
      expect(await store.migrate()).toBe(2)

      const preset = STRATEGY_PRESETS[0]
      await store.saveTenantSnapshot({
        schemaVersion: 2,
        savedAt: new Date().toISOString(),
        tenantId: 'acme',
        presetId: preset.id,
        isRunning: false,
        state: createInitialBotState(preset),
      })
      const loaded = await store.loadTenantSnapshot('acme')
      expect(loaded?.tenantId).toBe('acme')
      expect(await store.listTenantIds()).toEqual(['acme'])

      const nowMs = Date.now()
      const oldIso = new Date(nowMs - 120 * 86_400_000).toISOString()
      const recentIso = new Date(nowMs - 2 * 86_400_000).toISOString()

      await store.appendOrder('acme', {
        id: 'ORD-OLD',
        clientOrderId: 'cid-old',
        timestamp: oldIso,
        pair: 'BTC/USDT',
        side: 'BUY',
        notionalUsd: 100,
        price: 40_000,
        quantity: 0.0025,
        status: 'FILLED',
        mode: 'demo-vault',
        source: 'manual',
      })
      await store.appendOrder('acme', {
        id: 'ORD-NEW',
        clientOrderId: 'cid-new',
        timestamp: recentIso,
        pair: 'BTC/USDT',
        side: 'BUY',
        notionalUsd: 100,
        price: 50_000,
        quantity: 0.002,
        status: 'FILLED',
        mode: 'demo-vault',
        source: 'manual',
      })

      expect((await store.findOrderByClientOrderId('acme', 'cid-new'))?.id).toBe(
        'ORD-NEW',
      )

      const ledgerEntry = buildInitialFundingEntry('acme', {
        USDT: { free: 5_000, locked: 0 },
      })
      await store.appendLedgerEntry(ledgerEntry)
      expect(await store.getLedgerEntries('acme')).toHaveLength(1)

      await store.appendAuditEvent({
        id: 'AUD-OLD',
        tenantId: 'acme',
        timestamp: oldIso,
        actor: 'admin',
        role: 'admin',
        action: 'bot:start',
        resource: '/api/bot/start',
        outcome: 'allowed',
      })
      await store.appendAuditEvent({
        id: 'AUD-NEW',
        tenantId: 'acme',
        timestamp: recentIso,
        actor: 'admin',
        role: 'admin',
        action: 'bot:stop',
        resource: '/api/bot/stop',
        outcome: 'allowed',
      })

      await store.upsertCandles('BTC/USDT', '15m', [
        {
          time: nowMs - 120 * 86_400_000,
          open: 40_000,
          high: 40_100,
          low: 39_900,
          close: 40_050,
          volume: 10,
        },
        {
          time: nowMs - 900_000,
          open: 80_000,
          high: 80_200,
          low: 79_800,
          close: 80_100,
          volume: 25,
        },
      ])

      const prune = await store.pruneRetention(90, nowMs)
      expect(prune.deletedOrders).toBe(1)
      expect(prune.deletedAuditEvents).toBe(1)
      expect(prune.deletedCandles).toBe(1)

      expect((await store.getOrders('acme')).map((o) => o.id)).toEqual([
        'ORD-NEW',
      ])
      expect((await store.getAuditEvents('acme')).map((a) => a.id)).toEqual([
        'AUD-NEW',
      ])
      expect(await store.getCandles('BTC/USDT', '15m', 10)).toHaveLength(1)
    } finally {
      await store.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('executes Postgres + TimescaleDB migrations and parameterized queries via PostgresStateStore', async () => {
    const executedSql: string[] = []
    const appliedVersions: number[] = []
    const mockPool: PgPoolLike = {
      async query(text, params) {
        executedSql.push(text.trim())
        if (text.startsWith('SELECT version FROM schema_migrations')) {
          return {
            rows: appliedVersions.map((v) => ({ version: v })) as never[],
          }
        }
        if (text.startsWith('INSERT INTO schema_migrations')) {
          appliedVersions.push(Number(params?.[0] ?? 0))
          return { rows: [], rowCount: 1 }
        }
        if (text.startsWith('SELECT MAX(version)')) {
          return {
            rows: [
              { v: appliedVersions.length ? Math.max(...appliedVersions) : 0 },
            ] as never[],
          }
        }
        if (text.startsWith('DELETE FROM')) {
          return { rows: [], rowCount: 3 }
        }
        return { rows: [], rowCount: 1 }
      },
    }

    const pgStore = new PostgresStateStore(mockPool, 'postgres://test')
    const latest = await pgStore.migrate()
    expect(latest).toBe(POSTGRES_MIGRATIONS.length)
    expect(await pgStore.getSchemaVersion()).toBe(2)
    expect(executedSql.some((s) => s.includes('create_hypertable'))).toBe(true)

    const prune = await pgStore.pruneRetention(90)
    expect(prune.deletedOrders).toBe(3)
    expect(prune.deletedAuditEvents).toBe(3)
    expect(prune.deletedCandles).toBe(3)
  })

  it('supports TTL, sliding rate-limit windows, locks and pub/sub in Memory and Redis SharedStateAdapters', async () => {
    const mem = new MemorySharedStateAdapter()
    await mem.set('k1', 'v1', 5_000)
    expect(await mem.get('k1')).toBe('v1')
    expect(await mem.acquireLock('job:tick', 'node-1', 5_000)).toBe(true)
    expect(await mem.acquireLock('job:tick', 'node-2', 5_000)).toBe(false)
    expect(await mem.releaseLock('job:tick', 'node-1')).toBe(true)
    expect(await mem.acquireLock('job:tick', 'node-2', 5_000)).toBe(true)

    const received: string[] = []
    const unsub = await mem.subscribe('events', (msg) => received.push(msg))
    await mem.publish('events', 'hello')
    expect(received).toEqual(['hello'])
    await unsub()

    // Redis adapter contract test with in-memory fake Redis client
    const kv = new Map<string, string>()
    const counters = new Map<string, number>()
    const fakeRedis: RedisClientLike = {
      async get(key) {
        return kv.get(key) ?? null
      },
      async set(key, value, opts) {
        if (opts?.NX && kv.has(key)) return null
        kv.set(key, value)
        return 'OK'
      },
      async del(key) {
        const existed = kv.delete(key)
        return existed ? 1 : 0
      },
      async incr(key) {
        const next = (counters.get(key) ?? 0) + 1
        counters.set(key, next)
        return next
      },
      async pExpire() {
        return 1
      },
      async pTTL() {
        return 59_000
      },
    }
    const redisAdapter = new RedisSharedStateAdapter(fakeRedis, 'test:')
    expect(redisAdapter.backend).toBe('redis')
    const w1 = await redisAdapter.incrWindow('tenant-a', 60_000)
    const w2 = await redisAdapter.incrWindow('tenant-a', 60_000)
    expect(w1.count).toBe(1)
    expect(w2.count).toBe(2)
    expect(await redisAdapter.acquireLock('leader', 'pod-1', 10_000)).toBe(true)
    expect(await redisAdapter.acquireLock('leader', 'pod-2', 10_000)).toBe(false)
  })
})
