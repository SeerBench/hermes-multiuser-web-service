import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { formatBytes, timeAgo } from './format'
import { translate } from './i18n'

describe('formatBytes', () => {
  it('formats sub-kilobyte sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
  })

  it('formats kilobytes and megabytes', () => {
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('guards invalid input', () => {
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})

describe('timeAgo', () => {
  const t = (key: string, vars?: Record<string, string | number>) =>
    translate('en', key, vars)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('labels recent timestamps', () => {
    const now = Date.now() / 1000
    expect(timeAgo(now - 30, t)).toBe('just now')
    expect(timeAgo(now - 120, t)).toBe('2m ago')
    expect(timeAgo(now - 7200, t)).toBe('2h ago')
    expect(timeAgo(now - 86_400, t)).toBe('1d ago')
  })

  it('falls back to absolute date after 30 days', () => {
    const ts = Date.now() / 1000 - 40 * 86_400
    expect(timeAgo(ts, t)).toMatch(/2026/)
  })
})
