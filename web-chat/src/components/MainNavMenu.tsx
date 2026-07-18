import { Check, LayoutGrid, Menu, MessageSquare } from 'lucide-react'
import { useT } from '../i18n'
import type { MainTab } from '../routing'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

type Props = {
  activeTab: MainTab
  platformMode: boolean
  onMainTab: (tab: MainTab) => void
}

/**
 * Desktop: pill Tabs on the header right.
 * Mobile: hamburger menu to the left of the avatar (CSS toggles visibility).
 */
export function MainNavMenu({ activeTab, platformMode, onMainTab }: Props) {
  const t = useT()

  return (
    <>
      <div className="app-nav-tabs">
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

      <div className="app-nav-menu">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-8 shrink-0"
              title={t('nav.mainMenu')}
              aria-label={t('nav.mainMenu')}
            >
              <Menu className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem
              className="gap-2"
              onSelect={() => onMainTab('chat')}
            >
              <MessageSquare className="size-4" aria-hidden />
              <span className="flex-1">{t('nav.chat')}</span>
              {activeTab === 'chat' ? (
                <Check className="size-4 opacity-70" aria-hidden />
              ) : null}
            </DropdownMenuItem>
            {platformMode && (
              <DropdownMenuItem
                className="gap-2"
                onSelect={() => onMainTab('workspace')}
              >
                <LayoutGrid className="size-4" aria-hidden />
                <span className="flex-1">{t('nav.workspace')}</span>
                {activeTab === 'workspace' ? (
                  <Check className="size-4 opacity-70" aria-hidden />
                ) : null}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  )
}
