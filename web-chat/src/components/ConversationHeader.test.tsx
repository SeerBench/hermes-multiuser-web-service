import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { LocaleProvider } from '../i18n'
import { ConversationHeader } from './ConversationHeader'

describe('ConversationHeader', () => {
  it('shows only the width action on the right for a new conversation', async () => {
    const user = userEvent.setup()
    const onToggleChatWidth = vi.fn()
    render(
      <LocaleProvider>
        <ConversationHeader
          title="New conversation"
          pinned={false}
          chatWidth="reading"
          skillsCount={12}
          isNewConversation
          onToggleChatWidth={onToggleChatWidth}
        />
      </LocaleProvider>,
    )

    expect(screen.queryByText(/12/)).not.toBeInTheDocument()
    expect(screen.queryByText('New conversation')).not.toBeInTheDocument()
    const widthButton = screen.getByRole('button', { name: 'Widen' })
    await user.click(widthButton)
    expect(onToggleChatWidth).toHaveBeenCalledOnce()
  })

  it('shows a width-toggle icon in the overflow menu for an existing conversation', async () => {
    const user = userEvent.setup()
    const onToggleChatWidth = vi.fn()
    render(
      <LocaleProvider>
        <ConversationHeader
          title="Existing chat"
          pinned={false}
          chatWidth="reading"
          onRename={vi.fn()}
          onTogglePin={vi.fn()}
          onToggleChatWidth={onToggleChatWidth}
        />
      </LocaleProvider>,
    )

    await user.click(
      screen.getByRole('button', { name: 'Conversation options' }),
    )
    const widthItem = screen.getByRole('menuitem', { name: 'Widen' })
    // lucide icons render as <svg>; empty icon slot would leave only text.
    expect(widthItem.querySelector('svg')).toBeTruthy()
    await user.click(widthItem)
    expect(onToggleChatWidth).toHaveBeenCalledOnce()
  })
})
