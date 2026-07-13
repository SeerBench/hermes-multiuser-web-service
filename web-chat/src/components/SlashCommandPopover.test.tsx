import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { SlashCommandPopover } from './SlashCommandPopover'
import { LocaleProvider } from '../i18n'
import type { CommandSpec } from '../api'

const COMMANDS: CommandSpec[] = [
  {
    name: 'help',
    description: 'Show help',
    category: 'Info',
    args_hint: '',
    aliases: [],
    subcommands: [],
    client_only: false,
    supported: true,
  },
]

function renderPopover(query = '') {
  const onSelect = vi.fn()
  const onClose = vi.fn()
  render(
    <LocaleProvider>
      <SlashCommandPopover
        query={query}
        commands={COMMANDS}
        onSelect={onSelect}
        onClose={onClose}
      />
    </LocaleProvider>,
  )
  return { onSelect, onClose }
}

describe('SlashCommandPopover', () => {
  it('lists matching commands', () => {
    renderPopover('hel')
    expect(screen.getByText('/help')).toBeInTheDocument()
  })

  it('selects command on click', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderPopover('')

    await user.click(screen.getByRole('option', { name: /\/help/i }))
    expect(onSelect).toHaveBeenCalledWith(COMMANDS[0])
  })
})
