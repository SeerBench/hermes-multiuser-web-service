import { useCallback, useEffect, useState } from 'react'
import { ApiError, auth } from '../api'
import type { User } from '../api'
import { LanguageToggle } from '../components/LanguageToggle'
import { useT } from '../i18n'
import {
  PlatformApiError,
  platform,
  type PlatformUser,
} from '../platformClient'
import {
  getStoredTheme,
  setTheme,
  type ThemePreference,
} from '../themeStorage'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  platformMode?: boolean
  user?: PlatformUser | null
  onLoggedOut: () => void
  onUserUpdated?: (user: PlatformUser) => void
}

export function SettingsPage({
  open,
  onOpenChange,
  platformMode = false,
  user: platformUser,
  onLoggedOut,
  onUserUpdated,
}: Props) {
  const t = useT()
  const [me, setMe] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const [bindKey, setBindKey] = useState('')
  const [bindBusy, setBindBusy] = useState(false)
  const [bindMsg, setBindMsg] = useState<string | null>(null)
  const [theme, setThemeState] = useState<ThemePreference>(() => getStoredTheme())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (platformMode) {
        const u = await platform.me()
        setMe({
          user_id: u.user_id,
          created_at: u.created_at ?? 0,
          last_seen_at: u.last_seen_at ?? 0,
          email: u.email,
          upstream_status: u.upstream_status,
        })
      } else {
        const u = await auth.me()
        setMe(u)
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setMe(null)
      } else if (err instanceof PlatformApiError && err.status === 401) {
        setMe(null)
      } else {
        setError(err instanceof Error ? err.message : t('settings.error.generic'))
      }
    } finally {
      setLoading(false)
    }
  }, [platformMode, t])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const logout = async () => {
    setLoggingOut(true)
    try {
      if (platformMode) await platform.logout()
      else await auth.logout()
    } catch {
      // ignore
    }
    setMe(null)
    setLoggingOut(false)
    onOpenChange(false)
    onLoggedOut()
  }

  const submitBindKey = async () => {
    const trimmed = bindKey.trim()
    if (!trimmed) return
    setBindBusy(true)
    setBindMsg(null)
    try {
      const res = await platform.bindKey(trimmed)
      setBindKey('')
      setBindMsg(t('settings.bindKey.ok'))
      onUserUpdated?.(res.user)
      await load()
    } catch (err) {
      setBindMsg(
        err instanceof PlatformApiError ? err.message : t('settings.bindKey.fail'),
      )
    } finally {
      setBindBusy(false)
    }
  }

  const onThemeChange = (value: string) => {
    const next = value as ThemePreference
    setThemeState(next)
    setTheme(next)
  }

  const needsBind =
    platformMode &&
    (me?.upstream_status === 'pending_bind' ||
      platformUser?.upstream_status === 'pending_bind')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(90vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
        showCloseButton
      >
        <DialogHeader className="border-b border-border px-6 py-4 text-left">
          <DialogTitle>{t('settings.dialog.title')}</DialogTitle>
          <DialogDescription>{t('settings.dialog.subtitle')}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[min(70vh,560px)] flex-1 px-6 py-4">
          <div className="space-y-6 pb-2">
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">{t('settings.account.title')}</h3>
              {loading ? (
                <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
              ) : me ? (
                <>
                  <dl className="grid gap-2 text-sm">
                    {me.email && (
                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">{t('settings.account.email')}</dt>
                        <dd className="text-right font-medium">{me.email}</dd>
                      </div>
                    )}
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">{t('settings.account.user_id')}</dt>
                      <dd className="font-mono text-xs">{me.user_id}</dd>
                    </div>
                    {me.upstream_status && (
                      <div className="flex items-center justify-between gap-4">
                        <dt className="text-muted-foreground">
                          {t('settings.account.upstream')}
                        </dt>
                        <dd>
                          <Badge variant={needsBind ? 'destructive' : 'secondary'}>
                            {me.upstream_status}
                          </Badge>
                        </dd>
                      </div>
                    )}
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">
                        {t('settings.account.first_seen')}
                      </dt>
                      <dd className="text-right text-xs">
                        {new Date(me.created_at * 1000).toLocaleString()}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">
                        {t('settings.account.last_seen')}
                      </dt>
                      <dd className="text-right text-xs">
                        {new Date(me.last_seen_at * 1000).toLocaleString()}
                      </dd>
                    </div>
                  </dl>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => void logout()}
                    disabled={loggingOut}
                  >
                    {loggingOut ? t('settings.signout.busy') : t('settings.signout')}
                  </Button>
                </>
              ) : (
                <p className="text-muted-foreground text-sm">{t('settings.not_signed_in')}</p>
              )}
            </section>

            {needsBind && (
              <>
                <Separator />
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">{t('settings.bindKey.title')}</h3>
                  <p className="text-muted-foreground text-sm">{t('settings.bindKey.hint')}</p>
                  <div className="space-y-2">
                    <Label htmlFor="settings-bind-key">{t('settings.bindKey.title')}</Label>
                    <Input
                      id="settings-bind-key"
                      type="password"
                      value={bindKey}
                      onChange={(e) => setBindKey(e.target.value)}
                      placeholder={t('settings.bindKey.placeholder')}
                      disabled={bindBusy}
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={bindBusy || !bindKey.trim()}
                    onClick={() => void submitBindKey()}
                  >
                    {bindBusy ? t('settings.bindKey.busy') : t('settings.bindKey.submit')}
                  </Button>
                  {bindMsg && (
                    <Alert>
                      <AlertDescription>{bindMsg}</AlertDescription>
                    </Alert>
                  )}
                </section>
              </>
            )}

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-semibold">{t('settings.preferences.title')}</h3>
              <div className="flex items-center justify-between gap-4">
                <Label>{t('settings.preferences.language')}</Label>
                <LanguageToggle />
              </div>
              <div className="space-y-2">
                <Label>{t('settings.preferences.theme')}</Label>
                <p className="text-muted-foreground text-xs">
                  {t('settings.preferences.theme.hint')}
                </p>
                <RadioGroup
                  value={theme}
                  onValueChange={onThemeChange}
                  className="grid gap-2"
                >
                  {(
                    [
                      ['system', 'settings.theme.system'],
                      ['light', 'settings.theme.light'],
                      ['dark', 'settings.theme.dark'],
                    ] as const
                  ).map(([value, labelKey]) => (
                    <label
                      key={value}
                      className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2"
                    >
                      <RadioGroupItem value={value} id={`theme-${value}`} />
                      <span className="text-sm">{t(labelKey)}</span>
                    </label>
                  ))}
                </RadioGroup>
              </div>
            </section>

            {!platformMode && (
              <>
                <Separator />
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">{t('settings.about.title')}</h3>
                  <p className="text-muted-foreground text-sm leading-relaxed">
                    {t('settings.about.body')}
                  </p>
                </section>
              </>
            )}

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
