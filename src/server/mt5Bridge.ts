import type { BotEngineState, StrategyPreset } from '../botEngine'
import type { ExchangeStatusSnapshot } from './exchangeAdapter'

export type Mt5Action = 'BUY' | 'SELL' | 'HOLD' | 'CLOSE_ALL'

export type Mt5SignalPacket = {
  signalId: string
  timestamp: string
  magicNumber: number
  presetId: string
  presetName: string
  pair: string
  symbol: string
  timeframe: string
  action: Mt5Action
  killSwitchActive: boolean
  dayHalted: boolean
  stopLossPct: number
  takeProfitPct: number
  positionSizePct: number
  entryPrice: number
  stopPrice: number
  targetPrice: number
  breakevenArmed: boolean
}

export type Mt5TerminalTelemetry = {
  terminalName: string
  symbol: string | null
  pollCount: number
  lastPollAt: string
}

export type Mt5BridgeSnapshot = {
  magicNumber: number
  pollCount: number
  lastPollAt: string | null
  lastTerminalName: string | null
  lastTerminalSymbol: string | null
  terminals: Mt5TerminalTelemetry[]
  lastPacket: Mt5SignalPacket
}

const FLARE_MT5_MAGIC = 202615
const MAX_MT5_TERMINALS = 32

let pollCount = 0
let lastPollAt: string | null = null
let lastTerminalName: string | null = null
let lastTerminalSymbol: string | null = null
const terminalRegistry = new Map<string, Mt5TerminalTelemetry>()

export function toMt5Symbol(pair: string): string {
  return pair
    .toUpperCase()
    .replace(/\/(USDT|USDC|BUSD|FDUSD)$/i, 'USD')
    .replace('/', '')
}

export function buildMt5SignalPacket(
  state: BotEngineState,
  preset: StrategyPreset,
  exchange: ExchangeStatusSnapshot,
): Mt5SignalPacket {
  const symbol = toMt5Symbol(preset.strategy.pair)
  const pos = state.openPosition

  let action: Mt5Action = 'HOLD'
  if (exchange.killSwitchActive || state.dayHalted) {
    action = 'CLOSE_ALL'
  } else if (pos) {
    action = pos.side === 'buy' ? 'BUY' : 'SELL'
  }

  const signalId =
    action === 'CLOSE_ALL'
      ? `KILL-${exchange.killSwitchActivatedAt ?? state.currentDayKey ?? 'HALT'}`
      : pos
        ? `SIG-${symbol}-${pos.side.toUpperCase()}-${pos.entryTime}`
        : `HOLD-${symbol}-${state.lastProcessedCandleTime ?? 0}`

  return {
    signalId,
    timestamp: new Date().toISOString(),
    magicNumber: FLARE_MT5_MAGIC,
    presetId: preset.id,
    presetName: preset.name,
    pair: preset.strategy.pair,
    symbol,
    timeframe: preset.timeframe,
    action,
    killSwitchActive: exchange.killSwitchActive,
    dayHalted: state.dayHalted,
    stopLossPct: preset.strategy.stopLoss,
    takeProfitPct: preset.strategy.takeProfit,
    positionSizePct: preset.strategy.positionSize,
    entryPrice: pos ? Number(pos.entryPrice.toFixed(2)) : 0,
    stopPrice: pos ? Number(pos.stopPrice.toFixed(2)) : 0,
    targetPrice: pos ? Number(pos.targetPrice.toFixed(2)) : 0,
    breakevenArmed: Boolean(pos?.breakevenArmed),
  }
}

export function registerMt5Poll(
  state: BotEngineState,
  preset: StrategyPreset,
  exchange: ExchangeStatusSnapshot,
  meta?: { terminal?: string | null; symbol?: string | null },
): Mt5SignalPacket {
  const nowIso = new Date().toISOString()
  pollCount += 1
  lastPollAt = nowIso
  const terminalName = meta?.terminal?.trim() || 'MT5-ExpertAdvisor'
  const symbolName = meta?.symbol?.trim() || null
  if (meta?.terminal) {
    lastTerminalName = terminalName
  }
  if (symbolName) {
    lastTerminalSymbol = symbolName
  }

  const prev = terminalRegistry.get(terminalName)
  terminalRegistry.delete(terminalName)
  if (terminalRegistry.size >= MAX_MT5_TERMINALS) {
    const oldest = terminalRegistry.keys().next().value
    if (oldest !== undefined) terminalRegistry.delete(oldest)
  }
  terminalRegistry.set(terminalName, {
    terminalName,
    symbol: symbolName ?? prev?.symbol ?? null,
    pollCount: (prev?.pollCount ?? 0) + 1,
    lastPollAt: nowIso,
  })

  return buildMt5SignalPacket(state, preset, exchange)
}

export function getMt5BridgeSnapshot(
  state: BotEngineState,
  preset: StrategyPreset,
  exchange: ExchangeStatusSnapshot,
): Mt5BridgeSnapshot {
  return {
    magicNumber: FLARE_MT5_MAGIC,
    pollCount,
    lastPollAt,
    lastTerminalName,
    lastTerminalSymbol,
    terminals: Array.from(terminalRegistry.values()),
    lastPacket: buildMt5SignalPacket(state, preset, exchange),
  }
}

export function resetMt5BridgeTelemetry(): void {
  pollCount = 0
  lastPollAt = null
  lastTerminalName = null
  lastTerminalSymbol = null
  terminalRegistry.clear()
}
