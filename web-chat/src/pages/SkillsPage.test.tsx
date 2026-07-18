import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import { LocaleProvider } from '../i18n'
import { SkillsPage } from './SkillsPage'

vi.mock('../platformClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platformClient')>()
  return {
    ...actual,
    getStoredWorkspaceId: vi.fn(() => 'ws-1'),
    platform: {
      ...actual.platform,
      listSkills: vi.fn(),
      getSkill: vi.fn(),
      installSkillFromCatalog: vi.fn(),
      patchSkill: vi.fn(),
      createSkill: vi.fn(),
      enableSkill: vi.fn(),
      disableSkill: vi.fn(),
      deleteSkill: vi.fn(),
      replaceSkill: vi.fn(),
    },
  }
})

import { platform } from '../platformClient'

describe('Skill Center', () => {
  beforeEach(() => {
    localStorage.setItem('hermes-locale', 'en')
    vi.mocked(platform.listSkills).mockResolvedValue([
      {
        name: 'arxiv',
        source: 'global',
        description: 'Search papers',
        enabled: true,
        status: 'enabled',
        version: '1.0',
      },
      {
        name: 'my-helper',
        source: 'user',
        description: 'Custom helper',
        enabled: true,
        status: 'enabled',
        version: '1.0',
        updated_at: '2026-07-01T00:00:00Z',
        config: {},
      },
    ])
    vi.mocked(platform.getSkill).mockResolvedValue({
      name: 'arxiv',
      source: 'global',
      category: 'research',
      description: 'Search papers',
      content: '---\nname: arxiv\n---\n# arxiv\n',
    })
    vi.mocked(platform.installSkillFromCatalog).mockResolvedValue({
      success: true,
      name: 'arxiv',
      category: 'research',
      source: 'user',
    })
    vi.mocked(platform.createSkill).mockResolvedValue({
      success: true,
      name: 'futures-analysis',
    })
    vi.mocked(platform.disableSkill).mockResolvedValue({
      name: 'my-helper',
      enabled: false,
      status: 'disabled',
    })
    vi.mocked(platform.patchSkill).mockResolvedValue({
      name: 'my-helper',
      config: { a: 1 },
    })
  })

  it('splits mine vs catalog tabs and installs from the library', async () => {
    const user = userEvent.setup()
    render(
      <LocaleProvider>
        <SkillsPage />
      </LocaleProvider>,
    )

    expect(
      await screen.findByRole('tab', { name: /my skills/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /create skill/i }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /global skill library/i }))
    expect(await screen.findByText('arxiv')).toBeInTheDocument()
    expect(screen.getByText(/search papers/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /add to workspace/i }))
    expect(platform.installSkillFromCatalog).toHaveBeenCalledWith('ws-1', 'arxiv')
  })

  it('creates a skill from the structured form', async () => {
    const user = userEvent.setup()
    const successSpy = vi.spyOn(toast, 'success')
    render(
      <LocaleProvider>
        <SkillsPage />
      </LocaleProvider>,
    )

    await user.click(await screen.findByRole('button', { name: /create skill/i }))
    const nameInput = await screen.findByPlaceholderText(/futures-analysis/i)
    await user.type(nameInput, 'Futures Analysis')
    await user.type(
      screen.getByLabelText(/^description$/i),
      'Analyze futures markets',
    )

    const createButtons = screen.getAllByRole('button', { name: /^create skill$/i })
    await user.click(createButtons[createButtons.length - 1])

    await waitFor(() => {
      expect(platform.createSkill).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({
          name: 'Futures Analysis',
          description: 'Analyze futures markets',
          type: 'assistant',
        }),
      )
      expect(successSpy).toHaveBeenCalled()
    })
  })

  it('disables a personal skill', async () => {
    const user = userEvent.setup()
    render(
      <LocaleProvider>
        <SkillsPage />
      </LocaleProvider>,
    )

    expect(await screen.findByText('my-helper')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^disable$/i }))
    await waitFor(() => {
      expect(platform.disableSkill).toHaveBeenCalledWith('ws-1', 'my-helper')
    })
  })

  it('shows Chinese short descriptions in the catalog when locale is zh', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem('hermes-locale', 'zh')
    render(
      <LocaleProvider>
        <SkillsPage />
      </LocaleProvider>,
    )

    await user.click(
      await screen.findByRole('tab', { name: /全局技能库/ }),
    )
    expect(await screen.findByText('arxiv')).toBeInTheDocument()
    expect(screen.getByText(/检索 arXiv/)).toBeInTheDocument()
    expect(screen.queryByText('Search papers')).not.toBeInTheDocument()
    window.localStorage.removeItem('hermes-locale')
  })
})
