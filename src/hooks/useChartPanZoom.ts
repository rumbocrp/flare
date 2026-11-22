import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react'
import type { PanTransformChannel } from '../chartCrosshair'

export const PAN_OVERSCAN_LIMIT = 10

type UseChartPanZoomParams = {
  containerRef: RefObject<HTMLDivElement | null>
  canvasWrapRef: RefObject<HTMLDivElement | null>
  wheelTargetRef?: { current: HTMLElement | null }
  panLayerRef: RefObject<SVGGElement | null>
  marginLeft: number
  plotWidth: number
  count: number
  slot: number
  viewStart: number
  canPanLeft: boolean
  canPanRight: boolean
  wheelZoomLocked: boolean
  reducedMotion?: boolean
  panTransformChannel?: PanTransformChannel
  onPanDelta?: (deltaBars: number) => void
  onZoomDelta?: (deltaBars: number, anchorRatio?: number) => void
  onClearCrosshair: () => void
}

/**
 * Zero-sawtooth 120fps GPU sub-pixel pan & cursor-anchored zoom engine.
 *
 * Translates the clipped `<g ref={panLayerRef}>` directly via `translate3d`
 * (and broadcasts the exact same pixel offset to RSI/MACD via
 * `panTransformChannel`), then reconciles `committedBars = originViewStart - viewStart`
 * synchronously inside `useLayoutEffect` before paint so bar commits have
 * mathematically 0.00px visual discontinuity.
 */
