import { describe, expect, it } from 'vitest'
import {
  getNavLabelKey,
  isPrimaryNavPage,
  overflowNavItems,
  popNavHistory,
  primaryNavItems,
  pushNavHistory,
} from './navItems'
import type { PageId } from './types'

describe('navigation structure & history', () => {
  it('keeps exactly 5 primary dock items and groups secondary routes under More', () => {
    expect(primaryNavItems.map((item) => item.id)).toEqual([
      'dashboard',
      'bot-run',
      'backtest',
      'predictions',
      'stats',
    ])
    expect(primaryNavItems).toHaveLength(5)
    expect(overflowNavItems.map((item) => item.id)).toEqual([
      'bot-config',
      'training',
      'settings',
    ])

    expect(isPrimaryNavPage('dashboard')).toBe(true)
    expect(isPrimaryNavPage('stats')).toBe(true)
    expect(isPrimaryNavPage('bot-config')).toBe(false)
    expect(isPrimaryNavPage('training')).toBe(false)
    expect(isPrimaryNavPage('settings')).toBe(false)
    expect(isPrimaryNavPage('terminal')).toBe(false)
    expect(getNavLabelKey('terminal')).toBe('nav.terminal')
    expect(getNavLabelKey('bot-config')).toBe('nav.botConfig')
    expect(getNavLabelKey('training')).toBe('nav.training')
  })

  it('records A -> B history without cycles or duplicate adjacent entries', () => {
    let history: PageId[] = []
    history = pushNavHistory(history, 'dashboard', 'dashboard')
    expect(history).toEqual([])

    history = pushNavHistory(history, 'dashboard', 'bot-run')
    expect(history).toEqual(['dashboard'])

    history = pushNavHistory(history, 'bot-run', 'bot-config')
    expect(history).toEqual(['dashboard', 'bot-run'])

    // Navigating directly back to the immediate origin collapses the jump without duplicating history
    history = pushNavHistory(history, 'bot-config', 'bot-run')
    expect(history).toEqual(['dashboard'])

    const popped = popNavHistory(history)
    expect(popped.previous).toBe('dashboard')
    expect(popped.rest).toEqual([])
    expect(popNavHistory([])).toEqual({ previous: null, rest: [] })
  })

  it('caps return navigation history at 12 recent hops', () => {
    const pages: PageId[] = [
      'dashboard',
      'bot-run',
      'backtest',
      'predictions',
      'stats',
      'terminal',
      'bot-config',
      'settings',
    ]
    let history: PageId[] = []
    for (let i = 0; i < 18; i++) {
      history = pushNavHistory(
        history,
        pages[i % pages.length],
        pages[(i + 1) % pages.length],
      )
    }
    expect(history).toHaveLength(12)
  })
})
