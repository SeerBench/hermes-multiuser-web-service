/** Display helpers for the composer model picker (name, badges, brand). */

export type ModelBadgeKind = 'pro' | 'new'

export type ModelBadge = {
  kind: ModelBadgeKind
  /** Short label shown in the chip (locale-agnostic for Pro; New uses i18n). */
  labelKey: 'pro' | 'new'
}

export type ModelBrand = {
  key: string
  /** CSS color for the avatar disk */
  color: string
  /** 1–2 letter mark inside the avatar */
  mark: string
}

/** Turn `deepseek-v4-pro` / `claude-sonnet-4.6` into a readable label. */
export function modelDisplayName(id: string): string {
  const raw = id.trim()
  if (!raw) return ''
  // Keep known vendor casing; otherwise title-case hyphen/underscore segments.
  return raw
    .replace(/[_/]+/g, '-')
    .split('-')
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase()
      if (lower === 'gpt') return 'GPT'
      if (lower === 'o1' || lower === 'o3' || lower === 'o4') return lower
      if (lower === 'deepseek') return 'DeepSeek'
      if (lower === 'claude') return 'Claude'
      if (lower === 'gemini') return 'Gemini'
      if (lower === 'mistral') return 'Mistral'
      if (lower === 'qwen') return 'Qwen'
      if (lower === 'llama') return 'Llama'
      if (lower === 'grok') return 'Grok'
      if (lower === 'pro') return 'Pro'
      if (lower === 'flash') return 'Flash'
      if (lower === 'opus') return 'Opus'
      if (lower === 'sonnet') return 'Sonnet'
      if (lower === 'haiku') return 'Haiku'
      if (lower === 'mini') return 'Mini'
      if (lower === 'turbo') return 'Turbo'
      if (/^\d+(\.\d+)*$/.test(part)) return part
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(' ')
}

/** Infer Pro / New chips from the model id (no catalog metadata required). */
export function modelBadges(id: string): ModelBadge[] {
  const lower = id.toLowerCase()
  const badges: ModelBadge[] = []
  // Match trailing / segment "pro", or "-pro" / "_pro" / " pro".
  if (/(^|[-_./\s])pro($|[-_./\s])/i.test(lower) || /pro$/i.test(lower)) {
    badges.push({ kind: 'pro', labelKey: 'pro' })
  }
  // Heuristic "new": recent major lines (gpt-5, claude-*-4.5+, gemini-2.5+, deepseek-v4…).
  if (
    /\bgpt[-_]?5\b/i.test(lower) ||
    /claude.*4\.(5|6|7|8)/i.test(lower) ||
    /claude.*(opus|sonnet|haiku)[-_]?5/i.test(lower) ||
    /gemini[-_]?2\.5/i.test(lower) ||
    /deepseek[-_]?v4/i.test(lower) ||
    /\b(o3|o4)([-_.]|$)/i.test(lower)
  ) {
    badges.push({ kind: 'new', labelKey: 'new' })
  }
  return badges
}

export function modelBrand(id: string): ModelBrand {
  const lower = id.toLowerCase()
  if (lower.includes('deepseek')) {
    return { key: 'deepseek', color: '#4d6bfe', mark: 'DS' }
  }
  if (lower.includes('claude') || lower.includes('anthropic')) {
    return { key: 'claude', color: '#d97757', mark: 'C' }
  }
  if (lower.includes('gpt') || lower.includes('openai') || /^o[1-4]\b/.test(lower)) {
    return { key: 'openai', color: '#10a37f', mark: 'O' }
  }
  if (lower.includes('gemini') || lower.includes('google')) {
    return { key: 'gemini', color: '#4285f4', mark: 'G' }
  }
  if (lower.includes('qwen') || lower.includes('tongyi')) {
    return { key: 'qwen', color: '#6a5acd', mark: 'Q' }
  }
  if (lower.includes('mistral')) {
    return { key: 'mistral', color: '#ff7000', mark: 'M' }
  }
  if (lower.includes('llama') || lower.includes('meta')) {
    return { key: 'llama', color: '#0668e1', mark: 'L' }
  }
  if (lower.includes('grok') || lower.includes('xai')) {
    return { key: 'grok', color: '#9ca3af', mark: 'X' }
  }
  const mark = id.trim().charAt(0).toUpperCase() || '?'
  return { key: 'default', color: '#6b7280', mark }
}
