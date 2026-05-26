import { useCallback, useEffect, useState } from 'react'
import { ApiError, auth } from '../api'
import type { User } from '../api'

type Props = {
  onLoggedOut: () => void
}

export function SettingsPage({ onLoggedOut }: Props) {
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
        setError(err instanceof Error ? err.message : 'failed to load settings')
      }
    } finally {
      setLoading(false)
    }
  }, [])

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
        <h2>Account</h2>
        {loading ? (
          <p>Loading…</p>
        ) : me ? (
          <>
            <table className="settings-account">
              <tbody>
                <tr>
                  <th>User ID</th>
                  <td>
                    <code>{me.user_id}</code>
                  </td>
                </tr>
                <tr>
                  <th>First seen</th>
                  <td>{new Date(me.created_at * 1000).toLocaleString()}</td>
                </tr>
                <tr>
                  <th>Last seen</th>
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
              {loggingOut ? '…' : 'Sign out'}
            </button>
          </>
        ) : (
          <p>
            Not signed in. Return to <a href="#/chat">chat</a> and send a message
            to sign in with your API key.
          </p>
        )}
      </section>

      <section className="settings-block">
        <h2>About this service</h2>
        <p className="settings-help">
          Authentication and billing are handled by the upstream
          new-api gateway. Your API key was issued by your administrator;
          to request more capacity or a new key, contact them directly.
          This interface only stores the cookie session — your key is
          encrypted at rest and never displayed back.
        </p>
      </section>

      {error && <p className="settings-error">{error}</p>}
    </div>
  )
}
