import type { ChangeEventHandler } from "react"

type NumberFieldProps = {
  name: string
  label: string
  unit: string
  hint: string
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
  onChange
}: NumberFieldProps) {
  return (
    <div className='field'>
      <label className="field__label" htmlFor={name}>
        {label}
      </label>

      <div className="field__control">
        <input
          id={name}
          name={name}
          type='number'
          inputMode='decimal'
          step='any'
          value={value}
          onChange={onChange}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${name}-help`}
        />
        <span className='field__unit'>{unit}</span>
      </div>

      <p
        id={`${name}-help`}
        className={`field__help ${error ? 'field__help--error' : ''}`}
      >
        {error ?? hint}
      </p>
    </div>
  )
}

export default NumberField
