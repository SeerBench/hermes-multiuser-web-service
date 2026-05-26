import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { ApiError, auth, conversations as convosApi, streamChat } from '../api'
import type { ChatMessage, ConversationSummary } from '../api'
import { ConversationList } from '../components/ConversationList'
import { KeyPromptModal } from '../components/KeyPromptModal'
import { ToolEvent } from '../components/ToolEvent'

type Turn = {
  // Stable id so React keys don't collide on rapid streaming.
  id: string
  role: 'user' | 'assistant'
  content: string
  // Tool events that fired during the assistant turn.
  tools: { tool: string; preview: string; duration?: number; error?: boolean }[]
  status: 'streaming' | 'done' | 'error'
  errorMessage?: string
}

// `crypto.randomUUID` only exists in secure contexts (HTTPS or
// localhost).  This gateway is commonly accessed over plain HTTP on a
// Tailscale / LAN IP, where the API is undefined and calling it throws
// TypeError.  We only need a key that's unique within this React tree's
// lifetime, not a real UUID, so a timestamp + random suffix is fine.
function newTurnId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

type KeyModalState =
  | { open: false }
  // `pendingMessage` is empty when the modal is opened proactively on
  // page load (no cookie); non-empty when the user hit send and we
  // discovered the session is missing or expired mid-request.
  | { open: true; reason: 'first-message' | 'session-expired'; pendingMessage: string }