export function useChartPanZoom({
  containerRef,
  canvasWrapRef,
  wheelTargetRef,
  panLayerRef,
  marginLeft,
  plotWidth,
  count,
  slot,
  viewStart,
  canPanLeft,
  canPanRight,
  wheelZoomLocked,
  reducedMotion = false,
  panTransformChannel,
  onPanDelta,
  onZoomDelta,
  onClearCrosshair,
}: UseChartPanZoomParams) {
  const candleCountRef = useRef<number>(count)
  const viewStartRef = useRef<number>(viewStart)
  const canPanLeftRef = useRef<boolean>(canPanLeft)
  const canPanRightRef = useRef<boolean>(canPanRight)
  const slotRef = useRef<number>(slot)
  const wheelAccumRef = useRef<number>(0)
  const panRafRef = useRef<number | null>(null)
  const pendingPanBarsRef = useRef<number>(0)
  const wheelRafRef = useRef<number | null>(null)
  const pendingWheelZoomRef = useRef<{ delta: number; anchor: number } | null>(
    null,
  )

  const dragRef = useRef<{
    startX: number
    lastClientX: number
    originViewStart: number
    requestedBars: number
    isDragging: boolean
    clearedCrosshair: boolean
  } | null>(null)

  const wheelPanRef = useRef<{
    active: boolean
    originViewStart: number
    currentPx: number
    targetPx: number
    requestedBars: number
    idleTimer: number | null
    animRaf: number | null
  }>({
    active: false,
    originViewStart: 0,
    currentPx: 0,
    targetPx: 0,
    requestedBars: 0,
    idleTimer: null,
    animRaf: null,
  })

  const applyPanTransform = useCallback(
    (offsetPx: number) => {
      const normalized = Math.abs(offsetPx) < 0.05 ? 0 : offsetPx
      if (panLayerRef.current) {
        panLayerRef.current.style.transform =
          normalized === 0 ? '' : `translate3d(${normalized.toFixed(2)}px, 0, 0)`
      }
      panTransformChannel?.set(normalized)
    },
    [panLayerRef, panTransformChannel],
  )

  const queuePanDelta = useCallback(
    (deltaBars: number) => {
      if (!onPanDelta || deltaBars === 0) return
      pendingPanBarsRef.current += deltaBars
      if (panRafRef.current === null) {
        panRafRef.current = requestAnimationFrame(() => {
          panRafRef.current = null
          const queued = pendingPanBarsRef.current
          pendingPanBarsRef.current = 0
          if (queued !== 0) onPanDelta(queued)
        })
      }
    },
    [onPanDelta],
  )

  useEffect(() => {
    const wp = wheelPanRef.current
    return () => {
      if (panRafRef.current !== null) cancelAnimationFrame(panRafRef.current)
      if (wheelRafRef.current !== null) cancelAnimationFrame(wheelRafRef.current)
      if (wp.animRaf !== null) cancelAnimationFrame(wp.animRaf)
      if (wp.idleTimer !== null) window.clearTimeout(wp.idleTimer)
    }
  }, [])

  // Pre-paint synchronous reconciliation: keeps visualX === originX + dx with 0px jump
  useLayoutEffect(() => {
    candleCountRef.current = count
    viewStartRef.current = viewStart
    canPanLeftRef.current = canPanLeft
    canPanRightRef.current = canPanRight
    slotRef.current = slot

    if (slot <= 0 || count === 0) {
      applyPanTransform(0)
      return
    }
    const maxShiftPx = PAN_OVERSCAN_LIMIT * slot

    const drag = dragRef.current
    if (drag && drag.isDragging) {
      const committedBars = drag.originViewStart - viewStart
      const dx = drag.lastClientX - drag.startX
      let remPx = dx - committedBars * slot
      if (remPx > 0 && !canPanLeft) remPx = 0
      if (remPx < 0 && !canPanRight) remPx = 0
      remPx = Math.max(-maxShiftPx, Math.min(maxShiftPx, remPx))
      applyPanTransform(remPx)
      return
    }

    const wp = wheelPanRef.current
    if (wp.active) {
      const committedBars = wp.originViewStart - viewStart
      let remPx = wp.currentPx - committedBars * slot
      if (remPx > 0 && !canPanLeft) remPx = 0
      if (remPx < 0 && !canPanRight) remPx = 0
      remPx = Math.max(-maxShiftPx, Math.min(maxShiftPx, remPx))
      applyPanTransform(remPx)
      return
    }

    applyPanTransform(0)
  }, [applyPanTransform, canPanLeft, canPanRight, count, plotWidth, slot, viewStart])

  useEffect(() => {
    const rootEl = wheelTargetRef?.current ?? containerRef.current
    if (!rootEl || (!onZoomDelta && !onPanDelta) || plotWidth <= 0) return

    const effectiveReducedMotion =
      reducedMotion ||
      (typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches)

    const syncWheelPanVisual = () => {
      const wp = wheelPanRef.current
      if (!wp.active) return
      const effectiveSlot = slotRef.current
      if (effectiveSlot <= 0) return

      const committedBars = wp.originViewStart - viewStartRef.current
      let remPx = wp.currentPx - committedBars * effectiveSlot

      if (remPx > 0 && !canPanLeftRef.current) {
        remPx = 0
        wp.currentPx = committedBars * effectiveSlot
        wp.targetPx = wp.currentPx
        wp.requestedBars = committedBars
      } else if (remPx < 0 && !canPanRightRef.current) {
        remPx = 0
        wp.currentPx = committedBars * effectiveSlot
        wp.targetPx = wp.currentPx
        wp.requestedBars = committedBars
      }

      const maxShiftPx = PAN_OVERSCAN_LIMIT * effectiveSlot
      const clampedRemPx = Math.max(-maxShiftPx, Math.min(maxShiftPx, remPx))
      applyPanTransform(clampedRemPx)

      const desiredBars = Math.trunc(wp.currentPx / effectiveSlot)
      const stepDelta = desiredBars - wp.requestedBars
      if (stepDelta !== 0) {
        const canMove =
          (stepDelta > 0 && canPanLeftRef.current) ||
          (stepDelta < 0 && canPanRightRef.current)
        if (canMove) {
          wp.requestedBars = desiredBars
          queuePanDelta(stepDelta)
        }
      }
    }

    const scheduleWheelIdleSettle = () => {
      const wp = wheelPanRef.current
      if (wp.idleTimer !== null) window.clearTimeout(wp.idleTimer)
      wp.idleTimer = window.setTimeout(() => {
        wp.idleTimer = null
        if (!wp.active) return
        if (wp.animRaf !== null) {
          cancelAnimationFrame(wp.animRaf)
          wp.animRaf = null
        }
        const effectiveSlot = slotRef.current
        if (effectiveSlot > 0 && onPanDelta) {
          const committedBars = wp.originViewStart - viewStartRef.current
          const remPx = wp.currentPx - committedBars * effectiveSlot
          if (Math.abs(remPx) >= effectiveSlot * 0.5) {
            const roundBar =
              remPx > 0
                ? canPanLeftRef.current
                  ? 1
                  : 0
                : canPanRightRef.current
                  ? -1
                  : 0
            if (roundBar !== 0) onPanDelta(roundBar)
          }
        }
        wp.active = false
        wp.currentPx = 0
        wp.targetPx = 0
        wp.requestedBars = 0
        applyPanTransform(0)
      }, 140)
    }

    const startWheelGlideLoop = () => {
      const wp = wheelPanRef.current
      if (wp.animRaf !== null) return
      const step = () => {
        wp.animRaf = null
        if (!wp.active) return
        const diff = wp.targetPx - wp.currentPx
        if (Math.abs(diff) <= 0.35) {
          wp.currentPx = wp.targetPx
          syncWheelPanVisual()
          return
        }
        wp.currentPx += diff * 0.34
        syncWheelPanVisual()
        wp.animRaf = requestAnimationFrame(step)
      }
      wp.animRaf = requestAnimationFrame(step)
    }

    function handleNativeWheel(event: WheelEvent) {
      const hasZoomModifier = event.ctrlKey || event.metaKey || event.altKey
      const isHorizontalPan =
        (Math.abs(event.deltaX) > Math.abs(event.deltaY) &&
          Math.abs(event.deltaX) >= 0.5) ||
        (event.shiftKey && Math.abs(event.deltaY) >= 0.5)

      if (isHorizontalPan && onPanDelta) {
        event.preventDefault()
        event.stopPropagation()

        const effectiveSlot = slotRef.current
        if (effectiveSlot <= 0) return

        const rawDelta =
          Math.abs(event.deltaX) >= Math.abs(event.deltaY)
            ? event.deltaX
            : event.deltaY
        const pixelDelta =
          event.deltaMode === 1
            ? rawDelta * 24
            : event.deltaMode === 2
              ? rawDelta * plotWidth * 0.5
              : rawDelta

        const wp = wheelPanRef.current
        if (!wp.active) {
          wp.active = true
          wp.originViewStart = viewStartRef.current
          wp.currentPx = 0
          wp.targetPx = 0
          wp.requestedBars = 0
        }

        const isDiscreteNotch =
          event.deltaMode !== 0 || Math.abs(pixelDelta) >= 40
        const maxImpulse = effectiveSlot * 6
        const clampedDelta =
          Math.sign(pixelDelta) * Math.min(Math.abs(pixelDelta), maxImpulse)
        wp.targetPx += -clampedDelta

        if (!isDiscreteNotch || effectiveReducedMotion) {
          wp.currentPx = wp.targetPx
          syncWheelPanVisual()
        } else {
          startWheelGlideLoop()
        }

        scheduleWheelIdleSettle()
        return
      }

      if (!onZoomDelta) return
      if (!wheelZoomLocked && !hasZoomModifier) {
        return
      }
      event.preventDefault()
      event.stopPropagation()

      if (Math.abs(event.deltaY) < 0.01) return
      if (
        wheelAccumRef.current !== 0 &&
        Math.sign(event.deltaY) !== Math.sign(wheelAccumRef.current)
      ) {
        wheelAccumRef.current = 0
      }
      wheelAccumRef.current += event.deltaY
      if (Math.abs(wheelAccumRef.current) < 14) return

      const rawAccum = wheelAccumRef.current
      const direction = rawAccum > 0 ? 1 : -1
      wheelAccumRef.current = 0

      const rect = (
        canvasWrapRef.current ??
        containerRef.current ??
        rootEl!
      ).getBoundingClientRect()
      const relX = Math.max(
        0,
        Math.min(plotWidth, event.clientX - rect.left - marginLeft),
      )
      const rawRatio = relX / plotWidth
      const anchorRatio = rawRatio >= 0.9 ? 1 : rawRatio
      const zoomFactor = Math.abs(rawAccum) >= 70 ? 0.12 : 0.06
      const step = Math.max(2, Math.round(candleCountRef.current * zoomFactor))
      const prevZoom = pendingWheelZoomRef.current
      pendingWheelZoomRef.current = {
        delta: (prevZoom?.delta ?? 0) + direction * step,
        anchor: anchorRatio,
      }
      if (wheelRafRef.current === null) {
        wheelRafRef.current = requestAnimationFrame(() => {
          wheelRafRef.current = null
          const queued = pendingWheelZoomRef.current
          pendingWheelZoomRef.current = null
          if (queued && queued.delta !== 0) {
            onZoomDelta(queued.delta, queued.anchor)
          }
        })
      }
    }

    rootEl.addEventListener('wheel', handleNativeWheel, { passive: false })
    return () => {
      rootEl.removeEventListener('wheel', handleNativeWheel)
    }
  }, [
    applyPanTransform,
    canvasWrapRef,
    containerRef,
    marginLeft,
    onPanDelta,
    onZoomDelta,
    plotWidth,
    queuePanDelta,
    reducedMotion,
    wheelTargetRef,
    wheelZoomLocked,
  ])

  const cancelWheelPan = useCallback(() => {
    const wp = wheelPanRef.current
    if (!wp.active) return
    if (wp.animRaf !== null) {
      cancelAnimationFrame(wp.animRaf)
      wp.animRaf = null
    }
    if (wp.idleTimer !== null) {
      window.clearTimeout(wp.idleTimer)
      wp.idleTimer = null
    }
    wp.active = false
    wp.currentPx = 0
    wp.targetPx = 0
    wp.requestedBars = 0
    applyPanTransform(0)
  }, [applyPanTransform])

  const startDragPan = useCallback(
    (clientX: number) => {
      cancelWheelPan()
      dragRef.current = {
        startX: clientX,
        lastClientX: clientX,
        originViewStart: viewStartRef.current,
        requestedBars: 0,
        isDragging: true,
        clearedCrosshair: false,
      }
    },
    [cancelWheelPan],
  )

  const moveDragPan = useCallback(
    (clientX: number): boolean => {
      const drag = dragRef.current
      if (!drag || !drag.isDragging || !onPanDelta) return false

      drag.lastClientX = clientX
      const dx = clientX - drag.startX
      if (!drag.clearedCrosshair && Math.abs(dx) > 3) {
        drag.clearedCrosshair = true
        onClearCrosshair()
      }

      const effectiveSlot = slotRef.current
      if (effectiveSlot <= 0) return true

      const committedBars = drag.originViewStart - viewStartRef.current
      let remPx = dx - committedBars * effectiveSlot

      // Instant boundary clamp with zero dead-zone on direction reversal
      if (remPx > 0 && !canPanLeftRef.current) {
        remPx = 0
        drag.startX = clientX
        drag.originViewStart = viewStartRef.current
        drag.requestedBars = 0
      } else if (remPx < 0 && !canPanRightRef.current) {
        remPx = 0
        drag.startX = clientX
        drag.originViewStart = viewStartRef.current
        drag.requestedBars = 0
      }

      const maxShiftPx = PAN_OVERSCAN_LIMIT * effectiveSlot
      const clampedRemPx = Math.max(-maxShiftPx, Math.min(maxShiftPx, remPx))
      applyPanTransform(clampedRemPx)

      const desiredBars = Math.trunc((clientX - drag.startX) / effectiveSlot)
      const stepDelta = desiredBars - drag.requestedBars
      if (stepDelta !== 0) {
        const canMove =
          (stepDelta > 0 && canPanLeftRef.current) ||
          (stepDelta < 0 && canPanRightRef.current)
        if (canMove) {
          drag.requestedBars = desiredBars
          queuePanDelta(stepDelta)
        }
      }
      return true
    },
    [applyPanTransform, onClearCrosshair, onPanDelta, queuePanDelta],
  )

  const endDragPan = useCallback(() => {
    const drag = dragRef.current
    if (!drag || !drag.isDragging) return
    drag.isDragging = false
    const effectiveSlot = slotRef.current
    if (effectiveSlot > 0 && onPanDelta) {
      const committedBars = drag.originViewStart - viewStartRef.current
      const remPx =
        drag.lastClientX - drag.startX - committedBars * effectiveSlot
      if (Math.abs(remPx) >= effectiveSlot * 0.5) {
        const roundBar =
          remPx > 0
            ? canPanLeftRef.current
              ? 1
              : 0
            : canPanRightRef.current
              ? -1
              : 0
        if (roundBar !== 0) onPanDelta(roundBar)
      }
    }
    applyPanTransform(0)
  }, [applyPanTransform, onPanDelta])

  const abortDragPan = useCallback(() => {
    if (dragRef.current) {
      dragRef.current.isDragging = false
    }
    if (!wheelPanRef.current.active) {
      applyPanTransform(0)
    }
  }, [applyPanTransform])

  return {
    cancelWheelPan,
    startDragPan,
    moveDragPan,
    endDragPan,
    abortDragPan,
    applyPanTransform,
  }
}
