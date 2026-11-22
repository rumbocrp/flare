import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  BrainCircuit,
  Check,
  Copy,
  Download,
  FlaskConical,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Upload,
} from 'lucide-react'
import {
  getBotStatus,
  selectBotPresetOnServer,
} from '@/api/botClient'
import {
  mergePresetPatch,
  resolvePresetPredictionRule,
  STRATEGY_PRESETS,
  type BotDomain,
  type SpotSignalEngine,
  type StrategyPreset,
  type StrategyPresetPatch,
} from '@/botEngine'
import {
  deleteCustomBotProfile,
  loadCustomBotProfiles,
  upsertCustomBotProfile,
  type SavedBotProfile,
} from '@/botProfiles'
import NumberField from '@/components/NumberField'
import PageHeader from '@/components/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useI18n, type Translate } from '@/i18n'
import { cn } from '@/lib/utils'
import { BITCOIN_20_PREDICTIONS } from '@/predictions'
import { availablePairs } from '@/strategy'
import type { AverageKind, Interval, PageId, Strategy } from '@/types'

type BotConfigProps = {
  strategy: Strategy
  onSave: (strategy: Strategy) => void
  onNavigate?: (page: PageId) => void
}

type StudioTab = 'preset' | 'signals' | 'risk' | 'execution'

type DraftValues = {
  basePresetId: string
  name: string
  description: string
  domain: BotDomain
  pair: string
  timeframe: Interval
  positionSize: string
  stopLoss: string
  takeProfit: string
  maxDailyRisk: string
  signalEngine: SpotSignalEngine
  fastPeriod: string
  slowPeriod: string
  average: AverageKind
  avoidRsiExtremes: boolean
  maxBuyRsi: string
  minSellRsi: string
  oversoldRsi: string
  overboughtRsi: string
  requireEma50Alignment: boolean
  breakevenAtOneR: boolean
  flipOnOppositeSignal: boolean
  predictionRuleId: string
  minEdgePct: string
  minTriggers: string
  useQuarterKelly: boolean
  initialBalance: string
  commissionPct: string
  slippagePct: string
  allowShort: boolean
}

type DraftErrors = Partial<Record<keyof DraftValues, string>>

const INTERVALS: readonly Interval[] = ['5m', '15m', '1h', '4h', '1d']

const RISK_PRESET_CHIPS: {
  id: 'conservative' | 'balanced' | 'aggressive'
  labelKey:
    | 'botConfig.chipConservative'
    | 'botConfig.chipBalanced'
    | 'botConfig.chipAggressive'
  positionSize: number
  stopLoss: number
  takeProfit: number
  maxDailyRisk: number
}[] = [
  {
    id: 'conservative',
    labelKey: 'botConfig.chipConservative',
    positionSize: 2,
    stopLoss: 1,
    takeProfit: 2.5,
    maxDailyRisk: 2,
  },
  {
    id: 'balanced',
    labelKey: 'botConfig.chipBalanced',
    positionSize: 10,
    stopLoss: 1.5,
    takeProfit: 3,
    maxDailyRisk: 3,
  },
  {
    id: 'aggressive',
    labelKey: 'botConfig.chipAggressive',
    positionSize: 25,
    stopLoss: 2.5,
    takeProfit: 5,
    maxDailyRisk: 5,
  },
]

function presetToDraft(preset: StrategyPreset): DraftValues {
  const filters = preset.filters ?? {}
  const resolvedRule = resolvePresetPredictionRule(preset)
  return {
    basePresetId: preset.id,
    name: preset.name,
    description: preset.description,
    domain: preset.domain,
    pair: preset.strategy.pair,
    timeframe: preset.timeframe,
    positionSize: String(preset.strategy.positionSize),
    stopLoss: String(preset.strategy.stopLoss),
    takeProfit: String(preset.strategy.takeProfit),
    maxDailyRisk: String(preset.strategy.maxDailyRisk),
    signalEngine: filters.signalEngine ?? 'momentum-structure',
    fastPeriod: String(preset.signalParams.fastPeriod),
    slowPeriod: String(preset.signalParams.slowPeriod),
    average: preset.signalParams.average,
    avoidRsiExtremes: filters.avoidRsiExtremes ?? true,
    maxBuyRsi: String(filters.maxBuyRsi ?? 68),
    minSellRsi: String(filters.minSellRsi ?? 32),
    oversoldRsi: String(filters.oversoldRsi ?? 30),
    overboughtRsi: String(filters.overboughtRsi ?? 70),
    requireEma50Alignment: filters.requireEma50Alignment ?? false,
    breakevenAtOneR: filters.breakevenAtOneR ?? true,
    flipOnOppositeSignal: filters.flipOnOppositeSignal ?? false,
    predictionRuleId:
      resolvedRule?.id ?? BITCOIN_20_PREDICTIONS[0]?.id ?? 'm5-ema50-bear-cap',
    minEdgePct: String(preset.minEdgePct ?? 15),
    minTriggers: String(preset.minTriggers ?? 5),
    useQuarterKelly: preset.useQuarterKelly ?? true,
    initialBalance: String(preset.execution.initialBalance),
    commissionPct: String(preset.execution.commissionPct),
    slippagePct: String(preset.execution.slippagePct),
    allowShort: preset.execution.allowShort,
  }
}

