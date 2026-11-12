import { describe, expect, it } from 'vitest'
import {
  resolveExit,
  runBacktest,
  type BacktestConfig,
} from './backtest'
import { computeMetrics } from './metrics'
import type { Candle } from './types'

const HOUR = 3_600_000

function candle(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
): Candle {
  return { time, open, high, low, close, volume: 0 }
}

const params = {
  fastPeriod: 1,
  slowPeriod: 2,
  average: 'sma' as const,
}

function makeConfig(overrides: {
  strategy?: Partial<BacktestConfig['strategy']>
  settings?: Partial<BacktestConfig['settings']>
} = {}): BacktestConfig {
  return {
    pair: 'BTC/USDT',
    params,
    strategy: {
      positionSize: 100,
      stopLoss: 5,
      takeProfit: 10,
      maxDailyRisk: 50,
      ...overrides.strategy,
    },
    settings: {
      initialBalance: 1000,
      commissionPct: 0,
      slippagePct: 0,
      allowShort: false,
      ...overrides.settings,
    },
  }
}

/**
 * Datos base para una señal BUY en el índice 3.
 * closes: 100, 100, 90, 110, ...
 * La entrada se ejecuta en el open del índice 4.
 */
function buySignalCandles(): Candle[] {
  return [
    candle(0 * HOUR, 100, 101, 99, 100),
    candle(1 * HOUR, 100, 101, 99, 100),
    candle(2 * HOUR, 90, 91, 89, 90),
    candle(3 * HOUR, 110, 111, 109, 110),
    candle(4 * HOUR, 100, 101, 99, 110),
    candle(5 * HOUR, 105, 111, 104, 108),
    candle(6 * HOUR, 108, 109, 107, 108),
  ]
}

describe('resolveExit', () => {
  it('en un largo, si se tocan stop y objetivo en la misma vela, gana el stop', () => {
    const exit = resolveExit(
      { side: 'buy', stopPrice: 95, targetPrice: 110 },
      candle(0, 100, 111, 94, 100),
    )
    expect(exit).toEqual({ price: 95, reason: 'stop' })
  })

  it('en un largo, un hueco por debajo del stop sale a la apertura', () => {
    const exit = resolveExit(
      { side: 'buy', stopPrice: 95, targetPrice: 110 },
      candle(0, 90, 91, 89, 90),
    )
    expect(exit).toEqual({ price: 90, reason: 'stop' })
  })

  it('en un corto, el objetivo se toca con el mínimo', () => {
    const exit = resolveExit(
      { side: 'sell', stopPrice: 105, targetPrice: 90 },
      candle(0, 100, 101, 89, 95),
    )
    expect(exit).toEqual({ price: 90, reason: 'target' })
  })

  it('sin tocar niveles no hay salida', () => {
    const exit = resolveExit(
      { side: 'buy', stopPrice: 95, targetPrice: 110 },
      candle(0, 100, 105, 99, 102),
    )
    expect(exit).toBeNull()
  })
})

