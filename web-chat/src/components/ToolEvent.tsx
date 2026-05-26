import { useState } from 'react'
import { useT } from '../i18n'

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

function prettyJson(input: string): string {
  // Best-effort: if the args round-trip as JSON, pretty-print them;
  // otherwise show as-is. We never throw — the user just sees what
  // the agent supplied.
  try {
    const parsed = JSON.parse(input)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return input
  }
}
