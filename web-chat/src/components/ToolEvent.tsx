import { useState } from 'react'
import { useT } from '../i18n'
import { extractImageUrl, prettyJson } from '../toolEventUtils'

type Props = {
  tool: string
  preview: string
  args?: string
  result_preview?: string
  duration?: number
  error?: boolean
}

/**
 * One tool invocation rendered inline with the assistant's prose.
 * Collapsed by default — a single-line badge showing tool name +
 * args preview + status. Click to expand for full arguments and the
 * tool's result.
 */
export function ToolEvent({ tool, preview, args, result_preview, duration, error }: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const finished = duration != null
  const status = finished
    ? error
      ? t('tool.status.failed')
      : `${(duration ?? 0).toFixed(2)}s`
    : t('tool.status.running')

  const canToggle = finished && (Boolean(args) || Boolean(result_preview))

  // Fallback image rendering: image_generate returns its picture only as a URL
  // inside the tool result. Surface it as an actual <img> so the user sees the
  // image even when the model forgets to inline ![](url) in its prose reply.
  // (The primary path is the agent embedding the Markdown — see the web
  // platform prompt addendum — but this guards against non-compliance.)
  const imageUrl = !error && finished ? extractImageUrl(tool, result_preview) : null

  return (
    <div className={`tool-event ${error ? 'tool-error' : ''}${open ? ' tool-open' : ''}`}>
      <button
        type="button"
        className="tool-event-row"
        onClick={canToggle ? () => setOpen((v) => !v) : undefined}
        aria-expanded={open}
        disabled={!canToggle}
        title={canToggle ? (open ? t('tool.hide.details') : t('tool.show.details')) : undefined}
      >
        <span className="tool-name">{tool}</span>
        {preview && <span className="tool-preview">{preview}</span>}
        <span className="tool-status">{status}</span>
        {canToggle && (
          <span className="tool-event-caret" aria-hidden>
            {open ? '▾' : '▸'}
          </span>
        )}
      </button>
      {imageUrl && (
        <a
          className="tool-image-link"
          href={imageUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          <img className="tool-image" src={imageUrl} alt={t('tool.image.alt')} loading="lazy" />
        </a>
      )}
      {open && (
        <div className="tool-event-details">
          {args ? (
            <details open className="tool-event-section">
              <summary>{t('tool.args.heading')}</summary>
              <pre className="tool-event-pre">{prettyJson(args)}</pre>
            </details>
          ) : null}
          <details open className="tool-event-section">
            <summary>{t('tool.result.heading')}</summary>
            <pre className="tool-event-pre">
              {result_preview ? result_preview : t('tool.result.empty')}
            </pre>
          </details>
        </div>
      )}
    </div>
  )
}
