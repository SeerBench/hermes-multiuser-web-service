import { useEffect, useMemo, useState } from 'react'
import type { CommandSpec } from '../api'
import { useLocale, useT } from '../i18n'

type Props = {
  query: string
  commands: CommandSpec[]
  onSelect: (cmd: CommandSpec) => void
  onClose: () => void
}

/**
 * Popover that appears above the composer when the user begins typing
 * a slash command. Filters the catalog by the post-slash query and
 * lets the user pick one with the keyboard or mouse.
 *
 * The popover doesn't own the textarea state — it just suggests. The
 * composer decides when to show/hide based on the raw input.
 */
export function SlashCommandPopover({ query, commands, onSelect, onClose }: Props) {
  const t = useT()
  const { locale } = useLocale()
  const [activeIndex, setActiveIndex] = useState(0)

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => {
      if (c.name.toLowerCase().includes(q)) return true
      if (c.aliases.some((a) => a.toLowerCase().includes(q))) return true
      const desc = c.description_i18n?.[locale] ?? c.description
      return desc.toLowerCase().includes(q)
    })
  }, [commands, query, locale])

  // Reset active selection when matches change.
  useEffect(() => {
    setActiveIndex(0)
  }, [query, matches.length])

  // Window-level key handling — composer keeps focus, so we listen
  // here to drive arrow nav + Enter completion + Esc dismiss without
  // stealing focus from the textarea.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matches.length === 0) {
        if (e.key === 'Escape') onClose()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % matches.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + matches.length) % matches.length)
      } else if (e.key === 'Tab') {
        e.preventDefault()
        onSelect(matches[activeIndex])
      } else if (e.key === 'Enter') {
        // The composer also listens for Enter; we win because we run
        // first via window listener.
        e.preventDefault()
        onSelect(matches[activeIndex])
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [matches, activeIndex, onSelect, onClose])

  return (
    <div className="slash-popover" role="listbox" aria-label={t('command.popover.heading')}>
      <div className="slash-popover-head">{t('command.popover.heading')}</div>
      {matches.length === 0 ? (
        <div className="slash-popover-empty">{t('command.popover.empty')}</div>
      ) : (
        <ul>
          {matches.map((cmd, i) => {
            const desc =
              cmd.description_i18n?.[locale] ?? cmd.description ?? ''
            return (
              <li
                key={cmd.name}
                className={i === activeIndex ? 'slash-popover-active' : ''}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseDown={(e) => {
                  // mousedown (not click) so we fire before the
                  // textarea loses focus and the composer thinks we've
                  // closed the popover.
                  e.preventDefault()
                  onSelect(cmd)
                }}
                role="option"
                aria-selected={i === activeIndex}
              >
                <span className="slash-popover-name">
                  /{cmd.name}
                  {cmd.args_hint && (
                    <span className="slash-popover-hint"> {cmd.args_hint}</span>
                  )}
                </span>
                <span className="slash-popover-desc">{desc}</span>
                {!cmd.supported && !cmd.client_only && (
                  <span className="slash-popover-tag">
                    {t('command.popover.hint.not_yet')}
                  </span>
                )}
                {cmd.client_only && (
                  <span className="slash-popover-tag slash-popover-tag-local">
                    {t('command.popover.hint.client')}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
