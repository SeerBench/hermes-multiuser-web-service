// 将服务端消息历史转换为可渲染的对话轮次（从 ChatPage 抽离，便于单测）。
import type { ServerMessage, UploadedFile } from './api'
import type { ActivityItem } from './components/ActivityLog'
import { formatBytes } from './format'
import type { Translator } from './i18n'

export type ToolSegment = {
  kind: 'tool'
  id: string | null
  tool: string
  preview: string
  args: string
  result_preview?: string
  duration?: number
  error?: boolean
}

export type Segment =
  | { kind: 'text'; text: string }
  | ToolSegment
  | { kind: 'system'; text: string; tone?: 'ok' | 'error' }

export type Turn = {
  id: string
  role: 'user' | 'assistant'
  segments: Segment[]
  reasoning?: string
  status: 'streaming' | 'done' | 'error'
  errorMessage?: string
  usage?: Record<string, number>
  activity: ActivityItem[]
  attachments?: UploadedFile[]
}

/** 附件引用块：告知 agent 用 web_file_read 读取已上传文件。 */
export function attachmentNote(t: Translator, files: UploadedFile[]): string {
  const lines = files.map((f) => `- ${f.path} (${formatBytes(f.size)})`)
  return `\n\n${t('attach.inject.header')}\n${lines.join('\n')}`
}

/** 生成轮次 ID；非安全上下文下回退到时间戳 + 随机后缀。 */
export function newTurnId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 服务端历史消息 → 可渲染 Turn[]。 */
export function messagesToTurns(messages: ServerMessage[]): Turn[] {
  const turns: Turn[] = []
  let assistantTurn: Turn | null = null

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

/** 拼接轮次文本段，供剪贴板复制使用。 */
export function turnToCopyText(turn: Turn): string {
  return turn.segments
    .filter((s): s is Exclude<Segment, ToolSegment> => s.kind !== 'tool')
    .map((s) => s.text)
    .join('\n')
    .trim()
}
