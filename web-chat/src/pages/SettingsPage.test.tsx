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

import { platform } from '../platformClient'
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
  })

  it('opens with sidebar tabs: general, account, models, usage, and warning sign-out', async () => {
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

    expect(screen.getByRole('tab', { name: /general/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /account/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /models/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /usage/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: /light/i }))
    expect(getStoredTheme()).toBe('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
    applyTheme('system')

    await user.click(screen.getByRole('radio', { name: /large/i }))
    const { getStoredFontScale } = await import('../fontScaleStorage')
    expect(getStoredFontScale()).toBe('lg')
  })

  it('puts profile fields under account and API key + favorites under models', async () => {
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

    await user.click(await screen.findByRole('tab', { name: /account/i }))
    expect(await screen.findByText(/a@b.com/)).toBeInTheDocument()
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/current password/i)).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /models/i }))
    expect(
      await screen.findByRole('heading', { name: /bind api key/i }),
    ).toBeInTheDocument()
    expect(await screen.findAllByText('gpt-mini')).not.toHaveLength(0)
    expect(screen.getByText('gpt-pro')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /usage/i }))
    expect(await screen.findByText(/coming soon/i)).toBeInTheDocument()
  })
})
