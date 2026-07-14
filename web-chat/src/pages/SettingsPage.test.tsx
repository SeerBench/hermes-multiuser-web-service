import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LocaleProvider } from '../i18n'
import { SettingsPage } from './SettingsPage'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    auth: {
      ...actual.auth,
      me: vi.fn(),
      logout: vi.fn(),
    },
  }
})

vi.mock('../platformClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platformClient')>()
  return {
    ...actual,
    platform: {
      ...actual.platform,
      me: vi.fn(),
      logout: vi.fn(),
      bindKey: vi.fn(),
    },
  }
})

import { platform } from '../platformClient'
import { applyTheme, getStoredTheme } from '../themeStorage'

describe('SettingsPage', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('light', 'dark')
    vi.mocked(platform.me).mockResolvedValue({
      user_id: 'u1',
      email: 'a@b.com',
      upstream_status: 'ready',
      created_at: 1,
      last_seen_at: 1,
    })
  })

  it('opens as a dialog and switches theme to light', async () => {
    const user = userEvent.setup()
    render(
      <LocaleProvider>
        <SettingsPage
          open
          onOpenChange={vi.fn()}
          platformMode
          onLoggedOut={vi.fn()}
        />
      </LocaleProvider>,
    )

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(await screen.findByText(/a@b.com/)).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: /light/i }))
    expect(getStoredTheme()).toBe('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
    applyTheme('system')
  })
})
