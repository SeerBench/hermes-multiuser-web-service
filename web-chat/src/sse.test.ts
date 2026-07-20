import { describe, expect, it } from 'vitest'

import { parseSseFrame } from './sse'

describe('parseSseFrame', () => {
  it('parses token events', () => {
    const ev = parseSseFrame('event: token\ndata: {"text":"hi"}\n')
    expect(ev).toEqual({ type: 'token', text: 'hi' })
  })

  it('parses tool lifecycle events', () => {
    const start = parseSseFrame(
      'event: tool_start\ndata: {"id":"t1","tool":"web_search","preview":"q","args":"{}"}\n',
    )
    expect(start?.type).toBe('tool_start')

    const end = parseSseFrame(
      'event: tool_end\ndata: {"id":"t1","tool":"web_search","duration":1.2,"error":false,"result_preview":"ok"}\n',
    )
    expect(end).toMatchObject({ type: 'tool_end', error: false })
  })

  it('parses done and error events', () => {
    const done = parseSseFrame(
      'event: done\ndata: {"session_id":"s1","usage":{"total_tokens":42}}\n',
    )
    expect(done).toEqual({
      type: 'done',
      session_id: 's1',
      usage: { total_tokens: 42 },
    })

    const err = parseSseFrame(
      'event: error\ndata: {"message":"boom","code":"upstream_key_required"}\n',
    )
    expect(err).toEqual({
      type: 'error',
      message: 'boom',
      code: 'upstream_key_required',
    })
  })

  it('ignores comments and invalid JSON', () => {
    expect(parseSseFrame(': keepalive\n\n')).toBeNull()
    expect(parseSseFrame('event: token\ndata: not-json\n')).toBeNull()
    expect(parseSseFrame('event: unknown\ndata: {"x":1}\n')).toBeNull()
  })

  it('defaults status kind to lifecycle', () => {
    const ev = parseSseFrame('event: status\ndata: {"message":"ok"}\n')
    expect(ev).toEqual({ type: 'status', kind: 'lifecycle', message: 'ok' })
  })

  it('parses reasoning, step, activity and warn status', () => {
    expect(parseSseFrame('event: reasoning\ndata: {"text":"hmm"}\n')).toEqual({
      type: 'reasoning',
      text: 'hmm',
    })
    expect(parseSseFrame('event: step\ndata: {"step":3,"tools":["a"]}\n')).toEqual({
      type: 'step',
      step: 3,
      tools: ['a'],
    })
    expect(parseSseFrame('event: activity\ndata: {"kind":"thinking","text":"x"}\n')).toEqual({
      type: 'activity',
      kind: 'thinking',
      text: 'x',
    })
    expect(
      parseSseFrame(
        'event: title\ndata: {"session_id":"s1","title":"Hello world"}\n',
      ),
    ).toEqual({
      type: 'title',
      session_id: 's1',
      title: 'Hello world',
    })
    expect(parseSseFrame('event: status\ndata: {"kind":"warn","message":"slow"}\n')).toEqual({
      type: 'status',
      kind: 'warn',
      message: 'slow',
    })
  })
})
