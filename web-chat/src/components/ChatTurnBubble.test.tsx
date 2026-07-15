import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChatTurnBubble } from './ChatTurnBubble'
import { LocaleProvider } from '../i18n'
import type { Turn } from '../chatTurns'

function wrap(ui: React.ReactElement) {
  return render(<LocaleProvider>{ui}</LocaleProvider>)
}

describe('ChatTurnBubble', () => {
  it('renders user bubble with primary foreground contrast classes', () => {
    const turn: Turn = {
      id: 'u1',
      role: 'user',
      status: 'done',
      activity: [],
      segments: [{ kind: 'text', text: '可见用户气泡文字' }],
    }
    const { container } = wrap(<ChatTurnBubble turn={turn} />)
    expect(screen.getByText('可见用户气泡文字')).toBeTruthy()
    expect(container.querySelector('[data-slot="message"]')).toBeTruthy()
    // No custom avatar → no avatar slot
    expect(container.querySelector('[data-slot="avatar"]')).toBeNull()
    const content = container.querySelector('[data-slot="bubble-content"]')
    expect(content?.className).toMatch(/text-primary-foreground/)
    expect(content?.className).toMatch(/bg-primary/)
  })

  it('shows user avatar only when avatarUrl is provided', () => {
    const turn: Turn = {
      id: 'u2',
      role: 'user',
      status: 'done',
      activity: [],
      segments: [{ kind: 'text', text: '有头像' }],
    }
    const { container } = wrap(
      <ChatTurnBubble
        turn={turn}
        userAvatarUrl="data:image/png;base64,aaa"
      />,
    )
    const avatar = container.querySelector('[data-slot="avatar"]')
    expect(avatar).toBeTruthy()
    expect(container.querySelector('[data-slot="message-avatar"]')).toBeTruthy()
  })

  it('never shows an avatar on assistant turns', () => {
    const turn: Turn = {
      id: 'a1',
      role: 'assistant',
      status: 'done',
      activity: [],
      segments: [{ kind: 'text', text: '助手回复' }],
    }
    const { container } = wrap(
      <ChatTurnBubble
        turn={turn}
        userAvatarUrl="data:image/png;base64,aaa"
      />,
    )
    expect(screen.getByText('助手回复')).toBeTruthy()
    expect(container.querySelector('[data-slot="avatar"]')).toBeNull()
    expect(container.querySelector('[data-slot="message-avatar"]')).toBeNull()
  })
})
