import { useCallback, useEffect, useState } from 'react'
import { Power } from 'lucide-react'
import { ChatPage } from './pages/ChatPage'
import { SettingsPage } from './pages/SettingsPage'
import { AuthPage } from './pages/AuthPage'
import { FilesPage } from './pages/FilesPage'
import { MemoryPage } from './pages/MemoryPage'
import { SkillsPage } from './pages/SkillsPage'
import { AdminPage } from './pages/AdminPage'
import { OnboardingModal } from './components/OnboardingModal'
import { PendingBindBanner } from './components/PendingBindBanner'
import { BrandLogo } from './components/BrandLogo'
import { LocaleProvider, useT } from './i18n'
import { LanguageToggle } from './components/LanguageToggle'
import { auth } from './api'
import {
  clearWorkspaceId,
  platform,
  tryPlatformSession,
  type PlatformUser,
} from './platformClient'
import { parseRoute, routeHref, type Route } from './routing'
import {
  isOnboardingComplete,
  markOnboardingComplete,
  resetOnboarding,
} from './onboardingStorage'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

function goto(route: Route) {
  window.location.hash = routeHref(route)
}

/** Main nav tabs when signed in (center of header). */
type MainTab = 'chat' | 'files' | 'memory' | 'skills' | 'settings'

function tabFromRoute(route: Route): MainTab {
  if (
    route === 'files' ||
    route === 'memory' ||
    route === 'skills' ||
    route === 'settings'
  ) {
    return route
  }
  return 'chat'
}

function AppShell() {
  const t = useT()
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash))
  const [pageKey, setPageKey] = useState(0)
  const [platformMode, setPlatformMode] = useState(false)
  const [user, setUser] = useState<PlatformUser | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [backgroundRoute, setBackgroundRoute] = useState<Route>(() => {
    const initial = parseRoute(window.location.hash)
    return initial === 'settings' ? 'chat' : initial
  })

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
    const onHashChange = () => {
      const next = parseRoute(window.location.hash)
      setRoute(next)
      if (next !== 'settings') setBackgroundRoute(next)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    document.title = t('app.title')
  }, [t])

  // 未完成 onboarding 的 Platform 用户登录后弹出向导。
  useEffect(() => {
    if (platformMode && user && !isOnboardingComplete(user.user_id)) {
      setOnboardingOpen(true)
    } else {
      setOnboardingOpen(false)
    }
  }, [platformMode, user])

  const enterApp = useCallback((nextUser: PlatformUser) => {
    setUser(nextUser)
    setPageKey((n) => n + 1)
    goto('chat')
  }, [])

  const handleLoggedOut = async () => {
    try {
      if (platformMode) await platform.logout()
      else await auth.logout()
    } catch {
      // ignore
    }
    clearWorkspaceId()
    setUser(null)
    setPageKey((n) => n + 1)
    goto('chat')
    void refreshAuth()
  }

  const showAuthGate = platformMode && !authLoading && !user
  const needsBindKey =
    platformMode &&
    Boolean(user) &&
    user?.upstream_status === 'pending_bind'
  const pageRoute = route === 'settings' ? backgroundRoute : route
  const activeTab = tabFromRoute(route)

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-brand">
          <button
            type="button"
            className="app-brand-link"
            title={t('nav.home')}
            aria-label={t('nav.home')}
            onClick={() => goto('chat')}
          >
            <BrandLogo size={28} />
            <h1 className="app-title">{t('app.title')}</h1>
          </button>
        </div>

        <div className="app-nav-center">
          {user && (
            <Tabs
              value={activeTab}
              onValueChange={(v) => goto(v as MainTab)}
              className="gap-0"
            >
              <TabsList className="bg-muted/80">
                <TabsTrigger value="chat">{t('nav.chat')}</TabsTrigger>
                {platformMode && (
                  <>
                    <TabsTrigger value="files">{t('nav.files')}</TabsTrigger>
                    <TabsTrigger value="memory">{t('nav.memory')}</TabsTrigger>
                    <TabsTrigger value="skills">{t('nav.skills')}</TabsTrigger>
                  </>
                )}
                <TabsTrigger value="settings">{t('nav.settings')}</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
        </div>

        <div className="app-nav-actions">
          {user?.role === 'admin' && (
            <Button
              type="button"
              variant={route === 'admin' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => goto('admin')}
            >
              {t('nav.admin')}
            </Button>
          )}
          <LanguageToggle compact />
          {user && (
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              title={t('nav.logout.tip')}
              aria-label={t('nav.logout')}
              onClick={() => void handleLoggedOut()}
            >
              <Power className="size-4" />
            </Button>
          )}
        </div>
      </header>
      {needsBindKey && (
        <PendingBindBanner onGoSettings={() => goto('settings')} />
      )}
      <main className="app-main">
        {authLoading ? (
          <p className="page-hint">{t('common.loading')}</p>
        ) : showAuthGate ? (
          <AuthPage
            onSuccess={(u, opts) => {
              if (opts?.registered) resetOnboarding(u.user_id)
              enterApp(u)
            }}
            onLegacySuccess={async (userId) => {
              // Cookie already set by /api/auth/login — re-enter platform
              // mode so Files/Memory/Skills can resolve a workspace.
              const session = await tryPlatformSession()
              if (session?.user) {
                setPlatformMode(true)
                enterApp(session.user)
              } else {
                setPlatformMode(false)
                enterApp({ user_id: userId })
              }
            }}
          />
        ) : (
          <>
            {pageRoute === 'chat' && (
              <ChatPage
                key={`chat-${pageKey}`}
                platformMode={platformMode}
                signedIn={Boolean(user)}
                needsBindKey={needsBindKey}
                onGoBindSettings={() => goto('settings')}
              />
            )}
            {pageRoute === 'files' && <FilesPage key={`files-${pageKey}`} />}
            {pageRoute === 'memory' && <MemoryPage key={`memory-${pageKey}`} />}
            {pageRoute === 'skills' && <SkillsPage key={`skills-${pageKey}`} />}
            {pageRoute === 'admin' && <AdminPage key={`admin-${pageKey}`} />}
            <SettingsPage
              key={`settings-${pageKey}`}
              open={route === 'settings'}
              onOpenChange={(open) => {
                if (!open) goto(backgroundRoute === 'settings' ? 'chat' : backgroundRoute)
              }}
              platformMode={platformMode}
              user={user}
              onLoggedOut={handleLoggedOut}
              onUserUpdated={setUser}
            />
          </>
        )}
      </main>
      {onboardingOpen && user && (
        <OnboardingModal
          user={user}
          onUserUpdated={setUser}
          onNavigate={goto}
          onComplete={() => {
            markOnboardingComplete(user.user_id)
            setOnboardingOpen(false)
            goto('chat')
          }}
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
