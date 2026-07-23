import { describe, expect, it } from 'vitest'

import {
  filesListKindParam,
  isImageFilename,
} from './pages/FilesPage'

describe('files page helpers', () => {
  it('omits kind query for the All tab', () => {
    expect(filesListKindParam('all')).toBeUndefined()
    expect(filesListKindParam('document')).toBe('document')
    expect(filesListKindParam('image')).toBe('image')
  })

  it('detects image filenames by suffix', () => {
    expect(isImageFilename('shot.PNG')).toBe(true)
    expect(isImageFilename('notes.md')).toBe(false)
  })
})
