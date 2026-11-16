import type { ComponentProps } from 'react'
import { Slot } from 'radix-ui'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-tight uppercase tracking-[0.06em] whitespace-nowrap transition-colors',
  {
    variants: {
      variant: {
        default: 'border-primary/35 bg-primary/15 text-primary',
        secondary: 'border-border/80 bg-secondary/80 text-muted-foreground',
        outline: 'border-border bg-secondary/35 text-foreground',
        positive:
          'border-[var(--positive)]/40 bg-[var(--positive-soft)] text-[var(--positive)]',
        negative:
          'border-[var(--negative)]/40 bg-[var(--negative-soft)] text-[var(--negative)]',
        warning:
          'border-[var(--warning)]/40 bg-[var(--warning-soft)] text-[var(--warning)]',
        violet:
          'border-[var(--brand-violet)]/40 bg-[var(--brand-violet)]/12 text-[var(--brand-violet)]',
      },
    },
    defaultVariants: {
      variant: 'secondary',
    },
  },
)

type BadgeProps = ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean
  }

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: BadgeProps) {
  const Comp = asChild ? Slot.Root : 'span'

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
