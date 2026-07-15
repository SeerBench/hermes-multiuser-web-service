import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useT } from '../i18n'
import {
  routeHref,
  setLastWorkspaceTab,
  type WorkspaceTab,
} from '../routing'

/** Sub-nav for Files / Memory / Skills under the Workspace primary tab. */
export function WorkspaceShell({
  active,
  children,
}: {
  active: WorkspaceTab
  children: ReactNode
}) {
  const t = useT()

  useEffect(() => {
    setLastWorkspaceTab(active)
  }, [active])

  return (
    <div className="workspace-shell">
      <Tabs
        value={active}
        onValueChange={(v) => {
          window.location.hash = routeHref(v as WorkspaceTab)
        }}
        className="workspace-shell-tabs gap-3"
      >
        <TabsList className="bg-muted/80">
          <TabsTrigger value="files">{t('nav.files')}</TabsTrigger>
          <TabsTrigger value="memory">{t('nav.memory')}</TabsTrigger>
          <TabsTrigger value="skills">{t('nav.skills')}</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="workspace-shell-body">{children}</div>
    </div>
  )
}
