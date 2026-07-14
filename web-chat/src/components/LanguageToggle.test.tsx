import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { LanguageToggle } from './LanguageToggle'
import { LocaleProvider } from '../i18n'

describe('LanguageToggle', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('shows English when UI is Chinese, then toggles to 中文', async () => {
    const user = userEvent.setup()
    localStorage.setItem('hermes-locale', 'zh')
    render(
      <LocaleProvider>
        <LanguageToggle />
      </LocaleProvider>,
    )

    const btn = screen.getByRole('button', { name: 'Use English' })
    expect(btn).toHaveTextContent('English')
    expect(btn).toHaveAttribute('title', 'Use English')

    await user.click(btn)

    const next = screen.getByRole('button', { name: '使用中文' })
    expect(next).toHaveTextContent('中文')
    expect(next).toHaveAttribute('title', '使用中文')
  })

  it('shows 中文 when UI is English', () => {
    localStorage.setItem('hermes-locale', 'en')
    render(
      <LocaleProvider>
        <LanguageToggle />
      </LocaleProvider>,
    )

    const btn = screen.getByRole('button', { name: '使用中文' })
    expect(btn).toHaveTextContent('中文')
    expect(btn).toHaveAttribute('title', '使用中文')
  })
})
