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
      expect(await store.getSchemaVersion()).toBe(6)
      // Idempotent second migration call
      expect(await store.migrate()).toBe(6)

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
    expect(latest).toBe(6)
    expect(await pgStore.getSchemaVersion()).toBe(6)
    expect(executedSql.some((s) => s.includes('create_hypertable'))).toBe(true)
    expect(
      executedSql.some((s) =>
        s.includes('CREATE TABLE IF NOT EXISTS training_runs'),
      ),
    ).toBe(true)
    expect(
      executedSql.some((s) =>
        s.includes('CREATE TABLE IF NOT EXISTS runtime_events'),
      ),
    ).toBe(true)
    expect(
      executedSql.some((s) =>
        s.includes('CREATE TABLE IF NOT EXISTS strategy_audits'),
      ),
    ).toBe(true)
    expect(
      executedSql.some((s) =>
        s.includes('CREATE TABLE IF NOT EXISTS prediction_windows'),
      ),
    ).toBe(true)
    expect(
      executedSql.some((s) =>
        s.includes('CREATE TABLE IF NOT EXISTS prediction_window_snapshots'),
      ),
    ).toBe(true)
    expect(
      executedSql.some((s) =>
        s.includes('CREATE TABLE IF NOT EXISTS prediction_shadow_trades'),
      ),
    ).toBe(true)
    expect(
      executedSql.some((s) =>
        s.includes('CREATE TABLE IF NOT EXISTS prediction_strategy_states'),
      ),
    ).toBe(true)

    const prune = await pgStore.pruneRetention(90)
    expect(prune.deletedOrders).toBe(3)
    expect(prune.deletedAuditEvents).toBe(3)
    expect(prune.deletedCandles).toBe(3)
    expect(prune.windowRetentionDays).toBe(365)
    expect(prune.deletedPredictionWindows).toBe(3)
    expect(prune.deletedPredictionSnapshots).toBe(3)
    expect(prune.deletedPredictionTrades).toBe(3)
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

  it('persists v3 prediction windows, snapshots, shadow trades, strategy states, survives reopen, and enforces 365-day window retention in SqliteStateStore', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-sqlite-v3-'))
    const dbPath = path.join(tmpDir, 'flare-v3.db')
    let store = new SqliteStateStore(dbPath)
    const nowMs = 1_760_000_000_000

    try {
      expect(await store.getSchemaVersion()).toBe(6)
      expect(await store.migrate()).toBe(6)

      // 1. Window upsert + COALESCE preservation of pinned openTwap & non-unknown resolutionSource
      await store.upsertPredictionWindow({
        slug: 'btc-updown-5m-open',
        timeframe: '5m',
        conditionId: 'cond-1',
        upTokenId: 'up-1',
        downTokenId: 'down-1',
        resolutionSource: 'chainlink-twap-60s',
        startTimeMs: nowMs - 120_000,
        endTimeMs: nowMs + 180_000,
        openTwap: 90_000,
        closeTwap: null,
        resolvedUp: null,
        tickSize: 0.01,
        negRisk: false,
        volumeUsd: 12_500,
        updatedAt: nowMs - 60_000,
      })

      // Partial discovery refresh with openTwap=null and resolutionSource='unknown' must NOT clobber pinned S0 or source
      await store.upsertPredictionWindow({
        slug: 'btc-updown-5m-open',
        timeframe: '5m',
        conditionId: null,
        upTokenId: null,
        downTokenId: null,
        resolutionSource: 'unknown',
        startTimeMs: nowMs - 120_000,
        endTimeMs: nowMs + 180_000,
        openTwap: null,
        closeTwap: null,
        resolvedUp: null,
        tickSize: null,
        negRisk: false,
        volumeUsd: null,
        updatedAt: nowMs - 30_000,
      })

      const refreshedOpen = await store.getPredictionWindows({
        slug: 'btc-updown-5m-open',
      })
      expect(refreshedOpen).toHaveLength(1)
      expect(refreshedOpen[0].openTwap).toBe(90_000)
      expect(refreshedOpen[0].conditionId).toBe('cond-1')
      expect(refreshedOpen[0].resolutionSource).toBe('chainlink-twap-60s')
      expect(refreshedOpen[0].closeTwap).toBeNull()
      expect(refreshedOpen[0].resolvedUp).toBeNull()

      // Settlement update
      await store.upsertPredictionWindow({
        slug: 'btc-updown-5m-open',
        timeframe: '5m',
        conditionId: 'cond-1',
        upTokenId: 'up-1',
        downTokenId: 'down-1',
        resolutionSource: 'chainlink-twap-60s',
        startTimeMs: nowMs - 120_000,
        endTimeMs: nowMs + 180_000,
        openTwap: null,
        closeTwap: 90_120,
        resolvedUp: true,
        tickSize: 0.01,
        negRisk: false,
        volumeUsd: 14_000,
        updatedAt: nowMs,
      })

      await store.upsertPredictionWindow({
        slug: 'btc-updown-1h-unsettled',
        timeframe: '1h',
        conditionId: null,
        upTokenId: 'up-1h',
        downTokenId: 'down-1h',
        resolutionSource: 'binance-1h-candle',
        startTimeMs: nowMs - 60_000,
        endTimeMs: nowMs + 3_540_000,
        openTwap: 89_950,
        closeTwap: null,
        resolvedUp: null,
        tickSize: null,
        negRisk: true,
        volumeUsd: null,
        updatedAt: nowMs,
      })

      expect(await store.getSettledWindowCount()).toBe(1)
      expect(await store.getSettledWindowCount('5m')).toBe(1)
      expect(await store.getSettledWindowCount('1h')).toBe(0)
      expect(
        await store.getPredictionWindows({
          settledOnly: true,
          unsettledOnly: true,
        }),
      ).toEqual([])
      expect(
        (await store.getPredictionWindows({ unsettledOnly: true })).map(
          (w) => w.slug,
        ),
      ).toEqual(['btc-updown-1h-unsettled'])

      // 2. Snapshots: UNIQUE(slug, captured_at_ms) idempotency + ASC ordering
      await store.appendPredictionSnapshot({
        slug: 'btc-updown-5m-open',
        capturedAtMs: nowMs - 50_000,
        secondsRemaining: 230,
        twapPrice: 90_050,
        binancePrice: 90_060,
        sigma1m: 0.0012,
        basisBps: -1.1,
        yesBid: 0.54,
        yesAsk: 0.56,
        yesDepthUsd: 420,
        noBid: 0.44,
        noAsk: 0.46,
        noDepthUsd: 380,
        pModelYes: 0.58,
      })
      // Duplicate timestamp updates existing row instead of creating 2nd row
      await store.appendPredictionSnapshot({
        slug: 'btc-updown-5m-open',
        capturedAtMs: nowMs - 50_000,
        secondsRemaining: 230,
        twapPrice: 90_055,
        binancePrice: 90_062,
        sigma1m: 0.0012,
        basisBps: -0.8,
        yesBid: 0.55,
        yesAsk: 0.57,
        yesDepthUsd: 450,
        noBid: 0.43,
        noAsk: 0.45,
        noDepthUsd: 390,
        pModelYes: 0.59,
      })
      await store.appendPredictionSnapshot({
        slug: 'btc-updown-5m-open',
        capturedAtMs: nowMs - 60_000,
        secondsRemaining: 240,
        twapPrice: null,
        binancePrice: null,
        sigma1m: null,
        basisBps: null,
        yesBid: null,
        yesAsk: null,
        yesDepthUsd: null,
        noBid: null,
        noAsk: null,
        noDepthUsd: null,
        pModelYes: null,
      })

      const snaps = await store.getPredictionSnapshots('btc-updown-5m-open')
      expect(snaps).toHaveLength(2)
      expect(snaps[0].capturedAtMs).toBe(nowMs - 60_000)
      expect(snaps[0].twapPrice).toBeNull()
      expect(snaps[0].pModelYes).toBeNull()
      expect(snaps[1].capturedAtMs).toBe(nowMs - 50_000)
      expect(snaps[1].twapPrice).toBe(90_055)
      expect(snaps[1].yesBid).toBe(0.55)

      // 3. Shadow trades: OPEN -> markout30s -> SETTLED
      await store.upsertPredictionTrade({
        id: 'pt-1',
        tenantId: 'default',
        strategyId: 'c5-late-favorite',
        lane: 'high-hit-rate',
        mode: 'canary',
        slug: 'btc-updown-5m-open',
        timeframe: '5m',
        outcome: 'YES',
        liquidityRole: 'taker',
        entryTimeMs: nowMs - 40_000,
        entryPrice: 0.72,
        feeUsd: 0.05,
        stakeUsd: 5,
        shares: 6.94,
        pModel: 0.81,
        pCalibrated: 0.79,
        markout30s: null,
        resolvedUp: null,
        won: null,
        netPnlUsd: null,
        venueOrderId: 'clob-ord-1',
        status: 'OPEN',
      })
      await store.upsertPredictionTrade({
        id: 'pt-1',
        tenantId: 'default',
        strategyId: 'c5-late-favorite',
        lane: 'high-hit-rate',
        mode: 'canary',
        slug: 'btc-updown-5m-open',
        timeframe: '5m',
        outcome: 'YES',
        liquidityRole: 'taker',
        entryTimeMs: nowMs - 40_000,
        entryPrice: 0.72,
        feeUsd: 0.05,
        stakeUsd: 5,
        shares: 6.94,
        pModel: 0.81,
        pCalibrated: 0.79,
        markout30s: 0.06,
        resolvedUp: true,
        won: true,
        netPnlUsd: 1.89,
        venueOrderId: 'clob-ord-1',
        status: 'SETTLED',
      })

      const trades = await store.getPredictionTrades('default', {
        strategyId: 'c5-late-favorite',
        status: 'SETTLED',
      })
      expect(trades).toHaveLength(1)
      expect(trades[0].markout30s).toBeCloseTo(0.06, 6)
      expect(trades[0].won).toBe(true)
      expect(trades[0].netPnlUsd).toBeCloseTo(1.89, 6)

      // 4. Strategy mode states including 'research'
      await store.setStrategyModeState({
        tenantId: 'default',
        strategyId: 'c15-late-favorite-guarded',
        mode: 'research',
        haltedReason: null,
        updatedAt: nowMs,
      })
      await store.setStrategyModeState({
        tenantId: 'default',
        strategyId: 'c5-late-favorite',
        mode: 'canary',
        haltedReason: '3 daily losses',
        updatedAt: nowMs,
      })

      // 5. Persistence across close + reopen
      await store.close()
      store = new SqliteStateStore(dbPath)
      expect(await store.getSchemaVersion()).toBe(6)

      const states = await store.getStrategyModeStates('default')
      expect(states).toHaveLength(2)
      expect(states[0].strategyId).toBe('c15-late-favorite-guarded')
      expect(states[0].mode).toBe('research')
      expect(states[0].haltedReason).toBeNull()
      expect(states[1].mode).toBe('canary')
      expect(states[1].haltedReason).toBe('3 daily losses')

      // 6. Retention: 120-day windows/snapshots/trades survive pruneRetention(90, nowMs),
      // while 400-day settled records are pruned and 400-day OPEN trades are preserved.
      const day120Ms = nowMs - 120 * 86_400_000
      const day400Ms = nowMs - 400 * 86_400_000

      await store.upsertPredictionWindow({
        slug: 'btc-updown-5m-120d',
        timeframe: '5m',
        conditionId: null,
        upTokenId: null,
        downTokenId: null,
        resolutionSource: 'chainlink-twap-60s',
        startTimeMs: day120Ms - 300_000,
        endTimeMs: day120Ms,
        openTwap: 70_000,
        closeTwap: 70_050,
        resolvedUp: true,
        tickSize: 0.01,
        negRisk: false,
        volumeUsd: 5_000,
        updatedAt: day120Ms,
      })
      await store.appendPredictionSnapshot({
        slug: 'btc-updown-5m-120d',
        capturedAtMs: day120Ms - 60_000,
        secondsRemaining: 60,
        twapPrice: 70_020,
        binancePrice: 70_025,
        sigma1m: 0.001,
        basisBps: -0.7,
        yesBid: 0.6,
        yesAsk: 0.62,
        yesDepthUsd: 300,
        noBid: 0.38,
        noAsk: 0.4,
        noDepthUsd: 300,
        pModelYes: 0.63,
      })
      await store.upsertPredictionTrade({
        id: 'pt-120d',
        tenantId: 'default',
        strategyId: 'c5-late-favorite',
        lane: 'high-hit-rate',
        mode: 'paper',
        slug: 'btc-updown-5m-120d',
        timeframe: '5m',
        outcome: 'YES',
        liquidityRole: 'taker',
        entryTimeMs: day120Ms - 30_000,
        entryPrice: 0.62,
        feeUsd: 0.04,
        stakeUsd: 5,
        shares: 8.06,
        pModel: 0.68,
        pCalibrated: 0.66,
        markout30s: 0.02,
        resolvedUp: true,
        won: true,
        netPnlUsd: 2.9,
        venueOrderId: null,
        status: 'SETTLED',
      })

      await store.upsertPredictionWindow({
        slug: 'btc-updown-5m-400d',
        timeframe: '5m',
        conditionId: null,
        upTokenId: null,
        downTokenId: null,
        resolutionSource: 'chainlink-twap-60s',
        startTimeMs: day400Ms - 300_000,
        endTimeMs: day400Ms,
        openTwap: 60_000,
        closeTwap: 59_900,
        resolvedUp: false,
        tickSize: 0.01,
        negRisk: false,
        volumeUsd: 3_000,
        updatedAt: day400Ms,
      })
      await store.appendPredictionSnapshot({
        slug: 'btc-updown-5m-400d',
        capturedAtMs: day400Ms - 60_000,
        secondsRemaining: 60,
        twapPrice: 59_950,
        binancePrice: 59_955,
        sigma1m: 0.001,
        basisBps: -0.8,
        yesBid: 0.3,
        yesAsk: 0.32,
        yesDepthUsd: 250,
        noBid: 0.68,
        noAsk: 0.7,
        noDepthUsd: 250,
        pModelYes: 0.29,
      })
      await store.upsertPredictionTrade({
        id: 'pt-400d-settled',
        tenantId: 'default',
        strategyId: 'c5-late-favorite',
        lane: 'high-hit-rate',
        mode: 'paper',
        slug: 'btc-updown-5m-400d',
        timeframe: '5m',
        outcome: 'NO',
        liquidityRole: 'taker',
        entryTimeMs: day400Ms - 30_000,
        entryPrice: 0.7,
        feeUsd: 0.04,
        stakeUsd: 5,
        shares: 7.14,
        pModel: 0.72,
        pCalibrated: 0.71,
        markout30s: 0.01,
        resolvedUp: false,
        won: true,
        netPnlUsd: 2.0,
        venueOrderId: null,
        status: 'SETTLED',
      })
      await store.upsertPredictionTrade({
        id: 'pt-400d-open',
        tenantId: 'default',
        strategyId: 'c5-late-favorite',
        lane: 'high-hit-rate',
        mode: 'canary',
        slug: 'btc-updown-5m-400d',
        timeframe: '5m',
        outcome: 'NO',
        liquidityRole: 'maker',
        entryTimeMs: day400Ms - 30_000,
        entryPrice: 0.68,
        feeUsd: 0,
        stakeUsd: 5,
        shares: 7.35,
        pModel: 0.72,
        pCalibrated: 0.71,
        markout30s: null,
        resolvedUp: null,
        won: null,
        netPnlUsd: null,
        venueOrderId: 'ord-open-400d',
        status: 'OPEN',
      })

      const prune = await store.pruneRetention(90, nowMs)
      expect(prune.windowRetentionDays).toBe(365)
      expect(prune.deletedPredictionWindows).toBe(1)
      expect(prune.deletedPredictionSnapshots).toBe(1)
      expect(prune.deletedPredictionTrades).toBe(1)

      // 120-day data survived
      expect(
        await store.getPredictionWindows({ slug: 'btc-updown-5m-120d' }),
      ).toHaveLength(1)
      expect(
        await store.getPredictionSnapshots('btc-updown-5m-120d'),
      ).toHaveLength(1)
      expect(
        (await store.getPredictionTrades('default')).map((t) => t.id),
      ).toContain('pt-120d')

      // 400-day OPEN trade survived while 400-day SETTLED trade was pruned
      const remainingIds = (await store.getPredictionTrades('default')).map(
        (t) => t.id,
      )
      expect(remainingIds).toContain('pt-400d-open')
      expect(remainingIds).not.toContain('pt-400d-settled')
    } finally {
      await store.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('executes v3 parameterized queries and null-safe row mapping in PostgresStateStore', async () => {
    const queries: { text: string; params?: readonly unknown[] }[] = []
    const nowMs = 1_760_000_000_000

    const mockPool: PgPoolLike = {
      async query(text, params) {
        const trimmed = text.trim()
        queries.push({ text: trimmed, params })
        if (trimmed.startsWith('DELETE FROM')) {
          return { rows: [], rowCount: 2 }
        }
        if (trimmed.includes('SELECT COUNT(*) AS cnt FROM prediction_windows')) {
          return { rows: [{ cnt: '42' }] as never[] }
        }
        if (trimmed.startsWith('SELECT * FROM prediction_windows')) {
          return {
            rows: [
              {
                slug: 'btc-updown-15m-1',
                timeframe: '15m',
                condition_id: null,
                up_token_id: 'up-15',
                down_token_id: 'down-15',
                resolution_source: 'chainlink-twap-60s',
                start_time_ms: String(nowMs - 900_000),
                end_time_ms: String(nowMs),
                open_twap: null,
                close_twap: 91_200,
                resolved_up: true,
                tick_size: 0.01,
                neg_risk: false,
                volume_usd: null,
                updated_at: String(nowMs),
              },
            ] as never[],
          }
        }
        if (text.includes('FROM prediction_window_snapshots')) {
          return {
            rows: [
              {
                slug: 'btc-updown-15m-1',
                captured_at_ms: String(nowMs - 30_000),
                seconds_remaining: 30,
                twap_price: null,
                binance_price: 91_190,
                sigma_1m: 0.0011,
                basis_bps: null,
                yes_bid: 0.61,
                yes_ask: 0.63,
                yes_depth_usd: 500,
                no_bid: null,
                no_ask: null,
                no_depth_usd: null,
                p_model_yes: null,
              },
            ] as never[],
          }
        }
        if (text.includes('FROM prediction_shadow_trades')) {
          return {
            rows: [
              {
                id: 'pg-t1',
                tenant_id: 'default',
                strategy_id: 'c15-favorite-carry',
                lane: 'high-hit-rate',
                mode: 'paper',
                slug: 'btc-updown-15m-1',
                timeframe: '15m',
                outcome: 'YES',
                liquidity_role: 'taker',
                entry_time_ms: String(nowMs - 30_000),
                entry_price: 0.63,
                fee_usd: 0.05,
                stake_usd: 5,
                shares: 7.93,
                p_model: 0.75,
                p_calibrated: 0.72,
                markout_30s: null,
                resolved_up: null,
                won: null,
                net_pnl_usd: null,
                venue_order_id: null,
                status: 'OPEN',
              },
            ] as never[],
          }
        }
        if (text.includes('FROM prediction_strategy_states')) {
          return {
            rows: [
              {
                tenant_id: 'default',
                strategy_id: 'cx-nested-coherence',
                mode: 'research',
                halted_reason: null,
                updated_at: String(nowMs),
              },
            ] as never[],
          }
        }
        return { rows: [], rowCount: 1 }
      },
    }

    const pgStore = new PostgresStateStore(mockPool, 'postgres://v3-test')

    await pgStore.upsertPredictionWindow({
      slug: 'btc-updown-15m-1',
      timeframe: '15m',
      conditionId: null,
      upTokenId: 'up-15',
      downTokenId: 'down-15',
      resolutionSource: 'chainlink-twap-60s',
      startTimeMs: nowMs - 900_000,
      endTimeMs: nowMs,
      openTwap: null,
      closeTwap: 91_200,
      resolvedUp: true,
      tickSize: 0.01,
      negRisk: false,
      volumeUsd: null,
      updatedAt: nowMs,
    })
    const windows = await pgStore.getPredictionWindows({
      timeframe: '15m',
      settledOnly: true,
      order: 'asc',
      limit: 500,
    })
    expect(windows).toHaveLength(1)
    expect(windows[0].openTwap).toBeNull()
    expect(windows[0].closeTwap).toBe(91_200)
    expect(windows[0].resolvedUp).toBe(true)
    expect(await pgStore.getSettledWindowCount('15m')).toBe(42)

    await pgStore.appendPredictionSnapshot({
      slug: 'btc-updown-15m-1',
      capturedAtMs: nowMs - 30_000,
      secondsRemaining: 30,
      twapPrice: null,
      binancePrice: 91_190,
      sigma1m: 0.0011,
      basisBps: null,
      yesBid: 0.61,
      yesAsk: 0.63,
      yesDepthUsd: 500,
      noBid: null,
      noAsk: null,
      noDepthUsd: null,
      pModelYes: null,
    })
    const snaps = await pgStore.getPredictionSnapshots('btc-updown-15m-1')
    expect(snaps[0].twapPrice).toBeNull()
    expect(snaps[0].noBid).toBeNull()
    expect(snaps[0].yesAsk).toBe(0.63)

    await pgStore.upsertPredictionTrade({
      id: 'pg-t1',
      tenantId: 'default',
      strategyId: 'c15-favorite-carry',
      lane: 'high-hit-rate',
      mode: 'paper',
      slug: 'btc-updown-15m-1',
      timeframe: '15m',
      outcome: 'YES',
      liquidityRole: 'taker',
      entryTimeMs: nowMs - 30_000,
      entryPrice: 0.63,
      feeUsd: 0.05,
      stakeUsd: 5,
      shares: 7.93,
      pModel: 0.75,
      pCalibrated: 0.72,
      markout30s: null,
      resolvedUp: null,
      won: null,
      netPnlUsd: null,
      venueOrderId: null,
      status: 'OPEN',
    })
    const trades = await pgStore.getPredictionTrades('default', {
      status: 'OPEN',
    })
    expect(trades[0].markout30s).toBeNull()
    expect(trades[0].won).toBeNull()

    await pgStore.setStrategyModeState({
      tenantId: 'default',
      strategyId: 'cx-nested-coherence',
      mode: 'research',
      haltedReason: null,
      updatedAt: nowMs,
    })
    const states = await pgStore.getStrategyModeStates('default')
    expect(states[0].mode).toBe('research')
    expect(states[0].haltedReason).toBeNull()

    const report = await pgStore.pruneRetention(90, nowMs)
    expect(report.windowRetentionDays).toBe(365)
    expect(report.deletedPredictionWindows).toBe(2)
    const delWinQuery = queries.find((q) =>
      q.text.startsWith('DELETE FROM prediction_windows'),
    )
    expect(delWinQuery?.params?.[0]).toBe(nowMs - 365 * 86_400_000)

    // limit: Number.NaN falls back to default (2_000 / 200) in PostgresStateStore
    queries.length = 0
    await pgStore.getPredictionWindows({ limit: Number.NaN })
    const pgWinQuery = queries.find((q) =>
      q.text.startsWith('SELECT * FROM prediction_windows'),
    )
    expect(pgWinQuery?.params?.at(-1)).toBe(2_000)

    queries.length = 0
    await pgStore.getPredictionTrades('default', { limit: Number.NaN })
    const pgTradeQuery = queries.find((q) =>
      q.text.startsWith('SELECT * FROM prediction_shadow_trades'),
    )
    expect(pgTradeQuery?.params?.at(-1)).toBe(200)
  })

  it('enforces exact 89d/91d/364d/365d/366d retention boundaries, CANCELED trade pruning, sinceMs/untilMs filters, and limit: NaN fallback in SqliteStateStore', async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'flare-sqlite-boundaries-'),
    )
    const dbPath = path.join(tmpDir, 'flare-boundaries.db')
    const store = new SqliteStateStore(dbPath)
    const nowMs = 1_760_000_000_000
    const DAY_MS = 86_400_000

    try {
      await store.migrate()

      // Core 90-day boundaries: 89d survives, 91d pruned
      for (const daysAgo of [89, 91]) {
        const tsMs = nowMs - daysAgo * DAY_MS
        const tsIso = new Date(tsMs).toISOString()
        await store.appendOrder('acme', {
          id: `ORD-${daysAgo}d`,
          clientOrderId: `cid-${daysAgo}d`,
          timestamp: tsIso,
          pair: 'BTC/USDT',
          side: 'BUY',
          notionalUsd: 100,
          price: 80_000,
          quantity: 0.00125,
          status: 'FILLED',
          mode: 'demo-vault',
          source: 'manual',
        })
        await store.appendAuditEvent({
          id: `AUD-${daysAgo}d`,
          tenantId: 'acme',
          timestamp: tsIso,
          actor: 'admin',
          role: 'admin',
          action: 'bot:tick',
          resource: '/api/bot/tick',
          outcome: 'allowed',
        })
        await store.upsertCandles('BTC/USDT', '5m', [
          {
            time: tsMs,
            open: 80_000,
            high: 80_100,
            low: 79_900,
            close: 80_050,
            volume: 10,
          },
        ])
      }

      // Prediction 365-day boundaries: 89d, 91d, 364d, 365d survive; 366d pruned
      for (const daysAgo of [89, 91, 364, 365, 366]) {
        const endMs = nowMs - daysAgo * DAY_MS
        const startMs = endMs - 300_000
        const slug = `btc-updown-5m-${daysAgo}d`
        await store.upsertPredictionWindow({
          slug,
          timeframe: '5m',
          conditionId: null,
          upTokenId: null,
          downTokenId: null,
          resolutionSource: 'chainlink-twap-60s',
          startTimeMs: startMs,
          endTimeMs: endMs,
          openTwap: 80_000,
          closeTwap: 80_010,
          resolvedUp: true,
          tickSize: 0.01,
          negRisk: false,
          volumeUsd: 1_000,
          updatedAt: endMs,
        })
        await store.appendPredictionSnapshot({
          slug,
          capturedAtMs: endMs,
          secondsRemaining: 0,
          twapPrice: 80_005,
          binancePrice: 80_006,
          sigma1m: 0.001,
          basisBps: 0,
          yesBid: 0.5,
          yesAsk: 0.52,
          yesDepthUsd: 300,
          noBid: 0.48,
          noAsk: 0.5,
          noDepthUsd: 300,
          pModelYes: 0.51,
        })
        await store.upsertPredictionTrade({
          id: `tr-canceled-${daysAgo}d`,
          tenantId: 'default',
          strategyId: 'c5-late-favorite',
          lane: 'high-hit-rate',
          mode: 'paper',
          slug,
          timeframe: '5m',
          outcome: 'YES',
          liquidityRole: 'maker',
          entryTimeMs: endMs,
          entryPrice: 0.52,
          feeUsd: 0,
          stakeUsd: 5,
          shares: 9.61,
          pModel: 0.55,
          pCalibrated: 0.54,
          markout30s: 0,
          resolvedUp: false,
          won: false,
          netPnlUsd: 0,
          venueOrderId: null,
          status: 'CANCELED',
        })
      }

      // 366d OPEN trade must survive retention
      await store.upsertPredictionTrade({
        id: 'tr-open-366d',
        tenantId: 'default',
        strategyId: 'c5-late-favorite',
        lane: 'high-hit-rate',
        mode: 'canary',
        slug: 'btc-updown-5m-366d',
        timeframe: '5m',
        outcome: 'NO',
        liquidityRole: 'maker',
        entryTimeMs: nowMs - 366 * DAY_MS,
        entryPrice: 0.48,
        feeUsd: 0,
        stakeUsd: 5,
        shares: 10.41,
        pModel: 0.6,
        pCalibrated: 0.58,
        markout30s: null,
        resolvedUp: null,
        won: null,
        netPnlUsd: null,
        venueOrderId: 'ord-open-366d',
        status: 'OPEN',
      })

      const prune = await store.pruneRetention(90, nowMs)
      expect(prune.deletedOrders).toBe(1)
      expect(prune.deletedAuditEvents).toBe(1)
      expect(prune.deletedCandles).toBe(1)
      expect(prune.deletedPredictionWindows).toBe(1)
      expect(prune.deletedPredictionSnapshots).toBe(1)
      expect(prune.deletedPredictionTrades).toBe(1)

      expect((await store.getOrders('acme')).map((o) => o.id)).toEqual([
        'ORD-89d',
      ])
      expect((await store.getAuditEvents('acme')).map((a) => a.id)).toEqual([
        'AUD-89d',
      ])
      expect(await store.getCandles('BTC/USDT', '5m', 10)).toHaveLength(1)

      const remainingWindows = await store.getPredictionWindows({
        order: 'asc',
      })
      expect(remainingWindows.map((w) => w.slug)).toEqual([
        'btc-updown-5m-365d',
        'btc-updown-5m-364d',
        'btc-updown-5m-91d',
        'btc-updown-5m-89d',
      ])
      expect(
        await store.getPredictionSnapshots('btc-updown-5m-365d'),
      ).toHaveLength(1)
      expect(
        await store.getPredictionSnapshots('btc-updown-5m-366d'),
      ).toHaveLength(0)

      const remainingTrades = await store.getPredictionTrades('default')
      const remainingTradeIds = remainingTrades.map((t) => t.id)
      expect(remainingTradeIds).toContain('tr-open-366d')
      expect(remainingTradeIds).toContain('tr-canceled-365d')
      expect(remainingTradeIds).not.toContain('tr-canceled-366d')

      // sinceMs / untilMs inclusive filters on startTimeMs
      const start364 = nowMs - 364 * DAY_MS - 300_000
      const start91 = nowMs - 91 * DAY_MS - 300_000
      const filteredWindows = await store.getPredictionWindows({
        sinceMs: start364,
        untilMs: start91,
        order: 'asc',
      })
      expect(filteredWindows.map((w) => w.slug)).toEqual([
        'btc-updown-5m-364d',
        'btc-updown-5m-91d',
      ])

      // limit: Number.NaN falls back safely without throwing SQLite datatype mismatch
      const nanLimitedWindows = await store.getPredictionWindows({
        limit: Number.NaN,
      })
      expect(nanLimitedWindows).toHaveLength(4)

      const nanLimitedTrades = await store.getPredictionTrades('default', {
        limit: Number.NaN,
      })
      expect(nanLimitedTrades).toHaveLength(5)
    } finally {
      await store.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('persists v4 runtime_events, strategy_audits, and filtered order queries in SqliteStateStore', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-sqlite-v4-'))
    const dbPath = path.join(tmpDir, 'flare-v4.db')
    const store = new SqliteStateStore(dbPath)
    try {
      expect(await store.getSchemaVersion()).toBe(6)

      await store.appendRuntimeEvent({
        id: 'EVT-1',
        tenantId: 'default',
        timestamp: '2026-11-22T10:00:00.000Z',
        type: 'TRADE',
        severity: 'info',
        message: '[FILL] BUY BTC/USDT $100.00',
        source: 'paper',
        correlationId: 'ORD-1001',
        payload: { orderId: 'ORD-1001' },
      })
      await store.appendRuntimeEvent({
        id: 'EVT-2',
        tenantId: 'default',
        timestamp: '2026-11-22T10:01:00.000Z',
        type: 'RISK',
        severity: 'warn',
        message: '[RISK] Rejected over hard cap',
        source: 'paper',
        correlationId: 'ORD-1002',
      })

      const tradeOnly = await store.getRuntimeEvents('default', {
        types: ['TRADE'],
      })
      expect(tradeOnly).toHaveLength(1)
      expect(tradeOnly[0].correlationId).toBe('ORD-1001')

      const searched = await store.getRuntimeEvents('default', {
        q: 'hard cap',
      })
      expect(searched).toHaveLength(1)
      expect(searched[0].id).toBe('EVT-2')

      await store.appendStrategyAudit({
        id: 'SAUD-1',
        tenantId: 'default',
        runId: 'RUN-1',
        createdAt: '2026-11-22T10:02:00.000Z',
        presetId: 'btc-intraday-trend-15m',
        presetName: 'BTC Intraday',
        domain: 'crypto-spot',
        pair: 'BTC/USDT',
        timeframe: '15m',
        fromTimeMs: 1_700_000_000_000,
        toTimeMs: 1_700_450_000_000,
        candles: 500,
        metrics: {
          totalOperations: 12,
          wins: 8,
          losses: 4,
          winRatePct: 66.7,
          wilsonLowerBoundPct: 39.1,
          netPnlUsd: 245.5,
          returnPct: 2.45,
          profitFactor: 1.9,
          maxDrawdownPct: 1.8,
        },
        assumptions: {
          commissionPct: 0.05,
          slippagePct: 0.02,
          initialBalance: 10_000,
          allowShort: false,
        },
        dataSource: 'binance',
      })

      const audits = await store.getLatestStrategyAudits('default', 10)
      expect(audits).toHaveLength(1)
      expect(audits[0].presetId).toBe('btc-intraday-trend-15m')
      expect(audits[0].assumptions.commissionPct).toBe(0.05)
    } finally {
      await store.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('persists v5 training_runs, idempotent client_run_id, interrupted reconciliation, orders.preset_id, and getCandlesRange in SqliteStateStore', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-sqlite-v5-'))
    const dbPath = path.join(tmpDir, 'flare-v5.db')
    const store = new SqliteStateStore(dbPath)
    try {
      expect(await store.getSchemaVersion()).toBe(6)

      await store.upsertCandles('BTC/USDT', '15m', [
        { time: 1_700_000_000_000, open: 100, high: 105, low: 98, close: 102, volume: 10 },
        { time: 1_700_000_900_000, open: 102, high: 108, low: 101, close: 106, volume: 12 },
        { time: 1_700_001_800_000, open: 106, high: 110, low: 104, close: 109, volume: 15 },
      ])
      const range = await store.getCandlesRange(
        'BTC/USDT',
        '15m',
        1_700_000_000_000,
        1_700_000_900_000,
      )
      expect(range).toHaveLength(2)
      expect(range[0].time).toBe(1_700_000_000_000)
      expect(range[1].time).toBe(1_700_000_900_000)

      await store.appendOrder('default', {
        id: 'ORD-PRESET-1',
        timestamp: '2026-11-22T12:00:00.000Z',
        pair: 'BTC/USDT',
        side: 'BUY',
        notionalUsd: 100,
        price: 60_000,
        quantity: 0.00166,
        status: 'FILLED',
        mode: 'binance-testnet',
        source: 'bot-auto',
        presetId: 'btc-donchian-breakout-1h',
      })
      await store.appendOrder('default', {
        id: 'ORD-MANUAL-1',
        timestamp: '2026-11-22T12:01:00.000Z',
        pair: 'BTC/USDT',
        side: 'BUY',
        notionalUsd: 100,
        price: 60_000,
        quantity: 0.00166,
        status: 'FILLED',
        mode: 'binance-testnet',
        source: 'manual',
      })

      const attributed = await store.queryOrders('default', {
        presetId: 'btc-donchian-breakout-1h',
        mode: 'binance-testnet',
      })
      expect(attributed).toHaveLength(1)
      expect(attributed[0].id).toBe('ORD-PRESET-1')
      expect(attributed[0].presetId).toBe('btc-donchian-breakout-1h')

      const baseRun = {
        id: 'TRN-1',
        tenantId: 'default',
        clientRunId: 'cid-run-1',
        kind: 'walk-forward' as const,
        presetId: 'btc-donchian-breakout-1h',
        strategyFamily: 'donchian-breakout' as const,
        pair: 'BTC/USDT',
        timeframe: '1h' as const,
        fromTimeMs: 1_700_000_000_000,
        toTimeMs: 1_701_000_000_000,
        candleCount: 300,
        status: 'running' as const,
        config: {
          kind: 'walk-forward' as const,
          presetId: 'btc-donchian-breakout-1h',
          pair: 'BTC/USDT',
          timeframe: '1h' as const,
          fromTimeMs: 1_700_000_000_000,
          toTimeMs: 1_701_000_000_000,
          foldCount: 5,
          foldMode: 'anchored' as const,
          trainRatio: 0.55,
          valRatio: 0.2,
          testRatio: 0.25,
          purgeGapBars: 5,
          assumptions: {
            commissionPct: 0.05,
            slippagePct: 0.02,
            initialBalance: 10_000,
            allowShort: true,
          },
        },
        progress: null,
        metrics: null,
        folds: null,
        equity: null,
        trades: null,
        assumptions: {
          commissionPct: 0.05,
          slippagePct: 0.02,
          initialBalance: 10_000,
          allowShort: true,
        },
        dataSource: 'binance',
        error: null,
        createdAt: '2026-11-22T12:00:00.000Z',
        completedAt: null,
      }

      const r1 = await store.createTrainingRun(baseRun)
      expect(r1.deduplicated).toBe(false)
      const r2 = await store.createTrainingRun({ ...baseRun, id: 'TRN-2' })
      expect(r2.deduplicated).toBe(true)
      expect(r2.record.id).toBe('TRN-1')

      const interrupted = await store.markRunningTrainingRunsInterrupted('default')
      expect(interrupted).toBe(1)
      const fetched = await store.getTrainingRunById('default', 'TRN-1')
      expect(fetched?.status).toBe('interrupted')
    } finally {
      await store.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
