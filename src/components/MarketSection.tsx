import { useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import './EquityChart.css'
import './CandleChart.css'
import MarketAnalysis from './MarketAnalysis'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useLiveCandles } from '@/hooks/useCandles'
import { useLocalStorageState } from '@/hooks/useLocalStorageState'
import { atr, ema, rsi } from '@/indicators'
import { compute24hChangePct } from '@/chartViewport'
import { marketDataSource } from '@/market'
import { availablePairs } from '@/strategy'
import { defaultSignalParams, isSignalParams } from '@/signals'
import { useI18n } from '@/i18n'
import type {
  DensitySetting,
  Interval,
  PageId,
  SignalParams,
  Strategy,
} from '@/types'

const SIGNAL_PARAMS_KEY = 'lixtrd:signal-params'

// 360 candles = 310 navigable bars + 50 warm-up bars so SMA/EMA/EMA50/RSI never cut off
const CANDLE_SPECTRUM_LIMIT = 360

export type CoinFocusMeta = {
  pair: string
  optimalTimeframe: Interval
  optimalParams: SignalParams
  presetBadgeEs: string
  presetBadgeEn: string
  edgeSummaryEs: string
  edgeSummaryEn: string
}

export type LiveMarketMetrics = {
  lastClose: number
  changePct: number
  is24hChange: boolean
  lastEma50: number
  emaDistPct: number
  lastRsi: number
  lastAtr: number
  atrPct: number
  high: number
  low: number
}

const COIN_FOCUS_PROFILES: Record<string, CoinFocusMeta> = {
  'BTC/USDT': {
    pair: 'BTC/USDT',
    optimalTimeframe: '15m',
    optimalParams: { fastPeriod: 12, slowPeriod: 26, average: 'ema' },
    presetBadgeEs: 'Preset #2 · EMA 12/26 (15m)',
    presetBadgeEn: 'Preset #2 · EMA 12/26 (15m)',
    edgeSummaryEs: '61.9% Win Rate · PF 2.09 · Polymarket 75.8% WR',
    edgeSummaryEn: '61.9% Win Rate · PF 2.09 · Polymarket 75.8% WR',
  },
  'ETH/USDT': {
    pair: 'ETH/USDT',
    optimalTimeframe: '15m',
    optimalParams: { fastPeriod: 12, slowPeriod: 26, average: 'ema' },
    presetBadgeEs: 'Preset #6 · EMA 12/26 (15m)',
    presetBadgeEn: 'Preset #6 · EMA 12/26 (15m)',
    edgeSummaryEs: '61.9% Win Rate · PF 2.86 · Polymarket 68.8% WR',
    edgeSummaryEn: '61.9% Win Rate · PF 2.86 · Polymarket 68.8% WR',
  },
  'SOL/USDT': {
    pair: 'SOL/USDT',
    optimalTimeframe: '15m',
    optimalParams: { fastPeriod: 5, slowPeriod: 20, average: 'ema' },
    presetBadgeEs: 'Preset #8 · EMA 5/20 (15m)',
    presetBadgeEn: 'Preset #8 · EMA 5/20 (15m)',
    edgeSummaryEs: '75.0% Win Rate · PF 4.91 · Polymarket 81.0% WR',
    edgeSummaryEn: '75.0% Win Rate · PF 4.91 · Polymarket 81.0% WR',
  },
}

type MarketSectionProps = {
  strategy?: Strategy
  onSaveStrategy?: (next: Strategy) => void
  onNavigate?: (page: PageId) => void
  isFullTerminal?: boolean
  compact?: boolean
  chartHeight?: number
  selectedPair?: string
  onSelectPair?: (pair: string) => void
  soundAlerts?: boolean
  density?: DensitySetting
  reducedMotion?: boolean
}

