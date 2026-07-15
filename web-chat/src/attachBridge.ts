/** Bridge files from the Files page into Chat composer pending attachments. */

export type BridgedFile = {
  name: string
  path: string
  size: number
}

const KEY = 'hermes_pending_chat_files'

export function queueFilesForChat(files: BridgedFile[]): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(files))
  } catch {
    // ignore quota / private mode
  }
}

/** Read and clear any queued files (once). */
export function consumeFilesForChat(): BridgedFile[] {
  try {
    const raw = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (f): f is BridgedFile =>
        Boolean(f) &&
        typeof f === 'object' &&
        typeof (f as BridgedFile).name === 'string' &&
        typeof (f as BridgedFile).path === 'string' &&
        typeof (f as BridgedFile).size === 'number',
    )
  } catch {
    return []
  }
}

/** Queue one file and navigate to chat. */
export function sendFileToChat(file: BridgedFile): void {
  queueFilesForChat([file])
  window.location.hash = '#/chat'
}
