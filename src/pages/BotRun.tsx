import { useEffect, useState } from 'react'
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  FlaskConical,
  Lock,
  Play,
  Radio,
  RotateCcw,
  ShieldAlert,
  SlidersHorizontal,
  Square,
  Zap,
} from 'lucide-react'
import {
  buildBacktestSnapshotFromBot,
  fetchBotAccuracyAudit,
  getBotStatus,
  resetBotOnServer,
  resetExchangeVaultOnServer,
  selectBotPresetOnServer,
  simulateMt5PingOnServer,
  startBotOnServer,
  stopBotOnServer,
  submitDemoOrderOnServer,
  subscribeToBotStream,
  toggleExchangeKillSwitchOnServer,
  triggerImmediateBotTick,
  updateHardLimitsOnServer,
  type BotAccuracyResponse,
  type BotServerSnapshot,
  type Mt5SignalPacket,
} from '@/api/botClient'
import type { BacktestSnapshot } from '@/backtest'
import { STRATEGY_PRESETS } from '@/botEngine'
import PageHeader from '@/components/PageHeader'
import TradesTable from '@/components/TradesTable'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { BotStatus, PageId, Strategy } from '@/types'

type BotRunProps = {
  status: BotStatus
  onChangeStatus: (status: BotStatus) => void
  strategy: Strategy
  onNavigate?: (page: PageId) => void
  onSaveSnapshot?: (snapshot: BacktestSnapshot) => void
}