function MarketSection({
  strategy,
  onSaveStrategy,
  onNavigate,
  isFullTerminal = false,
  compact = false,
  chartHeight,
  selectedPair,
  onSelectPair,
  soundAlerts = false,
  density = 'comfortable',
  reducedMotion = false,
}: MarketSectionProps) {
  const { t } = useI18n()
  const [internalPair, setInternalPair] = useState<string>(
    strategy?.pair ?? availablePairs[0],
  )
  const pair = selectedPair ?? internalPair

  function handlePairChange(nextPair: string) {
    setInternalPair(nextPair)
    onSelectPair?.(nextPair)
  }

  const [timeframe, setTimeframe] = useState<Interval>('15m')
  const [reloadKey, setReloadKey] = useState(0)

  const [params, setParams] = useLocalStorageState<SignalParams>(
    SIGNAL_PARAMS_KEY,
    defaultSignalParams,
    isSignalParams,
  )

  const { state, streamStatus, lastTickAt } = useLiveCandles(
    marketDataSource,
    pair,
    timeframe,
    CANDLE_SPECTRUM_LIMIT,
    reloadKey,
  )

  const coinProfile =
    COIN_FOCUS_PROFILES[pair] ?? COIN_FOCUS_PROFILES['BTC/USDT']

  const liveMetrics = useMemo<LiveMarketMetrics | null>(() => {
    if (state.status !== 'success' || state.data.length < 55) return null
    const data = state.data
    const last = data[data.length - 1]
    const change24h = compute24hChangePct(data)
    const changePct = change24h?.changePct ?? 0
    const is24hChange = change24h?.is24h ?? false

    const closes = data.map((c) => c.close)
    const ema50Series = ema(closes, 50)
    const rsiSeries = rsi(closes, 14)
    const atrSeries = atr(data, 14)
    const lastAtr = atrSeries[atrSeries.length - 1] ?? 0

    const lastEma50 = ema50Series[ema50Series.length - 1] ?? last.close
    const lastRsi = rsiSeries[rsiSeries.length - 1] ?? 50
    const atrPct = (lastAtr / last.close) * 100
    const emaDistPct = ((last.close - lastEma50) / lastEma50) * 100

    let high = -Infinity
    let low = Infinity
    for (let i = Math.max(0, data.length - 120); i < data.length; i += 1) {
      if (data[i].high > high) high = data[i].high
      if (data[i].low < low) low = data[i].low
    }

    return {
      lastClose: last.close,
      changePct,
      is24hChange,
      lastEma50,
      emaDistPct,
      lastRsi,
      lastAtr,
      atrPct,
      high,
      low,
    }
  }, [state])

  function handleApplyCoinOptimalPreset() {
    setTimeframe(coinProfile.optimalTimeframe)
    setParams(coinProfile.optimalParams)
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {state.status === 'loading' && (
        <div
          className="flex min-h-0 flex-1 flex-col gap-2 bg-background p-3"
          role="status"
        >
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-7 w-52" />
            <Skeleton className="h-7 w-40" />
          </div>
          <Skeleton className="min-h-0 w-full flex-1 rounded-md" />
          <span className="sr-only">{t('market.loading')}</span>
        </div>
      )}

      {state.status === 'error' && (
        <div
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-[var(--negative-soft)] p-6 text-center"
          role="alert"
        >
          <p className="text-xs text-[var(--negative)]">
            {t('market.loadError', { message: state.message })}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            <RefreshCw className="size-3.5" />
            <span>{t('market.retry')}</span>
          </Button>
        </div>
      )}

      {state.status === 'success' && (
        <MarketAnalysis
          candles={state.data}
          params={params}
          pair={pair}
          timeframe={timeframe}
          onSelectPair={handlePairChange}
          onSelectTimeframe={setTimeframe}
          onChangeParams={setParams}
          strategy={strategy}
          onSaveStrategy={onSaveStrategy}
          onNavigate={onNavigate}
          streamStatus={streamStatus}
          lastTickAt={lastTickAt}
          coinProfile={coinProfile}
          liveMetrics={liveMetrics}
          onCalibratePreset={handleApplyCoinOptimalPreset}
          chartHeight={chartHeight}
          defaultWheelZoomLocked={isFullTerminal}
          compact={compact}
          soundAlerts={soundAlerts}
          density={density}
          reducedMotion={reducedMotion}
        />
      )}
    </section>
  )
}

export default MarketSection
