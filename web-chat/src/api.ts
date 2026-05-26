// API client for the web_chat gateway adapter.
//
// One-page summary:
// - All requests go to `/api/*`; in dev they're proxied to `:8643`,
//   in production the SPA is served by the gateway so it's same-origin.
// - Cookie auth is the default — `credentials: 'include'` on every
//   request.  The server sets / clears the `hermes_session` cookie.
// - The cookie is issued by POST /api/auth/login when the user pastes
//   their new-api key; the server validates it against the upstream
//   gateway before signing.
// - For chat streaming we use `fetch` + `ReadableStream` rather than
//   EventSource, because EventSource only supports GET and can't carry
//   cookies cross-origin in some browsers.

export type User = {
  user_id: string
  created_at: number
  last_seen_at: number
}

export type ConversationSummary = {
  id: string
  title: string | null
  preview: string
  started_at: number
  last_active: number
  message_count: number
}

export type ChatMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export type ChatEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_start'; tool: string; preview: string }
  | { type: 'tool_end'; tool: string; duration: number; error: boolean }
  | { type: 'reasoning'; text: string }
  | { type: 'done'; session_id: string; usage: Record<string, number> }
  | { type: 'error'; message: string; code?: string }

// ── Low-level fetch wrapper ──────────────────────────────────────────────

class ApiError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    ...init,
  })
  if (!res.ok) {
    let body: { error?: string; code?: string } = {}
    try {
      body = await res.json()
    } catch {
      // Non-JSON error response — keep the empty body.
    }
    throw new ApiError(body.error ?? res.statusText, res.status, body.code)
  }
  if (res.status === 204) return undefined as T
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('json')) return undefined as T
  return res.json() as Promise<T>
}

export { ApiError }

// ── Auth ────────────────────────────────────────────────────────────────

export const auth = {
  login: (apiKey: string) =>
    request<{ user_id: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ api_key: apiKey }),
    }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  me: () => request<User>('/api/me'),
}

// ── Conversations ───────────────────────────────────────────────────────

export const conversations = {
  list: (limit = 50, offset = 0) =>
    request<{ conversations: ConversationSummary[] }>(
      `/api/conversations?limit=${limit}&offset=${offset}`,
    ).then((r) => r.conversations),
}

// ── Chat (SSE stream) ───────────────────────────────────────────────────

export type ChatRequest = {
  message: string
  session_id?: string
  session_key?: string
  system_prompt?: string
  conversation_history?: ChatMessage[]
}

/**
 * Open a streaming chat connection.  Returns an async iterable of
 * decoded SSE events; the consumer drives the loop with `for await`.
 *
 * On 401, the iterator yields a single `error` event with code
 * `unauthorized` or `session_expired` so the caller can pop the key
 * prompt.  The caller is responsible for retrying after re-auth.
 *
 * Cancellation is via the `AbortSignal` on the supplied controller —
 * aborting tears down the fetch, the server detects the disconnect,
 * and the agent is interrupted server-side.
 */
export async function* streamChat(
  req: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<ChatEvent, void, undefined> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(req),
    signal,
  })

  const ct = res.headers.get('content-type') ?? ''
  if (!res.ok || !ct.includes('text/event-stream')) {
    let body: { error?: string; code?: string } = {}
    try {
      body = await res.json()
    } catch {
      // ignore
    }
    // Surface 401 with a distinct code so the UI can open the key modal.
    const code =
      body.code ??
      (res.status === 401 ? 'unauthorized' : undefined) ??
      undefined
    yield {
      type: 'error',
      message: body.error ?? `HTTP ${res.status}`,
      code,
    }
    return
  }

  if (!res.body) {
    yield { type: 'error', message: 'no response body' }
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Split on the SSE frame delimiter (blank line).
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const event = parseSseFrame(frame)
        if (event) yield event
      }
    }
  } finally {
    // Best-effort cancel — caller may have already aborted.
    try {
      await reader.cancel()
    } catch {
      // ignore
    }
  }
}

function parseSseFrame(frame: string): ChatEvent | null {
  let eventType = 'message'
  let dataLine = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) eventType = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLine += line.slice(5).trim()
    else if (line.startsWith(':')) continue // SSE comment
  }
  if (!dataLine) return null
  let data: Record<string, unknown>
  try {
    data = JSON.parse(dataLine)
  } catch {
    return null
  }
  // Narrow to the typed union by event name.  Unknown event names are
  // dropped — server and client must agree on the set.
  switch (eventType) {
    case 'token':
      return { type: 'token', text: String(data.text ?? '') }
    case 'tool_start':
      return {
        type: 'tool_start',
        tool: String(data.tool ?? ''),
        preview: String(data.preview ?? ''),
      }
    case 'tool_end':
      return {
        type: 'tool_end',
        tool: String(data.tool ?? ''),
        duration: Number(data.duration ?? 0),
        error: Boolean(data.error),
      }
    case 'reasoning':
      return { type: 'reasoning', text: String(data.text ?? '') }
    case 'done':
      return {
        type: 'done',
        session_id: String(data.session_id ?? ''),
        usage: (data.usage as Record<string, number>) ?? {},
      }
    case 'error':
      return {
        type: 'error',
        message: String(data.message ?? 'unknown error'),
        code: data.code ? String(data.code) : undefined,
      }
    default:
      return null
  }
}
