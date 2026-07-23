import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LocaleProvider } from '../i18n'
import { SharePage } from './SharePage'

vi.mock('../platformClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platformClient')>()
  return {
    ...actual,
    platform: {
      ...actual.platform,
      getShare: vi.fn(),
    },
  }
})

import { platform } from '../platformClient'

describe('SharePage', () => {
  beforeEach(() => {
    localStorage.setItem('hermes-locale', 'en')
    window.location.hash = '#/share/tok_abc'
    vi.mocked(platform.getShare).mockReset()
  })

  it('loads and renders read-only turns', async () => {
    vi.mocked(platform.getShare).mockResolvedValue({
      kind: 'conversation',
      title: 'Demo chat',
      turns: [
        { role: 'user', text: 'Hello share' },
        { role: 'assistant', text: 'Hi there' },
      ],
      created_at: '2026-07-22T00:00:00Z',
    })

    render(
      <LocaleProvider>
        <SharePage />
      </LocaleProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Hello share')).toBeInTheDocument()
    })
    expect(screen.getByText('Hi there')).toBeInTheDocument()
    expect(screen.getByText(/Read-only share/i)).toBeInTheDocument()
    expect(platform.getShare).toHaveBeenCalledWith('tok_abc')
    // No composer
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('shows not-found when GET fails', async () => {
    const { PlatformApiError } = await import('../platformClient')
    vi.mocked(platform.getShare).mockRejectedValue(
      new PlatformApiError('missing', 404),
    )

    render(
      <LocaleProvider>
        <SharePage />
      </LocaleProvider>,
    )

    await waitFor(() => {
      expect(
        screen.getByText(/does not exist|invalid/i),
      ).toBeInTheDocument()
    })
  })

  it('copies share link from the toolbar', async () => {
    vi.mocked(platform.getShare).mockResolvedValue({
      kind: 'reply',
      title: null,
      turns: [{ role: 'assistant', text: 'Only reply' }],
    })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    render(
      <LocaleProvider>
        <SharePage />
      </LocaleProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Only reply')).toBeInTheDocument()
    })

    await userEvent.click(screen.getByRole('button', { name: /Copy link/i }))
    expect(writeText).toHaveBeenCalled()
    expect(String(writeText.mock.calls[0][0])).toContain('#/share/tok_abc')
  })
})
