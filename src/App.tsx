import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import {
  selectBotPresetOnServer,
  setApiBaseUrl,
} from './api/botClient'
import { clearCustomBotProfiles } from './botProfiles'
import type { AppSettings, BotStatus, Language, PageId, Strategy } from './types'
import { defaultStrategy, isStrategy } from './strategy'
import { defaultSettings, isAppSettings, normalizeAppSettings } from './settings'
import { useLocalStorageState } from './hooks/useLocalStorageState'
import { useTheme } from './hooks/useTheme'
import Dashboard from './pages/Dashboard'

const ChartTerminal = lazy(() => import('./pages/ChartTerminal'))
const BotConfig = lazy(() => import('./pages/BotConfig'))
const Training = lazy(() => import('./pages/Training'))
const BotRun = lazy(() => import('./pages/BotRun'))
const Stats = lazy(() => import('./pages/Stats'))
const Settings = lazy(() => import('./pages/Settings'))
const Backtest = lazy(() => import('./pages/Backtest'))
const Predictions = lazy(() => import('./pages/Predictions'))
import {
  isBacktestSnapshot,
  isBacktestSnapshotList,
  type BacktestSnapshot,
} from './backtest'
import AppDock from './components/navigation/AppDock'
import AppTopBar from './components/navigation/AppTopBar'
import { I18nProvider } from './i18n'
import { cn } from './lib/utils'
import { isPrimaryNavPage, popNavHistory, pushNavHistory } from './navItems'
import type { PredictionFocusTarget } from './pages/Predictions'

const BACKTEST_KEY = 'lixtrd:last-backtest'
const BACKTEST_HISTORY_KEY = 'lixtrd:backtest-history'
const MAX_BACKTEST_HISTORY = 25
const STRATEGY_KEY = 'lixtrd:strategy'
const SETTINGS_KEY = 'lixtrd:settings'

function scrollToTop(behavior: ScrollBehavior = 'instant') {
  if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
    window.scrollTo({ top: 0, behavior })
  }
}

function PageLoadFallback() {
  return (
    <div className="flex min-h-[280px] items-center justify-center rounded-md bg-card/40 text-xs font-medium tracking-wide text-muted-foreground">
      Loading…
    </div>
  )
}

