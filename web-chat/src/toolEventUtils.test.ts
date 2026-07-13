import { describe, expect, it } from 'vitest'

import { extractImageUrl, prettyJson } from './toolEventUtils'

describe('prettyJson', () => {
  it('pretty-prints valid JSON', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}')
  })

  it('returns input when not JSON', () => {
    expect(prettyJson('not-json')).toBe('not-json')
  })
})

describe('extractImageUrl', () => {
  it('returns null for non-image_generate tools', () => {
    expect(
      extractImageUrl('web_search', '{"success":true,"image":"https://x.com/a.png"}'),
    ).toBeNull()
  })

  it('extracts URL from successful image_generate result', () => {
    const result = JSON.stringify({
      success: true,
      image: 'https://cdn.example.com/pic.png',
    })
    expect(extractImageUrl('image_generate', result)).toBe(
      'https://cdn.example.com/pic.png',
    )
  })

  it('falls back to regex when JSON is truncated', () => {
    const truncated = '{"success":true,"image":"https://cdn.example.com/x.jpg"'
    expect(extractImageUrl('image_generate', truncated)).toBe(
      'https://cdn.example.com/x.jpg',
    )
  })

  it('rejects non-http URLs', () => {
    const result = JSON.stringify({ success: true, image: 'javascript:alert(1)' })
    expect(extractImageUrl('image_generate', result)).toBeNull()
  })
})
