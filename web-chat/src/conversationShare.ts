import type { Turn } from './chatTurns'
import { turnToCopyText } from './chatTurns'

export type ShareTurnPayload = {
  role: 'user' | 'assistant'
  text: string
}

/** Build a Markdown document from chat turns for copy / share / download. */
export function conversationToMarkdown(
  turns: Turn[],
  opts?: { title?: string },
): string {
  const lines: string[] = []
  const title = opts?.title?.trim()
  if (title) {
    lines.push(`# ${title}`, '')
  }
  for (const turn of turns) {
    if (turn.status === 'error' && !turn.segments.length) continue
    const role = turn.role === 'user' ? 'User' : 'Assistant'
    const body = turnToCopyText(turn).trim()
    if (!body) continue
    lines.push(`## ${role}`, '', body, '')
  }
  return lines.join('\n').trimEnd() + (lines.length ? '\n' : '')
}

/** Sanitize turns for immutable public share snapshots (text only). */
export function turnsToSharePayload(turns: Turn[]): ShareTurnPayload[] {
  const out: ShareTurnPayload[] = []
  for (const turn of turns) {
    if (turn.role !== 'user' && turn.role !== 'assistant') continue
    const text = turnToCopyText(turn).trim()
    if (!text) continue
    out.push({ role: turn.role, text })
  }
  return out
}

/** Absolute browser URL for a share hash path (`#/share/…`). */
export function absoluteShareUrl(urlPath: string): string {
  const path = urlPath.startsWith('#')
    ? urlPath
    : `#/share/${urlPath.replace(/^\/+/, '')}`
  const { origin, pathname, search } = window.location
  return `${origin}${pathname}${search}${path}`
}

/** Trigger a browser download of Markdown text. */
export function downloadMarkdown(filename: string, markdown: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.md') ? filename : `${filename}.md`
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** Share text via Web Share API, or copy to clipboard as fallback. */
export async function shareOrCopyText(
  text: string,
  opts?: { title?: string },
): Promise<'shared' | 'copied'> {
  const title = opts?.title?.trim() || 'Hermes'
  try {
    if (typeof navigator !== 'undefined' && navigator.share) {
      await navigator.share({ title, text })
      return 'shared'
    }
  } catch (err) {
    // User cancel → rethrow AbortError so caller can ignore quietly.
    if (err instanceof DOMException && err.name === 'AbortError') throw err
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
  } else {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  return 'copied'
}
