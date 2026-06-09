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

// Pull a renderable image URL out of an image_generate tool result.
// Scoped to that tool so we never turn an arbitrary URL from some other
// tool's output into an <img>. Only http(s) URLs are accepted (no data:/
// javascript:), and we fall back to a regex when the preview was truncated
// past the closing brace so the JSON no longer parses.
function extractImageUrl(tool: string, result?: string): string | null {
  if (tool !== 'image_generate' || !result) return null
  let url: unknown = null
  try {
    const parsed = JSON.parse(result)
    if (parsed && typeof parsed === 'object' && (parsed as any).success) {
      url = (parsed as any).image
    }
  } catch {
    const m = result.match(/"image"\s*:\s*"(https?:\/\/[^"\\]+)"/)
    if (m) url = m[1]
  }
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null
}
