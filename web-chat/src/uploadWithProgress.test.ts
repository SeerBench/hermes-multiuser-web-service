import { describe, expect, it, vi } from 'vitest'
import { uploadWithProgress } from './uploadWithProgress'

describe('uploadWithProgress', () => {
  it('reports progress and resolves JSON body', async () => {
    const percents: number[] = []
    class FakeXHR {
      upload = { onprogress: null as ((ev: ProgressEvent) => void) | null }
      status = 200
      responseText = JSON.stringify([{ id: 'f1' }])
      withCredentials = false
      open() {}
      send() {
        this.upload.onprogress?.({
          lengthComputable: true,
          loaded: 50,
          total: 100,
        } as ProgressEvent)
        this.onload?.()
      }
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
    }

    vi.stubGlobal(
      'XMLHttpRequest',
      vi.fn(() => new FakeXHR()),
    )

    const result = await uploadWithProgress('/api/v1/ws/files', [new File(['a'], 'a.txt')], {
      onProgress: (ev) => percents.push(ev.percent),
    })
    expect(percents).toContain(50)
    expect(result).toEqual([{ id: 'f1' }])
    vi.unstubAllGlobals()
  })
})
