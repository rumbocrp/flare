import { useEffect } from 'react'
import type { AccentPreset, DensitySetting, ThemeSetting } from '../types'

function resolveTheme(
  setting: ThemeSetting,
  prefersLight: boolean,
): 'dark' | 'light' {
  if (setting === 'system') return prefersLight ? 'light' : 'dark'
  return setting
}

export function useTheme(
  setting: ThemeSetting,
  options?: {
    accentPreset?: AccentPreset
    density?: DensitySetting
    reducedMotion?: boolean
  },
) {
  const accent = options?.accentPreset ?? 'amber'
  const density = options?.density ?? 'comfortable'
  const reducedMotion = options?.reducedMotion ?? false

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: light)')

    function apply() {
      const root = document.documentElement
      const resolved = resolveTheme(setting, query.matches)
      root.dataset.theme = resolved
      root.classList.toggle('dark', resolved === 'dark')
      root.dataset.accent = accent
      root.dataset.density = density
      root.dataset.motion = reducedMotion ? 'reduced' : 'default'
    }

    apply()

    if (setting !== 'system') return undefined

    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [setting, accent, density, reducedMotion])
}
