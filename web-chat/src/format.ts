// Small shared formatting helpers used across chat components.
import type { Translator } from './i18n'

/** Human-readable byte size: 12 B / 3.4 KB / 1.2 MB. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Relative time-ago label, falling back to an absolute date past 30 days. */
export function timeAgo(ts: number, t: Translator): string {
  const now = Date.now() / 1000
  const dt = Math.max(0, now - ts)
  if (dt < 60) return t('convo.timeago.just_now')
  if (dt < 3600) return t('convo.timeago.minutes', { n: Math.floor(dt / 60) })
  if (dt < 86_400) return t('convo.timeago.hours', { n: Math.floor(dt / 3600) })
  const days = Math.floor(dt / 86_400)
  if (days < 30) return t('convo.timeago.days', { n: days })
  return new Date(ts * 1000).toLocaleDateString()
}
