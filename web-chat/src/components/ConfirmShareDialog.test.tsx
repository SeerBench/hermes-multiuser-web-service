import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LocaleProvider } from '../i18n'
import { ConfirmShareDialog } from './ConfirmShareDialog'

vi.mock('../platformClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platformClient')>()
  return {
    ...actual,
    platform: {
      ...actual.platform,
      createShare: vi.fn(),
    },
  }
})

import { platform } from '../platformClient'

describe('ConfirmShareDialog', () => {
  beforeEach(() => {
    localStorage.setItem('hermes-locale', 'en')
    vi.mocked(platform.createShare).mockReset()
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('creates share and copies link on confirm', async () => {
    vi.mocked(platform.createShare).mockResolvedValue({
      token: 'tok_new',
      url_path: '#/share/tok_new',
      kind: 'reply',
    })

    render(
      <LocaleProvider>
        <ConfirmShareDialog
          open
          onOpenChange={() => undefined}
          kind="reply"
          title="T"
          turns={[{ role: 'assistant', text: 'hello' }]}
        />
      </LocaleProvider>,
    )

    await userEvent.click(
      screen.getByRole('button', { name: /Create link/i }),
    )

    await waitFor(() => {
      expect(platform.createShare).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'reply',
          turns: [{ role: 'assistant', text: 'hello' }],
        }),
      )
    })
    expect(navigator.clipboard.writeText).toHaveBeenCalled()
    expect(String(vi.mocked(navigator.clipboard.writeText).mock.calls[0][0])).toContain(
      '#/share/tok_new',
    )
  })
})
