import type { ConversationSummary } from '../api'

type Props = {
  conversations: ConversationSummary[]
  activeId: string | null
  onSelect: (id: string) => void
}

export function ConversationList({ conversations, activeId, onSelect }: Props) {
  if (conversations.length === 0) {
    return <p className="convo-empty">No conversations yet.</p>
  }
  return (
    <ul className="convo-list">
      {conversations.map((c) => (
        <li
          key={c.id}
          className={c.id === activeId ? 'convo-active' : ''}
          onClick={() => onSelect(c.id)}
        >
          <div className="convo-title">
            {c.title ?? c.preview ?? '(untitled)'}
          </div>
          <div className="convo-meta">
            {timeAgo(c.last_active)} · {c.message_count} msgs
          </div>
        </li>
      ))}
    </ul>
  )
}

function timeAgo(ts: number): string {
  const now = Date.now() / 1000
  const dt = Math.max(0, now - ts)
  if (dt < 60) return 'just now'
  if (dt < 3600) return `${Math.floor(dt / 60)}m ago`
  if (dt < 86_400) return `${Math.floor(dt / 3600)}h ago`
  const days = Math.floor(dt / 86_400)
  if (days < 30) return `${days}d ago`
  return new Date(ts * 1000).toLocaleDateString()
}
