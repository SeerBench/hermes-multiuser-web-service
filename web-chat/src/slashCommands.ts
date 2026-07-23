import type { CommandSpec } from './api'
import type { Locale } from './i18n'

/** 按名称、别名或描述过滤斜杠命令目录。 */
export function filterSlashCommands(
  query: string,
  commands: CommandSpec[],
  locale: Locale,
): CommandSpec[] {
  const q = query.trim().toLowerCase()
  if (!q) return commands
  return commands.filter((c) => {
    if (c.name.toLowerCase().includes(q)) return true
    if (c.aliases.some((a) => a.toLowerCase().includes(q))) return true
    const desc = c.description_i18n?.[locale] ?? c.description
    return desc.toLowerCase().includes(q)
  })
}
