import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../i18n'
import {
  isImageAttachmentName,
  PendingAttachments,
  type PendingAttachment,
} from './AttachmentChips'

describe('isImageAttachmentName', () => {
  it('detects common image extensions case-insensitively', () => {
    expect(isImageAttachmentName('shot.PNG')).toBe(true)
    expect(isImageAttachmentName('a.webp')).toBe(true)
    expect(isImageAttachmentName('notes.md')).toBe(false)
  })
})

describe('PendingAttachments', () => {
  it('renders hover image preview when previewUrl is set for an image', () => {
    const items: PendingAttachment[] = [
      {
        id: '1',
        name: 'photo.jpg',
        size: 1200,
        status: 'done',
        path: '/uploads/photo.jpg',
        previewUrl: 'blob:http://localhost/preview-1',
      },
    ]
    render(
      <LocaleProvider>
        <PendingAttachments items={items} onRemove={vi.fn()} />
      </LocaleProvider>,
    )

    const chip = screen.getByTitle('photo.jpg')
    expect(chip.className).toContain('attach-chip--image')
    const preview = chip.querySelector(
      'img.attach-preview-img',
    ) as HTMLImageElement | null
    expect(preview).toBeTruthy()
    expect(preview?.getAttribute('src')).toBe('blob:http://localhost/preview-1')
  })

  it('does not render image preview for non-image attachments', () => {
    const items: PendingAttachment[] = [
      {
        id: '2',
        name: 'notes.md',
        size: 40,
        status: 'done',
        path: '/uploads/notes.md',
        previewUrl: 'blob:http://localhost/should-not-show',
      },
    ]
    render(
      <LocaleProvider>
        <PendingAttachments items={items} onRemove={vi.fn()} />
      </LocaleProvider>,
    )

    const chip = screen.getByTitle('notes.md')
    expect(chip.className).not.toContain('attach-chip--image')
    expect(chip.querySelector('img.attach-preview-img')).toBeNull()
  })
})
