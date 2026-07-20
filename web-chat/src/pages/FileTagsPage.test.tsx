import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LocaleProvider } from '../i18n'
import { FileTagsPage } from './FileTagsPage'

vi.mock('../platformClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platformClient')>()
  return {
    ...actual,
    getStoredWorkspaceId: () => 'ws-1',
    platform: {
      ...actual.platform,
      listFileTags: vi.fn(),
      listFiles: vi.fn(),
      createFileTag: vi.fn(),
      deleteFileTag: vi.fn(),
      patchFile: vi.fn(),
    },
  }
})

import { platform } from '../platformClient'

describe('FileTagsPage', () => {
  beforeEach(() => {
    localStorage.setItem('hermes-locale', 'zh')
    vi.mocked(platform.listFileTags).mockResolvedValue([
      { id: 't1', name: '重要资料', created_at: 1 },
      { id: 't2', name: '待审核', created_at: 2 },
    ])
    vi.mocked(platform.listFiles).mockResolvedValue([])
  })

  it('uses adaptive inline tags with icon-only delete actions', async () => {
    const { container } = render(
      <LocaleProvider>
        <FileTagsPage />
      </LocaleProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText('重要资料')).toBeInTheDocument()
    })
    const list = container.querySelector('.files-tags-list')
    expect(list).toHaveClass('files-tags-list')
    expect(list?.querySelectorAll('.files-tags-list-item')).toHaveLength(2)
    expect(
      screen.getByRole('button', { name: '删除标签：重要资料' }),
    ).toHaveAttribute('title', '删除标签：重要资料')
  })
})
