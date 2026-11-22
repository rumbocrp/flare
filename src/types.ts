export type PageId =
  | 'dashboard'
  | 'terminal'
  | 'bot-config'
  | 'training'
  | 'bot-run'
  | 'backtest'
  | 'predictions'
  | 'stats'
  | 'settings'

export type BotStatus = 'stopped' | 'running' | 'paused'

export type Strategy = {
  pair: string
  positionSize: number
  stopLoss: number
  takeProfit: number
  maxDailyRisk: number
}

export type TradeSide = 'buy' | 'sell'

export type Trade = {
  id: number
  time: string
  pair: string
  side: TradeSide
  entryPrice: number
  exitPrice: number
  size: number
  pnl?: number
  entryTime?: number
  exitTime?: number
  exitReason?: ExitReason
}

export type Tone = 'positive' | 'negative' | 'neutral'

export type ChartPoint = {
  label: string
  value: number
}

export type ThemeSetting = 'dark' | 'light' | 'system'

export type DensitySetting = 'comfortable' | 'compact'

export type AccentPreset = 'amber' | 'emerald' | 'violet' | 'cyan'

export type TimezoneSetting = 'UTC' | 'local'

export type AppSettings = {
  theme: ThemeSetting
  language: Language
  density: DensitySetting
  accentPreset: AccentPreset
  defaultPair: string
  defaultInterval: Interval
  timezone: TimezoneSetting
  confirmDestructive: boolean
  soundAlerts: boolean
  reducedMotion: boolean
  apiBaseUrl: string
}

export type Candle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type Interval = '5m' | '15m' | '1h' | '4h' | '1d'

export type CandleRequest = {
  pair: string
  interval: Interval
  limit: number
  from?: number
  to?: number
  signal?: AbortSignal
}

export type MarketDataSource = {
  name: string
  description: string
  getCandles: (request: CandleRequest) => Promise<Candle[]>
}

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; data: T }

export type AverageKind = 'sma' | 'ema'

export type SignalParams = {
  fastPeriod: number
  slowPeriod: number
  average: AverageKind
}

export type Signal = {
  index: number
  time: number
  side: TradeSide
  price: number
  reason: string
}

export type CandleStyleMode = 'candles' | 'hollow' | 'heikin-ashi'

export type DrawingToolMode =
  | 'cursor'
  | 'measure'
  | 'trendline'
  | 'horizontal'
  | 'fib'

type OverlayKind =
  | 'fast'
  | 'slow'
  | 'trend'
  | 'ema200'
  | 'vwap'
  | 'bb-upper'
  | 'bb-basis'
  | 'bb-lower'
  | 'vol-sma'

export type ChartOverlay = {
  id: string
  label: string
  kind: OverlayKind
  values: (number | null)[]
}

export type ChartOrderLine = {
  id: string
  label: string
  price: number
  kind: 'entry' | 'tp' | 'sl' | 'lock'
  badge: string
}

export type ChartViewport = {
  leftAnchorTime: number | null
  visibleCount: number
  followLive: boolean
}

export type ChartPaneKind = 'rsi' | 'macd'

export type RsiPaneSettings = {
  period: number
  overbought: number
  oversold: number
}

export type MacdPaneSettings = {
  fastPeriod: number
  slowPeriod: number
  signalPeriod: number
}

export type RsiPaneConfig = {
  id: 'rsi'
  kind: 'rsi'
  height: number
  visible: boolean
  collapsed: boolean
  settings: RsiPaneSettings
}

export type MacdPaneConfig = {
  id: 'macd'
  kind: 'macd'
  height: number
  visible: boolean
  collapsed: boolean
  settings: MacdPaneSettings
}

export type ChartPaneConfig = RsiPaneConfig | MacdPaneConfig

type ChartDrawingBase = {
  id: string
  pair: string
  interval: Interval
  createdAt: number
  updatedAt: number
  label?: string
  color?: string
  locked?: boolean
}

export type ChartDrawing =
  | (ChartDrawingBase & {
      type: 'trendline'
      t1: number
      p1: number
      t2: number
      p2: number
    })
  | (ChartDrawingBase & {
      type: 'horizontal'
      price: number
      label: string
    })
  | (ChartDrawingBase & {
      type: 'fib'
      t1: number
      p1: number
      t2: number
      p2: number
    })

export type ChartAlertDirection = 'above' | 'below'

export type ChartAlert = {
  id: string
  pair: string
  interval: Interval
  price: number
  direction: ChartAlertDirection
  createdAt: number
  triggeredAt?: number
  enabled: boolean
  note?: string
}

export type OrderPrefillIntent = {
  nonce: number
  pair: string
  side: TradeSide
  referencePrice: number
}

export type ExitReason =
  | 'stop'
  | 'target'
  | 'signal'
  | 'end'
  | 'bankrupt'
  | 'manual'
  | 'kill-switch'

export type Language = 'en' | 'es'
