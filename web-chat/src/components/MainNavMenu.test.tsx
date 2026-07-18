import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { LocaleProvider } from '../i18n'
import { MainNavMenu } from './MainNavMenu'

beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {}
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {}
  }
})

afterEach(() => cleanup())

function renderMenu(props: Partial<ComponentProps<typeof MainNavMenu>> = {}) {
  const onMainTab = vi.fn()
  render(
    <LocaleProvider>
      <MainNavMenu
        activeTab="chat"
        platformMode
        onMainTab={onMainTab}
        {...props}
      />
    </LocaleProvider>,
  )
  return { onMainTab }
}

describe('MainNavMenu', () => {
  it('renders desktop chat/workspace tabs', () => {
    renderMenu()
    expect(screen.getByRole('tab', { name: /对话|Chat/i })).toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: /工作区|Workspace/i }),
    ).toBeInTheDocument()
  })

  it('hides workspace tab when not in platform mode', () => {
    renderMenu({ platformMode: false })
    expect(screen.getByRole('tab', { name: /对话|Chat/i })).toBeInTheDocument()
    expect(
      screen.queryByRole('tab', { name: /工作区|Workspace/i }),
    ).toBeNull()
  })

  it('desktop tab click switches to workspace', async () => {
    const user = userEvent.setup()
    const { onMainTab } = renderMenu()
    await user.click(screen.getByRole('tab', { name: /工作区|Workspace/i }))
    expect(onMainTab).toHaveBeenCalledWith('workspace')
  })

  it('mobile menu lists chat and workspace and navigates', async () => {
    const user = userEvent.setup()
    const { onMainTab } = renderMenu({ activeTab: 'workspace' })
    await user.click(screen.getByRole('button', { name: /主导航|Main menu/i }))
    await user.click(screen.getByRole('menuitem', { name: /对话|Chat/i }))
    expect(onMainTab).toHaveBeenCalledWith('chat')
  })

  it('mobile menu can open workspace', async () => {
    const user = userEvent.setup()
    const { onMainTab } = renderMenu()
    await user.click(screen.getByRole('button', { name: /主导航|Main menu/i }))
    await user.click(screen.getByRole('menuitem', { name: /工作区|Workspace/i }))
    expect(onMainTab).toHaveBeenCalledWith('workspace')
  })
})
