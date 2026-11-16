import { lazy, Suspense, useEffect, useState } from 'react'
import { selectBotPresetOnServer } from './api/botClient'
import type { AppSettings, BotStatus, Language, PageId, Strategy } from './types'
import { defaultStrategy, isStrategy } from './strategy'
import { defaultSettings, isAppSettings } from './settings'
import { useLocalStorageState } from './hooks/useLocalStorageState'
import { useTheme } from './hooks/useTheme'
import Dashboard from './pages/Dashboard'

const ChartTerminal = lazy(() => import('./pages/ChartTerminal'))
const BotConfig = lazy(() => import('./pages/BotConfig'))
const BotRun = lazy(() => import('./pages/BotRun'))
const Stats = lazy(() => import('./pages/Stats'))
const Settings = lazy(() => import('./pages/Settings'))
const Backtest = lazy(() => import('./pages/Backtest'))
const Predictions = lazy(() => import('./pages/Predictions'))
import {
  isBacktestSnapshot,
  type BacktestSnapshot,
} from './backtest'
import AppDock from './components/navigation/AppDock'
import AppTopBar from './components/navigation/AppTopBar'
import { I18nProvider } from './i18n'
import { isPrimaryNavPage, popNavHistory, pushNavHistory } from './navItems'

const BACKTEST_KEY = 'lixtrd:last-backtest'
const STRATEGY_KEY = 'lixtrd:strategy'
const SETTINGS_KEY = 'lixtrd:settings'

function scrollToTop(behavior: ScrollBehavior = 'instant') {
  if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
    window.scrollTo({ top: 0, behavior })
  }
}

function PageLoadFallback() {
  return (
    <div className="flex min-h-[280px] items-center justify-center rounded-md border border-border/60 bg-card/40 text-xs font-medium tracking-wide text-muted-foreground">
      Loading view…
    </div>
  )
}

function App() {
  const [activePage, setActivePage] = useState<PageId>('dashboard')
  const [pageHistory, setPageHistory] = useState<PageId[]>([])
  const [botStatus, setBotStatus] = useState<BotStatus>('stopped')

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

  useTheme(settings.theme)

  const language: Language = settings.language === 'es' ? 'es' : 'en'

  useEffect(() => {
    if (settings.language !== language) {
      setSettings({ ...settings, language })
    }
  }, [language, settings, setSettings])

  function handleSaveStrategy(nextStrategy: Strategy) {
    setStrategy(nextStrategy)
    void selectBotPresetOnServer({ strategy: nextStrategy })
  }

  function handleResetAll() {
    setStrategy(defaultStrategy)
    setSettings({ ...defaultSettings, language })
    setLastBacktest(null)
    void selectBotPresetOnServer({ strategy: defaultStrategy })
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
            backtest={lastBacktest}
            onNavigate={handleContextualNavigate}
          />
        )
      case 'terminal':
        return (
          <ChartTerminal
            strategy={strategy}
            onSaveStrategy={handleSaveStrategy}
            onNavigate={handleContextualNavigate}
            previousPage={previousPage}
            onBack={handleGoBack}
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
      case 'bot-run':
        return (
          <BotRun
            status={botStatus}
            onChangeStatus={setBotStatus}
            strategy={strategy}
            onNavigate={handleContextualNavigate}
            onSaveSnapshot={setLastBacktest}
          />
        )
      case 'backtest':
        return (
          <Backtest
            strategy={strategy}
            onNavigate={handleContextualNavigate}
            onSaveResult={setLastBacktest}
          />
        )
      case 'predictions':
        return <Predictions onNavigate={handleContextualNavigate} />
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
            settings={{ ...settings, language }}
            onChangeSettings={setSettings}
            onResetAll={handleResetAll}
          />
        )
    }
  }

  return (
    <I18nProvider language={language}>
      <div className="flex min-h-dvh flex-col bg-background text-foreground">
        <AppTopBar
          activePage={activePage}
          previousPage={previousPage}
          onBack={handleGoBack}
        />
        <main className="mx-auto w-full min-w-0 max-w-[1360px] flex-1 px-3.5 pt-3.5 pb-24 sm:px-5">
          <Suspense fallback={<PageLoadFallback />}>{renderPage()}</Suspense>
        </main>
        <AppDock activePage={activePage} onNavigate={handleDockNavigate} />
      </div>
    </I18nProvider>
  )
}

export default App
