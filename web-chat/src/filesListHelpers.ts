import type { FileFolder, FileTag } from './platformClient'

export type FolderTreeNode = {
  id: string
  name: string
  depth: number
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
