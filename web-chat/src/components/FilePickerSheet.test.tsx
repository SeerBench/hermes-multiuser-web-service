import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../i18n'
import { FilePickerSheet } from './FilePickerSheet'

function makeFiles(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `file-${i + 1}`,
    filename:
      i === 0
        ? 'Python开发技术选型对比与项目实施方案-这是一个非常长的文件名称.pdf'
        : i === 1
          ? 'notes.md'
          : `doc-${i + 1}.txt`,
    size_bytes: 4_321_000,
    storage_key: `uploads/f${i + 1}`,
    mime_type: i === 0 ? 'application/pdf' : 'text/plain',
    status: i === 2 ? 'processing' : 'ready',
    tag_ids: i % 2 === 0 ? ['tag-a'] : ['tag-b'],
    created_at: 1_700_000_000 + i,
  }))
}

const listFiles = vi.fn()
const listFileTags = vi.fn()

vi.mock('../platformClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platformClient')>()
  return {
    ...actual,
    platform: {
      ...actual.platform,
      listFiles: (...args: unknown[]) => listFiles(...args),
      listFileTags: (...args: unknown[]) => listFileTags(...args),
    },
  }
})

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

afterEach(() => {
  cleanup()
  listFiles.mockReset()
  listFileTags.mockReset()
})

describe('FilePickerSheet', () => {
  beforeEach(() => {
    listFiles.mockResolvedValue(makeFiles(1))
    listFileTags.mockResolvedValue([
      { id: 'tag-a', name: 'Alpha', created_at: 1 },
      { id: 'tag-b', name: 'Beta', created_at: 2 },
    ])
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1024,
    })
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('max-width')
        ? window.innerWidth < 768
        : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  })

  it('wraps long filenames and shows retrieval status after size', async () => {
    render(
      <LocaleProvider>
        <FilePickerSheet
          open
          onOpenChange={vi.fn()}
          workspaceId="ws-1"
          onConfirm={vi.fn()}
        />
      </LocaleProvider>,
    )

    const name = await screen.findByRole('button', {
      name: /Python开发技术选型对比与项目实施方案/,
    })
    expect(name).toHaveClass('file-picker-name--link')
    const row = name.closest('.file-picker-row')
    expect(row?.querySelector('.file-picker-size')).toHaveTextContent('4.1 MB')
    expect(row?.querySelector('.file-picker-status')).toHaveTextContent(
      /可被检索|Ready|Searchable/i,
    )
  })

  it('filters by filename search and tag', async () => {
    const user = userEvent.setup()
    listFiles.mockResolvedValue(makeFiles(4))
    render(
      <LocaleProvider>
        <FilePickerSheet
          open
          onOpenChange={vi.fn()}
          workspaceId="ws-1"
          onConfirm={vi.fn()}
        />
      </LocaleProvider>,
    )

    await screen.findByRole('button', { name: /Python开发技术选型/ })
    const search = screen.getByPlaceholderText(/按名称搜索|Search by name/i)
    await user.clear(search)
    await user.type(search, 'notes')
    await waitFor(() => {
      expect(screen.getByText('notes.md')).toBeInTheDocument()
      expect(screen.queryByText('doc-3.txt')).toBeNull()
    })

    await user.clear(search)
    const tagSelect = screen.getByLabelText(/标签|Tag/i)
    await user.selectOptions(tagSelect, 'tag-a')
    await waitFor(() => {
      const list = screen.getByRole('list', {
        name: /从文件库选择|Choose from files/i,
      })
      const items = within(list).getAllByRole('listitem')
      expect(items.length).toBeGreaterThanOrEqual(1)
      expect(within(list).queryByText('notes.md')).toBeNull()
    })
  })

  it('opens elevated preview drawer when clicking a previewable name', async () => {
    const user = userEvent.setup()
    listFiles.mockResolvedValue(makeFiles(2))
    render(
      <LocaleProvider>
        <FilePickerSheet
          open
          onOpenChange={vi.fn()}
          workspaceId="ws-1"
          onConfirm={vi.fn()}
        />
      </LocaleProvider>,
    )

    const pdfName = await screen.findByRole('button', {
      name: /Python开发技术选型/,
    })
    await user.click(pdfName)
    await waitFor(() => {
      const drawer = document.querySelector('.file-preview-drawer--elevated')
      expect(drawer).toBeTruthy()
    })
    expect(
      screen.getByRole('dialog', { name: /Python开发技术选型/ }),
    ).toBeInTheDocument()
  })

  it('paginates 20 items on desktop and can flip pages', async () => {
    const user = userEvent.setup()
    listFiles.mockResolvedValue(makeFiles(25))
    render(
      <LocaleProvider>
        <FilePickerSheet
          open
          onOpenChange={vi.fn()}
          workspaceId="ws-1"
          onConfirm={vi.fn()}
        />
      </LocaleProvider>,
    )

    // Default sort is created_at desc → newest (doc-25) first; PDF is last page.
    await screen.findByText('doc-25.txt')
    const list = screen.getByRole('list', {
      name: /从文件库选择|Choose from files/i,
    })
    expect(within(list).getAllByRole('listitem')).toHaveLength(20)
    expect(within(list).queryByText(/Python开发技术选型/)).toBeNull()

    await user.click(screen.getByRole('button', { name: /下一页|Next/i }))
    await waitFor(() => {
      expect(within(list).getAllByRole('listitem')).toHaveLength(5)
    })
    expect(screen.getByText('doc-5.txt')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Python开发技术选型/ }),
    ).toBeInTheDocument()
  })

  it('keeps header and footer actions visible in the dialog shell', async () => {
    listFiles.mockResolvedValue(makeFiles(3))
    render(
      <LocaleProvider>
        <FilePickerSheet
          open
          onOpenChange={vi.fn()}
          workspaceId="ws-1"
          onConfirm={vi.fn()}
        />
      </LocaleProvider>,
    )

    const dialog = await screen.findByRole('dialog', {
      name: /从文件库选择|Choose from files/i,
    })
    expect(dialog.className).toMatch(/file-picker-dialog/)
    expect(
      within(dialog).getByRole('button', { name: /取消|Cancel/i }),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByRole('button', { name: /附加|Attach/i }),
    ).toBeInTheDocument()
  })
})
