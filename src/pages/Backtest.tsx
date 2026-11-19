import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react'
import {
  ArrowRight,
  BarChart3,
  Play,
  RefreshCw,
} from 'lucide-react'
import {
  createBacktestSnapshot,
  type BacktestConfig,
  type BacktestResult,
  type BacktestSnapshot,
} from '@/backtest'
import { runBacktestOffloaded } from '@/workers/backtestClient'
import EquityChart from '@/components/EquityChart'
import MetricCard from '@/components/MetricCard'
import NumberField from '@/components/NumberField'
import PageHeader from '@/components/PageHeader'
import TradesTable from '@/components/TradesTable'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  formatDateTime,
  formatMoney,
  formatOrDash,
  formatPercent,
  formatSignedMoney,
} from '@/format'
import { useCandles } from '@/hooks/useCandles'
import { useI18n, type Translate, type TranslationKey } from '@/i18n'
import { cn } from '@/lib/utils'
import { marketDataSource } from '@/market'
import { computeMetrics } from '@/metrics'
import {
  averageOptions,
  defaultSignalParams,
  fastOptions,
  slowOptions,
} from '@/signals'
import { availablePairs } from '@/strategy'
import type {
  AverageKind,
  ChartPoint,
  ExitReason,
  Interval,
  PageId,
  SignalParams,
  Strategy,
  Tone,
} from '@/types'

const CANDLE_LIMITS = [200, 500, 1000]

const intervalOptions: { id: Interval; labelKey: TranslationKey }[] = [
  { id: '15m', labelKey: 'market.interval15m' },
  { id: '1h', labelKey: 'market.interval1h' },
  { id: '4h', labelKey: 'market.interval4h' },
  { id: '1d', labelKey: 'market.interval1d' },
]

type FormValues = {
  initialBalance: string
  commissionPct: string
  slippagePct: string
  positionSize: string
  stopLoss: string
  takeProfit: string
  maxDailyRisk: string
}

type FormErrors = Partial<Record<keyof FormValues, string>>

function toFormValues(strategy: Strategy): FormValues {
  return {
    initialBalance: '10000',
    commissionPct: '0.1',
    slippagePct: '0',
    positionSize: String(strategy.positionSize),
    stopLoss: String(strategy.stopLoss),
    takeProfit: String(strategy.takeProfit),
    maxDailyRisk: String(strategy.maxDailyRisk),
  }
}

function numberError(
  text: string,
  min: number,
  max: number,
  t: Translate,
): string | undefined {
  const value = Number(text)

  if (text.trim() === '' || Number.isNaN(value)) {
    return t('validation.number')
  }
  if (value < min || value > max) {
    return t('validation.range', { min, max })
  }
  return undefined
}

function validate(values: FormValues, t: Translate): FormErrors {
  return {
    initialBalance: numberError(values.initialBalance, 1, 1_000_000, t),
    commissionPct: numberError(values.commissionPct, 0, 5, t),
    slippagePct: numberError(values.slippagePct, 0, 5, t),
    positionSize: numberError(values.positionSize, 0.1, 100, t),
    stopLoss: numberError(values.stopLoss, 0.1, 50, t),
    takeProfit: numberError(values.takeProfit, 0.1, 100, t),
    maxDailyRisk: numberError(values.maxDailyRisk, 0.1, 100, t),
  }
}

function toneOf(value: number | null, threshold = 0): Tone {
  if (value === null) return 'neutral'
  if (value > threshold) return 'positive'
  if (value < threshold) return 'negative'
  return 'neutral'
}

type BacktestProps = {
  strategy: Strategy
  onNavigate: (page: PageId) => void
  onSaveResult: (snapshot: BacktestSnapshot) => void
}

