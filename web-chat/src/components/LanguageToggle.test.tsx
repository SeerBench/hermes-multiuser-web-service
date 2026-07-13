import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { LanguageToggle } from './LanguageToggle'
import { LocaleProvider } from '../i18n'

describe('LanguageToggle', () => {
  it('switches locale when a button is clicked', async () => {
    const user = userEvent.setup()
    render(
      <LocaleProvider>
        <LanguageToggle />
      </LocaleProvider>,
    )

    const zhBtn = screen.getByRole('button', { name: /中文|简体/i })
    await user.click(zhBtn)
    expect(zhBtn).toHaveAttribute('aria-pressed', 'true')
  })
})
