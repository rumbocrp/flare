import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3,
  CheckCircle2,
  FlaskConical,
  Keyboard,
  RefreshCw,
  ShieldAlert,
  SlidersHorizontal,
  WifiOff,
  X,
} from 'lucide-react'
import {
  buildBacktestSnapshotFromBot,
  cancelExchangeOrderOnServer,
  closePositionOnServer,
  fetchExchangeAccount,
  fetchExchangeOrders,
  fetchLatestBotAccuracyAudit,
  fetchMarketCandlesFromGateway,
  fetchRuntimeEvents,
  fundPaperAccountOnServer,
  getBotStatus,
  pauseBotOnServer,
  resetBotOnServer,
  resumeBotOnServer,
  selectBotPresetOnServer,
  startBotOnServer,
  stopBotOnServer,
  submitExchangeOrderOnServer,
  subscribeToBotStream,
  subscribeToMarketGatewayStream,
  toggleExchangeKillSwitchOnServer,
  triggerImmediateBotTick,
  updateHardLimitsOnServer,
  type BotServerSnapshot,
  type ExchangeAccountResponse,
  type ExchangeOrderRecord,
  type HardRiskLimits,
  type RuntimeEventRecord,
  type StrategyAuditRecord,
  type StreamConnectionStatus,
} from '@/api/botClient'
import type { BacktestSnapshot } from '@/backtest'
import {
  loadBotRunSectionState,
  saveBotRunSectionState,
  type BotRunSectionId,
  type BotRunSectionState,
} from '@/botRunUtils'
import PageHeader from '@/components/PageHeader'
import AccountCard from '@/components/botrun/AccountCard'
import ClosedTradesCard from '@/components/botrun/ClosedTradesCard'
import CommandBar from '@/components/botrun/CommandBar'
import EventLogCard from '@/components/botrun/EventLogCard'
import Mt5BridgeCard from '@/components/botrun/Mt5BridgeCard'
import OrdersCard from '@/components/botrun/OrdersCard'
import PositionsCard from '@/components/botrun/PositionsCard'
import RiskLimitsCard from '@/components/botrun/RiskLimitsCard'
import StrategyAuditCard from '@/components/botrun/StrategyAuditCard'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { BotStatus, Interval, PageId, Strategy } from '@/types'

type BotRunProps = {
  status: BotStatus
  onChangeStatus: (status: BotStatus) => void
  strategy: Strategy
  onNavigate?: (page: PageId) => void
  onSaveSnapshot?: (snapshot: BacktestSnapshot) => void
}

function deriveBotStatus(snap: BotServerSnapshot): BotStatus {
  if (snap.running) return 'running'
  if (snap.paused) return 'paused'
  return 'stopped'
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return Boolean(
    target.closest('[contenteditable="true"], [role="combobox"], [role="textbox"]'),
  )
}

