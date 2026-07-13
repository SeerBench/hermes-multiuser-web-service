// 聊天流式更新辅助函数（从 ChatPage 抽离，便于单测）。
import type { ActivityItem } from './components/ActivityLog'
import type { Turn } from './chatTurns'

/** 更新最后一个 assistant 轮次；非 assistant 时原样返回。 */
export function updateAssistant(
  prev: Turn[],
  fn: (t: Turn) => Turn,
): Turn[] {
  if (prev.length === 0) return prev
  const last = prev[prev.length - 1]
  if (last.role !== 'assistant') return prev
  return [...prev.slice(0, -1), fn(last)]
}

/** 向当前 assistant 轮次追加活动日志条目。 */
export function pushActivity(prev: Turn[], item: ActivityItem): Turn[] {
  return updateAssistant(prev, (turn) => ({
    ...turn,
    activity: [...turn.activity, item],
  }))
}

/** 将 token 文本追加到 assistant 轮次的最后一个文本段。 */
export function appendToken(turn: Turn, text: string): Turn {
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

/** 轮次是否包含可复制的文本内容。 */
export function turnHasText(turn: Turn): boolean {
  return turn.segments.some(
    (s) => (s.kind === 'text' || s.kind === 'system') && s.text,
  )
}
