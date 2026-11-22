import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import {
  Activity,
  Check,
  Database,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Monitor,
  Moon,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  Sun,
  Upload,
  Volume2,
  XCircle,
} from 'lucide-react'
import {
  cancelPolymarketOrderOnServer,
  checkBackendHealth,
  getApiAuthToken,
  getApiTenantId,
  getBotStatus,
  getPolymarketExecutionStatus,
  getTenantAudit,
  getTenantLedger,
  pruneRetentionOnServer,
  reconcilePolymarketAccountOnServer,
  setApiAuthToken,
  setApiBaseUrl,
  setApiTenantId,
  subscribeToBotStream,
  toggleExchangeKillSwitchOnServer,
  updateHardLimitsOnServer,
  type BackendHealthResult,
  type BotServerSnapshot,
  type ExchangeStatusSnapshot,
  type PolymarketExecutorStatusView,
  type RetentionPruneReportView,
  type TenantAuditView,
  type TenantLedgerView,
} from '@/api/botClient'
import {
  loadCustomBotProfiles,
  playAlertChime,
  saveCustomBotProfiles,
} from '@/botProfiles'
import PageHeader from '@/components/PageHeader'
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
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
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
import { languageOptions, useI18n, type TranslationKey } from '@/i18n'
import { cn } from '@/lib/utils'
import { parseConfigBundle } from '@/settingsBundle'
import { availablePairs } from '@/strategy'
import type {
  AccentPreset,
  AppSettings,
  DensitySetting,
  Interval,
  Language,
  Strategy,
  ThemeSetting,
  TimezoneSetting,
} from '@/types'

type SettingsProps = {
  settings: AppSettings
  strategy: Strategy
  onChangeSettings: (settings: AppSettings) => void
  onChangeStrategy: (strategy: Strategy) => void
  onResetAll: () => void
}

type ConfirmAction = 'cancel-poly' | 'kill-switch' | 'reset-all'

type FeedbackState = {
  tone: 'positive' | 'negative'
  text: string
}

const themeOptions: {
  id: ThemeSetting
  labelKey: TranslationKey
  Icon: typeof Moon
}[] = [
  { id: 'dark', labelKey: 'settings.themeDark', Icon: Moon },
  { id: 'light', labelKey: 'settings.themeLight', Icon: Sun },
  { id: 'system', labelKey: 'settings.themeAuto', Icon: Monitor },
]

const accentOptions: {
  id: AccentPreset
  labelKey: TranslationKey
  swatchClass: string
}[] = [
  { id: 'amber', labelKey: 'settings.accentAmber', swatchClass: 'bg-[#ff704d]' },
  {
    id: 'emerald',
    labelKey: 'settings.accentEmerald',
    swatchClass: 'bg-[#0ecb81]',
  },
  {
    id: 'violet',
    labelKey: 'settings.accentViolet',
    swatchClass: 'bg-[#ab9ff2]',
  },
  { id: 'cyan', labelKey: 'settings.accentCyan', swatchClass: 'bg-[#57d6d2]' },
]

const densityOptions: { id: DensitySetting; labelKey: TranslationKey }[] = [
  { id: 'comfortable', labelKey: 'settings.densityComfortable' },
  { id: 'compact', labelKey: 'settings.densityCompact' },
]

const intervalOptions: { id: Interval; labelKey: TranslationKey }[] = [
  { id: '5m', labelKey: 'market.interval5m' },
  { id: '15m', labelKey: 'market.interval15m' },
  { id: '1h', labelKey: 'market.interval1h' },
  { id: '4h', labelKey: 'market.interval4h' },
  { id: '1d', labelKey: 'market.interval1d' },
]

const timezoneOptions: { id: TimezoneSetting; labelKey: TranslationKey }[] = [
  { id: 'UTC', labelKey: 'settings.tzUtc' },
  { id: 'local', labelKey: 'settings.tzLocal' },
]

