import { useLocale } from '../i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Props = {
  className?: string
  /** Slightly smaller for the app header. */
  compact?: boolean
}

/**
 * Single toggle for ZH ↔ EN.
 * Label/tooltip are always in the *target* language so the control
 * remains understandable regardless of the current UI locale.
 */
export function LanguageToggle({ className, compact }: Props) {
  const { locale, setLocale } = useLocale()

  const nextIsEnglish = locale === 'zh'
  const label = nextIsEnglish ? 'English' : '中文'
  const tip = nextIsEnglish ? 'Use English' : '使用中文'

  return (
    <Button
      type="button"
      size={compact ? 'xs' : 'sm'}
      variant="outline"
      className={cn(className)}
      title={tip}
      aria-label={tip}
      onClick={() => setLocale(nextIsEnglish ? 'en' : 'zh')}
    >
      {label}
    </Button>
  )
}
