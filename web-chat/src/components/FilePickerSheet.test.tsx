import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../i18n'
import { FilePickerSheet } from './FilePickerSheet'

vi.mock('../platformClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platformClient')>()
  return {
    ...actual,
    platform: {
      ...actual.platform,
      listFiles: vi.fn().mockResolvedValue([
        {
          id: 'file-long',
          filename:
            'Python开发技术选型对比与项目实施方案-这是一个非常长的文件名称.pdf',
          size_bytes: 4_321_000,
          storage_key: 'uploads/long.pdf',
          mime_type: 'application/pdf',
        },
      ]),
    },
  }
})

describe('FilePickerSheet', () => {
  it('keeps long filenames on one line with a non-shrinking size label', async () => {
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
    expect(name.closest('.file-picker-row')?.querySelector('.file-picker-size'))
      .toHaveTextContent('4.1 MB')

    await waitFor(() => {
      expect(name.closest('.file-picker-row')).toBeTruthy()
    })
  })
})
