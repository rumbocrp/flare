import { describe, expect, it } from 'vitest'
import { POLYMARKET_FEES } from './predictionMarket'
import {
  PREDICTION_STRATEGIES,
  STRATEGY_FAMILIES,
  countByStatus,
  familyById,
  primaryStrategies,
  strategiesForFamily,
  strategyById,
} from './predictionStrategies'

const FAMILY_IDS = [
  'crypto-5m',
  'crypto-15m',
  'crypto-1h',
  'crypto-1d',
  'sports-nonpopular',
  'sports-popular-unpopular-league',
  'politics',
] as const

const CATEGORY_BY_FAMILY = {
  'crypto-5m': 'crypto',
  'crypto-15m': 'crypto',
  'crypto-1h': 'crypto',
  'crypto-1d': 'crypto',
  'sports-nonpopular': 'sports',
  'sports-popular-unpopular-league': 'sports',
  politics: 'politics',
} as const

describe('predictionStrategies: catalog integrity', () => {
  it('covers all seven requested market families', () => {
    expect(STRATEGY_FAMILIES.map((f) => f.id).sort()).toEqual([...FAMILY_IDS].sort())
    for (const family of FAMILY_IDS) {
      expect(strategiesForFamily(family).length).toBeGreaterThan(0)
    }
  })

  it('has unique strategy ids and a valid primary per family', () => {
    const ids = PREDICTION_STRATEGIES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)

    for (const family of STRATEGY_FAMILIES) {
      const primary = strategyById(family.primaryStrategyId)
      expect(primary, `missing primary ${family.primaryStrategyId}`).toBeDefined()
      expect(primary?.family).toBe(family.id)
      expect(familyById(family.id)).toEqual(family)
    }
    expect(primaryStrategies()).toHaveLength(STRATEGY_FAMILIES.length)
  })

  it('ships hard entry, exit and kill-switch rules for every strategy', () => {
    for (const strategy of PREDICTION_STRATEGIES) {
      expect(strategy.entry.length, strategy.id).toBeGreaterThan(0)
      expect(strategy.exit.length, strategy.id).toBeGreaterThan(0)
      expect(strategy.risks.length, strategy.id).toBeGreaterThan(0)
      expect(strategy.killSwitches.length, strategy.id).toBeGreaterThan(0)
      expect(strategy.expectedEdge.length, strategy.id).toBeGreaterThan(20)
      expect(strategy.capacity.length, strategy.id).toBeGreaterThan(5)
      expect(strategy.thesis.length, strategy.id).toBeGreaterThan(40)
    }
  })

  it('never allocates capital to an avoided strategy', () => {
    for (const strategy of PREDICTION_STRATEGIES.filter((s) => s.status === 'avoid')) {
      expect(strategy.sizing.perTicketPct, strategy.id).toBe(0)
      expect(strategy.sizing.familyCapPct, strategy.id).toBe(0)
      expect(strategy.entry.length, strategy.id).toBeGreaterThan(0)
    }
  })

  it('does not call a hypothesis deploy-ready', () => {
    for (const strategy of PREDICTION_STRATEGIES.filter((s) => s.status === 'deploy')) {
      expect(strategy.evidence, strategy.id).not.toBe('hypothesis')
    }
  })

  it('keeps sizing inside sane bounds', () => {
    for (const strategy of PREDICTION_STRATEGIES) {
      expect(strategy.sizing.perTicketPct, strategy.id).toBeGreaterThanOrEqual(0)
      expect(strategy.sizing.perTicketPct, strategy.id).toBeLessThanOrEqual(3)
      expect(strategy.sizing.familyCapPct, strategy.id).toBeGreaterThanOrEqual(0)
      expect(strategy.sizing.familyCapPct, strategy.id).toBeLessThanOrEqual(10)
    }
  })

  it('uses the matching Polymarket fee rate for each family', () => {
    for (const strategy of PREDICTION_STRATEGIES) {
      const category = CATEGORY_BY_FAMILY[strategy.family]
      expect(strategy.costModel.takerFeeRate, strategy.id).toBe(
        POLYMARKET_FEES[category].takerFeeRate,
      )
      expect(strategy.costModel.makerRebateShare, strategy.id).toBe(
        POLYMARKET_FEES[category].makerRebateShare,
      )
      expect(strategy.costModel.feePct, strategy.id).toBe(0)
      expect(strategy.costModel.spreadCents, strategy.id).toBeGreaterThanOrEqual(0)
    }
  })

  it('marks maker strategies as maker and taker strategies as taker', () => {
    for (const strategy of PREDICTION_STRATEGIES) {
      expect(['maker', 'taker']).toContain(strategy.costModel.liquidityRole)
    }
    expect(strategyById('c5-nowcast-maker')?.costModel.liquidityRole).toBe('maker')
    expect(strategyById('pol-favorite-carry')?.costModel.liquidityRole).toBe('taker')
    expect(strategyById('pol-longshot-fade')?.costModel.liquidityRole).toBe('maker')
  })

  it('covers all three crypto assets and all four crypto horizons', () => {
    const crypto = PREDICTION_STRATEGIES.filter((s) => s.family.startsWith('crypto-'))
    for (const asset of ['BTC', 'ETH', 'SOL']) {
      expect(crypto.some((s) => s.assets?.includes(asset as 'BTC'))).toBe(true)
    }
    for (const timeframe of ['5m', '15m', '1h', '1d']) {
      expect(crypto.some((s) => s.timeframes?.includes(timeframe as '5m'))).toBe(true)
    }
  })

  it('counts statuses without dropping a strategy', () => {
    const counts = countByStatus()
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    expect(total).toBe(PREDICTION_STRATEGIES.length)
    expect(counts.deploy).toBeGreaterThan(0)
    expect(counts.avoid).toBeGreaterThan(0)
  })
})
