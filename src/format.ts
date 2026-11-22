const moneyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})

const moneyWholeFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const priceFmt = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const dateTimeFmtCache = new Map<string, Intl.DateTimeFormat>()

function getDateTimeFmt(locale: string): Intl.DateTimeFormat {
  let fmt = dateTimeFmtCache.get(locale)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'UTC',
    })
    dateTimeFmtCache.set(locale, fmt)
  }
  return fmt
}

export function formatMoney(value: number): string {
  return moneyFmt.format(value)
}

export function formatSignedMoney(value: number): string {
  const text = formatMoney(value)
  return value > 0 ? `+${text}` : text
}

export function formatPrice(value: number): string {
  return priceFmt.format(value)
}

export function formatPercent(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`
}

export function formatR(value: number, digits = 2): string {
  const fixed = value.toFixed(digits)
  return value > 0 ? `+${fixed}R` : `${fixed}R`
}

export function formatOrDash(
  value: number | null,
  format: (value: number) => string,
): string {
  return value === null ? '—' : format(value)
}

export function formatMoneyWhole(value: number): string {
  return moneyWholeFmt.format(value)
}

export function formatDateTime(timestamp: number, locale = 'en-US'): string {
  return getDateTimeFmt(locale).format(timestamp)
}
