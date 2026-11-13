import type { PageId } from './types'

export type NavItem = {
  id: PageId
  label: string
  icon: string
}

export const navItems: NavItem[] = [
  { id: 'dashboard', label: 'Panel', icon: '▦' },
  { id: 'bot-config', label: 'Ajustar bot', icon: '⚙' },
  { id: 'bot-run', label: 'Ejecutar bot', icon: '▶' },
  { id: 'backtest', label: 'Backtest', icon: '⟲' },
  { id: 'stats', label: 'Estadísticas', icon: '◔' },
  { id: 'settings', label: 'Ajustes', icon: '☰' },
]

export const primaryNavIds: readonly PageId[] = [
  'dashboard',
  'bot-config',
  'bot-run',
  'backtest',
  'stats',
]

export const primaryNavItems: NavItem[] = primaryNavIds
  .map((id) => navItems.find((item) => item.id === id))
  .filter((item): item is NavItem => item !== undefined)

export const overflowNavItems: NavItem[] = navItems.filter(
  (item) => !primaryNavIds.includes(item.id),
)

export function getNavLabel(id: PageId): string {
  return navItems.find((item) => item.id === id)?.label ?? id
}
