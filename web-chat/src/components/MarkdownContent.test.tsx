import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { LocaleProvider } from '../i18n'
import { MarkdownContent, renderMarkdown } from './MarkdownContent'

function wrap(ui: React.ReactElement) {
  return render(<LocaleProvider>{ui}</LocaleProvider>)
}

describe('renderMarkdown', () => {
  it('strips script tags and javascript urls', () => {
    const html = renderMarkdown(
      'Hi <script>alert(1)</script> [x](javascript:alert(1))',
    )
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/javascript:/i)
  })

  it('highlights fenced code with hljs classes and wraps a copy control', () => {
    const html = renderMarkdown('```python\nprint("hi")\n```')
    expect(html).toContain('md-code-block')
    expect(html).toContain('data-md-copy')
    expect(html).toContain('hljs')
    expect(html).toMatch(/language-python|python/)
    expect(html).toContain('print')
  })
})

describe('MarkdownContent', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('renders a copy button that writes code to the clipboard', async () => {
    wrap(<MarkdownContent text={'```js\nconst x = 1\n```'} />)
    const btn = await screen.findByRole('button', {
      name: /copy code|复制代码/i,
    })
    fireEvent.click(btn)
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('const x = 1'),
      )
    })
  })
})
