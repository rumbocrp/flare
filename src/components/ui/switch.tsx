import type { ComponentProps } from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

function Switch({
  className,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-[5px] border border-border transition-all duration-150 outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=unchecked]:bg-secondary',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block size-3 rounded-[3px] transition-transform data-[state=checked]:translate-x-[15px] data-[state=checked]:bg-primary-foreground data-[state=unchecked]:translate-x-0.5 data-[state=unchecked]:bg-muted-foreground',
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
