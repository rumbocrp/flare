import { useState } from 'react'
import './App.css'
import type { AppSettings, BotStatus, PageId, Strategy } from './types'
import { defaultStrategy, isStrategy } from './strategy'
import { defaultSettings, isAppSettings } from './settings'
import { useLocalStorageState } from './hooks/useLocalStorageState'
import { useTheme } from './hooks/useTheme'
import Sidebar from './components/Sidebar'
import Dashboard from './pages/Dashboard'
import BotConfig from './pages/BotConfig'
import BotRun from './pages/BotRun'
import Stats from './pages/Stats'
import Settings from './pages/Settings'

const STRATEGY_KEY = 'lixtrd:strategy'
const SETTINGS_KEY = 'lixtrd:settings'

function App() {
  const [activePage, setActivePage] = useState<PageId>('dashboard')
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

  useTheme(settings.theme)

  function handleResetAll() {
    setStrategy(defaultStrategy)
    setSettings(defaultSettings)
  }

  function renderPage() {
    switch (activePage) {
      case 'dashboard':
        return <Dashboard botStatus={botStatus} />
      case 'bot-config':
        return <BotConfig strategy={strategy} onSave={setStrategy} />
      case 'bot-run':
        return (
          <BotRun
            status={botStatus}
            onChangeStatus={setBotStatus}
            strategy={strategy}
          />
        )
      case 'stats':
        return <Stats />
      case 'settings':
        return (
          <Settings
            settings={settings}
            onChangeSettings={setSettings}
            onResetAll={handleResetAll}
          />
        )
    }
  }

  return (
    <div className="app">
      <Sidebar activePage={activePage} onNavigate={setActivePage} />
      <main className="content">{renderPage()}</main>
    </div>
  )
}

export default App
