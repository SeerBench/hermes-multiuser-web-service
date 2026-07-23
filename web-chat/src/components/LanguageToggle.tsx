import { useLocale, useT } from '../i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Props = {
  className?: string
  /** Slightly smaller for the app header. */
  compact?: boolean
  /**
   * `current` — label is the active locale (中文 / English).
   * `target` — label is the locale you switch *to* (legacy Settings helper).
   */
  variant?: 'current' | 'target'
}

/**
 * Single toggle for ZH ↔ EN.
 * Default (`current`) shows the active language so the control matches the UI.
 */
export function LanguageToggle({
  className,
  compact,
  variant = 'current',
}: Props) {
  const { locale, setLocale } = useLocale()
  const t = useT()

  const label =
    variant === 'target'
      ? locale === 'zh'
        ? 'English'
        : '中文'
      : locale === 'zh'
        ? '中文'
        : 'English'

  const tip =
    variant === 'target'
      ? locale === 'zh'
        ? 'Use English'
        : '使用中文'
      : t('lang.toggle.tip')

  return (
    <Button
      type="button"
      size={compact ? 'xs' : 'sm'}
      variant="outline"
      className={cn(className)}
      title={tip}
      aria-label={tip}
      onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
    >
      {label}
    </Button>
  )
}
