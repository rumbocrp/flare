import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Info,
  Maximize2,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from 'lucide-react'
import {
  fetchPolymarketSnapshot,
  getPredictionEngineStatus,
  runPredictionReplay,
  updatePredictionCanaryConfig,
  updatePredictionStrategyMode,
} from '@/api/botClient'
import EquityChart from '@/components/EquityChart'
import MetricCard from '@/components/MetricCard'
import NumberField from '@/components/NumberField'
import PageHeader from '@/components/PageHeader'
import PredictionRuleDetail from '@/components/PredictionRuleDetail'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  buildDirectionalRules,
  type DirectionalTimeframe,
} from '@/directionalRules'
import { formatDateTime, formatMoney, formatSignedMoney } from '@/format'
import { useCandles } from '@/hooks/useCandles'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { marketDataSource } from '@/market'
import { getStrategyDefinition } from '@/prediction/engine/strategies'
import {
  PREDICTION_ENGINE_STRATEGY_IDS,
  type MacroBlackoutWindow,
  type PredictionEngineStrategyId,
  type StrategyLifecycleMode,
} from '@/prediction/engine/types'
import {
  DEFAULT_SIMULATION_CONFIG,
  analyzeRulesMarket,
  chooseSide,
  simulatePredictionStrategy,
  type MarketCostModel,
  type QuoteProvider,
  type SizingMode,
} from '@/predictionMarket'
import { BITCOIN_20_PREDICTIONS, buildMarketContext } from '@/predictions'
import type {
  PolymarketSnapshot,
  PolymarketTimeframe,
  PolymarketWindow,
} from '@/server/polymarketAdapter'
import type {
  PredictionEngineStatus,
  PredictionStrategyStatusView,
} from '@/server/prediction/predictionRunner'
import type { StoredPredictionTrade } from '@/server/store/types'
import { availablePairs } from '@/strategy'
import type { ChartPoint, Interval, PageId } from '@/types'

type PredictionsTab = 'engine' | 'rules' | 'simulator' | 'polymarket'
type RuleFamily = 'flare20' | 'directional'
type EngineTicketFilter = 'all' | 'open' | 'settled'

type PendingForcePromotion = {
  strategyId: PredictionEngineStrategyId
  strategyName: string
  fromMode: StrategyLifecycleMode
  toMode: StrategyLifecycleMode
  settledSamples: number
  targetSamples: number
  failures: string[]
}

const LIFECYCLE_MODES: readonly StrategyLifecycleMode[] = [
  'disabled',
  'research',
  'paper',
  'canary',
  'scale',
]

function buildFallbackStrategies(): PredictionStrategyStatusView[] {
  return PREDICTION_ENGINE_STRATEGY_IDS.map((id) => {
    const def = getStrategyDefinition(id)
    return {
      id: def.id,
      name: def.name,
      lane: def.lane,
      timeframes: def.timeframes,
      description: def.description,
      defaultRole: def.defaultRole,
      defaultMode: def.defaultMode,
      mode: def.defaultMode,
      haltedReason: null,
      updatedAt: null,
      settledSamplesForTimeframe: 0,
      targetSamples: 500,
      forcedOverride: false,
      liveStats: {
        openCount: 0,
        settledCount: 0,
        canceledCount: 0,
        wins: 0,
        winRatePct: 0,
        netPnlUsd: 0,
        meanMarkout30s: null,
        markoutSampleCount: 0,
        consecutiveHighErrorCount: 0,
      },
      latestReplay: null,
    }
  })
}

function getModeBadgeVariant(
  mode: StrategyLifecycleMode,
): 'secondary' | 'outline' | 'default' | 'warning' | 'positive' {
  switch (mode) {
    case 'disabled':
      return 'secondary'
    case 'research':
      return 'outline'
    case 'paper':
      return 'default'
    case 'canary':
      return 'warning'
    case 'scale':
      return 'positive'
  }
}

function formatModeLabel(mode: StrategyLifecycleMode, isEs: boolean): string {
  switch (mode) {
    case 'disabled':
      return isEs ? 'DESACTIVADO' : 'DISABLED'
    case 'research':
      return isEs ? 'INVESTIGACIÓN' : 'RESEARCH'
    case 'paper':
      return 'PAPER'
    case 'canary':
      return 'CANARY $5'
    case 'scale':
      return 'SCALE'
  }
}

const TIMEFRAMES: { id: Interval; label: string }[] = [
  { id: '5m', label: '5m' },
  { id: '15m', label: '15m' },
  { id: '1h', label: '1h' },
  { id: '4h', label: '4h' },
  { id: '1d', label: '1d' },
]

export type PredictionFocusTarget = {
  ruleId: string
  pair: string
  timeframe: Interval
  family?: RuleFamily
}

type PredictionsProps = {
  onNavigate?: (page: PageId) => void
  onOpenTerminalForPair?: (pair: string) => void
  focusTarget?: PredictionFocusTarget | null
  onClearFocusTarget?: () => void
}

