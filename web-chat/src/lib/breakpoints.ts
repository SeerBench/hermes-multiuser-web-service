/** Responsive breakpoints shared across the SPA shell. */

export const BP_MOBILE = 768
export const BP_DESKTOP = 1024

export function isMobileViewport(width = window.innerWidth): boolean {
  return width < BP_MOBILE
}

export function isDesktopViewport(width = window.innerWidth): boolean {
  return width >= BP_DESKTOP
}

export function subscribeViewport(
  onChange: (mobile: boolean) => void,
): () => void {
  const mq = window.matchMedia(`(max-width: ${BP_MOBILE - 1}px)`)
  const handler = () => onChange(mq.matches)
  handler()
  mq.addEventListener('change', handler)
  return () => mq.removeEventListener('change', handler)
}
