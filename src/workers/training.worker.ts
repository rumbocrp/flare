/**
 * Dedicated browser Web Worker executing FLARE's Fit -> Validate -> Test
 * training pipelines (`walk-forward`, `meta-filter`, `prediction-market`) off
 * the main UI thread with real progress checkpoints and cooperative cancellation.
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

export type TrainingWorkerRequest =
  | {
      id: number
      type: 'run'
      candles: Candle[]
      preset: StrategyPreset
      config: TrainingConfig
    }
  | {
      id: number
      type: 'cancel'
    }

export type TrainingWorkerResponse =
  | {
      id: number
      type: 'progress'
      progress: TrainingProgress
    }
  | {
      id: number
      type: 'done'
      output: TrainingRunOutput
      durationMs: number
    }
  | {
      id: number
      type: 'cancelled'
    }
  | {
      id: number
      type: 'error'
      error: string
    }

const cancelledJobIds = new Set<number>()

self.onmessage = (event: MessageEvent<TrainingWorkerRequest>) => {
  const req = event.data
  if (req.type === 'cancel') {
    cancelledJobIds.add(req.id)
    return
  }

  const started = performance.now()
  try {
    const output = runTrainingPipeline(
      {
        candles: req.candles,
        preset: req.preset,
        config: req.config,
      },
      {
        onProgress: (progress) => {
          const msg: TrainingWorkerResponse = {
            id: req.id,
            type: 'progress',
            progress,
          }
          self.postMessage(msg)
        },
        isCancelled: () => cancelledJobIds.has(req.id),
      },
    )

    cancelledJobIds.delete(req.id)
    const doneMsg: TrainingWorkerResponse = {
      id: req.id,
      type: 'done',
      output,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
    }
    self.postMessage(doneMsg)
  } catch (err) {
    cancelledJobIds.delete(req.id)
    if (err instanceof TrainingCancelledError) {
      const cancelMsg: TrainingWorkerResponse = {
        id: req.id,
        type: 'cancelled',
      }
      self.postMessage(cancelMsg)
      return
    }
    const errMsg: TrainingWorkerResponse = {
      id: req.id,
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    }
    self.postMessage(errMsg)
  }
}
