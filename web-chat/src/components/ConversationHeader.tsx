import { useState } from 'react'
import { Check, ChevronDown, Download, Pencil, Pin, PinOff, Share2 } from 'lucide-react'
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

/** Session title bar + actions (rename / widen / pin / share). */
export function ConversationHeader({
  title,
  pinned,
  chatWidth,
  skillsCount,
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
  onRename: (title: string) => void
  onTogglePin: () => void
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
    if (next && next !== title) onRename(next)
  }

  return (
    <div className="conversation-header">
      {editing ? (
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('chat.title.menu')}
              >
                <ChevronDown className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-48">
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
              <DropdownMenuItem onClick={onTogglePin}>
                {pinned ? (
                  <PinOff className="size-4" />
                ) : (
                  <Pin className="size-4" />
                )}
                {pinned ? t('convo.action.unpin') : t('convo.action.pin')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  )
}
