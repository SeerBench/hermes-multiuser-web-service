import { render, screen, within } from '@testing-library/react'
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

  it('opens a searchable model dropdown instead of a dialog', async () => {
    const user = userEvent.setup()
    const onModelChange = vi.fn()
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
          models={[
            { id: 'deepseek-v4-pro' },
            { id: 'claude-sonnet-4.6' },
            { id: 'gpt-5.6-sol-pro' },
          ]}
          selectedModel="deepseek-v4-pro"
          onModelChange={onModelChange}
        />
      </LocaleProvider>,
    )

    await user.click(screen.getByRole('button', { name: /choose model/i }))
    const search = await screen.findByPlaceholderText(/search models/i)
    expect(search).toBeTruthy()
    const popover = search.closest('[data-slot="popover-content"]')
    expect(popover).toBeTruthy()
    expect(popover).toHaveTextContent('DeepSeek V4 Pro')
    expect(popover).toHaveTextContent('Claude Sonnet 4.6')

    await user.type(search, 'claude')
    expect(popover).not.toHaveTextContent('DeepSeek V4 Pro')
    expect(popover).toHaveTextContent('Claude Sonnet 4.6')

    await user.click(
      within(popover as HTMLElement).getByRole('option', {
        name: /claude sonnet 4\.6/i,
      }),
    )
    expect(onModelChange).toHaveBeenCalledWith('claude-sonnet-4.6')
  })

  it('uses a 2-line autosize textarea (grows up to 5 lines in CSS/JS)', () => {
    render(
      <LocaleProvider>
        <ChatComposer
          input="hello"
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
          models={[]}
          selectedModel=""
          onModelChange={noop}
        />
      </LocaleProvider>,
    )

    const ta = screen.getByPlaceholderText('msg') as HTMLTextAreaElement
    expect(ta.rows).toBe(2)
    expect(ta.className).toContain('composer-hmu-input')
  })

  it('adds focus-inputting only while the textarea has focus', async () => {
    const user = userEvent.setup()
    const { container } = render(
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
          placeholder="focus message"
          showSlashPopover={false}
          slashQuery={null}
          commandCatalog={[]}
          onSlashSelect={noop}
          onSlashClose={noop}
          models={[]}
          selectedModel=""
          onModelChange={noop}
        />
      </LocaleProvider>,
    )

    const box = container.querySelector('.composer-hmu-box')
    const textarea = screen.getByPlaceholderText('focus message')
    expect(box).not.toHaveClass('focus-inputting')

    await user.click(textarea)
    expect(box).toHaveClass('focus-inputting')

    await user.tab()
    expect(box).not.toHaveClass('focus-inputting')
  })
})
