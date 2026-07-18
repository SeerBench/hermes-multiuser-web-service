/** File picker dialog list paging (composer attach sheet). */

export const FILE_PICKER_PAGE_SIZE_DESKTOP = 20
export const FILE_PICKER_PAGE_SIZE_MOBILE = 15

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
