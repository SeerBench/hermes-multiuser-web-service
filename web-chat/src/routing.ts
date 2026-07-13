/** Hash-based client routes for the SPA shell. */

export type Route =
  | 'chat'
  | 'settings'
  | 'files'
  | 'memory'
  | 'skills'
  | 'admin'

const ROUTES: Route[] = [
  'settings',
  'files',
  'memory',
  'skills',
  'admin',
  'chat',
]

/** Parse ``#/chat``-style hash into a canonical route name. */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  return ROUTES.find((r) => raw === r) ?? 'chat'
}

export function routeHref(route: Route): string {
  return `#/${route}`
}
