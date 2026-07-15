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
  UploadedFile,
} from '../api'
import { ChatComposer } from '../components/ChatComposer'
import type { PendingAttachment } from '../components/AttachmentChips'
import { ChatTurnBubble } from '../components/ChatTurnBubble'
import { ConversationHeader } from '../components/ConversationHeader'
import { ConversationList } from '../components/ConversationList'
import { KeyPromptModal } from '../components/KeyPromptModal'
import {
  getStoredWorkspaceId,
  platform,
} from '../platformClient'
import {
  appendToken,
  pushActivity,
  turnHasText,
  updateAssistant,
} from '../chatStreamHelpers'
import {
  attachmentNote,
  messagesToTurns,
  newTurnId,
  turnToCopyText,
  type ToolSegment,
  type Turn,
} from '../chatTurns'
import { provisionalTitleFromMessage } from '../conversationTitle'
import {
  getChatWidth,
  setChatWidth,
  toggleExpanded,
  widthClass,
  type LayoutWidth,
} from '../layoutWidthStorage'
import { consumeFilesForChat } from '../attachBridge'
import { ChatEmptyGuide } from '../components/ChatEmptyGuide'
import { routeHref } from '../routing'
import { useLocale, useT } from '../i18n'
import type { Locale } from '../i18n'
import { cn } from '@/lib/utils'

type KeyModalState =
  | { open: false }
  | {
      open: true
      reason: 'first-message' | 'session-expired'
      pendingMessage: string
    }

