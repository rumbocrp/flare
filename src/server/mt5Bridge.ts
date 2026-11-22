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
  eaVersion: string | null
  broker: string | null
  account: string | null
  reportedMagicNumber: number | null
  pollCount: number
  lastPollAt: string
}

export type Mt5AckStatus =
  | 'EXECUTED'
  | 'CLOSED'
  | 'REJECTED'
  | 'ERROR'
  | 'NOOP'

export type Mt5ReportedPosition = {
  ticket: string
  symbol: string
  side: 'BUY' | 'SELL'
  volume: number
  openPrice: number
  sl: number
  tp: number
  profit: number
}

export type Mt5ExecutionAck = {
  signalId: string
  receivedAt: string
  terminalName: string
  eaVersion: string | null
  symbol: string | null
  action: Mt5Action | null
  status: Mt5AckStatus
  ticket: string | null
  fillPrice: number | null
  volume: number | null
  error: string | null
  broker: string | null
  account: string | null
  positions: Mt5ReportedPosition[] | null
}

export type Mt5ExecutionState =
  | 'waiting-for-ea'
  | 'unconfirmed'
  | 'pending-ea'
  | 'confirmed'
  | 'error'

export type Mt5BridgeSnapshot = {
  magicNumber: number
  pollCount: number
  lastPollAt: string | null
  lastTerminalName: string | null
  lastTerminalSymbol: string | null
  lastEaVersion: string | null
  lastBroker: string | null
  lastAccount: string | null
  terminals: Mt5TerminalTelemetry[]
  /** The exact last packet actually served to a polling EA (`null` if no EA has polled). */
  lastPacket: Mt5SignalPacket | null
  /** Last execution acknowledgement reported by the EA via `POST /api/mt5/ack`. */
  lastAck: Mt5ExecutionAck | null
  executionState: Mt5ExecutionState
  pendingCloseCommand: boolean
  reportedPositions: Mt5ReportedPosition[] | null
}

const FLARE_MT5_MAGIC = 202615
const MAX_MT5_TERMINALS = 32

let pollCount = 0
let lastPollAt: string | null = null
let lastTerminalName: string | null = null
let lastTerminalSymbol: string | null = null
let lastEaVersion: string | null = null
let lastBroker: string | null = null
let lastAccount: string | null = null
let lastServedPacket: Mt5SignalPacket | null = null
let lastAck: Mt5ExecutionAck | null = null
let pendingCloseCommand = false
let reportedPositions: Mt5ReportedPosition[] | null = null
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
  meta?: {
    terminal?: string | null
    symbol?: string | null
    eaVersion?: string | null
    broker?: string | null
    account?: string | null
    magicNumber?: number | null
  },
): Mt5SignalPacket {
  const nowIso = new Date().toISOString()
  pollCount += 1
  lastPollAt = nowIso
  const terminalName = meta?.terminal?.trim() || 'MT5-ExpertAdvisor'
  const symbolName = meta?.symbol?.trim() || null
  const eaVersion = meta?.eaVersion?.trim() || null
  const broker = meta?.broker?.trim() || null
  const account = meta?.account?.trim() || null
  const reportedMagicNumber =
    typeof meta?.magicNumber === 'number' &&
    Number.isFinite(meta.magicNumber) &&
    meta.magicNumber > 0
      ? Math.round(meta.magicNumber)
      : null

  lastTerminalName = terminalName
  if (symbolName) lastTerminalSymbol = symbolName
  if (eaVersion) lastEaVersion = eaVersion
  if (broker) lastBroker = broker
  if (account) lastAccount = account

  const prev = terminalRegistry.get(terminalName)
  terminalRegistry.delete(terminalName)
  if (terminalRegistry.size >= MAX_MT5_TERMINALS) {
    const oldest = terminalRegistry.keys().next().value
    if (oldest !== undefined) terminalRegistry.delete(oldest)
  }
  terminalRegistry.set(terminalName, {
    terminalName,
    symbol: symbolName ?? prev?.symbol ?? null,
    eaVersion: eaVersion ?? prev?.eaVersion ?? null,
    broker: broker ?? prev?.broker ?? null,
    account: account ?? prev?.account ?? null,
    reportedMagicNumber: reportedMagicNumber ?? prev?.reportedMagicNumber ?? null,
    pollCount: (prev?.pollCount ?? 0) + 1,
    lastPollAt: nowIso,
  })

  const packet = buildMt5SignalPacket(state, preset, exchange)
  lastServedPacket = packet
  return packet
}

