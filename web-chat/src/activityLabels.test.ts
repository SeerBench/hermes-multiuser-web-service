import { describe, expect, it } from 'vitest'

import { activityItemLabel } from './activityLabels'
import { translate } from './i18n'

const t = (key: string, vars?: Record<string, string | number>) =>
  translate('en', key, vars)

describe('activityItemLabel', () => {
  it('formats step with tools', () => {
    const label = activityItemLabel(t, {
      kind: 'step',
      step: 2,
      tools: ['web_search', 'read_file'],
      ts: 0,
    })
    expect(label).toContain('2')
    expect(label).toContain('web_search')
  })

  it('formats thinking hint', () => {
    const label = activityItemLabel(t, {
      kind: 'thinking',
      text: 'planning',
      ts: 0,
    })
    expect(label).toContain('planning')
  })

  it('returns status text as-is', () => {
    expect(
      activityItemLabel(t, { kind: 'status', text: 'Running…', ts: 0 }),
    ).toBe('Running…')
  })
})
