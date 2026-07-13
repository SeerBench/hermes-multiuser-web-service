import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { ToolEvent } from './ToolEvent'
import { LocaleProvider } from '../i18n'

describe('ToolEvent', () => {
  it('shows running status while tool is in flight', () => {
    render(
      <LocaleProvider>
        <ToolEvent tool="web_search" preview='{"q":"test"}' />
      </LocaleProvider>,
    )
    expect(screen.getByText('web_search')).toBeInTheDocument()
    expect(screen.getByText(/running/i)).toBeInTheDocument()
  })

  it('expands details after completion', async () => {
    const user = userEvent.setup()
    render(
      <LocaleProvider>
        <ToolEvent
          tool="web_search"
          preview="q"
          args='{"q":"hello"}'
          result_preview="results"
          duration={1.5}
        />
      </LocaleProvider>,
    )

    await user.click(screen.getByRole('button'))
    expect(screen.getByText('results')).toBeInTheDocument()
  })

  it('renders image preview for image_generate', () => {
    const result = JSON.stringify({
      success: true,
      image: 'https://cdn.example.com/pic.png',
    })
    render(
      <LocaleProvider>
        <ToolEvent
          tool="image_generate"
          preview=""
          result_preview={result}
          duration={2}
        />
      </LocaleProvider>,
    )
    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('src', 'https://cdn.example.com/pic.png')
  })
})
