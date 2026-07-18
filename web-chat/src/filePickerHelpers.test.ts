import { describe, expect, it } from 'vitest'
import {
  FILE_PICKER_PAGE_SIZE_DESKTOP,
  FILE_PICKER_PAGE_SIZE_MOBILE,
  filePickerPageSize,
  filePickerTotalPages,
  sliceFilePickerPage,
} from './filePickerHelpers'

describe('filePickerHelpers', () => {
  it('uses 20 on desktop and 15 on mobile', () => {
    expect(filePickerPageSize(false)).toBe(FILE_PICKER_PAGE_SIZE_DESKTOP)
    expect(filePickerPageSize(true)).toBe(FILE_PICKER_PAGE_SIZE_MOBILE)
    expect(FILE_PICKER_PAGE_SIZE_DESKTOP).toBe(20)
    expect(FILE_PICKER_PAGE_SIZE_MOBILE).toBe(15)
  })

  it('slices pages and clamps out-of-range page', () => {
    const items = Array.from({ length: 45 }, (_, i) => i + 1)
    const first = sliceFilePickerPage(items, 1, 20)
    expect(first.pageItems).toEqual(items.slice(0, 20))
    expect(first.totalPages).toBe(3)

    const last = sliceFilePickerPage(items, 99, 20)
    expect(last.safePage).toBe(3)
    expect(last.pageItems).toEqual(items.slice(40, 45))

    const mobile = sliceFilePickerPage(items, 2, 15)
    expect(mobile.pageItems).toHaveLength(15)
    expect(mobile.pageItems[0]).toBe(16)
  })

  it('total pages is at least 1 when empty', () => {
    expect(filePickerTotalPages(0, 20)).toBe(1)
  })
})
