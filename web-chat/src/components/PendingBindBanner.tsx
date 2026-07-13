import { useT } from '../i18n'

type Props = {
  onGoSettings: () => void
}

/** 平台用户尚未绑定 upstream key 时的全局引导条。 */
export function PendingBindBanner({ onGoSettings }: Props) {
  const t = useT()
  return (
    <div className="app-bind-banner" role="status">
      <p className="app-bind-banner-text">{t('bindBanner.message')}</p>
      <button type="button" className="app-bind-banner-btn" onClick={onGoSettings}>
        {t('bindBanner.action')}
      </button>
    </div>
  )
}
