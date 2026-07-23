import { useState } from 'react'
import type { ReactNode } from 'react'
import { Copy, Pencil, RotateCcw, Share2 } from 'lucide-react'
import { useT } from '../i18n'
import { cn } from '@/lib/utils'

type Props = {
  copyText: string
  onRetry?: () => void
  onEdit?: () => void
  /** Assistant: share this reply (opens confirm → static link). */
  shareable?: boolean
  /** Called when the user clicks Share (parent owns confirm dialog). */
  onShare?: () => void
}

type ActionBtnProps = {
  label: string
  onClick: () => void
  active?: boolean
  children: ReactNode
}

/** Icon + hover-expanded label action button. */
function ActionBtn({ label, onClick, active, children }: ActionBtnProps) {
  return (
    <button
      type="button"
      className={cn('msg-action', active && 'msg-action--active')}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {children}
      <span className="msg-action-label">{label}</span>
    </button>
  )
}

/**
 * Message footer actions: icon by default, label expands on hover.
 * Assistant: Copy / Share (/ Retry). User: Copy / Edit.
 */
export function MessageActions({
  copyText,
  onRetry,
  onEdit,
  shareable = false,
  onShare,
}: Props) {
  const t = useT()
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(copyText)
      } else {
        const ta = document.createElement('textarea')
        ta.value = copyText
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  return (
    <div className="msg-actions" role="group">
      <ActionBtn
        label={t(copied ? 'actions.copied' : 'actions.copy')}
        onClick={() => void copy()}
        active={copied}
      >
        <Copy className="size-3.5" aria-hidden />
      </ActionBtn>

      {shareable && onShare && (
        <ActionBtn label={t('actions.share')} onClick={onShare}>
          <Share2 className="size-3.5" aria-hidden />
        </ActionBtn>
      )}

      {onRetry && (
        <ActionBtn label={t('actions.retry')} onClick={onRetry}>
          <RotateCcw className="size-3.5" aria-hidden />
        </ActionBtn>
      )}

      {onEdit && (
        <ActionBtn label={t('actions.edit')} onClick={onEdit}>
          <Pencil className="size-3.5" aria-hidden />
        </ActionBtn>
      )}
    </div>
  )
}
