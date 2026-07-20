import { useT } from '../i18n'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

type Props = {
  onGoSettings: () => void
}

/** 平台用户尚未绑定 upstream key 时的全局引导条。 */
export function PendingBindBanner({ onGoSettings }: Props) {
  const t = useT()
  return (
    <Alert className="mx-3 mt-2 rounded-lg border-primary/30 bg-primary/10">
      <AlertTitle className="sr-only">{t('bindBanner.action')}</AlertTitle>
      <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-foreground text-sm">{t('bindBanner.message')}</span>
        <Button type="button" size="sm" onClick={onGoSettings}>
          {t('bindBanner.action')}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
