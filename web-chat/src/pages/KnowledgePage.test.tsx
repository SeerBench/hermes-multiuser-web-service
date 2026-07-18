import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LocaleProvider } from '../i18n'
import { KnowledgePage } from './KnowledgePage'

vi.mock('../platformClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platformClient')>()
  return {
    ...actual,
    getStoredWorkspaceId: vi.fn(() => 'ws-1'),
    platform: {
      ...actual.platform,
      listKnowledgeBases: vi.fn(),
      getKnowledgeStats: vi.fn(),
      listFiles: vi.fn(),
      createKnowledgeBase: vi.fn(),
      getKnowledgeBase: vi.fn(),
      deleteKnowledgeBase: vi.fn(),
      reindexKnowledgeBase: vi.fn(),
      searchKnowledgeBases: vi.fn(),
    },
  }
})

import { platform } from '../platformClient'

describe('Knowledge Center', () => {
  beforeEach(() => {
    localStorage.setItem('hermes-locale', 'en')
    vi.mocked(platform.listKnowledgeBases).mockResolvedValue({
      items: [
        {
          id: 'kb-1',
          user_id: 'u1',
          workspace_id: 'ws-1',
          name: 'Trading notes',
          description: 'MVP collection',
          category: 'trading',
          status: 'ready',
          file_count: 1,
          chunk_count: 3,
          updated_at: '2026-07-01T00:00:00Z',
        },
      ],
    })
    vi.mocked(platform.getKnowledgeStats).mockResolvedValue({
      knowledge_count: 1,
      document_count: 1,
      chunk_count: 3,
      last_updated_at: '2026-07-01T00:00:00Z',
    })
    vi.mocked(platform.listFiles).mockResolvedValue([
      {
        id: 'f-1',
        filename: 'alpha.txt',
        status: 'ready',
        created_at: 1,
      },
    ])
    vi.mocked(platform.createKnowledgeBase).mockResolvedValue({
      id: 'kb-2',
      user_id: 'u1',
      workspace_id: 'ws-1',
      name: 'New KB',
      category: 'tech',
      status: 'ready',
      file_count: 1,
      chunk_count: 1,
    })
    vi.mocked(platform.getKnowledgeBase).mockResolvedValue({
      id: 'kb-1',
      user_id: 'u1',
      workspace_id: 'ws-1',
      name: 'Trading notes',
      category: 'trading',
      status: 'ready',
      file_count: 1,
      chunk_count: 3,
      files: [{ file_id: 'f-1', filename: 'alpha.txt', status: 'ready' }],
    })
    vi.mocked(platform.deleteKnowledgeBase).mockResolvedValue({
      status: 'deleted',
    })
  })

  it('lists knowledge bases and opens create tab with file picker', async () => {
    const user = userEvent.setup()
    render(
      <LocaleProvider>
        <KnowledgePage />
      </LocaleProvider>,
    )

    expect(
      await screen.findByRole('heading', { name: /knowledge center/i }),
    ).toBeInTheDocument()
    expect(await screen.findByText('Trading notes')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /my knowledge bases/i })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /^create$/i }))
    expect(await screen.findByText('alpha.txt')).toBeInTheDocument()

    await user.type(
      screen.getByPlaceholderText(/trading notes/i),
      'New KB',
    )
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: /create & index/i }))

    await waitFor(() => {
      expect(platform.createKnowledgeBase).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({
          name: 'New KB',
          file_ids: ['f-1'],
        }),
      )
    })
  })

  it('opens detail dialog from list', async () => {
    const user = userEvent.setup()
    render(
      <LocaleProvider>
        <KnowledgePage />
      </LocaleProvider>,
    )

    await screen.findByText('Trading notes')
    await user.click(screen.getByRole('button', { name: /details/i }))

    await waitFor(() => {
      expect(platform.getKnowledgeBase).toHaveBeenCalledWith('ws-1', 'kb-1')
    })
    expect(await screen.findByText('alpha.txt')).toBeInTheDocument()
  })
})
