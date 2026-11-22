import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

function Dock({ className, children, ...props }: ComponentProps<'nav'>) {
  return (
    <nav
      data-slot="dock"
      className={cn(
        'inline-flex w-auto max-w-[calc(100vw-1rem)] items-center justify-center gap-1.5 rounded-2xl bg-[var(--surface-glass)] px-2.5 py-1.5 backdrop-blur-xl',
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
  const tooltipLabel = tooltip ?? label
  const btn = (
    <button
      type={type}
      data-slot="dock-item"
      data-active={active ? 'true' : 'false'}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex size-10 shrink-0 items-center justify-center rounded-xl transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer select-none',
        active
          ? 'bg-primary/15 text-primary'
          : 'bg-transparent text-muted-foreground hover:bg-muted/55 hover:text-foreground',
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          'flex items-center justify-center transition-transform duration-150 group-hover:-translate-y-0.5',
          active
            ? 'text-primary'
            : 'text-muted-foreground group-hover:text-foreground',
        )}
      >
        {icon}
      </span>
      <span className="sr-only">{label}</span>
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute bottom-1 h-1 rounded-full transition-all duration-150',
          active
            ? 'w-1.5 bg-primary opacity-100'
            : 'w-1 bg-foreground/45 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
        )}
      />
    </button>
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={10}>
        {tooltipLabel}
      </TooltipContent>
    </Tooltip>
  )
}

function DockSeparator({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('mx-1 h-4 w-px shrink-0 bg-foreground/10', className)}
    />
  )
}

export { Dock, DockItem, DockSeparator }
