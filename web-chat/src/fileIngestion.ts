import type { PlatformFile } from './platformClient'

/** 文件 ingestion 已结束的状态。 */
export const TERMINAL_FILE_STATUSES = new Set(['ready', 'failed'])

export const FILE_INGEST_POLL_MS = 2000

export function isTerminalFileStatus(status: string): boolean {
  return TERMINAL_FILE_STATUSES.has(status)
}

export function filesNeedPolling(files: PlatformFile[]): boolean {
  return files.some((f) => !isTerminalFileStatus(f.status))
}

/** 将轮询结果合并进列表。 */
export function mergeFileUpdates(
  current: PlatformFile[],
  updates: (PlatformFile | null)[],
): PlatformFile[] {
  const byId = new Map(
    updates.filter((u): u is PlatformFile => u != null).map((u) => [u.id, u]),
  )
  if (!byId.size) return current
  return current.map((f) => (byId.has(f.id) ? { ...f, ...byId.get(f.id)! } : f))
}
