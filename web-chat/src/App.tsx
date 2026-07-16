import { useCallback, useEffect, useState } from 'react'
import { LayoutGrid, MessageSquare } from 'lucide-react'
import { Toaster } from 'sonner'
import { ChatPage } from './pages/ChatPage'
import { SettingsPage } from './pages/SettingsPage'
import { AuthPage } from './pages/AuthPage'
import { FilesPage } from './pages/FilesPage'
import { FileTagsPage } from './pages/FileTagsPage'
import { MemoryPage } from './pages/MemoryPage'
import { SkillsPage } from './pages/SkillsPage'
import { AdminPage } from './pages/AdminPage'
import { AccountMenu } from './components/AccountMenu'
import { OnboardingModal } from './components/OnboardingModal'
import { PendingBindBanner } from './components/PendingBindBanner'
import { BrandLogo } from './components/BrandLogo'
import { WorkspaceShell } from './components/WorkspaceShell'
import { LocaleProvider, useT } from './i18n'
import { auth } from './api'
import {
  clearWorkspaceId,
  platform,
  tryPlatformSession,
  type PlatformUser,
} from './platformClient'
import {
  isWorkspaceRoute,
  mainTabFromRoute,
  parseRoute,
  routeHref,
  workspaceEntryRoute,
  workspaceShellTab,
  type MainTab,
  type Route,
} from './routing'
import { subscribeViewport } from './lib/breakpoints'
import {
  isOnboardingComplete,
  markOnboardingComplete,
  resetOnboarding,
} from './onboardingStorage'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

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
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [backgroundRoute, setBackgroundRoute] = useState<Route>(() => {
    const initial = parseRoute(window.location.hash)
    return initial === 'settings' ? 'chat' : initial
  })
  const [mobileNav, setMobileNav] = useState(false)

  useEffect(() => subscribeViewport(setMobileNav), [])

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
  const activeTab = mainTabFromRoute(
    route === 'settings' ? backgroundRoute : route,
  )

  const onMainTab = (tab: MainTab) => {
    if (tab === 'chat') {
      goto('chat')
      return
    }
    if (!isWorkspaceRoute(pageRoute)) {
      goto(workspaceEntryRoute())
    }
  }

  const workspaceBody =
    pageRoute === 'files' ? (
      <FilesPage key={`files-${pageKey}`} />
    ) : pageRoute === 'file-tags' ? (
      <FileTagsPage key={`file-tags-${pageKey}`} />
    ) : pageRoute === 'memory' ? (
      <MemoryPage key={`memory-${pageKey}`} />
    ) : pageRoute === 'skills' ? (
      <SkillsPage key={`skills-${pageKey}`} />
    ) : null

  const shellTab = workspaceShellTab(pageRoute)

  // 登录门禁 / 加载中不渲染工作台顶栏（仅已登录用户可见）
  const showChrome = Boolean(user) && !showAuthGate && !authLoading

  return (
    <div className={cn('app', route === 'settings' && 'app--settings-open')}>
      {showChrome && user && (
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
            <Tabs
              value={activeTab}
              onValueChange={(v) => onMainTab(v as MainTab)}
              className="gap-0"
            >
              <TabsList className="bg-muted/80">
                <TabsTrigger value="chat" className="gap-1.5">
                  <MessageSquare className="size-4" aria-hidden />
                  {t('nav.chat')}
                </TabsTrigger>
                {platformMode && (
                  <TabsTrigger value="workspace" className="gap-1.5">
                    <LayoutGrid className="size-4" aria-hidden />
                    {t('nav.workspace')}
                  </TabsTrigger>
                )}
              </TabsList>
            </Tabs>
          </div>

          <div className="app-nav-actions">
            {user.role === 'admin' && (
              <Button
                type="button"
                variant={route === 'admin' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => goto('admin')}
              >
                {t('nav.admin')}
              </Button>
            )}
            <AccountMenu
              email={user.email}
              avatarUrl={user.avatar_url}
              onOpenSettings={() => goto('settings')}
              onLogout={() => void handleLoggedOut()}
            />
          </div>
        </header>
      )}
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
            <div
              className={cn(
                'app-page',
                route === 'settings' && 'app-page--dimmed',
              )}
              aria-hidden={route === 'settings' || undefined}
            >
              {pageRoute === 'chat' && (
                <ChatPage
                  key={`chat-${pageKey}`}
                  platformMode={platformMode}
                  signedIn={Boolean(user)}
                  needsBindKey={needsBindKey}
                  onGoBindSettings={() => goto('settings')}
                  userAvatarUrl={user?.avatar_url ?? null}
                />
              )}
              {isWorkspaceRoute(pageRoute) && workspaceBody && shellTab && (
                <WorkspaceShell active={shellTab}>
                  {workspaceBody}
                </WorkspaceShell>
              )}
              {pageRoute === 'admin' && <AdminPage key={`admin-${pageKey}`} />}
            </div>
            <SettingsPage
              key={`settings-${pageKey}`}
              open={route === 'settings'}
              onOpenChange={(open) => {
                if (!open)
                  goto(backgroundRoute === 'settings' ? 'chat' : backgroundRoute)
              }}
              platformMode={platformMode}
              user={user}
              onLoggedOut={handleLoggedOut}
              onUserUpdated={setUser}
            />
          </>
        )}
      </main>
      {user && mobileNav && (
        <nav className="app-mobile-nav" aria-label={t('nav.mobile')}>
          <button
            type="button"
            className={activeTab === 'chat' ? 'app-mobile-nav--active' : undefined}
            onClick={() => onMainTab('chat')}
          >
            <MessageSquare className="size-4" aria-hidden />
            {t('nav.chat')}
          </button>
          {platformMode && (
            <button
              type="button"
              className={
                activeTab === 'workspace' ? 'app-mobile-nav--active' : undefined
              }
              onClick={() => onMainTab('workspace')}
            >
              <LayoutGrid className="size-4" aria-hidden />
              {t('nav.workspace')}
            </button>
          )}
          <button
            type="button"
            onClick={() => goto('settings')}
          >
            {t('nav.account')}
          </button>
        </nav>
      )}
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
      <Toaster richColors position="top-center" closeButton />
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
