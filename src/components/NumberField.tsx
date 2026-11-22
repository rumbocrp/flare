import type { ChangeEventHandler } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

type NumberFieldProps = {
  name: string
  label: string
  unit: string
  hint?: string
  value: string
  error?: string
  onChange: ChangeEventHandler<HTMLInputElement>
}

function NumberField({
  name,
  label,
  unit,
  hint,
  value,
  error,
  onChange,
}: NumberFieldProps) {
  const inputId = `field-${name}`
  const helpId = `${inputId}-help`

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      <div className="flex items-center gap-1.5">
        <Input
          id={inputId}
          name={name}
          type="number"
          step="any"
          inputMode="decimal"
          value={value}
          onChange={onChange}
          aria-invalid={Boolean(error)}
          aria-describedby={error || hint ? helpId : undefined}
        />
        <span className="inline-flex h-8 min-w-[38px] shrink-0 items-center justify-center rounded-sm bg-muted/45 px-1.5 font-mono text-[10.5px] font-medium text-muted-foreground">
          {unit}
        </span>
      </div>
      {(error || hint) && (
        <span
          id={helpId}
          className={cn(
            'text-[11px] leading-snug',
            error ? 'text-[var(--negative)]' : 'text-[var(--text-subtle)]',
          )}
        >
          {error ?? hint}
        </span>
      )}
    </div>
  )
}

export default NumberField
