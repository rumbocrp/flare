import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'

type PaneResizeHandleProps = {
  paneLabel: string
  currentHeight: number
  minHeight: number
  maxHeight: number
  disabled?: boolean
  title?: string
  ariaLabel: string
  onResize: (nextHeight: number) => void
  onReset: () => void
}

/**
 * Accessible horizontal divider handle for resizing oscillator sub-panes.
 * Dragging up grows the pane below; dragging down shrinks it.
 * Supports keyboard ArrowUp/ArrowDown, Home/End, and double-click reset.
 */
function PaneResizeHandle({
  currentHeight,
  minHeight,
  maxHeight,
  disabled = false,
  title,
  ariaLabel,
  onResize,
  onReset,
}: PaneResizeHandleProps) {
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (disabled) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = {
      startY: event.clientY,
      startHeight: currentHeight,
    }
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragRef.current || disabled) return
    // Moving pointer upward (smaller clientY) expands the pane below
    const deltaY = dragRef.current.startY - event.clientY
    onResize(dragRef.current.startHeight + deltaY)
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    dragRef.current = null
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return
    const step = event.shiftKey ? 24 : 12
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      onResize(currentHeight + step)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      onResize(currentHeight - step)
    } else if (event.key === 'Home') {
      event.preventDefault()
      onResize(minHeight)
    } else if (event.key === 'End') {
      event.preventDefault()
      onResize(maxHeight)
    } else if (event.key === 'Enter' || event.key === '0') {
      event.preventDefault()
      onReset()
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={ariaLabel}
      aria-valuemin={minHeight}
      aria-valuemax={maxHeight}
      aria-valuenow={currentHeight}
      tabIndex={disabled ? -1 : 0}
      title={title}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={disabled ? undefined : onReset}
      onKeyDown={handleKeyDown}
      className={cn(
        'pane-resize-handle group flex h-2 shrink-0 items-center justify-center outline-none select-none',
        disabled
          ? 'pointer-events-none opacity-40'
          : 'cursor-row-resize touch-none focus-visible:bg-primary/15',
      )}
    >
      <span
        aria-hidden="true"
        className="h-[2px] w-10 rounded-full bg-foreground/15 transition-colors group-hover:w-14 group-hover:bg-primary group-focus-visible:bg-primary"
      />
    </div>
  )
}

export default PaneResizeHandle
