import type { UploadedFile } from '../api'
import { formatBytes } from '../format'
import { useT } from '../i18n'

// A file selected in the composer, tracked through its upload lifecycle.
export type PendingAttachment = {
  id: string
  name: string
  size: number
  path?: string
  status: 'uploading' | 'done' | 'error'
  error?: string
}

type PendingProps = {
  items: PendingAttachment[]
  onRemove: (id: string) => void
}

/** Editable attachment strip shown above the composer textarea. */
export function PendingAttachments({ items, onRemove }: PendingProps) {
  const t = useT()
  if (items.length === 0) return null
  return (
    <div className="attach-strip">
      {items.map((a) => (
        <span
          key={a.id}
          className={`attach-chip attach-${a.status}`}
          title={a.error || a.name}
        >
          <span className="attach-icon" aria-hidden>
            📎
          </span>
          <span className="attach-name">{a.name}</span>
          <span className="attach-size">
            {a.status === 'uploading'
              ? t('attach.uploading')
              : a.status === 'error'
                ? t('attach.failed')
                : formatBytes(a.size)}
          </span>
          <button
            type="button"
            className="attach-remove"
            onClick={() => onRemove(a.id)}
            aria-label={t('attach.remove')}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
}

/** Read-only attachment chips rendered on a sent user turn. */
export function AttachmentList({ items }: { items: UploadedFile[] }) {
  if (!items || items.length === 0) return null
  return (
    <div className="attach-strip attach-strip-readonly">
      {items.map((a, i) => (
        <span key={i} className="attach-chip attach-done" title={a.path}>
          <span className="attach-icon" aria-hidden>
            📎
          </span>
          <span className="attach-name">{a.name}</span>
          <span className="attach-size">{formatBytes(a.size)}</span>
        </span>
      ))}
    </div>
  )
}
