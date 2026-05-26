import { useMemo } from 'react'
import { marked } from 'marked'

// Configure marked once on module load. We deliberately stick to the
// safe, predictable subset: GitHub-flavoured markdown + soft-break to
// <br>. No sync renderer overrides — those drifted between marked
// majors and bit us during the upstream rebase.
marked.setOptions({
  gfm: true,
  breaks: true,
})

// Tags that have no business appearing inside an assistant reply.
// Anything in this set is stripped from the rendered DOM after marked
// finishes; this is our defence-in-depth in lieu of a full sanitiser.
// marked already HTML-escapes ordinary prose, so the only way these
// tags get in is if the model emits raw HTML — which we don't trust.
const UNSAFE_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'style',
  'link',
  'meta',
  'base',
  'form',
])

function sanitizeHtmlInPlace(root: DocumentFragment): void {
  const all = Array.from(root.querySelectorAll('*')) as Element[]
  for (const el of all) {
    const tag = el.tagName.toLowerCase()
    if (UNSAFE_TAGS.has(tag)) {
      el.remove()
      continue
    }
    // Strip on* handlers and javascript: URLs from any element.
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name)
        continue
      }
      if (
        (name === 'href' || name === 'src' || name === 'xlink:href') &&
        /^\s*javascript:/i.test(attr.value)
      ) {
        el.removeAttribute(attr.name)
      }
    }
    if (tag === 'a') {
      el.setAttribute('rel', 'noopener noreferrer')
      if (!el.getAttribute('target')) el.setAttribute('target', '_blank')
    }
  }
}

function renderMarkdown(text: string): string {
  // marked v11 returns string when no async/walkTokens is registered.
  // Cast is safe given the options above.
  const rawHtml = marked.parse(text) as string
  if (typeof document === 'undefined') return rawHtml // SSR safety
  const tpl = document.createElement('template')
  tpl.innerHTML = rawHtml
  sanitizeHtmlInPlace(tpl.content)
  return tpl.innerHTML
}

type Props = {
  text: string
  // Visual variant — "compact" trims default margins for tight contexts
  // like reasoning panels or tool result cards.
  compact?: boolean
  className?: string
}

/**
 * Render Markdown safely. The renderer deliberately stays within the
 * subset of CommonMark/GFM that the agent is likely to produce: code
 * blocks, lists, tables, links, inline emphasis. Anything risky
 * (script tags, inline event handlers, javascript: URLs) is stripped
 * out before insertion.
 */
export function MarkdownContent({ text, compact, className }: Props) {
  const html = useMemo(() => renderMarkdown(text), [text])
  const cls = ['md', compact ? 'md-compact' : '', className ?? '']
    .filter(Boolean)
    .join(' ')
  return <div className={cls} dangerouslySetInnerHTML={{ __html: html }} />
}
