import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { LocaleProvider } from '../i18n'
import { KeyPromptModal } from './KeyPromptModal'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    auth: { ...actual.auth, login: vi.fn() },
  }
})

import { ApiError, auth } from '../api'

describe('KeyPromptModal', () => {
  it('maps invalid_key to a friendly message', async () => {
    const user = userEvent.setup()
    vi.mocked(auth.login).mockRejectedValue(
      new ApiError('nope', 401, 'invalid_key'),
    )

    render(
      <LocaleProvider>
        <KeyPromptModal
          reason="first-message"
          onSuccess={vi.fn()}
          onCancel={vi.fn()}
        />
      </LocaleProvider>,
    )

    await user.type(screen.getByPlaceholderText(/sk-/i), 'sk-bad')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    expect(
      await screen.findByText(/rejected by the upstream gateway/i),
    ).toBeInTheDocument()
  })
})
