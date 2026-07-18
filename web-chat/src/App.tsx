import { useCallback, useEffect, useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { ChatPage } from './pages/ChatPage'
import { SettingsPage } from './pages/SettingsPage'
import { AuthPage } from './pages/AuthPage'
import { FilesPage } from './pages/FilesPage'
import { FileTagsPage } from './pages/FileTagsPage'
import { KnowledgePage } from './pages/KnowledgePage'
import { MemoryPage } from './pages/MemoryPage'
import { SkillsPage } from './pages/SkillsPage'
import { UsagePage } from './pages/UsagePage'
import { AdminPage } from './pages/AdminPage'
import { AdminAuditPage } from './pages/AdminAuditPage'
import { AccountMenu } from './components/AccountMenu'
import { MainNavMenu } from './components/MainNavMenu'
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
  isAdminRoute,
  isWorkspaceRoute,
  mainTabFromRoute,
  parseResetToken,
  parseRoute,
  routeHref,
  workspaceEntryRoute,
  workspaceShellTab,
  type MainTab,
  type Route,
} from './routing'
import {
  isOnboardingComplete,
  markOnboardingComplete,
  resetOnboarding,
} from './onboardingStorage'
import { Button } from '@/components/ui/button'
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
    ) : pageRoute === 'knowledge' ? (
      <KnowledgePage key={`knowledge-${pageKey}`} />
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
      <a className="skip-nav" href="#main-content">
        {t('a11y.skipNav')}
      </a>
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

          {/* 主导航靠右：桌面 pill；移动端菜单紧贴头像左侧 */}
          <div className="app-nav-actions">
            {user.role === 'admin' && (
              <Button
                type="button"
                variant={isAdminRoute(route) ? 'secondary' : 'ghost'}
                size="sm"
                className="app-nav-admin"
                onClick={() => goto('admin')}
              >
                {t('nav.admin')}
              </Button>
            )}
            <MainNavMenu
              activeTab={activeTab}
              platformMode={platformMode}
              onMainTab={onMainTab}
            />
            <AccountMenu
              email={user.email}
              avatarUrl={user.avatar_url}
              onOpenSettings={() => goto('settings')}
              onOpenUsage={
                platformMode ? () => goto('usage') : undefined
              }
              onLogout={() => void handleLoggedOut()}
            />
          </div>
        </header>
      )}
      {needsBindKey && (
        <PendingBindBanner onGoSettings={() => goto('settings')} />
      )}
      <main id="main-content" className="app-main" tabIndex={-1}>
        {authLoading ? (
          <p className="page-hint">{t('common.loading')}</p>
        ) : showAuthGate ? (
          <AuthPage
            initialMode={
              route === 'reset-password' ? 'reset' : 'login'
            }
            resetToken={
              route === 'reset-password'
                ? parseResetToken(window.location.hash)
                : null
            }
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
              {pageRoute === 'usage' && platformMode && (
                <UsagePage key={`usage-${pageKey}`} />
              )}
              {pageRoute === 'admin' && <AdminPage key={`admin-${pageKey}`} />}
              {pageRoute === 'admin-audit' && (
                <AdminAuditPage key={`admin-audit-${pageKey}`} />
              )}
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
              onOpenUsageCenter={() => goto('usage')}
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
      <Toaster />
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
