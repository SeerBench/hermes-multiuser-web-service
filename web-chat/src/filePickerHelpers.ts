/** File picker dialog list paging / filter (composer attach sheet). */

import type { FileTag, PlatformFile } from './platformClient'

export const FILE_PICKER_PAGE_SIZE_DESKTOP = 20
export const FILE_PICKER_PAGE_SIZE_MOBILE = 15

export type FilePickerSortKey = 'created_at' | 'name' | 'size'
export type FilePickerSortOrder = 'asc' | 'desc'

export function filePickerPageSize(isMobile: boolean): number {
  return isMobile
    ? FILE_PICKER_PAGE_SIZE_MOBILE
    : FILE_PICKER_PAGE_SIZE_DESKTOP
}

export function filePickerTotalPages(
  itemCount: number,
  pageSize: number,
): number {
  if (itemCount <= 0 || pageSize <= 0) return 1
  return Math.max(1, Math.ceil(itemCount / pageSize))
}

/** Clamp page into ``[1, totalPages]`` then slice. */
export function sliceFilePickerPage<T>(
  items: T[],
  page: number,
  pageSize: number,
): { pageItems: T[]; safePage: number; totalPages: number } {
  const totalPages = filePickerTotalPages(items.length, pageSize)
  const safePage = Math.min(Math.max(1, page), totalPages)
  const start = (safePage - 1) * pageSize
  return {
    pageItems: items.slice(start, start + pageSize),
    safePage,
    totalPages,
  }
}

/** Filename contains + optional tag id filter. */
export function filterFilePickerFiles(
  files: PlatformFile[],
  opts: { query?: string; tagId?: string },
): PlatformFile[] {
  const q = (opts.query ?? '').trim().toLocaleLowerCase()
  const tagId = (opts.tagId ?? '').trim()
  return files.filter((f) => {
    if (tagId && !(f.tag_ids ?? []).includes(tagId)) return false
    if (q && !f.filename.toLocaleLowerCase().includes(q)) return false
    return true
  })
}

export function sortFilePickerFiles(
  files: PlatformFile[],
  sort: FilePickerSortKey,
  order: FilePickerSortOrder,
): PlatformFile[] {
  const mul = order === 'asc' ? 1 : -1
  return [...files].sort((a, b) => {
    if (sort === 'name') {
      return mul * a.filename.localeCompare(b.filename, undefined, {
        sensitivity: 'base',
      })
    }
    if (sort === 'size') {
      return mul * ((a.size_bytes ?? 0) - (b.size_bytes ?? 0))
    }
    return mul * ((a.created_at ?? 0) - (b.created_at ?? 0))
  })
}

/** Resolve tag filter select value against known tags (empty = all). */
export function resolveFilePickerTagFilter(
  tagId: string,
  tags: Pick<FileTag, 'id'>[],
): string {
  if (!tagId) return ''
  return tags.some((tg) => tg.id === tagId) ? tagId : ''
}
