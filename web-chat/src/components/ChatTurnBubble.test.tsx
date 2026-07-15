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
    expect(container.querySelector('[data-slot="avatar"]')).toBeTruthy()
    const content = container.querySelector('[data-slot="bubble-content"]')
    expect(content?.className).toMatch(/text-primary-foreground/)
    expect(content?.className).toMatch(/bg-primary/)
  })
})
