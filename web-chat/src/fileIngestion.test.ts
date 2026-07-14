import { describe, expect, it } from 'vitest'

import type { PlatformFile } from './platformClient'
import {
  filesNeedPolling,
  isTerminalFileStatus,
  mergeFileUpdates,
} from './fileIngestion'

const base = (status: string): PlatformFile => ({
  id: 'f1',
  filename: 'a.pdf',
  status,
  created_at: 0,
})

describe('fileIngestion', () => {
  it('detects non-terminal statuses', () => {
    expect(isTerminalFileStatus('ready')).toBe(true)
    expect(isTerminalFileStatus('failed')).toBe(true)
    expect(isTerminalFileStatus('pending')).toBe(false)
    expect(isTerminalFileStatus('processing')).toBe(false)
  })

  it('filesNeedPolling when any file is in-flight', () => {
    expect(filesNeedPolling([base('ready')])).toBe(false)
    expect(filesNeedPolling([base('pending'), base('ready')])).toBe(true)
  })

  it('mergeFileUpdates patches matching rows', () => {
    const merged = mergeFileUpdates([base('pending')], [
      { ...base('ready'), status: 'ready' },
    ])
    expect(merged[0].status).toBe('ready')
  })
})
