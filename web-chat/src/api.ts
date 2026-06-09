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
  pinned?: boolean
  archived?: boolean
}

// A file the user uploaded into their sandbox workspace.  ``path`` is the
// workspace-relative path the agent reads via ``web_file_read``.
export type UploadedFile = {
  name: string
  path: string
  size: number
}

export type ChatMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export type ChatEvent =
  | { type: 'token'; text: string }
  | {
      type: 'tool_start'
      id: string | null
      tool: string
      preview: string
      args: string
    }
  | {
      type: 'tool_end'
      id: string | null
      tool: string
      duration: number
      error: boolean
      result_preview: string
    }
  | { type: 'reasoning'; text: string }
  | { type: 'status'; kind: 'lifecycle' | 'warn'; message: string }
  | { type: 'step'; step: number; tools: string[] }
  | { type: 'activity'; kind: string; text: string }
  | { type: 'done'; session_id: string; usage: Record<string, number> }
  | { type: 'error'; message: string; code?: string }

// ── Stored messages (returned by GET /api/conversations/:id) ────────────

export type ServerMessage = {
  id: number | null
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string | null
  tool_calls: ServerToolCall[]
  tool_call_id: string | null
  tool_name: string | null
  reasoning: string | null
  timestamp: number | null
}

export type ServerToolCall = {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
  // Defensive: some providers store tool calls in flat form.
  name?: string
  arguments?: string | Record<string, unknown>
}

export type ConversationDetail = {
  id: string
  title: string | null
  started_at: number
  last_active: number
  messages: ServerMessage[]
}

// ── Slash command catalog + dispatch ────────────────────────────────────

export type CommandSpec = {
  name: string
  description: string
  description_i18n?: { en: string; zh: string }
  category: string
  args_hint: string
  aliases: string[]
  subcommands: string[]
  client_only: boolean
  supported: boolean
}

export type CommandResult = {
  ok: boolean
  message: string
  side_effects?: Record<string, unknown>
}

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
  // FormData bodies must NOT carry an explicit Content-Type — the browser
  // sets the multipart boundary itself.  Only default to JSON otherwise.
  const isFormData =
    typeof FormData !== 'undefined' && init.body instanceof FormData
  const baseHeaders: Record<string, string> = isFormData
    ? {}
    : { 'Content-Type': 'application/json' }
  const res = await fetch(path, {
    credentials: 'include',
    headers: {
      ...baseHeaders,
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
  list: (opts: { limit?: number; offset?: number; archived?: boolean } = {}) => {
    const { limit = 50, offset = 0, archived = false } = opts
    const q = `limit=${limit}&offset=${offset}${archived ? '&archived=1' : ''}`
    return request<{ conversations: ConversationSummary[] }>(
      `/api/conversations?${q}`,
    ).then((r) => r.conversations)
  },
  get: (id: string) =>
    request<ConversationDetail>(`/api/conversations/${encodeURIComponent(id)}`),
  rename: (id: string, title: string) =>
    request<{ id: string; title: string }>(
      `/api/conversations/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify({ title }) },
    ),
  remove: (id: string) =>
    request<{ id: string; deleted: boolean }>(
      `/api/conversations/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  setFlags: (id: string, flags: { pinned?: boolean; archived?: boolean }) =>
    request<{ id: string; pinned: boolean; archived: boolean }>(
      `/api/conversations/${encodeURIComponent(id)}/flags`,
      { method: 'POST', body: JSON.stringify(flags) },
    ),
}

// ── Uploads ──────────────────────────────────────────────────────────────

export const uploads = {
  /** Upload files into the user's sandbox; returns workspace-relative paths. */
  create: (files: File[]) => {
    const fd = new FormData()
    for (const f of files) fd.append('files', f, f.name)
    return request<{ files: UploadedFile[] }>(`/api/uploads`, {
      method: 'POST',
      body: fd,
    }).then((r) => r.files)
  },
}

// ── Commands ────────────────────────────────────────────────────────────

export const commands = {
  list: () =>
    request<{ commands: CommandSpec[] }>(`/api/commands`).then((r) => r.commands),
  run: (name: string, args = '', session_id?: string | null) =>
    request<CommandResult>(`/api/command`, {
      method: 'POST',
      body: JSON.stringify({
        command: name,
        args,
        session_id: session_id ?? null,
      }),
    }),
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
        id: data.id == null ? null : String(data.id),
        tool: String(data.tool ?? ''),
        preview: String(data.preview ?? ''),
        args: String(data.args ?? ''),
      }
    case 'tool_end':
      return {
        type: 'tool_end',
        id: data.id == null ? null : String(data.id),
        tool: String(data.tool ?? ''),
        duration: Number(data.duration ?? 0),
        error: Boolean(data.error),
        result_preview: String(data.result_preview ?? ''),
      }
    case 'reasoning':
      return { type: 'reasoning', text: String(data.text ?? '') }
    case 'status':
      return {
        type: 'status',
        kind: data.kind === 'warn' ? 'warn' : 'lifecycle',
        message: String(data.message ?? ''),
      }
    case 'step':
      return {
        type: 'step',
        step: Number(data.step ?? 0),
        tools: Array.isArray(data.tools) ? data.tools.map(String) : [],
      }
    case 'activity':
      return {
        type: 'activity',
        kind: String(data.kind ?? 'thinking'),
        text: String(data.text ?? ''),
      }
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
