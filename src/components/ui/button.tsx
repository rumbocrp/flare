import type { ComponentProps } from 'react'
import { Slot } from 'radix-ui'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border text-xs font-medium transition-all duration-150 outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 cursor-pointer select-none',
  {
    variants: {
      variant: {
        default:
          'border-primary bg-primary text-primary-foreground font-semibold hover:bg-[var(--brand-hover)] hover:border-[var(--brand-hover)]',
        secondary:
          'border-border bg-secondary text-secondary-foreground hover:bg-accent hover:border-[var(--border-strong)]',
        outline:
          'border-border bg-card text-foreground hover:bg-accent hover:border-[var(--border-strong)]',
        ghost:
          'border-transparent bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
        destructive:
          'border-[var(--negative)]/45 bg-[var(--negative-soft)] text-[var(--negative)] hover:bg-destructive hover:border-destructive hover:text-destructive-foreground font-semibold',
        destructiveSolid:
          'border-destructive bg-destructive text-destructive-foreground font-semibold hover:opacity-90',
        positive:
          'border-[var(--positive)]/45 bg-[var(--positive-soft)] text-[var(--positive)] hover:bg-[var(--positive)] hover:border-[var(--positive)] hover:text-[#0b0e11] font-semibold',
        link: 'border-transparent bg-transparent text-primary underline-offset-4 hover:underline p-0 h-auto',
      },
      size: {
        default: 'h-8 px-3 py-1.5',
        xs: 'h-6 px-2 text-[11px] rounded-[4px]',
        sm: 'h-7 px-2.5 text-[11.5px]',
        lg: 'h-9 px-4 text-xs',
        icon: 'h-8 w-8 p-0',
        'icon-sm': 'h-7 w-7 p-0',
        'icon-xs': 'h-6 w-6 p-0 rounded-[4px]',
      },
    },
    defaultVariants: {
      variant: 'outline',
      size: 'default',
    },
  },
)

type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
