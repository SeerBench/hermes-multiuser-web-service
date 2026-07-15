/** Fired when Settings saves workspace model preferences. */
export const PREFERENCES_UPDATED_EVENT = 'hermes:preferences-updated'

/**
 * Prefer favorite models in the chat picker; fall back to full catalog if empty.
 * Optionally keep the currently selected model visible even if not favorited.
 */
export function filterModelsByFavorites<T extends { id: string }>(
  models: T[],
  favorites: string[] | null | undefined,
  alwaysInclude?: string | null,
): T[] {
  if (!favorites?.length) return models
  const set = new Set(favorites)
  const extra = alwaysInclude?.trim()
  if (extra) set.add(extra)
  const filtered = models.filter((m) => set.has(m.id))
  return filtered.length > 0 ? filtered : models
}

export function notifyPreferencesUpdated() {
  window.dispatchEvent(new CustomEvent(PREFERENCES_UPDATED_EVENT))
}
