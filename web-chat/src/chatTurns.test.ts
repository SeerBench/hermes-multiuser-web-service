import { describe, expect, it } from 'vitest'

import type { ServerMessage } from './api'
import {
  attachmentNote,
  messagesToTurns,
  newTurnId,
  turnToCopyText,
  type Turn,
} from './chatTurns'
import { translate } from './i18n'

const t = (key: string, vars?: Record<string, string | number>) =>
  translate('en', key, vars)

describe('newTurnId', () => {
  it('returns a non-empty string', () => {
    expect(newTurnId()).toMatch(/^[0-9a-f-]+|t-/)
  })
})

describe('messagesToTurns', () => {
  it('returns empty array for no messages', () => {
    expect(messagesToTurns([])).toEqual([])
  })

  it('maps user messages to user turns', () => {
    const msgs: ServerMessage[] = [
      {
        id: 1,
        role: 'user',
        content: 'hello',
        tool_calls: [],
        tool_call_id: null,
        tool_name: null,
        reasoning: null,
        timestamp: null,
      },
    ]
    const turns = messagesToTurns(msgs)
    expect(turns).toHaveLength(1)
    expect(turns[0].role).toBe('user')
    expect(turns[0].segments).toEqual([{ kind: 'text', text: 'hello' }])
  })

  it('merges assistant content and tool calls with results', () => {
    const msgs: ServerMessage[] = [
      {
        id: 1,
        role: 'assistant',
        content: 'working',
        reasoning: 'think',
        tool_calls: [
          {
            id: 'tc1',
            function: { name: 'web_search', arguments: '{"q":"test"}' },
          },
        ],
        tool_call_id: null,
        tool_name: null,
        timestamp: null,
      },
      {
        id: 2,
        role: 'tool',
        content: 'search results',
        tool_call_id: 'tc1',
        tool_calls: [],
        tool_name: 'web_search',
        reasoning: null,
        timestamp: null,
      },
    ]
    const turns = messagesToTurns(msgs)
    expect(turns).toHaveLength(1)
    expect(turns[0].role).toBe('assistant')
    expect(turns[0].reasoning).toBe('think')
    const toolSeg = turns[0].segments.find((s) => s.kind === 'tool')
    expect(toolSeg).toMatchObject({
      tool: 'web_search',
      result_preview: 'search results',
    })
  })

  it('restores Brave search_meta and activity from tool _meta', () => {
    const toolBody = JSON.stringify({
      success: true,
      data: { web: [{ title: 'X', url: 'https://x.example' }] },
      _meta: {
        backend: 'brave-free',
        brave_remaining: 1,
        urls: ['https://x.example'],
        url_count: 1,
      },
    })
    const msgs: ServerMessage[] = [
      {
        id: 1,
        role: 'assistant',
        content: 'done',
        reasoning: null,
        tool_calls: [
          {
            id: 'tc1',
            function: { name: 'web_search', arguments: '{}' },
          },
        ],
        tool_call_id: null,
        tool_name: null,
        timestamp: null,
      },
      {
        id: 2,
        role: 'tool',
        content: toolBody,
        tool_call_id: 'tc1',
        tool_calls: [],
        tool_name: 'web_search',
        reasoning: null,
        timestamp: null,
      },
    ]
    const turns = messagesToTurns(msgs)
    const toolSeg = turns[0].segments.find((s) => s.kind === 'tool')
    expect(toolSeg && toolSeg.kind === 'tool' && toolSeg.search_meta).toMatchObject({
      backend: 'brave-free',
      brave_remaining: 1,
    })
    expect(turns[0].activity.some((a) => a.kind === 'status' && a.text.includes('Brave'))).toBe(
      true,
    )
  })

  it('splits consecutive user messages into separate turns', () => {
    const mkUser = (content: string): ServerMessage => ({
      id: null,
      role: 'user',
      content,
      tool_calls: [],
      tool_call_id: null,
      tool_name: null,
      reasoning: null,
      timestamp: null,
    })
    const turns = messagesToTurns([mkUser('a'), mkUser('b')])
    expect(turns).toHaveLength(2)
    expect(turns.map((t) => t.segments[0])).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
    ])
  })
})

describe('turnToCopyText', () => {
  it('joins text and system segments, skips tools', () => {
    const turn: Turn = {
      id: '1',
      role: 'assistant',
      status: 'done',
      activity: [],
      segments: [
        { kind: 'text', text: 'line1' },
        {
          kind: 'tool',
          id: 'x',
          tool: 'web_search',
          preview: '',
          args: '{}',
        },
        { kind: 'system', text: 'line2' },
      ],
    }
    expect(turnToCopyText(turn)).toBe('line1\nline2')
  })
})

describe('attachmentNote', () => {
  it('formats file list for agent injection', () => {
    const note = attachmentNote(t, [
      { path: 'docs/a.md', size: 512, name: 'a.md' },
    ])
    expect(note).toContain('docs/a.md')
    expect(note).toContain('512 B')
  })
})
