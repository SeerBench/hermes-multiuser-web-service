import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import { LocaleProvider } from '../i18n'
import { MemoryPage } from './MemoryPage'
import type { MemoryItem } from '../platformClient'

vi.mock('../platformClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platformClient')>()
  return {
    ...actual,
    getStoredWorkspaceId: () => 'ws-1',
    platform: {
      ...actual.platform,
      migrateMemoryFromFiles: vi.fn(),
      getMemoryStats: vi.fn(),
      listMemoryItems: vi.fn(),
      createMemoryItem: vi.fn(),
      updateMemoryItem: vi.fn(),
      deleteMemoryItem: vi.fn(),
      approveMemoryItem: vi.fn(),
      rejectMemoryItem: vi.fn(),
    },
  }
})

import { platform } from '../platformClient'

const pendingItem: MemoryItem = {
  id: 'm-pending',
  user_id: 'u1',
  workspace_id: 'ws-1',
  category: 'preference',
  content: 'User wants all agent ops via UI',
  source: 'agent_tool',
  confidence: 0.9,
  status: 'pending',
  importance: 70,
  source_ref: '2026-06-30 chat',
  updated_at: '2026-06-30T12:00:00Z',
}

const profileItem: MemoryItem = {
  id: 'm-profile',
  user_id: 'u1',
  workspace_id: 'ws-1',
  category: 'profile',
  content: 'Senior engineer',
  source: 'manual',
  confidence: 1,
  status: 'active',
  importance: 80,
  updated_at: '2026-06-28T12:00:00Z',
}

describe('Memory Center', () => {
  beforeEach(() => {
    localStorage.setItem('hermes-locale', 'en')
    vi.mocked(platform.migrateMemoryFromFiles).mockResolvedValue({ imported: 0 })
    vi.mocked(platform.getMemoryStats).mockResolvedValue({
      total: 1,
      pending: 1,
      last_updated_at: '2026-06-30T12:00:00Z',
    })
    vi.mocked(platform.listMemoryItems).mockImplementation(
      async (_wid, params) => {
        if (params?.status === 'pending') {
          return { items: [pendingItem] }
        }
        if (params?.category === 'profile') {
          return { items: [profileItem] }
        }
        return { items: [profileItem, pendingItem] }
      },
    )
    vi.mocked(platform.approveMemoryItem).mockResolvedValue({
      ...pendingItem,
      status: 'active',
    })
    vi.mocked(platform.rejectMemoryItem).mockResolvedValue({
      ...pendingItem,
      status: 'archived',
    })
  })

  it('shows stats and profile memories', async () => {
    render(
      <LocaleProvider>
        <MemoryPage />
      </LocaleProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText(/Total/i)).toBeInTheDocument()
      expect(screen.getByText('Senior engineer')).toBeInTheDocument()
    })
    expect(platform.migrateMemoryFromFiles).toHaveBeenCalledWith('ws-1')
  })

  it('approves a pending suggestion with toast', async () => {
    const user = userEvent.setup()
    const successSpy = vi.spyOn(toast, 'success')

    render(
      <LocaleProvider>
        <MemoryPage />
      </LocaleProvider>,
    )

    await user.click(screen.getByRole('tab', { name: /AI suggestions/i }))
    await waitFor(() => {
      expect(
        screen.getByText('User wants all agent ops via UI'),
      ).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => {
      expect(platform.approveMemoryItem).toHaveBeenCalledWith(
        'ws-1',
        'm-pending',
      )
      expect(successSpy).toHaveBeenCalledWith('Memory saved.')
    })
  })

  it('filters all tab by search query', async () => {
    const user = userEvent.setup()
    render(
      <LocaleProvider>
        <MemoryPage />
      </LocaleProvider>,
    )

    await user.click(screen.getByRole('tab', { name: /^all$/i }))
    const search = await screen.findByLabelText(/search memories/i)
    await user.type(search, 'risk')

    await waitFor(() => {
      expect(platform.listMemoryItems).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({ q: 'risk' }),
      )
    })
  })
})
