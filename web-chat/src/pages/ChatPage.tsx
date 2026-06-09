import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import {
  ApiError,
  auth,
  commands as commandsApi,
  conversations as convosApi,
  streamChat,
  uploads as uploadsApi,
} from '../api'
import type {
  ChatMessage,
  CommandSpec,
  ConversationSummary,
  ServerMessage,
  UploadedFile,
} from '../api'
import { ActivityLog } from '../components/ActivityLog'
import type { ActivityItem } from '../components/ActivityLog'
import {
  AttachmentList,
  PendingAttachments,
} from '../components/AttachmentChips'
import type { PendingAttachment } from '../components/AttachmentChips'
import { ConversationList } from '../components/ConversationList'
import { KeyPromptModal } from '../components/KeyPromptModal'
import { MarkdownContent } from '../components/MarkdownContent'
import { MessageActions } from '../components/MessageActions'
import { ReasoningPanel } from '../components/ReasoningPanel'
import { SlashCommandPopover } from '../components/SlashCommandPopover'
import { ToolEvent } from '../components/ToolEvent'
import { formatBytes } from '../format'
import { useLocale, useT } from '../i18n'
import type { Locale, Translator } from '../i18n'

// ── Domain types ──────────────────────────────────────────────────────────

type ToolSegment = {
  kind: 'tool'
  // SSE tool_call id when available — lets us match tool_end back to the
  // tool_start that opened the segment even when tools interleave.
  id: string | null
  tool: string
  preview: string
  args: string
  result_preview?: string
  duration?: number
  error?: boolean
}

type Segment =
  | { kind: 'text'; text: string }
  | ToolSegment
  | { kind: 'system'; text: string; tone?: 'ok' | 'error' }

type Turn = {
  id: string
  role: 'user' | 'assistant'
  segments: Segment[]
  reasoning?: string
  status: 'streaming' | 'done' | 'error'
  errorMessage?: string
  usage?: Record<string, number>
  // Behind-the-scenes activity feed (assistant turns): lifecycle status,
  // loop-iteration steps, pre-tool "thinking" hints.
  activity: ActivityItem[]
  // Files attached to a user turn (workspace-relative paths the agent reads).
  attachments?: UploadedFile[]
}

// Build the reference block appended to a message when files are attached,
// so the agent knows to read them with web_file_read.
function attachmentNote(t: Translator, files: UploadedFile[]): string {
  const lines = files.map((f) => `- ${f.path} (${formatBytes(f.size)})`)
  return `\n\n${t('attach.inject.header')}\n${lines.join('\n')}`
}

type KeyModalState =
  | { open: false }
  | {
      open: true
      reason: 'first-message' | 'session-expired'
      pendingMessage: string
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

// ── messagesToTurns: server history → renderable Turn[] ───────────────────

function messagesToTurns(messages: ServerMessage[]): Turn[] {
  const turns: Turn[] = []
  let assistantTurn: Turn | null = null

  // Pre-index tool results by tool_call_id so we can attach them to the
  // assistant turn's tool segments without a second pass.
  const toolResults = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'tool' && m.tool_call_id) {
      toolResults.set(m.tool_call_id, m.content ?? '')
    }
  }

  const flushAssistant = () => {
    if (assistantTurn) {
      turns.push(assistantTurn)
      assistantTurn = null
    }
  }

  for (const m of messages) {
    if (m.role === 'user') {
      flushAssistant()
      turns.push({
        id: newTurnId(),
        role: 'user',
        segments: [{ kind: 'text', text: m.content ?? '' }],
        status: 'done',
        activity: [],
      })
      continue
    }
    if (m.role !== 'assistant') {
      // tool messages are merged via toolResults above; system messages
      // are skipped (we'd surface them as system segments only when the
      // SPA itself emits them, e.g. /command results).
      continue
    }
    if (!assistantTurn) {
      assistantTurn = {
        id: newTurnId(),
        role: 'assistant',
        segments: [],
        status: 'done',
        activity: [],
      }
    }
    if (m.reasoning) {
      assistantTurn.reasoning = (assistantTurn.reasoning ?? '') + m.reasoning
    }
    if (m.content) {
      assistantTurn.segments.push({ kind: 'text', text: m.content })
    }
    for (const tc of m.tool_calls ?? []) {
      const id = tc.id ? String(tc.id) : null
      const fnName = tc.function?.name ?? tc.name ?? '(tool)'
      const rawArgs = tc.function?.arguments ?? tc.arguments
      let argsStr = ''
      if (rawArgs != null) {
        argsStr = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs)
      }
      const result = id ? toolResults.get(id) : undefined
      assistantTurn.segments.push({
        kind: 'tool',
        id,
        tool: fnName,
        preview: argsStr.slice(0, 280),
        args: argsStr,
        result_preview: result,
        duration: 0,
        error: false,
      })
    }
  }
  flushAssistant()
  return turns
}

