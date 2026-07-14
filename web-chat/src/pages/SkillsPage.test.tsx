import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    },
  }
})

import { platform } from '../platformClient'

describe('SkillsPage', () => {
  beforeEach(() => {
    vi.mocked(platform.listSkills).mockResolvedValue([
      {
        name: 'arxiv',
        source: 'global',
        description: 'Search papers',
        enabled: true,
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
  })

  it('installs a catalog skill into the workspace', async () => {
    const user = userEvent.setup()
    render(
      <LocaleProvider>
        <SkillsPage />
      </LocaleProvider>,
    )

    expect(await screen.findByText(/skill catalog/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /add to workspace/i }))

    expect(platform.installSkillFromCatalog).toHaveBeenCalledWith('ws-1', 'arxiv')
  })
})
