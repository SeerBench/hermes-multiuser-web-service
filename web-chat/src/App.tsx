import { useCallback, useEffect, useState } from 'react'
import { ChatPage } from './pages/ChatPage'
import { SettingsPage } from './pages/SettingsPage'
import { AuthPage } from './pages/AuthPage'
import { FilesPage } from './pages/FilesPage'
import { MemoryPage } from './pages/MemoryPage'
import { SkillsPage } from './pages/SkillsPage'
import { AdminPage } from './pages/AdminPage'
import { KeyPromptModal } from './components/KeyPromptModal'
import { PendingBindBanner } from './components/PendingBindBanner'
import { LocaleProvider, useT } from './i18n'
import { LanguageToggle } from './components/LanguageToggle'
import { auth } from './api'
import {
  platform,
  tryPlatformSession,
  type PlatformUser,
} from './platformClient'
import { parseRoute, routeHref, type Route } from './routing'

function goto(route: Route) {
  window.location.hash = routeHref(route)
}

function AppShell() {
  const t = useT()
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash))
  const [pageKey, setPageKey] = useState(0)
  const [platformMode, setPlatformMode] = useState(false)
  const [user, setUser] = useState<PlatformUser | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [legacyKeyOpen, setLegacyKeyOpen] = useState(false)

  const refreshAuth = useCallback(async () => {
    setAuthLoading(true)
    try {
      const session = await tryPlatformSession()
      if (session) {
        setPlatformMode(true)
        setUser(session.user)
        return
      }
      try {
        await platform.healthz()
        setPlatformMode(true)
        setUser(null)
        return
      } catch {
        // platform-api not running — legacy key mode
      }
      setPlatformMode(false)
      try {
        const legacy = await auth.me()
        setUser({
          user_id: legacy.user_id,
          created_at: legacy.created_at,
          last_seen_at: legacy.last_seen_at,
          email: legacy.email,
          upstream_status: legacy.upstream_status,
        })
      } catch {
        setUser(null)
      }
    } finally {
      setAuthLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshAuth()
  }, [refreshAuth])

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    document.title = t('app.title')
  }, [t])

  const handleLoggedOut = async () => {
    try {
      if (platformMode) await platform.logout()
      else await auth.logout()
    } catch {
      // ignore
    }
    setUser(null)
    setPageKey((n) => n + 1)
    goto('chat')
    void refreshAuth()
  }

  const showAuthGate = platformMode && !authLoading && !user && !legacyKeyOpen
  const needsBindKey =
    platformMode &&
    Boolean(user) &&
    user?.upstream_status === 'pending_bind'

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">{t('app.title')}</h1>
        <nav className="app-nav">
          <button
            type="button"
            className={route === 'chat' ? 'nav-active' : ''}
            onClick={() => goto('chat')}
          >
            {t('nav.chat')}
          </button>
          {platformMode && user && (
            <>
              <button
                type="button"
                className={route === 'files' ? 'nav-active' : ''}
                onClick={() => goto('files')}
              >
                {t('nav.files')}
              </button>
              <button
                type="button"
                className={route === 'memory' ? 'nav-active' : ''}
                onClick={() => goto('memory')}
              >
                {t('nav.memory')}
              </button>
              <button
                type="button"
                className={route === 'skills' ? 'nav-active' : ''}
                onClick={() => goto('skills')}
              >
                {t('nav.skills')}
              </button>
              {user.role === 'admin' && (
                <button
                  type="button"
                  className={route === 'admin' ? 'nav-active' : ''}
                  onClick={() => goto('admin')}
                >
                  {t('nav.admin')}
                </button>
              )}
            </>
          )}
          <button
            type="button"
            className={route === 'settings' ? 'nav-active' : ''}
            onClick={() => goto('settings')}
          >
            {t('nav.settings')}
          </button>
          <LanguageToggle compact />
        </nav>
      </header>
      {needsBindKey && (
        <PendingBindBanner onGoSettings={() => goto('settings')} />
      )}
      <main className="app-main">
        {authLoading ? (
          <p className="page-hint">{t('common.loading')}</p>
        ) : showAuthGate ? (
          <AuthPage
            onSuccess={(u) => {
              setUser(u)
              setPageKey((n) => n + 1)
            }}
            onLegacyKey={() => setLegacyKeyOpen(true)}
          />
        ) : (
          <>
            {route === 'chat' && (
              <ChatPage
                key={`chat-${pageKey}`}
                platformMode={platformMode}
                signedIn={Boolean(user)}
                needsBindKey={needsBindKey}
                onGoBindSettings={() => goto('settings')}
              />
            )}
            {route === 'settings' && (
              <SettingsPage
                key={`settings-${pageKey}`}
                platformMode={platformMode}
                user={user}
                onLoggedOut={handleLoggedOut}
                onUserUpdated={setUser}
              />
            )}
            {route === 'files' && <FilesPage key={`files-${pageKey}`} />}
            {route === 'memory' && <MemoryPage key={`memory-${pageKey}`} />}
            {route === 'skills' && <SkillsPage key={`skills-${pageKey}`} />}
            {route === 'admin' && <AdminPage key={`admin-${pageKey}`} />}
          </>
        )}
      </main>
      {legacyKeyOpen && (
        <KeyPromptModal
          reason="first-message"
          onSuccess={(userId) => {
            setLegacyKeyOpen(false)
            setPlatformMode(false)
            setUser({ user_id: userId })
            setPageKey((n) => n + 1)
          }}
          onCancel={() => setLegacyKeyOpen(false)}
        />
      )}
    </div>
  )
}

export function App() {
  return (
    <LocaleProvider>
      <AppShell />
    </LocaleProvider>
  )
}
