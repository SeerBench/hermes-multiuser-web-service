/** Chat keyboard shortcuts and custom-event bridge. */

export type ChatHotkeyAction = 'focus-composer' | 'new-chat'

export type ChatHotkeyHandlers = {
  openHelp: () => void
}

/** True when keystrokes should stay in the focused field. */
export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return Boolean(target.closest('[contenteditable="true"]'))
}

export function dispatchChatHotkey(action: ChatHotkeyAction): void {
  const name =
    action === 'focus-composer' ? 'hermes:focus-composer' : 'hermes:new-chat'
  window.dispatchEvent(new CustomEvent(name))
}

/**
 * Global chat hotkeys (ignored inside editable fields except where noted):
 * - `?` → shortcuts help
 * - `n` → new conversation
 * - `/` → focus composer
 */
export function handleGlobalChatHotkey(
  e: KeyboardEvent,
  handlers: ChatHotkeyHandlers,
): boolean {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return false
  if (isEditableKeyboardTarget(e.target)) return false

  if (e.key === '?') {
    e.preventDefault()
    handlers.openHelp()
    return true
  }
  if (e.key === 'n' || e.key === 'N') {
    e.preventDefault()
    dispatchChatHotkey('new-chat')
    return true
  }
  if (e.key === '/') {
    e.preventDefault()
    dispatchChatHotkey('focus-composer')
    return true
  }
  return false
}
