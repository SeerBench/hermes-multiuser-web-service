import { useCallback, useEffect, useState } from 'react'
import { ApiError, auth } from '../api'
import type { User } from '../api'
import { LanguageToggle } from '../components/LanguageToggle'
import { useT } from '../i18n'

type Props = {
  onLoggedOut: () => void
}

export function SettingsPage({ onLoggedOut }: Props) {
  const t = useT()
  const [me, setMe] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const u = await auth.me()
      setMe(u)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setMe(null)
      } else {
        setError(err instanceof Error ? err.message : t('settings.error.generic'))
      }
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const logout = async () => {
    setLoggingOut(true)
    try {
      await auth.logout()
    } catch {
      // ignore — clear UI state regardless
    }
    setMe(null)
    setLoggingOut(false)
    onLoggedOut()
  }

  return (
    <div className="settings-page">
      <section className="settings-block">
        <h2>{t('settings.account.title')}</h2>
        {loading ? (
          <p>{t('common.loading')}</p>
        ) : me ? (
          <>
            <table className="settings-account">
              <tbody>
                <tr>
                  <th>{t('settings.account.user_id')}</th>
                  <td>
                    <code>{me.user_id}</code>
                  </td>
                </tr>
                <tr>
                  <th>{t('settings.account.first_seen')}</th>
                  <td>{new Date(me.created_at * 1000).toLocaleString()}</td>
                </tr>
                <tr>
                  <th>{t('settings.account.last_seen')}</th>
                  <td>{new Date(me.last_seen_at * 1000).toLocaleString()}</td>
                </tr>
              </tbody>
            </table>
            <button
              type="button"
              className="settings-danger"
              onClick={logout}
              disabled={loggingOut}
            >
              {loggingOut ? t('settings.signout.busy') : t('settings.signout')}
            </button>
          </>
        ) : (
          <p>{t('settings.not_signed_in')}</p>
        )}
      </section>

      <section className="settings-block">
        <h2>{t('settings.preferences.title')}</h2>
        <div className="settings-pref-row">
          <span className="settings-pref-label">
            {t('settings.preferences.language')}
          </span>
          <LanguageToggle />
        </div>
      </section>

      <section className="settings-block">
        <h2>{t('settings.about.title')}</h2>
        <p className="settings-help">{t('settings.about.body')}</p>
      </section>

      {error && <p className="settings-error">{error}</p>}
    </div>
  )
}
