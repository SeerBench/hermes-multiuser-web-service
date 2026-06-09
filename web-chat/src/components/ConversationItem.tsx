import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { ConversationSummary } from '../api'
import { timeAgo } from '../format'
import { useT } from '../i18n'

type Props = {
  convo: ConversationSummary
  active: boolean
  archived?: boolean
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onSetFlags: (id: string, flags: { pinned?: boolean; archived?: boolean }) => void
}

/**
 * One sidebar conversation row with a hover "⋯" menu: rename (inline),
 * pin / archive toggle, and delete (with inline confirm).  Archived rows
 * only offer unarchive + delete.
 */
export function ConversationItem({
  convo,
  active,
  archived,
  onSelect,
  onRename,
  onDelete,
  onSetFlags,
}: Props) {
  const t = useT()
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(convo.title ?? '')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const rootRef = useRef<HTMLLIElement | null>(null)

  // Close the menu on any outside click.
  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
        setConfirmDelete(false)
      }
    }
    window.addEventListener('mousedown', onDoc)
    return () => window.removeEventListener('mousedown', onDoc)
  }, [menuOpen])

  const startRename = () => {
    setRenameValue(convo.title ?? '')
    setRenaming(true)
    setMenuOpen(false)
  }

  const commitRename = () => {
    const v = renameValue.trim()
    setRenaming(false)
    if (v && v !== (convo.title ?? '')) onRename(convo.id, v)
  }

  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setRenaming(false)
    }
  }

  if (renaming) {
    return (
      <li className="convo-item convo-renaming" ref={rootRef}>
        <input
          className="convo-rename-input"
          value={renameValue}
          autoFocus
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={onRenameKey}
          onBlur={commitRename}
        />
      </li>
    )
  }

  return (
    <li className={`convo-item${active ? ' convo-active' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="convo-open"
        onClick={() => onSelect(convo.id)}
      >
        <div className="convo-title">
          {convo.pinned && (
            <span className="convo-pin" aria-hidden>
              📌{' '}
            </span>
          )}
          {convo.title ?? convo.preview ?? t('convo.untitled')}
        </div>
        <div className="convo-meta">
          {timeAgo(convo.last_active, t)} · {convo.message_count}{' '}
          {t('convo.msgs.suffix')}
        </div>
      </button>
      <button
        type="button"
        className="convo-menu-btn"
        aria-label={t('convo.menu')}
        onClick={(e) => {
          e.stopPropagation()
          setMenuOpen((v) => !v)
        }}
      >
        ⋯
      </button>
      {menuOpen && (
        <div className="convo-menu" role="menu">
          {!archived && (
            <>
              <button type="button" onClick={startRename}>
                {t('convo.action.rename')}
              </button>
              <button
                type="button"
                onClick={() => {
                  onSetFlags(convo.id, { pinned: !convo.pinned })
                  setMenuOpen(false)
                }}
              >
                {convo.pinned ? t('convo.action.unpin') : t('convo.action.pin')}
              </button>
              <button
                type="button"
                onClick={() => {
                  onSetFlags(convo.id, { archived: true })
                  setMenuOpen(false)
                }}
              >
                {t('convo.action.archive')}
              </button>
            </>
          )}
          {archived && (
            <button
              type="button"
              onClick={() => {
                onSetFlags(convo.id, { archived: false })
                setMenuOpen(false)
              }}
            >
              {t('convo.action.unarchive')}
            </button>
          )}
          {confirmDelete ? (
            <button
              type="button"
              className="convo-menu-danger"
              onClick={() => {
                onDelete(convo.id)
                setMenuOpen(false)
                setConfirmDelete(false)
              }}
            >
              {t('convo.action.delete.confirm')}
            </button>
          ) : (
            <button
              type="button"
              className="convo-menu-danger"
              onClick={() => setConfirmDelete(true)}
            >
              {t('convo.action.delete')}
            </button>
          )}
        </div>
      )}
    </li>
  )
}