describe('runBacktest', () => {
  it('entra en la apertura de la vela siguiente, no en el cierre de la señal', () => {
    const candles = [
      candle(0 * HOUR, 100, 101, 99, 100),
      candle(1 * HOUR, 100, 101, 99, 100),
      candle(2 * HOUR, 90, 91, 89, 90),
      candle(3 * HOUR, 110, 111, 109, 110), // señal BUY al cierre
      candle(4 * HOUR, 20, 116, 19.5, 115), // apertura con hueco
      candle(5 * HOUR, 115, 116, 114, 120),
      candle(6 * HOUR, 120, 126, 119, 125),
    ]

    const result = runBacktest(candles, makeConfig())

    expect(result.trades).toHaveLength(1)
    expect(result.trades[0].entryPrice).toBe(20)
    expect(result.trades[0].entryTime).toBe(4 * HOUR)
  })

  it('toma ganancia en el objetivo y aplica comisiones por lado', () => {
    const result = runBacktest(
      buySignalCandles(),
      makeConfig({ settings: { commissionPct: 0.1 } }),
    )

    expect(result.trades).toHaveLength(1)

    const trade = result.trades[0]
    expect(trade.exitReason).toBe('target')
    expect(trade.entryPrice).toBe(100)
    expect(trade.exitPrice).toBe(110)
    expect(trade.grossPnl).toBe(100)
    expect(trade.fees).toBe(2.1)
    expect(trade.pnl).toBe(97.9)
    expect(result.finalBalance).toBe(1097.9)
    expect(result.feesPaid).toBe(2.1)
  })

  it('aplica el stop antes que el objetivo si ambos se tocan', () => {
    const candles = buySignalCandles()
    candles[5] = candle(5 * HOUR, 105, 111, 94, 100)

    const result = runBacktest(
      candles,
      makeConfig({ settings: { commissionPct: 0 } }),
    )

    expect(result.trades[0].exitReason).toBe('stop')
    expect(result.trades[0].exitPrice).toBe(95)
    expect(result.trades[0].pnl).toBe(-50)
    expect(result.finalBalance).toBe(950)
  })

  it('abre cortos cuando allowShort es true', () => {
    const candles = [
      candle(0 * HOUR, 90, 91, 89, 90),
      candle(1 * HOUR, 100, 101, 99, 100),
      candle(2 * HOUR, 110, 111, 109, 110),
      candle(3 * HOUR, 90, 91, 89, 90), // señal SELL
      candle(4 * HOUR, 100, 101, 89, 90), // entrada 100 y objetivo 90
      candle(5 * HOUR, 90, 91, 89, 90),
      candle(6 * HOUR, 90, 91, 89, 90),
    ]

    const result = runBacktest(
      candles,
      makeConfig({ settings: { allowShort: true } }),
    )

    expect(result.trades).toHaveLength(1)
    expect(result.trades[0].side).toBe('sell')
    expect(result.trades[0].exitReason).toBe('target')
    expect(result.trades[0].exitPrice).toBe(90)
    expect(result.trades[0].pnl).toBe(100)
  })

  it('sin allowShort, una señal SELL estando plano no abre nada', () => {
    const candles = [
      candle(0 * HOUR, 90, 91, 89, 90),
      candle(1 * HOUR, 100, 101, 99, 100),
      candle(2 * HOUR, 110, 111, 109, 110),
      candle(3 * HOUR, 90, 91, 89, 90),
      candle(4 * HOUR, 100, 101, 99, 100),
    ]

    const result = runBacktest(candles, makeConfig())
    expect(result.trades).toHaveLength(0)
    expect(result.skippedSignals).toBeGreaterThan(0)
  })

  it('el límite de riesgo diario bloquea nuevas entradas el resto del día', () => {
    const candles = [
      candle(0 * HOUR, 100, 101, 99, 100),
      candle(1 * HOUR, 100, 101, 99, 100),
      candle(2 * HOUR, 90, 91, 89, 90),
      candle(3 * HOUR, 110, 111, 109, 110), // BUY
      candle(4 * HOUR, 100, 101, 99, 110), // entrada 100
      candle(5 * HOUR, 100, 101, 97, 100), // stop 98
      candle(6 * HOUR, 100, 101, 99, 100),
      candle(7 * HOUR, 100, 101, 99, 100),
      candle(8 * HOUR, 100, 101, 89, 90), // SELL, se descarta
      candle(9 * HOUR, 90, 111, 89, 110), // BUY
      candle(10 * HOUR, 110, 111, 109, 110), // ya bloqueado
    ]

    const result = runBacktest(
      candles,
      makeConfig({
        strategy: { stopLoss: 2, maxDailyRisk: 2 },
        settings: { allowShort: false },
      }),
    )

    expect(result.trades).toHaveLength(1)
    expect(result.trades[0].exitReason).toBe('stop')
    expect(result.trades[0].pnl).toBe(-20)
    expect(result.finalBalance).toBe(980)
    expect(result.skippedSignals).toBeGreaterThan(0)
  })

  it('cierra la posición abierta al final de los datos', () => {
    const candles = [
      candle(0 * HOUR, 100, 101, 99, 100),
      candle(1 * HOUR, 100, 101, 99, 100),
      candle(2 * HOUR, 90, 91, 89, 90),
      candle(3 * HOUR, 110, 111, 109, 110), // BUY
      candle(4 * HOUR, 100, 101, 99, 115), // entrada 100
      candle(5 * HOUR, 115, 116, 114, 120),
      candle(6 * HOUR, 120, 126, 119, 125),
    ]

    const result = runBacktest(
      candles,
      makeConfig({
        strategy: { stopLoss: 50, takeProfit: 50 },
      }),
    )

    expect(result.trades).toHaveLength(1)
    expect(result.trades[0].exitReason).toBe('end')
    expect(result.trades[0].exitPrice).toBe(125)
    expect(result.trades[0].pnl).toBe(250)
  })

  it('el slippage encarece la entrada de un largo', () => {
    const candles = [
      candle(0 * HOUR, 100, 101, 99, 100),
      candle(1 * HOUR, 100, 101, 99, 100),
      candle(2 * HOUR, 90, 91, 89, 90),
      candle(3 * HOUR, 110, 111, 109, 110),
      candle(4 * HOUR, 100, 101, 99, 115),
      candle(5 * HOUR, 115, 116, 114, 120),
      candle(6 * HOUR, 120, 126, 119, 125),
    ]

    const result = runBacktest(
      candles,
      makeConfig({
        strategy: { stopLoss: 50, takeProfit: 50 },
        settings: { slippagePct: 1 },
      }),
    )

    expect(result.trades[0].entryPrice).toBeCloseTo(101, 6)
  })

  it('no muta las velas de entrada', () => {
    const candles = buySignalCandles()
    const before = JSON.stringify(candles)

    runBacktest(candles, makeConfig())

    expect(JSON.stringify(candles)).toBe(before)
  })

  it('devuelve un resultado vacío con warning si hay menos de 2 velas', () => {
    const result = runBacktest(
      [candle(0, 100, 101, 99, 100)],
      makeConfig(),
    )

    expect(result.trades).toHaveLength(0)
    expect(result.finalBalance).toBe(1000)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('las métricas usan el balance inicial del backtest', () => {
    const candles = buySignalCandles()
    const result = runBacktest(candles, makeConfig())

    const metrics = computeMetrics(result.trades, result.initialBalance)

    expect(metrics.totalTrades).toBe(1)
    expect(metrics.wins).toBe(1)
    expect(metrics.winRate).toBe(100)
    expect(metrics.maxDrawdown).toBe(0)
  })
})
