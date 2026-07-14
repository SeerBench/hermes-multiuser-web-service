const ONBOARDING_PREFIX = 'hermes_onboarding_done:'

export function onboardingStorageKey(userId: string): string {
  return `${ONBOARDING_PREFIX}${userId}`
}

export function isOnboardingComplete(userId: string): boolean {
  try {
    return localStorage.getItem(onboardingStorageKey(userId)) === '1'
  } catch {
    return false
  }
}

export function markOnboardingComplete(userId: string): void {
  try {
    localStorage.setItem(onboardingStorageKey(userId), '1')
  } catch {
    // ignore
  }
}

export function resetOnboarding(userId: string): void {
  try {
    localStorage.removeItem(onboardingStorageKey(userId))
  } catch {
    // ignore
  }
}
