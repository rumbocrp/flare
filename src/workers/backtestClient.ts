/**
 * Promise + AbortSignal client for the dedicated backtest Web Worker.
 * Automatically falls back to synchronous execution in non-Worker runtimes
 * (e.g., Vitest Node tests or SSR) so callers share one clean async API.
 */
import {
  runBacktest,
  type BacktestConfig,
  type BacktestResult,
} from '../backtest'
import {
  buildDirectionalRules,
  type DirectionalTimeframe,
} from '../directionalRules'
import {
  simulatePredictionStrategy,
  type SimulationConfig,
  type SimulationResult,
} from '../predictionMarket'
import { BITCOIN_20_PREDICTIONS } from '../predictions'
import type { Candle, Interval } from '../types'
import type {
  WorkerJobRequest,
  WorkerJobResponse,
} from './backtest.worker'

export type OffloadedJobOutput<T> = {
  result: T
  durationMs: number
  executedIn: 'worker' | 'main-thread'
}

type PendingJob = {
  resolve: (value: WorkerJobResponse) => void
  reject: (reason: unknown) => void
}

let sharedWorker: Worker | null = null
let nextJobId = 1
const pendingJobs = new Map<number, PendingJob>()

function resetWorker(error?: Error): void {
  if (sharedWorker) {
    sharedWorker.terminate()
    sharedWorker = null
  }
  if (error) {
    for (const [, pending] of pendingJobs) {
      pending.reject(error)
    }
    pendingJobs.clear()
  }
}

function getOrCreateWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null
  if (sharedWorker) return sharedWorker
  try {
    const worker = new Worker(
      new URL('./backtest.worker.ts', import.meta.url),
      { type: 'module' },
    )
    worker.onmessage = (event: MessageEvent<WorkerJobResponse>) => {
      const msg = event.data
      const pending = pendingJobs.get(msg.id)
      if (!pending) return
      pendingJobs.delete(msg.id)
      pending.resolve(msg)
    }
    worker.onerror = (event) => {
      resetWorker(new Error(event.message || 'Backtest worker crashed'))
    }
    sharedWorker = worker
    return worker
  } catch {
    return null
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never

type WorkerJobPayload = DistributiveOmit<WorkerJobRequest, 'id'>

function dispatchToWorker(
  payload: WorkerJobPayload,
  signal?: AbortSignal,
): Promise<WorkerJobResponse> | null {
  const worker = getOrCreateWorker()
  if (!worker) return null

  return new Promise<WorkerJobResponse>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Backtest job aborted', 'AbortError'))
      return
    }

    const id = nextJobId++
    const onAbort = () => {
      pendingJobs.delete(id)
      reject(new DOMException('Backtest job aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    pendingJobs.set(id, {
      resolve: (res) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(res)
      },
      reject: (err) => {
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      },
    })

    worker.postMessage({ ...payload, id } as WorkerJobRequest)
  })
}

export async function runBacktestOffloaded(
  candles: Candle[],
  config: BacktestConfig,
  signal?: AbortSignal,
): Promise<OffloadedJobOutput<BacktestResult>> {
  const workerPromise = dispatchToWorker(
    { type: 'backtest', candles, config },
    signal,
  )

  if (workerPromise) {
    const res = await workerPromise
    if (!res.ok) throw new Error(res.error)
    if (res.type === 'backtest') {
      return {
        result: res.result,
        durationMs: res.durationMs,
        executedIn: 'worker',
      }
    }
  }

  if (signal?.aborted) {
    throw new DOMException('Backtest job aborted', 'AbortError')
  }
  const started = performance.now()
  const result = runBacktest(candles, config)
  return {
    result,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
    executedIn: 'main-thread',
  }
}

export async function runPredictionSimOffloaded(params: {
  candles: Candle[]
  ruleFamily: 'bitcoin20' | 'directional'
  timeframe: Interval
  config: SimulationConfig
  signal?: AbortSignal
}): Promise<OffloadedJobOutput<SimulationResult>> {
  const workerPromise = dispatchToWorker(
    {
      type: 'prediction-sim',
      candles: params.candles,
      ruleFamily: params.ruleFamily,
      timeframe: params.timeframe,
      config: params.config,
    },
    params.signal,
  )

  if (workerPromise) {
    const res = await workerPromise
    if (!res.ok) throw new Error(res.error)
    if (res.type === 'prediction-sim') {
      return {
        result: res.result,
        durationMs: res.durationMs,
        executedIn: 'worker',
      }
    }
  }

  if (params.signal?.aborted) {
    throw new DOMException('Simulation job aborted', 'AbortError')
  }
  const started = performance.now()
  const rules =
    params.ruleFamily === 'directional'
      ? buildDirectionalRules(
          (params.timeframe === '5m' ? '5m' : '15m') as DirectionalTimeframe,
        )
      : BITCOIN_20_PREDICTIONS.filter((r) => r.timeframe === params.timeframe)
  const result = simulatePredictionStrategy(params.candles, rules, params.config)
  return {
    result,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
    executedIn: 'main-thread',
  }
}

export function disposeBacktestWorker(): void {
  resetWorker()
}
