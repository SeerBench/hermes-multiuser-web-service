import { describe, expect, it } from 'vitest'

import {
  SKILL_DESCRIPTIONS_ZH,
  skillDisplayDescription,
} from './skillDescriptions.zh'

describe('skillDisplayDescription', () => {
  it('returns Chinese overlay for zh locale', () => {
    expect(skillDisplayDescription('zh', 'arxiv', 'Search papers')).toMatch(
      /arXiv/,
    )
    expect(skillDisplayDescription('zh', 'arxiv', 'Search papers')).not.toBe(
      'Search papers',
    )
  })

  it('keeps English fallback for en locale', () => {
    expect(skillDisplayDescription('en', 'arxiv', 'Search papers')).toBe(
      'Search papers',
    )
  })

  it('falls back when zh mapping is missing', () => {
    expect(skillDisplayDescription('zh', 'unknown-skill', 'Hello')).toBe(
      'Hello',
    )
  })

  it('covers the global catalog name set', () => {
    expect(Object.keys(SKILL_DESCRIPTIONS_ZH).length).toBeGreaterThanOrEqual(80)
    expect(SKILL_DESCRIPTIONS_ZH.arxiv).toBeTruthy()
    expect(SKILL_DESCRIPTIONS_ZH.yuanbao).toBeTruthy()
  })
})
