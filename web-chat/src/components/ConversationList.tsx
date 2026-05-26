import type { ConversationSummary } from '../api'
import { useT } from '../i18n'
import type { Translator } from '../i18n'

type Props = {
  conversations: ConversationSummary[]
  activeId: string | null
  onSelect: (id: string) => void
}

export function ConversationList({ conversations, activeId, onSelect }: Props) {
  const t = useT()
  if (conversations.length === 0) {
    return <p className="convo-empty">{t('convo.empty')}</p>
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
            {c.title ?? c.preview ?? t('convo.untitled')}
          </div>
          <div className="convo-meta">
            {timeAgo(c.last_active, t)} · {c.message_count} {t('convo.msgs.suffix')}
          </div>
        </li>
      ))}
    </ul>
  )
}

function timeAgo(ts: number, t: Translator): string {
  const now = Date.now() / 1000
  const dt = Math.max(0, now - ts)
  if (dt < 60) return t('convo.timeago.just_now')
  if (dt < 3600) return t('convo.timeago.minutes', { n: Math.floor(dt / 60) })
  if (dt < 86_400) return t('convo.timeago.hours', { n: Math.floor(dt / 3600) })
  const days = Math.floor(dt / 86_400)
  if (days < 30) return t('convo.timeago.days', { n: days })
  return new Date(ts * 1000).toLocaleDateString()
}
