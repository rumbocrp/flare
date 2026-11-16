import type { AppSettings, Language, ThemeSetting } from './types'

export const defaultSettings: AppSettings = {
  theme: 'dark',
  language: 'en',
}

const themes: ThemeSetting[] = ['dark', 'light', 'system']
const languages: Language[] = ['en', 'es']

export function isAppSettings(value: unknown): value is AppSettings {
  if (typeof value !== 'object' || value === null) return false

  const theme = (value as { theme?: unknown }).theme
  const language = (value as { language?: unknown }).language

  return (
    typeof theme === 'string' &&
    themes.includes(theme as ThemeSetting) &&
    (language === undefined || languages.includes(language as Language))
  )
}
