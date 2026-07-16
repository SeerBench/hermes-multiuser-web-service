import { useState } from 'react'
import {
  Check,
  Download,
  Maximize2,
  Menu,
  Minimize2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Share2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useT } from '../i18n'
import type { LayoutWidth } from '../layoutWidthStorage'

/** Session title bar: sidebar toggle + title + overflow menu. */
export function ConversationHeader({
  title,
  pinned,
  chatWidth,
  skillsCount,
  isNewConversation = false,
  onOpenSidebar,
  onRename,
  onTogglePin,
  onToggleChatWidth,
  onShareConversation,
  onExportConversation,
}: {
  title: string
  pinned: boolean
  chatWidth: LayoutWidth
  skillsCount?: number
  /** New chat: hide title/skill metadata and expose width as a direct action. */
  isNewConversation?: boolean
  /** Mobile: open conversation list drawer. */
  onOpenSidebar?: () => void
  onRename?: (title: string) => void
  onTogglePin?: () => void
  onToggleChatWidth: () => void
  onShareConversation?: () => void
  onExportConversation?: () => void
}) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)

  const startEdit = () => {
    setDraft(title)
    setEditing(true)
  }

  const commit = () => {
    const next = draft.trim()
    setEditing(false)
    if (next && next !== title) onRename?.(next)
  }

  const showSessionActions = Boolean(onRename && onTogglePin)

  return (
    <div className="conversation-header">
      {onOpenSidebar && (
        <button
          type="button"
          className="chat-sidebar-toggle"
          aria-label={t('chat.openSidebar')}
          onClick={onOpenSidebar}
        >
          <Menu className="size-5" aria-hidden />
        </button>
      )}

      {isNewConversation ? (
        <>
          <span className="conversation-header-spacer" />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="conversation-header-menu"
            aria-label={
              chatWidth === 'full'
                ? t('layout.width.standard')
                : t('layout.width.expand')
            }
            title={
              chatWidth === 'full'
                ? t('layout.width.standard')
                : t('layout.width.expand')
            }
            onClick={onToggleChatWidth}
          >
            {chatWidth === 'full' ? (
              <Minimize2 className="size-4" aria-hidden />
            ) : (
              <Maximize2 className="size-4" aria-hidden />
            )}
          </Button>
        </>
      ) : editing ? (
        <form
          className="conversation-header-edit"
          onSubmit={(e) => {
            e.preventDefault()
            commit()
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            maxLength={200}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setEditing(false)
                setDraft(title)
              }
            }}
            aria-label={t('chat.title.edit')}
          />
          <Button type="submit" size="icon-sm" variant="ghost">
            <Check className="size-4" />
          </Button>
        </form>
      ) : (
        <>
          <h2 className="conversation-header-title" title={title}>
            {pinned && <Pin className="size-3.5 shrink-0 opacity-70" aria-hidden />}
            <span className="truncate">{title}</span>
          </h2>
          {typeof skillsCount === 'number' && skillsCount > 0 && (
            <span className="conversation-header-skills">
              {t('chat.skills.count', { count: skillsCount })}
            </span>
          )}
          {showSessionActions && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="conversation-header-menu"
                  aria-label={t('chat.title.menu')}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuItem onClick={startEdit}>
                  <Pencil className="size-4" />
                  {t('chat.title.edit')}
                </DropdownMenuItem>
                {onShareConversation && (
                  <DropdownMenuItem onClick={onShareConversation}>
                    <Share2 className="size-4" />
                    {t('chat.share')}
                  </DropdownMenuItem>
                )}
                {onExportConversation && (
                  <DropdownMenuItem onClick={onExportConversation}>
                    <Download className="size-4" />
                    {t('chat.export')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={onToggleChatWidth}>
                  {chatWidth === 'full'
                    ? t('layout.width.standard')
                    : t('layout.width.expand')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onTogglePin?.()}>
                  {pinned ? (
                    <PinOff className="size-4" />
                  ) : (
                    <Pin className="size-4" />
                  )}
                  {pinned ? t('convo.action.unpin') : t('convo.action.pin')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </>
      )}
    </div>
  )
}
