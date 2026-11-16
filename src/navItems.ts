import type { PageId } from './types'
import type { TranslationKey } from './i18n'

type NavItem = {
  id: PageId
  label: string
  labelKey: TranslationKey
}

const navItems: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', labelKey: 'nav.dashboard' },
  { id: 'bot-config', label: 'Bot setup', labelKey: 'nav.botConfig' },
  { id: 'bot-run', label: 'Run bot', labelKey: 'nav.botRun' },
  { id: 'backtest', label: 'Backtest', labelKey: 'nav.backtest' },
  { id: 'predictions', label: 'Predictions', labelKey: 'nav.predictions' },
  { id: 'stats', label: 'Statistics', labelKey: 'nav.stats' },
  { id: 'settings', label: 'Settings', labelKey: 'nav.settings' },
]

const primaryNavIds: readonly PageId[] = [
  'dashboard',
  'bot-run',
  'backtest',
  'predictions',
  'stats',
]

export const primaryNavItems: NavItem[] = primaryNavIds
  .map((id) => navItems.find((item) => item.id === id))
  .filter((item): item is NavItem => item !== undefined)

export const overflowNavItems: NavItem[] = navItems.filter(
  (item) => !primaryNavIds.includes(item.id),
)

export function isPrimaryNavPage(id: PageId): boolean {
  return primaryNavIds.includes(id)
}

export function getNavLabelKey(id: PageId): TranslationKey {
  if (id === 'terminal') return 'nav.terminal'
  return navItems.find((item) => item.id === id)?.labelKey ?? 'nav.dashboard'
}

const MAX_NAV_HISTORY = 12

export function pushNavHistory(
  history: readonly PageId[],
  from: PageId,
  to: PageId,
): PageId[] {
  if (from === to) return [...history]
  if (history.length > 0 && history[history.length - 1] === to) {
    return history.slice(0, -1)
  }
  const next =
    history[history.length - 1] === from ? [...history] : [...history, from]
  return next.slice(-MAX_NAV_HISTORY)
}

export function popNavHistory(history: readonly PageId[]): {
  previous: PageId | null
  rest: PageId[]
} {
  if (history.length === 0) return { previous: null, rest: [] }
  return {
    previous: history[history.length - 1],
    rest: history.slice(0, -1),
  }
}
