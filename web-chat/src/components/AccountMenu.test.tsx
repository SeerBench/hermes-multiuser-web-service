import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
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
})
