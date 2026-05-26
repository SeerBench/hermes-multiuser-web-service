import { useLocale, useT } from '../i18n'
import type { Locale } from '../i18n'

type Props = {
  className?: string
  compact?: boolean
}

const OPTIONS: { value: Locale; key: string }[] = [
  { value: 'en', key: 'lang.option.en' },
  { value: 'zh', key: 'lang.option.zh' },
]

/**
 * Two-state segmented control for switching the UI language.
 * Used both in the app header (compact) and in Settings (labelled).
 */
export function LanguageToggle({ className, compact }: Props) {
  const { locale, setLocale } = useLocale()
  const t = useT()

  return (
    <div
      className={`lang-toggle${compact ? ' lang-toggle-compact' : ''}${
        className ? ` ${className}` : ''
      }`}
      role="group"
      aria-label={t('lang.toggle.label')}
    >
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={locale === opt.value ? 'lang-toggle-active' : ''}
          aria-pressed={locale === opt.value}
          onClick={() => setLocale(opt.value)}
        >
          {t(opt.key)}
        </button>
      ))}
    </div>
  )
}
