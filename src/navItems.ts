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
  { id: 'stats', label: 'Estadísticas', icon: '◔' },
  { id: 'settings', label: 'Ajustes', icon: '☰' },
]
