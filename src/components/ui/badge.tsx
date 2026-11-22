import type { ComponentProps } from 'react'
import { Slot } from 'radix-ui'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 font-mono text-[10.5px] font-medium leading-tight whitespace-nowrap transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-primary/14 text-primary',
        secondary: 'bg-muted/55 text-muted-foreground',
        outline: 'bg-muted/40 text-foreground',
        positive: 'bg-[var(--positive-soft)] text-[var(--positive)]',
        negative: 'bg-[var(--negative-soft)] text-[var(--negative)]',
        warning: 'bg-[var(--warning-soft)] text-[var(--warning)]',
        violet: 'bg-[var(--brand-violet)]/14 text-[var(--brand-violet)]',
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
