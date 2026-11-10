import type { Candle, MarketDataSource } from '../types'

function toNumber(value: unknown): number {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    throw new Error('La API devolvió un dato inválido')
  }
  return number
}

function parseKline(row: unknown): Candle {
  if (!Array.isArray(row) || row.length < 6) {
    throw new Error('La API devolvió una vela con formato inesperado')
  }

  return {
    time: toNumber(row[0]),
    open: toNumber(row[1]),
    high: toNumber(row[2]),
    low: toNumber(row[3]),
    close: toNumber(row[4]),
    volume: toNumber(row[5]),
  }
}

export const binanceSource: MarketDataSource = {
  name: 'API pública de Binance',
  description: 'Precios reales de mercado, sin claves.',

  async getCandles({ pair, interval, limit, signal }) {
    const symbol = encodeURIComponent(pair.replace('/', ''))
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`

    const response = await fetch(url, { signal })
    if (!response.ok) {
      throw new Error(`La API respondió con el código ${response.status}`)
    }

    const rows: unknown = await response.json()
    if (!Array.isArray(rows)) {
      throw new Error('La API devolvió una respuesta inesperada')
    }

    return rows.map((row) => parseKline(row))
  },
}