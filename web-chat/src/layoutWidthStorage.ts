/**
 * Content column width: density (reading/wide) + optional full-bleed preference.
 */

export type LayoutDensity = 'reading' | 'wide'
export type LayoutWidth = 'reading' | 'wide' | 'full'

const PANEL_KEY = 'hermes_panel_width'
const CHAT_KEY = 'hermes_chat_width'

function isFull(raw: string | null): boolean {
  return raw === 'full'
}

function readExpanded(key: string): boolean {
  try {
    return isFull(localStorage.getItem(key))
  } catch {
    return false
  }
}

function writeExpanded(key: string, expanded: boolean): void {
  try {
    if (expanded) localStorage.setItem(key, 'full')
    else localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

/** Effective panel width for a page density. */
export function getPanelWidth(density: LayoutDensity = 'wide'): LayoutWidth {
  return readExpanded(PANEL_KEY) ? 'full' : density
}

export function setPanelWidth(value: LayoutWidth): void {
  writeExpanded(PANEL_KEY, value === 'full')
}

export function getChatWidth(): LayoutWidth {
  return readExpanded(CHAT_KEY) ? 'full' : 'reading'
}

export function setChatWidth(value: LayoutWidth): void {
  writeExpanded(CHAT_KEY, value === 'full')
}

export function toggleExpanded(
  density: LayoutDensity,
  current: LayoutWidth,
): LayoutWidth {
  return current === 'full' ? density : 'full'
}

/** Tailwind classes for the content column. */
export function widthClass(width: LayoutWidth | 'lg'): string {
  const w = width === 'lg' ? 'reading' : width
  if (w === 'full') return 'w-full max-w-none'
  if (w === 'wide') return 'mx-auto w-full max-w-7xl'
  return 'mx-auto w-full max-w-screen-xl'
}
