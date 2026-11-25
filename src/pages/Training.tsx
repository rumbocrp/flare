import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Play, RefreshCw, WifiOff } from 'lucide-react'
import {
  BackendApiError,
  fetchLatestBotAccuracyAudit,
  selectBotPresetOnServer,
  type StrategyAuditRecord,
} from '@/api/botClient'
import {
  cancelTrainingRunApi,
  createClientRunId,
  createTrainingRunApi,
  fetchHistoricalCandlesApi,
  getTrainingLiveShadowApi,
  getTrainingRunApi,
  listTrainingRunsApi,
  patchTrainingRunApi,
} from '@/api/trainingClient'
import type { StrategyPreset, StrategyPresetPatch } from '@/botEngine'
import {
  deleteCustomBotProfile,
  loadCustomBotProfiles,
  upsertCustomBotProfile,
  type SavedBotProfile,
} from '@/botProfiles'
import PageHeader from '@/components/PageHeader'
import BacktestTab from '@/components/training/BacktestTab'
import CustomizePanel from '@/components/training/CustomizePanel'
import EquityTab from '@/components/training/EquityTab'
import FoldsTab from '@/components/training/FoldsTab'
import OverviewTab from '@/components/training/OverviewTab'
import RunBar from '@/components/training/RunBar'
import RunConfig from '@/components/training/RunConfig'
import RunHistory from '@/components/training/RunHistory'
import ShadowTab from '@/components/training/ShadowTab'
import StrategyCatalog from '@/components/training/StrategyCatalog'
import TradesTab from '@/components/training/TradesTab'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  buildDefaultDraft,
  draftToTrainingConfig,
  validateTrainingDraft,
  type TrainingFormDraft,
} from '@/training/formDraft'
import { TrainingCancelledError } from '@/training/runner'
import {
  applyPresetPatchWithClamps,
  buildPromotionPlan,
  findCatalogBasePreset,
  type ClampedFieldNotice,
} from '@/training/shadowAndCustomize'
import { buildTrainingCatalog } from '@/training/strategyRegistry'
import type {
  HistoricalCandlesMissingSpan,
  TrainingLiveShadowResponse,
  TrainingProgress,
  TrainingRunRecord,
  TrainingRunStatus,
} from '@/training/types'
import type { Candle, PageId } from '@/types'
import { runTrainingOffloaded } from '@/workers/trainingClient'

type TrainingProps = {
  onNavigate?: (page: PageId) => void
}

type TrainingSectionState = {
  catalog: boolean
  history: boolean
}

const TRAINING_SECTIONS_KEY = 'flare:training-sections'
const DEFAULT_SECTIONS: TrainingSectionState = {
  catalog: true,
  history: true,
}

function loadTrainingSectionState(): TrainingSectionState {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return { ...DEFAULT_SECTIONS }
    }
    const raw = window.localStorage.getItem(TRAINING_SECTIONS_KEY)
    if (!raw) return { ...DEFAULT_SECTIONS }
    const parsed = JSON.parse(raw) as Partial<TrainingSectionState>
    return {
      catalog:
        typeof parsed.catalog === 'boolean'
          ? parsed.catalog
          : DEFAULT_SECTIONS.catalog,
      history:
        typeof parsed.history === 'boolean'
          ? parsed.history
          : DEFAULT_SECTIONS.history,
    }
  } catch {
    return { ...DEFAULT_SECTIONS }
  }
}

function saveTrainingSectionState(state: TrainingSectionState): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(TRAINING_SECTIONS_KEY, JSON.stringify(state))
  } catch {
    // Ignore storage quota errors
  }
}

type WorkspaceTab =
  | 'overview'
  | 'folds'
  | 'trades'
  | 'equity'
  | 'backtest'
  | 'shadow'
  | 'customize'

