import { describe, expect, it, beforeEach } from 'vitest'
import {
  getChatWidth,
  getPanelWidth,
  setChatWidth,
  setPanelWidth,
  widthClass,
} from './layoutWidthStorage'

describe('layoutWidthStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults panel and chat to lg', () => {
    expect(getPanelWidth()).toBe('lg')
    expect(getChatWidth()).toBe('lg')
  })

  it('persists full width preference', () => {
    setPanelWidth('full')
    setChatWidth('full')
    expect(getPanelWidth()).toBe('full')
    expect(getChatWidth()).toBe('full')
  })

  it('maps width to max-w-screen-lg vs unconstrained', () => {
    expect(widthClass('lg')).toContain('max-w-screen-lg')
    expect(widthClass('full')).toContain('max-w-none')
  })
})
