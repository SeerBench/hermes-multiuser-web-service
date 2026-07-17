import { describe, expect, it } from 'vitest'
import type { FileFolder, FileTag } from './platformClient'
import {
  assignedTagsForFile,
  canCiteFileToChat,
  fileOriginLabelKey,
  findTagByName,
  flattenFolderTree,
  folderContentCount,
  toggleFileTagId,
} from './filesListHelpers'

describe('fileOriginLabelKey', () => {
  it('maps chat origin to the chat label key', () => {
    expect(fileOriginLabelKey('chat')).toBe('files.origin.chat')
  })

  it('maps platform / missing origin to workspace', () => {
    expect(fileOriginLabelKey('platform')).toBe('files.origin.workspace')
    expect(fileOriginLabelKey(undefined)).toBe('files.origin.workspace')
    expect(fileOriginLabelKey(null)).toBe('files.origin.workspace')
  })
})

describe('canCiteFileToChat', () => {
  it('allows only ready (searchable) files', () => {
    expect(canCiteFileToChat({ status: 'ready' })).toBe(true)
    expect(canCiteFileToChat({ status: 'skipped' })).toBe(false)
    expect(canCiteFileToChat({ status: 'pending' })).toBe(false)
    expect(canCiteFileToChat({ status: 'failed' })).toBe(false)
  })
})

describe('folderContentCount', () => {
  it('sums API file_count with immediate subfolders', () => {
    const folder = { id: 'parent', file_count: 2 }
    const all = [
      { id: 'parent', parent_id: null },
      { id: 'c1', parent_id: 'parent' },
      { id: 'c2', parent_id: 'parent' },
      { id: 'other', parent_id: null },
    ]
    expect(folderContentCount(folder, all)).toBe(4)
  })

  it('falls back to subfolders alone when file_count is missing', () => {
    expect(
      folderContentCount({ id: 'p' }, [{ id: 'c', parent_id: 'p' }]),
    ).toBe(1)
  })
})

describe('assignedTagsForFile', () => {
  const tags: FileTag[] = [
    { id: 't1', name: 'urgent', created_at: 1 },
    { id: 't2', name: 'draft', created_at: 2 },
  ]

  it('returns only tags assigned to the file', () => {
    expect(assignedTagsForFile(tags, ['t2'])).toEqual([
      { id: 't2', name: 'draft', created_at: 2 },
    ])
  })

  it('returns empty when none assigned', () => {
    expect(assignedTagsForFile(tags, [])).toEqual([])
    expect(assignedTagsForFile(tags, undefined)).toEqual([])
  })
})

describe('flattenFolderTree', () => {
  it('orders folders depth-first with depth for indentation', () => {
    const folders: FileFolder[] = [
      { id: 'b', name: 'Beta', parent_id: null, created_at: 1 },
      { id: 'a', name: 'Alpha', parent_id: null, created_at: 1 },
      { id: 'a1', name: 'Nested', parent_id: 'a', created_at: 1 },
    ]
    expect(flattenFolderTree(folders)).toEqual([
      { id: 'a', name: 'Alpha', depth: 0 },
      { id: 'a1', name: 'Nested', depth: 1 },
      { id: 'b', name: 'Beta', depth: 0 },
    ])
  })
})

describe('toggleFileTagId', () => {
  it('adds a missing tag without mutating the original list', () => {
    const current = ['t1']
    expect(toggleFileTagId(current, 't2')).toEqual(['t1', 't2'])
    expect(current).toEqual(['t1'])
  })

  it('removes an assigned tag', () => {
    expect(toggleFileTagId(['t1', 't2'], 't1')).toEqual(['t2'])
  })
})

describe('findTagByName', () => {
  const tags: FileTag[] = [
    { id: 't1', name: 'Urgent', created_at: 1 },
  ]

  it('matches trimmed names case-insensitively', () => {
    expect(findTagByName(tags, '  urgent ')).toEqual(tags[0])
  })

  it('returns undefined for a new tag name', () => {
    expect(findTagByName(tags, 'review')).toBeUndefined()
  })
})
