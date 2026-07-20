import type { FileFolder, FileTag, PlatformFile } from './platformClient'

export type FolderTreeNode = {
  id: string
  name: string
  depth: number
}

/** Page size for the workspace files table. */
export const FILES_PAGE_SIZE = 25

export type FilesListRow =
  | { kind: 'folder'; folder: FileFolder }
  | { kind: 'file'; file: PlatformFile }

/** Map API origin to i18n key: platform → workspace, chat → chat. */
export function fileOriginLabelKey(
  origin: string | undefined | null,
): 'files.origin.workspace' | 'files.origin.chat' {
  return origin === 'chat' ? 'files.origin.chat' : 'files.origin.workspace'
}

/** Only searchable (ready) documents can be cited into chat. */
export function canCiteFileToChat(file: {
  status: string
}): boolean {
  return file.status === 'ready'
}

/**
 * Folder list badge count: direct files (from API) + immediate subfolders.
 * Subfolder count is derived client-side from the loaded folder tree.
 */
export function folderContentCount(
  folder: Pick<FileFolder, 'id' | 'file_count'>,
  allFolders: Pick<FileFolder, 'id' | 'parent_id'>[],
): number {
  const files = folder.file_count ?? 0
  const subfolders = allFolders.filter(
    (f) => (f.parent_id ?? null) === folder.id,
  ).length
  return files + subfolders
}

/** Folders first, then files — one flat list for the table. */
export function buildFilesListRows(
  folders: FileFolder[],
  files: PlatformFile[],
): FilesListRow[] {
  return [
    ...folders.map((folder) => ({ kind: 'folder' as const, folder })),
    ...files.map((file) => ({ kind: 'file' as const, file })),
  ]
}

/** Case-insensitive name filter across folders and files. */
export function filterFilesListRows(
  rows: FilesListRow[],
  query: string,
): FilesListRow[] {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return rows
  return rows.filter((row) => {
    const name =
      row.kind === 'folder' ? row.folder.name : row.file.filename
    return name.toLocaleLowerCase().includes(q)
  })
}

export function filesListPageCount(
  total: number,
  pageSize: number = FILES_PAGE_SIZE,
): number {
  if (total <= 0) return 1
  return Math.max(1, Math.ceil(total / pageSize))
}

/** Slice rows for the current 1-based page. */
export function sliceFilesListPage<T>(
  rows: T[],
  page: number,
  pageSize: number = FILES_PAGE_SIZE,
): T[] {
  const safePage = Math.min(
    Math.max(1, page),
    filesListPageCount(rows.length, pageSize),
  )
  const start = (safePage - 1) * pageSize
  return rows.slice(start, start + pageSize)
}

/**
 * Compact page number list with ellipsis markers (-1).
 * Example: 1 … 4 5 6 … 12
 */
export function filesPaginationItems(
  current: number,
  totalPages: number,
): number[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1)
  }
  const pages = new Set<number>([1, totalPages, current])
  for (let d = 1; d <= 1; d++) {
    if (current - d > 1) pages.add(current - d)
    if (current + d < totalPages) pages.add(current + d)
  }
  const sorted = [...pages].sort((a, b) => a - b)
  const out: number[] = []
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i]!
    if (i > 0 && n - sorted[i - 1]! > 1) out.push(-1)
    out.push(n)
  }
  return out
}

/** Tags shown on a file row — display only (no toggle). */
export function assignedTagsForFile(
  allTags: FileTag[],
  tagIds: string[] | undefined | null,
): FileTag[] {
  if (!tagIds?.length) return []
  const want = new Set(tagIds)
  return allTags.filter((tg) => want.has(tg.id))
}

/** Return the next tag assignment without mutating the file's current ids. */
export function toggleFileTagId(
  tagIds: string[] | undefined | null,
  tagId: string,
): string[] {
  const next = new Set(tagIds ?? [])
  if (next.has(tagId)) next.delete(tagId)
  else next.add(tagId)
  return [...next]
}

/** Find an existing tag using the same trimmed, case-insensitive identity as the API. */
export function findTagByName(
  tags: FileTag[],
  name: string,
): FileTag | undefined {
  const normalized = name.trim().toLocaleLowerCase()
  if (!normalized) return undefined
  return tags.find((tag) => tag.name.trim().toLocaleLowerCase() === normalized)
}

/**
 * Depth-first folder list for move-to tree pickers.
 * Roots first (name-sorted), then children.
 */
export function flattenFolderTree(folders: FileFolder[]): FolderTreeNode[] {
  const byParent = new Map<string | null, FileFolder[]>()
  for (const f of folders) {
    const key = f.parent_id ?? null
    const list = byParent.get(key) ?? []
    list.push(f)
    byParent.set(key, list)
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name))
  }

  const out: FolderTreeNode[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const node of byParent.get(parentId) ?? []) {
      out.push({ id: node.id, name: node.name, depth })
      walk(node.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}