function clampNumber(
  raw: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function SegmentedButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: string
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-[26px] cursor-pointer items-center justify-center rounded-[4px] px-2 text-xs font-medium whitespace-nowrap transition-all duration-150 select-none outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'bg-card font-semibold text-foreground'
          : 'bg-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

export default function Predictions({
  onNavigate,
  onOpenTerminalForPair,
  focusTarget = null,
  onClearFocusTarget,
}: PredictionsProps) {
  const { language, t } = useI18n()
  const isEs = language === 'es'

  const [tab, setTab] = useState<PredictionsTab>(
    focusTarget ? 'rules' : 'engine',
  )
  const [pair, setPair] = useState<string>(
    focusTarget?.pair ?? availablePairs[0],
  )
  const [timeframe, setTimeframe] = useState<Interval>(
    focusTarget?.timeframe ?? '15m',
  )
  const [ruleFamily, setRuleFamily] = useState<RuleFamily>(
    focusTarget?.family ?? 'flare20',
  )
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(
    focusTarget?.ruleId ?? null,
  )
  const [reloadKey, setReloadKey] = useState(0)

  // Engine Orchestrator state
  const [engineStatus, setEngineStatus] =
    useState<PredictionEngineStatus | null>(null)
  const [engineLoading, setEngineLoading] = useState(false)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [replayInFlightByStrategy, setReplayInFlightByStrategy] = useState<
    Record<string, boolean>
  >({})
  const [modeSwitchInFlight, setModeSwitchInFlight] = useState<string | null>(
    null,
  )
  const [pendingForcePromotion, setPendingForcePromotion] =
    useState<PendingForcePromotion | null>(null)
  const [overrideReasonDraft, setOverrideReasonDraft] = useState('')
  const [canaryStakeDraft, setCanaryStakeDraft] = useState('5')
  const [canaryMaxLossesDraft, setCanaryMaxLossesDraft] = useState<3 | 4>(3)
  const [canaryMaxExposureDraft, setCanaryMaxExposureDraft] = useState('15')
  const [canaryDirty, setCanaryDirty] = useState(false)
  const [macroTimestampInput, setMacroTimestampInput] = useState('')
  const [macroLabelInput, setMacroLabelInput] = useState('')
  const [savingCanary, setSavingCanary] = useState(false)
  const [haltingAll, setHaltingAll] = useState(false)
  const [ticketFilter, setTicketFilter] = useState<EngineTicketFilter>('all')
  const [engineFeedback, setEngineFeedback] = useState<{
    tone: 'positive' | 'negative'
    text: string
  } | null>(null)

  // Shared cost model and strategies
  const [spreadCents, setSpreadCents] = useState('2')
  const [feePct, setFeePct] = useState('1')
  const [useCooldown, setUseCooldown] = useState(true)

  // Simulator configuration
  const [bankroll, setBankroll] = useState('1000')
  const [sizing, setSizing] = useState<SizingMode>('quarter-kelly')
  const [fixedStakePct, setFixedStakePct] = useState('2')
  const [maxStakePct, setMaxStakePct] = useState('5')
  const [minEdgePct, setMinEdgePct] = useState('3')
  const [minConfluence, setMinConfluence] = useState('1')
  const [trainRatioPct, setTrainRatioPct] = useState('70')
  const [allowNo, setAllowNo] = useState(true)

  // Polymarket (live market)
  const [polyTf, setPolyTf] = useState<PolymarketTimeframe>('15m')
  const [polyLimit, setPolyLimit] = useState<24 | 48>(24)
  const [polyReloadNonce, setPolyReloadNonce] = useState(0)
  const [polyStored, setPolyStored] = useState<{
    key: string
    state:
      | { status: 'success'; data: PolymarketSnapshot }
      | { status: 'error'; message: string }
  } | null>(null)

  const activeTimeframe: Interval =
    tab === 'polymarket'
      ? polyTf
      : ruleFamily === 'directional' && timeframe !== '5m' && timeframe !== '15m'
        ? '15m'
        : timeframe

  const activePair =
    tab === 'polymarket' || tab === 'engine' ? 'BTC/USDT' : pair

  const fetchAndApplyEngineStatus = useCallback(async () => {
    try {
      const status = await getPredictionEngineStatus()
      if (status) {
        setEngineStatus(status)
        setEngineError(null)
        if (!canaryDirty) {
          setCanaryStakeDraft(String(status.canaryRisk.config.stakeUsd))
          setCanaryMaxLossesDraft(status.canaryRisk.config.maxDailyLosses)
          setCanaryMaxExposureDraft(
            String(status.canaryRisk.config.maxConcurrentBtcExposureUsd),
          )
        }
      } else {
        setEngineError(
          isEs
            ? 'Estado del motor no disponible (servidor offline o sin permisos).'
            : 'Prediction engine status unavailable (backend offline or missing permissions).',
        )
      }
    } catch (err) {
      setEngineError(err instanceof Error ? err.message : String(err))
    } finally {
      setEngineLoading(false)
    }
  }, [canaryDirty, isEs])

  const refreshEngineStatus = useCallback(async () => {
    setEngineLoading(true)
    await fetchAndApplyEngineStatus()
  }, [fetchAndApplyEngineStatus])

  useEffect(() => {
    if (tab !== 'engine') return
    let cancelled = false
    const poll = () => {
      if (!cancelled) {
        void fetchAndApplyEngineStatus()
      }
    }
    const initialTimer = setTimeout(poll, 0)
    const timer = setInterval(poll, 3_000)
    return () => {
      cancelled = true
      clearTimeout(initialTimer)
      clearInterval(timer)
    }
  }, [tab, fetchAndApplyEngineStatus])

  const fallbackStrategies = useMemo(() => buildFallbackStrategies(), [])
  const strategiesView: PredictionStrategyStatusView[] =
    engineStatus?.strategies ?? fallbackStrategies
  const laneAStrategies = useMemo(
    () => strategiesView.filter((s) => s.lane === 'high-hit-rate'),
    [strategiesView],
  )
  const laneBStrategies = useMemo(
    () => strategiesView.filter((s) => s.lane === 'edge'),
    [strategiesView],
  )

  const combinedTickets: StoredPredictionTrade[] = useMemo(() => {
    const open = engineStatus?.openTrades ?? []
    const settled = engineStatus?.recentSettledTrades ?? []
    if (ticketFilter === 'open') return open
    if (ticketFilter === 'settled') return settled
    const seen = new Set<string>()
    const merged: StoredPredictionTrade[] = []
    for (const tk of [...open, ...settled]) {
      if (!seen.has(tk.id)) {
        seen.add(tk.id)
        merged.push(tk)
      }
    }
    return merged.sort((a, b) => b.entryTimeMs - a.entryTimeMs)
  }, [engineStatus, ticketFilter])

  const handleRunReplay = useCallback(
    async (strategyId: PredictionEngineStrategyId) => {
      setReplayInFlightByStrategy((prev) => ({ ...prev, [strategyId]: true }))
      setEngineFeedback(null)
      try {
        const report = await runPredictionReplay(strategyId)
        setEngineStatus((prev) => {
          if (!prev) return prev
          return {
            ...prev,
            strategies: prev.strategies.map((s) =>
              s.id === strategyId ? { ...s, latestReplay: report } : s,
            ),
          }
        })
        setEngineFeedback({
          tone: report.eligibleForCanary ? 'positive' : 'negative',
          text: `${strategyId}: ${report.sampleProgressText} · WR ${report.winRatePct.toFixed(1)}% vs BE ${report.avgBreakEvenPct.toFixed(1)}% · Net ${formatSignedMoney(report.netPnlUsd)}`,
        })
      } catch (err) {
        setEngineFeedback({
          tone: 'negative',
          text: err instanceof Error ? err.message : String(err),
        })
      } finally {
        setReplayInFlightByStrategy((prev) => ({
          ...prev,
          [strategyId]: false,
        }))
      }
    },
    [],
  )

  const handleSelectStrategyMode = useCallback(
    async (
      strat: PredictionStrategyStatusView,
      nextMode: StrategyLifecycleMode,
    ) => {
      if (nextMode === strat.mode) return
      const isPromotionToLive = nextMode === 'canary' || nextMode === 'scale'
      if (isPromotionToLive) {
        const localFailures: string[] = []
        if (strat.settledSamplesForTimeframe < strat.targetSamples) {
          localFailures.push(
            `Minimum sample gate failed: ${strat.settledSamplesForTimeframe} / ${strat.targetSamples} settled windows collected.`,
          )
        }
        if (strat.latestReplay && !strat.latestReplay.eligibleForCanary) {
          for (const f of strat.latestReplay.gateFailures) {
            if (!localFailures.includes(f)) localFailures.push(f)
          }
        } else if (!strat.latestReplay) {
          localFailures.push(
            'Out-of-sample walk-forward replay has not been verified for this strategy yet.',
          )
        }
        if (localFailures.length > 0) {
          setOverrideReasonDraft('')
          setPendingForcePromotion({
            strategyId: strat.id,
            strategyName: strat.name,
            fromMode: strat.mode,
            toMode: nextMode,
            settledSamples: strat.settledSamplesForTimeframe,
            targetSamples: strat.targetSamples,
            failures: localFailures,
          })
          return
        }
      }

      setModeSwitchInFlight(strat.id)
      setEngineFeedback(null)
      try {
        const res = await updatePredictionStrategyMode({
          strategyId: strat.id,
          mode: nextMode,
        })
        if (res.status) {
          setEngineStatus(res.status)
        }
        if (!res.ok) {
          if (
            isPromotionToLive &&
            res.transition &&
            !res.transition.allowed &&
            res.transition.failures.length > 0
          ) {
            setOverrideReasonDraft('')
            setPendingForcePromotion({
              strategyId: strat.id,
              strategyName: strat.name,
              fromMode: strat.mode,
              toMode: nextMode,
              settledSamples: strat.settledSamplesForTimeframe,
              targetSamples: strat.targetSamples,
              failures: res.transition.failures,
            })
            return
          }
          setEngineFeedback({
            tone: 'negative',
            text: res.error ?? 'Failed to update strategy mode.',
          })
        } else {
          setEngineFeedback({
            tone: 'positive',
            text: `${strat.name} → ${nextMode.toUpperCase()}`,
          })
        }
      } catch (err) {
        setEngineFeedback({
          tone: 'negative',
          text: err instanceof Error ? err.message : String(err),
        })
      } finally {
        setModeSwitchInFlight(null)
      }
    },
    [],
  )

  const handleConfirmForcePromotion = useCallback(async () => {
    if (!pendingForcePromotion) return
    const target = pendingForcePromotion
    const reason =
      overrideReasonDraft.trim() ||
      'Operator audited override via Prediction Engine UI'
    setPendingForcePromotion(null)
    setModeSwitchInFlight(target.strategyId)
    setEngineFeedback(null)
    try {
      const res = await updatePredictionStrategyMode({
        strategyId: target.strategyId,
        mode: target.toMode,
        forceOverride: true,
        overrideReason: reason,
      })
      if (res.status) {
        setEngineStatus(res.status)
      }
      if (!res.ok) {
        setEngineFeedback({
          tone: 'negative',
          text: res.error ?? 'Force promotion rejected by server.',
        })
      } else {
        setEngineFeedback({
          tone: 'positive',
          text: `${target.strategyName} force-promoted to ${target.toMode.toUpperCase()} (audit recorded).`,
        })
      }
    } catch (err) {
      setEngineFeedback({
        tone: 'negative',
        text: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setModeSwitchInFlight(null)
    }
  }, [pendingForcePromotion, overrideReasonDraft])

  const handleSaveCanaryConfig = useCallback(async () => {
    setSavingCanary(true)
    setEngineFeedback(null)
    try {
      const stakeUsd = clampNumber(canaryStakeDraft, 5, 1, 5)
      const maxConcurrentBtcExposureUsd = clampNumber(
        canaryMaxExposureDraft,
        15,
        5,
        50,
      )
      const maxDailyLossUsd = canaryMaxLossesDraft * stakeUsd
      const res = await updatePredictionCanaryConfig({
        canaryConfig: {
          stakeUsd,
          maxDailyLosses: canaryMaxLossesDraft,
          maxDailyLossUsd,
          maxConcurrentBtcExposureUsd,
        },
      })
      if (res.status) {
        setEngineStatus(res.status)
      }
      if (!res.ok) {
        setEngineFeedback({
          tone: 'negative',
          text: res.error ?? 'Failed to save Canary risk config.',
        })
      } else {
        setCanaryDirty(false)
        setEngineFeedback({
          tone: 'positive',
          text: isEs
            ? `Config Canary guardada ($${stakeUsd.toFixed(2)} / ${canaryMaxLossesDraft} pérdidas / $${maxConcurrentBtcExposureUsd.toFixed(2)} tope BTC).`
            : `Canary config saved ($${stakeUsd.toFixed(2)} stake / ${canaryMaxLossesDraft} max losses / $${maxConcurrentBtcExposureUsd.toFixed(2)} BTC cap).`,
        })
      }
    } catch (err) {
      setEngineFeedback({
        tone: 'negative',
        text: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setSavingCanary(false)
    }
  }, [
    canaryStakeDraft,
    canaryMaxLossesDraft,
    canaryMaxExposureDraft,
    isEs,
  ])

  const handleAddMacroBlackout = useCallback(async () => {
    const raw = macroTimestampInput.trim()
    if (!raw) return
    const parsedMs = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw)
    if (!Number.isFinite(parsedMs) || parsedMs <= 0) {
      setEngineFeedback({
        tone: 'negative',
        text: isEs
          ? 'Introduce una fecha ISO válida o timestamp en ms para el bloqueo macro.'
          : 'Enter a valid ISO timestamp or epoch milliseconds for macro blackout.',
      })
      return
    }
    const windowEntry: MacroBlackoutWindow = {
      timestampMs: parsedMs,
      label: macroLabelInput.trim() || 'MACRO',
    }
    setSavingCanary(true)
    try {
      const res = await updatePredictionCanaryConfig({
        addMacroBlackout: windowEntry,
      })
      if (res.status) setEngineStatus(res.status)
      if (!res.ok) {
        setEngineFeedback({
          tone: 'negative',
          text: res.error ?? 'Failed to add macro blackout window.',
        })
      } else {
        setMacroTimestampInput('')
        setMacroLabelInput('')
        setEngineFeedback({
          tone: 'positive',
          text: `${windowEntry.label} blackout added (±30m around ${formatDateTime(parsedMs)}).`,
        })
      }
    } finally {
      setSavingCanary(false)
    }
  }, [macroTimestampInput, macroLabelInput, isEs])

  const handleRemoveMacroBlackout = useCallback(async (timestampMs: number) => {
    setSavingCanary(true)
    try {
      const res = await updatePredictionCanaryConfig({
        removeMacroBlackoutTimestampMs: timestampMs,
      })
      if (res.status) setEngineStatus(res.status)
      if (!res.ok) {
        setEngineFeedback({
          tone: 'negative',
          text: res.error ?? 'Failed to remove macro blackout window.',
        })
      }
    } finally {
      setSavingCanary(false)
    }
  }, [])

  const handleEmergencyHaltAll = useCallback(async () => {
    setHaltingAll(true)
    setEngineFeedback(null)
    try {
      const res = await updatePredictionStrategyMode({
        halt: true,
        haltedReason: 'Emergency manual operator halt from Engine UI',
      })
      if (res.status) setEngineStatus(res.status)
      if (!res.ok) {
        setEngineFeedback({
          tone: 'negative',
          text: res.error ?? 'Failed to halt strategies.',
        })
      } else {
        setEngineFeedback({
          tone: 'negative',
          text: isEs
            ? 'Parada de emergencia activada: todas las estrategias han sido desactivadas.'
            : 'Emergency halt engaged: all 8 prediction strategies halted and disabled.',
        })
      }
    } finally {
      setHaltingAll(false)
    }
  }, [isEs])

  const candleState = useCandles(
    marketDataSource,
    activePair,
    activeTimeframe,
    500,
    reloadKey,
  )

  const polyKey = `${polyTf}|${polyLimit}|${polyReloadNonce}`

  const loadPolymarket = useCallback(() => {
    setPolyReloadNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    if (tab !== 'polymarket') return
    let cancelled = false
    fetchPolymarketSnapshot(polyTf, polyLimit)
      .then((data) => {
        if (!cancelled) {
          setPolyStored({ key: polyKey, state: { status: 'success', data } })
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPolyStored({
            key: polyKey,
            state: {
              status: 'error',
              message: err instanceof Error ? err.message : String(err),
            },
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [tab, polyTf, polyLimit, polyKey])

  const polyState:
    | { status: 'idle' | 'loading' }
    | { status: 'success'; data: PolymarketSnapshot }
    | { status: 'error'; message: string } = useMemo(() => {
    if (tab !== 'polymarket') return { status: 'idle' }
    if (polyStored && polyStored.key === polyKey) return polyStored.state
    return { status: 'loading' }
  }, [tab, polyStored, polyKey])

  const costs: MarketCostModel = useMemo(
    () => ({
      spreadCents: clampNumber(spreadCents, 2, 0, 20),
      feePct: clampNumber(feePct, 1, 0, 10),
    }),
    [spreadCents, feePct],
  )

  const activeRules = useMemo(() => {
    if (ruleFamily === 'directional') {
      const dirTf: DirectionalTimeframe = activeTimeframe === '5m' ? '5m' : '15m'
      return buildDirectionalRules(dirTf)
    }
    return BITCOIN_20_PREDICTIONS.filter((r) => r.timeframe === activeTimeframe)
  }, [ruleFamily, activeTimeframe])

  // ------------------- Tab 1: Rules -------------------
  const ruleStats = useMemo(() => {
    if (candleState.status !== 'success') return []
    return analyzeRulesMarket(activeRules, candleState.data, costs, useCooldown)
  }, [candleState, activeRules, costs, useCooldown])

  const expandedRule = useMemo(
    () =>
      expandedRuleId
        ? activeRules.find((r) => r.id === expandedRuleId) ?? null
        : null,
    [activeRules, expandedRuleId],
  )

  const expandedRuleMarketStats = useMemo(
    () =>
      expandedRuleId
        ? ruleStats.find((s) => s.ruleId === expandedRuleId) ?? null
        : null,
    [ruleStats, expandedRuleId],
  )

  const ruleSummary = useMemo(() => {
    if (ruleStats.length === 0) {
      return {
        avgWr: 0,
        avgLift: 0,
        activeCount: 0,
        bestTitle: '—',
        bestEdge: 0,
      }
    }
    const avgWr = ruleStats.reduce((a, r) => a + r.winRatePct, 0) / ruleStats.length
    const avgLift = ruleStats.reduce((a, r) => a + r.liftPct, 0) / ruleStats.length
    const activeCount = ruleStats.filter((r) => r.currentlyActive).length
    const best = [...ruleStats].sort((a, b) => b.netEdgePct - a.netEdgePct)[0]
    return {
      avgWr,
      avgLift,
      activeCount,
      bestTitle: best?.title ?? '—',
      bestEdge: best?.netEdgePct ?? 0,
    }
  }, [ruleStats])

  // ------------------- Tab 2: Simulator -------------------
  const simConfig = useMemo(
    () => ({
      ...DEFAULT_SIMULATION_CONFIG,
      initialBankroll: clampNumber(bankroll, 1000, 10, 1_000_000),
      sizing,
      fixedStakePct: clampNumber(fixedStakePct, 2, 0.25, 25),
      maxStakePct: clampNumber(maxStakePct, 5, 0.5, 50),
      minEdgePct: clampNumber(minEdgePct, 3, 0, 40),
      minConfluence: Math.round(clampNumber(minConfluence, 1, 1, 8)),
      trainRatio: clampNumber(trainRatioPct, 70, 50, 90) / 100,
      allowNo,
      useCooldown,
      costs,
    }),
    [
      bankroll,
      sizing,
      fixedStakePct,
      maxStakePct,
      minEdgePct,
      minConfluence,
      trainRatioPct,
      allowNo,
      useCooldown,
      costs,
    ],
  )

  const simResult = useMemo(() => {
    if (candleState.status !== 'success') return null
    return simulatePredictionStrategy(candleState.data, activeRules, simConfig)
  }, [candleState, activeRules, simConfig])

  const equityPoints: ChartPoint[] = useMemo(() => {
    if (!simResult) return []
    return simResult.equity.map((pt) => ({
      label: formatDateTime(pt.time, isEs ? 'es-ES' : 'en-US'),
      value: pt.value,
    }))
  }, [simResult, isEs])

  // ------------------- Tab 3: Live Market (Polymarket) -------------------
  const polyAnalysis = useMemo(() => {
    if (
      tab !== 'polymarket' ||
      polyState.status !== 'success' ||
      candleState.status !== 'success'
    ) {
      return null
    }
    const candles = candleState.data
    const dirTf: DirectionalTimeframe = polyTf === '5m' ? '5m' : '15m'
    const dirRules = buildDirectionalRules(dirTf)
    const windowsByStart = new Map<number, PolymarketWindow>()
    for (const w of polyState.data.windows) {
      windowsByStart.set(w.startTime, w)
    }

    const stats = analyzeRulesMarket(dirRules, candles, costs, useCooldown)
    const ctx = buildMarketContext(candles)
    const candleIndexByTime = new Map<number, number>()
    candles.forEach((c, idx) => candleIndexByTime.set(c.time, idx))

    const openWindow =
      [...polyState.data.windows].reverse().find((w) => w.status === 'open') ?? null

    const lastIdx = candles.length - 1
    const liveMid = openWindow?.upPriceNow ?? openWindow?.upPriceAtOpen ?? null
    const liveSignals =
      liveMid !== null && lastIdx >= 50
        ? dirRules
          .map((rule, rIdx) => {
            if (!rule.condition(ctx, lastIdx)) return null
            const prob = stats[rIdx]?.probabilityPct
              ? stats[rIdx].probabilityPct / 100
              : 0.5
            const decision = chooseSide(prob, liveMid, costs, 0, true)
            return {
              rule,
              probPct: prob * 100,
              decision,
            }
          })
          .filter((x): x is NonNullable<typeof x> => x !== null)
        : []

    const quoteProvider: QuoteProvider = (_rule, entryIndex) => {
      const nextCandle = candles[entryIndex + 1]
      if (!nextCandle) return null
      const win = windowsByStart.get(nextCandle.time)
      if (!win || win.upPriceAtOpen === null || win.resolvedUp === null) return null
      return { mid: win.upPriceAtOpen, resolvedYes: win.resolvedUp }
    }

    const realSim = simulatePredictionStrategy(
      candles,
      dirRules,
      { ...simConfig, trainRatio: 0.85, minEdgePct: 1 },
      quoteProvider,
    )

    const resolvedWindows = polyState.data.windows.filter(
      (w) => w.status === 'closed' && w.resolvedUp !== null,
    )
    const resolvedUpCount = resolvedWindows.filter((w) => w.resolvedUp).length

    const rows = [...polyState.data.windows].reverse().map((w) => {
      const nextIdx = candleIndexByTime.get(w.startTime)
      const entryIdx = nextIdx !== undefined ? nextIdx - 1 : -1
      let bestPick: { title: string; side: string; edgePct: number } | null = null
      const quoteMid = w.upPriceAtOpen ?? w.upPriceNow
      if (entryIdx >= 50 && quoteMid !== null) {
        for (let rIdx = 0; rIdx < dirRules.length; rIdx++) {
          const rule = dirRules[rIdx]
          if (!rule.condition(ctx, entryIdx)) continue
          const prob = stats[rIdx] ? stats[rIdx].probabilityPct / 100 : 0.5
          const dec = chooseSide(prob, quoteMid, costs, 0, true)
          if (dec && (!bestPick || dec.edge * 100 > bestPick.edgePct)) {
            bestPick = {
              title: rule.title,
              side: dec.side,
              edgePct: Math.round(dec.edge * 1000) / 10,
            }
          }
        }
      }
      return { win: w, bestPick }
    })

    return {
      openWindow,
      liveSignals,
      resolvedCount: resolvedWindows.length,
      resolvedUpPct:
        resolvedWindows.length > 0
          ? (resolvedUpCount / resolvedWindows.length) * 100
          : 0,
      realSim,
      rows,
    }
  }, [tab, polyState, candleState, polyTf, costs, useCooldown, simConfig])

  const visibleTimeframes = TIMEFRAMES.filter((tf) =>
    ruleFamily === 'directional' ? tf.id === '5m' || tf.id === '15m' : true,
  )

  const renderStrategyRow = (strat: PredictionStrategyStatusView) => {
    const replay = strat.latestReplay
    const replayBusy = Boolean(replayInFlightByStrategy[strat.id])
    const modeBusy = modeSwitchInFlight === strat.id
    const brierDelta =
      replay && replay.brierMarket !== null
        ? replay.brierModel - replay.brierMarket
        : null
    const markoutCents =
      replay !== null
        ? replay.meanMarkout30s * 100
        : strat.liveStats.meanMarkout30s !== null
          ? strat.liveStats.meanMarkout30s * 100
          : null

    return (
      <TableRow key={strat.id}>
        <TableCell className="min-w-[230px] whitespace-normal">
          <div className="flex flex-col gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  title={strat.description}
                  className="flex cursor-help items-center gap-1.5 font-sans text-xs font-semibold text-foreground"
                >
                  <span>{strat.name}</span>
                  <Info className="size-3 shrink-0 text-[var(--text-subtle)]" />
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs font-sans text-[11px] leading-snug">
                {strat.description}
              </TooltipContent>
            </Tooltip>
            <div className="flex flex-wrap items-center gap-1">
              <span className="font-mono text-[10.5px] text-muted-foreground">
                {strat.id}
              </span>
              {strat.forcedOverride && (
                <Badge variant="warning" className="text-[10px]">
                  {isEs ? 'OVERRIDE AUDITADO' : 'AUDITED OVERRIDE'}
                </Badge>
              )}
              {strat.haltedReason && (
                <Badge variant="negative" className="text-[10px]">
                  {strat.haltedReason}
                </Badge>
              )}
            </div>
          </div>
        </TableCell>

        <TableCell className="font-mono text-xs tabular-nums">
          <div className="flex flex-col gap-0.5">
            <span className="font-semibold text-foreground">
              {strat.timeframes.join(' / ')}
            </span>
            <span className="text-[10.5px] uppercase text-muted-foreground">
              {strat.defaultRole}
            </span>
          </div>
        </TableCell>

        <TableCell>
          <Badge variant={getModeBadgeVariant(strat.mode)}>
            {formatModeLabel(strat.mode, isEs)}
          </Badge>
        </TableCell>

        <TableCell className="text-right font-mono text-xs tabular-nums">
          <Badge
            variant={
              strat.settledSamplesForTimeframe >= strat.targetSamples
                ? 'positive'
                : 'secondary'
            }
            className="font-mono tabular-nums"
          >
            {strat.settledSamplesForTimeframe} / {strat.targetSamples}
          </Badge>
        </TableCell>

        <TableCell className="text-right font-mono text-xs tabular-nums">
          {replay ? (
            <div className="flex flex-col items-end gap-0.5">
              <span
                className={cn(
                  'font-semibold',
                  replay.edgeVsBreakEvenPp >= 1
                    ? 'text-[var(--positive)]'
                    : replay.edgeVsBreakEvenPp < 0
                      ? 'text-[var(--negative)]'
                      : 'text-foreground',
                )}
              >
                {replay.winRatePct.toFixed(1)}% vs{' '}
                {replay.avgBreakEvenPct.toFixed(1)}% (
                {replay.edgeVsBreakEvenPp >= 0 ? '+' : ''}
                {replay.edgeVsBreakEvenPp.toFixed(1)}pp)
              </span>
              <span className="text-[10.5px] text-muted-foreground">
                {replay.wins}/{replay.tradeCount} ·{' '}
                {formatSignedMoney(replay.netPnlUsd)}
              </span>
            </div>
          ) : strat.liveStats.settledCount > 0 ? (
            <span className="text-muted-foreground">
              Live {strat.liveStats.winRatePct.toFixed(1)}% (
              {strat.liveStats.wins}/{strat.liveStats.settledCount})
            </span>
          ) : (
            <span className="text-[var(--text-subtle)]">—</span>
          )}
        </TableCell>

        <TableCell className="text-right font-mono text-xs font-semibold tabular-nums">
          {replay ? `${replay.wilsonLowerBoundPct.toFixed(1)}%` : '—'}
        </TableCell>

        <TableCell className="text-right font-mono text-xs tabular-nums">
          {replay ? (
            <span
              className={cn(
                brierDelta !== null && brierDelta <= 0
                  ? 'text-[var(--positive)]'
                  : brierDelta !== null && brierDelta > 0
                    ? 'text-[var(--negative)]'
                    : 'text-foreground',
              )}
            >
              {replay.brierModel.toFixed(3)}
              {brierDelta !== null
                ? ` (${brierDelta > 0 ? '+' : ''}${brierDelta.toFixed(3)})`
                : ''}
            </span>
          ) : (
            <span className="text-[var(--text-subtle)]">—</span>
          )}
        </TableCell>

        <TableCell
          className={cn(
            'text-right font-mono text-xs font-semibold tabular-nums',
            markoutCents !== null && markoutCents >= 0
              ? 'text-[var(--positive)]'
              : markoutCents !== null && markoutCents < -2
                ? 'text-[var(--negative)]'
                : 'text-muted-foreground',
          )}
        >
          {markoutCents !== null
            ? `${markoutCents >= 0 ? '+' : ''}${markoutCents.toFixed(2)}¢`
            : '—'}
        </TableCell>

        <TableCell className="text-right">
          <Button
            size="sm"
            variant="outline"
            disabled={replayBusy}
            onClick={() => void handleRunReplay(strat.id)}
          >
            <Play className="size-3" />
            <span>
              {replayBusy
                ? t('predictions.engineReplaying')
                : t('predictions.engineRunReplay')}
            </span>
          </Button>
        </TableCell>

        <TableCell className="min-w-[140px]">
          <Select
            value={strat.mode}
            disabled={modeBusy}
            onValueChange={(val) =>
              void handleSelectStrategyMode(
                strat,
                val as StrategyLifecycleMode,
              )
            }
          >
            <SelectTrigger
              aria-label={`Lifecycle mode for ${strat.name}`}
              className="h-7 font-mono text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIFECYCLE_MODES.map((m) => (
                <SelectItem key={m} value={m} className="font-mono text-xs">
                  {formatModeLabel(m, isEs)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </TableCell>
      </TableRow>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={
          isEs
            ? `Mercados de Predicción · ${activePair}`
            : `Prediction Markets · ${activePair}`
        }
        actions={
          onNavigate && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onNavigate('bot-run')}
            >
              <span>{t('predictions.runBot')}</span>
              <ArrowRight className="size-3.5" />
            </Button>
          )
        }
      />

      {/* Mode Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as PredictionsTab)}
          className="w-fit"
        >
          <TabsList aria-label={isEs ? 'Vistas de predicciones' : 'Prediction views'}>
            <TabsTrigger value="engine">
              {t('predictions.tabEngine')}
            </TabsTrigger>
            <TabsTrigger value="rules">
              {t('predictions.tabRules')}
            </TabsTrigger>
            <TabsTrigger value="simulator">
              {t('predictions.tabSimulator')}
            </TabsTrigger>
            <TabsTrigger value="polymarket">
              {t('predictions.tabPolymarket')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* ==================== TAB 0: ENGINE ==================== */}
      {tab === 'engine' && (
        <div className="flex flex-col gap-4">
          {/* Top Status Strip */}
          <Card>
            <CardHeader className="gap-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Activity className="size-3.5 text-primary" />
                  <CardTitle>{t('predictions.engineTelemetryTitle')}</CardTitle>
                  <Badge
                    variant={
                      engineStatus?.running
                        ? 'positive'
                        : engineStatus
                          ? 'secondary'
                          : 'outline'
                    }
                  >
                    {engineStatus?.running
                      ? isEs
                        ? 'ACTIVO'
                        : 'ACTIVE'
                      : engineStatus
                        ? isEs
                          ? 'EN ESPERA'
                          : 'IDLE'
                        : isEs
                          ? 'SIN CONEXIÓN'
                          : 'OFFLINE'}
                  </Badge>
                  <Badge
                    variant={
                      engineStatus?.oracle.connectedRtds
                        ? 'positive'
                        : 'secondary'
                    }
                  >
                    RTDS{' '}
                    {engineStatus?.oracle.connectedRtds ? 'LIVE' : 'STANDBY'}
                  </Badge>
                  <Badge
                    variant={
                      engineStatus?.oracle.connectedBinance
                        ? 'positive'
                        : 'secondary'
                    }
                  >
                    Binance 1s{' '}
                    {engineStatus?.oracle.connectedBinance ? 'LIVE' : 'STANDBY'}
                  </Badge>
                </div>

                <Button
                  size="sm"
                  variant="outline"
                  disabled={engineLoading}
                  onClick={() => void refreshEngineStatus()}
                >
                  <RefreshCw
                    className={cn(
                      'size-3.5',
                      engineLoading && 'animate-spin',
                    )}
                  />
                  <span>{isEs ? 'Actualizar' : 'Refresh'}</span>
                </Button>
              </div>
            </CardHeader>

            <CardContent className="flex flex-col gap-3">
              {engineError && (
                <div className="flex items-center gap-2 rounded-sm bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
                  <AlertTriangle className="size-3.5 shrink-0 text-primary" />
                  <span>{engineError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
                {/* 1. Oracle & Basis */}
                <div className="flex flex-col gap-1 rounded-sm bg-muted/30 px-3 py-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                    {t('predictions.engineOracleLabel')}
                  </span>
                  <strong className="font-mono text-sm font-semibold tabular-nums text-foreground">
                    {engineStatus?.oracle.chainlinkTwap60s !== null &&
                    engineStatus?.oracle.chainlinkTwap60s !== undefined
                      ? formatMoney(engineStatus.oracle.chainlinkTwap60s)
                      : '—'}{' '}
                    /{' '}
                    {engineStatus?.oracle.binancePrice !== null &&
                    engineStatus?.oracle.binancePrice !== undefined
                      ? formatMoney(engineStatus.oracle.binancePrice)
                      : '—'}
                  </strong>
                  <span
                    className={cn(
                      'font-mono text-[11px] tabular-nums',
                      engineStatus?.oracle.basisBps !== null &&
                        engineStatus?.oracle.basisBps !== undefined &&
                        Math.abs(engineStatus.oracle.basisBps) > 25
                        ? 'text-[var(--negative)]'
                        : 'text-muted-foreground',
                    )}
                  >
                    Basis:{' '}
                    {engineStatus?.oracle.basisBps !== null &&
                    engineStatus?.oracle.basisBps !== undefined
                      ? `${engineStatus.oracle.basisBps >= 0 ? '+' : ''}${engineStatus.oracle.basisBps.toFixed(1)} bps`
                      : '—'}
                  </span>
                </div>

                {/* 2. Realized Volatility */}
                <div className="flex flex-col gap-1 rounded-sm bg-muted/30 px-3 py-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                    {t('predictions.engineSigmaLabel')}
                  </span>
                  <strong className="font-mono text-sm font-semibold tabular-nums text-foreground">
                    {engineStatus?.oracle.sigma1m !== null &&
                    engineStatus?.oracle.sigma1m !== undefined
                      ? `${(engineStatus.oracle.sigma1m * 100).toFixed(3)}%`
                      : '—'}
                  </strong>
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {engineStatus?.oracle.median24hSigma1m !== null &&
                    engineStatus?.oracle.median24hSigma1m !== undefined
                      ? `24h med ${(engineStatus.oracle.median24hSigma1m * 100).toFixed(3)}%`
                      : '24h med —'}
                  </span>
                </div>

                {/* 3. G1 & G2 Safety Gates */}
                <div className="flex flex-col gap-1 rounded-sm bg-muted/30 px-3 py-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                    {t('predictions.engineGatesLabel')}
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge
                      variant={
                        engineStatus
                          ? engineStatus.gates.g1Passed
                            ? 'positive'
                            : 'negative'
                          : 'secondary'
                      }
                    >
                      G1{' '}
                      {engineStatus
                        ? engineStatus.gates.g1Passed
                          ? 'PASS'
                          : 'BLOCK'
                        : '—'}
                    </Badge>
                    <Badge
                      variant={
                        engineStatus
                          ? engineStatus.gates.g2Passed
                            ? 'positive'
                            : 'negative'
                          : 'secondary'
                      }
                    >
                      G2{' '}
                      {engineStatus
                        ? engineStatus.gates.g2Passed
                          ? 'PASS'
                          : 'BLOCK'
                        : '—'}
                    </Badge>
                  </div>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {engineStatus && engineStatus.gates.failureCodes.length > 0
                      ? engineStatus.gates.failureCodes.join(', ')
                      : isEs
                        ? 'Sin bloqueos activos'
                        : 'No active gate blocks'}
                  </span>
                </div>

                {/* 4. Collector Sample Counter */}
                <div className="flex flex-col gap-1 rounded-sm bg-muted/30 px-3 py-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                    {t('predictions.engineCollectorLabel')}
                  </span>
                  <strong className="font-mono text-xs font-semibold tabular-nums text-foreground">
                    5m:{' '}
                    {engineStatus?.collector.settledCountsByTimeframe['5m'] ??
                      0}
                    /500 · 15m:{' '}
                    {engineStatus?.collector.settledCountsByTimeframe['15m'] ??
                      0}
                    /500 · 1h:{' '}
                    {engineStatus?.collector.settledCountsByTimeframe['1h'] ??
                      0}
                    /500
                  </strong>
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {isEs ? 'Ventanas activas:' : 'Active windows:'}{' '}
                    {engineStatus?.collector.activeSlugs.length ?? 0}
                  </span>
                </div>

                {/* 5. Daily Canary Budget */}
                <div className="flex flex-col gap-1 rounded-sm bg-muted/30 px-3 py-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                    {t('predictions.engineCanaryBudgetLabel')}
                  </span>
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <strong className="font-mono text-sm font-semibold tabular-nums text-foreground">
                      {engineStatus?.canaryRisk.todayLossesCount ?? 0} /{' '}
                      {engineStatus?.canaryRisk.config.maxDailyLosses ??
                        canaryMaxLossesDraft}{' '}
                      {isEs ? 'pérdidas' : 'losses'}
                    </strong>
                    <Badge
                      variant={
                        engineStatus?.canaryRisk.killSwitchActive
                          ? 'negative'
                          : 'positive'
                      }
                    >
                      {engineStatus?.canaryRisk.killSwitchActive
                        ? 'HALTED'
                        : 'ARMED'}
                    </Badge>
                  </div>
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    BTC:{' '}
                    {formatMoney(
                      engineStatus?.canaryRisk.openBtcExposureUsd ?? 0,
                    )}{' '}
                    /{' '}
                    {formatMoney(
                      engineStatus?.canaryRisk.config
                        .maxConcurrentBtcExposureUsd ?? 15,
                    )}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Canary Controls Bar */}
          <Card>
            <CardHeader className="gap-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>{t('predictions.engineCanaryControlsTitle')}</CardTitle>
                <div className="flex flex-wrap items-center gap-2">
                  {engineFeedback && (
                    <Badge
                      variant={
                        engineFeedback.tone === 'positive'
                          ? 'positive'
                          : 'negative'
                      }
                    >
                      {engineFeedback.text}
                    </Badge>
                  )}
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={haltingAll}
                    onClick={() => void handleEmergencyHaltAll()}
                  >
                    <ShieldAlert className="size-3.5" />
                    <span>{t('predictions.engineManualHalt')}</span>
                  </Button>
                </div>
              </div>
            </CardHeader>

            <CardContent className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="engine-canary-stake">
                    {t('predictions.engineStakeUsd')}
                  </Label>
                  <Input
                    id="engine-canary-stake"
                    type="number"
                    min="1"
                    max="5"
                    step="0.5"
                    value={canaryStakeDraft}
                    onChange={(e) => {
                      setCanaryStakeDraft(e.target.value)
                      setCanaryDirty(true)
                    }}
                    className="font-mono tabular-nums"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="engine-canary-losses">
                    {t('predictions.engineMaxDailyLosses')}
                  </Label>
                  <Select
                    value={String(canaryMaxLossesDraft)}
                    onValueChange={(val) => {
                      setCanaryMaxLossesDraft(val === '4' ? 4 : 3)
                      setCanaryDirty(true)
                    }}
                  >
                    <SelectTrigger
                      id="engine-canary-losses"
                      className="font-mono tabular-nums"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="3" className="font-mono">
                        3 losses ($15/day)
                      </SelectItem>
                      <SelectItem value="4" className="font-mono">
                        4 losses ($20/day)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="engine-canary-btc-cap">
                    {t('predictions.engineMaxBtcExposure')}
                  </Label>
                  <Input
                    id="engine-canary-btc-cap"
                    type="number"
                    min="5"
                    max="50"
                    step="5"
                    value={canaryMaxExposureDraft}
                    onChange={(e) => {
                      setCanaryMaxExposureDraft(e.target.value)
                      setCanaryDirty(true)
                    }}
                    className="font-mono tabular-nums"
                  />
                </div>

                <div className="flex flex-col gap-1.5 lg:col-span-2">
                  <Label htmlFor="engine-macro-ts">
                    {t('predictions.engineMacroBlackout')}
                  </Label>
                  <div className="flex items-center gap-1.5">
                    <Input
                      id="engine-macro-ts"
                      type="text"
                      placeholder="2026-12-09T19:00:00Z"
                      value={macroTimestampInput}
                      onChange={(e) => setMacroTimestampInput(e.target.value)}
                      className="font-mono text-xs"
                    />
                    <Input
                      id="engine-macro-label"
                      aria-label="Macro event label"
                      type="text"
                      placeholder="FOMC / CPI"
                      value={macroLabelInput}
                      onChange={(e) => setMacroLabelInput(e.target.value)}
                      className="w-28 font-mono text-xs"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={savingCanary}
                      onClick={() => void handleAddMacroBlackout()}
                    >
                      <Plus className="size-3.5" />
                      <span>{t('predictions.engineAddBlackout')}</span>
                    </Button>
                  </div>
                </div>

                <div className="flex flex-col justify-end">
                  <Button
                    size="sm"
                    variant="default"
                    disabled={savingCanary}
                    onClick={() => void handleSaveCanaryConfig()}
                  >
                    <span>{t('predictions.engineSaveCanary')}</span>
                  </Button>
                </div>
              </div>

              {engineStatus &&
                engineStatus.macroBlackoutWindows.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-2">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {isEs ? 'Bloqueos activos (±30m):' : 'Active blackouts (±30m):'}
                    </span>
                    {engineStatus.macroBlackoutWindows.map((bw) => (
                      <Badge
                        key={`${bw.timestampMs}-${bw.label ?? ''}`}
                        variant="secondary"
                        className="gap-1.5 font-mono text-[11px]"
                      >
                        <span>
                          {bw.label ?? 'MACRO'} ·{' '}
                          {formatDateTime(bw.timestampMs)}
                        </span>
                        <button
                          type="button"
                          aria-label={`Remove ${bw.label ?? 'macro'} blackout`}
                          onClick={() =>
                            void handleRemoveMacroBlackout(bw.timestampMs)
                          }
                          className="cursor-pointer text-muted-foreground hover:text-foreground"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
            </CardContent>
          </Card>

          {/* Lane A — High-Hit-Rate (>90% Target) */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>{t('predictions.engineLaneATitle')}</CardTitle>
                <Badge variant="outline" className="font-mono">
                  {laneAStrategies.length}{' '}
                  {isEs ? 'estrategias' : 'strategies'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{isEs ? 'Estrategia' : 'Strategy'}</TableHead>
                    <TableHead>TF · Role</TableHead>
                    <TableHead>{isEs ? 'Modo' : 'Mode'}</TableHead>
                    <TableHead className="text-right">n / 500</TableHead>
                    <TableHead className="text-right">
                      {isEs ? 'Acierto vs Equilibrio' : 'Hit Rate vs Break-Even'}
                    </TableHead>
                    <TableHead className="text-right">Wilson 95% LB</TableHead>
                    <TableHead className="text-right">Brier (Δ)</TableHead>
                    <TableHead className="text-right">+30s Markout</TableHead>
                    <TableHead className="text-right">Replay</TableHead>
                    <TableHead>{isEs ? 'Cambiar Modo' : 'Lifecycle'}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {laneAStrategies.map(renderStrategyRow)}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Lane B — Edge & Maker (50–87% Hit Rate) */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>{t('predictions.engineLaneBTitle')}</CardTitle>
                <Badge variant="outline" className="font-mono">
                  {laneBStrategies.length}{' '}
                  {isEs ? 'estrategias' : 'strategies'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{isEs ? 'Estrategia' : 'Strategy'}</TableHead>
                    <TableHead>TF · Role</TableHead>
                    <TableHead>{isEs ? 'Modo' : 'Mode'}</TableHead>
                    <TableHead className="text-right">n / 500</TableHead>
                    <TableHead className="text-right">
                      {isEs ? 'Acierto vs Equilibrio' : 'Hit Rate vs Break-Even'}
                    </TableHead>
                    <TableHead className="text-right">Wilson 95% LB</TableHead>
                    <TableHead className="text-right">Brier (Δ)</TableHead>
                    <TableHead className="text-right">+30s Markout</TableHead>
                    <TableHead className="text-right">Replay</TableHead>
                    <TableHead>{isEs ? 'Cambiar Modo' : 'Lifecycle'}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {laneBStrategies.map(renderStrategyRow)}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Live Open & Recent Settled Tickets Table */}
          <Card>
            <CardHeader className="gap-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>{t('predictions.engineTicketsTitle')}</CardTitle>
                <div
                  role="group"
                  aria-label="Filter prediction tickets"
                  className="inline-flex h-8 items-center gap-0.5 rounded-sm bg-muted/45 p-0.5"
                >
                  <SegmentedButton
                    active={ticketFilter === 'all'}
                    onClick={() => setTicketFilter('all')}
                  >
                    {isEs ? 'Todos' : 'All'}
                  </SegmentedButton>
                  <SegmentedButton
                    active={ticketFilter === 'open'}
                    onClick={() => setTicketFilter('open')}
                  >
                    {isEs ? 'Abiertos' : 'Open'}
                  </SegmentedButton>
                  <SegmentedButton
                    active={ticketFilter === 'settled'}
                    onClick={() => setTicketFilter('settled')}
                  >
                    {isEs ? 'Resueltos' : 'Settled'}
                  </SegmentedButton>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {combinedTickets.length === 0 ? (
                <div className="p-4 text-xs text-muted-foreground">
                  {t('predictions.engineNoTickets')}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{isEs ? 'Estado' : 'Status'}</TableHead>
                      <TableHead>{isEs ? 'Hora (UTC)' : 'Time (UTC)'}</TableHead>
                      <TableHead>
                        {isEs ? 'Estrategia · Ventana' : 'Strategy · Window'}
                      </TableHead>
                      <TableHead>{isEs ? 'Lado · Rol' : 'Side · Role'}</TableHead>
                      <TableHead className="text-right">
                        {isEs ? 'Entrada · Stake' : 'Entry · Stake'}
                      </TableHead>
                      <TableHead className="text-right">
                        P_model / P_cal
                      </TableHead>
                      <TableHead className="text-right">+30s Markout</TableHead>
                      <TableHead className="text-right">
                        {isEs ? 'Resolución · PnL' : 'Resolution · PnL'}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {combinedTickets.map((trade) => (
                      <TableRow key={trade.id}>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge
                              variant={
                                trade.status === 'OPEN'
                                  ? 'default'
                                  : trade.status === 'SETTLED'
                                    ? 'secondary'
                                    : 'outline'
                              }
                            >
                              {trade.status}
                            </Badge>
                            <Badge variant="outline" className="font-mono">
                              {trade.mode.toUpperCase()}
                            </Badge>
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular-nums">
                          {formatDateTime(trade.entryTimeMs)}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            <span className="font-mono text-xs font-semibold text-foreground">
                              {trade.strategyId}
                            </span>
                            <span className="font-mono text-[10.5px] text-muted-foreground">
                              {trade.slug} ({trade.timeframe})
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Badge
                              variant={
                                trade.outcome === 'YES'
                                  ? 'positive'
                                  : 'negative'
                              }
                            >
                              {trade.outcome}
                            </Badge>
                            <span className="font-mono text-[10.5px] uppercase text-muted-foreground">
                              {trade.liquidityRole}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          <div className="flex flex-col items-end gap-0.5">
                            <span>
                              ${trade.entryPrice.toFixed(2)} ·{' '}
                              {formatMoney(trade.stakeUsd)}
                            </span>
                            <span className="text-[10.5px] text-muted-foreground">
                              fee ${trade.feeUsd.toFixed(3)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {(trade.pModel * 100).toFixed(1)}% /{' '}
                          {(trade.pCalibrated * 100).toFixed(1)}%
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right font-mono text-xs font-semibold tabular-nums',
                            trade.markout30s !== null && trade.markout30s >= 0
                              ? 'text-[var(--positive)]'
                              : trade.markout30s !== null &&
                                  trade.markout30s < -0.02
                                ? 'text-[var(--negative)]'
                                : 'text-muted-foreground',
                          )}
                        >
                          {trade.markout30s !== null
                            ? `${trade.markout30s >= 0 ? '+' : ''}${(trade.markout30s * 100).toFixed(2)}¢`
                            : '—'}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {trade.status === 'OPEN' ? (
                            <Badge variant="outline">OPEN</Badge>
                          ) : (
                            <div className="flex items-center justify-end gap-1.5">
                              {trade.won !== null && (
                                <Badge
                                  variant={trade.won ? 'positive' : 'negative'}
                                >
                                  {trade.won ? 'WON' : 'LOST'}
                                </Badge>
                              )}
                              <span
                                className={cn(
                                  'font-semibold',
                                  (trade.netPnlUsd ?? 0) >= 0
                                    ? 'text-[var(--positive)]'
                                    : 'text-[var(--negative)]',
                                )}
                              >
                                {trade.netPnlUsd !== null
                                  ? formatSignedMoney(trade.netPnlUsd)
                                  : '—'}
                              </span>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Force-Promote AlertDialog */}
          <AlertDialog
            open={pendingForcePromotion !== null}
            onOpenChange={(open) => {
              if (!open) setPendingForcePromotion(null)
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t('predictions.engineForcePromoteTitle')}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t('predictions.engineForcePromoteDesc')}
                </AlertDialogDescription>
              </AlertDialogHeader>

              {pendingForcePromotion && (
                <div className="flex flex-col gap-2.5 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-sm bg-muted/35 px-3 py-2 font-mono">
                    <span>
                      {pendingForcePromotion.strategyName} (
                      {pendingForcePromotion.fromMode.toUpperCase()} →{' '}
                      {pendingForcePromotion.toMode.toUpperCase()})
                    </span>
                    <Badge variant="warning">
                      n = {pendingForcePromotion.settledSamples} /{' '}
                      {pendingForcePromotion.targetSamples}
                    </Badge>
                  </div>

                  <ul className="flex flex-col gap-1 rounded-sm bg-muted/25 px-3 py-2 font-mono text-[11px] text-[var(--negative)]">
                    {pendingForcePromotion.failures.map((failure) => (
                      <li key={failure}>{failure}</li>
                    ))}
                  </ul>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="engine-override-reason">
                      {t('predictions.engineOverrideReason')}
                    </Label>
                    <Input
                      id="engine-override-reason"
                      type="text"
                      placeholder="e.g. Manual risk manager canary approval ($5 cap)"
                      value={overrideReasonDraft}
                      onChange={(e) => setOverrideReasonDraft(e.target.value)}
                    />
                  </div>
                </div>
              )}

              <AlertDialogFooter>
                <AlertDialogCancel>
                  {t('settings.cancel')}
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => void handleConfirmForcePromotion()}
                >
                  {t('predictions.engineForcePromoteConfirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}

      {/* ==================== TAB 1: RULES & EDGE (RESEARCH ONLY) ==================== */}
      {tab === 'rules' && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              label={
                isEs
                  ? `Win Rate Medio (${activeTimeframe})`
                  : `Avg Win Rate (${activeTimeframe})`
              }
              value={`${ruleSummary.avgWr.toFixed(1)}%`}
              hint={
                isEs
                  ? 'Acierto bruto tras cooldown sin solapamiento'
                  : 'Raw hit rate with non-overlapping cooldown'
              }
              tone={ruleSummary.avgWr >= 55 ? 'positive' : 'neutral'}
            />
            <MetricCard
              label={isEs ? 'Lift Medio vs Tasa Base' : 'Avg Lift vs Base Rate'}
              value={`${ruleSummary.avgLift >= 0 ? '+' : ''}${ruleSummary.avgLift.toFixed(1)}%`}
              hint={
                isEs
                  ? 'Ventaja real sobre comprar sin señal'
                  : 'True gain over unconditional base rate'
              }
              tone={ruleSummary.avgLift > 0 ? 'positive' : 'negative'}
            />
            <MetricCard
              label={isEs ? 'Señales Activas Ahora' : 'Signals Active Now'}
              value={`${ruleSummary.activeCount} / ${ruleStats.length}`}
              hint={
                isEs
                  ? 'Condición cumplida en la última vela'
                  : 'Condition met on latest closed candle'
              }
              tone={ruleSummary.activeCount > 0 ? 'positive' : 'neutral'}
            />
            <MetricCard
              label={
                isEs
                  ? 'Mejor Edge Neto (Modelado)'
                  : 'Best Net Edge (Modeled)'
              }
              value={`${ruleSummary.bestEdge >= 0 ? '+' : ''}${ruleSummary.bestEdge.toFixed(1)}%`}
              hint={ruleSummary.bestTitle}
              tone={ruleSummary.bestEdge > 0 ? 'positive' : 'neutral'}
            />
          </div>

          {expandedRule && candleState.status === 'success' && (
            <PredictionRuleDetail
              key={`${expandedRule.id}-${activePair}-${activeTimeframe}`}
              rule={expandedRule}
              marketStats={expandedRuleMarketStats}
              candles={candleState.data}
              pair={activePair}
              onClose={() => {
                setExpandedRuleId(null)
                onClearFocusTarget?.()
              }}
              onOpenCharts={
                onOpenTerminalForPair
                  ? () => onOpenTerminalForPair(activePair)
                  : onNavigate
                    ? () => onNavigate('terminal')
                    : undefined
              }
            />
          )}

          <Card>
            <CardHeader className="gap-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Activity className="size-3.5 text-primary" />
                  <CardTitle>{t('predictions.rulesResearchTitle')}</CardTitle>
                </div>
                <Badge variant="warning">
                  {t('botConfig.researchOnlyBadge')}
                </Badge>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div
                  role="group"
                  aria-label={isEs ? 'Familia' : 'Family'}
                  className="inline-flex h-8 items-center gap-0.5 rounded-sm bg-muted/45 p-0.5"
                >
                  <SegmentedButton
                    active={ruleFamily === 'flare20'}
                    onClick={() => setRuleFamily('flare20')}
                  >
                    20 FLARE
                  </SegmentedButton>
                  <SegmentedButton
                    active={ruleFamily === 'directional'}
                    onClick={() => setRuleFamily('directional')}
                  >
                    {isEs ? '8 Direccionales' : '8 Directional'}
                  </SegmentedButton>
                </div>

                <div
                  role="group"
                  aria-label={isEs ? 'Moneda' : 'Pair'}
                  className="inline-flex h-8 items-center gap-0.5 rounded-sm bg-muted/45 p-0.5"
                >
                  {availablePairs.map((opt) => (
                    <SegmentedButton
                      key={opt}
                      active={pair === opt}
                      onClick={() => setPair(opt)}
                    >
                      {opt}
                    </SegmentedButton>
                  ))}
                </div>

                <div
                  role="group"
                  aria-label={isEs ? 'Temporalidad' : 'Timeframe'}
                  className="inline-flex h-8 items-center gap-0.5 rounded-sm bg-muted/45 p-0.5"
                >
                  {visibleTimeframes.map((tf) => (
                    <SegmentedButton
                      key={tf.id}
                      active={activeTimeframe === tf.id}
                      onClick={() => setTimeframe(tf.id)}
                    >
                      {tf.label}
                    </SegmentedButton>
                  ))}
                </div>

                <div className="flex items-center gap-1.5 rounded-sm bg-muted/40 px-2 py-0.5">
                  <Label
                    htmlFor="pred-rules-spread"
                    className="font-mono text-[10px] tracking-normal normal-case text-muted-foreground"
                  >
                    Spread (¢)
                  </Label>
                  <Input
                    id="pred-rules-spread"
                    type="number"
                    min="0"
                    max="20"
                    step="0.5"
                    value={spreadCents}
                    onChange={(e) => setSpreadCents(e.target.value)}
                    className="h-6 w-14 bg-card px-1.5 text-right text-[11px]"
                  />
                </div>

                <div className="flex items-center gap-1.5 rounded-sm bg-muted/40 px-2 py-0.5">
                  <Label
                    htmlFor="pred-rules-fee"
                    className="font-mono text-[10px] tracking-normal normal-case text-muted-foreground"
                  >
                    Fee (%)
                  </Label>
                  <Input
                    id="pred-rules-fee"
                    type="number"
                    min="0"
                    max="10"
                    step="0.25"
                    value={feePct}
                    onChange={(e) => setFeePct(e.target.value)}
                    className="h-6 w-14 bg-card px-1.5 text-right text-[11px]"
                  />
                </div>

                <label
                  htmlFor="pred-rules-cooldown"
                  className="flex h-8 cursor-pointer items-center gap-2 rounded-sm bg-muted/40 px-2.5 font-mono text-[11px] font-medium text-foreground select-none"
                >
                  <Switch
                    id="pred-rules-cooldown"
                    checked={useCooldown}
                    onCheckedChange={setUseCooldown}
                  />
                  <span>Cooldown</span>
                </label>

                {onNavigate && (
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => onNavigate('terminal')}
                  >
                    <Maximize2 className="size-3.5" />
                    <span>{isEs ? 'Gráficos' : 'Charts'}</span>
                  </Button>
                )}
              </div>
            </CardHeader>

            <CardContent className="p-0">
              {candleState.status === 'loading' && (
                <div className="flex flex-col gap-2 p-4">
                  <div className="flex items-center justify-between font-mono text-xs text-muted-foreground">
                    <span>
                      {isEs
                        ? `Evaluando margen y tasa base de ${activePair} sobre 500 velas...`
                        : `Evaluating net edge and base rate for ${activePair}...`}
                    </span>
                    <Badge variant="secondary">500 candles</Badge>
                  </div>
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-4/5" />
                </div>
              )}

              {candleState.status === 'error' && (
                <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="flex items-center gap-2 font-mono text-xs text-[var(--negative)]">
                    <AlertTriangle className="size-4 shrink-0" />
                    <span>{candleState.message}</span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setReloadKey((k) => k + 1)}
                  >
                    <RefreshCw className="size-3.5" />
                    <span>{isEs ? 'Reintentar' : 'Retry'}</span>
                  </Button>
                </div>
              )}

              {candleState.status === 'success' && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">#</TableHead>
                      <TableHead>
                        {isEs
                          ? 'Regla (pasa el cursor para ver condición)'
                          : 'Rule (hover for condition)'}
                      </TableHead>
                      <TableHead>{isEs ? 'Estado' : 'Status'}</TableHead>
                      <TableHead>{isEs ? 'Lado · Entrada' : 'Side · Entry'}</TableHead>
                      <TableHead className="text-right">
                        {isEs ? 'Aciertos' : 'Hits'}
                      </TableHead>
                      <TableHead className="text-right">Win Rate</TableHead>
                      <TableHead className="text-right">
                        {isEs ? 'Tasa Base' : 'Base Rate'}
                      </TableHead>
                      <TableHead className="text-right">Lift</TableHead>
                      <TableHead className="text-right">
                        {isEs ? 'Edge Neto' : 'Net Edge'}
                      </TableHead>
                      <TableHead className="text-right">1/4 Kelly</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ruleStats.map((item) => {
                      const isExpanded = expandedRuleId === item.ruleId
                      return (
                      <TableRow
                        key={item.ruleId}
                        onClick={() =>
                          setExpandedRuleId(isExpanded ? null : item.ruleId)
                        }
                        className={cn(
                          'cursor-pointer',
                          isExpanded && 'bg-primary/10',
                        )}
                      >
                        <TableCell className="text-muted-foreground">
                          #{item.number}
                        </TableCell>
                        <TableCell className="min-w-[230px] whitespace-normal">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div
                                title={item.contractQuestion}
                                className="flex cursor-help flex-col gap-0.5"
                              >
                                <span className="flex items-center gap-1.5 font-sans text-xs font-semibold text-foreground">
                                  {item.title}
                                  <Info className="size-3 shrink-0 text-[var(--text-subtle)]" />
                                </span>
                                <span className="font-mono text-[10.5px] text-muted-foreground">
                                  {item.category} · {item.horizonBars}{' '}
                                  {isEs ? 'velas' : 'bars'} · Wilson{' '}
                                  {item.wilsonLowerBoundPct.toFixed(1)}%
                                </span>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs font-sans text-[11px] leading-snug">
                              {item.contractQuestion}
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={item.currentlyActive ? 'positive' : 'secondary'}
                          >
                            {item.currentlyActive
                              ? isEs
                                ? 'ACTIVA'
                                : 'ACTIVE'
                              : isEs
                                ? 'ESPERA'
                                : 'WAIT'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {item.side ? (
                            <Badge
                              variant={
                                item.side === 'YES' ? 'positive' : 'negative'
                              }
                            >
                              {item.side} @ ${item.entryPrice.toFixed(2)}
                            </Badge>
                          ) : (
                            <span className="font-mono text-[11px] text-[var(--text-subtle)]">
                              {isEs ? 'Sin edge' : 'No edge'}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {item.hits} / {item.triggers}
                        </TableCell>
                        <TableCell className="text-right font-semibold">
                          {item.winRatePct.toFixed(1)}%
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {item.baseRatePct.toFixed(1)}%
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right font-semibold',
                            item.liftPct > 0
                              ? 'text-[var(--positive)]'
                              : item.liftPct < 0
                                ? 'text-[var(--negative)]'
                                : 'text-muted-foreground',
                          )}
                        >
                          {item.liftPct > 0 ? '+' : ''}
                          {item.liftPct.toFixed(1)}%
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right font-semibold',
                            item.netEdgePct > 0
                              ? 'text-[var(--positive)]'
                              : 'text-muted-foreground',
                          )}
                        >
                          {item.netEdgePct > 0 ? '+' : ''}
                          {item.netEdgePct.toFixed(1)}%
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {item.kellyQuarterPct.toFixed(1)}%
                        </TableCell>
                      </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ==================== TAB 2: SIMULATOR & MONTE CARLO ==================== */}
      {tab === 'simulator' && (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader className="gap-2.5">
              <CardTitle>
                {isEs
                  ? 'Parámetros de Estrategia y Banca'
                  : 'Strategy & Bankroll Parameters'}
              </CardTitle>

              <div className="flex flex-wrap items-center gap-2">
                <div
                  role="group"
                  aria-label={isEs ? 'Familia' : 'Family'}
                  className="inline-flex h-8 items-center gap-0.5 rounded-sm bg-muted/45 p-0.5"
                >
                  <SegmentedButton
                    active={ruleFamily === 'flare20'}
                    onClick={() => setRuleFamily('flare20')}
                  >
                    20 FLARE
                  </SegmentedButton>
                  <SegmentedButton
                    active={ruleFamily === 'directional'}
                    onClick={() => setRuleFamily('directional')}
                  >
                    {isEs ? '8 Direccionales' : '8 Directional'}
                  </SegmentedButton>
                </div>

                <div
                  role="group"
                  aria-label={isEs ? 'Temporalidad' : 'Timeframe'}
                  className="inline-flex h-8 items-center gap-0.5 rounded-sm bg-muted/45 p-0.5"
                >
                  {visibleTimeframes.map((tf) => (
                    <SegmentedButton
                      key={tf.id}
                      active={activeTimeframe === tf.id}
                      onClick={() => setTimeframe(tf.id)}
                    >
                      {tf.label}
                    </SegmentedButton>
                  ))}
                </div>
              </div>
            </CardHeader>

            <CardContent className="flex flex-col gap-3.5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sim-pair">{isEs ? 'Par' : 'Pair'}</Label>
                  <Select value={pair} onValueChange={setPair}>
                    <SelectTrigger id="sim-pair">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {availablePairs.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sim-sizing">
                    {isEs ? 'Dimensionado' : 'Sizing'}
                  </Label>
                  <Select
                    value={sizing}
                    onValueChange={(value) => setSizing(value as SizingMode)}
                  >
                    <SelectTrigger id="sim-sizing">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="quarter-kelly">1/4 Kelly</SelectItem>
                      <SelectItem value="full-kelly">
                        {isEs ? 'Kelly Completo' : 'Full Kelly'}
                      </SelectItem>
                      <SelectItem value="fixed">
                        {isEs ? 'Monto Fijo (%)' : 'Fixed (%)'}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <NumberField
                  name="sim-bankroll"
                  label={isEs ? 'Banca Inicial' : 'Initial Bankroll'}
                  unit="USD"
                  hint={isEs ? 'Capital de partida' : 'Starting capital'}
                  value={bankroll}
                  onChange={(e) => setBankroll(e.target.value)}
                />

                {sizing === 'fixed' ? (
                  <NumberField
                    name="sim-fixed"
                    label={isEs ? 'Apuesta Fija' : 'Fixed Stake'}
                    unit="%"
                    hint={isEs ? '% de banca inicial' : '% of initial bankroll'}
                    value={fixedStakePct}
                    onChange={(e) => setFixedStakePct(e.target.value)}
                  />
                ) : (
                  <NumberField
                    name="sim-max-stake"
                    label={isEs ? 'Tope por Ticket' : 'Max Ticket Cap'}
                    unit="%"
                    hint={isEs ? 'Límite de equity por apuesta' : 'Max equity per ticket'}
                    value={maxStakePct}
                    onChange={(e) => setMaxStakePct(e.target.value)}
                  />
                )}

                <NumberField
                  name="sim-min-edge"
                  label={isEs ? 'Margen Mínimo' : 'Min Net Edge'}
                  unit="%"
                  hint={isEs ? 'Filtro de entrada' : 'Entry threshold'}
                  value={minEdgePct}
                  onChange={(e) => setMinEdgePct(e.target.value)}
                />

                <NumberField
                  name="sim-confluence"
                  label={isEs ? 'Confluencia Mín.' : 'Min Confluence'}
                  unit={isEs ? 'reglas' : 'rules'}
                  hint={isEs ? 'Reglas activas a la vez' : 'Simultaneous rules'}
                  value={minConfluence}
                  onChange={(e) => setMinConfluence(e.target.value)}
                />

                <NumberField
                  name="sim-spread"
                  label="Spread"
                  unit="¢"
                  hint={isEs ? 'Diferencia bid-ask' : 'Bid-ask spread'}
                  value={spreadCents}
                  onChange={(e) => setSpreadCents(e.target.value)}
                />

                <NumberField
                  name="sim-fee"
                  label={isEs ? 'Comisión' : 'Fee'}
                  unit="%"
                  hint={isEs ? 'Sobre el nocional' : 'On entry notional'}
                  value={feePct}
                  onChange={(e) => setFeePct(e.target.value)}
                />

                <NumberField
                  name="sim-train"
                  label={isEs ? 'Entrenamiento' : 'Train Split'}
                  unit="%"
                  hint={
                    isEs
                      ? 'Resto = prueba fuera de muestra'
                      : 'Rest = out-of-sample test'
                  }
                  value={trainRatioPct}
                  onChange={(e) => setTrainRatioPct(e.target.value)}
                />
              </div>

              <div className="flex flex-wrap items-center gap-4 pt-2">
                <label
                  htmlFor="sim-cooldown"
                  className="flex cursor-pointer items-center gap-2 text-xs text-foreground select-none"
                >
                  <Switch
                    id="sim-cooldown"
                    checked={useCooldown}
                    onCheckedChange={setUseCooldown}
                  />
                  <span>
                    {isEs
                      ? 'Cooldown sin solapamiento por regla'
                      : 'Non-overlapping cooldown per rule'}
                  </span>
                </label>

                <label
                  htmlFor="sim-allow-no"
                  className="flex cursor-pointer items-center gap-2 text-xs text-foreground select-none"
                >
                  <Switch
                    id="sim-allow-no"
                    checked={allowNo}
                    onCheckedChange={setAllowNo}
                  />
                  <span>
                    {isEs
                      ? 'Permitir lado NO cuando el edge esté invertido'
                      : 'Allow NO side when edge is inverted'}
                  </span>
                </label>
              </div>
            </CardContent>
          </Card>

          {candleState.status === 'loading' && (
            <Card>
              <CardContent className="flex flex-col gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  {isEs
                    ? 'Ejecutando simulación fuera de muestra...'
                    : 'Running out-of-sample simulation...'}
                </span>
                <Skeleton className="h-24 w-full" />
              </CardContent>
            </Card>
          )}

          {simResult && simResult.insufficientData && (
            <Card>
              <CardContent className="font-mono text-xs text-muted-foreground">
                {isEs
                  ? 'No hay suficientes velas para separar entrenamiento y prueba en esta configuración.'
                  : 'Not enough candles to split train and test windows.'}
              </CardContent>
            </Card>
          )}

          {simResult && !simResult.insufficientData && (
            <>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard
                  label={
                    isEs
                      ? 'Capital Final (Prueba)'
                      : 'Final Bankroll (Test)'
                  }
                  value={formatMoney(simResult.metrics.finalBankroll)}
                  hint={`ROI ${simResult.metrics.roiPct >= 0 ? '+' : ''}${simResult.metrics.roiPct.toFixed(1)}%`}
                  tone={
                    simResult.metrics.roiPct > 0
                      ? 'positive'
                      : simResult.metrics.roiPct < 0
                        ? 'negative'
                        : 'neutral'
                  }
                />
                <MetricCard
                  label={isEs ? 'Drawdown Máximo' : 'Max Drawdown'}
                  value={`${simResult.metrics.maxDrawdownPct.toFixed(1)}%`}
                  hint={
                    isEs
                      ? `Racha máx. pérdidas: ${simResult.metrics.longestLosingStreak}`
                      : `Longest loss streak: ${simResult.metrics.longestLosingStreak}`
                  }
                  tone={simResult.metrics.maxDrawdownPct > 20 ? 'negative' : 'neutral'}
                />
                <MetricCard
                  label={isEs ? 'Tickets y Acierto' : 'Tickets & Win Rate'}
                  value={`${simResult.metrics.winRatePct.toFixed(1)}%`}
                  hint={`${simResult.metrics.wins}/${simResult.metrics.tickets} · YES ${simResult.metrics.yesTickets} / NO ${simResult.metrics.noTickets}`}
                  tone={simResult.metrics.winRatePct >= 55 ? 'positive' : 'neutral'}
                />
                <MetricCard
                  label={isEs ? 'Edge Medio y PF' : 'Avg Edge & PF'}
                  value={`+${simResult.metrics.avgEdgePct.toFixed(1)}%`}
                  hint={`PF: ${simResult.metrics.profitFactor?.toFixed(2) ?? '—'} · Skipped: ${simResult.metrics.skippedNoEdge + simResult.metrics.skippedConfluence}`}
                  tone={simResult.metrics.avgEdgePct > 0 ? 'positive' : 'neutral'}
                />
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>
                    {isEs
                      ? 'Curva de Capital (Fuera de Muestra)'
                      : 'Equity Curve (Out-of-Sample)'}
                  </CardTitle>
                  {simResult.testFromTime && simResult.testToTime && (
                    <Badge variant="secondary" className="font-mono">
                      {formatDateTime(simResult.testFromTime)} →{' '}
                      {formatDateTime(simResult.testToTime)}
                    </Badge>
                  )}
                </CardHeader>
                <CardContent className="p-0">
                  <EquityChart points={equityPoints} />
                </CardContent>
              </Card>

              {simResult.monteCarlo && (
                <Card>
                  <CardHeader>
                    <CardTitle>
                      {isEs
                        ? `Monte Carlo (${simResult.monteCarlo.runs} permutaciones)`
                        : `Monte Carlo (${simResult.monteCarlo.runs} runs)`}
                    </CardTitle>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {isEs
                        ? 'Riesgo de secuencia sobre tickets'
                        : 'Sequence-risk permutations'}
                    </span>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
                      <div className="flex flex-col gap-1 rounded-sm bg-muted/30 px-3 py-2">
                        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                          {isEs ? 'Capital P5' : 'P5 Bankroll'}
                        </span>
                        <strong className="font-mono text-sm font-semibold tabular-nums text-foreground">
                          {formatMoney(simResult.monteCarlo.finalP5)}
                        </strong>
                      </div>
                      <div className="flex flex-col gap-1 rounded-sm bg-muted/30 px-3 py-2">
                        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                          {isEs ? 'Capital P50' : 'P50 Median'}
                        </span>
                        <strong className="font-mono text-sm font-semibold tabular-nums text-foreground">
                          {formatMoney(simResult.monteCarlo.finalP50)}
                        </strong>
                      </div>
                      <div className="flex flex-col gap-1 rounded-sm bg-muted/30 px-3 py-2">
                        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                          {isEs ? 'Capital P95' : 'P95 High'}
                        </span>
                        <strong className="font-mono text-sm font-semibold tabular-nums text-[var(--positive)]">
                          {formatMoney(simResult.monteCarlo.finalP95)}
                        </strong>
                      </div>
                      <div className="flex flex-col gap-1 rounded-sm bg-muted/30 px-3 py-2">
                        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                          Drawdown P50 / P95
                        </span>
                        <strong className="font-mono text-sm font-semibold tabular-nums text-foreground">
                          {simResult.monteCarlo.maxDrawdownP50.toFixed(1)}% /{' '}
                          {simResult.monteCarlo.maxDrawdownP95.toFixed(1)}%
                        </strong>
                      </div>
                      <div className="flex flex-col gap-1 rounded-sm bg-muted/30 px-3 py-2">
                        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                          {isEs ? 'Riesgo < 50%' : 'Ruin (< 50%)'}
                        </span>
                        <strong
                          className={cn(
                            'font-mono text-sm font-semibold tabular-nums',
                            simResult.monteCarlo.ruinPct > 0
                              ? 'text-[var(--negative)]'
                              : 'text-[var(--positive)]',
                          )}
                        >
                          {simResult.monteCarlo.ruinPct.toFixed(1)}%
                        </strong>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {simResult.tickets.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>
                      {isEs
                        ? `Últimos Tickets Simulados (${Math.min(30, simResult.tickets.length)} de ${simResult.tickets.length})`
                        : `Recent Simulated Tickets (${Math.min(30, simResult.tickets.length)} of ${simResult.tickets.length})`}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>#</TableHead>
                          <TableHead>
                            {isEs ? 'Entrada (UTC)' : 'Entry (UTC)'}
                          </TableHead>
                          <TableHead>{isEs ? 'Lado' : 'Side'}</TableHead>
                          <TableHead className="text-right">
                            {isEs ? 'Precio' : 'Price'}
                          </TableHead>
                          <TableHead className="text-right">Edge</TableHead>
                          <TableHead className="text-right">Confl.</TableHead>
                          <TableHead className="text-right">Stake</TableHead>
                          <TableHead>{isEs ? 'Resultado' : 'Outcome'}</TableHead>
                          <TableHead className="text-right">PnL</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {[...simResult.tickets]
                          .reverse()
                          .slice(0, 30)
                          .map((tk, idx) => (
                            <TableRow key={`${tk.ruleId}-${tk.entryIndex}-${idx}`}>
                              <TableCell className="text-muted-foreground">
                                #{tk.ruleNumber}
                              </TableCell>
                              <TableCell>{formatDateTime(tk.entryTime)}</TableCell>
                              <TableCell>
                                <Badge
                                  variant={
                                    tk.side === 'YES' ? 'positive' : 'negative'
                                  }
                                >
                                  {tk.side}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right">
                                ${tk.price.toFixed(2)}
                              </TableCell>
                              <TableCell className="text-right text-[var(--positive)]">
                                +{(tk.edge * 100).toFixed(1)}%
                              </TableCell>
                              <TableCell className="text-right text-muted-foreground">
                                {tk.confluence}
                              </TableCell>
                              <TableCell className="text-right">
                                {formatMoney(tk.stake)}
                              </TableCell>
                              <TableCell>
                                <Badge variant={tk.won ? 'positive' : 'negative'}>
                                  {tk.won
                                    ? isEs
                                      ? 'GANADO'
                                      : 'WON'
                                    : isEs
                                      ? 'PERDIDO'
                                      : 'LOST'}
                                </Badge>
                              </TableCell>
                              <TableCell
                                className={cn(
                                  'text-right font-semibold',
                                  tk.pnl >= 0
                                    ? 'text-[var(--positive)]'
                                    : 'text-[var(--negative)]',
                                )}
                              >
                                {formatSignedMoney(tk.pnl)}
                              </TableCell>
                            </TableRow>
                          ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      )}

      {/* ==================== TAB 3: LIVE MARKET (POLYMARKET) ==================== */}
      {tab === 'polymarket' && (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader className="gap-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>
                  {isEs
                    ? 'Contratos "Bitcoin Up or Down" · Polymarket'
                    : 'Live "Bitcoin Up or Down" Contracts · Polymarket'}
                </CardTitle>
                <Badge variant="outline">Chainlink BTC/USD</Badge>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div
                  role="group"
                  aria-label={
                    isEs ? 'Ventana Polymarket' : 'Polymarket timeframe'
                  }
                  className="inline-flex h-8 items-center gap-0.5 rounded-sm bg-muted/45 p-0.5"
                >
                  {(['5m', '15m', '1h'] as PolymarketTimeframe[]).map((tf) => (
                    <SegmentedButton
                      key={tf}
                      active={polyTf === tf}
                      onClick={() => setPolyTf(tf)}
                    >
                      {tf}
                    </SegmentedButton>
                  ))}
                </div>

                <div
                  role="group"
                  aria-label={isEs ? 'Cantidad de ventanas' : 'Window count'}
                  className="inline-flex h-8 items-center gap-0.5 rounded-sm bg-muted/45 p-0.5"
                >
                  {([24, 48] as const).map((n) => (
                    <SegmentedButton
                      key={n}
                      active={polyLimit === n}
                      onClick={() => setPolyLimit(n)}
                    >
                      {`${n} ${isEs ? 'ventanas' : 'windows'}`}
                    </SegmentedButton>
                  ))}
                </div>

                <Button
                  size="sm"
                  variant="outline"
                  onClick={loadPolymarket}
                  disabled={polyState.status === 'loading'}
                >
                  <RefreshCw
                    className={cn(
                      'size-3.5',
                      polyState.status === 'loading' && 'animate-spin',
                    )}
                  />
                  <span>{isEs ? 'Actualizar' : 'Refresh'}</span>
                </Button>
              </div>
            </CardHeader>
          </Card>

          {(polyState.status === 'loading' || polyState.status === 'idle') && (
            <Card>
              <CardContent className="flex flex-col gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  {isEs
                    ? `Consultando ventanas reales ${polyTf} en Polymarket...`
                    : `Fetching real ${polyTf} windows from Polymarket...`}
                </span>
                <Skeleton className="h-20 w-full" />
              </CardContent>
            </Card>
          )}

          {polyState.status === 'error' && (
            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 font-mono text-xs text-[var(--negative)]">
                  <AlertTriangle className="size-4 shrink-0" />
                  <span>{polyState.message}</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={loadPolymarket}
                >
                  <RefreshCw className="size-3.5" />
                  <span>{isEs ? 'Reintentar' : 'Retry'}</span>
                </Button>
              </CardContent>
            </Card>
          )}

          {polyState.status === 'success' && polyAnalysis && (
            <>
              {polyAnalysis.openWindow && (
                <Card>
                  <CardContent className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-col gap-1">
                      <strong className="font-sans text-xs font-semibold text-foreground sm:text-sm">
                        {polyAnalysis.openWindow.question ??
                          polyAnalysis.openWindow.slug}
                      </strong>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {isEs ? 'Ventana abierta' : 'Open window'} ·{' '}
                        {formatDateTime(polyAnalysis.openWindow.startTime)} →{' '}
                        {formatDateTime(polyAnalysis.openWindow.endTime)}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline">
                        UP Mid:{' '}
                        {polyAnalysis.openWindow.upPriceNow !== null
                          ? `$${polyAnalysis.openWindow.upPriceNow.toFixed(2)}`
                          : '—'}
                      </Badge>
                      <Badge variant="secondary">
                        Bid/Ask:{' '}
                        {polyAnalysis.openWindow.bestBid !== null &&
                          polyAnalysis.openWindow.bestAsk !== null
                          ? `$${polyAnalysis.openWindow.bestBid.toFixed(2)} / $${polyAnalysis.openWindow.bestAsk.toFixed(2)}`
                          : '—'}
                      </Badge>
                      <Badge
                        variant={
                          polyAnalysis.liveSignals.length > 0
                            ? 'positive'
                            : 'secondary'
                        }
                      >
                        {isEs ? 'Señales:' : 'Signals:'}{' '}
                        {polyAnalysis.liveSignals.length}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              )}

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard
                  label={isEs ? 'Ventanas Resueltas' : 'Resolved Windows'}
                  value={`${polyAnalysis.resolvedCount} / ${polyState.data.windows.length}`}
                  hint={
                    isEs
                      ? 'Con cierre confirmado en Polymarket'
                      : 'Confirmed settled on Polymarket'
                  }
                />
                <MetricCard
                  label={isEs ? 'Tasa UP Real' : 'Actual UP Rate'}
                  value={`${polyAnalysis.resolvedUpPct.toFixed(1)}%`}
                  hint={
                    isEs
                      ? 'Proporción real de cierres UP'
                      : 'Share of windows settled UP'
                  }
                />
                <MetricCard
                  label={
                    isEs ? 'Simulación Precio Real' : 'Real-Price Backtest'
                  }
                  value={
                    polyAnalysis.realSim.metrics.tickets > 0
                      ? `${polyAnalysis.realSim.metrics.roiPct >= 0 ? '+' : ''}${polyAnalysis.realSim.metrics.roiPct.toFixed(1)}%`
                      : '—'
                  }
                  hint={
                    polyAnalysis.realSim.metrics.tickets > 0
                      ? `${polyAnalysis.realSim.metrics.wins}/${polyAnalysis.realSim.metrics.tickets} tickets (WR ${polyAnalysis.realSim.metrics.winRatePct.toFixed(1)}%)`
                      : isEs
                        ? 'Sin tickets suficientes en esta muestra'
                        : 'Not enough matched tickets in sample'
                  }
                  tone={
                    polyAnalysis.realSim.metrics.roiPct > 0
                      ? 'positive'
                      : polyAnalysis.realSim.metrics.roiPct < 0
                        ? 'negative'
                        : 'neutral'
                  }
                />
                <MetricCard
                  label={isEs ? 'Errores de Consulta' : 'Fetch Warnings'}
                  value={String(polyState.data.errors.length)}
                  hint={
                    isEs
                      ? 'Ventanas sin respuesta del servidor'
                      : 'Windows without upstream response'
                  }
                  tone={polyState.data.errors.length > 0 ? 'negative' : 'positive'}
                />
              </div>

              <Card>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>
                          {isEs ? 'Ventana (UTC)' : 'Window (UTC)'}
                        </TableHead>
                        <TableHead>{isEs ? 'Estado' : 'Status'}</TableHead>
                        <TableHead className="text-right">
                          {isEs ? 'UP Apertura' : 'UP Open'}
                        </TableHead>
                        <TableHead className="text-right">
                          {isEs ? 'UP Actual' : 'UP Now'}
                        </TableHead>
                        <TableHead>{isEs ? 'Resolución' : 'Outcome'}</TableHead>
                        <TableHead>
                          {isEs
                            ? 'Mejor Señal Direccional'
                            : 'Top Directional Signal'}
                        </TableHead>
                        <TableHead className="text-right">
                          {isEs ? 'Edge Neto' : 'Net Edge'}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {polyAnalysis.rows.map(({ win, bestPick }) => (
                        <TableRow key={win.slug}>
                          <TableCell>{formatDateTime(win.startTime)}</TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                win.status === 'open' ? 'positive' : 'secondary'
                              }
                            >
                              {win.status === 'open'
                                ? isEs
                                  ? 'ABIERTA'
                                  : 'OPEN'
                                : win.status === 'closed'
                                  ? isEs
                                    ? 'CERRADA'
                                    : 'CLOSED'
                                  : isEs
                                    ? 'SIN DATO'
                                    : 'MISSING'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            {win.upPriceAtOpen !== null
                              ? `$${win.upPriceAtOpen.toFixed(2)}`
                              : '—'}
                          </TableCell>
                          <TableCell className="text-right">
                            {win.upPriceNow !== null
                              ? `$${win.upPriceNow.toFixed(2)}`
                              : '—'}
                          </TableCell>
                          <TableCell>
                            {win.resolvedUp === null ? (
                              <span className="text-[var(--text-subtle)]">—</span>
                            ) : (
                              <Badge
                                variant={win.resolvedUp ? 'positive' : 'negative'}
                              >
                                {win.resolvedUp ? 'UP' : 'DOWN'}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            {bestPick ? (
                              <span className="font-sans text-xs text-foreground">
                                {bestPick.title} ({bestPick.side})
                              </span>
                            ) : (
                              <span className="font-mono text-[11px] text-[var(--text-subtle)]">
                                {isEs ? 'Sin señal' : 'No signal'}
                              </span>
                            )}
                          </TableCell>
                          <TableCell
                            className={cn(
                              'text-right font-semibold',
                              bestPick && bestPick.edgePct > 0
                                ? 'text-[var(--positive)]'
                                : 'text-muted-foreground',
                            )}
                          >
                            {bestPick
                              ? `${bestPick.edgePct > 0 ? '+' : ''}${bestPick.edgePct.toFixed(1)}%`
                              : '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      )}
    </div>
  )
}
