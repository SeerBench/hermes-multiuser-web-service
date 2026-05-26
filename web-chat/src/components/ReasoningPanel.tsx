import { useState } from 'react'
import { useT } from '../i18n'
import { MarkdownContent } from './MarkdownContent'

type Props = {
  text: string
  streaming?: boolean
}

/**
 * Collapsible "thinking" panel rendered above the assistant's final
 * text. Defaults to collapsed once the turn is done so the answer is
 * the first thing the user reads; while the model is mid-reasoning we
 * auto-expand so the user can see something is happening.
 */
export function ReasoningPanel({ text, streaming }: Props) {
  const t = useT()
  const [open, setOpen] = useState<boolean>(Boolean(streaming))
  if (!text) return null

  const title = streaming ? t('reasoning.title.streaming') : t('reasoning.title')
  const action = open ? t('reasoning.hide') : t('reasoning.show')

  return (
    <div className={`reasoning-panel${streaming ? ' reasoning-streaming' : ''}`}>
      <button
        type="button"
        className="reasoning-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="reasoning-toggle-title">{title}</span>
        <span className="reasoning-toggle-action">{action}</span>
      </button>
      {open && (
        <div className="reasoning-body">
          <MarkdownContent text={text} compact />
        </div>
      )}
    </div>
  )
}
