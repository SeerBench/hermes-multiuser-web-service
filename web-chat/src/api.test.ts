import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, auth, conversations, streamChat } from './api'

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

describe('api request wrapper', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('auth.login posts api_key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ user_id: 'u_abc' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await auth.login('sk-test-key')
    expect(res.user_id).toBe('u_abc')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ api_key: 'sk-test-key' }),
      }),
    )
  })

  it('throws ApiError with server code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ error: 'nope', code: 'invalid_key' }, { status: 401 }),
      ),
    )

    await expect(auth.me()).rejects.toMatchObject({
      status: 401,
      code: 'invalid_key',
    } satisfies Partial<ApiError>)
  })

  it('conversations.list builds query string', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ conversations: [{ id: 'c1' }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const rows = await conversations.list({ limit: 10, archived: true })
    expect(rows).toHaveLength(1)
    expect(fetchMock.mock.calls[0][0]).toContain('archived=1')
    expect(fetchMock.mock.calls[0][0]).toContain('limit=10')
  })
})

describe('streamChat', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('yields parsed SSE events from the response body', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('event: token\ndata: {"text":"Hi"}\n\n'),
        )
        controller.enqueue(
          encoder.encode(
            'event: done\ndata: {"session_id":"s1","usage":{}}\n\n',
          ),
        )
        controller.close()
      },
    })

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    )

    const events = []
    for await (const ev of streamChat({ message: 'hello' }, new AbortController().signal)) {
      events.push(ev)
    }

    expect(events).toEqual([
      { type: 'token', text: 'Hi' },
      { type: 'done', session_id: 's1', usage: {} },
    ])
  })

  it('yields error event on non-SSE HTTP failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ error: 'unauthorized', code: 'session_expired' }, {
          status: 401,
        }),
      ),
    )

    const events = []
    for await (const ev of streamChat({ message: 'x' }, new AbortController().signal)) {
      events.push(ev)
    }

    expect(events).toEqual([
      {
        type: 'error',
        message: 'unauthorized',
        code: 'session_expired',
      },
    ])
  })
})
