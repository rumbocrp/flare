import type { ComponentProps } from 'react'
import { Check } from 'lucide-react'
import { Checkbox as CheckboxPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

function Checkbox({
  className,
  ...props
}: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer size-4 shrink-0 cursor-pointer rounded-[4px] border border-border bg-secondary/80 transition-all duration-150 outline-none hover:border-[var(--border-strong)] focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        <Check className="size-3 stroke-[2.75]" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