function BotRun({
  onChangeStatus,
  strategy,
  onNavigate,
  onSaveSnapshot,
}: BotRunProps) {
  const { t } = useI18n()

  const [snapshot, setSnapshot] = useState<BotServerSnapshot | null>(null)
  const [streamStatus, setStreamStatus] =
    useState<StreamConnectionStatus>('connecting')
  const [lastSseAt, setLastSseAt] = useState<string | null>(null)
  const [initialLoaded, setInitialLoaded] = useState(false)
  const [retryNonce, setRetryNonce] = useState(0)

  const [account, setAccount] = useState<ExchangeAccountResponse | null>(null)
  const [accountLoading, setAccountLoading] = useState(false)
  const [accountError, setAccountError] = useState<string | null>(null)

  const [orders, setOrders] = useState<ExchangeOrderRecord[]>([])
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [ordersError, setOrdersError] = useState<string | null>(null)
  const [ordersSyncedAt, setOrdersSyncedAt] = useState<string | null>(null)

  const [events, setEvents] = useState<RuntimeEventRecord[]>([])
  const [eventsLoading, setEventsLoading] = useState(false)
  const [eventsError, setEventsError] = useState<string | null>(null)
  const [eventsSyncedAt, setEventsSyncedAt] = useState<string | null>(null)

  const [audits, setAudits] = useState<StrategyAuditRecord[]>([])
  const [auditsLoading, setAuditsLoading] = useState(false)
  const [auditsError, setAuditsError] = useState<string | null>(null)

  const [liveMark, setLiveMark] = useState<{
    pair: string
    price: number
  } | null>(null)

  const [sections, setSections] = useState<BotRunSectionState>(() =>
    loadBotRunSectionState(),
  )
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [confirmKillOpen, setConfirmKillOpen] = useState(false)
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [feedback, setFeedback] = useState<{
    tone: 'pos' | 'neg'
    message: string
  } | null>(null)

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const toggleSection = useCallback((id: BotRunSectionId) => {
    setSections((prev) => {
      const next = { ...prev, [id]: !prev[id] }
      saveBotRunSectionState(next)
      return next
    })
  }, [])

  const ensureSectionOpen = useCallback((id: BotRunSectionId) => {
    setSections((prev) => {
      if (prev[id]) return prev
      const next = { ...prev, [id]: true }
      saveBotRunSectionState(next)
      return next
    })
  }, [])

  const sectionTogglers = useMemo(
    () => ({
      account: () => toggleSection('account'),
      positions: () => toggleSection('positions'),
      orders: () => toggleSection('orders'),
      risk: () => toggleSection('risk'),
      mt5: () => toggleSection('mt5'),
      audit: () => toggleSection('audit'),
      events: () => toggleSection('events'),
      trades: () => toggleSection('trades'),
    }),
    [toggleSection],
  )

  const refreshAccount = useCallback(async (silent = false) => {
    if (!silent) setAccountLoading(true)
    setAccountError(null)
    try {
      const res = await fetchExchangeAccount()
      if (!mountedRef.current) return
      setAccount(res)
    } catch (err) {
      if (!mountedRef.current) return
      setAccountError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current && !silent) setAccountLoading(false)
    }
  }, [])

  const refreshOrders = useCallback(async (silent = false) => {
    if (!silent) setOrdersLoading(true)
    setOrdersError(null)
    try {
      const list = await fetchExchangeOrders({ limit: 200 })
      if (!mountedRef.current) return
      setOrders(list)
      setOrdersSyncedAt(
        list[0]?.updatedAt ?? list[0]?.timestamp ?? new Date().toISOString(),
      )
    } catch (err) {
      if (!mountedRef.current) return
      setOrdersError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current && !silent) setOrdersLoading(false)
    }
  }, [])

  const refreshEvents = useCallback(async (silent = false) => {
    if (!silent) setEventsLoading(true)
    setEventsError(null)
    try {
      const list = await fetchRuntimeEvents({ limit: 300 })
      if (!mountedRef.current) return
      setEvents(list)
      setEventsSyncedAt(list[0]?.timestamp ?? new Date().toISOString())
    } catch (err) {
      if (!mountedRef.current) return
      setEventsError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current && !silent) setEventsLoading(false)
    }
  }, [])

  const refreshAudits = useCallback(async (silent = false) => {
    if (!silent) setAuditsLoading(true)
    setAuditsError(null)
    try {
      const list = await fetchLatestBotAccuracyAudit()
      if (!mountedRef.current) return
      setAudits(list)
    } catch (err) {
      if (!mountedRef.current) return
      setAuditsError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current && !silent) setAuditsLoading(false)
    }
  }, [])

  const refreshAllSqlViews = useCallback(
    async (silent = false) => {
      await Promise.allSettled([
        refreshAccount(silent),
        refreshOrders(silent),
        refreshEvents(silent),
        ...(silent ? [] : [refreshAudits(false)]),
      ])
    },
    [refreshAccount, refreshOrders, refreshEvents, refreshAudits],
  )

  useEffect(() => {
    let active = true

    getBotStatus().then((snap) => {
      if (!active) return
      setSnapshot(snap)
      setInitialLoaded(true)
      if (snap) {
        setLastSseAt(new Date().toISOString())
        onChangeStatus(deriveBotStatus(snap))
        void refreshAllSqlViews(false)
      } else {
        setStreamStatus('offline')
        setAccount(null)
        setOrders([])
        setEvents([])
        setAudits([])
      }
    })

    const unsubscribe = subscribeToBotStream(
      (snap) => {
        if (!active) return
        setSnapshot(snap)
        setLastSseAt(new Date().toISOString())
        setInitialLoaded(true)
        onChangeStatus(deriveBotStatus(snap))
        void refreshAllSqlViews(true)
      },
      {
        onStatusChange: (nextStatus) => {
          if (!active) return
          setStreamStatus(nextStatus)
          if (nextStatus === 'offline') {
            setInitialLoaded(true)
          }
        },
      },
    )

    return () => {
      active = false
      unsubscribe()
    }
  }, [onChangeStatus, refreshAllSqlViews, retryNonce])

  // Live mark-price subscription for real unrealized PnL & ticket estimates
  const markPair =
    snapshot?.state.openPosition?.pair ??
    snapshot?.exchange?.botOwnedPosition?.pair ??
    snapshot?.preset.strategy.pair ??
    null

  useEffect(() => {
    if (!markPair) return
    let active = true
    const controller = new AbortController()

    fetchMarketCandlesFromGateway(markPair, '5m', 2, controller.signal).then(
      (res) => {
        if (!active || !res || res.candles.length === 0) return
        const last = res.candles[res.candles.length - 1]
        if (last && Number.isFinite(last.close) && last.close > 0) {
          setLiveMark({ pair: markPair, price: last.close })
        }
      },
    )

    const unsubscribe = subscribeToMarketGatewayStream(
      markPair,
      '5m',
      2,
      (ev) => {
        if (!active) return
        if (ev.type === 'snapshot' && ev.candles.length > 0) {
          const last = ev.candles[ev.candles.length - 1]
          if (last && Number.isFinite(last.close) && last.close > 0) {
            setLiveMark({ pair: markPair, price: last.close })
          }
        } else if (
          ev.type === 'candle' &&
          Number.isFinite(ev.candle.close) &&
          ev.candle.close > 0
        ) {
          setLiveMark({ pair: markPair, price: ev.candle.close })
        }
      },
      () => {
        // Keep last real price or null; never fabricate
      },
    )

    return () => {
      active = false
      controller.abort()
      unsubscribe()
    }
  }, [markPair])

  const effectiveMarkPrice =
    liveMark && markPair && liveMark.pair === markPair ? liveMark.price : null

  const runServerAction = useCallback(
    async <T,>(
      actionKey: string,
      fn: () => Promise<T>,
      onSuccess?: (result: T) => void,
    ): Promise<boolean> => {
      setBusyAction(actionKey)
      setFeedback(null)
      try {
        const result = await fn()
        onSuccess?.(result)
        await refreshAllSqlViews(true)
        return true
      } catch (err) {
        setFeedback({
          tone: 'neg',
          message: err instanceof Error ? err.message : String(err),
        })
        return false
      } finally {
        setBusyAction(null)
      }
    },
    [refreshAllSqlViews],
  )

  const handleRetryConnection = useCallback(() => {
    setFeedback(null)
    setInitialLoaded(false)
    setStreamStatus('connecting')
    setRetryNonce((n) => n + 1)
  }, [])

  const handleStart = useCallback(() => {
    if (!snapshot) return
    void runServerAction(
      'start',
      () => startBotOnServer({ presetId: snapshot.preset.id }),
      (next) => {
        setSnapshot(next)
        onChangeStatus(deriveBotStatus(next))
      },
    )
  }, [snapshot, runServerAction, onChangeStatus])

  const handlePause = useCallback(() => {
    void runServerAction('pause', () => pauseBotOnServer(), (next) => {
      setSnapshot(next)
      onChangeStatus(deriveBotStatus(next))
    })
  }, [runServerAction, onChangeStatus])

  const handleResume = useCallback(() => {
    void runServerAction('resume', () => resumeBotOnServer(), (next) => {
      setSnapshot(next)
      onChangeStatus(deriveBotStatus(next))
    })
  }, [runServerAction, onChangeStatus])

  const handleStop = useCallback(() => {
    void runServerAction('stop', () => stopBotOnServer(), (next) => {
      setSnapshot(next)
      onChangeStatus(deriveBotStatus(next))
    })
  }, [runServerAction, onChangeStatus])

  const handleTickNow = useCallback(() => {
    void runServerAction('tick', () => triggerImmediateBotTick(), (next) => {
      setSnapshot(next)
    })
  }, [runServerAction])

  const handleToggleKillSwitch = useCallback(() => {
    setConfirmKillOpen(false)
    const killSwitchActive = Boolean(snapshot?.exchange?.killSwitchActive)
    const action = killSwitchActive ? 'reset' : 'engage'
    void runServerAction(
      'kill-switch',
      () =>
        toggleExchangeKillSwitchOnServer({
          action,
          reason: t('botRun.killSwitchTriggerReason'),
        }),
      (next) => {
        setSnapshot(next)
        onChangeStatus(deriveBotStatus(next))
        setFeedback({
          tone: action === 'engage' ? 'neg' : 'pos',
          message:
            action === 'engage'
              ? t('botRun.killSwitchEngagedFeedback')
              : t('botRun.killSwitchRearmedFeedback'),
        })
      },
    )
  }, [snapshot, t, runServerAction, onChangeStatus])

  const handleFundPaper = useCallback(
    async (amountUsd: number) => {
      await runServerAction(
        'paper-fund',
        () => fundPaperAccountOnServer(amountUsd),
        (next) => {
          setSnapshot(next)
          setFeedback({
            tone: 'pos',
            message: t('botRun.acctFundedFeedback', {
              amount: amountUsd.toFixed(2),
            }),
          })
        },
      )
    },
    [t, runServerAction],
  )

  const handleResetSession = useCallback(async () => {
    await runServerAction('reset', () => resetBotOnServer(), (next) => {
      setSnapshot(next)
      onChangeStatus(deriveBotStatus(next))
    })
  }, [runServerAction, onChangeStatus])

  const handleClosePosition = useCallback(async () => {
    await runServerAction('close-pos', () => closePositionOnServer(), (res) => {
      setSnapshot(res.bot)
      setFeedback({
        tone: 'pos',
        message: t('botRun.posClosedFeedback', {
          paper: String(res.paperClosed),
          testnet: String(res.testnetClosed),
          mt5: String(res.mt5Pending),
        }),
      })
    })
  }, [t, runServerAction])

  const handleSubmitOrder = useCallback(
    async (params: {
      pair: string
      side: 'BUY' | 'SELL'
      notionalUsd: number
      clientOrderId: string
    }): Promise<boolean> => {
      return runServerAction(
        'manual-order',
        () => submitExchangeOrderOnServer(params),
        (res) => {
          setSnapshot(res.bot)
          setFeedback({
            tone: res.ok ? 'pos' : 'neg',
            message: res.ok
              ? t('botRun.orderSubmittedFeedback', {
                  id: res.order.id,
                  status: res.order.status,
                  dedup: res.deduplicated ? t('botRun.orderDedupSuffix') : '',
                })
              : (res.error ?? t('botRun.orderRejectedFeedback')),
          })
        },
      )
    },
    [t, runServerAction],
  )

  const handleCancelOrder = useCallback(
    async (orderId: string) => {
      await runServerAction(
        `cancel-${orderId}`,
        () => cancelExchangeOrderOnServer(orderId),
        (res) => {
          setSnapshot(res.bot)
          setFeedback({
            tone: 'pos',
            message: t('botRun.orderCanceledFeedback', { id: orderId }),
          })
        },
      )
    },
    [t, runServerAction],
  )

  const handleSaveHardLimits = useCallback(
    async (
      limits: Partial<HardRiskLimits> & { autoMirrorBotOrders?: boolean },
    ) => {
      await runServerAction(
        'limits',
        () => updateHardLimitsOnServer(limits),
        (next) => {
          setSnapshot(next)
          setFeedback({
            tone: 'pos',
            message: t('botRun.riskSavedFeedback'),
          })
        },
      )
    },
    [t, runServerAction],
  )

  const handleSelectPreset = useCallback(
    async (presetId: string) => {
      await runServerAction(
        'preset',
        () => selectBotPresetOnServer({ presetId }),
        (next) => setSnapshot(next),
      )
    },
    [runServerAction],
  )

  const handleSaveStrategyParams = useCallback(
    async (params: { strategy: Strategy; timeframe: Interval }) => {
      await runServerAction(
        'strategy-params',
        () => selectBotPresetOnServer(params),
        (next) => {
          setSnapshot(next)
          setFeedback({
            tone: 'pos',
            message: t('botRun.strategySavedFeedback'),
          })
        },
      )
    },
    [t, runServerAction],
  )

  const handleApplyBotSetup = useCallback(async () => {
    await runServerAction(
      'sync',
      () => selectBotPresetOnServer({ strategy }),
      (next) => {
        setSnapshot(next)
        setFeedback({
          tone: 'pos',
          message: t('botRun.setupAppliedFeedback'),
        })
      },
    )
  }, [strategy, t, runServerAction])

  const handleSendToStats = useCallback(() => {
    if (!snapshot || !onSaveSnapshot) return
    const btSnapshot = buildBacktestSnapshotFromBot(snapshot)
    onSaveSnapshot(btSnapshot)
    onNavigate?.('stats')
  }, [snapshot, onSaveSnapshot, onNavigate])

  const handleOpenShortcuts = useCallback(() => {
    setShortcutsOpen(true)
  }, [])

  // Keyboard shortcuts: P (pause/resume), C (close position w/ confirm), / (log search), ? (cheat sheet)
  useEffect(() => {
    if (!snapshot) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (isEditableTarget(e.target)) return

      const key = e.key
      if (key === '?') {
        e.preventDefault()
        setShortcutsOpen((prev) => !prev)
        return
      }
      if (confirmKillOpen || confirmCloseOpen || shortcutsOpen) return

      if (key === '/') {
        e.preventDefault()
        ensureSectionOpen('events')
        requestAnimationFrame(() => {
          const el = document.getElementById('botrun-event-search')
          if (el instanceof HTMLInputElement) {
            el.focus()
            el.select()
          }
        })
        return
      }

      if (key === 'p' || key === 'P') {
        if (busyAction !== null) return
        if (snapshot.running) {
          e.preventDefault()
          handlePause()
        } else if (snapshot.paused && !snapshot.exchange?.killSwitchActive) {
          e.preventDefault()
          handleResume()
        }
        return
      }

      if (key === 'c' || key === 'C') {
        const hasOpen = Boolean(
          snapshot.state.openPosition || snapshot.exchange?.botOwnedPosition,
        )
        if (hasOpen && busyAction === null) {
          e.preventDefault()
          ensureSectionOpen('positions')
          setConfirmCloseOpen(true)
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    snapshot,
    busyAction,
    confirmKillOpen,
    confirmCloseOpen,
    shortcutsOpen,
    ensureSectionOpen,
    handlePause,
    handleResume,
  ])

  const pageHeaderActions = onNavigate ? (
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
  ) : undefined

  // Offline / Backend Disconnected Gate — zero fabricated data shown
  if (!snapshot) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={t('botRun.title')} actions={pageHeaderActions} />

        <Card>
          <CardContent className="flex flex-col items-start gap-3 p-6">
            <div className="flex flex-wrap items-center gap-2.5">
              <WifiOff className="size-5 text-[var(--negative)]" />
              <strong className="text-sm font-bold text-foreground">
                {!initialLoaded && streamStatus === 'connecting'
                  ? t('botRun.connectingTitle')
                  : t('botRun.offlineTitle')}
              </strong>
              <Badge variant="negative">{streamStatus.toUpperCase()}</Badge>
            </div>
            <p className="max-w-2xl text-xs text-muted-foreground">
              {t('botRun.offlineDesc')}
            </p>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={handleRetryConnection}
            >
              <RefreshCw className="size-3.5" />
              <span>{t('botRun.retryConn')}</span>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('botRun.title')} actions={pageHeaderActions} />

      {/* Sticky 1-row Operator Command Bar */}
      <CommandBar
        snapshot={snapshot}
        account={account}
        streamStatus={streamStatus}
        busyAction={busyAction}
        confirmKillOpen={confirmKillOpen}
        onConfirmKillOpenChange={setConfirmKillOpen}
        onOpenShortcuts={handleOpenShortcuts}
        onStart={handleStart}
        onPause={handlePause}
        onResume={handleResume}
        onStop={handleStop}
        onTickNow={handleTickNow}
        onToggleKillSwitch={handleToggleKillSwitch}
      />

      {/* Action Feedback Banner */}
      {feedback && (
        <div
          role={feedback.tone === 'neg' ? 'alert' : 'status'}
          className={cn(
            'flex items-center justify-between gap-2 rounded-sm px-3 py-2 text-xs',
            feedback.tone === 'pos'
              ? 'bg-[var(--positive-soft)] text-[var(--positive)]'
              : 'bg-[var(--negative-soft)] text-[var(--negative)]',
          )}
        >
          <span className="flex items-center gap-2">
            {feedback.tone === 'pos' ? (
              <CheckCircle2 className="size-4 shrink-0" />
            ) : (
              <ShieldAlert className="size-4 shrink-0" />
            )}
            <span>{feedback.message}</span>
          </span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            aria-label={t('botRun.dismissNotice')}
            className="rounded-sm p-0.5 opacity-75 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {/* Two-column Operator Layout on wide screens */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        {/* Left Column: Account, Positions & Manual Ticket, Orders */}
        <div className="flex min-w-0 flex-col gap-4 xl:col-span-7">
          <AccountCard
            snapshot={snapshot}
            account={account}
            accountLoading={accountLoading}
            accountError={accountError}
            liveMarkPrice={effectiveMarkPrice}
            streamStatus={streamStatus}
            open={sections.account}
            onToggle={sectionTogglers.account}
            onRetryAccount={() => void refreshAccount(false)}
            onFundPaper={handleFundPaper}
            onResetSession={handleResetSession}
            busyAction={busyAction}
          />

          <PositionsCard
            snapshot={snapshot}
            account={account}
            orders={orders}
            liveMarkPrice={effectiveMarkPrice}
            liveMarkPair={markPair}
            lastSseAt={lastSseAt}
            streamStatus={streamStatus}
            open={sections.positions}
            onToggle={sectionTogglers.positions}
            busyAction={busyAction}
            confirmCloseOpen={confirmCloseOpen}
            onConfirmCloseOpenChange={setConfirmCloseOpen}
            onClosePosition={handleClosePosition}
            onSubmitOrder={handleSubmitOrder}
          />

          <OrdersCard
            orders={orders}
            updatedAt={ordersSyncedAt}
            streamStatus={streamStatus}
            loading={ordersLoading}
            error={ordersError}
            open={sections.orders}
            onToggle={sectionTogglers.orders}
            busyAction={busyAction}
            onRefresh={() => void refreshOrders(false)}
            onCancelOrder={handleCancelOrder}
          />
        </div>

        {/* Right Column: Risk & Strategy, MT5 Bridge, Strategy Audit */}
        <div className="flex min-w-0 flex-col gap-4 xl:col-span-5">
          <RiskLimitsCard
            snapshot={snapshot}
            strategy={strategy}
            events={events}
            streamStatus={streamStatus}
            open={sections.risk}
            onToggle={sectionTogglers.risk}
            busyAction={busyAction}
            onSaveHardLimits={handleSaveHardLimits}
            onSelectPreset={handleSelectPreset}
            onSaveStrategyParams={handleSaveStrategyParams}
            onApplyBotSetup={handleApplyBotSetup}
          />

          <Mt5BridgeCard
            mt5={snapshot.mt5}
            activePreset={snapshot.preset}
            streamStatus={streamStatus}
            open={sections.mt5}
            onToggle={sectionTogglers.mt5}
          />

          <StrategyAuditCard
            presets={snapshot.presets}
            audits={audits}
            streamStatus={streamStatus}
            loading={auditsLoading}
            error={auditsError}
            open={sections.audit}
            onToggle={sectionTogglers.audit}
            onRetry={() => void refreshAudits(false)}
            onAuditsUpdated={setAudits}
          />
        </div>
      </div>

      {/* Full-width Bottom Sections: Virtualized Event Log & Closed Trades */}
      <EventLogCard
        events={events}
        updatedAt={eventsSyncedAt}
        streamStatus={streamStatus}
        loading={eventsLoading}
        error={eventsError}
        open={sections.events}
        onToggle={sectionTogglers.events}
        onRefresh={() => void refreshEvents(false)}
      />

      <ClosedTradesCard
        trades={snapshot.state.closedTrades}
        resolvedTickets={snapshot.state.resolvedTickets}
        activePreset={snapshot.preset}
        streamStatus={streamStatus}
        open={sections.trades}
        onToggle={sectionTogglers.trades}
        onSendToStats={onSaveSnapshot ? handleSendToStats : undefined}
      />

      {/* Keyboard Shortcuts Cheat Sheet Dialog (?) */}
      <AlertDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Keyboard className="size-4" />
              <span>{t('botRun.shortcutsTitle')}</span>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('botRun.shortcutsDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2 py-1 font-mono text-xs">
            <div className="flex items-center justify-between gap-4 rounded-sm bg-muted/30 px-2.5 py-1.5">
              <kbd className="rounded-sm bg-background px-1.5 py-0.5 font-bold">
                P
              </kbd>
              <span className="flex-1 text-right text-muted-foreground">
                {t('botRun.shortcutPause')}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-sm bg-muted/30 px-2.5 py-1.5">
              <kbd className="rounded-sm bg-background px-1.5 py-0.5 font-bold">
                C
              </kbd>
              <span className="flex-1 text-right text-muted-foreground">
                {t('botRun.shortcutClose')}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-sm bg-muted/30 px-2.5 py-1.5">
              <kbd className="rounded-sm bg-background px-1.5 py-0.5 font-bold">
                /
              </kbd>
              <span className="flex-1 text-right text-muted-foreground">
                {t('botRun.shortcutSearch')}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-sm bg-muted/30 px-2.5 py-1.5">
              <kbd className="rounded-sm bg-background px-1.5 py-0.5 font-bold">
                ?
              </kbd>
              <span className="flex-1 text-right text-muted-foreground">
                {t('botRun.shortcutHelp')}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-sm bg-muted/30 px-2.5 py-1.5">
              <kbd className="rounded-sm bg-background px-1.5 py-0.5 font-bold">
                Esc
              </kbd>
              <span className="flex-1 text-right text-muted-foreground">
                {t('botRun.shortcutEsc')}
              </span>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setShortcutsOpen(false)}>
              {t('botRun.close')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default BotRun
