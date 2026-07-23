import { describe, expect, it, beforeEach } from 'vitest'

import {
  isOnboardingComplete,
  markOnboardingComplete,
  onboardingStorageKey,
  resetOnboarding,
} from './onboardingStorage'

describe('onboardingStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('tracks completion per user', () => {
    expect(isOnboardingComplete('u1')).toBe(false)
    markOnboardingComplete('u1')
    expect(isOnboardingComplete('u1')).toBe(true)
    expect(isOnboardingComplete('u2')).toBe(false)
    expect(localStorage.getItem(onboardingStorageKey('u1'))).toBe('1')
  })

  it('reset clears completion', () => {
    markOnboardingComplete('u1')
    resetOnboarding('u1')
    expect(isOnboardingComplete('u1')).toBe(false)
  })
})
