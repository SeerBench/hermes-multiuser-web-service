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

  it('shows current locale name by default (中文 when UI is Chinese)', async () => {
    const user = userEvent.setup()
    localStorage.setItem('hermes-locale', 'zh')
    render(
      <LocaleProvider>
        <LanguageToggle />
      </LocaleProvider>,
    )

    const btn = screen.getByRole('button', { name: /切换|switch|语言/i })
    expect(btn).toHaveTextContent('中文')

    await user.click(btn)

    expect(screen.getByRole('button', { name: /切换|switch|语言/i })).toHaveTextContent(
      'English',
    )
  })

  it('target variant shows the opposite language label', () => {
    localStorage.setItem('hermes-locale', 'zh')
    render(
      <LocaleProvider>
        <LanguageToggle variant="target" />
      </LocaleProvider>,
    )

    const btn = screen.getByRole('button', { name: 'Use English' })
    expect(btn).toHaveTextContent('English')
  })
})
