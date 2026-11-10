export function niceTicks(min: number, max: number, count = 4): number[] {
  let low = min
  let high = max

  if (low === high) {
    low -= 1
    high += 1
  }

  const roughStep = (high - low) / count
  const magnitude = 10 ** Math.floor(Math.log10(roughStep))
  const residual = roughStep / magnitude

  let niceResidual = 10
  if (residual <= 1) niceResidual = 1
  else if (residual <= 2) niceResidual = 2
  else if (residual <= 5) niceResidual = 5

  const step = niceResidual * magnitude
  const first = Math.floor(low / step) * step
  const last = Math.ceil(high / step) * step

  const ticks: number[] = []
  for (let value = first; value <= last + step / 2; value += step) {
    ticks.push(Math.round(value / step) * step)
  }

  return ticks
}
