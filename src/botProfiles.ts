import {
  mergePresetPatch,
  STRATEGY_PRESETS,
  type StrategyPreset,
} from './botEngine'

export const CUSTOM_PROFILES_STORAGE_KEY = 'flare:custom-bot-profiles'
const MAX_CUSTOM_PROFILES = 24

export type SavedBotProfile = {
  id: string
  savedAt: string
  preset: StrategyPreset
}

export function loadCustomBotProfiles(): SavedBotProfile[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return []
    const raw = window.localStorage.getItem(CUSTOM_PROFILES_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []

    const out: SavedBotProfile[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const candidate = item as Record<string, unknown>
      if (
        typeof candidate.id !== 'string' ||
        typeof candidate.preset !== 'object' ||
        candidate.preset === null
      ) {
        continue
      }
      const rawPreset = candidate.preset as Partial<StrategyPreset>
      const base =
        STRATEGY_PRESETS.find((p) => p.id === rawPreset.id) ??
        STRATEGY_PRESETS[1]
      out.push({
        id: candidate.id,
        savedAt:
          typeof candidate.savedAt === 'string'
            ? candidate.savedAt
            : new Date().toISOString(),
        preset: {
          ...mergePresetPatch(base, rawPreset),
          id:
            typeof rawPreset.id === 'string' && rawPreset.id.trim().length > 0
              ? rawPreset.id
              : candidate.id,
        },
      })
    }
    return out.slice(0, MAX_CUSTOM_PROFILES)
  } catch {
    return []
  }
}

export function saveCustomBotProfiles(profiles: SavedBotProfile[]): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(
      CUSTOM_PROFILES_STORAGE_KEY,
      JSON.stringify(profiles.slice(0, MAX_CUSTOM_PROFILES)),
    )
  } catch {
    // Ignore storage quota / privacy errors
  }
}

export function clearCustomBotProfiles(): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.removeItem(CUSTOM_PROFILES_STORAGE_KEY)
  } catch {
    // Ignore storage access errors
  }
}

export function upsertCustomBotProfile(
  preset: StrategyPreset,
  profileName: string,
): SavedBotProfile[] {
  const existing = loadCustomBotProfiles()
  const cleanedName = profileName.trim().slice(0, 90) || preset.name
  const slug = cleanedName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36)
  const id = `custom-${slug || Date.now().toString(36)}`
  const entry: SavedBotProfile = {
    id,
    savedAt: new Date().toISOString(),
    preset: {
      ...preset,
      name: cleanedName,
    },
  }
  const next = [entry, ...existing.filter((p) => p.id !== id)].slice(
    0,
    MAX_CUSTOM_PROFILES,
  )
  saveCustomBotProfiles(next)
  return next
}

export function deleteCustomBotProfile(id: string): SavedBotProfile[] {
  const next = loadCustomBotProfiles().filter((p) => p.id !== id)
  saveCustomBotProfiles(next)
  return next
}

/**
 * Plays a short, crisp institutional chime via Web Audio API when testing
 * or triggering sound alerts in Settings (no external audio assets required).
 */
export function playAlertChime(): boolean {
  try {
    if (typeof window === 'undefined') return false
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!AudioCtx) return false
    const ctx = new AudioCtx()
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(660, now)
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.11)
    gain.gain.setValueAtTime(0.001, now)
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.24)
    setTimeout(() => {
      void ctx.close().catch(() => {})
    }, 320)
    return true
  } catch {
    return false
  }
}
