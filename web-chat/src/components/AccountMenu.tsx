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
import { cn } from '@/lib/utils'

type Props = {
  email?: string | null
  /** 用户自定义头像 URL；为空则显示默认图标 */
  avatarUrl?: string | null
  onOpenSettings: () => void
  onLogout: () => void
}

/** Header account menu: language, settings, logout. */
export function AccountMenu({
  email,
  avatarUrl,
  onOpenSettings,
  onLogout,
}: Props) {
  const t = useT()
  const hasAvatar = Boolean(avatarUrl?.trim())

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          title={t('nav.account')}
          aria-label={t('nav.account')}
          className={cn(
            'account-menu-trigger size-8 shrink-0 overflow-hidden rounded-full p-0',
            hasAvatar && 'border-border',
          )}
        >
          {hasAvatar ? (
            <img
              src={avatarUrl!}
              alt=""
              className="size-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            <CircleUserRound className="size-4" aria-hidden />
          )}
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
