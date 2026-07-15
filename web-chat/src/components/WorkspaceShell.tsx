import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { useT } from '../i18n'
import { widthClass } from '../layoutWidthStorage'
import {
  routeHref,
  setLastWorkspaceTab,
  type WorkspaceTab,
} from '../routing'

/** Sub-nav: Files → Skills → Memory, centered 960 / 98% column. */
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
    <div className={cn('workspace-shell', widthClass('reading'))}>
      <Tabs
        value={active}
        onValueChange={(v) => {
          window.location.hash = routeHref(v as WorkspaceTab)
        }}
        className="workspace-shell-tabs gap-3"
      >
        <TabsList className="bg-muted/80">
          <TabsTrigger value="files">{t('nav.files')}</TabsTrigger>
          <TabsTrigger value="skills">{t('nav.skills')}</TabsTrigger>
          <TabsTrigger value="memory">{t('nav.memory')}</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="workspace-shell-body">{children}</div>
    </div>
  )
}
