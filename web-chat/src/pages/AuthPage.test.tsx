import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LocaleProvider } from '../i18n'
import { AuthPage } from './AuthPage'

vi.mock('../platformClient', () => ({
  platform: {
    login: vi.fn(),
    register: vi.fn(),
    forgotPassword: vi.fn(),
    resetPassword: vi.fn(),
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

vi.mock('../api', () => ({
  auth: { login: vi.fn() },
  ApiError: class extends Error {
    status: number
    code?: string
    constructor(message: string, status: number, code?: string) {
      super(message)
      this.status = status
      this.code = code
    }
  },
}))

import { auth } from '../api'
import { platform } from '../platformClient'

function renderAuth(
  props: {
    initialMode?: 'login' | 'register' | 'forgot' | 'reset'
    resetToken?: string | null
  } = {},
) {
  const onSuccess = vi.fn()
  const onLegacySuccess = vi.fn()
  render(
    <LocaleProvider>
      <AuthPage
        onSuccess={onSuccess}
        onLegacySuccess={onLegacySuccess}
        initialMode={props.initialMode}
        resetToken={props.resetToken}
      />
    </LocaleProvider>,
  )
  return { onSuccess, onLegacySuccess }
}

describe('AuthPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

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

  it('switches to API key login and submits', async () => {
    const user = userEvent.setup()
    vi.mocked(auth.login).mockResolvedValue({ user_id: 'legacy-u' })
    const { onLegacySuccess } = renderAuth()

    await user.click(screen.getByRole('button', { name: /use api key/i }))
    await user.type(screen.getByLabelText(/api key/i), 'sk-test')
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))

    expect(auth.login).toHaveBeenCalledWith('sk-test')
    expect(onLegacySuccess).toHaveBeenCalledWith('legacy-u')
  })

  it('can switch back to account login from API key form', async () => {
    const user = userEvent.setup()
    renderAuth()

    await user.click(screen.getByRole('button', { name: /use api key/i }))
    expect(screen.getByLabelText(/api key/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /account sign-in/i }))
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument()
  })

  it('submits forgot-password and shows confirmation', async () => {
    const user = userEvent.setup()
    vi.mocked(platform.forgotPassword).mockResolvedValue({ status: 'ok' })
    renderAuth()

    await user.click(screen.getByRole('button', { name: /forgot password/i }))
    await user.type(screen.getByLabelText(/email/i), 'a@b.com')
    await user.click(
      screen.getByRole('button', { name: /send reset email/i }),
    )

    expect(platform.forgotPassword).toHaveBeenCalledWith('a@b.com')
    await waitFor(() => {
      expect(screen.getByText(/reset link has been sent/i)).toBeInTheDocument()
    })
  })

  it('submits reset-password with token then returns to login', async () => {
    const user = userEvent.setup()
    vi.mocked(platform.resetPassword).mockResolvedValue({ status: 'ok' })
    renderAuth({ initialMode: 'reset', resetToken: 'tok-xyz' })

    await user.type(screen.getByLabelText(/new password/i), 'newpass99')
    await user.click(
      screen.getByRole('button', { name: /update password/i }),
    )

    expect(platform.resetPassword).toHaveBeenCalledWith('tok-xyz', 'newpass99')
    await waitFor(() => {
      expect(
        screen.getByText(/password updated|sign in with your new/i),
      ).toBeInTheDocument()
    })
  })
})
