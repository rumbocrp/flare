/**
 * Promise + AbortSignal + real-progress client for the dedicated training Web Worker.
 * Mirrors `src/workers/backtestClient.ts`: executes in a module Web Worker in
 * browsers (terminating immediately on cancel to free CPU) and runs directly
 * in Node/Vitest where `Worker` is unavailable.
 */
import type { StrategyPreset } from '../botEngine'
import {
  runTrainingPipeline,
  TrainingCancelledError,
} from '../training/runner'
import type {
  TrainingConfig,
  TrainingProgress,
  TrainingRunOutput,
} from '../training/types'
import type { Candle } from '../types'
import type {
  TrainingWorkerRequest,
  TrainingWorkerResponse,
} from './training.worker'

export type TrainingJobResult = {
  output: TrainingRunOutput
  durationMs: number
  executedIn: 'worker' | 'main-thread'
}

type PendingTrainingJob = {
  resolve: (result: { output: TrainingRunOutput; durationMs: number }) => void
  reject: (reason: unknown) => void
  onProgress?: (progress: TrainingProgress) => void
}

let sharedWorker: Worker | null = null
let nextJobId = 1
const pendingJobs = new Map<number, PendingTrainingJob>()

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
      new URL('./training.worker.ts', import.meta.url),
      { type: 'module' },
    )
    worker.onmessage = (event: MessageEvent<TrainingWorkerResponse>) => {
      const msg = event.data
      const pending = pendingJobs.get(msg.id)
      if (!pending) return
      if (msg.type === 'progress') {
        pending.onProgress?.(msg.progress)
        return
      }
      pendingJobs.delete(msg.id)
      if (msg.type === 'done') {
        pending.resolve({ output: msg.output, durationMs: msg.durationMs })
        return
      }
      if (msg.type === 'cancelled') {
        pending.reject(new TrainingCancelledError())
        return
      }
      pending.reject(new Error(msg.error))
    }
    worker.onerror = (event) => {
      resetWorker(new Error(event.message || 'Training worker crashed'))
    }
    sharedWorker = worker
    return worker
  } catch {
    return null
  }
}

export async function runTrainingOffloaded(params: {
  candles: Candle[]
  preset: StrategyPreset
  config: TrainingConfig
  onProgress?: (progress: TrainingProgress) => void
  signal?: AbortSignal
}): Promise<TrainingJobResult> {
  const { candles, preset, config, onProgress, signal } = params

  if (signal?.aborted) {
    throw new TrainingCancelledError()
  }

  const worker = getOrCreateWorker()
  if (worker) {
    const result = await new Promise<{
      output: TrainingRunOutput
      durationMs: number
    }>((resolve, reject) => {
      const id = nextJobId++
      const onAbort = () => {
        pendingJobs.delete(id)
        try {
          worker.postMessage({ id, type: 'cancel' } satisfies TrainingWorkerRequest)
        } catch {
          // Ignore postMessage errors during termination
        }
        // Terminate immediately if this was the only active job so CPU stops right away
        if (pendingJobs.size === 0) {
          resetWorker()
        }
        reject(new TrainingCancelledError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      pendingJobs.set(id, {
        onProgress,
        resolve: (res) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(res)
        },
        reject: (err) => {
          signal?.removeEventListener('abort', onAbort)
          reject(err)
        },
      })

      const request: TrainingWorkerRequest = {
        id,
        type: 'run',
        candles,
        preset,
        config,
      }
      worker.postMessage(request)
    })

    return {
      output: result.output,
      durationMs: result.durationMs,
      executedIn: 'worker',
    }
  }

  // Non-Worker environment (Node / Vitest)
  const started = performance.now()
  const output = runTrainingPipeline(
    { candles, preset, config },
    {
      onProgress,
      isCancelled: () => Boolean(signal?.aborted),
    },
  )
  return {
    output,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
    executedIn: 'main-thread',
  }
}

export function disposeTrainingWorker(): void {
  resetWorker()
}
