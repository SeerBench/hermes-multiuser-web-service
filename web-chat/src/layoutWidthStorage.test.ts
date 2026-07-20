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

  it('maps width classes to content-column / full bleed', () => {
    expect(widthClass('reading')).toBe('content-column')
    expect(widthClass('wide')).toBe('content-column')
    expect(widthClass('full')).toBe('content-column content-column--full')
  })

  it('toggles expanded vs density standard', () => {
    expect(toggleExpanded('wide', 'wide')).toBe('full')
    expect(toggleExpanded('wide', 'full')).toBe('wide')
    expect(toggleExpanded('reading', 'full')).toBe('reading')
  })
})
