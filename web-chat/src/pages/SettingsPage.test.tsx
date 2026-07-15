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
    getStoredWorkspaceId: () => 'ws-1',
    platform: {
      ...actual.platform,
      me: vi.fn(),
      logout: vi.fn(),
      bindKey: vi.fn(),
      listModels: vi.fn(),
      patchPreferences: vi.fn(),
      patchMe: vi.fn(),
      changePassword: vi.fn(),
      getBillingUsage: vi.fn(),
      getBillingLogs: vi.fn(),
    },
  }
})

import { platform, PlatformApiError } from '../platformClient'
import { applyTheme, getStoredTheme } from '../themeStorage'

describe('SettingsPage', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('hermes-locale', 'en')
    document.documentElement.classList.remove('light', 'dark')
    vi.mocked(platform.me).mockResolvedValue({
      user_id: 'u1',
      email: 'a@b.com',
      nickname: 'Ada',
      upstream_status: 'ready',
      created_at: 1,
      last_seen_at: 1,
    })
    vi.mocked(platform.listModels).mockResolvedValue({
      models: [
        { id: 'gpt-mini' },
        { id: 'gpt-pro' },
        { id: 'other' },
      ],
      favorite_models: ['gpt-mini'],
      preferred_model: 'gpt-mini',
      default_model: 'gpt-mini',
    })
    vi.mocked(platform.getBillingUsage).mockRejectedValue(
      new PlatformApiError('upstream key not bound', 403),
    )
    vi.mocked(platform.getBillingLogs).mockResolvedValue({ items: [] })
  })

  it('opens as a wide settings dialog with tabs and switches theme', async () => {
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

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(dialog.className).toMatch(/sm:max-w-3xl/)
    expect(await screen.findByText(/a@b.com/)).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /general/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /account/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /api key/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /models/i })).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: /light/i }))
    expect(getStoredTheme()).toBe('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
    applyTheme('system')

    await user.click(screen.getByRole('radio', { name: /large/i }))
    const { getStoredFontScale } = await import('../fontScaleStorage')
    expect(getStoredFontScale()).toBe('lg')
  })

  it('shows account edit fields and model favorites checklist', async () => {
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

    await screen.findByText(/a@b.com/)
    await user.click(screen.getByRole('tab', { name: /account/i }))
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/current password/i)).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /models/i }))
    expect(await screen.findAllByText('gpt-mini')).not.toHaveLength(0)
    expect(screen.getByText('gpt-pro')).toBeInTheDocument()
    expect(screen.getByText('other')).toBeInTheDocument()
  })
})
