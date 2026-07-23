import { useState } from 'react'
import { useT } from '../i18n'
import {
  extractImageUrl,
  extractWebSearchSummary,
  prettyJson,
  type WebSearchSummary,
} from '../toolEventUtils'

type Props = {
  tool: string
  preview: string
  args?: string
  result_preview?: string
  duration?: number
  error?: boolean
  search_meta?: Record<string, unknown> | null
}

/**
 * One tool invocation rendered inline with the assistant's prose.
 * Collapsed by default — a single-line badge showing tool name +
 * args preview + status. Click to expand for full arguments and the
 * tool's result.
 */
export function ToolEvent({
  tool,
  preview,
  args,
  result_preview,
  duration,
  error,
  search_meta,
}: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const finished = duration != null
  const status = finished
    ? error
      ? t('tool.status.failed')
      : `${(duration ?? 0).toFixed(2)}s`
    : t('tool.status.running')

  const searchSummary: WebSearchSummary | null =
    !error && finished
      ? extractWebSearchSummary(tool, result_preview, search_meta)
      : null

  const canToggle =
    finished &&
    (Boolean(args) || Boolean(result_preview) || Boolean(searchSummary?.urls.length))

  const imageUrl = !error && finished ? extractImageUrl(tool, result_preview) : null

  const inlineHint =
    searchSummary && searchSummary.resultCount > 0
      ? t('tool.webSearch.inline', {
          backend: searchSummary.backendLabel,
          count: searchSummary.resultCount,
        })
      : searchSummary
        ? t('tool.webSearch.inlineEmpty', { backend: searchSummary.backendLabel })
        : null

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
        {inlineHint ? (
          <span className="tool-preview">{inlineHint}</span>
        ) : (
          preview && <span className="tool-preview">{preview}</span>
        )}
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
          {searchSummary && (
            <div className="tool-event-section tool-web-search-summary">
              <div className="tool-web-search-backend">
                {t('tool.webSearch.backend', { backend: searchSummary.backendLabel })}
                {searchSummary.braveRemaining != null &&
                  searchSummary.backend === 'brave-free' &&
                  t('tool.webSearch.braveRemaining', {
                    count: searchSummary.braveRemaining,
                  })}
              </div>
              {searchSummary.urls.length > 0 ? (
                <ul className="tool-web-search-urls">
                  {searchSummary.urls.map((hit) => (
                    <li key={hit.url}>
                      <a href={hit.url} target="_blank" rel="noopener noreferrer">
                        {hit.title}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="tool-web-search-empty">{t('tool.webSearch.noUrls')}</p>
              )}
            </div>
          )}
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
