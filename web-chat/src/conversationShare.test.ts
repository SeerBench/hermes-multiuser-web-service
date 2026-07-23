import { describe, expect, it } from 'vitest'

import {
  absoluteShareUrl,
  conversationToMarkdown,
  turnsToSharePayload,
} from './conversationShare'
import type { Turn } from './chatTurns'

describe('conversationToMarkdown', () => {
  it('formats titled conversation with roles', () => {
    const turns: Turn[] = [
      {
        id: '1',
        role: 'user',
        status: 'done',
        segments: [{ kind: 'text', text: '你好' }],
        activity: [],
      },
      {
        id: '2',
        role: 'assistant',
        status: 'done',
        segments: [{ kind: 'text', text: '你好！' }],
        activity: [],
      },
    ]
    const md = conversationToMarkdown(turns, { title: '测试' })
    expect(md).toContain('# 测试')
    expect(md).toContain('## User')
    expect(md).toContain('你好')
    expect(md).toContain('## Assistant')
    expect(md).toContain('你好！')
  })

  it('skips empty errored turns', () => {
    const turns: Turn[] = [
      {
        id: 'e',
        role: 'assistant',
        status: 'error',
        segments: [],
        activity: [],
        errorMessage: 'boom',
      },
    ]
    expect(conversationToMarkdown(turns)).toBe('')
  })
})

describe('turnsToSharePayload', () => {
  it('keeps only user/assistant text', () => {
    const turns: Turn[] = [
      {
        id: '1',
        role: 'user',
        status: 'done',
        segments: [{ kind: 'text', text: 'Q' }],
        activity: [],
      },
      {
        id: '2',
        role: 'assistant',
        status: 'done',
        segments: [
          { kind: 'text', text: 'A' },
          {
            kind: 'tool',
            id: 't1',
            tool: 'web_search',
            preview: 'secret path',
            args: '{}',
          },
        ],
        activity: [],
      },
    ]
    expect(turnsToSharePayload(turns)).toEqual([
      { role: 'user', text: 'Q' },
      { role: 'assistant', text: 'A' },
    ])
  })
})

describe('absoluteShareUrl', () => {
  it('joins origin with hash share path', () => {
    const url = absoluteShareUrl('#/share/abc123')
    expect(url).toContain('#/share/abc123')
    expect(url.startsWith('http')).toBe(true)
  })
})
