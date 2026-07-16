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
})