// Stitch a turn's text into a single string for clipboard copy.
function turnToCopyText(turn: Turn): string {
  return turn.segments
    .filter((s): s is Exclude<Segment, ToolSegment> => s.kind !== 'tool')
    .map((s) => s.text)
    .join('\n')
    .trim()
}

// ── ChatPage ──────────────────────────────────────────────────────────────

export function ChatPage() {
  const t = useT()
  const { setLocale } = useLocale()
  const [convos, setConvos] = useState<ConversationSummary[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [keyModal, setKeyModal] = useState<KeyModalState>({ open: false })
  const [commandCatalog, setCommandCatalog] = useState<CommandSpec[]>([])
  const [historyBanner, setHistoryBanner] = useState<string | null>(null)
  const [archived, setArchived] = useState<ConversationSummary[]>([])
  const [pending, setPending] = useState<PendingAttachment[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Probe auth + initial data.
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
        try {
          setCommandCatalog(await commandsApi.list())
        } catch {
          // command catalog is non-essential; popover just hides if empty.
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
    setHistoryBanner(null)
  }, [])

  // Sidebar click → fetch the full transcript and rehydrate. Before this
  // change the SPA just cleared the turn list and left the user staring
  // at an empty page — the server-side endpoint that returns history
  // didn't exist. Now it does.
  const switchConversation = useCallback(
    async (id: string) => {
      abortRef.current?.abort()
      setSessionId(id)
      setTurns([])
      setHistoryBanner(null)
      try {
        const detail = await convosApi.get(id)
        setTurns(messagesToTurns(detail.messages))
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setKeyModal({
            open: true,
            reason: 'session-expired',
            pendingMessage: '',
          })
          return
        }
        if (err instanceof ApiError && err.status === 404) {
          setHistoryBanner(t('chat.history.notfound'))
        } else {
          setHistoryBanner(t('chat.history.unavailable'))
        }
      }
    },
    [t],
  )

  const refreshConvos = useCallback(() => {
    void convosApi
      .list()
      .then(setConvos)
      .catch(() => undefined)
  }, [])

  const loadArchived = useCallback(() => {
    void convosApi
      .list({ archived: true })
      .then(setArchived)
      .catch(() => setArchived([]))
  }, [])

  const handleRename = useCallback(
    async (id: string, title: string) => {
      try {
        await convosApi.rename(id, title)
      } catch {
        // Non-fatal — leave the old title in place.
      }
      refreshConvos()
      loadArchived()
    },
    [refreshConvos, loadArchived],
  )

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await convosApi.remove(id)
      } catch {
        // Non-fatal.
      }
      if (id === sessionId) {
        abortRef.current?.abort()
        setSessionId(null)
        setTurns([])
        setHistoryBanner(null)
      }
      refreshConvos()
      loadArchived()
    },
    [sessionId, refreshConvos, loadArchived],
  )

  const handleSetFlags = useCallback(
    async (id: string, flags: { pinned?: boolean; archived?: boolean }) => {
      try {
        await convosApi.setFlags(id, flags)
      } catch {
        // Non-fatal.
      }
      refreshConvos()
      loadArchived()
    },
    [refreshConvos, loadArchived],
  )

  // ── Attachments ────────────────────────────────────────────────────────

  const removePending = useCallback((id: string) => {
    setPending((prev) => prev.filter((p) => p.id !== id))
  }, [])

  const onPickFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const picked = Array.from(files)
    const entries: PendingAttachment[] = picked.map((f) => ({
      id: newTurnId(),
      name: f.name,
      size: f.size,
      status: 'uploading',
    }))
    setPending((prev) => [...prev, ...entries])
    try {
      const saved = await uploadsApi.create(picked)
      // Match returned files back to the pending entries by position.
      setPending((prev) =>
        prev.map((p) => {
          const idx = entries.findIndex((e) => e.id === p.id)
          if (idx < 0 || idx >= saved.length) return p
          const s = saved[idx]
          return { ...p, status: 'done', path: s.path, name: s.name, size: s.size }
        }),
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const ids = new Set(entries.map((e) => e.id))
      setPending((prev) =>
        prev.map((p) =>
          ids.has(p.id) ? { ...p, status: 'error', error: msg } : p,
        ),
      )
    }
  }, [])

  const runMessage = useCallback(
    async (
      message: string,
      historyOverride?: ChatMessage[],
      attachments?: UploadedFile[],
    ) => {
      const userTurn: Turn = {
        id: newTurnId(),
        role: 'user',
        segments: [{ kind: 'text', text: message }],
        status: 'done',
        activity: [],
        attachments: attachments && attachments.length ? attachments : undefined,
      }
      const assistantTurn: Turn = {
        id: newTurnId(),
        role: 'assistant',
        segments: [],
        status: 'streaming',
        activity: [],
      }
      setTurns((prev) => [...prev, userTurn, assistantTurn])
      setStreaming(true)

      // Append the attachment reference block so the agent reads the
      // uploaded files via web_file_read; the visible user turn keeps the
      // clean message and shows attachments as chips instead.
      const wireMessage =
        attachments && attachments.length
          ? message + attachmentNote(t, attachments)
          : message

      const history: ChatMessage[] =
        historyOverride ??
        turns
          .filter((t) => t.status === 'done')
          .map((t) => ({
            role: t.role,
            content: turnToCopyText(t),
          }))
          .filter((m) => m.content)

      const controller = new AbortController()
      abortRef.current = controller

      try {
        for await (const ev of streamChat(
          {
            message: wireMessage,
            session_id: sessionId ?? undefined,
            conversation_history: history,
          },
          controller.signal,
        )) {
          if (ev.type === 'token') {
            setTurns((prev) => updateAssistant(prev, (turn) => appendToken(turn, ev.text)))
          } else if (ev.type === 'reasoning') {
            setTurns((prev) =>
              updateAssistant(prev, (turn) => ({
                ...turn,
                reasoning: (turn.reasoning ?? '') + ev.text,
              })),
            )
          } else if (ev.type === 'status') {
            setTurns((prev) =>
              pushActivity(prev, {
                kind: 'status',
                text: ev.message,
                tone: ev.kind === 'warn' ? 'warn' : undefined,
                ts: Date.now(),
              }),
            )
          } else if (ev.type === 'step') {
            setTurns((prev) =>
              pushActivity(prev, {
                kind: 'step',
                step: ev.step,
                tools: ev.tools,
                ts: Date.now(),
              }),
            )
          } else if (ev.type === 'activity') {
            setTurns((prev) =>
              pushActivity(prev, { kind: 'thinking', text: ev.text, ts: Date.now() }),
            )
          } else if (ev.type === 'tool_start') {
            const newSeg: ToolSegment = {
              kind: 'tool',
              id: ev.id,
              tool: ev.tool,
              preview: ev.preview,
              args: ev.args,
            }
            setTurns((prev) =>
              updateAssistant(prev, (turn) => ({
                ...turn,
                segments: [...turn.segments, newSeg],
              })),
            )
          } else if (ev.type === 'tool_end') {
            setTurns((prev) =>
              updateAssistant(prev, (turn) => ({
                ...turn,
                segments: turn.segments.map((seg) => {
                  if (seg.kind !== 'tool') return seg
                  const matches = ev.id
                    ? seg.id === ev.id && seg.duration == null
                    : seg.tool === ev.tool && seg.duration == null
                  if (!matches) return seg
                  return {
                    ...seg,
                    duration: ev.duration,
                    error: ev.error,
                    result_preview: ev.result_preview,
                  }
                }),
              })),
            )
          } else if (ev.type === 'done') {
            setSessionId(ev.session_id)
            setTurns((prev) =>
              updateAssistant(prev, (turn) => ({
                ...turn,
                status: 'done',
                usage: ev.usage,
              })),
            )
            void convosApi
              .list()
              .then(setConvos)
              .catch(() => undefined)
          } else if (ev.type === 'error') {
            if (ev.code === 'unauthorized' || ev.code === 'session_expired') {
              setTurns((prev) => prev.slice(0, -2))
              setKeyModal({
                open: true,
                reason:
                  ev.code === 'session_expired' ? 'session-expired' : 'first-message',
                pendingMessage: message,
              })
              return
            }
            setTurns((prev) =>
              updateAssistant(prev, (turn) => ({
                ...turn,
                status: 'error',
                errorMessage: ev.message,
              })),
            )
          }
        }
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') {
          setTurns((prev) =>
            updateAssistant(prev, (turn) => ({
              ...turn,
              status: turnHasText(turn) ? 'done' : 'error',
              errorMessage: turnHasText(turn) ? undefined : t('chat.error.cancelled'),
            })),
          )
        } else {
          setTurns((prev) =>
            updateAssistant(prev, (turn) => ({
              ...turn,
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
    [sessionId, turns, t],
  )

  // ── Slash command handling ────────────────────────────────────────────

  // Detect a slash command at the start of the input. We keep this
  // simple: if the entire textarea starts with '/' on a single line,
  // the popover shows up.
  const slashQuery = useMemo<string | null>(() => {
    if (!input.startsWith('/')) return null
    if (input.includes('\n')) return null
    return input.slice(1)
  }, [input])
  const showPopover = slashQuery !== null && !streaming && commandCatalog.length > 0

  const appendSystemSegment = useCallback((text: string, tone?: 'ok' | 'error') => {
    setTurns((prev) => [
      ...prev,
      {
        id: newTurnId(),
        role: 'assistant',
        segments: [{ kind: 'system', text, tone }],
        status: 'done',
        activity: [],
      },
    ])
  }, [])

  const runClientCommand = useCallback(
    (name: string, args: string): boolean => {
      switch (name) {
        case 'clear': {
          abortRef.current?.abort()
          setSessionId(null)
          setTurns([])
          setHistoryBanner(null)
          return true
        }
        case 'new': {
          abortRef.current?.abort()
          setSessionId(null)
          setTurns([])
          setHistoryBanner(null)
          return true
        }
        case 'help': {
          const lines = commandCatalog.map((c) => {
            const hint = c.args_hint ? ` ${c.args_hint}` : ''
            const tag = c.client_only
              ? ` [${t('command.popover.hint.client')}]`
              : c.supported
                ? ''
                : ` [${t('command.popover.hint.not_yet')}]`
            const desc = c.description_i18n
              ? (c.description_i18n as Record<Locale, string>)[
                  /* run-time locale */ (document.documentElement.lang as Locale) ||
                    'en'
                ] ?? c.description
              : c.description
            return `/${c.name}${hint} — ${desc}${tag}`
          })
          appendSystemSegment(
            `${t('command.help.title')}\n\n${lines.join('\n')}`,
          )
          return true
        }
        case 'lang': {
          const next = args.trim().toLowerCase()
          if (next === 'zh' || next === 'en') {
            setLocale(next)
            return true
          }
          appendSystemSegment(`/lang [en|zh]`, 'error')
          return true
        }
        case 'retry': {
          const lastUser = [...turns].reverse().find((tn) => tn.role === 'user')
          if (lastUser) {
            void runMessage(turnToCopyText(lastUser))
          } else {
            appendSystemSegment(t('command.error.failed'), 'error')
          }
          return true
        }
        default:
          return false
      }
    },
    [commandCatalog, t, setLocale, turns, appendSystemSegment, runMessage],
  )

  const runServerCommand = useCallback(
    async (name: string, args: string) => {
      try {
        const result = await commandsApi.run(name, args, sessionId)
        appendSystemSegment(result.message, result.ok ? 'ok' : 'error')
        if (
          result.ok &&
          result.side_effects &&
          typeof result.side_effects['title'] === 'string'
        ) {
          // Title changed via /title → refresh sidebar so the new name
          // appears immediately.
          void convosApi
            .list()
            .then(setConvos)
            .catch(() => undefined)
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setKeyModal({
            open: true,
            reason: 'session-expired',
            pendingMessage: '',
          })
          return
        }
        const msg = err instanceof Error ? err.message : t('command.error.failed')
        appendSystemSegment(msg, 'error')
      }
    },
    [sessionId, t, appendSystemSegment],
  )

  const dispatchSlash = useCallback(
    async (raw: string) => {
      const stripped = raw.startsWith('/') ? raw.slice(1) : raw
      const [name, ...rest] = stripped.split(/\s+/)
      const args = rest.join(' ').trim()
      const cmd = commandCatalog.find(
        (c) => c.name === name || c.aliases.includes(name),
      )
      if (!cmd) {
        appendSystemSegment(`${t('command.error.unknown')}: /${name}`, 'error')
        return
      }
      if (cmd.client_only) {
        const ok = runClientCommand(cmd.name, args)
        if (!ok) {
          appendSystemSegment(`${t('command.error.unknown')}: /${cmd.name}`, 'error')
        }
        return
      }
      if (!cmd.supported) {
        appendSystemSegment(t('command.popover.hint.not_yet'), 'error')
        return
      }
      await runServerCommand(cmd.name, args)
    },
    [commandCatalog, t, runClientCommand, runServerCommand, appendSystemSegment],
  )

  const uploading = pending.some((p) => p.status === 'uploading')

  const submit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault()
      const message = input.trim()
      if (streaming || uploading) return
      const ready: UploadedFile[] = pending
        .filter((p) => p.status === 'done' && p.path)
        .map((p) => ({ name: p.name, path: p.path as string, size: p.size }))
      // Need either text or at least one uploaded attachment to send.
      if (!message && ready.length === 0) return
      // Slash commands never carry attachments.
      if (message.startsWith('/') && !message.includes('\n') && ready.length === 0) {
        setInput('')
        await dispatchSlash(message)
        return
      }
      setInput('')
      setPending([])
      await runMessage(message, undefined, ready.length ? ready : undefined)
    },
    [input, streaming, uploading, pending, runMessage, dispatchSlash],
  )

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showPopover && (e.key === 'ArrowDown' || e.key === 'ArrowUp' ||
        e.key === 'Tab' || e.key === 'Enter' || e.key === 'Escape')) {
      // Popover's own window listener handles these — don't compete.
      // We still call preventDefault on Enter so the textarea doesn't
      // insert a newline before the popover fires.
      if (e.key === 'Enter') e.preventDefault()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  const stop = () => abortRef.current?.abort()

  const onLoginSuccess = useCallback(() => {
    setKeyModal((prev) => {
      if (!prev.open) return prev
      if (prev.pendingMessage) {
        void runMessage(prev.pendingMessage, [])
      }
      return { open: false }
    })
    void convosApi
      .list()
      .then(setConvos)
      .catch(() => undefined)
    void commandsApi
      .list()
      .then(setCommandCatalog)
      .catch(() => undefined)
  }, [runMessage])

  const onLoginCancel = useCallback(() => {
    setKeyModal({ open: false })
  }, [])

  const handleRetry = useCallback(
    (turn: Turn) => {
      if (streaming) return
      const index = turns.findIndex((t) => t.id === turn.id)
      if (index < 0) return
      // Walk back to the last user turn before this one.
      let userIdx = index
      while (userIdx >= 0 && turns[userIdx].role !== 'user') userIdx--
      if (userIdx < 0) return
      const userMsg = turnToCopyText(turns[userIdx])
      if (!userMsg) return
      // Drop everything from the user message forward and replay it.
      setTurns((prev) => prev.slice(0, userIdx))
      void runMessage(userMsg)
    },
    [streaming, turns, runMessage],
  )

  const handleEdit = useCallback(
    (turn: Turn) => {
      if (streaming) return
      const index = turns.findIndex((t) => t.id === turn.id)
      if (index < 0) return
      setInput(turnToCopyText(turn))
      // Drop the edited turn and everything after — the user will
      // resubmit when they're ready.
      setTurns((prev) => prev.slice(0, index))
    },
    [streaming, turns],
  )

  const composerPlaceholder = showPopover
    ? t('composer.placeholder.slash')
    : t('composer.placeholder')

  return (
    <div className="chat-page">
      <aside className="chat-side">
        <button type="button" className="chat-new" onClick={startNewConversation}>
          {t('chat.new')}
        </button>
        <ConversationList
          conversations={convos}
          archived={archived}
          activeId={sessionId}
          onSelect={(id) => void switchConversation(id)}
          onRename={(id, title) => void handleRename(id, title)}
          onDelete={(id) => void handleDelete(id)}
          onSetFlags={(id, flags) => void handleSetFlags(id, flags)}
          onLoadArchived={loadArchived}
        />
      </aside>

      <section className="chat-main">
        {historyBanner && (
          <div className="chat-banner chat-banner-error" role="alert">
            {historyBanner}
          </div>
        )}
        <div className="chat-transcript" ref={transcriptRef}>
          {turns.length === 0 ? (
            <div className="chat-empty">
              <h2>{t('chat.empty.title')}</h2>
              <p>{t('chat.empty.subtitle')}</p>
            </div>
          ) : (
            turns.map((turn) => (
              <article key={turn.id} className={`turn turn-${turn.role}`}>
                <header className="turn-role">
                  {turn.role === 'user' ? t('chat.role.user') : t('chat.role.assistant')}
                  {turn.usage && turn.role === 'assistant' && (
                    <span className="turn-usage" aria-label="token usage">
                      ↑{turn.usage.input_tokens ?? 0} ↓{turn.usage.output_tokens ?? 0}
                    </span>
                  )}
                </header>
                {turn.role === 'assistant' && (
                  <ActivityLog
                    items={turn.activity}
                    streaming={turn.status === 'streaming'}
                  />
                )}
                {turn.reasoning && (
                  <ReasoningPanel
                    text={turn.reasoning}
                    streaming={turn.status === 'streaming'}
                  />
                )}
                {turn.segments.map((seg, i) => {
                  if (seg.kind === 'tool') {
                    return (
                      <ToolEvent
                        key={`${turn.id}-seg-${i}`}
                        tool={seg.tool}
                        preview={seg.preview}
                        args={seg.args}
                        result_preview={seg.result_preview}
                        duration={seg.duration}
                        error={seg.error}
                      />
                    )
                  }
                  if (seg.kind === 'system') {
                    return (
                      <div
                        key={`${turn.id}-seg-${i}`}
                        className={`turn-system${
                          seg.tone === 'error' ? ' turn-system-error' : ''
                        }`}
                      >
                        <span className="turn-system-prefix">
                          {t('command.system.prefix')}
                        </span>
                        <pre>{seg.text}</pre>
                      </div>
                    )
                  }
                  // text segment
                  return (
                    <div key={`${turn.id}-seg-${i}`} className="turn-text">
                      {turn.role === 'assistant' ? (
                        <MarkdownContent text={seg.text || '…'} />
                      ) : (
                        <div className="turn-content">{seg.text}</div>
                      )}
                    </div>
                  )
                })}
                {turn.attachments && turn.attachments.length > 0 && (
                  <AttachmentList items={turn.attachments} />
                )}
                {turn.status === 'streaming' && turn.segments.length === 0 && (
                  <div className="turn-text">
                    <em>…</em>
                  </div>
                )}
                {turn.status === 'error' && (
                  <div className="turn-error">{turn.errorMessage}</div>
                )}
                {turn.status === 'done' && (
                  <MessageActions
                    copyText={turnToCopyText(turn)}
                    onRetry={
                      turn.role === 'assistant' ? () => handleRetry(turn) : undefined
                    }
                    onEdit={
                      turn.role === 'user' ? () => handleEdit(turn) : undefined
                    }
                  />
                )}
              </article>
            ))
          )}
        </div>

        <form className="composer" onSubmit={submit}>
          <div className="composer-input-wrap">
            {showPopover && (
              <SlashCommandPopover
                query={slashQuery ?? ''}
                commands={commandCatalog}
                onSelect={(cmd) => {
                  const hint = cmd.args_hint && cmd.args_hint.startsWith('<')
                  // For required args, leave the trailing space so the
                  // user starts typing the argument immediately.
                  setInput(`/${cmd.name}${hint ? ' ' : ''}`)
                }}
                onClose={() => setInput('')}
              />
            )}
            <PendingAttachments items={pending} onRemove={removePending} />
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={composerPlaceholder}
              rows={3}
              disabled={streaming}
            />
          </div>
          <div className="composer-actions">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void onPickFiles(e.target.files)
                // Reset so picking the same file again re-triggers onChange.
                e.target.value = ''
              }}
            />
            <button
              type="button"
              className="composer-attach"
              onClick={() => fileInputRef.current?.click()}
              disabled={streaming}
              title={t('attach.button')}
              aria-label={t('attach.button')}
            >
              📎
            </button>
            {streaming ? (
              <button type="button" onClick={stop} className="composer-stop">
                {t('composer.stop')}
              </button>
            ) : (
              <button
                type="submit"
                disabled={
                  (!input.trim() &&
                    !pending.some((p) => p.status === 'done')) ||
                  uploading
                }
                className="composer-send"
              >
                {t('composer.send')}
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

function pushActivity(prev: Turn[], item: ActivityItem): Turn[] {
  return updateAssistant(prev, (turn) => ({
    ...turn,
    activity: [...turn.activity, item],
  }))
}

function appendToken(turn: Turn, text: string): Turn {
  if (!text) return turn
  const segments = [...turn.segments]
  const last = segments[segments.length - 1]
  if (last && last.kind === 'text') {
    segments[segments.length - 1] = { kind: 'text', text: last.text + text }
  } else {
    segments.push({ kind: 'text', text })
  }
  return { ...turn, segments }
}

function turnHasText(turn: Turn): boolean {
  return turn.segments.some((s) => (s.kind === 'text' || s.kind === 'system') && s.text)
}
