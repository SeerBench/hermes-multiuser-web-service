/** Hash-based client routes for the SPA shell. */

export type Route =
  | 'chat'
  | 'settings'
  | 'files'
  | 'file-tags'
  | 'memory'
  | 'skills'
  | 'admin'

/** Top-level chrome tabs (settings lives in AccountMenu). */
export type MainTab = 'chat' | 'workspace'

export type WorkspaceTab = 'files' | 'memory' | 'skills'

const ROUTES: Route[] = [
  'settings',
  'files',
  'file-tags',
  'memory',
  'skills',
  'admin',
  'chat',
]

/** Display / entry order: Files → Skills → Memory. */
const WORKSPACE_TABS: WorkspaceTab[] = ['files', 'skills', 'memory']
const LAST_WS_KEY = 'hermes_last_workspace_tab'

/** Parse ``#/chat``-style hash into a canonical route name. */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  return ROUTES.find((r) => raw === r) ?? 'chat'
}

export function routeHref(route: Route): string {
  return `#/${route}`
}

export function isWorkspaceRoute(route: Route): boolean {
  return (
    route === 'files' ||
    route === 'file-tags' ||
    route === 'memory' ||
    route === 'skills'
  )
}

/** WorkspaceShell 顶栏高亮的子 Tab（file-tags 挂在「文件」下）。 */
export function workspaceShellTab(route: Route): WorkspaceTab | null {
  if (route === 'files' || route === 'file-tags') return 'files'
  if (route === 'memory' || route === 'skills') return route
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
