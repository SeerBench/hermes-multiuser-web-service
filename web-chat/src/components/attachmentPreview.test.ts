import { describe, expect, it } from 'vitest'
import {
  isDrawerPreviewableName,
  isImageAttachmentName,
} from './AttachmentChips'

describe('attachment preview helpers', () => {
  it('detects image filenames', () => {
    expect(isImageAttachmentName('a.PNG')).toBe(true)
    expect(isImageAttachmentName('a.md')).toBe(false)
  })

  it('detects md/pdf as drawer-previewable docs', () => {
    expect(isDrawerPreviewableName('readme.md')).toBe(true)
    expect(isDrawerPreviewableName('spec.PDF')).toBe(true)
    expect(isDrawerPreviewableName('notes.txt')).toBe(false)
    expect(isDrawerPreviewableName('shot.png')).toBe(false)
  })
})
