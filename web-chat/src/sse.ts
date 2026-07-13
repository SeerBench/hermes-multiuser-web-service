/** SSE frame parsing for the web_chat chat stream. */

import type { ChatEvent } from './chatEvents'

/** Parse one SSE frame (lines between blank-line delimiters). */
export function parseSseFrame(frame: string): ChatEvent | null {
  let eventType = 'message'
  let dataLine = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) eventType = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLine += line.slice(5).trim()
    else if (line.startsWith(':')) continue
  }
  if (!dataLine) return null
  let data: Record<string, unknown>
  try {
    data = JSON.parse(dataLine)
  } catch {
    return null
  }
  switch (eventType) {
    case 'token':
      return { type: 'token', text: String(data.text ?? '') }
    case 'tool_start':
      return {
        type: 'tool_start',
        id: data.id == null ? null : String(data.id),
        tool: String(data.tool ?? ''),
        preview: String(data.preview ?? ''),
        args: String(data.args ?? ''),
      }
    case 'tool_end':
      return {
        type: 'tool_end',
        id: data.id == null ? null : String(data.id),
        tool: String(data.tool ?? ''),
        duration: Number(data.duration ?? 0),
        error: Boolean(data.error),
        result_preview: String(data.result_preview ?? ''),
      }
    case 'reasoning':
      return { type: 'reasoning', text: String(data.text ?? '') }
    case 'status':
      return {
        type: 'status',
        kind: data.kind === 'warn' ? 'warn' : 'lifecycle',
        message: String(data.message ?? ''),
      }
    case 'step':
      return {
        type: 'step',
        step: Number(data.step ?? 0),
        tools: Array.isArray(data.tools) ? data.tools.map(String) : [],
      }
    case 'activity':
      return {
        type: 'activity',
        kind: String(data.kind ?? 'thinking'),
        text: String(data.text ?? ''),
      }
    case 'done':
      return {
        type: 'done',
        session_id: String(data.session_id ?? ''),
        usage: (data.usage as Record<string, number>) ?? {},
      }
    case 'error':
      return {
        type: 'error',
        message: String(data.message ?? 'unknown error'),
        code: data.code ? String(data.code) : undefined,
      }
    default:
      return null
  }
}
