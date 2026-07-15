import { describe, expect, it } from 'vitest'

import { conversationToMarkdown } from './conversationShare'
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
