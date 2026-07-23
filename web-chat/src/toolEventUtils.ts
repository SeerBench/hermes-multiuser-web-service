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

/** 与 gateway `format_search_status_message` 对齐的活动区文案（中文产品面）。 */
export function formatSearchStatusMessage(
  meta: Record<string, unknown> | null | undefined,
): string | null {
  if (!meta || typeof meta !== 'object') return null
  const backend = meta.backend
  if (backend === 'brave-free') {
    const remaining = meta.brave_remaining
    if (typeof remaining === 'number') {
      return `使用 Brave 搜索，Brave 用量还剩 ${remaining} 次`
    }
    return '使用 Brave 搜索'
  }
  if (backend === 'ddgs') {
    const reason = meta.fallback_reason
    if (reason === 'brave_quota_exhausted') {
      return '使用 DuckDuckGo 搜索（Brave 额度已用完）'
    }
    return '使用 DuckDuckGo 搜索'
  }
  if (backend == null) return null
  return '联网搜索完成'
}

/** 站点 favicon（Google s2；失败时由 UI 回退占位）。 */
export function faviconUrlForSite(pageUrl: string): string {
  try {
    const host = new URL(pageUrl).hostname
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`
  } catch {
    return ''
  }
}

/** 合并一轮对话中所有 web_search 命中（按 URL 去重，保序）。 */
export function collectTurnSearchHits(
  segments: Array<{
    kind: string
    tool?: string
    result_preview?: string
    search_meta?: Record<string, unknown> | null
  }>,
): WebSearchHit[] {
  const seen = new Set<string>()
  const out: WebSearchHit[] = []
  for (const seg of segments) {
    if (seg.kind !== 'tool' || seg.tool !== 'web_search') continue
    const summary = extractWebSearchSummary(
      'web_search',
      seg.result_preview,
      seg.search_meta,
    )
    if (!summary) continue
    for (const hit of summary.urls) {
      if (seen.has(hit.url)) continue
      seen.add(hit.url)
      out.push(hit)
    }
  }
  return out
}

export type WebSearchTurnConsumption = {
  /** 本轮成功的 web_search 次数 */
  total: number
  brave: number
  ddgs: number
  /** 最后一次 Brave 搜索后的剩余额度（若有） */
  braveRemaining: number | null
}

/** 统计本轮助手回复中 web_search 消耗（成功调用次数）。 */
export function summarizeTurnWebSearchConsumption(
  segments: ReadonlyArray<{
    kind: string
    tool?: string
    error?: boolean
    result_preview?: string
    search_meta?: Record<string, unknown> | null
    // 允许传入完整 Segment（含 text/preview 等额外字段）
    [key: string]: unknown
  }>,
): WebSearchTurnConsumption | null {
  let total = 0
  let brave = 0
  let ddgs = 0
  let braveRemaining: number | null = null

  for (const seg of segments) {
    if (seg.kind !== 'tool' || seg.tool !== 'web_search' || seg.error) continue
    const summary = extractWebSearchSummary(
      'web_search',
      seg.result_preview,
      seg.search_meta,
    )
    if (!summary) continue
    total += 1
    if (summary.backend === 'brave-free') {
      brave += 1
      if (typeof summary.braveRemaining === 'number') {
        braveRemaining = summary.braveRemaining
      }
    } else if (summary.backend === 'ddgs') {
      ddgs += 1
    }
  }

  if (total === 0) return null
  return { total, brave, ddgs, braveRemaining }
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
  const hits: WebSearchHit[] = []
  if (Array.isArray(web)) {
    for (const item of web) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      const url = String(row.url ?? '').trim()
      if (!url) continue
      hits.push({
        title: String(row.title ?? url),
        url,
        description: row.description ? String(row.description) : undefined,
      })
    }
  }

  const metaUrls = Array.isArray(meta?.urls)
    ? (meta.urls as unknown[]).map(String).filter(Boolean)
    : []

  const urls =
    hits.length > 0
      ? hits
      : metaUrls.map((url) => ({ title: url, url }))

  // 无 _meta 且无 URL 时不造空摘要（避免历史脏数据噪音）。
  if (!meta && urls.length === 0) return null

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
