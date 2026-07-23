/** Build a provisional session title from the first user message. */

export function provisionalTitleFromMessage(message: string, maxLen = 48): string {
  const oneLine = message.replace(/\s+/g, ' ').trim()
  if (!oneLine) return ''
  if (oneLine.length <= maxLen) return oneLine
  return oneLine.slice(0, maxLen - 1).trimEnd() + '…'
}
