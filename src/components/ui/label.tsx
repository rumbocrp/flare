import type { ComponentProps } from 'react'
import { Label as LabelPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

function Label({
  className,
  ...props
}: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        'font-mono text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export { Label }
