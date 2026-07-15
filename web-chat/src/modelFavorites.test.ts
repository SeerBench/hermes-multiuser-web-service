import { describe, expect, it } from 'vitest'

import { filterModelsByFavorites } from './modelFavorites'

describe('filterModelsByFavorites', () => {
  const catalog = [
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
  ]

  it('returns full catalog when favorites empty', () => {
    expect(filterModelsByFavorites(catalog, [])).toEqual(catalog)
    expect(filterModelsByFavorites(catalog, null)).toEqual(catalog)
  })

  it('keeps only favorite ids when present in catalog', () => {
    expect(filterModelsByFavorites(catalog, ['c', 'a'])).toEqual([
      { id: 'a' },
      { id: 'c' },
    ])
  })

  it('falls back to full catalog when no favorite matches', () => {
    expect(filterModelsByFavorites(catalog, ['missing'])).toEqual(catalog)
  })

  it('always includes the active model even if not favorited', () => {
    expect(filterModelsByFavorites(catalog, ['a'], 'b')).toEqual([
      { id: 'a' },
      { id: 'b' },
    ])
  })
})
