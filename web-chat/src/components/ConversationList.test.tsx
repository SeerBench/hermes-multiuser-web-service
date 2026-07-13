import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { ConversationSummary } from '../api'
import { ConversationList } from './ConversationList'
import { LocaleProvider } from '../i18n'

const noop = () => undefined

const convos: ConversationSummary[] = [
  {
    id: 'a',
    title: 'Project Alpha',
    preview: 'hello',
    started_at: 0,
    last_active: 0,
    message_count: 2,
  },
  {
    id: 'b',
    title: 'Weekly notes',
    preview: 'beta release',
    started_at: 0,
    last_active: 0,
    message_count: 1,
  },
]

describe('ConversationList', () => {
  it('filters conversations by search query', async () => {
    const user = userEvent.setup()
    render(
      <LocaleProvider>
        <ConversationList
          conversations={convos}
          archived={[]}
          activeId={null}
          onSelect={noop}
          onRename={noop}
          onDelete={noop}
          onSetFlags={noop}
          onLoadArchived={noop}
        />
      </LocaleProvider>,
    )

    expect(screen.getByText('Project Alpha')).toBeInTheDocument()
    expect(screen.getByText('Weekly notes')).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText(/search conversations/i), 'alpha')

    expect(screen.getByText('Project Alpha')).toBeInTheDocument()
    expect(screen.queryByText('Weekly notes')).not.toBeInTheDocument()
  })
})
