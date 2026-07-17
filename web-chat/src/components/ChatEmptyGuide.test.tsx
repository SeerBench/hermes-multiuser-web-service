import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChatEmptyGuide } from './ChatEmptyGuide'
import { LocaleProvider } from '../i18n'

describe('ChatEmptyGuide', () => {
  it('renders suggestions and a primary files CTA', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    const onFiles = vi.fn()
    const onSkills = vi.fn()
    render(
      <LocaleProvider>
        <ChatEmptyGuide
          platformMode
          onPickSuggestion={onPick}
          onGoFiles={onFiles}
          onGoSkills={onSkills}
        />
      </LocaleProvider>,
    )

    expect(screen.getByText(/start a new conversation/i)).toBeTruthy()
    // 技能数量不再展示在空态（避免运营数字抢视觉）
    expect(screen.queryByText(/85|skills \(3/i)).toBeNull()
    const filesButton = screen.getByRole('button', { name: /from files/i })
    const skillsButton = screen.getByRole('button', { name: /browse skills/i })
    expect(filesButton).toHaveClass('chat-empty-guide-action')
    expect(skillsButton).toHaveClass('chat-empty-guide-action')
    for (const suggestion of screen.getAllByRole('button').slice(0, 3)) {
      expect(suggestion).toHaveClass('chat-empty-guide-chip')
    }

    await user.click(filesButton)
    expect(onFiles).toHaveBeenCalled()
    await user.click(skillsButton)
    expect(onSkills).toHaveBeenCalled()
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
