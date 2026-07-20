import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountMenu } from './AccountMenu'
import { LocaleProvider } from '../i18n'

beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {}
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {}
  }
})

describe('AccountMenu', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('light', 'dark')
    document.documentElement.style.removeProperty('--chat-font-scale')
  })

  it('shows default icon when avatar is unset', () => {
    render(
      <LocaleProvider>
        <AccountMenu
          email="a@example.com"
          avatarUrl={null}
          onOpenSettings={vi.fn()}
          onLogout={vi.fn()}
        />
      </LocaleProvider>,
    )
    const trigger = screen.getByRole('button', { name: /account|账户/i })
    expect(trigger.className).toMatch(/\bsize-8\b/)
    expect(trigger.querySelector('img')).toBeNull()
    expect(trigger.querySelector('svg')).toBeTruthy()
  })

  it('shows the user avatar image when avatarUrl is set', () => {
    render(
      <LocaleProvider>
        <AccountMenu
          email="a@example.com"
          avatarUrl="https://cdn.example.com/me.png"
          onOpenSettings={vi.fn()}
          onLogout={vi.fn()}
        />
      </LocaleProvider>,
    )
    const img = screen.getByRole('button', { name: /account|账户/i }).querySelector('img')
    expect(img).toHaveAttribute('src', 'https://cdn.example.com/me.png')
  })

  it('switches theme and chat font size directly from the menu', async () => {
    const user = userEvent.setup()
    render(
      <LocaleProvider>
        <AccountMenu
          email="a@example.com"
          avatarUrl={null}
          onOpenSettings={vi.fn()}
          onLogout={vi.fn()}
        />
      </LocaleProvider>,
    )

    await user.click(screen.getByRole('button', { name: /account|账户/i }))
    await user.click(screen.getByRole('button', { name: 'Dark' }))
    expect(document.documentElement).toHaveClass('dark')
    expect(localStorage.getItem('hermes_theme')).toBe('dark')

    await user.click(screen.getByRole('button', { name: 'Large' }))
    expect(
      document.documentElement.style.getPropertyValue('--chat-font-scale'),
    ).toBe('1.125')
    expect(localStorage.getItem('hermes_font_scale')).toBe('lg')
  })
})
