import { describe, expect, it } from 'vitest'
import type { FileFolder, FileTag } from './platformClient'
import {
  assignedTagsForFile,
  flattenFolderTree,
  toggleFileTagId,
} from './filesListHelpers'

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
