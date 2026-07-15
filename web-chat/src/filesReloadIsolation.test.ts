import { describe, expect, it } from 'vitest'

/** Mirror FilesPage reload isolation: a folders 404 must not wipe a successful file list. */
async function loadFilesPageData(deps: {
  listFiles: () => Promise<unknown[]>
  listFolders: () => Promise<unknown[]>
  listTags: () => Promise<unknown[]>
}) {
  let files: unknown[] = []
  let folders: unknown[] = []
  let tags: unknown[] = []
  let fileError: string | null = null
  let secondaryError: string | null = null

  try {
    files = await deps.listFiles()
  } catch (err) {
    files = []
    fileError = err instanceof Error ? err.message : String(err)
  }
  try {
    folders = await deps.listFolders()
  } catch (err) {
    folders = []
    const status = (err as { status?: number }).status
    if (status !== 404) {
      secondaryError = err instanceof Error ? err.message : String(err)
    }
  }
  try {
    tags = await deps.listTags()
  } catch {
    tags = []
  }
  return { files, folders, tags, error: fileError ?? secondaryError }
}

describe('files page reload isolation', () => {
  it('keeps files when folder route is Not Found', async () => {
    const result = await loadFilesPageData({
      listFiles: async () => [{ id: '1', filename: 'a.txt' }],
      listFolders: async () => {
        const err = new Error('Not Found') as Error & { status: number }
        err.status = 404
        throw err
      },
      listTags: async () => [],
    })
    expect(result.files).toHaveLength(1)
    expect(result.folders).toEqual([])
    expect(result.error).toBeNull()
  })
})
