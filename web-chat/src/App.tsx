import { useEffect, useState } from 'react'
import { ChatPage } from './pages/ChatPage'
import { SettingsPage } from './pages/SettingsPage'
import { LocaleProvider, useT } from './i18n'
import { LanguageToggle } from './components/LanguageToggle'

type Route = 'chat' | 'settings'

function parseRoute(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '')
  return raw === 'settings' ? 'settings' : 'chat'
}

function goto(route: Route) {
  window.location.hash = `#/${route}`
}

function AppShell() {
  const t = useT()
  const [route, setRoute] = useState<Route>(parseRoute())
  // Bump this on logout so child pages remount with fresh state.
  const [pageKey, setPageKey] = useState(0)

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    document.title = t('app.title')
  }, [t])

  // Sign-out from SettingsPage navigates back to chat and bumps pageKey
  // so any in-memory state (transcript, conversation list cache) is
  // discarded and the next chat attempt re-triggers the key prompt.
  const handleLoggedOut = () => {
    setPageKey((n) => n + 1)
    goto('chat')
  }

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
      <main className="app-main">
        {route === 'chat' && <ChatPage key={`chat-${pageKey}`} />}
        {route === 'settings' && (
          <SettingsPage key={`settings-${pageKey}`} onLoggedOut={handleLoggedOut} />
        )}
      </main>
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
