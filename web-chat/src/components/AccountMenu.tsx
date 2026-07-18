import { useState } from 'react'
import { CircleUserRound } from 'lucide-react'
import { useT } from '../i18n'
import { LanguageToggle } from './LanguageToggle'
import {
  getStoredFontScale,
  setFontScale,
  type FontScale,
} from '../fontScaleStorage'
import {
  getStoredTheme,
  setTheme,
  type ThemePreference,
} from '../themeStorage'
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
  /** Platform mode: open Usage Center */
  onOpenUsage?: () => void
  onLogout: () => void
}

/** Header account menu: language, settings, logout. */
export function AccountMenu({
  email,
  avatarUrl,
  onOpenSettings,
  onOpenUsage,
  onLogout,
}: Props) {
  const t = useT()
  const hasAvatar = Boolean(avatarUrl?.trim())
  const [theme, setThemePreference] = useState<ThemePreference>(getStoredTheme)
  const [fontScale, setFontScalePreference] =
    useState<FontScale>(getStoredFontScale)

  const selectTheme = (next: ThemePreference) => {
    setThemePreference(next)
    setTheme(next)
  }

  const selectFontScale = (next: FontScale) => {
    setFontScalePreference(next)
    setFontScale(next)
  }

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
      <DropdownMenuContent align="end" className="min-w-56">
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
        <div className="px-2 py-1.5">
          <p className="mb-1 text-xs text-muted-foreground">
            {t('settings.preferences.theme')}
          </p>
          <div className="grid grid-cols-3 gap-1">
            {(['system', 'light', 'dark'] as const).map((option) => (
              <Button
                key={option}
                type="button"
                size="sm"
                variant={theme === option ? 'secondary' : 'outline'}
                className="px-2"
                aria-pressed={theme === option}
                onClick={() => selectTheme(option)}
              >
                {t(`settings.theme.${option}`)}
              </Button>
            ))}
          </div>
        </div>
        <div className="px-2 py-1.5">
          <p className="mb-1 text-xs text-muted-foreground">
            {t('settings.preferences.font')}
          </p>
          <div className="grid grid-cols-3 gap-1">
            {(['sm', 'md', 'lg'] as const).map((option) => (
              <Button
                key={option}
                type="button"
                size="sm"
                variant={fontScale === option ? 'secondary' : 'outline'}
                className="px-2"
                aria-pressed={fontScale === option}
                onClick={() => selectFontScale(option)}
              >
                {t(`settings.font.${option}`)}
              </Button>
            ))}
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            onOpenSettings()
          }}
        >
          {t('nav.settings')}
        </DropdownMenuItem>
        {onOpenUsage ? (
          <DropdownMenuItem
            onSelect={() => {
              onOpenUsage()
            }}
          >
            {t('nav.usage')}
          </DropdownMenuItem>
        ) : null}
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