function truncateAddress(address: string | null): string {
  if (!address) return '—'
  if (address.length <= 14) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function formatTimestamp(
  iso: string | null | undefined,
  timezone: TimezoneSetting,
): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  if (timezone === 'UTC') {
    return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`
  }
  return date.toLocaleString()
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function Settings({
  settings,
  strategy,
  onChangeSettings,
  onChangeStrategy,
  onResetAll,
}: SettingsProps) {
  const { t } = useI18n()

  // Render-time sync for apiBaseUrl so external updates (like onResetAll) stay aligned
  const [apiBaseInput, setApiBaseInput] = useState(settings.apiBaseUrl)
  const [syncedApiBaseUrl, setSyncedApiBaseUrl] = useState(settings.apiBaseUrl)
  if (syncedApiBaseUrl !== settings.apiBaseUrl) {
    setSyncedApiBaseUrl(settings.apiBaseUrl)
    setApiBaseInput(settings.apiBaseUrl)
  }

  // Backend credentials & health state
  const [tenantInput, setTenantInput] = useState(() => getApiTenantId())
  const [tokenInput, setTokenInput] = useState(() => getApiAuthToken() ?? '')
  const [showToken, setShowToken] = useState(false)
  const [endpointSavedMsg, setEndpointSavedMsg] = useState<string | null>(null)
  const [tenantSavedMsg, setTenantSavedMsg] = useState<string | null>(null)
  const [tokenSavedMsg, setTokenSavedMsg] = useState<string | null>(null)
  const [testingHealth, setTestingHealth] = useState(false)
  const [healthResult, setHealthResult] = useState<BackendHealthResult | null>(
    null,
  )

  // Chime feedback
  const [chimeFeedback, setChimeFeedback] = useState<FeedbackState | null>(null)

  // Live runtime telemetry state
  const [hydrating, setHydrating] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [botSnapshot, setBotSnapshot] = useState<BotServerSnapshot | null>(null)
  const [polyStatus, setPolyStatus] =
    useState<PolymarketExecutorStatusView | null>(null)
  const [ledger, setLedger] = useState<TenantLedgerView | null>(null)
  const [audit, setAudit] = useState<TenantAuditView | null>(null)

  // Hard risk limits draft form + SSE race guard
  const limitsDirtyRef = useRef(false)
  const [maxOrderNotionalInput, setMaxOrderNotionalInput] = useState('500')
  const [maxDailyLossInput, setMaxDailyLossInput] = useState('250')
  const [maxDailyOrdersInput, setMaxDailyOrdersInput] = useState('12')
  const [autoMirrorInput, setAutoMirrorInput] = useState(true)
  const [allowedPairsInput, setAllowedPairsInput] = useState<string[]>(() => [
    ...availablePairs,
  ])
  const [savingLimits, setSavingLimits] = useState(false)
  const [limitsFeedback, setLimitsFeedback] = useState<FeedbackState | null>(
    null,
  )

  // Venue action feedback
  const [polyReconciling, setPolyReconciling] = useState(false)
  const [polyCanceling, setPolyCanceling] = useState(false)
  const [polyFeedback, setPolyFeedback] = useState<FeedbackState | null>(null)
  const [vaultBusy, setVaultBusy] = useState(false)

  // Retention & bundle state
  const [retentionDaysInput, setRetentionDaysInput] = useState('90')
  const [pruningRetention, setPruningRetention] = useState(false)
  const [pruneReport, setPruneReport] =
    useState<RetentionPruneReportView | null>(null)
  const [pruneError, setPruneError] = useState<string | null>(null)
  const [bundleFeedback, setBundleFeedback] = useState<FeedbackState | null>(
    null,
  )
  const bundleFileInputRef = useRef<HTMLInputElement | null>(null)

  // Controlled destructive AlertDialog
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)

  function syncLimitsFromExchange(exchange?: ExchangeStatusSnapshot) {
    if (!exchange || limitsDirtyRef.current) return
    setMaxOrderNotionalInput(String(exchange.hardLimits.maxOrderNotionalUsd))
    setMaxDailyLossInput(String(exchange.hardLimits.maxDailyLossUsd))
    setMaxDailyOrdersInput(String(exchange.hardLimits.maxDailyOrders))
    setAutoMirrorInput(exchange.autoMirrorBotOrders)
    setAllowedPairsInput(
      exchange.hardLimits.allowedPairs.length > 0
        ? [...exchange.hardLimits.allowedPairs]
        : [...availablePairs],
    )
  }

  async function refreshAllTelemetry() {
    setRefreshing(true)
    try {
      const [bot, poly, nextLedger, nextAudit] = await Promise.all([
        getBotStatus(),
        getPolymarketExecutionStatus(),
        getTenantLedger(),
        getTenantAudit(40),
      ])
      setBotSnapshot(bot)
      setPolyStatus(poly)
      setLedger(nextLedger)
      setAudit(nextAudit)
      syncLimitsFromExchange(bot?.exchange)
    } finally {
      setHydrating(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    let active = true

    Promise.all([
      getBotStatus(),
      getPolymarketExecutionStatus(),
      getTenantLedger(),
      getTenantAudit(40),
    ]).then(([bot, poly, nextLedger, nextAudit]) => {
      if (!active) return
      setBotSnapshot(bot)
      setPolyStatus(poly)
      setLedger(nextLedger)
      setAudit(nextAudit)
      syncLimitsFromExchange(bot?.exchange)
      setHydrating(false)
    })

    const unsubscribe = subscribeToBotStream((snap) => {
      if (!active) return
      setBotSnapshot(snap)
      syncLimitsFromExchange(snap.exchange)
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  // Appearance & Workspace handlers
  function handleThemeChange(theme: ThemeSetting) {
    onChangeSettings({ ...settings, theme })
  }

  function handleLanguageChange(language: Language) {
    onChangeSettings({ ...settings, language })
  }

  function handleAccentChange(accentPreset: AccentPreset) {
    onChangeSettings({ ...settings, accentPreset })
  }

  function handleDensityChange(density: DensitySetting) {
    onChangeSettings({ ...settings, density })
  }

  function handleTimezoneChange(timezone: TimezoneSetting) {
    onChangeSettings({ ...settings, timezone })
  }

  function handleTestChime() {
    const played = playAlertChime()
    setChimeFeedback(
      played
        ? { tone: 'positive', text: t('settings.chimePlayed') }
        : { tone: 'negative', text: t('settings.chimeUnavailable') },
    )
  }

  // Backend Connection, Tenant & Auth handlers
  function handleApplyEndpoint() {
    const cleaned = apiBaseInput.trim().slice(0, 256)
    setApiBaseInput(cleaned)
    setApiBaseUrl(cleaned || null)
    onChangeSettings({ ...settings, apiBaseUrl: cleaned })
    setEndpointSavedMsg(cleaned || '/api')
    void refreshAllTelemetry()
  }

  function handleResetEndpoint() {
    setApiBaseInput('')
    setApiBaseUrl(null)
    onChangeSettings({ ...settings, apiBaseUrl: '' })
    setEndpointSavedMsg('/api')
    void refreshAllTelemetry()
  }

  function handleApplyTenant() {
    const cleaned = tenantInput.trim()
    setTenantInput(cleaned)
    setApiTenantId(cleaned || null)
    setTenantSavedMsg(cleaned || 'default')
    void refreshAllTelemetry()
  }

  function handleApplyToken() {
    const cleaned = tokenInput.trim()
    setTokenInput(cleaned)
    setApiAuthToken(cleaned || null)
    setTokenSavedMsg(cleaned ? '•••' : null)
    void refreshAllTelemetry()
  }

  function handleClearToken() {
    setTokenInput('')
    setApiAuthToken(null)
    setTokenSavedMsg(null)
    void refreshAllTelemetry()
  }

  async function handleTestHealth() {
    setTestingHealth(true)
    try {
      const result = await checkBackendHealth()
      setHealthResult(result)
    } finally {
      setTestingHealth(false)
    }
  }

  // Polymarket CLOB handlers
  async function handleReconcilePoly() {
    setPolyReconciling(true)
    setPolyFeedback(null)
    try {
      const res = await reconcilePolymarketAccountOnServer()
      if (res.ok && res.snapshot) {
        setPolyFeedback({
          tone: 'positive',
          text: t('settings.polyReconciled', {
            collateral: formatUsd(res.snapshot.collateralUsd),
            orders: res.snapshot.openOrdersCount,
          }),
        })
        const updated = await getPolymarketExecutionStatus()
        setPolyStatus(updated)
      } else {
        setPolyFeedback({
          tone: 'negative',
          text: res.error ?? t('settings.polyUnavailable'),
        })
      }
    } finally {
      setPolyReconciling(false)
    }
  }

  async function executeCancelAllPoly() {
    setPolyCanceling(true)
    setPolyFeedback(null)
    try {
      const res = await cancelPolymarketOrderOnServer({ cancelAll: true })
      if (res && res.ok) {
        if (res.polymarket) {
          setPolyStatus(res.polymarket)
        } else {
          const updated = await getPolymarketExecutionStatus()
          setPolyStatus(updated)
        }
        setPolyFeedback({
          tone: 'positive',
          text: t('settings.polyCanceled'),
        })
      } else {
        setPolyFeedback({
          tone: 'negative',
          text: res?.error ?? t('settings.polyUnavailable'),
        })
      }
    } finally {
      setPolyCanceling(false)
    }
  }

  function handleCancelAllPolyClick() {
    if (settings.confirmDestructive) {
      setConfirmAction('cancel-poly')
      return
    }
    void executeCancelAllPoly()
  }

  // Exchange Vault & Hard Risk Limits handlers
  function handleToggleAllowedPair(pair: string, checked: boolean) {
    setLimitsFeedback(null)
    setAllowedPairsInput((current) => {
      if (checked) {
        if (current.includes(pair)) return current
        limitsDirtyRef.current = true
        return [...current, pair]
      }
      if (current.length <= 1) return current
      limitsDirtyRef.current = true
      return current.filter((p) => p !== pair)
    })
  }

  async function handleSaveHardLimits() {
    setLimitsFeedback(null)

    const notionalText = maxOrderNotionalInput.trim()
    const dailyLossText = maxDailyLossInput.trim()
    const dailyOrdersText = maxDailyOrdersInput.trim()

    const rawMaxOrderNotional = Number(notionalText)
    const rawMaxDailyLoss = Number(dailyLossText)
    const rawMaxDailyOrders = Number(dailyOrdersText)

    if (
      notionalText === '' ||
      dailyLossText === '' ||
      dailyOrdersText === '' ||
      !Number.isFinite(rawMaxOrderNotional) ||
      rawMaxOrderNotional <= 0 ||
      !Number.isFinite(rawMaxDailyLoss) ||
      rawMaxDailyLoss <= 0 ||
      !Number.isFinite(rawMaxDailyOrders) ||
      !Number.isInteger(rawMaxDailyOrders) ||
      rawMaxDailyOrders < 1 ||
      allowedPairsInput.length === 0
    ) {
      setLimitsFeedback({
        tone: 'negative',
        text: t('settings.limitsInvalid'),
      })
      return
    }

    setSavingLimits(true)
    try {
      limitsDirtyRef.current = false
      const updated = await updateHardLimitsOnServer({
        maxOrderNotionalUsd: rawMaxOrderNotional,
        maxDailyLossUsd: rawMaxDailyLoss,
        maxDailyOrders: rawMaxDailyOrders,
        autoMirrorBotOrders: autoMirrorInput,
        allowedPairs: allowedPairsInput,
      })
      setBotSnapshot(updated)
      syncLimitsFromExchange(updated.exchange)
      setLimitsFeedback({
        tone: 'positive',
        text: t('settings.limitsSaved'),
      })
    } catch (err) {
      setLimitsFeedback({
        tone: 'negative',
        text: err instanceof Error ? err.message : t('settings.limitsInvalid'),
      })
    } finally {
      setSavingLimits(false)
    }
  }

  async function executeKillSwitchAction(action: 'engage' | 'reset') {
    setVaultBusy(true)
    try {
      const updated = await toggleExchangeKillSwitchOnServer({ action })
      setBotSnapshot(updated)
    } catch (err) {
      setLimitsFeedback({
        tone: 'negative',
        text: err instanceof Error ? err.message : t('settings.healthFail'),
      })
    } finally {
      setVaultBusy(false)
    }
  }

  function handleKillSwitchClick() {
    const isActive = Boolean(botSnapshot?.exchange?.killSwitchActive)
    if (isActive) {
      void executeKillSwitchAction('reset')
      return
    }
    if (settings.confirmDestructive) {
      setConfirmAction('kill-switch')
      return
    }
    void executeKillSwitchAction('engage')
  }

  // Retention Pruner handler
  async function handlePruneRetention() {
    const trimmed = retentionDaysInput.trim()
    const days = Number(trimmed)
    if (trimmed === '' || !Number.isFinite(days) || !Number.isInteger(days) || days < 1) {
      setPruneError(t('validation.range', { min: 1, max: 3650 }))
      return
    }

    setPruningRetention(true)
    setPruneError(null)
    setPruneReport(null)
    try {
      const res = await pruneRetentionOnServer(days)
      if (res.ok && res.report) {
        setPruneReport(res.report)
      } else {
        setPruneError(res.error ?? t('settings.healthFail'))
      }
    } finally {
      setPruningRetention(false)
    }
  }

  // JSON Bundle Export / Import handlers
  function handleExportBundle() {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings,
      strategy,
      customProfiles: loadCustomBotProfiles(),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'flare-config-bundle.json'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)

    setBundleFeedback({
      tone: 'positive',
      text: t('settings.bundleExported'),
    })
  }

  async function handleImportBundleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    const text = await file.text()
    const result = parseConfigBundle(text)
    if (!result.ok) {
      setBundleFeedback({
        tone: 'negative',
        text: t('settings.bundleError', { message: result.error }),
      })
      return
    }

    if (result.data.settings) {
      onChangeSettings(result.data.settings)
      setApiBaseInput(result.data.settings.apiBaseUrl)
      setApiBaseUrl(result.data.settings.apiBaseUrl || null)
    }
    if (result.data.strategy) {
      onChangeStrategy(result.data.strategy)
    }
    if (result.data.customProfiles) {
      saveCustomBotProfiles(result.data.customProfiles)
    }

    setBundleFeedback({
      tone: 'positive',
      text: t('settings.bundleImported', {
        profiles: loadCustomBotProfiles().length,
      }),
    })
  }

  // Restore All Data
  function executeResetAll() {
    setApiBaseInput('')
    limitsDirtyRef.current = false
    onResetAll()
  }

  function handleResetAllClick() {
    if (settings.confirmDestructive) {
      setConfirmAction('reset-all')
      return
    }
    executeResetAll()
  }

  function handleConfirmDialogAction() {
    const action = confirmAction
    setConfirmAction(null)
    switch (action) {
      case 'cancel-poly':
        void executeCancelAllPoly()
        break
      case 'kill-switch':
        void executeKillSwitchAction('engage')
        break
      case 'reset-all':
        executeResetAll()
        break
      case null:
        break
    }
  }

  const exchange = botSnapshot?.exchange
  const mt5 = botSnapshot?.mt5

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('settings.title')}
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={refreshing}
            onClick={() => void refreshAllTelemetry()}
          >
            <RefreshCw
              className={cn('size-3.5', refreshing && 'animate-spin')}
            />
            <span>{t('settings.refresh')}</span>
          </Button>
        }
      />

      {/* Section 1: Appearance */}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.secAppearance')}</CardTitle>
        </CardHeader>

        <CardContent className="flex flex-col gap-1 p-0">
          {/* Language */}
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3">
            <strong className="text-xs font-semibold text-foreground">
              {t('settings.language')}
            </strong>

            <Tabs
              value={settings.language}
              onValueChange={(val) => handleLanguageChange(val as Language)}
            >
              <TabsList aria-label={t('settings.language')}>
                {languageOptions.map((option) => (
                  <TabsTrigger key={option.id} value={option.id}>
                    {option.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          {/* Theme */}
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3">
            <strong className="text-xs font-semibold text-foreground">
              {t('settings.theme')}
            </strong>

            <Tabs
              value={settings.theme}
              onValueChange={(val) => handleThemeChange(val as ThemeSetting)}
            >
              <TabsList aria-label={t('settings.theme')}>
                {themeOptions.map(({ id, labelKey, Icon }) => (
                  <TabsTrigger key={id} value={id}>
                    <Icon className="size-3.5" />
                    <span>{t(labelKey)}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          {/* Accent preset */}
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3">
            <strong className="text-xs font-semibold text-foreground">
              {t('settings.accentPreset')}
            </strong>

            <Tabs
              value={settings.accentPreset}
              onValueChange={(val) => handleAccentChange(val as AccentPreset)}
            >
              <TabsList aria-label={t('settings.accentPreset')}>
                {accentOptions.map(({ id, labelKey, swatchClass }) => (
                  <TabsTrigger key={id} value={id}>
                    <span
                      aria-hidden="true"
                      className={cn('size-2 rounded-full', swatchClass)}
                    />
                    <span>{t(labelKey)}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          {/* Density */}
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3">
            <strong className="text-xs font-semibold text-foreground">
              {t('settings.density')}
            </strong>

            <Tabs
              value={settings.density}
              onValueChange={(val) =>
                handleDensityChange(val as DensitySetting)
              }
            >
              <TabsList aria-label={t('settings.density')}>
                {densityOptions.map(({ id, labelKey }) => (
                  <TabsTrigger key={id} value={id}>
                    {t(labelKey)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          {/* Reduced motion */}
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3">
            <Label
              htmlFor="settings-reduced-motion"
              className="text-xs font-semibold text-foreground"
            >
              {t('settings.reducedMotion')}
            </Label>

            <Switch
              id="settings-reduced-motion"
              checked={settings.reducedMotion}
              onCheckedChange={(checked) =>
                onChangeSettings({ ...settings, reducedMotion: checked })
              }
            />
          </div>

          {/* Default pair & interval */}
          <div className="grid gap-4 px-4 py-3 sm:grid-cols-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Label
                htmlFor="settings-default-pair"
                className="text-xs font-semibold text-foreground"
              >
                {t('settings.defaultPair')}
              </Label>

              <Select
                value={settings.defaultPair}
                onValueChange={(defaultPair) =>
                  onChangeSettings({ ...settings, defaultPair })
                }
              >
                <SelectTrigger id="settings-default-pair" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availablePairs.map((pair) => (
                    <SelectItem key={pair} value={pair}>
                      {pair}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <Label
                htmlFor="settings-default-interval"
                className="text-xs font-semibold text-foreground"
              >
                {t('settings.defaultInterval')}
              </Label>

              <Select
                value={settings.defaultInterval}
                onValueChange={(val) =>
                  onChangeSettings({
                    ...settings,
                    defaultInterval: val as Interval,
                  })
                }
              >
                <SelectTrigger id="settings-default-interval" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {intervalOptions.map(({ id, labelKey }) => (
                    <SelectItem key={id} value={id}>
                      {t(labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Timezone */}
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3">
            <strong className="text-xs font-semibold text-foreground">
              {t('settings.timezone')}
            </strong>

            <Tabs
              value={settings.timezone}
              onValueChange={(val) =>
                handleTimezoneChange(val as TimezoneSetting)
              }
            >
              <TabsList aria-label={t('settings.timezone')}>
                {timezoneOptions.map(({ id, labelKey }) => (
                  <TabsTrigger key={id} value={id}>
                    {t(labelKey)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          {/* Confirm destructive */}
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3">
            <Label
              htmlFor="settings-confirm-destructive"
              className="text-xs font-semibold text-foreground"
            >
              {t('settings.confirmDestructive')}
            </Label>

            <Switch
              id="settings-confirm-destructive"
              checked={settings.confirmDestructive}
              onCheckedChange={(checked) =>
                onChangeSettings({ ...settings, confirmDestructive: checked })
              }
            />
          </div>

          {/* Sound alerts + Test chime */}
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3">
            <div className="flex flex-col gap-0.5">
              <Label
                htmlFor="settings-sound-alerts"
                className="text-xs font-semibold text-foreground"
              >
                {t('settings.soundAlerts')}
              </Label>
              {chimeFeedback && (
                <span
                  className={cn(
                    'text-[11px] font-medium',
                    chimeFeedback.tone === 'positive'
                      ? 'text-[var(--positive)]'
                      : 'text-[var(--negative)]',
                  )}
                >
                  {chimeFeedback.text}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTestChime}
              >
                <Volume2 className="size-3.5" />
                <span>{t('settings.testChime')}</span>
              </Button>
              <Switch
                id="settings-sound-alerts"
                checked={settings.soundAlerts}
                onCheckedChange={(checked) =>
                  onChangeSettings({ ...settings, soundAlerts: checked })
                }
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Section 2: Connection & Auth */}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.secBackend')}</CardTitle>
          {healthResult && (
            <Badge variant={healthResult.ok ? 'positive' : 'negative'}>
              {healthResult.ok
                ? t('settings.healthOk', { status: healthResult.status ?? 200 })
                : t('settings.healthFail')}
            </Badge>
          )}
        </CardHeader>

        <CardContent className="flex flex-col gap-2 p-0">
          {/* Custom API Base URL */}
          <div className="flex flex-col gap-2 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label
                htmlFor="settings-api-base-url"
                className="text-xs font-semibold text-foreground"
              >
                {t('settings.apiBaseUrl')}
              </Label>
              {endpointSavedMsg && (
                <span className="font-mono text-[11px] text-[var(--positive)]">
                  {endpointSavedMsg}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="settings-api-base-url"
                value={apiBaseInput}
                onChange={(e) => setApiBaseInput(e.target.value)}
                placeholder={t('settings.apiBaseUrlPlaceholder')}
                className="min-w-[240px] flex-1"
              />
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={handleApplyEndpoint}
              >
                <Check className="size-3.5" />
                <span>{t('settings.applyEndpoint')}</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleResetEndpoint}
              >
                <RotateCcw className="size-3.5" />
                <span>{t('settings.resetEndpoint')}</span>
              </Button>
            </div>
          </div>

          {/* Tenant ID */}
          <div className="flex flex-col gap-2 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label
                htmlFor="settings-tenant-id"
                className="text-xs font-semibold text-foreground"
              >
                {t('settings.tenantId')}
              </Label>
              {tenantSavedMsg && (
                <span className="font-mono text-[11px] text-[var(--positive)]">
                  {tenantSavedMsg}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="settings-tenant-id"
                value={tenantInput}
                onChange={(e) => setTenantInput(e.target.value)}
                placeholder={t('settings.tenantIdPlaceholder')}
                className="min-w-[220px] flex-1"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleApplyTenant}
              >
                <Check className="size-3.5" />
                <span>{t('settings.applyTenant')}</span>
              </Button>
            </div>
          </div>

          {/* Bearer Token */}
          <div className="flex flex-col gap-2 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label
                htmlFor="settings-auth-token"
                className="text-xs font-semibold text-foreground"
              >
                {t('settings.authToken')}
              </Label>
              {tokenSavedMsg && (
                <span className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--positive)]">
                  <KeyRound className="size-3" />
                  <span>{tokenSavedMsg}</span>
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="settings-auth-token"
                type={showToken ? 'text' : 'password'}
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder={t('settings.authTokenPlaceholder')}
                className="min-w-[220px] flex-1"
                autoComplete="off"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={
                  showToken ? t('settings.hideToken') : t('settings.showToken')
                }
                onClick={() => setShowToken((prev) => !prev)}
              >
                {showToken ? (
                  <EyeOff className="size-3.5" />
                ) : (
                  <Eye className="size-3.5" />
                )}
                <span>
                  {showToken ? t('settings.hideToken') : t('settings.showToken')}
                </span>
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleApplyToken}
              >
                <Check className="size-3.5" />
                <span>{t('settings.applyToken')}</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleClearToken}
              >
                <XCircle className="size-3.5" />
                <span>{t('settings.clearToken')}</span>
              </Button>
            </div>
          </div>

          {/* Health Probe */}
          <div className="flex flex-col gap-3 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Activity className="size-4 text-primary" />
                <span className="text-xs font-semibold text-foreground">
                  {t('settings.testHealth')}
                </span>
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={testingHealth}
                onClick={() => void handleTestHealth()}
              >
                <Activity className="size-3.5" />
                <span>
                  {testingHealth
                    ? t('settings.testingHealth')
                    : t('settings.testHealth')}
                </span>
              </Button>
            </div>

            {healthResult && (
              <div className="grid gap-2 rounded-sm bg-muted/35 p-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[11px] text-muted-foreground">
                    {t('settings.healthLatency')}
                  </span>
                  <span className="font-mono font-semibold tabular-nums text-foreground">
                    {healthResult.latencyMs} ms
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[11px] text-muted-foreground">
                    {t('settings.healthDriver')}
                  </span>
                  <span className="font-mono font-semibold text-foreground">
                    {healthResult.storeDriver ?? '—'}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[11px] text-muted-foreground">
                    {t('settings.healthSharedState')}
                  </span>
                  <span className="font-mono font-semibold text-foreground">
                    {healthResult.sharedStateBackend ?? '—'}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[11px] text-muted-foreground">
                    {t('settings.healthTarget')}
                  </span>
                  <span className="truncate font-mono font-semibold text-foreground">
                    {healthResult.baseUrl}
                  </span>
                </div>
                {!healthResult.ok && healthResult.error && (
                  <div className="sm:col-span-2 lg:col-span-4">
                    <span className="font-mono text-[11px] text-[var(--negative)]">
                      {healthResult.error}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Section 3: Exchanges & Risk */}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.secVenues')}</CardTitle>
          {exchange && (
            <Badge
              variant={exchange.killSwitchActive ? 'negative' : 'positive'}
            >
              {exchange.killSwitchActive
                ? t('settings.killSwitchActive')
                : t('settings.killSwitchIdle')}
            </Badge>
          )}
        </CardHeader>

        <CardContent className="flex flex-col gap-3 p-0">
          {/* Polymarket CLOB block */}
          <div className="flex flex-col gap-3 px-4 py-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-xs font-semibold text-foreground">
                {t('settings.polyTitle')}
              </strong>
              {polyStatus && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={polyStatus.liveArmed ? 'warning' : 'secondary'}>
                    {polyStatus.liveArmed
                      ? t('settings.polyLiveArmed')
                      : t('settings.polyReadOnly')}
                  </Badge>
                  <Badge
                    variant={polyStatus.configured ? 'positive' : 'secondary'}
                  >
                    {polyStatus.configured
                      ? t('settings.polyConfigured')
                      : t('settings.polyNotConfigured')}
                  </Badge>
                </div>
              )}
            </div>

            {hydrating && !polyStatus ? (
              <div className="grid gap-2 sm:grid-cols-3">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : !polyStatus ? (
              <div className="rounded-sm bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
                {t('settings.polyUnavailable')}
              </div>
            ) : (
              <>
                <div className="grid gap-2.5 rounded-sm bg-muted/30 p-3 text-xs sm:grid-cols-2 lg:grid-cols-5">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[11px] text-muted-foreground">
                      {t('settings.polyChainId')}
                    </span>
                    <span className="font-mono font-semibold tabular-nums text-foreground">
                      {polyStatus.chainId}
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[11px] text-muted-foreground">
                      {t('settings.polySigner')}
                    </span>
                    <span
                      className="font-mono font-semibold text-foreground"
                      title={polyStatus.signerAddress ?? undefined}
                    >
                      {truncateAddress(polyStatus.signerAddress)}
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[11px] text-muted-foreground">
                      {t('settings.polyFunder')}
                    </span>
                    <span
                      className="font-mono font-semibold text-foreground"
                      title={polyStatus.funderAddress ?? undefined}
                    >
                      {truncateAddress(polyStatus.funderAddress)}
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[11px] text-muted-foreground">
                      {t('settings.polyL2Creds')}
                    </span>
                    <span className="font-mono font-semibold text-foreground">
                      {polyStatus.hasL2Creds
                        ? t('settings.polyReady')
                        : t('settings.polyMissing')}
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[11px] text-muted-foreground">
                      {t('settings.polyOrders')}
                    </span>
                    <span className="font-mono font-semibold tabular-nums text-foreground">
                      {polyStatus.orderCount}
                    </span>
                  </div>
                </div>

                {polyStatus.lastReconciliation && (
                  <div className="grid gap-2.5 rounded-sm bg-muted/25 p-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[11px] text-muted-foreground">
                        {t('settings.polyCollateral')}
                      </span>
                      <span className="font-mono font-semibold tabular-nums text-foreground">
                        {formatUsd(polyStatus.lastReconciliation.collateralUsd)}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[11px] text-muted-foreground">
                        {t('settings.polyAllowance')}
                      </span>
                      <span className="font-mono font-semibold tabular-nums text-foreground">
                        {formatUsd(polyStatus.lastReconciliation.allowanceUsd)}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[11px] text-muted-foreground">
                        {t('settings.polyOpenOrders')}
                      </span>
                      <span className="font-mono font-semibold tabular-nums text-foreground">
                        {polyStatus.lastReconciliation.openOrdersCount}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[11px] text-muted-foreground">
                        {t('settings.polyLastSync')}
                      </span>
                      <span className="font-mono font-semibold tabular-nums text-foreground">
                        {formatTimestamp(
                          polyStatus.lastReconciliation.syncedAt,
                          settings.timezone,
                        )}
                      </span>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={polyReconciling}
                    onClick={() => void handleReconcilePoly()}
                  >
                    <RefreshCw
                      className={cn(
                        'size-3.5',
                        polyReconciling && 'animate-spin',
                      )}
                    />
                    <span>
                      {polyReconciling
                        ? t('settings.polyReconciling')
                        : t('settings.polyReconcile')}
                    </span>
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={polyCanceling}
                    onClick={handleCancelAllPolyClick}
                  >
                    <XCircle className="size-3.5" />
                    <span>{t('settings.polyCancelAll')}</span>
                  </Button>
                  {polyFeedback && (
                    <span
                      className={cn(
                        'text-[11.5px] font-medium',
                        polyFeedback.tone === 'positive'
                          ? 'text-[var(--positive)]'
                          : 'text-[var(--negative)]',
                      )}
                    >
                      {polyFeedback.text}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Exchange Vault & Hard Risk Limits */}
          <div className="flex flex-col gap-3.5 px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-xs font-semibold text-foreground">
                {t('settings.vaultTitle')}
              </strong>
              {exchange && (
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <Badge variant="outline">
                    {t('settings.vaultMode')}: {exchange.mode}
                  </Badge>
                  <Badge variant="outline">
                    {t('settings.vaultDailyOrders')}: {exchange.dailyOrderCount}/
                    {exchange.hardLimits.maxDailyOrders}
                  </Badge>
                  <Badge variant="outline">
                    {t('settings.vaultDailyLoss')}:{' '}
                    {formatUsd(exchange.dailyRealizedLossUsd)}/
                    {formatUsd(exchange.hardLimits.maxDailyLossUsd)}
                  </Badge>
                </div>
              )}
            </div>

            {hydrating && !exchange ? (
              <div className="grid gap-2 sm:grid-cols-3">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="flex flex-col gap-1.5">
                    <Label
                      htmlFor="settings-max-order-notional"
                      className="text-xs text-foreground"
                    >
                      {t('settings.maxOrderNotional')} (USD)
                    </Label>
                    <Input
                      id="settings-max-order-notional"
                      type="number"
                      min="1"
                      step="1"
                      value={maxOrderNotionalInput}
                      onChange={(e) => {
                        limitsDirtyRef.current = true
                        setLimitsFeedback(null)
                        setMaxOrderNotionalInput(e.target.value)
                      }}
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label
                      htmlFor="settings-max-daily-loss"
                      className="text-xs text-foreground"
                    >
                      {t('settings.maxDailyLoss')} (USD)
                    </Label>
                    <Input
                      id="settings-max-daily-loss"
                      type="number"
                      min="1"
                      step="1"
                      value={maxDailyLossInput}
                      onChange={(e) => {
                        limitsDirtyRef.current = true
                        setLimitsFeedback(null)
                        setMaxDailyLossInput(e.target.value)
                      }}
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label
                      htmlFor="settings-max-daily-orders"
                      className="text-xs text-foreground"
                    >
                      {t('settings.maxDailyOrders')}
                    </Label>
                    <Input
                      id="settings-max-daily-orders"
                      type="number"
                      min="1"
                      step="1"
                      value={maxDailyOrdersInput}
                      onChange={(e) => {
                        limitsDirtyRef.current = true
                        setLimitsFeedback(null)
                        setMaxDailyOrdersInput(e.target.value)
                      }}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-4 rounded-sm bg-muted/25 px-3 py-2.5">
                  <div className="flex flex-col gap-0.5">
                    <Label
                      htmlFor="settings-auto-mirror"
                      className="text-xs font-semibold text-foreground"
                    >
                      {t('settings.autoMirror')}
                    </Label>
                    <span className="text-[11.5px] text-muted-foreground">
                      {t('settings.autoMirrorDesc')}
                    </span>
                  </div>
                  <Switch
                    id="settings-auto-mirror"
                    checked={autoMirrorInput}
                    onCheckedChange={(checked) => {
                      limitsDirtyRef.current = true
                      setLimitsFeedback(null)
                      setAutoMirrorInput(checked)
                    }}
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-foreground">
                    {t('settings.allowedPairs')}
                  </span>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                    {availablePairs.map((pair) => {
                      const checked = allowedPairsInput.includes(pair)
                      const isLastSelected =
                        checked && allowedPairsInput.length <= 1
                      return (
                        <label
                          key={pair}
                          className="flex cursor-pointer items-center gap-2 rounded-sm bg-muted/30 px-2.5 py-2 font-mono text-xs text-foreground hover:bg-muted/50"
                        >
                          <Checkbox
                            checked={checked}
                            disabled={isLastSelected}
                            onCheckedChange={(val) =>
                              handleToggleAllowedPair(pair, val === true)
                            }
                          />
                          <span>{pair}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      disabled={savingLimits}
                      onClick={() => void handleSaveHardLimits()}
                    >
                      <Save className="size-3.5" />
                      <span>{t('settings.saveLimits')}</span>
                    </Button>

                    {limitsFeedback && (
                      <span
                        className={cn(
                          'text-[11.5px] font-medium',
                          limitsFeedback.tone === 'positive'
                            ? 'text-[var(--positive)]'
                            : 'text-[var(--negative)]',
                        )}
                      >
                        {limitsFeedback.text}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant={
                        exchange?.killSwitchActive ? 'positive' : 'destructive'
                      }
                      size="sm"
                      disabled={vaultBusy}
                      onClick={handleKillSwitchClick}
                    >
                      <Power className="size-3.5" />
                      <span>
                        {exchange?.killSwitchActive
                          ? t('settings.rearmKillSwitch')
                          : t('settings.engageKillSwitch')}
                      </span>
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* MT5 EA Bridge */}
          <div className="flex flex-col gap-3 px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-xs font-semibold text-foreground">
                {t('settings.mt5Title')}
              </strong>
              {mt5 && (
                <Badge variant="secondary">
                  {mt5.executionState.toUpperCase()}
                </Badge>
              )}
            </div>

            <div className="grid gap-2.5 rounded-sm bg-muted/30 p-3 text-xs sm:grid-cols-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-muted-foreground">
                  {t('settings.mt5Magic')}
                </span>
                <span className="font-mono font-semibold tabular-nums text-foreground">
                  {mt5?.magicNumber ?? '—'}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-muted-foreground">
                  {t('settings.mt5Polls')}
                </span>
                <span className="font-mono font-semibold tabular-nums text-foreground">
                  {mt5 ? mt5.pollCount : '—'}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-muted-foreground">
                  {t('settings.mt5LastPoll')}
                </span>
                <span className="font-mono font-semibold tabular-nums text-foreground">
                  {formatTimestamp(mt5?.lastPollAt, settings.timezone)}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[11.5px] font-medium text-muted-foreground">
                {t('settings.mt5Terminals')}
              </span>
              {mt5?.terminals && mt5.terminals.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {mt5.terminals.map((term) => (
                    <div
                      key={`${term.terminalName}-${term.symbol ?? 'all'}`}
                      className="flex items-center gap-2 rounded-sm bg-muted/30 px-2.5 py-1.5 font-mono text-[11px]"
                    >
                      <span className="font-semibold text-foreground">
                        {term.terminalName}
                      </span>
                      {term.symbol && (
                        <Badge variant="outline">{term.symbol}</Badge>
                      )}
                      <span className="tabular-nums text-muted-foreground">
                        #{term.pollCount}
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {formatTimestamp(term.lastPollAt, settings.timezone)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t('settings.mt5NoTerminals')}
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Section 4: Ledger & Backup */}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.secLedger')}</CardTitle>
        </CardHeader>

        <CardContent className="flex flex-col gap-3 p-0">
          {/* Double-Entry Ledger */}
          <div className="flex flex-col gap-3 px-4 py-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-xs font-semibold text-foreground">
                {t('settings.ledgerTitle')}
              </strong>
              {ledger && (
                <div className="flex items-center gap-1.5">
                  <Badge
                    variant={
                      ledger.verification.balanced ? 'positive' : 'negative'
                    }
                  >
                    {ledger.verification.balanced
                      ? t('settings.ledgerBalanced')
                      : t('settings.ledgerUnbalanced')}
                  </Badge>
                  <Badge variant="outline">
                    {t('settings.ledgerEntries', {
                      count: ledger.verification.entryCount,
                    })}
                  </Badge>
                </div>
              )}
            </div>

            {hydrating && !ledger ? (
              <Skeleton className="h-14 w-full" />
            ) : !ledger ? (
              <div className="rounded-sm bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
                {t('settings.ledgerUnavailable')}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <span className="text-[11.5px] text-muted-foreground">
                  {t('settings.ledgerWallets')}
                </span>
                <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {Object.entries(ledger.walletBalances).map(
                    ([wallet, balance]) => (
                      <div
                        key={wallet}
                        className="flex items-center justify-between gap-2 rounded-sm bg-muted/30 px-3 py-2 text-xs"
                      >
                        <span className="truncate font-mono text-muted-foreground">
                          {wallet}
                        </span>
                        <span className="font-mono font-semibold tabular-nums text-foreground">
                          {balance.toLocaleString('en-US', {
                            maximumFractionDigits: 6,
                          })}
                        </span>
                      </div>
                    ),
                  )}
                </div>
              </div>
            )}
          </div>

          {/* RBAC Audit Log */}
          <div className="flex flex-col gap-3 px-4 py-3.5">
            <strong className="text-xs font-semibold text-foreground">
              {t('settings.auditTitle')}
            </strong>

            {hydrating && !audit ? (
              <Skeleton className="h-28 w-full" />
            ) : !audit || audit.events.length === 0 ? (
              <div className="rounded-sm bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
                {t('settings.auditEmpty')}
              </div>
            ) : (
              <ScrollArea className="h-[240px] rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('settings.auditTime')}</TableHead>
                      <TableHead>{t('settings.auditActor')}</TableHead>
                      <TableHead>{t('settings.auditRole')}</TableHead>
                      <TableHead>{t('settings.auditAction')}</TableHead>
                      <TableHead>{t('settings.auditOutcome')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {audit.events.map((evt) => (
                      <TableRow key={evt.id}>
                        <TableCell>
                          {formatTimestamp(evt.timestamp, settings.timezone)}
                        </TableCell>
                        <TableCell>{evt.actor}</TableCell>
                        <TableCell>{evt.role}</TableCell>
                        <TableCell>
                          {evt.action} · {evt.resource}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              evt.outcome === 'allowed'
                                ? 'positive'
                                : evt.outcome === 'denied'
                                  ? 'warning'
                                  : 'negative'
                            }
                          >
                            {evt.outcome}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            )}
          </div>

          {/* Database Retention Pruner */}
          <div className="flex flex-col gap-2.5 px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Database className="size-4 text-primary" />
                <strong className="text-xs font-semibold text-foreground">
                  {t('settings.retentionTitle')}
                </strong>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Label
                  htmlFor="settings-retention-days"
                  className="text-xs text-muted-foreground"
                >
                  {t('settings.retentionDays')}
                </Label>
                <Input
                  id="settings-retention-days"
                  type="number"
                  min="1"
                  step="1"
                  value={retentionDaysInput}
                  onChange={(e) => {
                    setRetentionDaysInput(e.target.value)
                    setPruneError(null)
                  }}
                  className="w-24"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pruningRetention}
                  onClick={() => void handlePruneRetention()}
                >
                  <Database className="size-3.5" />
                  <span>{t('settings.pruneRetention')}</span>
                </Button>
              </div>
            </div>

            {pruneReport && (
              <p className="text-[11.5px] font-medium text-[var(--positive)]">
                {t('settings.pruneReport', {
                  orders: pruneReport.deletedOrders,
                  audits: pruneReport.deletedAuditEvents,
                  candles: pruneReport.deletedCandles,
                  days: pruneReport.retentionDays,
                })}
              </p>
            )}
            {pruneError && (
              <p className="text-[11.5px] font-medium text-[var(--negative)]">
                {pruneError}
              </p>
            )}
          </div>

          {/* JSON Configuration Bundle */}
          <div className="flex flex-col gap-2.5 px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <strong className="text-xs font-semibold text-foreground">
                  {t('settings.bundleTitle')}
                </strong>
                <span className="text-[11.5px] text-muted-foreground">
                  {t('settings.bundleDesc')}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleExportBundle}
                >
                  <Download className="size-3.5" />
                  <span>{t('settings.exportBundle')}</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => bundleFileInputRef.current?.click()}
                >
                  <Upload className="size-3.5" />
                  <span>{t('settings.importBundle')}</span>
                </Button>
                <input
                  ref={bundleFileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => void handleImportBundleFile(e)}
                />
              </div>
            </div>

            {bundleFeedback && (
              <p
                className={cn(
                  'text-[11.5px] font-medium',
                  bundleFeedback.tone === 'positive'
                    ? 'text-[var(--positive)]'
                    : 'text-[var(--negative)]',
                )}
              >
                {bundleFeedback.text}
              </p>
            )}
          </div>

          {/* Stored Data & Restore All */}
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4">
            <div className="flex max-w-xl flex-col gap-0.5">
              <strong className="text-xs font-semibold text-foreground">
                {t('settings.storedData')}
              </strong>
              <span className="text-[11.5px] text-muted-foreground">
                {t('settings.storedDataDesc')}
              </span>
            </div>

            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleResetAllClick}
            >
              <RotateCcw className="size-3.5" />
              <span>{t('settings.reset')}</span>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Shared Destructive Confirmation Dialog */}
      <AlertDialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-[var(--negative)]" />
              <span>
                {confirmAction === 'cancel-poly'
                  ? t('settings.polyCancelAll')
                  : confirmAction === 'kill-switch'
                    ? t('settings.killSwitchConfirmTitle')
                    : t('settings.reset')}
              </span>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === 'cancel-poly'
                ? t('settings.polyCancelAllConfirm')
                : confirmAction === 'kill-switch'
                  ? t('settings.killSwitchConfirmDesc')
                  : t('settings.resetConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('settings.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDialogAction}>
              {confirmAction === 'cancel-poly'
                ? t('settings.polyCancelAllYes')
                : confirmAction === 'kill-switch'
                  ? t('settings.killSwitchConfirmYes')
                  : t('settings.resetYes')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default Settings
