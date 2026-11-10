import CandleChart from './CandleChart'
import RsiPanel from './RsiPanel'
import SignalsTable from './SignalsTable'
import { ema, rsi, sma } from '../indicators'
import { RSI_PERIOD, crossoverSignals } from '../signals'
import type { Candle, ChartOverlay, SignalParams } from '../types'

type MarketAnalysisProps = {
  candles: Candle[]
  params: SignalParams
}

function MarketAnalysis({ candles, params }: MarketAnalysisProps) {
  const closes = candles.map((candle) => candle.close)
  const average = params.average === 'ema' ? ema : sma
  const name = params.average.toUpperCase()

  const overlays: ChartOverlay[] = [
    {
      id: 'fast',
      label: `${name} ${params.fastPeriod}`,
      kind: 'fast',
      values: average(closes, params.fastPeriod),
    },
    {
      id: 'slow',
      label: `${name} ${params.slowPeriod}`,
      kind: 'slow',
      values: average(closes, params.slowPeriod),
    },
  ]

  const signals = crossoverSignals(candles, params)
  const rsiValues = rsi(closes, RSI_PERIOD)

  return (
    <>
      <CandleChart candles={candles} overlays={overlays} signals={signals} />

      <div className="market__rsi">
        <RsiPanel candles={candles} values={rsiValues} period={RSI_PERIOD} />
      </div>

      <div className="market__signals">
        <h3 className="market__subtitle">Señales ({signals.length})</h3>
        <SignalsTable signals={signals} />
      </div>

      <p className="disclaimer">
        Las señales son un ejemplo educativo (cruce de medias) y se confirman al
        cierre de cada vela. No son una recomendación de compra ni de venta.
      </p>
    </>
  )
}

export default MarketAnalysis