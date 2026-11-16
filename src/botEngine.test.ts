import { describe, expect, it } from 'vitest'
import {
  createInitialBotState,
  evaluateBotPresetAccuracy,
  isCandleClosed,
  normalizeBotEngineState,
  stepBotEngine,
  STRATEGY_PRESETS,
  trimBotEngineHistory,
} from './botEngine'
import { syntheticSource } from './market/synthetic'
import type { ExecutablePredictionQuote } from './market/quoteService'

describe('botEngine (Unified Trading, Crypto & Prediction Market Engine)', () => {
  it('is idempotent: never processes the same candle timestamp twice', async () => {
    const preset = STRATEGY_PRESETS[0]
    const candles = await syntheticSource.getCandles({
      pair: preset.strategy.pair,
      interval: preset.timeframe,
      limit: 120,
    })
    let state = createInitialBotState(preset)

    state = stepBotEngine(state, candles, preset)
    const firstProcessedTime = state.lastProcessedCandleTime
    const logsCountAfterFirst = state.logs.length

    const repeatedState = stepBotEngine(state, candles, preset)
    expect(repeatedState.lastProcessedCandleTime).toBe(firstProcessedTime)
    expect(repeatedState.logs.length).toBe(logsCountAfterFirst)
  })

  it('properly separates forming candles (nowMs < closeTime) from closed candles to avoid repainting', async () => {
    const preset = STRATEGY_PRESETS[1]
    const candles = await syntheticSource.getCandles({
      pair: preset.strategy.pair,
      interval: preset.timeframe,
      limit: 120,
    })
    const lastCandle = candles[candles.length - 1]
    const prevCandle = candles[candles.length - 2]

    const midBarNow = lastCandle.time + 60_000
    expect(isCandleClosed(lastCandle, '15m', midBarNow)).toBe(false)

    const state = createInitialBotState(preset)
    const nextMidBar = stepBotEngine(state, candles, preset, {
      nowMs: midBarNow,
    })

    expect(nextMidBar.lastProcessedCandleTime).toBe(prevCandle.time)

    const afterCloseNow = lastCandle.time + 15 * 60_000
    expect(isCandleClosed(lastCandle, '15m', afterCloseNow)).toBe(true)

    const nextAfterClose = stepBotEngine(nextMidBar, candles, preset, {
      nowMs: afterCloseNow,
    })
    expect(nextAfterClose.lastProcessedCandleTime).toBe(lastCandle.time)
  })

  it('executes prediction-market preset evaluation with Wilson 95% filter and Quarter-Kelly', async () => {
    const predPreset = STRATEGY_PRESETS.find(
      (p) => p.domain === 'prediction-market',
    )!
    const candles = await syntheticSource.getCandles({
      pair: predPreset.strategy.pair,
      interval: predPreset.timeframe,
      limit: 250,
    })

    const report = evaluateBotPresetAccuracy(candles, predPreset)
    expect(report.presetId).toBe(predPreset.id)
    expect(report.domain).toBe('prediction-market')
    expect(report.winRatePct).toBeGreaterThanOrEqual(0)
    expect(report.wilsonLowerBoundPct).toBeGreaterThanOrEqual(0)
  })

  it('computes accuracy reports (evaluateBotPresetAccuracy) for all 8 presets without error', async () => {
    for (const preset of STRATEGY_PRESETS) {
      const candles = await syntheticSource.getCandles({
        pair: preset.strategy.pair,
        interval: preset.timeframe,
        limit: 220,
      })
      const report = evaluateBotPresetAccuracy(candles, preset)
      expect(report.presetId).toBe(preset.id)
      expect(report.winRatePct).toBeGreaterThanOrEqual(0)
      expect(report.winRatePct).toBeLessThanOrEqual(100)
    }
  })

  it('preserves monotonic trade and ticket ID counters across history trimming', () => {
    const preset = STRATEGY_PRESETS[0]
    const state = createInitialBotState(preset)
    state.closedTrades = [
      {
        id: 14,
        time: new Date(1_700_000_000_000).toISOString(),
        pair: 'BTC/USDT',
        side: 'buy',
        entryPrice: 80_000,
        exitPrice: 81_000,
        size: 100,
        pnl: 1.2,
        grossPnl: 1.3,
        fees: 0.1,
        entryTime: 1_700_000_000_000,
        exitTime: 1_700_000_900_000,
        exitReason: 'target',
        balanceAfter: 1002.3,
      },
      {
        id: 13,
        time: new Date(1_699_999_000_000).toISOString(),
        pair: 'BTC/USDT',
        side: 'buy',
        entryPrice: 79_000,
        exitPrice: 80_000,
        size: 100,
        pnl: 1.1,
        grossPnl: 1.2,
        fees: 0.1,
        entryTime: 1_699_999_000_000,
        exitTime: 1_699_999_900_000,
        exitReason: 'target',
        balanceAfter: 1001.1,
      },
    ]
    state.nextTradeId = 0

    const normalized = normalizeBotEngineState(state)
    expect(normalized.nextTradeId).toBe(15)

    const trimmed = trimBotEngineHistory(normalized, {
      maxClosedTrades: 1,
      maxResolvedTickets: 1,
    })
    expect(trimmed.closedTrades).toHaveLength(1)
    expect(trimmed.nextTradeId).toBe(15)
  })

  it('enforces executable prediction quotes ([QUOTE GUARD]) and settles using fee-adjusted effectiveAsk', () => {
    const predPreset = STRATEGY_PRESETS.find(
      (p) => p.id === 'pred-btc-sma20-bear-cap-15m',
    )!
    const stepMs = 15 * 60_000
    const baseTime = 1_700_000_000_000
    const decliningCandles = Array.from({ length: 65 }, (_, i) => {
      const close = 90_000 - i * 100
      return {
        time: baseTime + i * stepMs,
        open: close + 60,
        high: close + 80,
        low: close - 20,
        close,
        volume: 100,
      }
    })
    const initialCandles = decliningCandles.slice(0, 64)
    const lastInitial = initialCandles[initialCandles.length - 1]
    const nowMs = lastInitial.time + stepMs + 1_000

    // 1. Missing quote -> blocked by [QUOTE GUARD], zero tickets opened
    const stateMissing = stepBotEngine(
      createInitialBotState(predPreset),
      initialCandles,
      predPreset,
      { nowMs, requireExecutableQuote: true },
    )
    expect(stateMissing.activeTickets).toHaveLength(0)
    expect(
      stateMissing.logs.some((log) => log.message.includes('[QUOTE GUARD]')),
    ).toBe(true)

    // 2. Stale quote (>30s) -> blocked by [QUOTE GUARD]
    const baseQuote: ExecutablePredictionQuote = {
      instrumentId: 'btc-updown-15m-test',
      outcome: 'YES',
      bid: 0.52,
      ask: 0.54,
      mid: 0.53,
      spread: 0.02,
      asOfMs: nowMs - 2_000,
      source: 'polymarket-clob',
      category: 'crypto',
    }
    const stateStale = stepBotEngine(
      createInitialBotState(predPreset),
      initialCandles,
      predPreset,
      {
        nowMs,
        requireExecutableQuote: true,
        predictionQuote: { ...baseQuote, asOfMs: nowMs - 60_000 },
      },
    )
    expect(stateStale.activeTickets).toHaveLength(0)
    expect(
      stateStale.logs.some(
        (log) =>
          log.message.includes('[QUOTE GUARD]') &&
          log.message.includes('Stale quote'),
      ),
    ).toBe(true)

    // 3. Too-expensive ask failing net edge -> blocked by [QUOTE GUARD]
    const stateExpensive = stepBotEngine(
      createInitialBotState(predPreset),
      initialCandles,
      predPreset,
      {
        nowMs,
        requireExecutableQuote: true,
        predictionQuote: { ...baseQuote, bid: 0.9, ask: 0.92, mid: 0.91 },
      },
    )
    expect(stateExpensive.activeTickets).toHaveLength(0)
    expect(
      stateExpensive.logs.some(
        (log) =>
          log.message.includes('[QUOTE GUARD]') &&
          log.message.includes('net edge'),
      ),
    ).toBe(true)

    // 4. Fresh positive-edge quote -> opens ticket using effectiveAsk & settles accurately
    const stateOpened = stepBotEngine(
      createInitialBotState(predPreset),
      initialCandles,
      predPreset,
      {
        nowMs,
        requireExecutableQuote: true,
        predictionQuote: baseQuote,
      },
    )
    expect(stateOpened.activeTickets).toHaveLength(1)
    const ticket = stateOpened.activeTickets[0]
    expect(ticket.bid).toBe(0.52)
    expect(ticket.ask).toBe(0.54)
    expect(ticket.fairPricePaid).toBeGreaterThan(0.54)
    expect(ticket.quoteSource).toBe('polymarket-clob')
    expect(ticket.instrumentId).toBe('btc-updown-15m-test')
    expect(ticket.feeUsd).toBeGreaterThan(0)

    const nextBarNow = decliningCandles[64].time + stepMs + 1_000
    const stateSettled = stepBotEngine(stateOpened, decliningCandles, predPreset, {
      nowMs: nextBarNow,
      requireExecutableQuote: true,
      predictionQuote: { ...baseQuote, asOfMs: nextBarNow - 2_000 },
    })
    expect(stateSettled.resolvedTickets.length).toBeGreaterThanOrEqual(1)
    const settled = stateSettled.resolvedTickets.find((t) => t.id === ticket.id)!
    expect(settled.won).toBe(true)
    const expectedPayout =
      Math.round((ticket.stakeUsd / Math.max(0.05, ticket.fairPricePaid)) * 100) /
      100
    expect(settled.payoutUsd).toBe(expectedPayout)
    expect(settled.netPnlUsd).toBeGreaterThan(0)
  })
})
