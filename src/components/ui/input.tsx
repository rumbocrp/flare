import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-8 w-full min-w-0 rounded-sm bg-muted/45 px-2.5 py-1 text-xs text-foreground tabular-nums transition-all duration-150 outline-none placeholder:text-[var(--text-subtle)] hover:bg-muted/65 focus-visible:bg-card focus-visible:ring-2 focus-visible:ring-ring/50 aria-invalid:ring-2 aria-invalid:ring-[var(--negative)] disabled:cursor-not-allowed disabled:opacity-45',
        type === 'number' && 'font-mono',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
