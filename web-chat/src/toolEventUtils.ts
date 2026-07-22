/** 工具事件展示辅助函数（从 ToolEvent 抽离，便于单测）。 */

export type WebSearchHit = {
  title: string
  url: string
  description?: string
}

export type WebSearchSummary = {
  backend: string
  backendLabel: string
  resultCount: number
  urls: WebSearchHit[]
  braveRemaining?: number | null
  fallbackReason?: string | null
}

/** 尽力格式化 JSON 参数；解析失败则原样返回。 */
export function prettyJson(input: string): string {
  try {
    const parsed = JSON.parse(input)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return input
  }
}

function backendLabel(backend: string): string {
  if (backend === 'brave-free') return 'Brave'
  if (backend === 'ddgs') return 'DuckDuckGo'
  return backend
}

function parseResultObject(result?: string): Record<string, unknown> | null {
  if (!result) return null
  try {
    const parsed = JSON.parse(result)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 从 web_search 工具结果或 SSE search_meta 提取结构化摘要。 */
export function extractWebSearchSummary(
  tool: string,
  result?: string,
  searchMeta?: Record<string, unknown> | null,
): WebSearchSummary | null {
  if (tool !== 'web_search') return null

  const meta =
    searchMeta && typeof searchMeta === 'object'
      ? searchMeta
      : (parseResultObject(result)?._meta as Record<string, unknown> | undefined)

  const parsed = parseResultObject(result)
  const web = (parsed?.data as { web?: unknown } | undefined)?.web
  const hits: WebSearchHit[] = Array.isArray(web)
    ? web
        .map((item) => {
          if (!item || typeof item !== 'object') return null
          const row = item as Record<string, unknown>
          const url = String(row.url ?? '').trim()
          if (!url) return null
          return {
            title: String(row.title ?? url),
            url,
            description: row.description ? String(row.description) : undefined,
          }
        })
        .filter((x): x is WebSearchHit => x != null)
    : []

  const metaUrls = Array.isArray(meta?.urls)
    ? (meta.urls as unknown[]).map(String).filter(Boolean)
    : []

  const urls =
    hits.length > 0
      ? hits
      : metaUrls.map((url) => ({ title: url, url }))

  const backend = String(meta?.backend ?? 'unknown')
  const resultCount =
    typeof meta?.url_count === 'number'
      ? meta.url_count
      : urls.length

  return {
    backend,
    backendLabel: backendLabel(backend),
    resultCount,
    urls,
    braveRemaining:
      typeof meta?.brave_remaining === 'number' ? meta.brave_remaining : null,
    fallbackReason:
      typeof meta?.fallback_reason === 'string' ? meta.fallback_reason : null,
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
