/**
 * Typed HTTP client for FLARE's Training & Historical Market Data endpoints.
 * Zero client-side fallback: every error throws `BackendApiError` so the UI
 * renders an explicit offline/error state with retry.
 */
import type { StrategyPresetPatch } from '../botEngine'
import type {
  HistoricalCandlesResponse,
  TrainingConfig,
  TrainingEquityPoint,
  TrainingFoldResult,
  TrainingLiveShadowResponse,
  TrainingProgress,
  TrainingRunMetrics,
  TrainingRunRecord,
  TrainingRunStatus,
  TrainingTradeRecord,
} from '../training/types'
import type { Interval } from '../types'
import { BackendApiError, requestBackend } from './botClient'

export function createClientRunId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export async function fetchHistoricalCandlesApi(params: {
  pair: string
  interval: Interval
  fromTimeMs: number
  toTimeMs: number
  signal?: AbortSignal
}): Promise<HistoricalCandlesResponse> {
  const qs = new URLSearchParams({
    pair: params.pair,
    interval: params.interval,
    from: String(Math.floor(params.fromTimeMs)),
    to: String(Math.floor(params.toTimeMs)),
  })
  const res = await requestBackend<HistoricalCandlesResponse>(
    `/market/history?${qs.toString()}`,
    { method: 'GET', signal: params.signal },
    30_000,
  )
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return res.data
}

export type CreateTrainingRunPayload = {
  clientRunId: string
  config: TrainingConfig
  candleCount?: number
  dataSource?: string
  customPreset?: StrategyPresetPatch
}

export type CreateTrainingRunResponse = {
  run: TrainingRunRecord
  deduplicated: boolean
}

export async function createTrainingRunApi(
  payload: CreateTrainingRunPayload,
  signal?: AbortSignal,
): Promise<CreateTrainingRunResponse> {
  const res = await requestBackend<CreateTrainingRunResponse>(
    '/training/runs',
    {
      method: 'POST',
      body: JSON.stringify(payload),
      signal,
    },
    10_000,
  )
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return res.data
}

export type PatchTrainingRunPayload = {
  status?: TrainingRunStatus
  candleCount?: number
  progress?: TrainingProgress | null
  metrics?: TrainingRunMetrics | null
  folds?: TrainingFoldResult[] | null
  equity?: TrainingEquityPoint[] | null
  trades?: TrainingTradeRecord[] | null
  dataSource?: string
  error?: string | null
}

export async function patchTrainingRunApi(
  runId: string,
  payload: PatchTrainingRunPayload,
  signal?: AbortSignal,
): Promise<TrainingRunRecord> {
  const res = await requestBackend<{ run: TrainingRunRecord }>(
    `/training/runs/${encodeURIComponent(runId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
      signal,
    },
    15_000,
  )
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return res.data.run
}

export async function listTrainingRunsApi(options?: {
  presetId?: string
  limit?: number
  reconcileInterrupted?: boolean
  signal?: AbortSignal
}): Promise<{
  tenantId: string
  runs: TrainingRunRecord[]
  interruptedCount: number
}> {
  const qs = new URLSearchParams()
  if (options?.presetId) qs.set('presetId', options.presetId)
  if (options?.limit !== undefined) qs.set('limit', String(options.limit))
  if (options?.reconcileInterrupted) qs.set('reconcileInterrupted', 'true')
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  const res = await requestBackend<{
    tenantId: string
    runs: TrainingRunRecord[]
    interruptedCount: number
  }>(`/training/runs${suffix}`, { method: 'GET', signal: options?.signal }, 10_000)
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return res.data
}

export async function getTrainingRunApi(
  runId: string,
  signal?: AbortSignal,
): Promise<TrainingRunRecord> {
  const res = await requestBackend<{ run: TrainingRunRecord }>(
    `/training/runs/${encodeURIComponent(runId)}`,
    { method: 'GET', signal },
    10_000,
  )
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return res.data.run
}

export async function cancelTrainingRunApi(
  runId: string,
  signal?: AbortSignal,
): Promise<{ run: TrainingRunRecord; alreadyCancelled: boolean }> {
  const res = await requestBackend<{
    run: TrainingRunRecord
    alreadyCancelled: boolean
  }>(
    `/training/runs/${encodeURIComponent(runId)}/cancel`,
    { method: 'POST', signal },
    10_000,
  )
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return res.data
}

export async function getTrainingLiveShadowApi(params: {
  presetId: string
  fromTimeMs?: number
  toTimeMs?: number
  signal?: AbortSignal
}): Promise<TrainingLiveShadowResponse> {
  const qs = new URLSearchParams({ presetId: params.presetId })
  if (params.fromTimeMs !== undefined) qs.set('from', String(Math.floor(params.fromTimeMs)))
  if (params.toTimeMs !== undefined) qs.set('to', String(Math.floor(params.toTimeMs)))
  const res = await requestBackend<TrainingLiveShadowResponse>(
    `/training/live?${qs.toString()}`,
    { method: 'GET', signal: params.signal },
    10_000,
  )
  if (!res.ok) {
    throw new BackendApiError(res.error, res.status)
  }
  return res.data
}
