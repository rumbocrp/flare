/**
 * Continuous Polymarket BTC Up/Down (5m / 15m / 1h) Window Collector.
 *
 * Discovers open & recently closed windows via `fetchPolymarketUpDown`, pins
 * `S0` (`openTwap`) and settlement `closeTwap` from `OracleFeedService`, and
 * records intrawindow snapshots combining Chainlink TWAP, Binance spot/vol,
 * live CLOB YES/NO top-5 books, and unblended diffusion `pModelYes` every 10s
 * (or every 2s in the final 180s).
 *
 * Zero synthetic fallback data: missing or stale upstream feeds persist `null`.
 */
import { computeNowcast } from '../../prediction/nowcast'
import {
  fetchPolymarketUpDown,
  type PolymarketSnapshot,
  type PolymarketTimeframe,
  type PolymarketWindow,
} from '../polymarketAdapter'
import type {
  CollectedWindowRecord,
  StateStore,
  WindowSnapshotPoint,
} from '../store/types'
import {
  ClobBookFeedService,
  DEFAULT_BOOK_STALE_MS,
  isBookSideStale,
} from './clobBookFeed'
import type {
  FetchLike,
  OracleFeedService,
  OracleSnapshot,
} from './oracleFeed'

export type FetchPolymarketUpDownFn = (
  tf: PolymarketTimeframe,
  limit: number,
  options?: { fetchImpl?: FetchLike; nowMs?: number },
) => Promise<PolymarketSnapshot>

export type CollectorStats = {
  running: boolean
  settledCountsByTimeframe: Record<PolymarketTimeframe, number>
  activeSlugs: string[]
  lastCaptureAtMs: number | null
  lastPollAtMs: number | null
  errorCount: number
  lastError: string | null
}

export type WindowCollectorOptions = {
  store: StateStore
  oracleFeed: OracleFeedService
  clobBookFeed: ClobBookFeedService
  fetchPolymarketUpDown?: FetchPolymarketUpDownFn
  fetchImpl?: FetchLike
  nowMs?: () => number
  timeframes?: readonly PolymarketTimeframe[]
  discoveryLimit?: number
  pollIntervalMs?: number
  discoveryIntervalMs?: number
  normalSnapshotIntervalMs?: number
  finalPhaseThresholdSec?: number
  finalSnapshotIntervalMs?: number
  hydrateCooldownMs?: number
  bookStaleMs?: number
  openTwapMaxAgeMs?: number
  computePModelYes?: (input: {
    window: PolymarketWindow
    oracle: OracleSnapshot
    openTwap: number | null
    secondsRemaining: number
  }) => number | null
  onError?: (context: string, err: unknown) => void
}

