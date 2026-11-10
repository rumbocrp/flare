import { describe, expect, it } from 'vitest'
import { ema, rsi, sma } from './indicators'
import { crossoverSignals } from './signals'
import type { Candle, SignalParams } from './types'

function candlesFromCloses(closes: number[]): Candle[] {
  return closes.map((close, index) => ({
    time: index * 3_600_000,
    open: close,
    high: close,
    low: close,
    close,
    volume: 0,
  }))
}

describe('sma', () => {
  it('calcula el promedio de las últimas N velas', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4])
  })

  it('con periodo 1 devuelve los mismos valores', () => {
    expect(sma([1, 2, 3], 1)).toEqual([1, 2, 3])
  })

  it('devuelve solo nulos si no hay datos suficientes', () => {
    expect(sma([1, 2], 5)).toEqual([null, null])
  })
})

describe('ema', () => {
  it('empieza con la media simple y luego suaviza', () => {
    expect(ema([2, 4, 6, 8, 6], 3)).toEqual([null, null, 4, 6, 6])
  })

  it('devuelve solo nulos si no hay datos suficientes', () => {
    expect(ema([1, 2], 5)).toEqual([null, null])
  })
})

describe('rsi', () => {
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89,
    46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
  ]

  it('el primer valor coincide con el cálculo hecho a mano', () => {
    expect(rsi(closes, 14)[14]).toBeCloseTo(70.46, 1)
  })

  it('el segundo valor aplica el suavizado de Wilder', () => {
    expect(rsi(closes, 14)[15]).toBeCloseTo(66.25, 1)
  })

  it('no hay valor mientras no haya suficientes velas', () => {
    expect(rsi([1, 2, 3], 14)).toEqual([null, null, null])
  })

  it('un precio plano da 50', () => {
    expect(rsi(new Array(20).fill(10), 14)[19]).toBe(50)
  })

  it('un precio que solo sube da 100', () => {
    const rising = Array.from({ length: 20 }, (_, index) => index)
    expect(rsi(rising, 14)[19]).toBe(100)
  })

  it('un precio que solo baja da 0', () => {
    const falling = Array.from({ length: 20 }, (_, index) => 20 - index)
    expect(rsi(falling, 14)[19]).toBe(0)
  })
})

describe('crossoverSignals', () => {
  const params: SignalParams = { fastPeriod: 2, slowPeriod: 3, average: 'sma' }
  const closes = [10, 10, 10, 10, 9, 8, 7, 8, 9, 10, 11, 12, 11, 10, 9]

  it('detecta una venta, una compra y otra venta', () => {
    const signals = crossoverSignals(candlesFromCloses(closes), params)

    expect(signals.map((signal) => [signal.index, signal.side])).toEqual([
      [4, 'sell'],
      [8, 'buy'],
      [13, 'sell'],
    ])
  })

  it('un precio plano no genera señales', () => {
    const flat = new Array(10).fill(5)
    expect(crossoverSignals(candlesFromCloses(flat), params)).toEqual([])
  })

  it('no usa datos del futuro', () => {
    const full = crossoverSignals(candlesFromCloses(closes), params)
    const partial = crossoverSignals(candlesFromCloses(closes.slice(0, 10)), params)

    expect(full.filter((signal) => signal.index < 10)).toEqual(partial)
  })
})