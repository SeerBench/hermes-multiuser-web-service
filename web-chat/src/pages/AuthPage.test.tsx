import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { LocaleProvider } from '../i18n'
import { AuthPage } from './AuthPage'

vi.mock('../platformClient', () => ({
  platform: {
    login: vi.fn(),
    register: vi.fn(),
  },
  storeWorkspaceId: vi.fn(),
  PlatformApiError: class extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  },
}))

import { platform } from '../platformClient'

function renderAuth() {
  const onSuccess = vi.fn()
  const onLegacyKey = vi.fn()
  render(
    <LocaleProvider>
      <AuthPage onSuccess={onSuccess} onLegacyKey={onLegacyKey} />
    </LocaleProvider>,
  )
  return { onSuccess, onLegacyKey }
}

describe('AuthPage', () => {
  it('renders login form and submits credentials', async () => {
    const user = userEvent.setup()
    vi.mocked(platform.login).mockResolvedValue({
      user: { user_id: 'u1', email: 'a@b.com' },
    })
    const { onSuccess } = renderAuth()

    await user.type(screen.getByLabelText(/email/i), 'a@b.com')
    await user.type(screen.getByLabelText(/password/i), 'password123')
    await user.click(screen.getByRole('button', { name: /continue/i }))

    expect(platform.login).toHaveBeenCalledWith('a@b.com', 'password123')
    expect(onSuccess).toHaveBeenCalled()
  })

  it('offers legacy API key path', async () => {
    const user = userEvent.setup()
    const { onLegacyKey } = renderAuth()

    await user.click(screen.getByRole('button', { name: /api key/i }))
    expect(onLegacyKey).toHaveBeenCalled()
  })
})
