import { describe, expect, it } from 'vitest'
import {
  CHART_ALERTS_STORAGE_KEY,
  createChartAlert,
  evaluateAlerts,
  inferAlertDirection,
  loadChartAlerts,
  rearmAlert,
  removeAlert,
  saveChartAlerts,
  toggleAlertEnabled,
} from './chartAlerts'

function createMemoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
  }
}

describe('chartAlerts', () => {
  it('infers direction from livePrice and generates UUID ids', () => {
    expect(inferAlertDirection(70000, 68000)).toBe('above')
    expect(inferAlertDirection(65000, 68000)).toBe('below')

    const a = createChartAlert({
      pair: 'BTC/USDT',
      interval: '15m',
      price: 70000,
      livePrice: 68000,
    })
    const b = createChartAlert({
      pair: 'BTC/USDT',
      interval: '15m',
      price: 66000,
      livePrice: 68000,
    })
    expect(a.direction).toBe('above')
    expect(b.direction).toBe('below')
    expect(a.id).not.toBe(b.id)
    expect(a.enabled).toBe(true)
    expect(a.triggeredAt).toBeUndefined()
  })

  it('triggers above and below alerts once against livePrice and respects pair isolation', () => {
    const btcAbove = createChartAlert({
      pair: 'BTC/USDT',
      interval: '15m',
      price: 70000,
      livePrice: 68000,
    })
    const btcBelow = createChartAlert({
      pair: 'BTC/USDT',
      interval: '15m',
      price: 65000,
      livePrice: 68000,
    })
    const ethAbove = createChartAlert({
      pair: 'ETH/USDT',
      interval: '15m',
      price: 2500,
      livePrice: 2400,
    })

    const alerts = [btcAbove, btcBelow, ethAbove]

    // Not crossed yet
    const r0 = evaluateAlerts(alerts, 'BTC/USDT', 69000, 1000)
    expect(r0.newlyTriggered).toHaveLength(0)

    // Crosses btcAbove
    const r1 = evaluateAlerts(r0.nextAlerts, 'BTC/USDT', 70100, 2000)
    expect(r1.newlyTriggered).toHaveLength(1)
    expect(r1.newlyTriggered[0].id).toBe(btcAbove.id)
    expect(r1.newlyTriggered[0].triggeredAt).toBe(2000)

    // Evaluating again at 70500 does not double-fire
    const r2 = evaluateAlerts(r1.nextAlerts, 'BTC/USDT', 70500, 3000)
    expect(r2.newlyTriggered).toHaveLength(0)

    // BTC evaluation never triggers ETH alerts even though 70500 > 2500
    expect(
      r2.nextAlerts.find((a) => a.id === ethAbove.id)?.triggeredAt,
    ).toBeUndefined()

    // Drops below btcBelow
    const r3 = evaluateAlerts(r2.nextAlerts, 'BTC/USDT', 64900, 4000)
    expect(r3.newlyTriggered).toHaveLength(1)
    expect(r3.newlyTriggered[0].id).toBe(btcBelow.id)
  })

  it('supports pause/enable, re-arm, and delete', () => {
    const alert = createChartAlert({
      pair: 'SOL/USDT',
      interval: '1h',
      price: 200,
      livePrice: 190,
    })

    const paused = toggleAlertEnabled([alert], alert.id)
    expect(paused[0].enabled).toBe(false)
    // Disabled alerts must not trigger
    expect(evaluateAlerts(paused, 'SOL/USDT', 210, 5000).newlyTriggered).toHaveLength(0)

    const reEnabled = toggleAlertEnabled(paused, alert.id)
    const fired = evaluateAlerts(reEnabled, 'SOL/USDT', 210, 6000)
    expect(fired.newlyTriggered).toHaveLength(1)

    const rearmed = rearmAlert(fired.nextAlerts, alert.id)
    expect(rearmed[0].triggeredAt).toBeUndefined()
    expect(rearmed[0].enabled).toBe(true)

    expect(removeAlert(rearmed, alert.id)).toHaveLength(0)
  })

  it('persists and sanitizes alerts in flare:chart-alerts', () => {
    const storage = createMemoryStorage()
    const alert = createChartAlert({
      pair: 'BTC/USDT',
      interval: '15m',
      price: 71250,
      livePrice: 69000,
      note: 'Breakout watch',
      now: 123456,
    })

    saveChartAlerts([alert], storage)
    const raw = storage.getItem(CHART_ALERTS_STORAGE_KEY)
    expect(raw).not.toBeNull()

    const loaded = loadChartAlerts(storage)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({
      id: alert.id,
      pair: 'BTC/USDT',
      interval: '15m',
      price: 71250,
      direction: 'above',
      note: 'Breakout watch',
      enabled: true,
    })
  })
})
