import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { LocaleProvider } from '../i18n'
import {
  ShortcutsHelpDialog,
  isEditableKeyboardTarget,
} from './ShortcutsHelpDialog'

function wrap(ui: React.ReactElement) {
  return render(<LocaleProvider>{ui}</LocaleProvider>)
}

describe('isEditableKeyboardTarget', () => {
  it('detects inputs and textareas', () => {
    const input = document.createElement('input')
    const ta = document.createElement('textarea')
    const div = document.createElement('div')
    expect(isEditableKeyboardTarget(input)).toBe(true)
    expect(isEditableKeyboardTarget(ta)).toBe(true)
    expect(isEditableKeyboardTarget(div)).toBe(false)
  })
})

describe('ShortcutsHelpDialog', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('lists send / new chat / focus composer shortcuts', () => {
    wrap(<ShortcutsHelpDialog open onOpenChange={() => {}} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/send|发送/i)).toBeInTheDocument()
    expect(screen.getByText(/new (chat|conversation)|新对话/i)).toBeInTheDocument()
    expect(screen.getByText(/focus|聚焦/i)).toBeInTheDocument()
  })

  it('uses a modal dialog (Radix focus trap)', () => {
    wrap(<ShortcutsHelpDialog open onOpenChange={() => {}} />)
    const dialog = screen.getByRole('dialog')
    // Radix DialogContent sets role=dialog; focus trap is built-in.
    expect(dialog).toHaveAttribute('data-slot', 'dialog-content')
  })
})

describe('chat hotkey events', () => {
  it('dispatches focus and new-chat custom events from helpers', async () => {
    const { dispatchChatHotkey } = await import('../chatHotkeys')
    const focus = vi.fn()
    const neu = vi.fn()
    window.addEventListener('hermes:focus-composer', focus)
    window.addEventListener('hermes:new-chat', neu)
    dispatchChatHotkey('focus-composer')
    dispatchChatHotkey('new-chat')
    expect(focus).toHaveBeenCalled()
    expect(neu).toHaveBeenCalled()
    window.removeEventListener('hermes:focus-composer', focus)
    window.removeEventListener('hermes:new-chat', neu)
  })

  it('opens help when ? is pressed outside editable fields', async () => {
    const { handleGlobalChatHotkey } = await import('../chatHotkeys')
    const openHelp = vi.fn()
    const ev = new KeyboardEvent('keydown', { key: '?', bubbles: true })
    Object.defineProperty(ev, 'target', { value: document.body })
    handleGlobalChatHotkey(ev, { openHelp })
    expect(openHelp).toHaveBeenCalled()
  })

  it('ignores ? while typing in a textarea', async () => {
    const { handleGlobalChatHotkey } = await import('../chatHotkeys')
    const openHelp = vi.fn()
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    const ev = new KeyboardEvent('keydown', { key: '?', bubbles: true })
    Object.defineProperty(ev, 'target', { value: ta })
    handleGlobalChatHotkey(ev, { openHelp })
    expect(openHelp).not.toHaveBeenCalled()
    fireEvent.keyDown(ta, { key: '?' })
  })
})
