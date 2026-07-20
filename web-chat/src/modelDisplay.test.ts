import { describe, expect, it } from 'vitest'

import { modelBadges, modelBrand, modelDisplayName } from './modelDisplay'

describe('modelDisplayName', () => {
  it('title-cases vendor and product segments', () => {
    expect(modelDisplayName('deepseek-v4-pro')).toBe('DeepSeek V4 Pro')
    expect(modelDisplayName('claude-sonnet-4.6')).toBe('Claude Sonnet 4.6')
    expect(modelDisplayName('gpt-5.6-sol')).toBe('GPT 5.6 Sol')
  })
})

describe('modelBadges', () => {
  it('marks Pro from id segments', () => {
    expect(modelBadges('deepseek-v4-pro').map((b) => b.kind)).toContain('pro')
    expect(modelBadges('claude-opus-4.8-pro').map((b) => b.kind)).toContain('pro')
  })

  it('marks New for recent major lines', () => {
    const kinds = modelBadges('gpt-5.6-sol-pro').map((b) => b.kind)
    expect(kinds).toContain('new')
    expect(kinds).toContain('pro')
  })

  it('skips badges for plain models', () => {
    expect(modelBadges('claude-haiku-4.5')).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'new' })]),
    )
    expect(modelBadges('gpt-4o-mini')).toEqual([])
  })
})

describe('modelBrand', () => {
  it('maps known vendors to colors and marks', () => {
    expect(modelBrand('deepseek-v4-flash').key).toBe('deepseek')
    expect(modelBrand('claude-sonnet-5').key).toBe('claude')
    expect(modelBrand('gpt-5.6-terra').key).toBe('openai')
  })
})