function draftToPatch(draft: DraftValues): StrategyPresetPatch {
  return {
    name: draft.name.trim() || undefined,
    description: draft.description.trim(),
    domain: draft.domain,
    timeframe: draft.timeframe,
    strategy: {
      pair: draft.pair,
      positionSize: Number(draft.positionSize),
      stopLoss: Number(draft.stopLoss),
      takeProfit: Number(draft.takeProfit),
      maxDailyRisk: Number(draft.maxDailyRisk),
    },
    signalParams: {
      fastPeriod: Math.round(Number(draft.fastPeriod)),
      slowPeriod: Math.round(Number(draft.slowPeriod)),
      average: draft.average,
    },
    filters: {
      signalEngine: draft.signalEngine,
      avoidRsiExtremes: draft.avoidRsiExtremes,
      maxBuyRsi: Math.round(Number(draft.maxBuyRsi)),
      minSellRsi: Math.round(Number(draft.minSellRsi)),
      oversoldRsi: Math.round(Number(draft.oversoldRsi)),
      overboughtRsi: Math.round(Number(draft.overboughtRsi)),
      requireEma50Alignment: draft.requireEma50Alignment,
      breakevenAtOneR: draft.breakevenAtOneR,
      flipOnOppositeSignal: draft.flipOnOppositeSignal,
    },
    predictionRuleId: draft.predictionRuleId,
    minEdgePct: Number(draft.minEdgePct),
    minTriggers: Math.round(Number(draft.minTriggers)),
    useQuarterKelly: draft.useQuarterKelly,
    execution: {
      initialBalance: Number(draft.initialBalance),
      commissionPct: Number(draft.commissionPct),
      slippagePct: Number(draft.slippagePct),
      allowShort: draft.allowShort,
    },
  }
}

function numberError(
  text: string,
  min: number,
  max: number,
  t: Translate,
): string | undefined {
  const value = Number(text)
  if (text.trim() === '' || Number.isNaN(value) || !Number.isFinite(value)) {
    return t('validation.number')
  }
  if (value < min || value > max) {
    return t('validation.range', { min, max })
  }
  return undefined
}

function validateDraft(values: DraftValues, t: Translate): DraftErrors {
  const errors: DraftErrors = {
    positionSize: numberError(values.positionSize, 0.1, 100, t),
    stopLoss: numberError(values.stopLoss, 0.1, 50, t),
    takeProfit: numberError(values.takeProfit, 0.1, 100, t),
    maxDailyRisk: numberError(values.maxDailyRisk, 0.1, 100, t),
    initialBalance: numberError(values.initialBalance, 100, 10_000_000, t),
    commissionPct: numberError(values.commissionPct, 0, 5, t),
    slippagePct: numberError(values.slippagePct, 0, 5, t),
  }

  if (values.domain === 'crypto-spot') {
    errors.fastPeriod = numberError(values.fastPeriod, 2, 150, t)
    errors.slowPeriod = numberError(values.slowPeriod, 3, 300, t)
    if (!errors.fastPeriod && !errors.slowPeriod) {
      if (Math.round(Number(values.fastPeriod)) >= Math.round(Number(values.slowPeriod))) {
        errors.fastPeriod = t('botConfig.errFastSlow')
      }
    }

    errors.maxBuyRsi = numberError(values.maxBuyRsi, 45, 95, t)
    errors.minSellRsi = numberError(values.minSellRsi, 5, 55, t)
    if (!errors.maxBuyRsi && !errors.minSellRsi) {
      if (Math.round(Number(values.minSellRsi)) > Math.round(Number(values.maxBuyRsi)) - 5) {
        errors.minSellRsi = t('botConfig.errBuySellRsi')
      }
    }

    errors.oversoldRsi = numberError(values.oversoldRsi, 5, 50, t)
    errors.overboughtRsi = numberError(values.overboughtRsi, 50, 95, t)
    if (!errors.oversoldRsi && !errors.overboughtRsi) {
      if (
        Math.round(Number(values.oversoldRsi)) >
        Math.round(Number(values.overboughtRsi)) - 5
      ) {
        errors.oversoldRsi = t('botConfig.errOversoldOverbought')
      }
    }
  } else {
    errors.minEdgePct = numberError(values.minEdgePct, 0, 50, t)
    errors.minTriggers = numberError(values.minTriggers, 1, 100, t)
  }

  return errors
}

