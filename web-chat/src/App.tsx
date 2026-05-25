import { useCallback, useEffect, useState } from 'react'
import { ApiError, auth, usage as usageApi } from './api'
import type { Quota, User } from './api'
import { AuthPage } from './pages/AuthPage'
import { ChatPage } from './pages/ChatPage'
import { SettingsPage } from './pages/SettingsPage'
import { QuotaBadge } from './components/QuotaBadge'

type Route = 'chat' | 'settings'

function parseRoute(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '')
  return raw === 'settings' ? 'settings' : 'chat'
}

function goto(route: Route) {
  window.location.hash = `#/${route}`
}

export function App() {
  const [user, setUser] = useState<User | null>(null)
  const [quota, setQuota] = useState<Quota | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [route, setRoute] = useState<Route>(parseRoute())

  // Probe authentication by hitting /api/usage; 401 → show login.
  useEffect(() => {
    let cancelled = false
    usageApi
      .get()
      .then((q) => {
        if (!cancelled) {
          setQuota(q)
          // We have a session — derive a placeholder user object.
          // The server's /api/usage doesn't include email today, so
          // we keep email blank until login/register hands it back.
          setUser((u) => u ?? { user_id: '', email: '' })
        }
      })
      .catch(() => {
        // 401 or other — leave user null.
      })
      .finally(() => {
        if (!cancelled) setAuthChecked(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const refreshQuota = useCallback(async () => {
    try {
      const q = await usageApi.get()
      setQuota(q)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setUser(null)
    }
  }, [])

  const handleAuthed = useCallback(
    (u: User, initialQuota?: Quota) => {
      setUser(u)
      if (initialQuota) setQuota(initialQuota)
      void refreshQuota()
    },
    [refreshQuota],
  )

  const handleLogout = useCallback(async () => {
    try {
      await auth.logout()
    } catch {
      // ignore — we want to clear UI state regardless
    }
    setUser(null)
    setQuota(null)
    goto('chat')
  }, [])

  if (!authChecked) {
    return (
      <div className="app-splash">
        <p>Loading…</p>
      </div>
    )
  }

  if (!user) {
    return <AuthPage onAuthed={handleAuthed} />
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">Hermes Web Chat</h1>
        <nav className="app-nav">
          <button
            type="button"
            className={route === 'chat' ? 'nav-active' : ''}
            onClick={() => goto('chat')}
          >
            Chat
          </button>
          <button
            type="button"
            className={route === 'settings' ? 'nav-active' : ''}
            onClick={() => goto('settings')}
          >
            Settings
          </button>
          {quota && <QuotaBadge quota={quota} />}
          <button type="button" onClick={handleLogout} className="nav-logout">
            Logout
          </button>
        </nav>
      </header>
      <main className="app-main">
        {route === 'chat' && <ChatPage onQuotaUpdate={setQuota} />}
        {route === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}
