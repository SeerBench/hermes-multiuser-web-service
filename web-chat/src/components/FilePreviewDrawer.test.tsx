import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../i18n'
import { FilePreviewDrawer } from './FilePreviewDrawer'

describe('FilePreviewDrawer', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches and shows markdown content when open', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '# Hello',
      }),
    )

    render(
      <LocaleProvider>
        <FilePreviewDrawer
          open
          onOpenChange={() => {}}
          workspaceId="ws-1"
          file={{ fileId: 'f1', name: 'notes.md' }}
        />
      </LocaleProvider>,
    )

    expect(screen.getByText('notes.md')).toBeTruthy()
    await waitFor(() => {
      expect(document.querySelector('.file-preview-md .md')).toBeTruthy()
    })
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/workspaces/ws-1/files/f1/content',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('embeds pdf via iframe', () => {
    render(
      <LocaleProvider>
        <FilePreviewDrawer
          open
          onOpenChange={() => {}}
          workspaceId="ws-1"
          file={{ fileId: 'f2', name: 'a.pdf' }}
        />
      </LocaleProvider>,
    )

    const iframe = document.querySelector(
      'iframe.file-preview-pdf',
    ) as HTMLIFrameElement | null
    expect(iframe).toBeTruthy()
    expect(iframe?.getAttribute('src')).toBe(
      '/api/v1/workspaces/ws-1/files/f2/content',
    )
  })
})
