/** 工具事件展示辅助函数（从 ToolEvent 抽离，便于单测）。 */

/** 尽力格式化 JSON 参数；解析失败则原样返回。 */
export function prettyJson(input: string): string {
  try {
    const parsed = JSON.parse(input)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return input
  }
}

/** 从 image_generate 工具结果中提取可渲染的图片 URL。 */
export function extractImageUrl(tool: string, result?: string): string | null {
  if (tool !== 'image_generate' || !result) return null
  let url: unknown = null
  try {
    const parsed = JSON.parse(result)
    if (parsed && typeof parsed === 'object' && (parsed as { success?: boolean }).success) {
      url = (parsed as { image?: unknown }).image
    }
  } catch {
    const m = result.match(/"image"\s*:\s*"(https?:\/\/[^"\\]+)"/)
    if (m) url = m[1]
  }
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null
}
