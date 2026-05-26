import { useEffect, useState } from 'react'
import { ChatPage } from './pages/ChatPage'
import { SettingsPage } from './pages/SettingsPage'

type Route = 'chat' | 'settings'

function parseRoute(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '')
  return raw === 'settings' ? 'settings' : 'chat'
}

function goto(route: Route) {
  window.location.hash = `#/${route}`
}

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute())
  // Bump this on logout so child pages remount with fresh state.
  const [pageKey, setPageKey] = useState(0)

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

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