const DEFAULT_TIMEFRAMES: readonly PolymarketTimeframe[] = ['5m', '15m', '1h']
const DEFAULT_DISCOVERY_LIMIT = 6
const DEFAULT_POLL_INTERVAL_MS = 2_000
const DEFAULT_DISCOVERY_INTERVAL_MS = 10_000
const DEFAULT_NORMAL_SNAPSHOT_INTERVAL_MS = 10_000
const DEFAULT_FINAL_PHASE_THRESHOLD_SEC = 180
const DEFAULT_FINAL_SNAPSHOT_INTERVAL_MS = 2_000
const DEFAULT_HYDRATE_COOLDOWN_MS = 5_000
const DEFAULT_OPEN_TWAP_MAX_AGE_MS = 15_000
const MAX_TRACKED_RECORDS = 300
const PENDING_FAST_DISCOVERY_MS = 15 * 60_000

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class PredictionWindowCollector {
  private readonly store: StateStore
  private readonly oracleFeed: OracleFeedService
  private readonly clobBookFeed: ClobBookFeedService
  private readonly fetchDiscovery: FetchPolymarketUpDownFn
  private readonly fetchImpl: FetchLike | undefined
  private readonly nowMs: () => number
  private readonly timeframes: readonly PolymarketTimeframe[]
  private readonly discoveryLimit: number
  private readonly pollIntervalMs: number
  private readonly discoveryIntervalMs: number
  private readonly normalSnapshotIntervalMs: number
  private readonly finalPhaseThresholdSec: number
  private readonly finalSnapshotIntervalMs: number
  private readonly hydrateCooldownMs: number
  private readonly bookStaleMs: number
  private readonly openTwapMaxAgeMs: number
  private readonly customComputePModelYes:
    | WindowCollectorOptions['computePModelYes']
    | undefined
  private readonly onError: ((context: string, err: unknown) => void) | undefined

  private running = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private pollInFlight: Promise<CollectorStats> | null = null
  private hydratedFromStore = false
  private lastDiscoveryAtMs: number | null = null
  private lastPollAtMs: number | null = null
  private lastCaptureAtMs: number | null = null
  private errorCount = 0
  private lastError: string | null = null
  private settledCountsByTimeframe: Record<PolymarketTimeframe, number> = {
    '5m': 0,
    '15m': 0,
    '1h': 0,
  }

  private readonly trackedRecords = new Map<string, CollectedWindowRecord>()
  private readonly openWindows = new Map<string, PolymarketWindow>()
  private readonly pendingSettlementEndMs = new Map<string, number>()
  private readonly lastSnapshotAtBySlug = new Map<string, number>()
  private readonly lastHydrateAtBySlug = new Map<string, number>()

  constructor(options: WindowCollectorOptions) {
    this.store = options.store
    this.oracleFeed = options.oracleFeed
    this.clobBookFeed = options.clobBookFeed
    this.fetchDiscovery = options.fetchPolymarketUpDown ?? fetchPolymarketUpDown
    this.fetchImpl = options.fetchImpl
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.timeframes = options.timeframes ?? DEFAULT_TIMEFRAMES
    this.discoveryLimit = Math.max(
      1,
      Math.round(options.discoveryLimit ?? DEFAULT_DISCOVERY_LIMIT),
    )
    this.pollIntervalMs = Math.max(
      100,
      Math.round(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
    )
    this.discoveryIntervalMs = Math.max(
      500,
      Math.round(options.discoveryIntervalMs ?? DEFAULT_DISCOVERY_INTERVAL_MS),
    )
    this.normalSnapshotIntervalMs = Math.max(
      500,
      Math.round(
        options.normalSnapshotIntervalMs ?? DEFAULT_NORMAL_SNAPSHOT_INTERVAL_MS,
      ),
    )
    this.finalPhaseThresholdSec = Math.max(
      0,
      options.finalPhaseThresholdSec ?? DEFAULT_FINAL_PHASE_THRESHOLD_SEC,
    )
    this.finalSnapshotIntervalMs = Math.max(
      250,
      Math.round(
        options.finalSnapshotIntervalMs ?? DEFAULT_FINAL_SNAPSHOT_INTERVAL_MS,
      ),
    )
    this.hydrateCooldownMs = Math.max(
      250,
      Math.round(options.hydrateCooldownMs ?? DEFAULT_HYDRATE_COOLDOWN_MS),
    )
    this.bookStaleMs = Math.max(
      500,
      Math.round(options.bookStaleMs ?? DEFAULT_BOOK_STALE_MS),
    )
    this.openTwapMaxAgeMs = Math.max(
      1_000,
      Math.round(options.openTwapMaxAgeMs ?? DEFAULT_OPEN_TWAP_MAX_AGE_MS),
    )
    this.customComputePModelYes = options.computePModelYes
    this.onError = options.onError
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.pollTimer = setInterval(() => {
      if (this.running) {
        void this.runPollCycle()
      }
    }, this.pollIntervalMs)
    this.pollTimer.unref?.()
    void this.runPollCycle()
  }

  stop(): void {
    this.running = false
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  isRunning(): boolean {
    return this.running
  }

  getCollectorStats(): CollectorStats {
    const now = this.nowMs()
    const activeSlugs = Array.from(this.openWindows.values())
      .filter((w) => w.endTime > now)
      .map((w) => w.slug)
      .sort()
    return {
      running: this.running,
      settledCountsByTimeframe: { ...this.settledCountsByTimeframe },
      activeSlugs,
      lastCaptureAtMs: this.lastCaptureAtMs,
      lastPollAtMs: this.lastPollAtMs,
      errorCount: this.errorCount,
      lastError: this.lastError,
    }
  }

  getTrackedWindows(): CollectedWindowRecord[] {
    return Array.from(this.trackedRecords.values(), (rec) => ({ ...rec }))
  }

  getActiveWindows(nowMs = this.nowMs()): PolymarketWindow[] {
    const active: PolymarketWindow[] = []
    for (const win of this.openWindows.values()) {
      if (win.startTime <= nowMs && nowMs < win.endTime) {
        active.push({ ...win })
      }
    }
    return active
  }

  async runPollCycle(
    nowMs = this.nowMs(),
    options: { forceDiscovery?: boolean } = {},
  ): Promise<CollectorStats> {
    if (this.pollInFlight) {
      return this.pollInFlight
    }
    this.pollInFlight = this.executePollCycle(
      nowMs,
      options.forceDiscovery ?? false,
    ).finally(() => {
      this.pollInFlight = null
    })
    return this.pollInFlight
  }

  private recordError(context: string, err: unknown): void {
    this.errorCount += 1
    this.lastError = `${context}: ${toErrorMessage(err)}`
    this.onError?.(context, err)
  }

  private async refreshSettledCounts(): Promise<void> {
    const [c5m, c15m, c1h] = await Promise.all([
      this.store.getSettledWindowCount('5m'),
      this.store.getSettledWindowCount('15m'),
      this.store.getSettledWindowCount('1h'),
    ])
    this.settledCountsByTimeframe = {
      '5m': c5m,
      '15m': c15m,
      '1h': c1h,
    }
  }

  private async hydrateFromStore(nowMs: number): Promise<void> {
    try {
      await this.refreshSettledCounts()
      const recent = await this.store.getPredictionWindows({
        order: 'desc',
        limit: 200,
      })
      for (const rec of recent) {
        if (!this.trackedRecords.has(rec.slug)) {
          this.trackedRecords.set(rec.slug, rec)
        }
        if (
          rec.resolvedUp === null &&
          rec.endTimeMs <= nowMs &&
          nowMs - rec.endTimeMs <= PENDING_FAST_DISCOVERY_MS
        ) {
          this.pendingSettlementEndMs.set(rec.slug, rec.endTimeMs)
        }
      }
      this.hydratedFromStore = true
    } catch (err) {
      this.recordError('hydrateFromStore', err)
    }
  }

  private hasExpiredOpenOrPendingWindows(nowMs: number): boolean {
    for (const win of this.openWindows.values()) {
      if (win.endTime <= nowMs) return true
    }
    for (const [slug, endMs] of this.pendingSettlementEndMs.entries()) {
      if (nowMs - endMs > PENDING_FAST_DISCOVERY_MS) {
        this.pendingSettlementEndMs.delete(slug)
        this.lastSnapshotAtBySlug.delete(slug)
        this.lastHydrateAtBySlug.delete(slug)
        continue
      }
      if (endMs <= nowMs) return true
    }
    return false
  }

  private missingActiveTimeframe(nowMs: number): boolean {
    for (const tf of this.timeframes) {
      let hasOpen = false
      for (const win of this.openWindows.values()) {
        if (
          win.timeframe === tf &&
          win.startTime <= nowMs &&
          nowMs < win.endTime
        ) {
          hasOpen = true
          break
        }
      }
      if (!hasOpen) return true
    }
    return false
  }

  private pruneTrackedRecords(): void {
    for (const slug of this.lastSnapshotAtBySlug.keys()) {
      if (!this.openWindows.has(slug)) {
        this.lastSnapshotAtBySlug.delete(slug)
      }
    }
    for (const slug of this.lastHydrateAtBySlug.keys()) {
      if (!this.openWindows.has(slug)) {
        this.lastHydrateAtBySlug.delete(slug)
      }
    }
    if (this.trackedRecords.size <= MAX_TRACKED_RECORDS) return
    const candidates = Array.from(this.trackedRecords.values())
      .filter((r) => r.resolvedUp !== null && !this.openWindows.has(r.slug))
      .sort((a, b) => a.endTimeMs - b.endTimeMs)
    for (const rec of candidates) {
      if (this.trackedRecords.size <= MAX_TRACKED_RECORDS) break
      this.trackedRecords.delete(rec.slug)
      this.pendingSettlementEndMs.delete(rec.slug)
      this.lastSnapshotAtBySlug.delete(rec.slug)
      this.lastHydrateAtBySlug.delete(rec.slug)
    }
  }

  private async runDiscovery(nowMs: number): Promise<void> {
    this.lastDiscoveryAtMs = nowMs
    let newlySettled = false

    for (const tf of this.timeframes) {
      let snap: PolymarketSnapshot
      try {
        snap = await this.fetchDiscovery(tf, this.discoveryLimit, {
          fetchImpl: this.fetchImpl,
          nowMs,
        })
      } catch (err) {
        this.recordError(`discovery:${tf}`, err)
        continue
      }

      if (snap.errors.length > 0) {
        this.errorCount += snap.errors.length
        this.lastError = `discovery:${tf}: ${snap.errors[snap.errors.length - 1]}`
      }

      for (const win of snap.windows) {
        if (win.status === 'missing') continue

        const existing = this.trackedRecords.get(win.slug)
        if (
          existing &&
          existing.resolvedUp !== null &&
          existing.closeTwap !== null
        ) {
          this.openWindows.delete(win.slug)
          this.pendingSettlementEndMs.delete(win.slug)
          this.lastSnapshotAtBySlug.delete(win.slug)
          this.lastHydrateAtBySlug.delete(win.slug)
          continue
        }

        let openTwap = existing?.openTwap ?? null
        if (openTwap === null && win.startTime <= nowMs) {
          openTwap = this.oracleFeed.getWindowOpenTwap(
            win.startTime,
            this.openTwapMaxAgeMs,
          )
        }

        let resolvedUp: boolean | null
        let closeTwap: number | null

        if (win.status === 'closed' && win.resolvedUp !== null) {
          resolvedUp = win.resolvedUp
          closeTwap =
            existing?.closeTwap ??
            this.oracleFeed.getWindowOpenTwap(
              win.endTime,
              this.openTwapMaxAgeMs,
            )
          if (existing === undefined || existing.resolvedUp === null) {
            newlySettled = true
          }
          this.openWindows.delete(win.slug)
          this.pendingSettlementEndMs.delete(win.slug)
          this.lastSnapshotAtBySlug.delete(win.slug)
          this.lastHydrateAtBySlug.delete(win.slug)
        } else if (existing?.resolvedUp !== null && existing !== undefined) {
          resolvedUp = existing.resolvedUp
          closeTwap =
            existing.closeTwap ??
            this.oracleFeed.getWindowOpenTwap(
              win.endTime,
              this.openTwapMaxAgeMs,
            )
          this.openWindows.delete(win.slug)
          this.pendingSettlementEndMs.delete(win.slug)
          this.lastSnapshotAtBySlug.delete(win.slug)
          this.lastHydrateAtBySlug.delete(win.slug)
        } else if (win.status === 'open' && win.endTime > nowMs) {
          resolvedUp = null
          closeTwap = null
          this.openWindows.set(win.slug, win)
          this.pendingSettlementEndMs.delete(win.slug)
        } else {
          resolvedUp = existing?.resolvedUp ?? null
          closeTwap = existing?.closeTwap ?? null
          this.openWindows.delete(win.slug)
          this.lastSnapshotAtBySlug.delete(win.slug)
          this.lastHydrateAtBySlug.delete(win.slug)
          if (nowMs - win.endTime <= PENDING_FAST_DISCOVERY_MS) {
            this.pendingSettlementEndMs.set(win.slug, win.endTime)
          } else {
            this.pendingSettlementEndMs.delete(win.slug)
          }
        }

        const record: CollectedWindowRecord = {
          slug: win.slug,
          timeframe: win.timeframe,
          conditionId: win.conditionId ?? existing?.conditionId ?? null,
          upTokenId: win.upTokenId ?? existing?.upTokenId ?? null,
          downTokenId: win.downTokenId ?? existing?.downTokenId ?? null,
          resolutionSource:
            win.resolutionSource ?? existing?.resolutionSource ?? 'unknown',
          startTimeMs: win.startTime,
          endTimeMs: win.endTime,
          openTwap,
          closeTwap,
          resolvedUp,
          tickSize: win.tickSize ?? existing?.tickSize ?? null,
          negRisk: win.negRisk ?? existing?.negRisk ?? false,
          volumeUsd: Number.isFinite(win.volume)
            ? win.volume
            : (existing?.volumeUsd ?? null),
          updatedAt: nowMs,
        }

        const unchangedSettled =
          existing !== undefined &&
          existing.resolvedUp !== null &&
          existing.resolvedUp === record.resolvedUp &&
          existing.closeTwap === record.closeTwap

        if (unchangedSettled) {
          this.trackedRecords.set(win.slug, record)
          continue
        }

        try {
          await this.store.upsertPredictionWindow(record)
          this.trackedRecords.set(win.slug, record)
        } catch (err) {
          this.recordError(`upsertWindow:${win.slug}`, err)
        }
      }
    }

    // Sweep expired openWindows (e.g., Gamma returned status: 'missing' or omitted aged-out slugs)
    for (const [slug, win] of this.openWindows.entries()) {
      if (win.endTime <= nowMs) {
        this.openWindows.delete(slug)
        this.lastSnapshotAtBySlug.delete(slug)
        this.lastHydrateAtBySlug.delete(slug)
        const tracked = this.trackedRecords.get(slug)
        const isSettled = tracked !== undefined && tracked.resolvedUp !== null
        if (!isSettled && nowMs - win.endTime <= PENDING_FAST_DISCOVERY_MS) {
          this.pendingSettlementEndMs.set(slug, win.endTime)
        } else {
          this.pendingSettlementEndMs.delete(slug)
        }
      }
    }

    const activeOpen = Array.from(this.openWindows.values()).filter(
      (w) => w.endTime > nowMs,
    )
    if (activeOpen.length > 0) {
      this.clobBookFeed.subscribeWindows(activeOpen)
    }

    if (newlySettled) {
      try {
        await this.refreshSettledCounts()
      } catch (err) {
        this.recordError('refreshSettledCounts', err)
      }
    }

    this.pruneTrackedRecords()
  }

  private async captureSnapshots(nowMs: number): Promise<void> {
    const oracleSnap = this.oracleFeed.getSnapshot(nowMs)

    for (const win of this.openWindows.values()) {
      if (win.startTime > nowMs || win.endTime <= nowMs) continue

      const secondsRemaining = Math.max(0, (win.endTime - nowMs) / 1000)
      const intervalMs =
        secondsRemaining <= this.finalPhaseThresholdSec
          ? this.finalSnapshotIntervalMs
          : this.normalSnapshotIntervalMs

      const lastSnapAt = this.lastSnapshotAtBySlug.get(win.slug)
      if (
        lastSnapAt !== undefined &&
        (nowMs <= lastSnapAt || nowMs - lastSnapAt < intervalMs)
      ) {
        continue
      }

      let record = this.trackedRecords.get(win.slug)
      let openTwap = record?.openTwap ?? null
      if (openTwap === null && win.startTime <= nowMs) {
        const pinned = this.oracleFeed.getWindowOpenTwap(
          win.startTime,
          this.openTwapMaxAgeMs,
        )
        if (pinned !== null) {
          openTwap = pinned
          if (record) {
            const updatedRecord: CollectedWindowRecord = {
              ...record,
              openTwap: pinned,
              updatedAt: nowMs,
            }
            try {
              await this.store.upsertPredictionWindow(updatedRecord)
              this.trackedRecords.set(win.slug, updatedRecord)
              record = updatedRecord
            } catch (err) {
              this.recordError(`pinOpenTwap:${win.slug}`, err)
            }
          }
        }
      }

      let book = this.clobBookFeed.getWindowSnapshot(win)
      const yesStale = isBookSideStale(book.yes, nowMs, this.bookStaleMs)
      const noStale = isBookSideStale(book.no, nowMs, this.bookStaleMs)
      const needYesHydrate = yesStale && Boolean(win.upTokenId)
      const needNoHydrate = noStale && Boolean(win.downTokenId)

      if (needYesHydrate || needNoHydrate) {
        const lastHydrate = this.lastHydrateAtBySlug.get(win.slug)
        if (
          lastHydrate === undefined ||
          nowMs - lastHydrate >= this.hydrateCooldownMs
        ) {
          this.lastHydrateAtBySlug.set(win.slug, nowMs)
          try {
            const hydrateTasks: Promise<unknown>[] = []
            if (needYesHydrate && win.upTokenId) {
              hydrateTasks.push(this.clobBookFeed.hydrateToken(win.upTokenId))
            }
            if (needNoHydrate && win.downTokenId) {
              hydrateTasks.push(this.clobBookFeed.hydrateToken(win.downTokenId))
            }
            if (hydrateTasks.length > 0) {
              await Promise.all(hydrateTasks)
              book = this.clobBookFeed.getWindowSnapshot(win)
            }
          } catch (err) {
            this.recordError(`hydrateBook:${win.slug}`, err)
          }
        }
      }

      const yesFresh =
        book.yes !== null &&
        !isBookSideStale(book.yes, nowMs, this.bookStaleMs)
      const noFresh =
        book.no !== null && !isBookSideStale(book.no, nowMs, this.bookStaleMs)

      const yesBid = yesFresh && book.yes ? book.yes.bestBid : null
      const yesAsk = yesFresh && book.yes ? book.yes.bestAsk : null
      const yesDepthUsd = yesFresh && book.yes ? book.yes.top5DepthUsd : null
      const noBid = noFresh && book.no ? book.no.bestBid : null
      const noAsk = noFresh && book.no ? book.no.bestAsk : null
      const noDepthUsd = noFresh && book.no ? book.no.top5DepthUsd : null

      let pModelYes: number | null = null
      if (this.customComputePModelYes) {
        pModelYes = this.customComputePModelYes({
          window: win,
          oracle: oracleSnap,
          openTwap,
          secondsRemaining,
        })
      } else if (
        openTwap !== null &&
        oracleSnap.chainlinkTwap60s !== null &&
        oracleSnap.sigma1m !== null
      ) {
        const est = computeNowcast({
          openTwap,
          currentTwap: oracleSnap.chainlinkTwap60s,
          secondsRemaining,
          sigma1m: oracleSnap.sigma1m,
        })
        pModelYes = est.valid ? est.pRawYes : null
      }

      const snapshot: WindowSnapshotPoint = {
        slug: win.slug,
        capturedAtMs: nowMs,
        secondsRemaining,
        twapPrice: oracleSnap.chainlinkTwap60s,
        binancePrice: oracleSnap.binancePrice,
        sigma1m: oracleSnap.sigma1m,
        basisBps: oracleSnap.basisBps,
        yesBid,
        yesAsk,
        yesDepthUsd,
        noBid,
        noAsk,
        noDepthUsd,
        pModelYes,
      }

      try {
        await this.store.appendPredictionSnapshot(snapshot)
        this.lastSnapshotAtBySlug.set(win.slug, nowMs)
        this.lastCaptureAtMs = nowMs
      } catch (err) {
        this.recordError(`appendSnapshot:${win.slug}`, err)
      }
    }
  }

  private async executePollCycle(
    nowMs: number,
    forceDiscovery: boolean,
  ): Promise<CollectorStats> {
    if (!this.hydratedFromStore) {
      await this.hydrateFromStore(nowMs)
    }

    const needsDiscovery =
      forceDiscovery ||
      this.lastDiscoveryAtMs === null ||
      nowMs - this.lastDiscoveryAtMs >= this.discoveryIntervalMs ||
      this.hasExpiredOpenOrPendingWindows(nowMs) ||
      this.missingActiveTimeframe(nowMs)

    if (needsDiscovery) {
      await this.runDiscovery(nowMs)
    }

    await this.captureSnapshots(nowMs)
    this.lastPollAtMs = nowMs
    return this.getCollectorStats()
  }
}
