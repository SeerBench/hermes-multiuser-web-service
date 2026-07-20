import { describe, expect, it, beforeEach } from 'vitest'

import {
  applyFontScale,
  getStoredFontScale,
  setFontScale,
} from './fontScaleStorage'

describe('fontScaleStorage', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-font-scale')
    document.documentElement.style.removeProperty('--chat-font-scale')
    document.documentElement.style.removeProperty('--ui-font-scale')
  })

  it('defaults to md when unset', () => {
    expect(getStoredFontScale()).toBe('md')
  })

  it('persists and applies CSS variables for UI + chat', () => {
    setFontScale('lg')
    expect(getStoredFontScale()).toBe('lg')
    expect(document.documentElement.dataset.fontScale).toBe('lg')
    expect(
      document.documentElement.style.getPropertyValue('--chat-font-scale'),
    ).toBe('1.125')
    expect(
      document.documentElement.style.getPropertyValue('--ui-font-scale'),
    ).toBe('1.125')
  })

  it('applyFontScale updates without persisting unknown', () => {
    applyFontScale('sm')
    expect(
      document.documentElement.style.getPropertyValue('--chat-font-scale'),
    ).toBe('0.875')
    expect(
      document.documentElement.style.getPropertyValue('--ui-font-scale'),
    ).toBe('0.875')
  })
})
