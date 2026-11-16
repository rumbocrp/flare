import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-8 w-full min-w-0 rounded-sm border border-input bg-secondary/65 px-2.5 py-1 font-mono text-xs text-foreground tabular-nums transition-all duration-150 outline-none placeholder:text-[var(--text-subtle)] hover:border-[var(--border-strong)] focus-visible:border-ring focus-visible:bg-card focus-visible:ring-1 focus-visible:ring-ring/50 aria-invalid:border-[var(--negative)] aria-invalid:ring-1 aria-invalid:ring-[var(--negative)] disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