function App() {
  const [activePage, setActivePage] = useState<PageId>('dashboard')
  const [pageHistory, setPageHistory] = useState<PageId[]>([])
  const [botStatus, setBotStatus] = useState<BotStatus>('stopped')
  const [terminalPair, setTerminalPair] = useState<string | null>(null)
  const [focusedPrediction, setFocusedPrediction] =
    useState<PredictionFocusTarget | null>(null)

  const [strategy, setStrategy] = useLocalStorageState<Strategy>(
    STRATEGY_KEY,
    defaultStrategy,
    isStrategy,
  )
  const [settings, setSettings] = useLocalStorageState<AppSettings>(
    SETTINGS_KEY,
    defaultSettings,
    isAppSettings,
  )

  const [lastBacktest, setLastBacktest] = useLocalStorageState<
    BacktestSnapshot | null
  >(
    BACKTEST_KEY,
    null,
    (value): value is BacktestSnapshot | null =>
      value === null || isBacktestSnapshot(value),
  )

  const [storedBacktestHistory, setStoredBacktestHistory] =
    useLocalStorageState<BacktestSnapshot[]>(
      BACKTEST_HISTORY_KEY,
      [],
      isBacktestSnapshotList,
    )

  const backtestHistory = useMemo(() => {
    if (storedBacktestHistory.length > 0) return storedBacktestHistory
    return lastBacktest ? [lastBacktest] : []
  }, [storedBacktestHistory, lastBacktest])

  function handleSaveBacktest(snapshot: BacktestSnapshot) {
    setLastBacktest(snapshot)
    setStoredBacktestHistory((prev) => {
      const base = prev.length > 0 ? prev : lastBacktest ? [lastBacktest] : []
      return [snapshot, ...base].slice(0, MAX_BACKTEST_HISTORY)
    })
  }

  const normalizedSettings = useMemo(
    () => normalizeAppSettings(settings),
    [settings],
  )

  useTheme(normalizedSettings.theme, {
    accentPreset: normalizedSettings.accentPreset,
    density: normalizedSettings.density,
    reducedMotion: normalizedSettings.reducedMotion,
  })

  const language: Language = normalizedSettings.language === 'es' ? 'es' : 'en'

  useEffect(() => {
    setApiBaseUrl(normalizedSettings.apiBaseUrl || null)
  }, [normalizedSettings.apiBaseUrl])

  function handleSaveStrategy(nextStrategy: Strategy) {
    setStrategy(nextStrategy)
    void selectBotPresetOnServer({ strategy: nextStrategy }).catch(() => {})
  }

  function handleResetAll() {
    setStrategy(defaultStrategy)
    setSettings({ ...defaultSettings, language })
    setLastBacktest(null)
    setStoredBacktestHistory([])
    clearCustomBotProfiles()
    setApiBaseUrl(null)
    void selectBotPresetOnServer({ strategy: defaultStrategy, reset: true }).catch(
      () => {},
    )
  }

  function handleOpenTerminalForPair(pair: string) {
    setTerminalPair(pair)
    handleContextualNavigate('terminal')
  }

  function handleOpenPredictionStrategy(target: PredictionFocusTarget) {
    setFocusedPrediction(target)
    handleContextualNavigate('predictions')
  }

  function handleContextualNavigate(nextPage: PageId) {
    if (nextPage === activePage) {
      scrollToTop('smooth')
      return
    }
    setPageHistory((prev) => pushNavHistory(prev, activePage, nextPage))
    setActivePage(nextPage)
    scrollToTop('instant')
  }

  function handleDockNavigate(nextPage: PageId) {
    if (isPrimaryNavPage(nextPage)) {
      setPageHistory([])
    } else if (nextPage !== activePage) {
      setPageHistory((prev) => pushNavHistory(prev, activePage, nextPage))
    }
    if (nextPage === activePage) {
      scrollToTop('smooth')
      return
    }
    setActivePage(nextPage)
    scrollToTop('instant')
  }

  function handleGoBack() {
    const { previous, rest } = popNavHistory(pageHistory)
    if (!previous) return
    setPageHistory(rest)
    setActivePage(previous)
    scrollToTop('instant')
  }

  const previousPage = pageHistory[pageHistory.length - 1] ?? null

  function renderPage() {
    switch (activePage) {
      case 'dashboard':
        return (
          <Dashboard
            botStatus={botStatus}
            strategy={strategy}
            backtestHistory={backtestHistory}
            onNavigate={handleContextualNavigate}
            onOpenTerminalForPair={handleOpenTerminalForPair}
            onOpenPredictionStrategy={handleOpenPredictionStrategy}
          />
        )
      case 'terminal':
        return (
          <ChartTerminal
            strategy={strategy}
            onSaveStrategy={handleSaveStrategy}
            onNavigate={handleContextualNavigate}
            initialPair={terminalPair}
            previousPage={previousPage}
            onBack={handleGoBack}
            soundAlerts={normalizedSettings.soundAlerts}
            density={normalizedSettings.density}
            reducedMotion={normalizedSettings.reducedMotion}
          />
        )
      case 'bot-config':
        return (
          <BotConfig
            strategy={strategy}
            onSave={handleSaveStrategy}
            onNavigate={handleContextualNavigate}
          />
        )
      case 'training':
        return <Training onNavigate={handleContextualNavigate} />
      case 'bot-run':
        return (
          <BotRun
            status={botStatus}
            onChangeStatus={setBotStatus}
            strategy={strategy}
            onNavigate={handleContextualNavigate}
            onSaveSnapshot={handleSaveBacktest}
          />
        )
      case 'backtest':
        return (
          <Backtest
            strategy={strategy}
            onNavigate={handleContextualNavigate}
            onSaveResult={handleSaveBacktest}
          />
        )
      case 'predictions':
        return (
          <Predictions
            onNavigate={handleContextualNavigate}
            onOpenTerminalForPair={handleOpenTerminalForPair}
            focusTarget={focusedPrediction}
            onClearFocusTarget={() => setFocusedPrediction(null)}
          />
        )
      case 'stats':
        return (
          <Stats
            backtest={lastBacktest}
            strategy={strategy}
            onNavigate={handleContextualNavigate}
          />
        )
      case 'settings':
        return (
          <Settings
            settings={normalizedSettings}
            strategy={strategy}
            onChangeSettings={setSettings}
            onChangeStrategy={handleSaveStrategy}
            onResetAll={handleResetAll}
          />
        )
    }
  }

  const isTerminalPage = activePage === 'terminal'

  return (
    <I18nProvider language={language}>
      <div
        className={cn(
          'flex flex-col bg-background text-foreground',
          isTerminalPage ? 'h-dvh overflow-hidden' : 'min-h-dvh',
        )}
      >
        <AppTopBar
          activePage={activePage}
          previousPage={previousPage}
          onBack={handleGoBack}
        />
        <main
          className={cn(
            'w-full min-w-0 flex-1',
            isTerminalPage
              ? 'flex min-h-0 flex-col overflow-hidden p-0'
              : 'mx-auto max-w-[1360px] px-3.5 pt-3.5 pb-[calc(var(--flare-dock-clearance,88px)+20px)] sm:px-5',
          )}
        >
          <Suspense fallback={<PageLoadFallback />}>{renderPage()}</Suspense>
        </main>
        <AppDock activePage={activePage} onNavigate={handleDockNavigate} />
      </div>
    </I18nProvider>
  )
}

export default App
