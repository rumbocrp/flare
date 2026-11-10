import type { AppSettings, ThemeSetting } from "./types";

export const defaultSettings: AppSettings = {
  theme: 'dark'
}

const themes: ThemeSetting[] = ['dark', 'light', 'system']

export function isAppSettings(value: unknown): value is AppSettings {
  if (typeof value !== 'object' || value === null) return false

  const theme = (value as { theme?: unknown }).theme
  return typeof theme === 'string' && themes.includes(theme as ThemeSetting)
}
