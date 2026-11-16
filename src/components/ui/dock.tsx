import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

function Dock({ className, children, ...props }: ComponentProps<'nav'>) {
  return (
    <nav
      data-slot="dock"
      className={cn(
        'inline-flex w-full max-w-[calc(100vw-1rem)] items-center justify-between gap-1 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-glass)] p-1.5 shadow-[var(--shadow-soft)] backdrop-blur-xl sm:w-auto sm:justify-start',
        className,
      )}
      {...props}
    >
      {children}
    </nav>
  )
}

type DockItemProps = ComponentProps<'button'> & {
  icon: ReactNode
  label: string
  tooltip?: string
  active?: boolean
}

function DockItem({
  className,
  icon,
  label,
  tooltip,
  active = false,
  type = 'button',
  ...props
}: DockItemProps) {
  const btn = (
    <button
      type={type}
      data-slot="dock-item"
      data-active={active ? 'true' : 'false'}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md border px-1 transition-all duration-150 outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer select-none sm:flex-none sm:min-w-[66px] sm:px-2.5',
        active
          ? 'border-border bg-secondary/90 text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
          : 'border-transparent bg-transparent text-muted-foreground hover:bg-accent/70 hover:text-foreground',
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          'flex items-center justify-center transition-colors',
          active
            ? 'text-primary'
            : 'text-muted-foreground group-hover:text-foreground',
        )}
      >
        {icon}
      </span>
      <span className="max-w-full truncate font-mono text-[9px] font-medium tracking-[0.02em] sm:text-[9.5px]">
        {label}
      </span>
      {active && (
        <span
          aria-hidden="true"
          className="absolute right-2.5 bottom-0.5 left-2.5 h-[2px] rounded-full bg-primary shadow-[0_0_8px_rgba(240,185,11,0.55)]"
        />
      )}
    </button>
  )

  if (!tooltip) return btn

  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

function DockSeparator({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('mx-0.5 hidden h-6 w-px shrink-0 bg-border sm:inline-block', className)}
    />
  )
}

export { Dock, DockItem, DockSeparator }
