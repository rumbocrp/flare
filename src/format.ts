export function formatMoney(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  })
}

export function formatSignedMoney(value: number): string {
  const text = formatMoney(value)
  return value > 0 ? `+${text}` : text
}

export function formatPrice(value: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function formatPercent(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`
}

export function formatOrDash(
  value: number | null,
  format: (value: number) => string,
): string {
  return value === null ? '—' : format(value)
}

export function formatMoneyWhole(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
}

export function formatDateTime(timestamp: number, locale = 'en-US'): string {
  return new Date(timestamp).toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  })
}
