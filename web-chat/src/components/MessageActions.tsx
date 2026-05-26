import { useState } from 'react'
import { useT } from '../i18n'

type Props = {
  // The plaintext representation of the turn — what gets copied to
  // clipboard. Callers stitch text + tool segments into a single
  // string so the copy is actually useful (no [object Object]).
  copyText: string
  // Optional actions: assistant turns expose Retry, user turns expose
  // Edit. The caller decides which to show by passing handlers.
  onRetry?: () => void
  onEdit?: () => void
}

/**
 * Hover-revealed action strip rendered in a message's top-right
 * corner. Designed to be quiet when the user isn't looking at it
 * and obvious when they are.
 */
export function MessageActions({ copyText, onRetry, onEdit }: Props) {
  const t = useT()
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(copyText)
      } else {
        // Old browsers / non-secure contexts — fall back to a
        // throwaway textarea trick. Best-effort.
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
      // ignore — copy is best-effort
    }
  }

  return (
    <div className="msg-actions" role="group">
      <button
        type="button"
        onClick={copy}
        className={copied ? 'msg-action-copied' : ''}
        title={t(copied ? 'actions.copied' : 'actions.copy')}
      >
        {copied ? t('actions.copied') : t('actions.copy')}
      </button>
      {onRetry && (
        <button type="button" onClick={onRetry} title={t('actions.retry')}>
          {t('actions.retry')}
        </button>
      )}
      {onEdit && (
        <button type="button" onClick={onEdit} title={t('actions.edit')}>
          {t('actions.edit')}
        </button>
      )}
    </div>
  )
}