function Training({ onNavigate }: TrainingProps) {
  const { t } = useI18n()

  const [customProfiles, setCustomProfiles] = useState<SavedBotProfile[]>(() =>
    loadCustomBotProfiles(),
  )
  const catalog = useMemo(
    () => buildTrainingCatalog(customProfiles),
    [customProfiles],
  )
  const presetNameMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of catalog) {
      map.set(item.presetId, item.preset.name)
    }
    return map
  }, [catalog])

  const [nowMs, setNowMs] = useState<number>(() => Date.now())
  const [selectedCatalogId, setSelectedCatalogId] = useState<string>(
    () => catalog[0]?.id ?? 'btc-intraday-trend-15m',
  )
  const selectedItem = useMemo(
    () => catalog.find((c) => c.id === selectedCatalogId) ?? catalog[0],
    [catalog, selectedCatalogId],
  )

  const catalogBasePreset = useMemo(
    () => findCatalogBasePreset(selectedItem),
    [selectedItem],
  )

  const [workingPreset, setWorkingPreset] = useState<StrategyPreset>(
    () => catalog[0].preset,
  )
  const [clamps, setClamps] = useState<ClampedFieldNotice[]>([])

  const [draft, setDraft] = useState<TrainingFormDraft>(() =>
    buildDefaultDraft(catalog[0], Date.now()),
  )
  const [sections, setSections] = useState<TrainingSectionState>(
    loadTrainingSectionState,
  )
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('overview')

  // Batched server state
  const [backendOffline, setBackendOffline] = useState(false)
  const [runs, setRuns] = useState<TrainingRunRecord[]>([])
  const [runsLoading, setRunsLoading] = useState(true)
  const [runsError, setRunsError] = useState<string | null>(null)
  const [audits, setAudits] = useState<StrategyAuditRecord[]>([])
  const [selectedRun, setSelectedRun] = useState<TrainingRunRecord | null>(null)

  // Live Shadow state (real /api/training/live — zero fallback)
  const [shadowData, setShadowData] =
    useState<TrainingLiveShadowResponse | null>(null)
  const [shadowFetchedKey, setShadowFetchedKey] = useState<string | null>(null)
  const [shadowError, setShadowError] = useState<string | null>(null)
  const [shadowLoadedAtMs, setShadowLoadedAtMs] = useState<number | null>(null)
  const [shadowNonce, setShadowNonce] = useState(0)

  // Active execution state (progress isolated to RunBar)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [runStatus, setRunStatus] = useState<TrainingRunStatus | 'idle'>('idle')
  const [progress, setProgress] = useState<TrainingProgress | null>(null)
  const [runStartedAtMs, setRunStartedAtMs] = useState<number | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [isCancelling, setIsCancelling] = useState(false)
  const [partialMissingSpans, setPartialMissingSpans] = useState<
    HistoricalCandlesMissingSpan[]
  >([])
  const [lastFetchedCandles, setLastFetchedCandles] = useState<Candle[] | null>(
    null,
  )

  const abortRef = useRef<AbortController | null>(null)
  const activeRunIdRef = useRef<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)

  const effectiveSelectedItem = useMemo(
    () => ({
      ...selectedItem,
      preset: workingPreset,
    }),
    [selectedItem, workingPreset],
  )

  const validation = useMemo(
    () => validateTrainingDraft(draft, effectiveSelectedItem, nowMs, t),
    [draft, effectiveSelectedItem, nowMs, t],
  )

  // Lightweight wall-clock tick for relative timestamps and real ETA calculation
  useEffect(() => {
    const interval = runStatus === 'running' ? 1_000 : 15_000
    const timer = window.setInterval(() => setNowMs(Date.now()), interval)
    return () => window.clearInterval(timer)
  }, [runStatus])

  // Initial & retry batched fetch: 1 GET /api/training/runs (reconciling orphaned runs) + 1 GET /api/bot/accuracy/latest
  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()

    void (async () => {
      try {
        const [runsRes, auditsRes] = await Promise.all([
          listTrainingRunsApi({
            limit: 50,
            reconcileInterrupted: reloadNonce === 0,
            signal: ac.signal,
          }),
          fetchLatestBotAccuracyAudit().catch(() => null),
        ])
        if (cancelled) return
        setBackendOffline(false)
        setRunsError(null)
        setRuns(runsRes.runs)
        if (auditsRes) {
          setAudits(auditsRes)
        }
        setSelectedRun((prev) => {
          if (prev) {
            return runsRes.runs.find((r) => r.id === prev.id) ?? prev
          }
          const matching = runsRes.runs.find(
            (r) => r.presetId === selectedItem.presetId,
          )
          return matching ?? runsRes.runs[0] ?? null
        })
      } catch (err) {
        if (cancelled) return
        const isNetwork =
          err instanceof BackendApiError ? err.status === null : true
        if (isNetwork) {
          setBackendOffline(true)
        }
        setRunsError(
          err instanceof Error ? err.message : 'Failed to load training runs.',
        )
      } finally {
        if (!cancelled) {
          setRunsLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
      ac.abort()
    }
  }, [reloadNonce, selectedItem.presetId])

  const currentShadowKey = `${selectedItem.presetId}:${reloadNonce}:${shadowNonce}`
  const shadowLoading =
    !backendOffline && shadowFetchedKey !== currentShadowKey

  // Fetch live Shadow operations for the selected strategy (feeds Funnel + Shadow tab)
  useEffect(() => {
    if (backendOffline) return
    let cancelled = false
    const ac = new AbortController()
    const targetKey = currentShadowKey

    void (async () => {
      try {
        const res = await getTrainingLiveShadowApi({
          presetId: selectedItem.presetId,
          signal: ac.signal,
        })
        if (!cancelled) {
          setShadowData(res)
          setShadowLoadedAtMs(Date.now())
          setShadowError(null)
        }
      } catch (err) {
        if (!cancelled) {
          const isNetwork =
            err instanceof BackendApiError ? err.status === null : false
          if (isNetwork) {
            setBackendOffline(true)
          }
          setShadowData(null)
          setShadowError(
            err instanceof Error
              ? err.message
              : 'Failed to load live shadow operations.',
          )
        }
      } finally {
        if (!cancelled) {
          setShadowFetchedKey(targetKey)
        }
      }
    })()

    return () => {
      cancelled = true
      ac.abort()
    }
  }, [backendOffline, currentShadowKey, selectedItem.presetId])

  const handleToggleSection = useCallback((key: keyof TrainingSectionState) => {
    setSections((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      saveTrainingSectionState(next)
      return next
    })
  }, [])

  const handleSelectCatalogItem = useCallback(
    (id: string) => {
      const found = catalog.find((item) => item.id === id)
      if (!found) return
      setSelectedCatalogId(id)
      setWorkingPreset(found.preset)
      setClamps([])
      setDraft(buildDefaultDraft(found, Date.now()))
      setRunError(null)
      setPartialMissingSpans([])
      const latestForPreset =
        runs.find((r) => r.presetId === found.presetId) ?? null
      setSelectedRun(latestForPreset)
    },
    [catalog, runs],
  )

  const handleSelectHistoryRun = useCallback(
    async (runId: string) => {
      setRunError(null)
      try {
        const fullRun = await getTrainingRunApi(runId)
        setSelectedRun(fullRun)
        setRunStatus(fullRun.status)
        const matchingItem = catalog.find((c) => c.presetId === fullRun.presetId)
        if (matchingItem) {
          setSelectedCatalogId(matchingItem.id)
          setWorkingPreset(matchingItem.preset)
          setClamps([])
        }
      } catch (err) {
        setRunError(err instanceof Error ? err.message : String(err))
      }
    },
    [catalog],
  )

  const handleRetryAll = useCallback(() => {
    setRunsLoading(true)
    setRunsError(null)
    setRunError(null)
    setShadowError(null)
    setBackendOffline(false)
    setReloadNonce((n) => n + 1)
  }, [])

  const handleRefreshShadow = useCallback(() => {
    if (backendOffline) {
      handleRetryAll()
      return
    }
    setShadowNonce((n) => n + 1)
  }, [backendOffline, handleRetryAll])

  const handlePatchWorkingPreset = useCallback((patch: StrategyPresetPatch) => {
    setWorkingPreset((prev) => {
      const { preset: next, clamps: newClamps } = applyPresetPatchWithClamps(
        prev,
        patch,
      )
      setClamps(newClamps)
      // Sync execution & market fields cleanly with the RunConfig draft
      setDraft((prevDraft) => ({
        ...prevDraft,
        pair: next.strategy.pair,
        timeframe: next.timeframe,
        commissionPct: String(next.execution.commissionPct),
        slippagePct: String(next.execution.slippagePct),
        initialBalance: String(next.execution.initialBalance),
        allowShort: next.execution.allowShort,
      }))
      return next
    })
  }, [])

  const handleResetToCatalog = useCallback(() => {
    setWorkingPreset(catalogBasePreset)
    setClamps([])
    setDraft((prevDraft) => ({
      ...prevDraft,
      pair: catalogBasePreset.strategy.pair,
      timeframe: catalogBasePreset.timeframe,
      commissionPct: String(catalogBasePreset.execution.commissionPct),
      slippagePct: String(catalogBasePreset.execution.slippagePct),
      initialBalance: String(catalogBasePreset.execution.initialBalance),
      allowShort: catalogBasePreset.execution.allowShort,
    }))
  }, [catalogBasePreset])

  const handleSaveProfile = useCallback(
    (name: string) => {
      const nextList = upsertCustomBotProfile(workingPreset, name)
      setCustomProfiles(nextList)
      if (nextList[0]) {
        setSelectedCatalogId(nextList[0].id)
        setWorkingPreset(nextList[0].preset)
        setClamps([])
      }
    },
    [workingPreset],
  )

  const handleDuplicateProfile = useCallback(
    (name: string) => {
      const nextList = upsertCustomBotProfile(workingPreset, name)
      setCustomProfiles(nextList)
      if (nextList[0]) {
        setSelectedCatalogId(nextList[0].id)
        setWorkingPreset(nextList[0].preset)
        setClamps([])
      }
    },
    [workingPreset],
  )

  const handleDeleteProfile = useCallback((profileId: string) => {
    const nextList = deleteCustomBotProfile(profileId)
    setCustomProfiles(nextList)
    const fallbackCatalog = buildTrainingCatalog(nextList)
    if (fallbackCatalog[0]) {
      setSelectedCatalogId(fallbackCatalog[0].id)
      setWorkingPreset(fallbackCatalog[0].preset)
      setClamps([])
      setDraft(buildDefaultDraft(fallbackCatalog[0], Date.now()))
    }
  }, [])

  const handlePromoteStrategy = useCallback(async (): Promise<{
    ok: boolean
    message: string
  }> => {
    const plan = buildPromotionPlan(
      selectedItem,
      workingPreset,
      validation.isResearchVariant,
    )
    if (!plan.allowed) {
      return {
        ok: false,
        message: t('training.customPromoteBlockedResearch'),
      }
    }
    try {
      const snap = await selectBotPresetOnServer(plan.payload)
      setShadowNonce((n) => n + 1)
      return {
        ok: true,
        message: t('training.customPromoteSuccess', {
          name: snap.preset.name,
          pair: snap.preset.strategy.pair,
          tf: snap.preset.timeframe,
        }),
      }
    } catch (err) {
      if (err instanceof BackendApiError && err.status === null) {
        setBackendOffline(true)
      }
      return {
        ok: false,
        message: t('training.customPromoteFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      }
    }
  }, [selectedItem, t, validation.isResearchVariant, workingPreset])

  const handleCancelRun = useCallback(async () => {
    const currentId = activeRunIdRef.current
    setIsCancelling(true)
    abortRef.current?.abort()
    if (currentId) {
      try {
        const cancelledRes = await cancelTrainingRunApi(currentId)
        setSelectedRun(cancelledRes.run)
        setRuns((prev) =>
          prev.map((r) => (r.id === currentId ? cancelledRes.run : r)),
        )
      } catch {
        // Server cancel best-effort if already offline
      }
    }
    setRunStatus('cancelled')
    setActiveRunId(null)
    activeRunIdRef.current = null
    setIsCancelling(false)
  }, [])

  const handleStartRun = useCallback(async () => {
    if (!validation.valid || backendOffline || runStatus === 'running') return

    const ac = new AbortController()
    abortRef.current = ac
    const startedAt = Date.now()
    setRunStartedAtMs(startedAt)
    setNowMs(startedAt)
    setRunError(null)
    setPartialMissingSpans([])
    setRunStatus('running')
    setProgress({
      phase: 'preparing',
      foldIndex: 0,
      foldCount: draft.kind === 'walk-forward' ? draft.foldCount : 1,
      barIndex: 0,
      barCount: 0,
    })

    let createdRunId: string | null = null
    try {
      const config = draftToTrainingConfig(
        draft,
        effectiveSelectedItem,
        validation,
      )

      // 1. Fetch real historical candles ONCE via archive-first /api/market/history
      const history = await fetchHistoricalCandlesApi({
        pair: config.pair,
        interval: config.timeframe,
        fromTimeMs: config.fromTimeMs,
        toTimeMs: config.toTimeMs,
        signal: ac.signal,
      })

      setLastFetchedCandles(history.candles)
      setPartialMissingSpans(history.missingSpans)

      if (history.candles.length < 100) {
        throw new Error(
          `Only ${history.candles.length} real historical candles returned for ${config.pair} ${config.timeframe}. Cannot train on insufficient data.`,
        )
      }

      // 2. Create persisted `running` row on server with idempotent UUID
      const clientRunId = createClientRunId()
      const created = await createTrainingRunApi(
        {
          clientRunId,
          config,
          candleCount: history.candles.length,
          dataSource: history.source,
          ...(selectedItem.kind === 'custom-profile' ||
          workingPreset !== selectedItem.preset
            ? { customPreset: workingPreset }
            : {}),
        },
        ac.signal,
      )

      createdRunId = created.run.id
      setActiveRunId(createdRunId)
      activeRunIdRef.current = createdRunId
      setSelectedRun(created.run)
      setRuns((prev) => [
        created.run,
        ...prev.filter((r) => r.id !== created.run.id),
      ])

      // 3. Offload Fit -> Validate -> Test to dedicated training Web Worker
      const job = await runTrainingOffloaded({
        candles: history.candles,
        preset: workingPreset,
        config,
        signal: ac.signal,
        onProgress: (p) => setProgress(p),
      })

      // 4. Persist & verify metrics server-side (recomputed within 1e-6)
      const verifiedRun = await patchTrainingRunApi(
        createdRunId,
        {
          status: 'completed',
          candleCount: history.candles.length,
          metrics: job.output.metrics,
          folds: job.output.folds,
          equity: job.output.equity,
          trades: job.output.trades,
          dataSource: history.source,
        },
        ac.signal,
      )

      setSelectedRun(verifiedRun)
      setRunStatus('completed')
      setRuns((prev) => [
        verifiedRun,
        ...prev.filter((r) => r.id !== verifiedRun.id),
      ])
      setActiveRunId(null)
      activeRunIdRef.current = null
      setProgress(verifiedRun.progress)
    } catch (err) {
      if (
        err instanceof TrainingCancelledError ||
        (err instanceof Error && err.name === 'AbortError') ||
        ac.signal.aborted
      ) {
        setRunStatus('cancelled')
        setActiveRunId(null)
        activeRunIdRef.current = null
        return
      }

      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof BackendApiError && err.status === null) {
        setBackendOffline(true)
      }
      setRunError(message)
      setRunStatus('failed')
      setActiveRunId(null)
      activeRunIdRef.current = null

      if (createdRunId) {
        try {
          const failedRun = await patchTrainingRunApi(createdRunId, {
            status: 'failed',
            error: message,
          })
          setSelectedRun(failedRun)
          setRuns((prev) =>
            prev.map((r) => (r.id === createdRunId ? failedRun : r)),
          )
        } catch {
          // Server unreachable while reporting failure
        }
      }
    } finally {
      abortRef.current = null
    }
  }, [
    backendOffline,
    draft,
    effectiveSelectedItem,
    runStatus,
    selectedItem,
    validation,
    workingPreset,
  ])

  const displayedRun =
    selectedRun && selectedRun.presetId === selectedItem.presetId
      ? selectedRun
      : selectedRun

  const displayedPresetName = displayedRun
    ? (presetNameMap.get(displayedRun.presetId) ?? displayedRun.presetId)
    : workingPreset.name

  const barStatus: TrainingRunStatus | 'idle' =
    runStatus === 'running'
      ? 'running'
      : (displayedRun?.status ?? runStatus)

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('training.title')}
        actions={
          <>
            {activeRunId && (
              <Badge variant="default">{t('training.statusRunning')}</Badge>
            )}
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={!validation.valid || backendOffline || runStatus === 'running'}
              onClick={() => void handleStartRun()}
              className="h-8 gap-1.5 text-xs"
            >
              <Play className="size-3.5" />
              <span>
                {runStatus === 'running'
                  ? t('training.runningCta')
                  : t('training.runTraining')}
              </span>
            </Button>
          </>
        }
      />

      {/* Explicit Offline State — zero client-side fallback */}
      {backendOffline && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-[var(--negative-soft)] px-4 py-3 text-xs text-[var(--negative)]"
        >
          <div className="flex items-center gap-2.5">
            <WifiOff className="size-4 shrink-0" />
            <div>
              <p className="font-semibold">{t('training.offlineTitle')}</p>
              <p className="text-[11.5px] opacity-90">
                {t('training.offlineBody')}
              </p>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleRetryAll}
            className="gap-1.5"
          >
            <RefreshCw className="size-3.5" />
            <span>{t('training.retry')}</span>
          </Button>
        </div>
      )}

      {/* Sticky Run Status Bar (isolated progress updates) */}
      <RunBar
        status={barStatus}
        strategyName={workingPreset.name}
        pair={draft.pair}
        timeframe={draft.timeframe}
        fromTimeMs={validation.fromTimeMs}
        toTimeMs={validation.toTimeMs}
        progress={progress}
        runStartedAtMs={runStartedAtMs}
        nowMs={nowMs}
        isCancelling={isCancelling}
        onCancel={() => void handleCancelRun()}
      />

      {/* Main Two-Column Workspace on xl, Stacked on Mobile */}
      <div
        className={cn(
          'grid grid-cols-1 gap-4',
          sections.catalog
            ? 'xl:grid-cols-[296px_minmax(0,1fr)]'
            : 'xl:grid-cols-[180px_minmax(0,1fr)]',
        )}
      >
        <StrategyCatalog
          catalog={catalog}
          selectedId={selectedItem.id}
          onSelect={handleSelectCatalogItem}
          runs={runs}
          audits={audits}
          collapsed={!sections.catalog}
          onToggleCollapse={() => handleToggleSection('catalog')}
        />

        <div className="flex min-w-0 flex-col gap-4">
          <RunConfig
            selectedItem={effectiveSelectedItem}
            draft={draft}
            validation={validation}
            backendOffline={backendOffline}
            isRunning={runStatus === 'running'}
            nowMs={nowMs}
            onChangeDraft={setDraft}
            onStartRun={() => void handleStartRun()}
          />

          <section aria-labelledby="training-workspace-heading">
            <h2 id="training-workspace-heading" className="sr-only">
              {t('training.workspaceAria')}
            </h2>
            <Tabs
              value={activeTab}
              onValueChange={(v) => setActiveTab(v as WorkspaceTab)}
              className="w-full"
            >
            <TabsList className="w-full justify-start overflow-x-auto">
              <TabsTrigger value="overview">{t('training.tabOverview')}</TabsTrigger>
              <TabsTrigger value="folds">{t('training.tabFolds')}</TabsTrigger>
              <TabsTrigger value="trades">{t('training.tabTrades')}</TabsTrigger>
              <TabsTrigger value="equity">{t('training.tabEquity')}</TabsTrigger>
              <TabsTrigger value="backtest">{t('training.tabBacktest')}</TabsTrigger>
              <TabsTrigger value="shadow">{t('training.tabShadow')}</TabsTrigger>
              <TabsTrigger value="customize">{t('training.tabCustomize')}</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="mt-3">
              <OverviewTab
                run={displayedRun}
                presetName={displayedPresetName}
                loading={runsLoading}
                error={runError}
                partialMissingSpans={partialMissingSpans}
                shadowData={shadowData}
                configuredToTimeMs={validation.toTimeMs}
                nowMs={nowMs}
                onRetry={handleRetryAll}
              />
            </TabsContent>

            <TabsContent value="folds" className="mt-3">
              <FoldsTab run={displayedRun} />
            </TabsContent>

            <TabsContent value="trades" className="mt-3">
              <TradesTab run={displayedRun} />
            </TabsContent>

            <TabsContent value="equity" className="mt-3">
              <EquityTab run={displayedRun} />
            </TabsContent>

            <TabsContent value="backtest" className="mt-3">
              <BacktestTab
                selectedItem={effectiveSelectedItem}
                run={displayedRun}
                cachedCandles={lastFetchedCandles}
                backendOffline={backendOffline}
                onNavigate={onNavigate}
              />
            </TabsContent>

            <TabsContent value="shadow" className="mt-3">
              <ShadowTab
                presetId={selectedItem.presetId}
                presetName={workingPreset.name}
                run={displayedRun}
                shadowData={shadowData}
                shadowLoadedAtMs={shadowLoadedAtMs}
                loading={shadowLoading}
                error={shadowError}
                backendOffline={backendOffline}
                nowMs={nowMs}
                onRefresh={handleRefreshShadow}
              />
            </TabsContent>

            <TabsContent value="customize" className="mt-3">
              <CustomizePanel
                selectedItem={selectedItem}
                draftPreset={workingPreset}
                catalogBase={catalogBasePreset}
                clamps={clamps}
                isResearchVariant={validation.isResearchVariant}
                backendOffline={backendOffline}
                customProfileCount={customProfiles.length}
                activeRun={displayedRun}
                onPatchPreset={handlePatchWorkingPreset}
                onResetToCatalog={handleResetToCatalog}
                onSaveProfile={handleSaveProfile}
                onDuplicateProfile={handleDuplicateProfile}
                onDeleteProfile={handleDeleteProfile}
                onPromote={handlePromoteStrategy}
              />
            </TabsContent>
            </Tabs>
          </section>
        </div>
      </div>

      {/* Collapsible Persisted Run History */}
      <RunHistory
        runs={runs}
        selectedRunId={displayedRun?.id ?? null}
        loading={runsLoading}
        error={runsError}
        nowMs={nowMs}
        collapsed={!sections.history}
        onToggleCollapse={() => handleToggleSection('history')}
        onSelectRun={(id) => void handleSelectHistoryRun(id)}
        onRetry={handleRetryAll}
        presetNameMap={presetNameMap}
      />
    </div>
  )
}

export default Training
