/** Hash-based client routes for the SPA shell. */

export type Route =
  | 'chat'
  | 'settings'
  | 'files'
  | 'file-tags'
  | 'knowledge'
  | 'memory'
  | 'skills'
  | 'usage'
  | 'admin'
  | 'admin-audit'
  | 'reset-password'

/** Top-level chrome tabs (settings lives in AccountMenu). */
export type MainTab = 'chat' | 'workspace'

export type WorkspaceTab = 'files' | 'knowledge' | 'memory' | 'skills'

const ROUTES: Route[] = [
  'settings',
  'files',
  'file-tags',
  'knowledge',
  'memory',
  'skills',
  'usage',
  'admin-audit',
  'admin',
  'reset-password',
  'chat',
]

/** Display / entry order: Files → Knowledge → Skills → Memory. */
const WORKSPACE_TABS: WorkspaceTab[] = ['files', 'knowledge', 'skills', 'memory']
const LAST_WS_KEY = 'hermes_last_workspace_tab'

/** Strip query string from a hash path (`reset-password?token=…` → path). */
function hashPath(hash: string): string {
  const raw = hash.replace(/^#\/?/, '')
  return raw.split('?')[0] ?? ''
}

/** Parse ``#/chat``-style hash into a canonical route name. */
export function parseRoute(hash: string): Route {
  const path = hashPath(hash)
  // Nested admin audit uses slash form in the URL (`#/admin/audit`).
  if (path === 'admin/audit') return 'admin-audit'
  return ROUTES.find((r) => path === r) ?? 'chat'
}

/** Read ``token`` from ``#/reset-password?token=…``. */
export function parseResetToken(hash: string): string | null {
  const raw = hash.replace(/^#\/?/, '')
  const path = raw.split('?')[0] ?? ''
  if (path !== 'reset-password') return null
  const q = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : ''
  const token = new URLSearchParams(q).get('token')
  return token?.trim() || null
}

export function routeHref(route: Route): string {
  if (route === 'admin-audit') return '#/admin/audit'
  return `#/${route}`
}

/** Admin console routes (users list + audit log). */
export function isAdminRoute(route: Route): boolean {
  return route === 'admin' || route === 'admin-audit'
}

export function isWorkspaceRoute(route: Route): boolean {
  return (
    route === 'files' ||
    route === 'file-tags' ||
    route === 'knowledge' ||
    route === 'memory' ||
    route === 'skills'
  )
}

/** WorkspaceShell 顶栏高亮的子 Tab（file-tags 挂在「文件」下）。 */
export function workspaceShellTab(route: Route): WorkspaceTab | null {
  if (route === 'files' || route === 'file-tags') return 'files'
  if (route === 'knowledge' || route === 'memory' || route === 'skills') {
    return route
  }
  return null
}

/** Map any route to the visible primary tab (settings → background). */
export function mainTabFromRoute(route: Route): MainTab {
  return isWorkspaceRoute(route) ? 'workspace' : 'chat'
}

export function getLastWorkspaceTab(): WorkspaceTab {
  try {
    const raw = sessionStorage.getItem(LAST_WS_KEY)
    if (raw && WORKSPACE_TABS.includes(raw as WorkspaceTab)) {
      return raw as WorkspaceTab
    }
  } catch {
    // ignore
  }
  return 'files'
}

export function setLastWorkspaceTab(tab: WorkspaceTab): void {
  try {
    sessionStorage.setItem(LAST_WS_KEY, tab)
  } catch {
    // ignore
  }
}

/** Destination when the user clicks the Workspace primary tab. */
export function workspaceEntryRoute(): WorkspaceTab {
  return getLastWorkspaceTab()
}
