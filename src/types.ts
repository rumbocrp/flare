export type PageId =
  | 'dashboard'
  | 'bot-config'
  | 'bot-run'
  | 'backtest'
  | 'stats'
  | 'settings'

export type BotStatus = 'stopped' | 'running'

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

export type AppSettings = {
  theme: ThemeSetting
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

export type OverlayKind = 'fast' | 'slow'

export type ChartOverlay = {
  id: string
  label: string
  kind: OverlayKind
  values: (number | null)[]
}

export type ExitReason = 'stop' | 'target' | 'signal' | 'end' | 'bankrupt'