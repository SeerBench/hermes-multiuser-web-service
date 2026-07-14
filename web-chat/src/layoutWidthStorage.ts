/** Panel / chat content width preference (constrained vs full-bleed). */

export type LayoutWidth = 'lg' | 'full'

const PANEL_KEY = 'hermes_panel_width'
const CHAT_KEY = 'hermes_chat_width'

function read(key: string, fallback: LayoutWidth): LayoutWidth {
  try {
    const raw = localStorage.getItem(key)
    if (raw === 'lg' || raw === 'full') return raw
  } catch {
    // ignore
  }
  return fallback
}

function write(key: string, value: LayoutWidth): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

export function getPanelWidth(): LayoutWidth {
  return read(PANEL_KEY, 'lg')
}

export function setPanelWidth(value: LayoutWidth): void {
  write(PANEL_KEY, value)
}

export function getChatWidth(): LayoutWidth {
  return read(CHAT_KEY, 'lg')
}

export function setChatWidth(value: LayoutWidth): void {
  write(CHAT_KEY, value)
}

/** Tailwind classes for the constrained content column. */
export function widthClass(width: LayoutWidth): string {
  return width === 'full'
    ? 'w-full max-w-none'
    : 'mx-auto w-full max-w-screen-lg'
}
