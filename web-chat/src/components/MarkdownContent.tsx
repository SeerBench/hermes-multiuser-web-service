import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

import { useT } from '../i18n'
import { copyTextToClipboard } from '../clipboard'

// Register a practical subset — keeps the bundle smaller than full hljs.
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('go', go)
hljs.registerLanguage('java', java)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)

marked.setOptions({
  gfm: true,
  breaks: true,
})

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

function langFromCodeEl(code: Element): string {
  const cls = code.getAttribute('class') || ''
  const m = cls.match(/language-([\w+-]+)/i)
  return m?.[1]?.toLowerCase() ?? ''
}

/** Highlight fenced blocks and wrap them with a copy toolbar. */
function enhanceCodeBlocks(root: DocumentFragment | ParentNode): void {
  const blocks = Array.from(root.querySelectorAll('pre > code'))
  for (const code of blocks) {
    const pre = code.parentElement
    if (!pre || pre.parentElement?.classList.contains('md-code-block')) continue

    const lang = langFromCodeEl(code)
    const source = code.textContent ?? ''
    try {
      if (lang && hljs.getLanguage(lang)) {
        code.innerHTML = hljs.highlight(source, { language: lang }).value
        code.classList.add('hljs', `language-${lang}`)
      } else {
        code.innerHTML = hljs.highlightAuto(source).value
        code.classList.add('hljs')
      }
    } catch {
      code.classList.add('hljs')
    }

    const wrap = document.createElement('div')
    wrap.className = 'md-code-block'
    const toolbar = document.createElement('div')
    toolbar.className = 'md-code-toolbar'
    if (lang) {
      const langEl = document.createElement('span')
      langEl.className = 'md-code-lang'
      langEl.textContent = lang
      toolbar.appendChild(langEl)
    } else {
      const spacer = document.createElement('span')
      spacer.className = 'md-code-lang'
      toolbar.appendChild(spacer)
    }
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'md-code-copy'
    btn.setAttribute('data-md-copy', '1')
    btn.textContent = 'Copy'
    toolbar.appendChild(btn)
    pre.replaceWith(wrap)
    wrap.appendChild(toolbar)
    wrap.appendChild(pre)
  }
}

/** Parse + sanitize + highlight. Exported for unit tests. */
export function renderMarkdown(text: string): string {
  const rawHtml = marked.parse(text) as string
  if (typeof document === 'undefined') return rawHtml
  const tpl = document.createElement('template')
  tpl.innerHTML = rawHtml
  sanitizeHtmlInPlace(tpl.content)
  enhanceCodeBlocks(tpl.content)
  return tpl.innerHTML
}

type Props = {
  text: string
  /** Compact margins for tight panels (reasoning / tool cards). */
  compact?: boolean
  className?: string
}

/**
 * Safe Markdown renderer with hljs fenced-code highlighting and a
 * per-block 「复制代码」 control.
 */
export function MarkdownContent({ text, compact, className }: Props) {
  const t = useT()
  const html = useMemo(() => renderMarkdown(text), [text])
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Localize copy button labels after each HTML refresh.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    root.querySelectorAll<HTMLButtonElement>('[data-md-copy]').forEach((btn, i) => {
      const id = `code-${i}`
      btn.dataset.copyId = id
      const label =
        copiedId === id ? t('md.copied') : t('md.copy')
      btn.textContent = label
      btn.setAttribute('aria-label', label)
    })
  }, [html, t, copiedId])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as Element | null)?.closest?.('[data-md-copy]')
      if (!(btn instanceof HTMLButtonElement) || !root.contains(btn)) return
      e.preventDefault()
      const block = btn.closest('.md-code-block')
      const code = block?.querySelector('code')?.textContent ?? ''
      const id = btn.dataset.copyId ?? null
      void copyTextToClipboard(code).then((ok) => {
        if (!ok || !id) return
        setCopiedId(id)
        window.setTimeout(() => {
          setCopiedId((cur) => (cur === id ? null : cur))
        }, 1500)
      })
    }
    root.addEventListener('click', onClick)
    return () => root.removeEventListener('click', onClick)
  }, [html])

  const cls = ['md', compact ? 'md-compact' : '', className ?? '']
    .filter(Boolean)
    .join(' ')
  return (
    <div
      ref={rootRef}
      className={cls}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
