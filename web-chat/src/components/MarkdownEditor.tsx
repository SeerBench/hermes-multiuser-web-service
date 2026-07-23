import { useEffect, useMemo, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { oneDark } from '@codemirror/theme-one-dark'
import { MarkdownContent } from './MarkdownContent'
import { SplitPane } from './SplitPane'
import { cn } from '@/lib/utils'

/** Follow project theme: forced .dark/.light on <html>, else system preference. */
function useProjectDark(): boolean {
  const [dark, setDark] = useState(() => resolveIsDark())

  useEffect(() => {
    const root = document.documentElement
    const sync = () => setDark(resolveIsDark())
    const obs = new MutationObserver(sync)
    obs.observe(root, { attributes: true, attributeFilter: ['class'] })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', sync)
    return () => {
      obs.disconnect()
      mq.removeEventListener('change', sync)
    }
  }, [])

  return dark
}

function resolveIsDark(): boolean {
  if (typeof document === 'undefined') return true
  const root = document.documentElement
  if (root.classList.contains('dark')) return true
  if (root.classList.contains('light')) return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Markdown source editor with live preview (PC split / mobile tabs). */
export function MarkdownEditor({
  value,
  onChange,
  readOnly = false,
  previewLabel,
  editLabel,
  minHeight = 280,
  className,
}: {
  value: string
  onChange?: (next: string) => void
  readOnly?: boolean
  previewLabel?: string
  editLabel?: string
  minHeight?: number
  className?: string
}) {
  const dark = useProjectDark()
  const extensions = useMemo(() => [markdown()], [])

  const editor = (
    <div className="markdown-editor-pane" style={{ minHeight }}>
      <CodeMirror
        value={value}
        height={`${minHeight}px`}
        theme={dark ? oneDark : 'light'}
        extensions={extensions}
        editable={!readOnly}
        onChange={(v) => onChange?.(v)}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: !readOnly,
        }}
      />
    </div>
  )

  const preview = (
    <div
      className={cn(
        'markdown-editor-preview',
        dark ? 'prose-invert' : 'prose',
      )}
      style={{ minHeight }}
    >
      <MarkdownContent text={value || ' '} />
    </div>
  )

  if (readOnly) {
    return <div className={cn('markdown-editor', className)}>{preview}</div>
  }

  return (
    <div className={cn('markdown-editor', className)}>
      <SplitPane
        leftLabel={editLabel ?? 'Edit'}
        rightLabel={previewLabel ?? 'Preview'}
        left={editor}
        right={preview}
      />
    </div>
  )
}