function Backtest({ strategy, onNavigate, onSaveResult }: BacktestProps) {
  const { locale, t } = useI18n()
  const [pair, setPair] = useState(strategy.pair)
  const [interval, setInterval] = useState<Interval>('1h')
  const [limit, setLimit] = useState(500)
  const [params, setParams] = useState<SignalParams>(defaultSignalParams)
  const [values, setValues] = useState<FormValues>(() =>
    toFormValues(strategy),
  )
  const [allowShort, setAllowShort] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [isRunningJob, setIsRunningJob] = useState(false)
  const [lastExecMeta, setLastExecMeta] = useState<{
    durationMs: number
    executedIn: 'worker' | 'main-thread'
  } | null>(null)
  const jobAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      jobAbortRef.current?.abort()
    }
  }, [])

  const state = useCandles(
    marketDataSource,
    pair,
    interval,
    limit,
    reloadKey,
  )

  const errors = validate(values, t)
  const hasErrors = Object.values(errors).some(
    (message) => message !== undefined,
  )

  const metrics = useMemo(
    () =>
      result
        ? computeMetrics(result.trades, result.initialBalance)
        : null,
    [result],
  )

  const equityPoints: ChartPoint[] = useMemo(
    () =>
      result
        ? result.equity.map((point) => ({
            label: formatDateTime(point.time, locale),
            value: point.value,
          }))
        : [],
    [result, locale],
  )

  const exitCounts = useMemo(() => {
    if (!result) return {} as Partial<Record<ExitReason, number>>

    return result.trades.reduce<Partial<Record<ExitReason, number>>>(
      (counts, trade) => {
        counts[trade.exitReason] = (counts[trade.exitReason] ?? 0) + 1
        return counts
      },
      {},
    )
  }, [result])

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const { name, value } = event.target
    setValues((current) => ({ ...current, [name]: value }))
  }

  async function handleRun(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()

    if (state.status !== 'success') {
      setRunError(t('backtest.waitForCandles'))
      return
    }

    if (hasErrors) {
      setRunError(t('backtest.fixFields'))
      return
    }

    const config: BacktestConfig = {
      pair,
      params,
      strategy: {
        positionSize: Number(values.positionSize),
        stopLoss: Number(values.stopLoss),
        takeProfit: Number(values.takeProfit),
        maxDailyRisk: Number(values.maxDailyRisk),
      },
      settings: {
        initialBalance: Number(values.initialBalance),
        commissionPct: Number(values.commissionPct),
        slippagePct: Number(values.slippagePct),
        allowShort,
      },
    }

    jobAbortRef.current?.abort()
    const controller = new AbortController()
    jobAbortRef.current = controller
    setIsRunningJob(true)
    setRunError(null)

    try {
      const output = await runBacktestOffloaded(
        state.data,
        config,
        controller.signal,
      )
      if (controller.signal.aborted) return
      setResult(output.result)
      setLastExecMeta({
        durationMs: output.durationMs,
        executedIn: output.executedIn,
      })
      onSaveResult(createBacktestSnapshot(output.result))
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setRunError(
        error instanceof Error ? error.message : t('backtest.fixFields'),
      )
    } finally {
      if (jobAbortRef.current === controller) {
        setIsRunningJob(false)
      }
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('backtest.title')}
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onNavigate('stats')}
          >
            <BarChart3 className="size-3.5" />
            <span>{t('backtest.viewStats')}</span>
          </Button>
        }
      />

      <form onSubmit={handleRun} noValidate className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('backtest.data')}</CardTitle>
            <Badge variant="outline">
              {pair} · {interval} · {limit}
            </Badge>
          </CardHeader>

          <CardContent className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bt-pair">{t('backtest.pair')}</Label>
                <Select value={pair} onValueChange={setPair}>
                  <SelectTrigger id="bt-pair">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availablePairs.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-[11px] text-[var(--text-subtle)]">
                  {t('backtest.pairHint')}
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bt-interval">{t('backtest.timeframe')}</Label>
                <Select
                  value={interval}
                  onValueChange={(val) => setInterval(val as Interval)}
                >
                  <SelectTrigger id="bt-interval">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {intervalOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {t(option.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-[11px] text-[var(--text-subtle)]">
                  {t('backtest.timeframeHint')}
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bt-limit">{t('backtest.candles')}</Label>
                <Select
                  value={String(limit)}
                  onValueChange={(val) => setLimit(Number(val))}
                >
                  <SelectTrigger id="bt-limit">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CANDLE_LIMITS.map((option) => (
                      <SelectItem key={option} value={String(option)}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-[11px] text-[var(--text-subtle)]">
                  {t('backtest.candlesHint')}
                </span>
              </div>
            </div>

            {state.status === 'loading' && (
              <div className="rounded-sm border border-border bg-secondary/35 px-3 py-2 font-mono text-xs text-muted-foreground" role="status">
                {t('backtest.loadingCandles')}
              </div>
            )}

            {state.status === 'error' && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-[var(--negative)]/40 bg-[var(--negative-soft)] px-3 py-2 text-xs text-[var(--negative)]" role="alert">
                <span>{t('backtest.loadError', { message: state.message })}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => setReloadKey((k) => k + 1)}
                >
                  <RefreshCw className="size-3" />
                  <span>{t('backtest.retry')}</span>
                </Button>
              </div>
            )}

            {state.status === 'success' && state.data.length > 0 && (
              <div className="rounded-sm border border-[var(--border-subtle)] bg-secondary/35 px-3 py-2 font-mono text-[11px] text-muted-foreground tabular-nums">
                {t('backtest.candleRange', {
                  count: state.data.length,
                  from: formatDateTime(state.data[0].time, locale),
                  to: formatDateTime(
                    state.data[state.data.length - 1].time,
                    locale,
                  ),
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('backtest.signal')}</CardTitle>
            <Badge variant="secondary">
              {params.average.toUpperCase()} {params.fastPeriod}/{params.slowPeriod}
            </Badge>
          </CardHeader>

          <CardContent className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bt-fast">{t('backtest.fastAverage')}</Label>
              <Select
                value={String(params.fastPeriod)}
                onValueChange={(val) =>
                  setParams({ ...params, fastPeriod: Number(val) })
                }
              >
                <SelectTrigger id="bt-fast">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {fastOptions.map((option) => (
                    <SelectItem key={option} value={String(option)}>
                      {t('backtest.candleCount', { count: option })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bt-slow">{t('backtest.slowAverage')}</Label>
              <Select
                value={String(params.slowPeriod)}
                onValueChange={(val) =>
                  setParams({ ...params, slowPeriod: Number(val) })
                }
              >
                <SelectTrigger id="bt-slow">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {slowOptions.map((option) => (
                    <SelectItem key={option} value={String(option)}>
                      {t('backtest.candleCount', { count: option })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <span
                className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground"
                id="bt-average-label"
              >
                {t('backtest.averageType')}
              </span>
              <div
                className="inline-flex h-8 w-full items-center gap-0.5 rounded-sm border border-border bg-secondary/65 p-0.5"
                role="group"
                aria-labelledby="bt-average-label"
              >
                {averageOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={cn(
                      'inline-flex h-[26px] flex-1 items-center justify-center rounded-[4px] border px-2 font-mono text-xs font-medium transition-all duration-150 cursor-pointer',
                      params.average === option.id
                        ? 'border-border bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.18)]'
                        : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                    aria-pressed={params.average === option.id}
                    onClick={() =>
                      setParams({
                        ...params,
                        average: option.id as AverageKind,
                      })
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('backtest.riskAndExecution')}</CardTitle>
          </CardHeader>

          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
              <NumberField
                name="initialBalance"
                label={t('backtest.initialBalance')}
                unit="USD"
                hint={t('backtest.initialBalanceHint')}
                value={values.initialBalance}
                error={errors.initialBalance}
                onChange={handleChange}
              />
              <NumberField
                name="positionSize"
                label={t('backtest.positionSize')}
                unit="%"
                hint={t('backtest.positionSizeHint')}
                value={values.positionSize}
                error={errors.positionSize}
                onChange={handleChange}
              />
              <NumberField
                name="stopLoss"
                label={t('backtest.stopLoss')}
                unit="%"
                hint={t('backtest.stopLossHint')}
                value={values.stopLoss}
                error={errors.stopLoss}
                onChange={handleChange}
              />
              <NumberField
                name="takeProfit"
                label={t('backtest.takeProfit')}
                unit="%"
                hint={t('backtest.takeProfitHint')}
                value={values.takeProfit}
                error={errors.takeProfit}
                onChange={handleChange}
              />
              <NumberField
                name="maxDailyRisk"
                label={t('backtest.maxDailyRisk')}
                unit="%"
                hint={t('backtest.maxDailyRiskHint')}
                value={values.maxDailyRisk}
                error={errors.maxDailyRisk}
                onChange={handleChange}
              />
              <NumberField
                name="commissionPct"
                label={t('backtest.commission')}
                unit="%"
                hint={t('backtest.commissionHint')}
                value={values.commissionPct}
                error={errors.commissionPct}
                onChange={handleChange}
              />
              <NumberField
                name="slippagePct"
                label={t('backtest.slippage')}
                unit="%"
                hint={t('backtest.slippageHint')}
                value={values.slippagePct}
                error={errors.slippagePct}
                onChange={handleChange}
              />
            </div>

            <div className="flex items-center gap-2.5 pt-1">
              <Checkbox
                id="bt-allow-short"
                checked={allowShort}
                onCheckedChange={(checked) => setAllowShort(checked === true)}
              />
              <label
                htmlFor="bt-allow-short"
                className="cursor-pointer text-xs text-muted-foreground select-none"
              >
                {t('backtest.allowShorts')}
              </label>
            </div>
          </CardContent>

          <CardFooter className="justify-between">
            <Button
              type="submit"
              variant="default"
              size="sm"
              disabled={state.status !== 'success' || isRunningJob}
            >
              <Play className="size-3.5 fill-current" />
              <span>{t('backtest.run')}</span>
            </Button>

            <span
              className={cn(
                'font-mono text-xs',
                runError ? 'text-[var(--negative)]' : 'text-muted-foreground',
              )}
              role={runError ? 'alert' : undefined}
            >
              {runError
                ? runError
                : hasErrors
                  ? t('backtest.fixFields')
                  : lastExecMeta
                    ? `${t('backtest.configApplied')} · ${lastExecMeta.executedIn} (${lastExecMeta.durationMs}ms)`
                    : t('backtest.configApplied')}
            </span>
          </CardFooter>
        </Card>
      </form>

      {result && metrics && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-sm font-semibold uppercase tracking-[0.06em] text-foreground">
              {t('backtest.result')}
            </h2>

            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onNavigate('bot-config')}
              >
                {t('backtest.editStrategy')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onNavigate('stats')}
              >
                <BarChart3 className="size-3.5" />
                <span>{t('backtest.viewStats')}</span>
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={() => onNavigate('bot-run')}
              >
                <span>{t('backtest.runBot')}</span>
                <ArrowRight className="size-3.5" />
              </Button>
            </div>
          </div>

          <Card className="px-3.5 py-2.5 font-mono text-xs text-muted-foreground">
            {t('backtest.resultReadout', {
              pair: result.config.pair,
              average: result.config.params.average.toUpperCase(),
              fast: result.config.params.fastPeriod,
              slow: result.config.params.slowPeriod,
              candles: result.candles.count,
              commission: result.config.settings.commissionPct,
              trades: result.trades.length,
            })}
            {result.bankrupt ? ` · ${t('backtest.accountDepleted')}` : ''}
          </Card>

          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            <MetricCard
              label={t('backtest.netPnl')}
              value={formatSignedMoney(result.netPnl)}
              hint={t('backtest.netPnlHint')}
              tone={toneOf(result.netPnl)}
            />
            <MetricCard
              label={t('backtest.return')}
              value={formatPercent(result.returnPct, 2)}
              hint={t('backtest.returnHint')}
              tone={toneOf(result.returnPct)}
            />
            <MetricCard
              label={t('backtest.finalBalance')}
              value={formatMoney(result.finalBalance)}
              hint={t('backtest.finalBalanceHint', {
                amount: formatMoney(result.initialBalance),
              })}
            />
            <MetricCard
              label={t('backtest.trades')}
              value={String(metrics.totalTrades)}
              hint={t('backtest.tradesHint', {
                wins: metrics.wins,
                losses: metrics.losses,
              })}
            />
            <MetricCard
              label={t('backtest.winRate')}
              value={formatOrDash(metrics.winRate, (value) =>
                formatPercent(value, 1),
              )}
              hint={t('backtest.winRateHint')}
            />
            <MetricCard
              label={t('backtest.profitFactor')}
              value={formatOrDash(metrics.profitFactor, (value) =>
                value.toFixed(2),
              )}
              hint={t('backtest.profitFactorHint')}
              tone={toneOf(metrics.profitFactor, 1)}
            />
            <MetricCard
              label={t('backtest.maxDrawdown')}
              value={formatMoney(-metrics.maxDrawdown)}
              hint={t('backtest.maxDrawdownHint', {
                pct: formatPercent(metrics.maxDrawdownPct, 2),
              })}
              tone={metrics.maxDrawdown > 0 ? 'negative' : 'neutral'}
            />
            <MetricCard
              label={t('backtest.feesPaid')}
              value={formatMoney(result.feesPaid)}
              hint={t('backtest.feesPaidHint')}
              tone={result.feesPaid > 0 ? 'negative' : 'neutral'}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{t('backtest.exitReasons')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {(Object.keys(exitCounts) as ExitReason[]).map((reason) => (
                <Badge key={reason} variant="outline" className="px-2.5 py-1 text-xs">
                  {t(`exit.${reason}` as TranslationKey)}: {exitCounts[reason]}
                </Badge>
              ))}
            </CardContent>
          </Card>

          <section className="flex flex-col gap-2">
            <h3 className="font-display text-xs font-semibold uppercase tracking-[0.06em] text-foreground">
              {t('backtest.balanceEvolution')}
            </h3>
            <EquityChart points={equityPoints} />
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="font-display text-xs font-semibold uppercase tracking-[0.06em] text-foreground">
              {t('backtest.operations', { count: result.trades.length })}
            </h3>
            {result.trades.length === 0 ? (
              <Card className="p-6 text-center text-xs text-muted-foreground">
                {t('backtest.noTrades')}
              </Card>
            ) : (
              <TradesTable trades={result.trades} />
            )}
          </section>
        </div>
      )}
    </div>
  )
}

export default Backtest
