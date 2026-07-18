import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { LocaleProvider } from '../i18n'
import { ChatTurnBubble } from './ChatTurnBubble'
import type { Turn } from '../chatTurns'

function wrap(ui: React.ReactElement) {
  return render(<LocaleProvider>{ui}</LocaleProvider>)
}

describe('ChatTurnBubble a11y', () => {
  it('marks streaming assistant content as a polite live region', () => {
    const turn: Turn = {
      id: 'a-stream',
      role: 'assistant',
      status: 'streaming',
      activity: [],
      segments: [{ kind: 'text', text: 'partial…' }],
    }
    const { container } = wrap(<ChatTurnBubble turn={turn} />)
    const live = container.querySelector('[aria-live="polite"]')
    expect(live).toBeTruthy()
    expect(live).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText(/partial/i)).toBeTruthy()
  })

  it('clears aria-busy when the turn is done', () => {
    const turn: Turn = {
      id: 'a-done',
      role: 'assistant',
      status: 'done',
      activity: [],
      segments: [{ kind: 'text', text: 'final' }],
    }
    const { container } = wrap(<ChatTurnBubble turn={turn} />)
    const live = container.querySelector('[aria-live="polite"]')
    expect(live).toHaveAttribute('aria-busy', 'false')
  })
})