export function markMt5ClosePending(): void {
  if (pollCount > 0) {
    pendingCloseCommand = true
  }
}

export function recordMt5Ack(input: {
  signalId: string
  terminalName?: string | null
  eaVersion?: string | null
  symbol?: string | null
  action?: Mt5Action | null
  status: Mt5AckStatus
  ticket?: string | null
  fillPrice?: number | null
  volume?: number | null
  error?: string | null
  broker?: string | null
  account?: string | null
  positions?: Mt5ReportedPosition[] | null
}): Mt5ExecutionAck {
  const nowIso = new Date().toISOString()
  const terminalName =
    input.terminalName?.trim() || lastTerminalName || 'MT5-ExpertAdvisor'
  const eaVersion = input.eaVersion?.trim() || lastEaVersion
  const broker = input.broker?.trim() || lastBroker
  const account = input.account?.trim() || lastAccount
  const symbol = input.symbol?.trim() || lastTerminalSymbol

  const ack: Mt5ExecutionAck = {
    signalId: input.signalId.trim(),
    receivedAt: nowIso,
    terminalName,
    eaVersion,
    symbol,
    action: input.action ?? null,
    status: input.status,
    ticket: input.ticket?.trim() || null,
    fillPrice:
      typeof input.fillPrice === 'number' && Number.isFinite(input.fillPrice)
        ? input.fillPrice
        : null,
    volume:
      typeof input.volume === 'number' && Number.isFinite(input.volume)
        ? input.volume
        : null,
    error: input.error?.trim() || null,
    broker,
    account,
    positions: Array.isArray(input.positions) ? input.positions : null,
  }

  lastAck = ack
  if (eaVersion) lastEaVersion = eaVersion
  if (broker) lastBroker = broker
  if (account) lastAccount = account
  if (ack.positions !== null) {
    reportedPositions = ack.positions
  }
  if (
    ack.status === 'CLOSED' ||
    ack.status === 'NOOP' ||
    ack.action === 'CLOSE_ALL'
  ) {
    pendingCloseCommand = false
  }

  return ack
}

function resolveExecutionState(
  exchange: ExchangeStatusSnapshot,
): Mt5ExecutionState {
  if (pollCount === 0 || !lastServedPacket) {
    return 'waiting-for-ea'
  }
  if (pendingCloseCommand) {
    return 'pending-ea'
  }
  if (exchange.killSwitchActive) {
    if (
      lastAck &&
      lastServedPacket.action === 'CLOSE_ALL' &&
      lastAck.signalId === lastServedPacket.signalId &&
      (lastAck.status === 'CLOSED' || lastAck.status === 'NOOP')
    ) {
      return 'confirmed'
    }
    return 'pending-ea'
  }
  if (!lastAck) {
    return 'unconfirmed'
  }
  if (lastAck.signalId !== lastServedPacket.signalId) {
    return lastServedPacket.action === 'HOLD' ? 'unconfirmed' : 'pending-ea'
  }
  if (lastAck.status === 'ERROR' || lastAck.status === 'REJECTED') {
    return 'error'
  }
  return 'confirmed'
}

export function getMt5BridgeSnapshot(
  _state: BotEngineState,
  _preset: StrategyPreset,
  exchange: ExchangeStatusSnapshot,
): Mt5BridgeSnapshot {
  return {
    magicNumber: FLARE_MT5_MAGIC,
    pollCount,
    lastPollAt,
    lastTerminalName,
    lastTerminalSymbol,
    lastEaVersion,
    lastBroker,
    lastAccount,
    terminals: Array.from(terminalRegistry.values()),
    lastPacket: lastServedPacket,
    lastAck,
    executionState: resolveExecutionState(exchange),
    pendingCloseCommand,
    reportedPositions,
  }
}

export function resetMt5BridgeTelemetry(): void {
  pollCount = 0
  lastPollAt = null
  lastTerminalName = null
  lastTerminalSymbol = null
  lastEaVersion = null
  lastBroker = null
  lastAccount = null
  lastServedPacket = null
  lastAck = null
  pendingCloseCommand = false
  reportedPositions = null
  terminalRegistry.clear()
}
