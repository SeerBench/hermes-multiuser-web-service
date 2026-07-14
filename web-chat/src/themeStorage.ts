export type ThemePreference = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'hermes_theme'

export function getStoredTheme(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    // ignore
  }
  return 'system'
}

export function storeTheme(theme: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // ignore
  }
}

/** Apply theme classes on ``<html>``. ``system`` clears forced classes. */
export function applyTheme(theme: ThemePreference): void {
  const root = document.documentElement
  root.classList.remove('light', 'dark')
  if (theme === 'light') {
    root.classList.add('light')
    root.style.colorScheme = 'light'
  } else if (theme === 'dark') {
    root.classList.add('dark')
    root.style.colorScheme = 'dark'
  } else {
    root.style.colorScheme = ''
  }
}

export function initTheme(): ThemePreference {
  const theme = getStoredTheme()
  applyTheme(theme)
  return theme
}

export function setTheme(theme: ThemePreference): void {
  storeTheme(theme)
  applyTheme(theme)
}
