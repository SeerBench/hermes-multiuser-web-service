import { describe, expect, it } from 'vitest'

import { interpolate, translate } from './i18n'

describe('i18n translate', () => {
  it('interpolates variables', () => {
    expect(interpolate('Hello {name}', { name: 'Hermes' })).toBe('Hello Hermes')
    expect(interpolate('Step {n}', { n: 3 })).toBe('Step 3')
  })

  it('keeps unknown placeholders', () => {
    expect(interpolate('Hi {missing}', {})).toBe('Hi {missing}')
  })

  it('resolves english keys', () => {
    expect(translate('en', 'nav.chat')).toBe('Chat')
    expect(translate('en', 'convo.timeago.minutes', { n: 5 })).toBe('5m ago')
  })

  it('resolves chinese keys', () => {
    expect(translate('zh', 'nav.chat')).toBe('对话')
  })

  it('falls back to english then key', () => {
    expect(translate('zh', 'nav.chat')).toBeTruthy()
    expect(translate('en', 'nonexistent.key.xyz')).toBe('nonexistent.key.xyz')
  })
})
