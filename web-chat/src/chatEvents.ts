/** SSE chat stream event types (shared by api + sse parsers). */

export type ChatMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export type ChatEvent =
  | { type: 'token'; text: string }
  | {
      type: 'tool_start'
      id: string | null
      tool: string
      preview: string
      args: string
    }
  | {
      type: 'tool_end'
      id: string | null
      tool: string
      duration: number
      error: boolean
      result_preview: string
      search_meta?: Record<string, unknown> | null
    }
  | { type: 'reasoning'; text: string }
  | { type: 'status'; kind: 'lifecycle' | 'warn'; message: string }
  | { type: 'step'; step: number; tools: string[] }
  | { type: 'activity'; kind: string; text: string }
  | { type: 'title'; session_id: string; title: string }
  | { type: 'done'; session_id: string; usage: Record<string, number> }
  | { type: 'error'; message: string; code?: string }
