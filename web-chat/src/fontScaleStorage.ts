/** UI + chat font size preference (local). */

export type FontScale = 'sm' | 'md' | 'lg'

const STORAGE_KEY = 'hermes_font_scale'

const SCALES: Record<FontScale, string> = {
  sm: '0.875',
  md: '1',
  lg: '1.125',
}

export function getStoredFontScale(): FontScale {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'sm' || raw === 'md' || raw === 'lg') return raw
  } catch {
    // ignore
  }
  return 'md'
}

export function storeFontScale(scale: FontScale): void {
  try {
    localStorage.setItem(STORAGE_KEY, scale)
  } catch {
    // ignore
  }
}

/**
 * Apply scale on ``<html>``:
 * - ``--ui-font-scale`` — nav / titles / menus / body
 * - ``--chat-font-scale`` — chat column (kept for existing selectors)
 */
export function applyFontScale(scale: FontScale): void {
  const root = document.documentElement
  const value = SCALES[scale]
  root.dataset.fontScale = scale
  root.style.setProperty('--ui-font-scale', value)
  root.style.setProperty('--chat-font-scale', value)
}

export function initFontScale(): FontScale {
  const scale = getStoredFontScale()
  applyFontScale(scale)
  return scale
}

export function setFontScale(scale: FontScale): void {
  storeFontScale(scale)
  applyFontScale(scale)
}
