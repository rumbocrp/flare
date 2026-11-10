import { useEffect } from "react"
import type { ThemeSetting } from "../types"

function resolveTheme(
  setting: ThemeSetting,
  prefersLight: boolean,
): 'dark' | 'light' {
  if (setting === 'system') return prefersLight ? 'light' : 'dark'
  return setting
}

export function useTheme(setting: ThemeSetting) {
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: light)')

    function apply() {
      document.documentElement.dataset.theme = resolveTheme(
        setting,
        query.matches,
      )
    }

    apply()

    if (setting !== 'system') return undefined

    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [setting])
}