export function ChatPage() {
  const [convos, setConvos] = useState<ConversationSummary[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [keyModal, setKeyModal] = useState<KeyModalState>({ open: false })
  const abortRef = useRef<AbortController | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)

  // On mount: probe /api/me. If unauthenticated, open the key modal
  // up front so the user isn't staring at a blank chat with no hint
  // that they need to sign in. If authenticated, populate the
  // conversation list.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await auth.me()
        if (cancelled) return
        try {
          setConvos(await convosApi.list())
        } catch {
          setConvos([])
        }
      } catch (err) {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          setKeyModal({ open: true, reason: 'first-message', pendingMessage: '' })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Auto-scroll on new content.
  useEffect(() => {
    const el = transcriptRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [turns])

  // Cancel any in-flight stream on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  const startNewConversation = useCallback(() => {
    abortRef.current?.abort()
    setSessionId(null)
    setTurns([])
  }, [])

  const switchConversation = useCallback((id: string) => {
    abortRef.current?.abort()
    setSessionId(id)
    // We don't fetch transcript history here yet — that needs an
    // additional endpoint on the server side (GET /api/conversations/{id}).
    // Switching just creates a fresh client-side view scoped to the
    // chosen session_id; the server transparently appends.
    setTurns([])
  }, [])

  const runMessage = useCallback(
    async (message: string, historyOverride?: ChatMessage[]) => {
      const userTurn: Turn = {
        id: newTurnId(),
        role: 'user',
        content: message,
        tools: [],
        status: 'done',
      }
      const assistantTurn: Turn = {
        id: newTurnId(),
        role: 'assistant',
        content: '',
        tools: [],
        status: 'streaming',
      }
      setTurns((prev) => [...prev, userTurn, assistantTurn])
      setStreaming(true)

      // Build history from prior fully-streamed turns, unless an
      // explicit override is supplied (used by the retry-after-login
      // path so we don't double-count the in-flight turns).
      const history: ChatMessage[] =
        historyOverride ??
        turns
          .filter((t) => t.status === 'done' && t.content)
          .map((t) => ({ role: t.role, content: t.content }))

      const controller = new AbortController()
      abortRef.current = controller

      try {
        for await (const ev of streamChat(
          {
            message,
            session_id: sessionId ?? undefined,
            conversation_history: history,
          },
          controller.signal,
        )) {
          if (ev.type === 'token') {
            setTurns((prev) =>
              updateAssistant(prev, (t) => ({ ...t, content: t.content + ev.text })),
            )
          } else if (ev.type === 'tool_start') {
            setTurns((prev) =>
              updateAssistant(prev, (t) => ({
                ...t,
                tools: [...t.tools, { tool: ev.tool, preview: ev.preview }],
              })),
            )
          } else if (ev.type === 'tool_end') {
            setTurns((prev) =>
              updateAssistant(prev, (t) => ({
                ...t,
                tools: t.tools.map((row, i) =>
                  i === t.tools.length - 1 && row.tool === ev.tool && row.duration == null
                    ? { ...row, duration: ev.duration, error: ev.error }
                    : row,
                ),
              })),
            )
          } else if (ev.type === 'done') {
            setSessionId(ev.session_id)
            setTurns((prev) => updateAssistant(prev, (t) => ({ ...t, status: 'done' })))
            // Refresh conversation list lazily so the new session
            // shows up in the sidebar without blocking the UI.
            void convosApi
              .list()
              .then(setConvos)
              .catch(() => undefined)
          } else if (ev.type === 'error') {
            // 401-flavoured errors come back with code unauthorized /
            // session_expired — pop the modal and stash the message so
            // we can resend after the user signs in.
            if (ev.code === 'unauthorized' || ev.code === 'session_expired') {
              // Drop the two in-flight turns; they'll be re-added on retry.
              setTurns((prev) => prev.slice(0, -2))
              setKeyModal({
                open: true,
                reason: ev.code === 'session_expired'
                  ? 'session-expired'
                  : 'first-message',
                pendingMessage: message,
              })
              return
            }
            setTurns((prev) =>
              updateAssistant(prev, (t) => ({
                ...t,
                status: 'error',
                errorMessage: ev.message,
              })),
            )
          }
        }
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') {
          setTurns((prev) =>
            updateAssistant(prev, (t) => ({
              ...t,
              status: t.content ? 'done' : 'error',
              errorMessage: t.content ? undefined : 'cancelled',
            })),
          )
        } else {
          setTurns((prev) =>
            updateAssistant(prev, (t) => ({
              ...t,
              status: 'error',
              errorMessage: err instanceof Error ? err.message : String(err),
            })),
          )
        }
      } finally {
        setStreaming(false)
        abortRef.current = null
      }
    },
    [sessionId, turns],
  )

  const submit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault()
      const message = input.trim()
      if (!message || streaming) return
      setInput('')
      await runMessage(message)
    },
    [input, streaming, runMessage],
  )

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter to send, Shift+Enter for newline (chat convention).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  const stop = () => abortRef.current?.abort()

  // After successful login from the modal, resend the stashed message
  // (if any — empty when the modal was opened proactively on mount).
  const onLoginSuccess = useCallback(() => {
    setKeyModal((prev) => {
      if (!prev.open) return prev
      if (prev.pendingMessage) {
        // Resend the original message; pass an empty history because
        // we cleared the in-flight turns above.
        void runMessage(prev.pendingMessage, [])
      }
      return { open: false }
    })
    // Refresh conversation list now that we're signed in.
    void convosApi
      .list()
      .then(setConvos)
      .catch(() => undefined)
  }, [runMessage])

  const onLoginCancel = useCallback(() => {
    setKeyModal({ open: false })
  }, [])

  return (
    <div className="chat-page">
      <aside className="chat-side">
        <button type="button" className="chat-new" onClick={startNewConversation}>
          + New chat
        </button>
        <ConversationList
          conversations={convos}
          activeId={sessionId}
          onSelect={switchConversation}
        />
      </aside>

      <section className="chat-main">
        <div className="chat-transcript" ref={transcriptRef}>
          {turns.length === 0 ? (
            <div className="chat-empty">
              <h2>Start a new conversation.</h2>
              <p>Your messages and the agent's reply will appear here.</p>
            </div>
          ) : (
            turns.map((turn) => (
              <article key={turn.id} className={`turn turn-${turn.role}`}>
                <header className="turn-role">{turn.role}</header>
                {turn.tools.length > 0 && (
                  <div className="turn-tools">
                    {turn.tools.map((t, i) => (
                      <ToolEvent
                        key={i}
                        tool={t.tool}
                        preview={t.preview}
                        duration={t.duration}
                        error={t.error}
                      />
                    ))}
                  </div>
                )}
                <div className="turn-content">{turn.content || <em>…</em>}</div>
                {turn.status === 'error' && (
                  <div className="turn-error">{turn.errorMessage}</div>
                )}
              </article>
            ))
          )}
        </div>

        <form className="composer" onSubmit={submit}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Message Hermes…"
            rows={3}
            disabled={streaming}
          />
          <div className="composer-actions">
            {streaming ? (
              <button type="button" onClick={stop} className="composer-stop">
                Stop
              </button>
            ) : (
              <button type="submit" disabled={!input.trim()} className="composer-send">
                Send
              </button>
            )}
          </div>
        </form>
      </section>

      {keyModal.open && (
        <KeyPromptModal
          reason={keyModal.reason}
          onSuccess={onLoginSuccess}
          onCancel={onLoginCancel}
        />
      )}
    </div>
  )
}

function updateAssistant(prev: Turn[], fn: (t: Turn) => Turn): Turn[] {
  if (prev.length === 0) return prev
  const last = prev[prev.length - 1]
  if (last.role !== 'assistant') return prev
  return [...prev.slice(0, -1), fn(last)]
}
