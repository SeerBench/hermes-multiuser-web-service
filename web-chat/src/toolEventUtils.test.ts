import { describe, expect, it } from 'vitest'

import {
  collectTurnSearchHits,
  extractImageUrl,
  extractWebSearchSummary,
  faviconUrlForSite,
  formatSearchStatusMessage,
  prettyJson,
  summarizeTurnWebSearchConsumption,
} from './toolEventUtils'

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

describe('extractWebSearchSummary', () => {
  it('returns null for non-web_search tools', () => {
    expect(extractWebSearchSummary('web_file_read', '{}')).toBeNull()
  })

  it('extracts backend and urls from result json', () => {
    const result = JSON.stringify({
      success: true,
      data: {
        web: [{ title: 'A', url: 'https://a.example', description: 'd' }],
      },
      _meta: {
        backend: 'brave-free',
        brave_remaining: 4,
        urls: ['https://a.example'],
        url_count: 1,
      },
    })
    const summary = extractWebSearchSummary('web_search', result)
    expect(summary?.backend).toBe('brave-free')
    expect(summary?.backendLabel).toBe('Brave')
    expect(summary?.resultCount).toBe(1)
    expect(summary?.urls[0]?.url).toBe('https://a.example')
    expect(summary?.braveRemaining).toBe(4)
  })

  it('prefers search_meta from sse when provided', () => {
    const summary = extractWebSearchSummary('web_search', undefined, {
      backend: 'ddgs',
      urls: ['https://b.example'],
      url_count: 1,
    })
    expect(summary?.backendLabel).toBe('DuckDuckGo')
    expect(summary?.urls[0]?.url).toBe('https://b.example')
  })
})

describe('formatSearchStatusMessage', () => {
  it('formats Brave remaining quota', () => {
    expect(
      formatSearchStatusMessage({
        backend: 'brave-free',
        brave_remaining: 3,
      }),
    ).toBe('使用 Brave 搜索，Brave 用量还剩 3 次')
  })

  it('formats ddgs after Brave quota exhausted', () => {
    expect(
      formatSearchStatusMessage({
        backend: 'ddgs',
        fallback_reason: 'brave_quota_exhausted',
      }),
    ).toContain('Brave 额度已用完')
  })
})

describe('collectTurnSearchHits + favicon', () => {
  it('dedupes urls across web_search segments', () => {
    const hits = collectTurnSearchHits([
      {
        kind: 'tool',
        tool: 'web_search',
        search_meta: {
          backend: 'brave-free',
          urls: ['https://a.example/1', 'https://b.example/2'],
        },
      },
      {
        kind: 'tool',
        tool: 'web_search',
        search_meta: {
          backend: 'ddgs',
          urls: ['https://b.example/2', 'https://c.example/3'],
        },
      },
      { kind: 'text' },
    ])
    expect(hits.map((h) => h.url)).toEqual([
      'https://a.example/1',
      'https://b.example/2',
      'https://c.example/3',
    ])
  })

  it('builds favicon url from page host', () => {
    expect(faviconUrlForSite('https://news.example.com/path')).toContain(
      'domain=news.example.com',
    )
  })
})

describe('summarizeTurnWebSearchConsumption', () => {
  it('returns null when no web_search', () => {
    expect(
      summarizeTurnWebSearchConsumption([
        { kind: 'text', text: 'hi' },
        { kind: 'tool', tool: 'web_file_read', preview: '', args: '' },
      ]),
    ).toBeNull()
  })

  it('counts brave and ddgs searches once per tool segment', () => {
    const summary = summarizeTurnWebSearchConsumption([
      {
        kind: 'tool',
        tool: 'web_search',
        preview: '',
        args: '',
        duration: 1,
        search_meta: {
          backend: 'brave-free',
          brave_remaining: 2,
          urls: ['https://a.example'],
        },
      },
      {
        kind: 'tool',
        tool: 'web_search',
        preview: '',
        args: '',
        duration: 1,
        search_meta: {
          backend: 'ddgs',
          urls: ['https://b.example'],
        },
      },
      { kind: 'text', text: 'answer' },
    ])
    expect(summary).toEqual({
      total: 2,
      brave: 1,
      ddgs: 1,
      braveRemaining: 2,
    })
  })

  it('skips errored web_search segments', () => {
    expect(
      summarizeTurnWebSearchConsumption([
        {
          kind: 'tool',
          tool: 'web_search',
          preview: '',
          args: '',
          duration: 1,
          error: true,
          search_meta: { backend: 'brave-free', urls: [] },
        },
      ]),
    ).toBeNull()
  })
})
