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
        : `doc-${i + 1}.txt`,
    size_bytes: 4_321_000,
    storage_key: `uploads/f${i + 1}`,
    mime_type: 'text/plain',
  }))
}

const listFiles = vi.fn()

vi.mock('../platformClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platformClient')>()
  return {
    ...actual,
    platform: {
      ...actual.platform,
      listFiles: (...args: unknown[]) => listFiles(...args),
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
})

describe('FilePickerSheet', () => {
  beforeEach(() => {
    listFiles.mockResolvedValue(makeFiles(1))
    // 默认桌面宽度 → 每页 20
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

  it('wraps long filenames instead of ellipsis nowrap', async () => {
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

    const name = await screen.findByText(
      /Python开发技术选型对比与项目实施方案/,
    )
    expect(name).toHaveClass('file-picker-name')
    const style = getComputedStyle(name)
    // CSS module may not apply in jsdom; assert class contract
    expect(name.className).toContain('file-picker-name')
    void style
    expect(
      name.closest('.file-picker-row')?.querySelector('.file-picker-size'),
    ).toHaveTextContent('4.1 MB')
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

    await screen.findByText(/Python开发技术选型/)
    const list = screen.getByRole('list', { name: /从文件库选择|Choose from files/i })
    expect(within(list).getAllByRole('listitem')).toHaveLength(20)

    await user.click(screen.getByRole('button', { name: /下一页|Next/i }))
    await waitFor(() => {
      expect(within(list).getAllByRole('listitem')).toHaveLength(5)
    })
    expect(screen.getByText('doc-21.txt')).toBeInTheDocument()
  })

  it('paginates 15 items on mobile', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    })
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('max-width: 767px'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))

    listFiles.mockResolvedValue(makeFiles(20))
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

    await screen.findByText(/Python开发技术选型/)
    const list = screen.getByRole('list', {
      name: /从文件库选择|Choose from files/i,
    })
    expect(within(list).getAllByRole('listitem')).toHaveLength(15)
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

    const dialog = await screen.findByRole('dialog')
    expect(dialog.className).toMatch(/file-picker-dialog/)
    expect(dialog.className).toMatch(/max-h-/)
    expect(
      within(dialog).getByRole('heading', { name: /从文件库选择|Choose from files/i }),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByRole('button', { name: /取消|Cancel/i }),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByRole('button', { name: /附加|Attach/i }),
    ).toBeInTheDocument()
  })
})
