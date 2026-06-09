import { useState } from 'react'
import type { ConversationSummary } from '../api'
import { useT } from '../i18n'
import { ConversationItem } from './ConversationItem'

type Props = {
  conversations: ConversationSummary[]
  archived: ConversationSummary[]
  activeId: string | null
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onSetFlags: (id: string, flags: { pinned?: boolean; archived?: boolean }) => void
  onLoadArchived: () => void
}

export function ConversationList({
  conversations,
  archived,
  activeId,
  onSelect,
  onRename,
  onDelete,
  onSetFlags,
  onLoadArchived,
}: Props) {
  const t = useT()
  const [showArchived, setShowArchived] = useState(false)

  const toggleArchived = () => {
    const next = !showArchived
    setShowArchived(next)
    if (next) onLoadArchived()
  }

  return (
    <div className="convo-wrap">
      {conversations.length === 0 ? (
        <p className="convo-empty">{t('convo.empty')}</p>
      ) : (
        <ul className="convo-list">
          {conversations.map((c) => (
            <ConversationItem
              key={c.id}
              convo={c}
              active={c.id === activeId}
              onSelect={onSelect}
              onRename={onRename}
              onDelete={onDelete}
              onSetFlags={onSetFlags}
            />
          ))}
        </ul>
      )}

      <button
        type="button"
        className="convo-archived-toggle"
        onClick={toggleArchived}
        aria-expanded={showArchived}
      >
        <span>{t('convo.archived.title')}</span>
        <span className="activity-caret" aria-hidden>
          {showArchived ? '▾' : '▸'}
        </span>
      </button>
      {showArchived &&
        (archived.length === 0 ? (
          <p className="convo-empty">{t('convo.archived.empty')}</p>
        ) : (
          <ul className="convo-list">
            {archived.map((c) => (
              <ConversationItem
                key={c.id}
                convo={c}
                active={c.id === activeId}
                archived
                onSelect={onSelect}
                onRename={onRename}
                onDelete={onDelete}
                onSetFlags={onSetFlags}
              />
            ))}
          </ul>
        ))}
    </div>
  )
}
