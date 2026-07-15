import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChatEmptyGuide } from './ChatEmptyGuide'
import { LocaleProvider } from '../i18n'

describe('ChatEmptyGuide', () => {
  it('renders suggestions and workspace shortcuts', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    const onFiles = vi.fn()
    render(
      <LocaleProvider>
        <ChatEmptyGuide
          platformMode
          enabledSkillsCount={3}
          onPickSuggestion={onPick}
          onGoFiles={onFiles}
          onGoSkills={vi.fn()}
        />
      </LocaleProvider>,
    )

    expect(screen.getByText(/start a new conversation/i)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /from files/i }))
    expect(onFiles).toHaveBeenCalled()
  })

  it('shows bind-key check when needed', () => {
    render(
      <LocaleProvider>
        <ChatEmptyGuide
          needsBindKey
          onPickSuggestion={vi.fn()}
          onGoSettings={vi.fn()}
        />
      </LocaleProvider>,
    )
    expect(screen.getByText(/bind|API|密钥/i)).toBeTruthy()
  })
})
