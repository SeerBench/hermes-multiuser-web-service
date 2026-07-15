import { describe, expect, it, beforeEach } from 'vitest'
import {
  getChatWidth,
  getPanelWidth,
  setChatWidth,
  setPanelWidth,
  toggleExpanded,
  widthClass,
} from './layoutWidthStorage'

describe('layoutWidthStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults chat to reading and panel to density when unset', () => {
    expect(getChatWidth()).toBe('reading')
    expect(getPanelWidth('wide')).toBe('wide')
    expect(getPanelWidth('reading')).toBe('reading')
  })

  it('treats legacy lg as not expanded (density applies)', () => {
    localStorage.setItem('hermes_chat_width', 'lg')
    expect(getChatWidth()).toBe('reading')
  })

  it('persists full width preference', () => {
    setPanelWidth('full')
    setChatWidth('full')
    expect(getPanelWidth('wide')).toBe('full')
    expect(getChatWidth()).toBe('full')
  })

  it('clears expansion when set back to density', () => {
    setPanelWidth('full')
    setPanelWidth('wide')
    expect(getPanelWidth('wide')).toBe('wide')
  })

  it('maps width classes for reading / wide / full', () => {
    expect(widthClass('reading')).toContain('max-w-screen-xl')
    expect(widthClass('wide')).toContain('max-w-7xl')
    expect(widthClass('full')).toContain('max-w-none')
  })

  it('toggles expanded vs density standard', () => {
    expect(toggleExpanded('wide', 'wide')).toBe('full')
    expect(toggleExpanded('wide', 'full')).toBe('wide')
    expect(toggleExpanded('reading', 'full')).toBe('reading')
  })
})
