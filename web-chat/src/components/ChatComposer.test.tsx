import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ChatComposer } from './ChatComposer'
import { LocaleProvider } from '../i18n'

function noop() {}

beforeAll(() => {
  // Radix DropdownMenu needs Pointer Capture APIs in jsdom.
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {}
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {}
  }
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = () => {}
  }
})

describe('ChatComposer', () => {
  it('opens the plus menu via portal so items are not clipped by overflow', async () => {
    const user = userEvent.setup()
    render(
      <LocaleProvider>
        <ChatComposer
          input=""
          onInputChange={noop}
          onSubmit={(e) => e?.preventDefault()}
          onKeyDown={noop}
          streaming={false}
          uploading={false}
          pending={[]}
          onRemovePending={noop}
          onPickFiles={noop}
          onAttachWorkspaceFiles={noop}
          onStop={noop}
          placeholder="msg"
          showSlashPopover={false}
          slashQuery={null}
          commandCatalog={[]}
          onSlashSelect={noop}
          onSlashClose={noop}
          platformMode
          workspaceId="ws-1"
          models={[]}
          selectedModel=""
          onModelChange={noop}
          enabledSkillsCount={90}
          onNavigate={vi.fn()}
        />
      </LocaleProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Tools' }))
    // Portaled content lands under document.body, outside composer-hmu-box.
    expect(await screen.findByText('Memory')).toBeTruthy()
    expect(screen.getByText(/Skills \(90 on\)/)).toBeTruthy()
    const menu = screen
      .getByText('Memory')
      .closest('[data-slot="dropdown-menu-content"]')
    expect(menu).toBeTruthy()
    expect(menu?.closest('.composer-hmu-box')).toBeNull()
  })
})
