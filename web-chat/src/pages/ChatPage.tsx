import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { conversations as convosApi, streamChat } from '../api'
import type { ChatMessage, ConversationSummary, Quota } from '../api'
import { ConversationList } from '../components/ConversationList'
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

type Props = {
  onQuotaUpdate: (q: Quota) => void
}

export function ChatPage({ onQuotaUpdate }: Props) {
  const [convos, setConvos] = useState<ConversationSummary[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)

  // Initial conversation list.
  useEffect(() => {
    convosApi
      .list()
      .then(setConvos)
      .catch(() => setConvos([]))
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

  const submit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault()
      const message = input.trim()
      if (!message || streaming) return
      setInput('')

      const userTurn: Turn = {
        id: crypto.randomUUID(),
        role: 'user',
        content: message,
        tools: [],
        status: 'done',
      }
      const assistantTurn: Turn = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        tools: [],
        status: 'streaming',
      }
      setTurns((prev) => [...prev, userTurn, assistantTurn])
      setStreaming(true)

      const history: ChatMessage[] = []
      for (const t of turns) {
        if (t.status === 'done' && t.content) {
          history.push({ role: t.role, content: t.content })
        }
      }

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
            onQuotaUpdate(ev.quota)
            setTurns((prev) => updateAssistant(prev, (t) => ({ ...t, status: 'done' })))
            // Refresh conversation list lazily so the new session
            // shows up in the sidebar without blocking the UI.
            void convosApi
              .list()
              .then(setConvos)
              .catch(() => undefined)
          } else if (ev.type === 'error') {
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
    [input, streaming, sessionId, turns, onQuotaUpdate],
  )

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter to send, Shift+Enter for newline (chat convention).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  const stop = () => abortRef.current?.abort()

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
    </div>
  )
}

function updateAssistant(prev: Turn[], fn: (t: Turn) => Turn): Turn[] {
  if (prev.length === 0) return prev
  const last = prev[prev.length - 1]
  if (last.role !== 'assistant') return prev
  return [...prev.slice(0, -1), fn(last)]
}
