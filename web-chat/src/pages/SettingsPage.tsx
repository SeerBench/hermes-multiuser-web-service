import { useCallback, useEffect, useState } from 'react'
import { ApiError, auth } from '../api'
import type { User } from '../api'
import { LanguageToggle } from '../components/LanguageToggle'
import { useT } from '../i18n'
import {
  PlatformApiError,
  platform,
  type PlatformUser,
} from '../platformClient'

type Props = {
  platformMode?: boolean
  user?: PlatformUser | null
  onLoggedOut: () => void
  onUserUpdated?: (user: PlatformUser) => void
}

export function SettingsPage({
  platformMode = false,
  user: platformUser,
  onLoggedOut,
  onUserUpdated,
}: Props) {
  const t = useT()
  const [me, setMe] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const [bindKey, setBindKey] = useState('')
  const [bindBusy, setBindBusy] = useState(false)
  const [bindMsg, setBindMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (platformMode) {
        const u = await platform.me()
        setMe({
          user_id: u.user_id,
          created_at: u.created_at ?? 0,
          last_seen_at: u.last_seen_at ?? 0,
          email: u.email,
          upstream_status: u.upstream_status,
        })
      } else {
        const u = await auth.me()
        setMe(u)
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setMe(null)
      } else if (err instanceof PlatformApiError && err.status === 401) {
        setMe(null)
      } else {
        setError(err instanceof Error ? err.message : t('settings.error.generic'))
      }
    } finally {
      setLoading(false)
    }
  }, [platformMode, t])

  useEffect(() => {
    void load()
  }, [load])

  const logout = async () => {
    setLoggingOut(true)
    try {
      if (platformMode) await platform.logout()
      else await auth.logout()
    } catch {
      // ignore
    }
    setMe(null)
    setLoggingOut(false)
    onLoggedOut()
  }

  const submitBindKey = async () => {
    const trimmed = bindKey.trim()
    if (!trimmed) return
    setBindBusy(true)
    setBindMsg(null)
    try {
      const res = await platform.bindKey(trimmed)
      setBindKey('')
      setBindMsg(t('settings.bindKey.ok'))
      onUserUpdated?.(res.user)
      await load()
    } catch (err) {
      setBindMsg(
        err instanceof PlatformApiError ? err.message : t('settings.bindKey.fail'),
      )
    } finally {
      setBindBusy(false)
    }
  }

  const needsBind =
    platformMode &&
    (me?.upstream_status === 'pending_bind' ||
      platformUser?.upstream_status === 'pending_bind')

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
                {me.email && (
                  <tr>
                    <th>{t('settings.account.email')}</th>
                    <td>{me.email}</td>
                  </tr>
                )}
                <tr>
                  <th>{t('settings.account.user_id')}</th>
                  <td>
                    <code>{me.user_id}</code>
                  </td>
                </tr>
                {me.upstream_status && (
                  <tr>
                    <th>{t('settings.account.upstream')}</th>
                    <td>{me.upstream_status}</td>
                  </tr>
                )}
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

      {needsBind && (
        <section className="settings-block">
          <h2>{t('settings.bindKey.title')}</h2>
          <p>{t('settings.bindKey.hint')}</p>
          <input
            type="password"
            value={bindKey}
            onChange={(e) => setBindKey(e.target.value)}
            placeholder={t('settings.bindKey.placeholder')}
          />
          <button type="button" disabled={bindBusy} onClick={submitBindKey}>
            {bindBusy ? t('settings.bindKey.busy') : t('settings.bindKey.submit')}
          </button>
          {bindMsg && <p className="page-hint">{bindMsg}</p>}
        </section>
      )}

      <section className="settings-block">
        <h2>{t('settings.preferences.title')}</h2>
        <div className="settings-pref-row">
          <span className="settings-pref-label">
            {t('settings.preferences.language')}
          </span>
          <LanguageToggle />
        </div>
      </section>

      {!platformMode && (
        <section className="settings-block">
          <h2>{t('settings.about.title')}</h2>
          <p>{t('settings.about.body')}</p>
        </section>
      )}

      {error && <p className="auth-error">{error}</p>}
    </div>
  )
}
