import type {
  ChartPaneConfig,
  MacdPaneConfig,
  MacdPaneSettings,
  RsiPaneConfig,
  RsiPaneSettings,
} from './types'

export const MIN_PANE_HEIGHT = 80
export const DEFAULT_PANE_HEIGHT = 104
export const COLLAPSED_PANE_HEIGHT = 28
export const PANE_HEADER_OVERHEAD = 28
export const MIN_MAIN_CHART_HEIGHT = 200
export const PANE_HANDLE_HEIGHT = 8
export const MAX_PANE_HEIGHT_RATIO = 0.4

export const DEFAULT_RSI_SETTINGS: RsiPaneSettings = {
  period: 14,
  overbought: 70,
  oversold: 30,
}

export const DEFAULT_MACD_SETTINGS: MacdPaneSettings = {
  fastPeriod: 12,
  slowPeriod: 26,
  signalPeriod: 9,
}

export function createDefaultRsiPane(visible = true): RsiPaneConfig {
  return {
    id: 'rsi',
    kind: 'rsi',
    height: DEFAULT_PANE_HEIGHT,
    visible,
    collapsed: false,
    settings: { ...DEFAULT_RSI_SETTINGS },
  }
}

export function createDefaultMacdPane(visible = false): MacdPaneConfig {
  return {
    id: 'macd',
    kind: 'macd',
    height: DEFAULT_PANE_HEIGHT,
    visible,
    collapsed: false,
    settings: { ...DEFAULT_MACD_SETTINGS },
  }
}

export function createDefaultPanes(
  showRsi = true,
  showMacd = false,
): ChartPaneConfig[] {
  return [createDefaultRsiPane(showRsi), createDefaultMacdPane(showMacd)]
}

export function sanitizeRsiSettings(
  patch: Partial<RsiPaneSettings>,
  current: RsiPaneSettings = DEFAULT_RSI_SETTINGS,
): RsiPaneSettings {
  const rawPeriod = patch.period ?? current.period
  const period = Math.min(
    50,
    Math.max(2, Math.round(Number.isFinite(rawPeriod) ? rawPeriod : 14)),
  )
  const rawOb = patch.overbought ?? current.overbought
  const overbought = Math.min(
    95,
    Math.max(55, Math.round(Number.isFinite(rawOb) ? rawOb : 70)),
  )
  const rawOs = patch.oversold ?? current.oversold
  const oversold = Math.min(
    Math.min(45, overbought - 5),
    Math.max(5, Math.round(Number.isFinite(rawOs) ? rawOs : 30)),
  )
  return { period, overbought, oversold }
}

export function sanitizeMacdSettings(
  patch: Partial<MacdPaneSettings>,
  current: MacdPaneSettings = DEFAULT_MACD_SETTINGS,
): MacdPaneSettings {
  const rawFast = patch.fastPeriod ?? current.fastPeriod
  const fastPeriod = Math.min(
    50,
    Math.max(2, Math.round(Number.isFinite(rawFast) ? rawFast : 12)),
  )
  const rawSlow = patch.slowPeriod ?? current.slowPeriod
  const slowPeriod = Math.min(
    100,
    Math.max(
      fastPeriod + 1,
      Math.round(Number.isFinite(rawSlow) ? rawSlow : 26),
    ),
  )
  const rawSig = patch.signalPeriod ?? current.signalPeriod
  const signalPeriod = Math.min(
    50,
    Math.max(2, Math.round(Number.isFinite(rawSig) ? rawSig : 9)),
  )
  return { fastPeriod, slowPeriod, signalPeriod }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isChartPaneConfig(value: unknown): value is ChartPaneConfig {
  if (!isRecord(value)) return false
  if (
    typeof value.height !== 'number' ||
    !Number.isFinite(value.height) ||
    typeof value.visible !== 'boolean' ||
    typeof value.collapsed !== 'boolean' ||
    !isRecord(value.settings)
  ) {
    return false
  }
  if (value.id === 'rsi' && value.kind === 'rsi') {
    const s = value.settings
    return (
      typeof s.period === 'number' &&
      typeof s.overbought === 'number' &&
      typeof s.oversold === 'number'
    )
  }
  if (value.id === 'macd' && value.kind === 'macd') {
    const s = value.settings
    return (
      typeof s.fastPeriod === 'number' &&
      typeof s.slowPeriod === 'number' &&
      typeof s.signalPeriod === 'number'
    )
  }
  return false
}

export function isChartPaneList(value: unknown): value is ChartPaneConfig[] {
  return Array.isArray(value) && value.every(isChartPaneConfig)
}

/**
 * Normalizes stored pane registry (or migrates legacy `showRsi`/`showMacd` flags)
 * into a complete, ordered `[rsi, macd]` registry.
 */
export function normalizeChartPanes(
  raw: ChartPaneConfig[] | undefined,
  fallbackShowRsi: boolean,
  fallbackShowMacd: boolean,
): ChartPaneConfig[] {
  if (!raw || raw.length === 0) {
    return createDefaultPanes(fallbackShowRsi, fallbackShowMacd)
  }

  const rsiEntry = raw.find((p): p is RsiPaneConfig => p.kind === 'rsi')
  const macdEntry = raw.find((p): p is MacdPaneConfig => p.kind === 'macd')

  const normalizedRsi: RsiPaneConfig = rsiEntry
    ? {
        id: 'rsi',
        kind: 'rsi',
        height: Math.max(MIN_PANE_HEIGHT, Math.round(rsiEntry.height)),
        visible: rsiEntry.visible,
        collapsed: rsiEntry.collapsed,
        settings: sanitizeRsiSettings(rsiEntry.settings),
      }
    : createDefaultRsiPane(fallbackShowRsi)

  const normalizedMacd: MacdPaneConfig = macdEntry
    ? {
        id: 'macd',
        kind: 'macd',
        height: Math.max(MIN_PANE_HEIGHT, Math.round(macdEntry.height)),
        visible: macdEntry.visible,
        collapsed: macdEntry.collapsed,
        settings: sanitizeMacdSettings(macdEntry.settings),
      }
    : createDefaultMacdPane(fallbackShowMacd)

  return [normalizedRsi, normalizedMacd]
}

/**
 * Computes the clamped pixel height for a resized oscillator pane, enforcing:
 *  - min height (80px)
 *  - max height (40% of plot stack height)
 *  - main chart minimum preservation (>= 200px)
 */
export function clampPaneHeight(
  requestedHeight: number,
  stackHeight: number,
  otherPanesTotalHeight: number,
  visiblePaneCount: number,
): number {
  const handlesBudget = visiblePaneCount * PANE_HANDLE_HEIGHT
  if (stackHeight <= 0) {
    return Math.max(MIN_PANE_HEIGHT, Math.min(260, Math.round(requestedHeight)))
  }
  const ratioMax = Math.floor(stackHeight * MAX_PANE_HEIGHT_RATIO)
  const mainChartBudgetMax = Math.floor(
    stackHeight - MIN_MAIN_CHART_HEIGHT - otherPanesTotalHeight - handlesBudget,
  )
  const effectiveMax = Math.max(
    MIN_PANE_HEIGHT,
    Math.min(ratioMax, mainChartBudgetMax),
  )
  return Math.max(
    MIN_PANE_HEIGHT,
    Math.min(effectiveMax, Math.round(requestedHeight)),
  )
}

/** Computes inner SVG height for an expanded pane given its total allocated height. */
export function resolvePaneSvgHeight(totalPaneHeight: number): number {
  return Math.max(48, Math.round(totalPaneHeight - PANE_HEADER_OVERHEAD))
}
