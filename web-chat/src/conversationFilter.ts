import type { ConversationSummary } from './api'

/** 按标题或预览文本筛选会话列表（客户端搜索）。 */
export function filterConversations(
  list: ConversationSummary[],
  query: string,
): ConversationSummary[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  return list.filter((c) => {
    const title = (c.title ?? '').toLowerCase()
    const preview = (c.preview ?? '').toLowerCase()
    return title.includes(q) || preview.includes(q)
  })
}
