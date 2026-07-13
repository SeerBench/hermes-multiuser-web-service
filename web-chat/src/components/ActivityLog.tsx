import { useState } from 'react'
import { useT } from '../i18n'
import { activityItemLabel } from '../activityLabels'

// One entry in a turn's "what is the agent doing behind the scenes" feed.
// Sourced from the new SSE ``status`` / ``step`` / ``activity`` events.
export type ActivityItem =
  | { kind: 'status'; text: string; tone?: 'warn'; ts: number }
  | { kind: 'step'; step: number; tools: string[]; ts: number }
  | { kind: 'thinking'; text: string; ts: number }

type Props = {
  items: ActivityItem[]
  streaming: boolean
}

/**
 * Collapsible activity timeline rendered above an assistant turn.  While
 * the turn is streaming it shows the latest line as a live ticker (with a
 * spinner) and can be expanded to the full feed; once done it collapses to
 * a "view execution (N steps)" summary so the transcript stays clean.
 */
export function ActivityLog({ items, streaming }: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null

  const latest = items[items.length - 1]
  const summary = open
    ? t('activity.hide')
    : streaming
      ? activityItemLabel(t, latest)
      : t('activity.summary', { n: items.length })

  return (
    <div className={`activity-log${streaming ? ' activity-streaming' : ''}`}>
      <button
        type="button"
        className="activity-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {streaming && <span className="activity-spinner" aria-hidden />}
        <span className="activity-summary">{summary}</span>
        <span className="activity-caret" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <ul className="activity-items">
          {items.map((item, i) => (
            <li
              key={i}
              className={`activity-item activity-${item.kind}${
                item.kind === 'status' && item.tone === 'warn' ? ' activity-warn' : ''
              }`}
            >
              {activityItemLabel(t, item)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
