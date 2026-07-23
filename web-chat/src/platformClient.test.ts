import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PlatformApiError,
  getStoredWorkspaceId,
  platform,
  storeWorkspaceId,
  tryPlatformSession,
} from './platformClient'

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('platformClient workspace storage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('stores and reads workspace id', () => {
    storeWorkspaceId('ws-123')
    expect(getStoredWorkspaceId()).toBe('ws-123')
  })
})

describe('platform API', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('register posts to /api/v1/auth/register', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        user: { user_id: 'u1', email: 'a@b.com' },
        workspace: { id: 'w1', tenant_id: 't1', name: 'Default' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await platform.register('a@b.com', 'password123')
    expect(res.user.user_id).toBe('u1')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/auth/register')
  })

  it('throws PlatformApiError on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ detail: 'bad credentials' }, { status: 401 }),
      ),
    )

    await expect(platform.login('a@b.com', 'wrong')).rejects.toBeInstanceOf(
      PlatformApiError,
    )
  })

  it('createShare posts snapshot and getShare reads by token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          token: 'tok_1',
          url_path: '#/share/tok_1',
          kind: 'reply',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          kind: 'reply',
          title: null,
          turns: [{ role: 'assistant', text: 'hi' }],
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const created = await platform.createShare({
      kind: 'reply',
      turns: [{ role: 'assistant', text: 'hi' }],
    })
    expect(created.token).toBe('tok_1')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/shares')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' })

    const got = await platform.getShare('tok_1')
    expect(got.turns[0].text).toBe('hi')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/shares/tok_1')
  })
})

describe('tryPlatformSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('returns null when healthz fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ detail: 'down' }, { status: 503 })),
    )
    expect(await tryPlatformSession()).toBeNull()
  })

  it('returns user and persisted workspace on success', async () => {
    storeWorkspaceId('ws-cached')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
      .mockResolvedValueOnce(
        jsonResponse({ user_id: 'u1', email: 'a@b.com' }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const session = await tryPlatformSession()
    expect(session).toEqual({
      user: { user_id: 'u1', email: 'a@b.com' },
      workspaceId: 'ws-cached',
    })
  })

  it('loads workspace from API when not cached', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
      .mockResolvedValueOnce(jsonResponse({ user_id: 'u1' }))
      .mockResolvedValueOnce(
        jsonResponse([{ id: 'ws-new', tenant_id: 't1', name: 'Default' }]),
      )
    vi.stubGlobal('fetch', fetchMock)

    const session = await tryPlatformSession()
    expect(session?.workspaceId).toBe('ws-new')
    expect(getStoredWorkspaceId()).toBe('ws-new')
  })
})