export function ChatPage({
  platformMode = false,
  signedIn = false,
  needsBindKey = false,
  onGoBindSettings,
}: {
  platformMode?: boolean
  signedIn?: boolean
  needsBindKey?: boolean
  onGoBindSettings?: () => void
} = {}) {
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
  const [sideOpen, setSideOpen] = useState(false)
  const [selectedModel, setSelectedModel] = useState('')
  const [models, setModels] = useState<{ id: string; owned_by?: string }[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [enabledSkillsCount, setEnabledSkillsCount] = useState(0)
  const [chatWidth, setChatWidthState] = useState<LayoutWidth>(() => getChatWidth())
  const [transcriptScrolling, setTranscriptScrolling] = useState(false)
  const workspaceId = getStoredWorkspaceId()
  const abortRef = useRef<AbortController | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const scrollHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Reveal scrollbar only while the transcript is being scrolled. */
  const onTranscriptScroll = useCallback(() => {
    setTranscriptScrolling(true)
    if (scrollHideTimerRef.current) clearTimeout(scrollHideTimerRef.current)
    scrollHideTimerRef.current = setTimeout(() => {
      setTranscriptScrolling(false)
      scrollHideTimerRef.current = null
    }, 800)
  }, [])

  useEffect(() => {
    return () => {
      if (scrollHideTimerRef.current) clearTimeout(scrollHideTimerRef.current)
    }
  }, [])

  // Probe auth + initial data.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        if (!signedIn) {
          await auth.me()
        } else {
          // Platform session — cookie already issued; load conversations.
          try {
            await auth.me()
          } catch {
            // Gateway may still accept the shared platform session cookie.
          }
        }
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
        if (signedIn) return
        if (err instanceof ApiError && err.status === 401) {
          setKeyModal({ open: true, reason: 'first-message', pendingMessage: '' })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [signedIn])

  // Platform: load models + skill count for composer chrome.
  useEffect(() => {
    if (!platformMode || !workspaceId) return
    setModelsLoading(true)
    void platform
      .listModels(workspaceId)
      .then((res) => {
        setModels(res.models ?? [])
        const pref =
          res.preferred_model?.trim() ||
          res.default_model?.trim() ||
          res.models[0]?.id ||
          ''
        setSelectedModel(pref)
      })
      .catch(() => undefined)
      .finally(() => setModelsLoading(false))

    void platform
      .listSkills(workspaceId)
      .then((rows) =>
        setEnabledSkillsCount(rows.filter((s) => s.enabled !== false).length),
      )
      .catch(() => undefined)
  }, [platformMode, workspaceId])

  // Files page → chat bridge (sessionStorage, consumed once on mount).
  useEffect(() => {
    const bridged = consumeFilesForChat()
    if (bridged.length === 0) return
    setPending((prev) => [
      ...prev,
      ...bridged.map((f) => ({
        id: newTurnId(),
        name: f.name,
        size: f.size,
        path: f.path,
        status: 'done' as const,
      })),
    ])
  }, [])

  const handleModelChange = useCallback(
    async (model: string) => {
      setSelectedModel(model)
      if (!workspaceId) return
      try {
        await platform.patchPreferences(workspaceId, { preferred_model: model })
      } catch {
        // keep local selection even if persist fails
      }
    },
    [workspaceId],
  )

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
      setConvos((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title } : c)),
      )
      try {
        await convosApi.rename(id, title)
      } catch {
        // Non-fatal — leave the optimistic title; refresh may correct.
      }
      refreshConvos()
      loadArchived()
    },
    [refreshConvos, loadArchived],
  )

  const activeConvo = useMemo(
    () =>
      convos.find((c) => c.id === sessionId) ??
      archived.find((c) => c.id === sessionId) ??
      null,
    [convos, archived, sessionId],
  )

  const toggleChatWidth = useCallback(() => {
    setChatWidthState((prev) => {
      const next = toggleExpanded('reading', prev)
      setChatWidth(next)
      return next
    })
  }, [])

  const ensureProvisionalTitle = useCallback(
    async (sid: string, message: string) => {
      const existing =
        convos.find((c) => c.id === sid)?.title ??
        archived.find((c) => c.id === sid)?.title
      if (existing) return
      const provisional = provisionalTitleFromMessage(message)
      if (!provisional) return
      await handleRename(sid, provisional)
    },
    [convos, archived, handleRename],
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
      if (needsBindKey) {
        onGoBindSettings?.()
        return
      }
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
            model: selectedModel || undefined,
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
          } else if (ev.type === 'title') {
            setSessionId(ev.session_id)
            setConvos((prev) =>
              prev.map((c) =>
                c.id === ev.session_id ? { ...c, title: ev.title } : c,
              ),
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
            void ensureProvisionalTitle(ev.session_id, message)
            void convosApi
              .list()
              .then(setConvos)
              .catch(() => undefined)
            // LLM auto-title may land a few seconds later — refresh again.
            window.setTimeout(() => {
              void convosApi
                .list()
                .then(setConvos)
                .catch(() => undefined)
            }, 4000)
          } else if (ev.type === 'error') {
            if (
              ev.code === 'unauthorized' ||
              ev.code === 'session_expired'
            ) {
              setTurns((prev) => prev.slice(0, -2))
              setKeyModal({
                open: true,
                reason:
                  ev.code === 'session_expired' ? 'session-expired' : 'first-message',
                pendingMessage: message,
              })
              return
            }
            if (ev.code === 'upstream_key_required') {
              setTurns((prev) => prev.slice(0, -2))
              onGoBindSettings?.()
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
    [sessionId, turns, t, needsBindKey, onGoBindSettings, selectedModel, ensureProvisionalTitle],
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

  const onAttachWorkspaceFiles = useCallback(
    (files: { name: string; path: string; size: number }[]) => {
      const entries: PendingAttachment[] = files.map((f) => ({
        id: newTurnId(),
        name: f.name,
        size: f.size,
        status: 'done',
        path: f.path,
      }))
      setPending((prev) => [...prev, ...entries])
    },
    [],
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

  const closeSidebar = () => setSideOpen(false)

  const selectConversation = (id: string) => {
    void switchConversation(id)
    closeSidebar()
  }

  const handleNewChat = () => {
    startNewConversation()
    closeSidebar()
  }

  return (
    <div className="chat-page">
      {sideOpen && (
        <button
          type="button"
          className="chat-side-backdrop"
          aria-label={t('chat.closeSidebar')}
          onClick={closeSidebar}
        />
      )}
      <aside className={`chat-side${sideOpen ? ' chat-side-open' : ''}`}>
        <button type="button" className="chat-new" onClick={handleNewChat}>
          {t('chat.new')}
        </button>
        <ConversationList
          conversations={convos}
          archived={archived}
          activeId={sessionId}
          onSelect={selectConversation}
          onRename={(id, title) => void handleRename(id, title)}
          onDelete={(id) => void handleDelete(id)}
          onSetFlags={(id, flags) => void handleSetFlags(id, flags)}
          onLoadArchived={loadArchived}
        />
      </aside>

      <section className="chat-main">
        <div className="chat-main-toolbar">
          <button
            type="button"
            className="chat-sidebar-toggle"
            aria-label={t('chat.openSidebar')}
            onClick={() => setSideOpen(true)}
          >
            ☰
          </button>
        </div>
        {needsBindKey && (
          <div className="chat-banner chat-banner-warn" role="status">
            <span>{t('bindBanner.chatHint')}</span>
            {onGoBindSettings && (
              <button type="button" className="link-btn" onClick={onGoBindSettings}>
                {t('bindBanner.action')}
              </button>
            )}
          </div>
        )}
        {historyBanner && (
          <div className="chat-banner chat-banner-error" role="alert">
            {historyBanner}
          </div>
        )}
        {/* Header + transcript + composer share one centered reading/full column */}
        <div className={cn('chat-column', widthClass(chatWidth))}>
          {(turns.length > 0 && sessionId) || enabledSkillsCount > 0 ? (
            turns.length > 0 && sessionId ? (
              <ConversationHeader
                title={
                  activeConvo?.title?.trim() ||
                  t('convo.untitled')
                }
                pinned={Boolean(activeConvo?.pinned)}
                chatWidth={chatWidth}
                skillsCount={enabledSkillsCount}
                onRename={(title) => void handleRename(sessionId, title)}
                onTogglePin={() =>
                  void handleSetFlags(sessionId, {
                    pinned: !activeConvo?.pinned,
                  })
                }
                onToggleChatWidth={toggleChatWidth}
              />
            ) : (
              <div className="conversation-header conversation-header--meta">
                <span className="conversation-header-skills">
                  {t('chat.skills.count', { count: enabledSkillsCount })}
                </span>
              </div>
            )
          ) : null}
          <div
            className={cn(
              'chat-transcript',
              transcriptScrolling && 'chat-transcript--scrolling',
            )}
            ref={transcriptRef}
            onScroll={onTranscriptScroll}
          >
            {turns.length === 0 ? (
              <ChatEmptyGuide
                platformMode={platformMode}
                needsBindKey={needsBindKey}
                hasModel={Boolean(selectedModel)}
                enabledSkillsCount={enabledSkillsCount}
                onPickSuggestion={setInput}
                onGoFiles={() => {
                  window.location.hash = routeHref('files')
                }}
                onGoSkills={() => {
                  window.location.hash = routeHref('skills')
                }}
                onGoSettings={onGoBindSettings}
              />
            ) : (
              turns.map((turn) => (
                <ChatTurnBubble
                  key={turn.id}
                  turn={turn}
                  onRetry={
                    turn.role === 'assistant'
                      ? () => handleRetry(turn)
                      : undefined
                  }
                  onEdit={
                    turn.role === 'user' ? () => handleEdit(turn) : undefined
                  }
                />
              ))
            )}
          </div>

          <ChatComposer
            input={input}
            onInputChange={setInput}
            onSubmit={submit}
            onKeyDown={onKeyDown}
            streaming={streaming}
            uploading={uploading}
            pending={pending}
            onRemovePending={removePending}
            onPickFiles={onPickFiles}
            onAttachWorkspaceFiles={onAttachWorkspaceFiles}
            onStop={stop}
            placeholder={composerPlaceholder}
            showSlashPopover={showPopover}
            slashQuery={slashQuery}
            commandCatalog={commandCatalog}
            onSlashSelect={(cmd) => {
              const hint = cmd.args_hint && cmd.args_hint.startsWith('<')
              setInput(`/${cmd.name}${hint ? ' ' : ''}`)
            }}
            onSlashClose={() => setInput('')}
            platformMode={platformMode}
            workspaceId={workspaceId}
            models={models}
            selectedModel={selectedModel}
            onModelChange={handleModelChange}
            modelsLoading={modelsLoading}
            enabledSkillsCount={enabledSkillsCount}
            onNavigate={(route) => {
              window.location.hash = `#/${route}`
            }}
          />
        </div>
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
