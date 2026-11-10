import type { BotStatus } from './types'

export const botStatusLabels: Record<BotStatus, string> = {
  stopped: 'STOP',
  running: 'PLAY (SIM)',
}
