import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Info,
  Maximize2,
  Radio,
  RefreshCw,
} from 'lucide-react'
import { fetchPolymarketSnapshot } from '@/api/botClient'
import EquityChart from '@/components/EquityChart'
import MetricCard from '@/components/MetricCard'
import NumberField from '@/components/NumberField'
import PageHeader from '@/components/PageHeader'
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
import { availablePairs } from '@/strategy'
import type { ChartPoint, Interval, PageId } from '@/types'

type PredictionsTab = 'rules' | 'simulator' | 'polymarket'
type RuleFamily = 'flare20' | 'directional'

const TIMEFRAMES: { id: Interval; label: string }[] = [
  { id: '5m', label: '5m' },
  { id: '15m', label: '15m' },
  { id: '1h', label: '1h' },
  { id: '4h', label: '4h' },
  { id: '1d', label: '1d' },
]

type PredictionsProps = {
  onNavigate?: (page: PageId) => void
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
        'inline-flex h-[26px] cursor-pointer items-center justify-center rounded-[4px] border px-2 font-mono text-[11px] font-medium whitespace-nowrap transition-all duration-150 select-none outline-none focus-visible:ring-1 focus-visible:ring-ring',
        active
          ? 'border-border bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.18)]'
          : 'border-transparent bg-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

export default function Predictions({ onNavigate }: PredictionsProps) {
  const { language, t } = useI18n()
  const isEs = language === 'es'

  const [tab, setTab] = useState<PredictionsTab>('rules')
  const [pair, setPair] = useState<string>(availablePairs[0])
  const [timeframe, setTimeframe] = useState<Interval>('15m')
  const [ruleFamily, setRuleFamily] = useState<RuleFamily>('flare20')
  const [reloadKey, setReloadKey] = useState(0)

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

  const activePair = tab === 'polymarket' ? 'BTC/USDT' : pair

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
    const dirRules = buildDirectionalRules(polyTf)
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

  const isRealSource = tab === 'polymarket'
  const visibleTimeframes = TIMEFRAMES.filter((tf) =>
    ruleFamily === 'directional' ? tf.id === '5m' || tf.id === '15m' : true,
  )

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={
          isEs
            ? `Mercados de Predicción · ${activePair}`
            : `Prediction Markets · ${activePair}`
        }
        subtitle={
          isEs
            ? 'Margen neto contra precio, estrategias de banca, validación fuera de muestra y precios reales de Polymarket'
            : 'Net edge vs contract price, bankroll sizing, out-of-sample validation and live Polymarket pricing'
        }
        badge={
          isRealSource
            ? isEs
              ? 'PRECIO REAL · POLYMARKET'
              : 'LIVE PRICE · POLYMARKET'
            : isEs
              ? 'PRECIO MODELADO'
              : 'MODELED PRICE'
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

      {/* Mode Tabs + Source Indicator */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as PredictionsTab)}
          className="w-fit"
        >
          <TabsList aria-label={isEs ? 'Vistas de predicciones' : 'Prediction views'}>
            <TabsTrigger value="rules">
              {isEs ? 'Reglas y Margen' : 'Rules & Edge'}
            </TabsTrigger>
            <TabsTrigger value="simulator">
              {isEs ? 'Simulador y Monte Carlo' : 'Simulator & Monte Carlo'}
            </TabsTrigger>
            <TabsTrigger value="polymarket">
              {isEs ? 'Mercado Real (Polymarket)' : 'Live Market (Polymarket)'}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <Badge
          variant={isRealSource ? 'positive' : 'secondary'}
          className="gap-1.5 px-2 py-1"
        >
          <Radio className="size-3" />
          {isRealSource
            ? isEs
              ? 'Fuente: Precio Real (Polymarket)'
              : 'Source: Real Price (Polymarket)'
            : isEs
              ? 'Fuente: Precio Modelado (Tasa Base + Spread)'
              : 'Source: Modeled Price (Base Rate + Spread)'}
        </Badge>
      </div>

      {/* ==================== TAB 1: RULES & EDGE ==================== */}
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

          <Card>
            <CardHeader className="gap-2.5">
              <div className="flex items-center gap-2">
                <Activity className="size-3.5 text-primary" />
                <CardTitle>
                  {isEs
                    ? `Evaluación de Margen · ${activePair} (${activeTimeframe})`
                    : `Edge Evaluation · ${activePair} (${activeTimeframe})`}
                </CardTitle>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div
                  role="group"
                  aria-label={isEs ? 'Familia' : 'Family'}
                  className="inline-flex h-8 items-center gap-0.5 rounded-sm border border-border bg-secondary/65 p-0.5"
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
                  className="inline-flex h-8 items-center gap-0.5 rounded-sm border border-border bg-secondary/65 p-0.5"
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
                  className="inline-flex h-8 items-center gap-0.5 rounded-sm border border-border bg-secondary/65 p-0.5"
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

                <div className="flex items-center gap-1.5 rounded-sm border border-border bg-secondary/45 px-2 py-0.5">
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
                    className="h-6 w-14 border-border/80 bg-card px-1.5 text-right text-[11px]"
                  />
                </div>

                <div className="flex items-center gap-1.5 rounded-sm border border-border bg-secondary/45 px-2 py-0.5">
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
                    className="h-6 w-14 border-border/80 bg-card px-1.5 text-right text-[11px]"
                  />
                </div>

                <label
                  htmlFor="pred-rules-cooldown"
                  className="flex h-8 cursor-pointer items-center gap-2 rounded-sm border border-border bg-secondary/50 px-2.5 font-mono text-[11px] font-medium text-foreground select-none"
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
                    <span>{isEs ? 'Terminal Pro' : 'Pro Terminal'}</span>
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
                <Table className="border-0">
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
                    {ruleStats.map((item) => (
                      <TableRow key={item.ruleId}>
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
                    ))}
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
                  className="inline-flex h-8 items-center gap-0.5 rounded-sm border border-border bg-secondary/65 p-0.5"
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
                  className="inline-flex h-8 items-center gap-0.5 rounded-sm border border-border bg-secondary/65 p-0.5"
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

              <div className="flex flex-wrap items-center gap-4 border-t border-border/70 pt-3">
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
                      <div className="flex flex-col gap-1 rounded-sm border border-[var(--border-subtle)] bg-secondary/35 px-3 py-2">
                        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                          {isEs ? 'Capital P5' : 'P5 Bankroll'}
                        </span>
                        <strong className="font-mono text-sm font-semibold tabular-nums text-foreground">
                          {formatMoney(simResult.monteCarlo.finalP5)}
                        </strong>
                      </div>
                      <div className="flex flex-col gap-1 rounded-sm border border-[var(--border-subtle)] bg-secondary/35 px-3 py-2">
                        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                          {isEs ? 'Capital P50' : 'P50 Median'}
                        </span>
                        <strong className="font-mono text-sm font-semibold tabular-nums text-foreground">
                          {formatMoney(simResult.monteCarlo.finalP50)}
                        </strong>
                      </div>
                      <div className="flex flex-col gap-1 rounded-sm border border-[var(--border-subtle)] bg-secondary/35 px-3 py-2">
                        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                          {isEs ? 'Capital P95' : 'P95 High'}
                        </span>
                        <strong className="font-mono text-sm font-semibold tabular-nums text-[var(--positive)]">
                          {formatMoney(simResult.monteCarlo.finalP95)}
                        </strong>
                      </div>
                      <div className="flex flex-col gap-1 rounded-sm border border-[var(--border-subtle)] bg-secondary/35 px-3 py-2">
                        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                          Drawdown P50 / P95
                        </span>
                        <strong className="font-mono text-sm font-semibold tabular-nums text-foreground">
                          {simResult.monteCarlo.maxDrawdownP50.toFixed(1)}% /{' '}
                          {simResult.monteCarlo.maxDrawdownP95.toFixed(1)}%
                        </strong>
                      </div>
                      <div className="flex flex-col gap-1 rounded-sm border border-[var(--border-subtle)] bg-secondary/35 px-3 py-2">
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
                    <Table className="border-0">
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
                  className="inline-flex h-8 items-center gap-0.5 rounded-sm border border-border bg-secondary/65 p-0.5"
                >
                  {(['5m', '15m'] as PolymarketTimeframe[]).map((tf) => (
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
                  className="inline-flex h-8 items-center gap-0.5 rounded-sm border border-border bg-secondary/65 p-0.5"
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
                <Card className="border-l-2 border-l-[var(--positive)]">
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
                  <Table className="border-0">
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
