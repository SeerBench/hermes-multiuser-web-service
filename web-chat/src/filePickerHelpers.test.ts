import { describe, expect, it } from 'vitest'
import {
  FILE_PICKER_PAGE_SIZE_DESKTOP,
  FILE_PICKER_PAGE_SIZE_MOBILE,
  filterFilePickerFiles,
  filePickerPageSize,
  filePickerTotalPages,
  resolveFilePickerTagFilter,
  sliceFilePickerPage,
  sortFilePickerFiles,
} from './filePickerHelpers'
import type { PlatformFile } from './platformClient'

function file(
  partial: Partial<PlatformFile> & Pick<PlatformFile, 'id' | 'filename'>,
): PlatformFile {
  return {
    status: 'ready',
    created_at: 0,
    size_bytes: 0,
    tag_ids: [],
    ...partial,
  }
}

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

  it('filters by filename and tag id', () => {
    const rows = [
      file({ id: '1', filename: 'Alpha.pdf', tag_ids: ['t1'] }),
      file({ id: '2', filename: 'beta.txt', tag_ids: ['t2'] }),
      file({ id: '3', filename: 'alpha-notes.md', tag_ids: ['t1', 't2'] }),
    ]
    expect(filterFilePickerFiles(rows, { query: 'alpha' })).toHaveLength(2)
    expect(
      filterFilePickerFiles(rows, { query: 'alpha', tagId: 't1' }).map(
        (f) => f.id,
      ),
    ).toEqual(['1', '3'])
    expect(filterFilePickerFiles(rows, { tagId: 't2' })).toHaveLength(2)
  })

  it('sorts by name and size', () => {
    const rows = [
      file({ id: 'a', filename: 'b.txt', size_bytes: 10, created_at: 1 }),
      file({ id: 'b', filename: 'a.txt', size_bytes: 30, created_at: 2 }),
    ]
    expect(sortFilePickerFiles(rows, 'name', 'asc').map((f) => f.id)).toEqual([
      'b',
      'a',
    ])
    expect(sortFilePickerFiles(rows, 'size', 'desc').map((f) => f.id)).toEqual([
      'b',
      'a',
    ])
  })

  it('resolves stale tag filter to all', () => {
    expect(resolveFilePickerTagFilter('gone', [{ id: 't1' }])).toBe('')
    expect(resolveFilePickerTagFilter('t1', [{ id: 't1' }])).toBe('t1')
  })
})
