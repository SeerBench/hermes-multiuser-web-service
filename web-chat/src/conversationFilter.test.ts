import { describe, expect, it } from 'vitest'

import type { ConversationSummary } from './api'
import { filterConversations } from './conversationFilter'

const base = (overrides: Partial<ConversationSummary>): ConversationSummary => ({
  id: '1',
  title: null,
  preview: '',
  started_at: 0,
  last_active: 0,
  message_count: 0,
  ...overrides,
})

describe('filterConversations', () => {
  it('returns all when query is empty', () => {
    const list = [base({ id: 'a', title: 'Hello' })]
    expect(filterConversations(list, '')).toHaveLength(1)
    expect(filterConversations(list, '   ')).toHaveLength(1)
  })

  it('matches title and preview case-insensitively', () => {
    const list = [
      base({ id: 'a', title: 'Project Alpha' }),
      base({ id: 'b', preview: 'notes about beta' }),
      base({ id: 'c', title: 'Other' }),
    ]
    expect(filterConversations(list, 'alpha').map((c) => c.id)).toEqual(['a'])
    expect(filterConversations(list, 'BETA').map((c) => c.id)).toEqual(['b'])
  })
})
