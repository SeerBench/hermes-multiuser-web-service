import { describe, expect, it } from 'vitest'
import { BP_MOBILE, isDesktopViewport, isMobileViewport } from './breakpoints'

describe('breakpoints', () => {
  it('classifies mobile below BP_MOBILE', () => {
    expect(isMobileViewport(BP_MOBILE - 1)).toBe(true)
    expect(isDesktopViewport(BP_MOBILE - 1)).toBe(false)
  })

  it('classifies desktop at BP_DESKTOP and above', () => {
    expect(isDesktopViewport(1024)).toBe(true)
    expect(isMobileViewport(1024)).toBe(false)
  })
})
