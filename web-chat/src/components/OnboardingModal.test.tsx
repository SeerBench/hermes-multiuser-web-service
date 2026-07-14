import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { LocaleProvider } from '../i18n'
import { OnboardingModal } from './OnboardingModal'

vi.mock('../platformClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platformClient')>()
  return {
    ...actual,
    platform: { ...actual.platform, bindKey: vi.fn() },
  }
})

import { platform } from '../platformClient'

describe('OnboardingModal', () => {
  it('starts at files step when key already bound', () => {
    render(
      <LocaleProvider>
        <OnboardingModal
          user={{ user_id: 'u1', upstream_status: 'ready' }}
          onUserUpdated={vi.fn()}
          onNavigate={vi.fn()}
          onComplete={vi.fn()}
        />
      </LocaleProvider>,
    )

    expect(screen.getByText(/upload documents/i)).toBeInTheDocument()
  })

  it('binds key and advances to files step', async () => {
    const user = userEvent.setup()
    const onUserUpdated = vi.fn()
    vi.mocked(platform.bindKey).mockResolvedValue({
      user: { user_id: 'u1', upstream_status: 'ready' },
    })

    render(
      <LocaleProvider>
        <OnboardingModal
          user={{ user_id: 'u1', upstream_status: 'pending_bind' }}
          onUserUpdated={onUserUpdated}
          onNavigate={vi.fn()}
          onComplete={vi.fn()}
        />
      </LocaleProvider>,
    )

    await user.type(screen.getByPlaceholderText(/sk-/i), 'sk-test')
    await user.click(screen.getByRole('button', { name: /bind key/i }))

    expect(platform.bindKey).toHaveBeenCalledWith('sk-test')
    expect(onUserUpdated).toHaveBeenCalled()
    expect(await screen.findByText(/upload documents/i)).toBeInTheDocument()
  })
})