function BotRun({
  status,
  onChangeStatus,
  strategy,
  onNavigate,
  onSaveSnapshot,
}: BotRunProps) {
  const { t, language } = useI18n()
  const isEs = language === 'es'

  const [snapshot, setSnapshot] = useState<BotServerSnapshot | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [auditReport, setAuditReport] = useState<BotAccuracyResponse | null>(
    null,
  )
  const [exchangeFeedback, setExchangeFeedback] = useState<{
    tone: 'pos' | 'neg'
    message: string
  } | null>(null)
  const [lastMt5Packet, setLastMt5Packet] = useState<Mt5SignalPacket | null>(
    null,
  )
  const [confirmKillOpen, setConfirmKillOpen] = useState(false)
  const [confirmResetOpen, setConfirmResetOpen] = useState(false)

  useEffect(() => {
    let active = true

    getBotStatus().then((snap) => {
      if (!active) return
      setSnapshot(snap)
      onChangeStatus(snap.running ? 'running' : 'stopped')
    })

    const unsubscribe = subscribeToBotStream((snap) => {
      if (!active) return
      setSnapshot(snap)
      onChangeStatus(snap.running ? 'running' : 'stopped')
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [onChangeStatus])

  const activePreset = snapshot?.preset ?? STRATEGY_PRESETS[1]
  const engineState = snapshot?.state
  const telemetry = snapshot?.telemetry
  const exchange = snapshot?.exchange
  const mt5 = snapshot?.mt5
  const isRunning = snapshot ? snapshot.running : status === 'running'
  const presets = snapshot?.presets ?? STRATEGY_PRESETS

  const balance = engineState?.balance ?? activePreset.execution.initialBalance
  const initialBalance =
    engineState?.initialBalance ?? activePreset.execution.initialBalance
  const lockedStake =
    engineState?.activeTickets.reduce((acc, tk) => acc + tk.stakeUsd, 0) ?? 0
  const totalEquity = balance + lockedStake
  const netPnl = totalEquity - initialBalance
  const netPnlPct = initialBalance > 0 ? (netPnl / initialBalance) * 100 : 0
  const closedTrades = engineState?.closedTrades ?? []
  const resolvedTickets = engineState?.resolvedTickets ?? []
  const killSwitchActive = exchange?.killSwitchActive ?? false
  const activeMt5Packet = lastMt5Packet ?? mt5?.lastPacket

  async function handleStart() {
    setBusyAction('start')
    try {
      const next = await startBotOnServer({ presetId: activePreset.id })
      setSnapshot(next)
      onChangeStatus(next.running ? 'running' : 'stopped')
    } finally {
      setBusyAction(null)
    }
  }

  async function handleStop() {
    setBusyAction('stop')
    try {
      const next = await stopBotOnServer()
      setSnapshot(next)
      onChangeStatus('stopped')
    } finally {
      setBusyAction(null)
    }
  }

  async function handleTickNow() {
    setBusyAction('tick')
    try {
      const next = await triggerImmediateBotTick()
      setSnapshot(next)
    } finally {
      setBusyAction(null)
    }
  }

  async function handleReset() {
    setBusyAction('reset')
    setConfirmResetOpen(false)
    try {
      const next = await resetBotOnServer()
      setSnapshot(next)
      onChangeStatus('stopped')
    } finally {
      setBusyAction(null)
    }
  }

  async function handleSelectPreset(presetId: string) {
    setBusyAction('preset')
    try {
      const next = await selectBotPresetOnServer({ presetId })
      setSnapshot(next)
    } finally {
      setBusyAction(null)
    }
  }

  async function handleSyncCustomStrategy() {
    setBusyAction('sync')
    try {
      const next = await selectBotPresetOnServer({ strategy })
      setSnapshot(next)
    } finally {
      setBusyAction(null)
    }
  }

  async function handleRunAccuracyAudit() {
    setBusyAction('audit')
    try {
      const result = await fetchBotAccuracyAudit(true)
      setAuditReport(result)
    } finally {
      setBusyAction(null)
    }
  }

  async function handleDemoOrder(side: 'BUY' | 'SELL', notionalUsd: number) {
    setBusyAction('exchange-order')
    setExchangeFeedback(null)
    try {
      const res = await submitDemoOrderOnServer({
        pair: activePreset.strategy.pair,
        side,
        notionalUsd,
      })
      setSnapshot(res.bot)
      if (res.ok) {
        setExchangeFeedback({
          tone: 'pos',
          message: isEs
            ? `Orden ${side} ${activePreset.strategy.pair} por $${notionalUsd.toFixed(2)} USD ejecutada @ $${res.order.price.toFixed(2)} (${res.order.quantity} unidades).`
            : `Order ${side} ${activePreset.strategy.pair} for $${notionalUsd.toFixed(2)} USD filled @ $${res.order.price.toFixed(2)} (${res.order.quantity} units).`,
        })
      } else {
        setExchangeFeedback({
          tone: 'neg',
          message:
            res.error ??
            (isEs
              ? 'Orden rechazada por Límites Duros.'
              : 'Order rejected by Hard Risk Limits.'),
        })
      }
    } finally {
      setBusyAction(null)
    }
  }

  async function handleToggleKillSwitch() {
    setBusyAction('kill-switch')
    setConfirmKillOpen(false)
    setExchangeFeedback(null)
    try {
      const action = killSwitchActive ? 'reset' : 'engage'
      const next = await toggleExchangeKillSwitchOnServer({
        action,
        reason: isEs
          ? 'Parada de emergencia activada desde el panel de control'
          : 'Emergency stop triggered from control panel',
      })
      setSnapshot(next)
      if (action === 'engage') {
        onChangeStatus('stopped')
        setExchangeFeedback({
          tone: 'neg',
          message: isEs
            ? 'Kill-Switch activado: el bot fue detenido, posiciones abiertas liquidadas y nuevas órdenes bloqueadas.'
            : 'Kill-Switch engaged: bot halted, open positions flattened, and new orders blocked.',
        })
      } else {
        setExchangeFeedback({
          tone: 'pos',
          message: isEs
            ? 'Kill-Switch rearmado: el adaptador de exchange vuelve a estar operativo.'
            : 'Kill-Switch rearmed: the exchange adapter is operational again.',
        })
      }
    } finally {
      setBusyAction(null)
    }
  }

  async function handleChangeMaxOrderNotional(maxOrderNotionalUsd: number) {
    setBusyAction('limits')
    try {
      const next = await updateHardLimitsOnServer({ maxOrderNotionalUsd })
      setSnapshot(next)
    } finally {
      setBusyAction(null)
    }
  }

  async function handleToggleAutoMirror(checked: boolean) {
    setBusyAction('limits')
    try {
      const next = await updateHardLimitsOnServer({
        autoMirrorBotOrders: checked,
      })
      setSnapshot(next)
    } finally {
      setBusyAction(null)
    }
  }

  async function handleResetVault() {
    setBusyAction('exchange-reset')
    setExchangeFeedback(null)
    try {
      const next = await resetExchangeVaultOnServer()
      setSnapshot(next)
    } finally {
      setBusyAction(null)
    }
  }

  async function handleSimulateMt5Ping() {
    setBusyAction('mt5-ping')
    try {
      const res = await simulateMt5PingOnServer()
      setLastMt5Packet(res.packet)
      setSnapshot(res.bot)
    } finally {
      setBusyAction(null)
    }
  }

  function handleSendToStats() {
    if (!snapshot || !onSaveSnapshot) return
    const btSnapshot = buildBacktestSnapshotFromBot(snapshot)
    onSaveSnapshot(btSnapshot)
    onNavigate?.('stats')
  }

  const connLabel =
    snapshot?.connectionMode === 'sse-live'
      ? 'SSE REALTIME STREAM'
      : snapshot?.connectionMode === 'http-server'
        ? 'BACKEND HTTP'
        : 'LOCAL SHADOW'

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('botRun.title')}
        badge={connLabel}
        actions={
          onNavigate && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onNavigate('bot-config')}
              >
                <SlidersHorizontal className="size-3.5" />
                <span>{t('botRun.editParams')}</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onNavigate('backtest')}
              >
                <FlaskConical className="size-3.5" />
                <span>{t('botRun.runBacktest')}</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onNavigate('stats')}
              >
                <BarChart3 className="size-3.5" />
                <span>{t('botRun.viewStats')}</span>
              </Button>
            </>
          )
        }
      />

      {/* Engine Status & Direct Command Strip */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={cn(
                'size-2.5 shrink-0 rounded-full',
                killSwitchActive
                  ? 'bg-[var(--negative)]'
                  : isRunning
                    ? 'bg-[var(--positive)] shadow-[0_0_0_3px_var(--positive-soft)]'
                    : 'bg-muted-foreground/50',
              )}
              aria-hidden="true"
            />
            <div className="flex flex-col">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                {t('botRun.currentStatus')}
              </span>
              <strong className="font-mono text-sm font-bold text-foreground">
                {t(isRunning ? 'status.running' : 'status.stopped')}
              </strong>
            </div>

            {killSwitchActive && (
              <Badge variant="negative">KILL-SWITCH ACTIVE</Badge>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={isRunning || killSwitchActive || busyAction !== null}
              onClick={handleStart}
            >
              <Play className="size-3.5 fill-current" />
              <span>{t('botRun.start')}</span>
            </Button>

            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!isRunning || busyAction !== null}
              onClick={handleStop}
            >
              <Square className="size-3.5 fill-current" />
              <span>{t('botRun.stop')}</span>
            </Button>

            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={killSwitchActive || busyAction !== null}
              onClick={handleTickNow}
            >
              <Zap className="size-3.5 text-primary" />
              <span>
                {isEs ? 'Evaluar Vela Ahora' : 'Evaluate Bar Now'}
              </span>
            </Button>

            <AlertDialog
              open={confirmResetOpen}
              onOpenChange={setConfirmResetOpen}
            >
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busyAction !== null}
                >
                  <RotateCcw className="size-3.5" />
                  <span>{isEs ? 'Reiniciar Cuenta' : 'Reset Account'}</span>
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {isEs ? 'Reiniciar cuenta del bot' : 'Reset bot account'}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {isEs
                      ? 'Se limpiarán las operaciones cerradas, tickets y bitácora de esta sesión y el motor volverá a STOP.'
                      : 'Closed trades, tickets, and session logs will be cleared and the engine will reset to STOP.'}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>
                    {isEs ? 'Cancelar' : 'Cancel'}
                  </AlertDialogCancel>
                  <AlertDialogAction onClick={handleReset}>
                    {isEs ? 'Confirmar reinicio' : 'Confirm reset'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardContent>
      </Card>

      {/* Active Strategy & Preset Selector */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-0.5">
            <CardTitle>{isEs ? 'Estrategia Activa' : 'Active Strategy'}</CardTitle>
            <CardDescription>{activePreset.description}</CardDescription>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={activePreset.id}
              disabled={busyAction !== null}
              onValueChange={handleSelectPreset}
            >
              <SelectTrigger
                className="w-[260px]"
                aria-label={
                  isEs ? 'Seleccionar preset del bot' : 'Select bot preset'
                }
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {presets.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    [{p.domain === 'prediction-market' ? 'PRED' : 'SPOT'} ·{' '}
                    {p.timeframe}] {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busyAction !== null}
              onClick={handleSyncCustomStrategy}
            >
              {isEs
                ? 'Aplicar mis ajustes de Bot Setup'
                : 'Apply My Bot Setup Params'}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
              {t('botRun.pair')}
            </span>
            <strong className="font-mono text-xs font-semibold text-foreground">
              {activePreset.strategy.pair} · {activePreset.timeframe}
            </strong>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
              {isEs ? 'Dominio / Motor' : 'Domain / Engine'}
            </span>
            <strong className="truncate font-mono text-xs font-semibold text-foreground">
              {activePreset.domain === 'prediction-market'
                ? isEs
                  ? 'Predicción Binaria (Wilson 95%)'
                  : 'Binary Prediction (Wilson 95%)'
                : `${activePreset.filters?.signalEngine ?? 'momentum-structure'}${activePreset.filters?.breakevenAtOneR ? ' + Profit-Lock' : ''}`}
            </strong>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
              {t('botRun.positionSize')}
            </span>
            <strong className="font-mono text-xs font-semibold text-foreground tabular-nums">
              {activePreset.strategy.positionSize}%
            </strong>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
              {t('botRun.stopLoss')}
            </span>
            <strong className="font-mono text-xs font-semibold text-[var(--negative)] tabular-nums">
              {activePreset.strategy.stopLoss}%
            </strong>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
              {t('botRun.takeProfit')}
            </span>
            <strong className="font-mono text-xs font-semibold text-[var(--positive)] tabular-nums">
              {activePreset.strategy.takeProfit}%
            </strong>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
              {t('botRun.maxDailyRisk')}
            </span>
            <strong className="font-mono text-xs font-semibold text-foreground tabular-nums">
              {activePreset.strategy.maxDailyRisk}%
            </strong>
          </div>
        </CardContent>
      </Card>

      {/* Account Equity & Server Telemetry */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{isEs ? 'Cuenta y Balance' : 'Account Equity'}</CardTitle>
            <Badge
              variant={engineState?.dayHalted ? 'negative' : 'positive'}
            >
              {engineState?.dayHalted ? 'HALTED' : 'CIRCUIT OK'}
            </Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-[10px] uppercase text-muted-foreground">
                  {isEs ? 'Equidad Total' : 'Total Equity'}
                </span>
                <strong className="font-mono text-sm font-bold tabular-nums">
                  ${totalEquity.toFixed(2)}
                </strong>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-[10px] uppercase text-muted-foreground">
                  {isEs ? 'PnL Neto' : 'Net PnL'}
                </span>
                <strong
                  className={cn(
                    'font-mono text-sm font-bold tabular-nums',
                    netPnl > 0
                      ? 'text-[var(--positive)]'
                      : netPnl < 0
                        ? 'text-[var(--negative)]'
                        : 'text-foreground',
                  )}
                >
                  {netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)} (
                  {netPnlPct >= 0 ? '+' : ''}
                  {netPnlPct.toFixed(2)}%)
                </strong>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-[10px] uppercase text-muted-foreground">
                  {activePreset.domain === 'prediction-market'
                    ? isEs
                      ? 'Tickets'
                      : 'Tickets'
                    : isEs
                      ? 'Posición / Cerradas'
                      : 'Open / Closed'}
                </span>
                <strong className="font-mono text-xs font-semibold tabular-nums">
                  {activePreset.domain === 'prediction-market'
                    ? `${engineState?.activeTickets.length ?? 0} / ${resolvedTickets.length}`
                    : `${engineState?.openPosition ? engineState.openPosition.side.toUpperCase() : 'NONE'} / ${closedTrades.length}`}
                </strong>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-[10px] uppercase text-muted-foreground">
                  {isEs ? 'Freno Diario' : 'Breaker'}
                </span>
                <strong className="font-mono text-xs font-semibold">
                  {engineState?.dayHalted ? 'HALTED' : 'OK'}
                </strong>
              </div>
            </div>

            {engineState?.openPosition && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-primary/35 bg-primary/10 px-3 py-2 font-mono text-xs">
                <strong className="text-foreground">
                  {isEs ? 'Posición Activa:' : 'Active Position:'}{' '}
                  {engineState.openPosition.side.toUpperCase()}{' '}
                  {engineState.openPosition.pair}
                </strong>
                <span className="text-muted-foreground tabular-nums">
                  Entry: ${engineState.openPosition.entryPrice.toFixed(2)} · SL: $
                  {engineState.openPosition.stopPrice.toFixed(2)}
                  {engineState.openPosition.breakevenArmed && (
                    <Badge variant="default" className="mx-1.5">
                      <Lock className="size-2.5" /> Profit-Lock
                    </Badge>
                  )}{' '}
                  · TP: ${engineState.openPosition.targetPrice.toFixed(2)}
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              {isEs ? 'Telemetría del Servidor' : 'Server Telemetry'}
            </CardTitle>
            <Badge variant="secondary">
              {telemetry?.cache.lastSource?.toUpperCase() ?? 'BINANCE'}
            </Badge>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {isEs ? 'Latencia Media API' : 'Avg API Latency'}
              </span>
              <strong className="font-mono text-xs font-semibold tabular-nums">
                {telemetry?.cache.avgLatencyMs ?? 0} ms
              </strong>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {isEs ? 'Hit-Rate Caché TTL' : 'TTL Cache Hit-Rate'}
              </span>
              <strong className="font-mono text-xs font-semibold tabular-nums">
                {telemetry?.cache.hitRatePct ?? 0}% ({telemetry?.cache.hits ?? 0} hits)
              </strong>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {isEs ? 'Ciclos Ejecutados' : 'Executed Ticks'}
              </span>
              <strong className="font-mono text-xs font-semibold tabular-nums">
                {telemetry?.tickCount ?? 0} · SSE:{' '}
                {telemetry?.connectedStreamClients ?? 1}
              </strong>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Demo Broker & Risk Guardian */}
      <Card>
        <CardHeader>
          <CardTitle>
            {isEs
              ? 'Broker Demo y Guardián de Riesgo'
              : 'Demo Broker & Risk Guard'}
          </CardTitle>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 font-mono text-xs text-muted-foreground">
              <Switch
                checked={exchange?.autoMirrorBotOrders !== false}
                disabled={busyAction !== null}
                onCheckedChange={handleToggleAutoMirror}
              />
              <span>{isEs ? 'Espejo Auto' : 'Auto-Mirror'}</span>
            </label>

            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={busyAction !== null}
              onClick={handleResetVault}
            >
              {isEs ? 'Restaurar Bóveda Demo' : 'Reset Demo Vault'}
            </Button>

            {killSwitchActive ? (
              <Button
                type="button"
                variant="positive"
                size="xs"
                disabled={busyAction !== null}
                onClick={handleToggleKillSwitch}
              >
                <CheckCircle2 className="size-3.5" />
                <span>
                  {isEs
                    ? 'Rearmar Sistema (Desbloquear Kill-Switch)'
                    : 'Rearm System (Unlock Kill-Switch)'}
                </span>
              </Button>
            ) : (
              <AlertDialog
                open={confirmKillOpen}
                onOpenChange={setConfirmKillOpen}
              >
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="destructive"
                    size="xs"
                    disabled={busyAction !== null}
                  >
                    <ShieldAlert className="size-3.5" />
                    <span>
                      {isEs
                        ? 'Botón de Emergencia (Kill-Switch)'
                        : 'Emergency Stop (Kill-Switch)'}
                    </span>
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle className="flex items-center gap-2 text-[var(--negative)]">
                      <ShieldAlert className="size-4" />
                      <span>
                        {isEs
                          ? 'Activar Parada de Emergencia (Kill-Switch)'
                          : 'Engage Emergency Kill-Switch'}
                      </span>
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {isEs
                        ? 'Detendrá el bot de inmediato, cerrará posiciones abiertas en la bóveda y bloqueará todas las nuevas órdenes hasta que lo rearmes.'
                        : 'This immediately stops the bot, flattens open vault positions, and blocks all new orders until manually rearmed.'}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>
                      {isEs ? 'Cancelar' : 'Cancel'}
                    </AlertDialogCancel>
                    <AlertDialogAction onClick={handleToggleKillSwitch}>
                      {isEs ? 'Activar Kill-Switch' : 'Engage Kill-Switch'}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {isEs ? 'Modo Adaptador' : 'Adapter Mode'}
              </span>
              <strong className="font-mono text-xs font-semibold">
                {exchange?.mode === 'binance-testnet'
                  ? 'BINANCE TESTNET'
                  : 'DEMO VAULT LOCAL'}
              </strong>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {isEs ? 'Kill-Switch' : 'Kill-Switch'}
              </span>
              <strong
                className={cn(
                  'font-mono text-xs font-semibold',
                  killSwitchActive
                    ? 'text-[var(--negative)]'
                    : 'text-[var(--positive)]',
                )}
              >
                {killSwitchActive
                  ? isEs
                    ? 'BLOQUEO ACTIVO'
                    : 'EMERGENCY LOCK'
                  : isEs
                    ? 'ARMADO / SEGURO'
                    : 'ARMED / SAFE'}
              </strong>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {isEs ? 'Límite Duro / Orden' : 'Hard Cap / Order'}
              </span>
              <strong className="font-mono text-xs font-semibold tabular-nums">
                ${exchange?.hardLimits.maxOrderNotionalUsd ?? 500} USD
              </strong>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {isEs ? 'Órdenes Hoy' : 'Orders Today'}
              </span>
              <strong className="font-mono text-xs font-semibold tabular-nums">
                {exchange?.dailyOrderCount ?? 0} /{' '}
                {exchange?.hardLimits.maxDailyOrders ?? 12}
              </strong>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {isEs ? 'Pérdida Diaria Acum.' : 'Daily Realized Loss'}
              </span>
              <strong className="font-mono text-xs font-semibold tabular-nums">
                ${(exchange?.dailyRealizedLossUsd ?? 0).toFixed(2)} / $
                {exchange?.hardLimits.maxDailyLossUsd ?? 250}
              </strong>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {isEs ? 'Saldos (USDT / BTC)' : 'Balances (USDT / BTC)'}
              </span>
              <strong className="font-mono text-xs font-semibold tabular-nums">
                $
                {(
                  exchange?.balances.find((b) => b.asset === 'USDT')?.free ??
                  10000
                ).toFixed(0)}{' '}
                ·{' '}
                {(
                  exchange?.balances.find((b) => b.asset === 'BTC')?.free ?? 0.05
                ).toFixed(4)}{' '}
                BTC
              </strong>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-secondary/40 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="positive"
                size="xs"
                disabled={busyAction !== null}
                onClick={() => handleDemoOrder('BUY', 150)}
              >
                {isEs
                  ? `Comprar $150 (${activePreset.strategy.pair})`
                  : `Buy $150 (${activePreset.strategy.pair})`}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="xs"
                disabled={busyAction !== null}
                onClick={() => handleDemoOrder('SELL', 150)}
              >
                {isEs
                  ? `Vender $150 (${activePreset.strategy.pair})`
                  : `Sell $150 (${activePreset.strategy.pair})`}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={busyAction !== null}
                onClick={() => handleDemoOrder('BUY', 950)}
              >
                {isEs
                  ? 'Probar Rechazo ($950 > Tope)'
                  : 'Test Rejection ($950 > Cap)'}
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <span className="font-mono text-[10.5px] uppercase text-muted-foreground">
                {isEs ? 'Tope / Orden:' : 'Hard Cap:'}
              </span>
              <div
                className="inline-flex h-7 items-center gap-0.5 rounded-sm border border-border bg-card p-0.5"
                role="group"
              >
                {[250, 500, 1000].map((cap) => (
                  <button
                    key={cap}
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => handleChangeMaxOrderNotional(cap)}
                    className={cn(
                      'inline-flex h-[22px] items-center rounded-[4px] border px-2 font-mono text-[11px] font-medium transition-all duration-150 cursor-pointer disabled:opacity-40',
                      (exchange?.hardLimits.maxOrderNotionalUsd ?? 500) === cap
                        ? 'border-border bg-secondary font-semibold text-primary shadow-[0_1px_2px_rgba(0,0,0,0.18)]'
                        : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    ${cap} USD
                  </button>
                ))}
              </div>
            </div>
          </div>

          {exchangeFeedback && (
            <div
              className={cn(
                'flex items-center gap-2 rounded-sm border px-3 py-2 font-mono text-xs',
                exchangeFeedback.tone === 'pos'
                  ? 'border-[var(--positive)]/40 bg-[var(--positive-soft)] text-[var(--positive)]'
                  : 'border-[var(--negative)]/40 bg-[var(--negative-soft)] text-[var(--negative)]',
              )}
            >
              {exchangeFeedback.tone === 'pos' ? (
                <CheckCircle2 className="size-4 shrink-0" />
              ) : (
                <ShieldAlert className="size-4 shrink-0" />
              )}
              <span>{exchangeFeedback.message}</span>
            </div>
          )}

          {(exchange?.orders.length ?? 0) > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>{isEs ? 'Origen' : 'Source'}</TableHead>
                  <TableHead>{isEs ? 'Par' : 'Pair'}</TableHead>
                  <TableHead>{isEs ? 'Lado' : 'Side'}</TableHead>
                  <TableHead className="text-right">
                    {isEs ? 'Monto' : 'Notional'}
                  </TableHead>
                  <TableHead className="text-right">
                    {isEs ? 'Precio' : 'Price'}
                  </TableHead>
                  <TableHead>{isEs ? 'Estado' : 'Status'}</TableHead>
                  <TableHead>{isEs ? 'Detalle / Guardián' : 'Detail / Guardian'}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(exchange?.orders ?? []).slice(0, 8).map((ord) => (
                  <TableRow key={ord.id}>
                    <TableCell className="text-muted-foreground">
                      {ord.id}
                    </TableCell>
                    <TableCell>
                      {ord.source === 'bot-auto' ? 'BOT AUTO' : 'MANUAL'}
                    </TableCell>
                    <TableCell className="font-semibold">{ord.pair}</TableCell>
                    <TableCell>
                      <Badge
                        variant={ord.side === 'BUY' ? 'positive' : 'negative'}
                      >
                        {ord.side}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      ${ord.notionalUsd.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right">
                      ${ord.price.toFixed(2)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          ord.status === 'FILLED' ? 'positive' : 'negative'
                        }
                      >
                        {ord.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {ord.reason ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* MetaTrader 5 Bridge */}
      <Card>
        <CardHeader>
          <CardTitle>
            {isEs ? 'Puente MetaTrader 5' : 'MetaTrader 5 Bridge'}
          </CardTitle>
          <Button
            type="button"
            variant="default"
            size="xs"
            disabled={busyAction !== null}
            onClick={handleSimulateMt5Ping}
          >
            <Radio className="size-3.5" />
            <span>
              {isEs
                ? 'Simular Poll MT5 (/api/mt5/signal)'
                : 'Simulate MetaTrader 5 Poll (/api/mt5/signal)'}
            </span>
          </Button>
        </CardHeader>

        <CardContent className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {isEs ? 'Símbolo MT5' : 'MT5 Symbol'}
              </span>
              <strong className="font-mono text-xs font-semibold">
                {activeMt5Packet?.symbol ?? 'BTCUSD'}
              </strong>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {isEs ? 'Acción Emitida' : 'Emitted Action'}
              </span>
              <strong
                className={cn(
                  'font-mono text-xs font-semibold',
                  activeMt5Packet?.action === 'BUY'
                    ? 'text-[var(--positive)]'
                    : activeMt5Packet?.action === 'SELL' ||
                        activeMt5Packet?.action === 'CLOSE_ALL'
                      ? 'text-[var(--negative)]'
                      : 'text-foreground',
                )}
              >
                {activeMt5Packet?.action ?? 'HOLD'}
              </strong>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                Magic Number
              </span>
              <strong className="font-mono text-xs font-semibold">
                #{mt5?.magicNumber ?? 202615}
              </strong>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {isEs ? 'SL / TP' : 'Emitted SL / TP'}
              </span>
              <strong className="font-mono text-xs font-semibold tabular-nums">
                {activeMt5Packet?.stopLossPct ?? activePreset.strategy.stopLoss}% /{' '}
                {activeMt5Packet?.takeProfitPct ??
                  activePreset.strategy.takeProfit}
                %
              </strong>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                Profit-Lock
              </span>
              <strong className="font-mono text-xs font-semibold tabular-nums">
                {activeMt5Packet?.breakevenArmed
                  ? `ARMED ($${activeMt5Packet.stopPrice.toFixed(2)})`
                  : 'STANDBY'}
              </strong>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {isEs ? 'Consultas MT5' : 'MT5 Polls'}
              </span>
              <strong className="truncate font-mono text-xs font-semibold">
                {mt5?.pollCount ?? 0} polls ·{' '}
                {mt5?.lastTerminalName ??
                  (isEs ? 'Esperando EA' : 'Waiting for EA')}
              </strong>
            </div>
          </div>

          {activeMt5Packet && (
            <pre className="max-h-48 overflow-auto rounded-sm border border-[var(--border-subtle)] bg-secondary/60 p-2.5 font-mono text-[11px] text-muted-foreground">
              {JSON.stringify(activeMt5Packet, null, 2)}
            </pre>
          )}
        </CardContent>
      </Card>

      {/* Strategy Audit Table */}
      <Card>
        <CardHeader>
          <CardTitle>
            {isEs ? 'Auditoría de Estrategias' : 'Strategy Audit'}
          </CardTitle>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={busyAction !== null}
            onClick={handleRunAccuracyAudit}
          >
            {busyAction === 'audit'
              ? isEs
                ? 'Auditando 8 estrategias en Binance...'
                : 'Auditing 8 strategies on Binance...'
              : isEs
                ? 'Auditar las 8 Estrategias Ahora'
                : 'Audit All 8 Strategies Now'}
          </Button>
        </CardHeader>

        <CardContent className="p-3.5">
          {auditReport ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{isEs ? 'Estrategia / Preset' : 'Strategy / Preset'}</TableHead>
                  <TableHead>TF</TableHead>
                  <TableHead>{isEs ? 'Aciertos' : 'Wins/Total'}</TableHead>
                  <TableHead className="text-right">Win Rate</TableHead>
                  <TableHead className="text-right">Wilson 95%</TableHead>
                  <TableHead className="text-right">PF</TableHead>
                  <TableHead className="text-right">PnL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {auditReport.reports.map((r) => (
                  <TableRow key={r.presetId}>
                    <TableCell className="font-semibold">{r.name}</TableCell>
                    <TableCell>{r.timeframe}</TableCell>
                    <TableCell>
                      {r.wins} / {r.totalOperations}
                    </TableCell>
                    <TableCell className="text-right font-semibold text-[var(--positive)]">
                      {r.winRatePct.toFixed(1)}%
                    </TableCell>
                    <TableCell className="text-right">
                      {r.wilsonLowerBoundPct.toFixed(1)}%
                    </TableCell>
                    <TableCell className="text-right">
                      {r.profitFactor ?? '—'}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right font-semibold',
                        r.netPnlUsd >= 0
                          ? 'text-[var(--positive)]'
                          : 'text-[var(--negative)]',
                      )}
                    >
                      {r.netPnlUsd >= 0 ? '+' : ''}${r.netPnlUsd.toFixed(2)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-xs text-muted-foreground">
              {isEs
                ? 'Ejecuta la auditoría para comparar los 8 presets.'
                : 'Run audit to compare all 8 presets.'}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Engine Event Log */}
      <Card>
        <CardHeader>
          <CardTitle>{isEs ? 'Bitácora de Eventos' : 'Event Log'}</CardTitle>
          {closedTrades.length > 0 && onSaveSnapshot && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={handleSendToStats}
            >
              <BarChart3 className="size-3.5" />
              <span>
                {isEs
                  ? 'Enviar Operaciones a Estadísticas'
                  : 'Send Trades to Statistics'}
              </span>
              <ArrowRight className="size-3.5" />
            </Button>
          )}
        </CardHeader>

        <CardContent className="p-0">
          <ScrollArea className="max-h-56">
            <ul className="flex flex-col divide-y divide-border/70">
              {(engineState?.logs ?? []).slice(0, 12).map((log) => (
                <li
                  key={log.id}
                  className="flex items-start gap-2.5 px-3.5 py-2 font-mono text-[11.5px]"
                >
                  <Badge variant="secondary" className="shrink-0">
                    {log.level.toUpperCase()}
                  </Badge>
                  <span className="text-foreground">{log.message}</span>
                </li>
              ))}
            </ul>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Closed Spot Trades / Resolved Binary Tickets */}
      <section className="flex flex-col gap-2">
        <h2 className="font-display text-sm font-semibold uppercase tracking-[0.06em] text-foreground">
          {activePreset.domain === 'crypto-spot'
            ? isEs
              ? `Operaciones Cerradas (${closedTrades.length})`
              : `Closed Trades (${closedTrades.length})`
            : isEs
              ? `Contratos Resueltos (${resolvedTickets.length})`
              : `Resolved Contracts (${resolvedTickets.length})`}
        </h2>

        {activePreset.domain === 'crypto-spot' ? (
          <TradesTable trades={closedTrades} />
        ) : resolvedTickets.length === 0 ? (
          <Card className="p-6 text-center text-xs text-muted-foreground">
            {isEs
              ? 'Sin contratos resueltos en esta sesión.'
              : 'No resolved contracts in this session yet.'}
          </Card>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>
                  {isEs ? 'Regla / Contrato' : 'Rule / Contract'}
                </TableHead>
                <TableHead>{isEs ? 'Dirección' : 'Outcome'}</TableHead>
                <TableHead className="text-right">Stake</TableHead>
                <TableHead>{isEs ? 'Resultado' : 'Result'}</TableHead>
                <TableHead className="text-right">PnL</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resolvedTickets.slice(0, 12).map((tk) => (
                <TableRow key={tk.id}>
                  <TableCell className="text-muted-foreground">#{tk.id}</TableCell>
                  <TableCell>{tk.title}</TableCell>
                  <TableCell>
                    <Badge
                      variant={tk.outcome === 'YES' ? 'positive' : 'negative'}
                    >
                      {tk.outcome}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    ${tk.stakeUsd.toFixed(2)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={tk.won ? 'positive' : 'negative'}>
                      {tk.won ? 'WON' : 'LOST'}
                    </Badge>
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right font-semibold',
                      tk.netPnlUsd >= 0
                        ? 'text-[var(--positive)]'
                        : 'text-[var(--negative)]',
                    )}
                  >
                    {tk.netPnlUsd >= 0 ? '+' : ''}${tk.netPnlUsd.toFixed(2)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  )
}

export default BotRun
