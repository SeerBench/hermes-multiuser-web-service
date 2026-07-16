import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchWorkspaceImagePreviewUrl,
  isDrawerPreviewableName,
  isImageAttachment,
  isImageAttachmentName,
} from './attachmentPreview'

describe('attachment preview helpers', () => {
  it('detects image filenames', () => {
    expect(isImageAttachmentName('a.PNG')).toBe(true)
    expect(isImageAttachmentName('a.md')).toBe(false)
  })

  it('detects images by mime type when filename lacks extension', () => {
    expect(
      isImageAttachment('62ab3b44b270fb', { mimeType: 'image/png' }),
    ).toBe(true)
    expect(
      isImageAttachment('62ab3b44b270fb', { path: 'uploads/x/photo.webp' }),
    ).toBe(true)
    expect(isImageAttachment('notes.txt', { mimeType: 'text/plain' })).toBe(
      false,
    )
  })

  it('detects md/pdf as drawer-previewable docs', () => {
    expect(isDrawerPreviewableName('readme.md')).toBe(true)
    expect(isDrawerPreviewableName('spec.PDF')).toBe(true)
    expect(isDrawerPreviewableName('notes.txt')).toBe(false)
    expect(isDrawerPreviewableName('shot.png')).toBe(false)
  })
})

describe('fetchWorkspaceImagePreviewUrl', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal(
      'URL',
      Object.assign(globalThis.URL, {
        createObjectURL: vi.fn(() => 'blob:preview-1'),
        revokeObjectURL: vi.fn(),
      }),
    )
  })

  it('fetches content with credentials and returns a blob URL', async () => {
    const blob = new Blob(['x'], { type: 'image/png' })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: async () => blob,
      }),
    )

    const url = await fetchWorkspaceImagePreviewUrl('ws-1', 'file-9')
    expect(url).toBe('blob:preview-1')
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/workspaces/ws-1/files/file-9/content',
      { credentials: 'include' },
    )
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob)
  })
})
