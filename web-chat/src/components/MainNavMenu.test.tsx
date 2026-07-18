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
  const slot = props.slot ?? 'tabs'
  render(
    <LocaleProvider>
      <MainNavMenu
        activeTab="chat"
        platformMode
        onMainTab={onMainTab}
        slot={slot}
        {...props}
      />
    </LocaleProvider>,
  )
  return { onMainTab }
}

describe('MainNavMenu', () => {
  it('tabs slot renders desktop chat/workspace tabs with center class', () => {
    renderMenu({ slot: 'tabs' })
    const tabs = screen.getByRole('tab', { name: /对话|Chat/i }).closest(
      '.app-nav-tabs',
    )
    expect(tabs).toBeTruthy()
    expect(
      screen.getByRole('tab', { name: /工作区|Workspace/i }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /主导航|Main menu/i }),
    ).toBeNull()
  })

  it('hides workspace tab when not in platform mode', () => {
    renderMenu({ slot: 'tabs', platformMode: false })
    expect(screen.getByRole('tab', { name: /对话|Chat/i })).toBeInTheDocument()
    expect(
      screen.queryByRole('tab', { name: /工作区|Workspace/i }),
    ).toBeNull()
  })

  it('desktop tab click switches to workspace', async () => {
    const user = userEvent.setup()
    const { onMainTab } = renderMenu({ slot: 'tabs' })
    await user.click(screen.getByRole('tab', { name: /工作区|Workspace/i }))
    expect(onMainTab).toHaveBeenCalledWith('workspace')
  })

  it('menu slot renders hamburger for mobile (left of avatar)', () => {
    renderMenu({ slot: 'menu' })
    const menu = screen
      .getByRole('button', { name: /主导航|Main menu/i })
      .closest('.app-nav-menu')
    expect(menu).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('mobile menu lists chat and workspace and navigates', async () => {
    const user = userEvent.setup()
    const { onMainTab } = renderMenu({ slot: 'menu', activeTab: 'workspace' })
    await user.click(screen.getByRole('button', { name: /主导航|Main menu/i }))
    await user.click(screen.getByRole('menuitem', { name: /对话|Chat/i }))
    expect(onMainTab).toHaveBeenCalledWith('chat')
  })

  it('mobile menu can open workspace', async () => {
    const user = userEvent.setup()
    const { onMainTab } = renderMenu({ slot: 'menu' })
    await user.click(screen.getByRole('button', { name: /主导航|Main menu/i }))
    await user.click(screen.getByRole('menuitem', { name: /工作区|Workspace/i }))
    expect(onMainTab).toHaveBeenCalledWith('workspace')
  })
})