function sameDraft(a: DraftValues, b: DraftValues): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function BotConfig({ strategy, onSave, onNavigate }: BotConfigProps) {
  const { t } = useI18n()

  const [hydrating, setHydrating] = useState(true)
  const [savedPreset, setSavedPreset] = useState<StrategyPreset>(() =>
    mergePresetPatch(STRATEGY_PRESETS[1], { strategy }),
  )
  const [draft, setDraft] = useState<DraftValues>(() =>
    presetToDraft(mergePresetPatch(STRATEGY_PRESETS[1], { strategy })),
  )
  const [activeTab, setActiveTab] = useState<StudioTab>('preset')

  // Custom profiles state
  const [customProfiles, setCustomProfiles] = useState<SavedBotProfile[]>(() =>
    loadCustomBotProfiles(),
  )
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null)
  const [profileNameInput, setProfileNameInput] = useState('')
  const [profileFeedback, setProfileFeedback] = useState<string | null>(null)

  // Save/sync & JSON import/copy state
  const [saving, setSaving] = useState(false)
  const [syncMessage, setSyncMessage] = useState<{
    tone: 'positive' | 'negative'
    text: string
  } | null>(null)
  const [copiedJson, setCopiedJson] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    getBotStatus()
      .then((snap) => {
        if (!active) return
        if (snap) {
          setSavedPreset(snap.preset)
          setDraft(presetToDraft(snap.preset))
        }
        setHydrating(false)
      })
      .catch(() => {
        if (active) setHydrating(false)
      })
    return () => {
      active = false
    }
  }, [])

  const savedDraft = useMemo(() => presetToDraft(savedPreset), [savedPreset])
  const errors = useMemo(() => validateDraft(draft, t), [draft, t])
  const errorCount = Object.values(errors).filter(
    (msg) => msg !== undefined,
  ).length
  const hasErrors = errorCount > 0
  const hasChanges = !sameDraft(draft, savedDraft)

  const ratio =
    errors.stopLoss === undefined && errors.takeProfit === undefined
      ? Number(draft.takeProfit) / Number(draft.stopLoss)
      : null

  const feeDragPct =
    errors.commissionPct === undefined && errors.slippagePct === undefined
      ? (Number(draft.commissionPct) + Number(draft.slippagePct)) * 2
      : null

  const selectedTemplate =
    STRATEGY_PRESETS.find((p) => p.id === draft.basePresetId) ??
    STRATEGY_PRESETS[1]

  const isResearchOnly =
    draft.domain === 'prediction-market' ||
    selectedTemplate.domain === 'prediction-market'

  const selectedPredictionRule =
    BITCOIN_20_PREDICTIONS.find((r) => r.id === draft.predictionRuleId) ??
    BITCOIN_20_PREDICTIONS.find((r) => r.timeframe === draft.timeframe) ??
    BITCOIN_20_PREDICTIONS[0]

  const previewPreset = useMemo(
    () => mergePresetPatch(selectedTemplate, draftToPatch(draft)),
    [selectedTemplate, draft],
  )

  function handleNumberChange(event: ChangeEvent<HTMLInputElement>) {
    const { name, value } = event.target
    setDraft((current) => ({ ...current, [name]: value }))
    setSyncMessage(null)
  }

  function handleSelectBasePreset(presetId: string) {
    const found = STRATEGY_PRESETS.find((p) => p.id === presetId)
    if (!found) return
    setActiveProfileId(null)
    setDraft(presetToDraft(found))
    setSyncMessage(null)
  }

  function handleLoadCustomProfile(profile: SavedBotProfile) {
    setActiveProfileId(profile.id)
    setProfileNameInput(profile.preset.name)
    setDraft(presetToDraft(profile.preset))
    setSyncMessage(null)
  }

  function handleSaveCustomProfile(duplicate: boolean) {
    const baseName = profileNameInput.trim() || draft.name.trim() || selectedTemplate.name
    const nextName = duplicate ? `${baseName} Copy` : baseName
    const nextList = upsertCustomBotProfile(previewPreset, nextName)
    setCustomProfiles(nextList)
    if (nextList[0]) {
      setActiveProfileId(nextList[0].id)
      setProfileNameInput(nextList[0].preset.name)
    }
    setProfileFeedback(t('botConfig.profileSaved', { name: nextName }))
  }

  function handleDeleteCustomProfile(id: string) {
    const nextList = deleteCustomBotProfile(id)
    setCustomProfiles(nextList)
    if (activeProfileId === id) {
      setActiveProfileId(null)
    }
    setProfileFeedback(t('botConfig.profileDeleted'))
  }

  function handleApplyRiskChip(
    chip: (typeof RISK_PRESET_CHIPS)[number],
  ) {
    setDraft((current) => ({
      ...current,
      positionSize: String(chip.positionSize),
      stopLoss: String(chip.stopLoss),
      takeProfit: String(chip.takeProfit),
      maxDailyRisk: String(chip.maxDailyRisk),
    }))
    setSyncMessage(null)
  }

  async function handleSaveAndSync() {
    if (hasErrors || saving) return
    setSaving(true)
    setSyncMessage(null)

    try {
      const patch = draftToPatch(draft)
      const normalized = mergePresetPatch(selectedTemplate, patch)
      const serverSnapshot = await selectBotPresetOnServer({
        presetId: normalized.id,
        timeframe: normalized.timeframe,
        customPreset: patch,
      })

      setSavedPreset(serverSnapshot.preset)
      setDraft(presetToDraft(serverSnapshot.preset))
      // Call onSave after selectBotPresetOnServer finishes to avoid racing App.tsx's handleSaveStrategy
      onSave(serverSnapshot.preset.strategy)
      setSyncMessage({ tone: 'positive', text: t('botConfig.synced') })
    } catch (err) {
      setSyncMessage({
        tone: 'negative',
        text: t('botConfig.syncError', {
          message: err instanceof Error ? err.message : 'Unknown error',
        }),
      })
    } finally {
      setSaving(false)
    }
  }

  function handleResetToBase() {
    setActiveProfileId(null)
    setDraft(presetToDraft(selectedTemplate))
    setSyncMessage(null)
  }

  async function handleCopyJson() {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(previewPreset, null, 2),
      )
      setCopiedJson(true)
      setTimeout(() => setCopiedJson(false), 1800)
    } catch {
      setImportOpen(true)
      setImportText(JSON.stringify(previewPreset, null, 2))
    }
  }

  function handleApplyJsonImport() {
    try {
      const parsed = JSON.parse(importText) as StrategyPresetPatch & {
        id?: string
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setImportError(t('botConfig.invalidJson'))
        return
      }
      const base =
        (typeof parsed.id === 'string' &&
          STRATEGY_PRESETS.find((p) => p.id === parsed.id)) ||
        selectedTemplate
      const merged = mergePresetPatch(base, parsed)
      setDraft(presetToDraft(merged))
      setImportError(null)
      setImportOpen(false)
      setSyncMessage(null)
    } catch {
      setImportError(t('botConfig.invalidJson'))
    }
  }

  const spotPresets = STRATEGY_PRESETS.filter((p) => p.domain === 'crypto-spot')
  const researchPresets = STRATEGY_PRESETS.filter(
    (p) => p.domain === 'prediction-market',
  )

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('botConfig.title')}
        actions={
          <>
            {hasChanges && (
              <Badge variant="warning">{t('botConfig.unsaved')}</Badge>
            )}
            {onNavigate && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onNavigate('training')}
                >
                  <BrainCircuit className="size-3.5" />
                  <span>{t('training.openTraining')}</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onNavigate('backtest')}
                >
                  <FlaskConical className="size-3.5" />
                  <span>{t('botConfig.tryBacktest')}</span>
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={() => onNavigate('bot-run')}
                >
                  <span>{t('botConfig.runBot')}</span>
                  <ArrowRight className="size-3.5" />
                </Button>
              </>
            )}
          </>
        }
      />

      {hydrating ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_350px]">
          <Skeleton className="h-[460px] w-full" />
          <Skeleton className="h-[460px] w-full" />
        </div>
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_350px]">
          {/* Left Column: 4-Tab Strategy Studio */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>{draft.name || selectedTemplate.name}</CardTitle>
                {isResearchOnly && (
                  <Badge variant="warning">
                    {t('botConfig.researchOnlyBadge')}
                  </Badge>
                )}
              </div>
              {ratio !== null && (
                <Badge variant={ratio >= 1.5 ? 'positive' : 'default'}>
                  {t('botConfig.riskReward', { ratio: ratio.toFixed(1) })}
                </Badge>
              )}
            </CardHeader>

            <CardContent>
              <Tabs
                value={activeTab}
                onValueChange={(val) => setActiveTab(val as StudioTab)}
                className="flex flex-col gap-4"
              >
                <TabsList
                  aria-label={t('botConfig.title')}
                  className="grid w-full grid-cols-2 sm:grid-cols-4"
                >
                  <TabsTrigger value="preset">
                    {t('botConfig.tabPreset')}
                  </TabsTrigger>
                  <TabsTrigger value="signals">
                    {t('botConfig.tabSignals')}
                  </TabsTrigger>
                  <TabsTrigger value="risk">
                    {t('botConfig.tabRisk')}
                  </TabsTrigger>
                  <TabsTrigger value="execution">
                    {t('botConfig.tabExecution')}
                  </TabsTrigger>
                </TabsList>

                {/* Tab 1: Base Preset & Mode */}
                <TabsContent value="preset" className="flex flex-col gap-4">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="studio-base-preset">
                        {t('botConfig.basePreset')}
                      </Label>
                      <Select
                        value={draft.basePresetId}
                        onValueChange={handleSelectBasePreset}
                      >
                        <SelectTrigger id="studio-base-preset">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectLabel>
                              {t('botConfig.spotGroup')}
                            </SelectLabel>
                            {spotPresets.map((preset) => (
                              <SelectItem key={preset.id} value={preset.id}>
                                {preset.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                          <SelectGroup>
                            <SelectLabel>
                              {t('botConfig.researchGroup')}
                            </SelectLabel>
                            {researchPresets.map((preset) => (
                              <SelectItem key={preset.id} value={preset.id}>
                                {preset.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <span className="text-[11px] text-muted-foreground">
                        {t('botConfig.basePresetHint')}
                      </span>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <Label>{t('botConfig.domain')}</Label>
                      <Tabs
                        value={draft.domain}
                        onValueChange={(val) =>
                          setDraft((current) => ({
                            ...current,
                            domain: val as BotDomain,
                          }))
                        }
                      >
                        <TabsList
                          aria-label={t('botConfig.domain')}
                          className="grid w-full grid-cols-2"
                        >
                          <TabsTrigger value="crypto-spot">
                            {t('botConfig.domainSpot')}
                          </TabsTrigger>
                          <TabsTrigger value="prediction-market">
                            {t('botConfig.domainPrediction')}
                          </TabsTrigger>
                        </TabsList>
                      </Tabs>
                    </div>
                  </div>

                  {isResearchOnly && (
                    <div className="flex items-start gap-2.5 rounded-sm bg-[var(--warning-soft)] p-3 text-xs text-foreground">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
                      <p className="leading-relaxed text-muted-foreground">
                        {t('botConfig.researchOnlyNotice')}
                      </p>
                    </div>
                  )}

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="field-pair">{t('botConfig.pair')}</Label>
                      <Select
                        value={draft.pair}
                        onValueChange={(pair) =>
                          setDraft((current) => ({ ...current, pair }))
                        }
                      >
                        <SelectTrigger id="field-pair">
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

                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="field-timeframe">
                        {t('botConfig.timeframe')}
                      </Label>
                      <Select
                        value={draft.timeframe}
                        onValueChange={(tf) =>
                          setDraft((current) => ({
                            ...current,
                            timeframe: tf as Interval,
                          }))
                        }
                      >
                        <SelectTrigger id="field-timeframe">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {INTERVALS.map((tf) => (
                            <SelectItem key={tf} value={tf}>
                              {tf}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="studio-preset-name">
                        {t('botConfig.presetName')}
                      </Label>
                      <Input
                        id="studio-preset-name"
                        maxLength={90}
                        value={draft.name}
                        onChange={(e) =>
                          setDraft((current) => ({
                            ...current,
                            name: e.target.value,
                          }))
                        }
                      />
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="studio-preset-notes">
                        {t('botConfig.presetNotes')}
                      </Label>
                      <Input
                        id="studio-preset-notes"
                        maxLength={280}
                        value={draft.description}
                        placeholder={t('botConfig.presetNotesPlaceholder')}
                        onChange={(e) =>
                          setDraft((current) => ({
                            ...current,
                            description: e.target.value,
                          }))
                        }
                      />
                    </div>
                  </div>

                  {/* Custom Profiles Manager */}
                  <div className="flex flex-col gap-3 rounded-sm bg-muted/30 p-3.5">
                    <div className="flex flex-wrap items-end justify-between gap-2">
                      <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
                        <Label htmlFor="studio-custom-profile-name">
                          {t('botConfig.profileName')}
                        </Label>
                        <Input
                          id="studio-custom-profile-name"
                          maxLength={90}
                          value={profileNameInput}
                          onChange={(e) => setProfileNameInput(e.target.value)}
                          placeholder={t('botConfig.profileNamePlaceholder')}
                        />
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => handleSaveCustomProfile(false)}
                        >
                          <Plus className="size-3.5" />
                          <span>{t('botConfig.saveProfile')}</span>
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => handleSaveCustomProfile(true)}
                        >
                          <Copy className="size-3.5" />
                          <span>{t('botConfig.duplicateProfile')}</span>
                        </Button>
                      </div>
                    </div>

                    {profileFeedback && (
                      <span className="text-[11.5px] font-medium text-[var(--positive)]">
                        {profileFeedback}
                      </span>
                    )}

                    <div className="flex flex-col gap-1.5">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        {t('botConfig.customProfiles')}
                      </span>
                      {customProfiles.length === 0 ? (
                        <span className="text-xs text-muted-foreground">
                          {t('botConfig.customProfilesEmpty')}
                        </span>
                      ) : (
                        <div className="flex flex-col gap-1.5">
                          {customProfiles.map((profile) => (
                            <div
                              key={profile.id}
                              className={cn(
                                'flex flex-wrap items-center justify-between gap-2 rounded-sm px-2.5 py-2 text-xs',
                                activeProfileId === profile.id
                                  ? 'bg-primary/12'
                                  : 'bg-background/40',
                              )}
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium text-foreground">
                                  {profile.preset.name}
                                </span>
                                <Badge variant="outline">
                                  {profile.preset.strategy.pair} ·{' '}
                                  {profile.preset.timeframe}
                                </Badge>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <Button
                                  type="button"
                                  size="xs"
                                  variant="outline"
                                  onClick={() =>
                                    handleLoadCustomProfile(profile)
                                  }
                                >
                                  <Download className="size-3" />
                                  <span>{t('botConfig.loadProfile')}</span>
                                </Button>
                                <Button
                                  type="button"
                                  size="xs"
                                  variant="ghost"
                                  aria-label={`${t('botConfig.deleteProfile')} ${profile.preset.name}`}
                                  onClick={() =>
                                    handleDeleteCustomProfile(profile.id)
                                  }
                                >
                                  <Trash2 className="size-3 text-[var(--negative)]" />
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </TabsContent>

                {/* Tab 2: Signals & Filters (Domain-Adaptive) */}
                <TabsContent value="signals" className="flex flex-col gap-4">
                  {draft.domain === 'crypto-spot' ? (
                    <>
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="studio-signal-engine">
                            {t('botConfig.signalEngine')}
                          </Label>
                          <Select
                            value={draft.signalEngine}
                            onValueChange={(val) =>
                              setDraft((current) => ({
                                ...current,
                                signalEngine: val as SpotSignalEngine,
                              }))
                            }
                          >
                            <SelectTrigger id="studio-signal-engine">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="momentum-structure">
                                {t('botConfig.engineMomentum')}
                              </SelectItem>
                              <SelectItem value="crossover">
                                {t('botConfig.engineCrossover')}
                              </SelectItem>
                              <SelectItem value="rsi-reversion">
                                {t('botConfig.engineRsi')}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          <span className="text-[11px] text-muted-foreground">
                            {t('botConfig.signalEngineHint')}
                          </span>
                        </div>

                        <div className="flex flex-col gap-1.5">
                          <Label>{t('botConfig.averageType')}</Label>
                          <Tabs
                            value={draft.average}
                            onValueChange={(val) =>
                              setDraft((current) => ({
                                ...current,
                                average: val as AverageKind,
                              }))
                            }
                          >
                            <TabsList
                              aria-label={t('botConfig.averageType')}
                              className="grid w-full grid-cols-2"
                            >
                              <TabsTrigger value="ema">
                                {t('botConfig.averageEma')}
                              </TabsTrigger>
                              <TabsTrigger value="sma">
                                {t('botConfig.averageSma')}
                              </TabsTrigger>
                            </TabsList>
                          </Tabs>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <NumberField
                          name="fastPeriod"
                          label={t('botConfig.fastPeriod')}
                          unit="bars"
                          hint={t('botConfig.fastPeriodHint')}
                          value={draft.fastPeriod}
                          error={errors.fastPeriod}
                          onChange={handleNumberChange}
                        />
                        <NumberField
                          name="slowPeriod"
                          label={t('botConfig.slowPeriod')}
                          unit="bars"
                          hint={t('botConfig.slowPeriodHint')}
                          value={draft.slowPeriod}
                          error={errors.slowPeriod}
                          onChange={handleNumberChange}
                        />
                      </div>

                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <NumberField
                          name="maxBuyRsi"
                          label={t('botConfig.maxBuyRsi')}
                          unit="RSI"
                          hint={t('botConfig.maxBuyRsiHint')}
                          value={draft.maxBuyRsi}
                          error={errors.maxBuyRsi}
                          onChange={handleNumberChange}
                        />
                        <NumberField
                          name="minSellRsi"
                          label={t('botConfig.minSellRsi')}
                          unit="RSI"
                          hint={t('botConfig.minSellRsiHint')}
                          value={draft.minSellRsi}
                          error={errors.minSellRsi}
                          onChange={handleNumberChange}
                        />
                        <NumberField
                          name="oversoldRsi"
                          label={t('botConfig.oversoldRsi')}
                          unit="RSI"
                          hint={t('botConfig.oversoldRsiHint')}
                          value={draft.oversoldRsi}
                          error={errors.oversoldRsi}
                          onChange={handleNumberChange}
                        />
                        <NumberField
                          name="overboughtRsi"
                          label={t('botConfig.overboughtRsi')}
                          unit="RSI"
                          hint={t('botConfig.overboughtRsiHint')}
                          value={draft.overboughtRsi}
                          error={errors.overboughtRsi}
                          onChange={handleNumberChange}
                        />
                      </div>

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="flex items-center justify-between gap-3 rounded-sm bg-muted/30 px-3 py-2.5">
                          <div className="flex flex-col gap-0.5">
                            <Label
                              htmlFor="filter-avoid-rsi"
                              className="text-xs font-medium"
                            >
                              {t('botConfig.avoidRsiExtremes')}
                            </Label>
                            <span className="text-[11px] text-muted-foreground">
                              {t('botConfig.avoidRsiExtremesHint')}
                            </span>
                          </div>
                          <Switch
                            id="filter-avoid-rsi"
                            checked={draft.avoidRsiExtremes}
                            onCheckedChange={(checked) =>
                              setDraft((current) => ({
                                ...current,
                                avoidRsiExtremes: checked,
                              }))
                            }
                          />
                        </div>

                        <div className="flex items-center justify-between gap-3 rounded-sm bg-muted/30 px-3 py-2.5">
                          <div className="flex flex-col gap-0.5">
                            <Label
                              htmlFor="filter-ema50"
                              className="text-xs font-medium"
                            >
                              {t('botConfig.requireEma50')}
                            </Label>
                            <span className="text-[11px] text-muted-foreground">
                              {t('botConfig.requireEma50Hint')}
                            </span>
                          </div>
                          <Switch
                            id="filter-ema50"
                            checked={draft.requireEma50Alignment}
                            onCheckedChange={(checked) =>
                              setDraft((current) => ({
                                ...current,
                                requireEma50Alignment: checked,
                              }))
                            }
                          />
                        </div>

                        <div className="flex items-center justify-between gap-3 rounded-sm bg-muted/30 px-3 py-2.5">
                          <div className="flex flex-col gap-0.5">
                            <Label
                              htmlFor="filter-breakeven"
                              className="text-xs font-medium"
                            >
                              {t('botConfig.breakevenAtOneR')}
                            </Label>
                            <span className="text-[11px] text-muted-foreground">
                              {t('botConfig.breakevenAtOneRHint')}
                            </span>
                          </div>
                          <Switch
                            id="filter-breakeven"
                            checked={draft.breakevenAtOneR}
                            onCheckedChange={(checked) =>
                              setDraft((current) => ({
                                ...current,
                                breakevenAtOneR: checked,
                              }))
                            }
                          />
                        </div>

                        <div className="flex items-center justify-between gap-3 rounded-sm bg-muted/30 px-3 py-2.5">
                          <div className="flex flex-col gap-0.5">
                            <Label
                              htmlFor="filter-flip"
                              className="text-xs font-medium"
                            >
                              {t('botConfig.flipOnOpposite')}
                            </Label>
                            <span className="text-[11px] text-muted-foreground">
                              {t('botConfig.flipOnOppositeHint')}
                            </span>
                          </div>
                          <Switch
                            id="filter-flip"
                            checked={draft.flipOnOppositeSignal}
                            onCheckedChange={(checked) =>
                              setDraft((current) => ({
                                ...current,
                                flipOnOppositeSignal: checked,
                              }))
                            }
                          />
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-start gap-2.5 rounded-sm bg-[var(--warning-soft)] p-3 text-xs text-foreground">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
                        <p className="leading-relaxed text-muted-foreground">
                          {t('botConfig.researchOnlyNotice')}
                        </p>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="studio-prediction-rule">
                          {t('botConfig.predictionRule')}
                        </Label>
                        <Select
                          value={draft.predictionRuleId}
                          onValueChange={(ruleId) =>
                            setDraft((current) => ({
                              ...current,
                              predictionRuleId: ruleId,
                            }))
                          }
                        >
                          <SelectTrigger id="studio-prediction-rule">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {BITCOIN_20_PREDICTIONS.map((rule) => (
                              <SelectItem key={rule.id} value={rule.id}>
                                #{rule.number} · {rule.timeframe} · {rule.title}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <span className="text-[11px] text-muted-foreground">
                          {t('botConfig.predictionRuleHint')}
                        </span>
                      </div>

                      {selectedPredictionRule && (
                        <div className="flex flex-col gap-2 rounded-sm bg-muted/30 p-3 text-xs">
                          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
                            <span>
                              #{selectedPredictionRule.number} · {selectedPredictionRule.timeframe}
                            </span>
                            <span>·</span>
                            <span>
                              {selectedPredictionRule.predictedOutcome}
                            </span>
                            <span>·</span>
                            <span>
                              {t('botConfig.ruleHorizonBars', {
                                bars: selectedPredictionRule.horizonBars,
                              })}
                            </span>
                            <span>·</span>
                            <span>{selectedPredictionRule.category}</span>
                          </div>
                          <p className="leading-relaxed text-foreground">
                            {selectedPredictionRule.contractQuestion}
                          </p>
                        </div>
                      )}

                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <NumberField
                          name="minEdgePct"
                          label={t('botConfig.minEdgePct')}
                          unit="%"
                          hint={t('botConfig.minEdgePctHint')}
                          value={draft.minEdgePct}
                          error={errors.minEdgePct}
                          onChange={handleNumberChange}
                        />
                        <NumberField
                          name="minTriggers"
                          label={t('botConfig.minTriggers')}
                          unit="n"
                          hint={t('botConfig.minTriggersHint')}
                          value={draft.minTriggers}
                          error={errors.minTriggers}
                          onChange={handleNumberChange}
                        />
                      </div>

                      <div className="flex items-center justify-between gap-3 rounded-sm bg-muted/30 px-3 py-2.5">
                        <div className="flex flex-col gap-0.5">
                          <Label
                            htmlFor="filter-quarter-kelly"
                            className="text-xs font-medium"
                          >
                            {t('botConfig.useQuarterKelly')}
                          </Label>
                          <span className="text-[11px] text-muted-foreground">
                            {t('botConfig.useQuarterKellyHint')}
                          </span>
                        </div>
                        <Switch
                          id="filter-quarter-kelly"
                          checked={draft.useQuarterKelly}
                          onCheckedChange={(checked) =>
                            setDraft((current) => ({
                              ...current,
                              useQuarterKelly: checked,
                            }))
                          }
                        />
                      </div>
                    </>
                  )}
                </TabsContent>

                {/* Tab 3: Risk & Sizing */}
                <TabsContent value="risk" className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t('botConfig.riskPresets')}:
                    </span>
                    {RISK_PRESET_CHIPS.map((chip) => (
                      <Button
                        key={chip.id}
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => handleApplyRiskChip(chip)}
                      >
                        {t(chip.labelKey)}
                      </Button>
                    ))}
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <NumberField
                      name="positionSize"
                      label={t('botConfig.positionSize')}
                      unit="%"
                      hint={t('botConfig.positionSizeHint')}
                      value={draft.positionSize}
                      error={errors.positionSize}
                      onChange={handleNumberChange}
                    />
                    <NumberField
                      name="stopLoss"
                      label={t('botConfig.stopLoss')}
                      unit="%"
                      hint={t('botConfig.stopLossHint')}
                      value={draft.stopLoss}
                      error={errors.stopLoss}
                      onChange={handleNumberChange}
                    />
                    <NumberField
                      name="takeProfit"
                      label={t('botConfig.takeProfit')}
                      unit="%"
                      hint={t('botConfig.takeProfitHint')}
                      value={draft.takeProfit}
                      error={errors.takeProfit}
                      onChange={handleNumberChange}
                    />
                    <NumberField
                      name="maxDailyRisk"
                      label={t('botConfig.maxDailyRisk')}
                      unit="%"
                      hint={t('botConfig.maxDailyRiskHint')}
                      value={draft.maxDailyRisk}
                      error={errors.maxDailyRisk}
                      onChange={handleNumberChange}
                    />
                  </div>
                </TabsContent>

                {/* Tab 4: Execution & Paper Vault */}
                <TabsContent value="execution" className="flex flex-col gap-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <NumberField
                      name="initialBalance"
                      label={t('botConfig.initialBalance')}
                      unit="$"
                      hint={t('botConfig.initialBalanceHint')}
                      value={draft.initialBalance}
                      error={errors.initialBalance}
                      onChange={handleNumberChange}
                    />
                    <NumberField
                      name="commissionPct"
                      label={t('botConfig.commissionPct')}
                      unit="%"
                      hint={t('botConfig.commissionPctHint')}
                      value={draft.commissionPct}
                      error={errors.commissionPct}
                      onChange={handleNumberChange}
                    />
                    <NumberField
                      name="slippagePct"
                      label={t('botConfig.slippagePct')}
                      unit="%"
                      hint={t('botConfig.slippagePctHint')}
                      value={draft.slippagePct}
                      error={errors.slippagePct}
                      onChange={handleNumberChange}
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3 rounded-sm bg-muted/30 px-3 py-2.5">
                    <div className="flex flex-col gap-0.5">
                      <Label
                        htmlFor="execution-allow-short"
                        className="text-xs font-medium"
                      >
                        {t('botConfig.allowShort')}
                      </Label>
                      <span className="text-[11px] text-muted-foreground">
                        {t('botConfig.allowShortHint')}
                      </span>
                    </div>
                    <Switch
                      id="execution-allow-short"
                      checked={draft.allowShort}
                      onCheckedChange={(checked) =>
                        setDraft((current) => ({
                          ...current,
                          allowShort: checked,
                        }))
                      }
                    />
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>

          {/* Right Column: Summary */}
          <Card className="lg:sticky lg:top-4">
            <CardHeader>
              <CardTitle>{t('botConfig.blueprintTitle')}</CardTitle>
              <Badge variant={hasErrors ? 'negative' : 'positive'}>
                {hasErrors
                  ? t('botConfig.validationErrors', { count: errorCount })
                  : t('botConfig.statusReady')}
              </Badge>
            </CardHeader>

            <CardContent className="flex flex-col gap-0.5 p-0 text-xs tabular-nums">
              <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
                <span className="text-muted-foreground">
                  {t('botConfig.blueprintDomain')}
                </span>
                {isResearchOnly ? (
                  <Badge variant="warning">
                    {t('botConfig.researchOnlyBadge')}
                  </Badge>
                ) : (
                  <Badge variant="default">{t('botConfig.domainSpot')}</Badge>
                )}
              </div>

              <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
                <span className="text-muted-foreground">
                  {t('botConfig.blueprintPairTf')}
                </span>
                <span className="font-mono font-semibold text-foreground">
                  {draft.pair} · {draft.timeframe}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
                <span className="text-muted-foreground">
                  {t('botConfig.blueprintSignal')}
                </span>
                <span className="text-right font-mono text-foreground">
                  {draft.domain === 'crypto-spot'
                    ? `${draft.average.toUpperCase()} ${draft.fastPeriod}/${draft.slowPeriod} · ${draft.signalEngine}`
                    : `#${selectedPredictionRule?.number ?? 1} · ${draft.minEdgePct}% edge`}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
                <span className="text-muted-foreground">
                  {t('botConfig.blueprintRisk')}
                </span>
                <span className="font-mono text-foreground">
                  {draft.positionSize}% / {draft.stopLoss}% / {draft.takeProfit}% /{' '}
                  {draft.maxDailyRisk}%
                </span>
              </div>

              <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
                <span className="text-muted-foreground">
                  {t('botConfig.blueprintFeeDrag')}
                </span>
                <span className="font-mono font-semibold text-foreground">
                  {feeDragPct !== null ? `${feeDragPct.toFixed(2)}%` : '—'}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
                <span className="text-muted-foreground">
                  {t('botConfig.blueprintStatus')}
                </span>
                <span
                  className={cn(
                    'font-medium',
                    hasErrors
                      ? 'text-[var(--negative)]'
                      : 'text-[var(--positive)]',
                  )}
                >
                  {hasErrors
                    ? t('botConfig.statusInvalid')
                    : t('botConfig.statusReady')}
                </span>
              </div>

              {syncMessage && (
                <div className="px-3.5 py-2.5">
                  <p
                    className={cn(
                      'text-[11.5px] font-medium',
                      syncMessage.tone === 'positive'
                        ? 'text-[var(--positive)]'
                        : 'text-[var(--negative)]',
                    )}
                  >
                    {syncMessage.text}
                  </p>
                </div>
              )}

              {importOpen && (
                <div className="flex flex-col gap-2 px-3.5 py-3">
                  <Label htmlFor="studio-import-json">
                    {t('botConfig.importJson')}
                  </Label>
                  <textarea
                    id="studio-import-json"
                    rows={5}
                    value={importText}
                    onChange={(e) => {
                      setImportText(e.target.value)
                      setImportError(null)
                    }}
                    placeholder={t('botConfig.importJsonPlaceholder')}
                    className="w-full rounded-sm bg-muted/40 p-2 font-mono text-[11px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  {importError && (
                    <span className="text-[11px] text-[var(--negative)]">
                      {importError}
                    </span>
                  )}
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="xs"
                      variant="default"
                      onClick={handleApplyJsonImport}
                    >
                      {t('botConfig.applyJson')}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        setImportOpen(false)
                        setImportError(null)
                      }}
                    >
                      {t('botConfig.cancelJson')}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>

            <CardFooter className="flex-col items-stretch gap-2">
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={hasErrors || saving}
                onClick={() => void handleSaveAndSync()}
              >
                <Save className="size-3.5" />
                <span>
                  {saving ? t('botConfig.saving') : t('botConfig.saveAndSync')}
                </span>
              </Button>

              <div className="grid grid-cols-3 gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={handleResetToBase}
                >
                  <RotateCcw className="size-3" />
                  <span>{t('botConfig.resetToBase')}</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => void handleCopyJson()}
                >
                  {copiedJson ? (
                    <Check className="size-3 text-[var(--positive)]" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                  <span>
                    {copiedJson
                      ? t('botConfig.copiedJson')
                      : t('botConfig.copyJson')}
                  </span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => setImportOpen((prev) => !prev)}
                >
                  <Upload className="size-3" />
                  <span>{t('botConfig.importJson')}</span>
                </Button>
              </div>
            </CardFooter>
          </Card>
        </div>
      )}
    </div>
  )
}

export default BotConfig
