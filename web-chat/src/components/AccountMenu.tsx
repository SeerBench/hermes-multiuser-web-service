import { CircleUserRound } from 'lucide-react'
import { useT } from '../i18n'
import { LanguageToggle } from './LanguageToggle'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

type Props = {
  email?: string | null
  onOpenSettings: () => void
  onLogout: () => void
}

/** Header account menu: language, settings, logout. */
export function AccountMenu({ email, onOpenSettings, onLogout }: Props) {
  const t = useT()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          title={t('nav.account')}
          aria-label={t('nav.account')}
        >
          <CircleUserRound className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[12rem]">
        {email && (
          <>
            <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
              {email}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        <div className="px-2 py-1.5">
          <p className="mb-1 text-xs text-muted-foreground">{t('lang.toggle.label')}</p>
          <LanguageToggle variant="current" className="w-full" />
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            onOpenSettings()
          }}
        >
          {t('nav.settings')}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            onLogout()
          }}
        >
          {t('nav.logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
