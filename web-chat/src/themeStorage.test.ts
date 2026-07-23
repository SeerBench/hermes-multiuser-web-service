import { beforeEach, describe, expect, it } from 'vitest'

import {
  applyTheme,
  getStoredTheme,
  setTheme,
  storeTheme,
} from './themeStorage'

describe('themeStorage', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('light', 'dark')
    document.documentElement.style.colorScheme = ''
  })

  it('defaults to system', () => {
    expect(getStoredTheme()).toBe('system')
  })

  it('persists and applies light', () => {
    setTheme('light')
    expect(getStoredTheme()).toBe('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('persists and applies dark', () => {
    storeTheme('dark')
    applyTheme('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('system clears forced classes', () => {
    setTheme('dark')
    setTheme('system')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.classList.contains('light')).toBe(false)
  })
})
