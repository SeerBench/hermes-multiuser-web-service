import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { ApiError, auth } from '../api'
import type { User } from '../api'
import { LanguageToggle } from '../components/LanguageToggle'
import { useT } from '../i18n'
import {
  PlatformApiError,
  getStoredWorkspaceId,
  platform,
  type PlatformUser,
} from '../platformClient'
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
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { notifyPreferencesUpdated } from '../modelFavorites'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  platformMode?: boolean
  user?: PlatformUser | null
  onLoggedOut: () => void
  onUserUpdated?: (user: PlatformUser) => void
}

type SettingsTab = 'general' | 'account' | 'models' | 'usage'

/** Settings: General / Account / Models / Usage. Wide on PC, fullscreen on mobile. */
export function SettingsPage({
  open,
  onOpenChange,
  platformMode = false,
  user: platformUser,
  onLoggedOut,
  onUserUpdated,
}: Props) {
  const t = useT()
  const workspaceId = getStoredWorkspaceId()
  const [tab, setTab] = useState<SettingsTab>('general')
  const [me, setMe] = useState<User & { nickname?: string | null; avatar_url?: string | null } | null>(
    null,
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const [bindKey, setBindKey] = useState('')
  const [bindBusy, setBindBusy] = useState(false)
  const [bindMsg, setBindMsg] = useState<string | null>(null)
  const [theme, setThemeState] = useState<ThemePreference>(() => getStoredTheme())
  const [fontScale, setFontScaleState] = useState<FontScale>(() =>
    getStoredFontScale(),
  )


  // Account edit form
  const [nickname, setNickname] = useState('')
  const [email, setEmail] = useState('')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const avatarFileRef = useRef<HTMLInputElement | null>(null)
  const [profileBusy, setProfileBusy] = useState(false)
  const [profileMsg, setProfileMsg] = useState<string | null>(null)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [passwordMsg, setPasswordMsg] = useState<string | null>(null)

  // Models
  const [allModels, setAllModels] = useState<{ id: string; owned_by?: string }[]>([])
  const [favorites, setFavorites] = useState<string[]>([])
  const [preferred, setPreferred] = useState('')
  const [modelsBusy, setModelsBusy] = useState(false)
  const [modelsMsg, setModelsMsg] = useState<string | null>(null)
  const [modelFilter, setModelFilter] = useState('')

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
          nickname: u.nickname,
          avatar_url: u.avatar_url,
        })
        setNickname(u.nickname ?? '')
        setEmail(u.email ?? '')
        setAvatarUrl(u.avatar_url ?? null)
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

  const loadModels = useCallback(async () => {
    if (!platformMode || !workspaceId) return
    setModelsBusy(true)
    try {
      const res = await platform.listModels(workspaceId)
      setAllModels(res.models ?? [])
      setFavorites(res.favorite_models ?? [])
      setPreferred(
        res.preferred_model?.trim() ||
          res.default_model?.trim() ||
          res.models[0]?.id ||
          '',
      )
    } catch {
      setAllModels([])
    } finally {
      setModelsBusy(false)
    }
  }, [platformMode, workspaceId])


  useEffect(() => {
    if (!open) return
    setTab('general')
    void load()
    void loadModels()
  }, [open, load, loadModels])

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

  const onFontScaleChange = (value: string) => {
    const next = value as FontScale
    setFontScaleState(next)
    setFontScale(next)
  }

  const saveProfile = async () => {
    if (!platformMode) return
    setProfileBusy(true)
    setProfileMsg(null)
    try {
      const u = await platform.patchMe({
        nickname: nickname.trim(),
        email: email.trim(),
        avatar_url: avatarUrl ?? undefined,
        clear_avatar: avatarUrl === null && Boolean(me?.avatar_url),
      })
      onUserUpdated?.(u)
      setProfileMsg(t('settings.account.save.ok'))
      await load()
    } catch (err) {
      setProfileMsg(
        err instanceof PlatformApiError ? err.message : t('settings.account.save.fail'),
      )
    } finally {
      setProfileBusy(false)
    }
  }

  const savePassword = async () => {
    if (!platformMode) return
    setPasswordBusy(true)
    setPasswordMsg(null)
    try {
      await platform.changePassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setPasswordMsg(t('settings.password.ok'))
    } catch (err) {
      setPasswordMsg(
        err instanceof PlatformApiError ? err.message : t('settings.password.fail'),
      )
    } finally {
      setPasswordBusy(false)
    }
  }

  const onAvatarFile = (file: File | null) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setProfileMsg(t('settings.account.avatar.invalid'))
      return
    }
    if (file.size > 200_000) {
      setProfileMsg(t('settings.account.avatar.tooLarge'))
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : null
      setAvatarUrl(result)
      setProfileMsg(null)
    }
    reader.readAsDataURL(file)
  }

  const toggleFavorite = (id: string) => {
    setFavorites((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const saveFavorites = async () => {
    if (!workspaceId) return
    setModelsBusy(true)
    setModelsMsg(null)
    try {
      const res = await platform.patchPreferences(workspaceId, {
        favorite_models: favorites,
        preferred_model: preferred || undefined,
      })
      setFavorites(res.favorite_models ?? favorites)
      if (res.preferred_model) setPreferred(res.preferred_model)
      setModelsMsg(t('settings.models.save.ok'))
      notifyPreferencesUpdated()
    } catch (err) {
      setModelsMsg(
        err instanceof PlatformApiError ? err.message : t('settings.models.save.fail'),
      )
    } finally {
      setModelsBusy(false)
    }
  }

  const filteredCatalog = useMemo(() => {
    const q = modelFilter.trim().toLowerCase()
    if (!q) return allModels
    return allModels.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        (m.owned_by && m.owned_by.toLowerCase().includes(q)),
    )
  }, [allModels, modelFilter])

  const needsBind =
    platformMode &&
    (me?.upstream_status === 'pending_bind' ||
      platformUser?.upstream_status === 'pending_bind')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'settings-dialog flex flex-col gap-0 overflow-hidden p-0',
          'max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:w-full max-sm:max-w-none',
          'max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none',
          'sm:max-h-[min(90vh,820px)] sm:max-w-3xl',
        )}
        showCloseButton
        overlayClassName="bg-black/70 backdrop-blur-[2px]"
      >
        <DialogHeader className="border-b border-border px-6 py-4 text-left">
          <DialogTitle>{t('settings.dialog.title')}</DialogTitle>
          <DialogDescription>{t('settings.dialog.subtitle')}</DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as SettingsTab)}
          orientation="vertical"
          className="flex min-h-0 flex-1 flex-col gap-0 sm:flex-row"
        >
          {/* Vertical sidebar (screenshot layout) */}
          <aside className="flex w-full shrink-0 flex-col border-b border-border sm:w-48 sm:border-r sm:border-b-0">
            <TabsList className="bg-transparent h-auto w-full flex-col items-stretch justify-start gap-1 rounded-none p-3">
              <TabsTrigger
                value="general"
                className="justify-start data-[state=active]:bg-muted"
              >
                {t('settings.tab.general')}
              </TabsTrigger>
              {platformMode && (
                <TabsTrigger
                  value="account"
                  className="justify-start data-[state=active]:bg-muted"
                >
                  {t('settings.tab.account')}
                </TabsTrigger>
              )}
              {platformMode && (
                <TabsTrigger
                  value="models"
                  className="justify-start data-[state=active]:bg-muted"
                >
                  {t('settings.tab.models')}
                </TabsTrigger>
              )}
              {platformMode && (
                <TabsTrigger
                  value="usage"
                  className="justify-start data-[state=active]:bg-muted"
                >
                  {t('settings.tab.usage')}
                </TabsTrigger>
              )}
            </TabsList>
            <div className="mt-auto border-t border-border p-3">
              <Button
                type="button"
                variant="destructive"
                className="w-full justify-start"
                size="sm"
                onClick={() => void logout()}
                disabled={loggingOut || !me}
              >
                {loggingOut ? t('settings.signout.busy') : t('settings.signout')}
              </Button>
            </div>
          </aside>

          <ScrollArea className="min-h-0 flex-1 px-6 py-4">
            <TabsContent value="general" className="mt-0 space-y-6 pb-4">
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">{t('settings.preferences.theme')}</h3>
                <RadioGroup
                  value={theme}
                  onValueChange={onThemeChange}
                  className="grid gap-2 sm:grid-cols-3"
                >
                  {(
                    [
                      ['light', 'settings.theme.light'],
                      ['dark', 'settings.theme.dark'],
                      ['system', 'settings.theme.system'],
                    ] as const
                  ).map(([value, labelKey]) => (
                    <label
                      key={value}
                      className={cn(
                        'hover:bg-muted/50 flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-border px-3 py-4 text-center',
                        theme === value && 'bg-muted border-primary/40',
                      )}
                    >
                      <RadioGroupItem value={value} id={`theme-${value}`} className="sr-only" />
                      <span className="text-sm font-medium whitespace-nowrap">
                        {t(labelKey)}
                      </span>
                    </label>
                  ))}
                </RadioGroup>
                <p className="text-muted-foreground text-xs">
                  {t('settings.preferences.theme.hint')}
                </p>
              </section>

              <Separator />

              <section className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Label className="shrink-0">{t('settings.preferences.language')}</Label>
                  <LanguageToggle />
                </div>
              </section>

              <Separator />

              <section className="space-y-3">
                <Label>{t('settings.preferences.font')}</Label>
                <p className="text-muted-foreground text-xs">
                  {t('settings.preferences.font.hint')}
                </p>
                <RadioGroup
                  value={fontScale}
                  onValueChange={onFontScaleChange}
                  className="flex flex-row flex-wrap gap-2"
                >
                  {(
                    [
                      ['sm', 'settings.font.sm'],
                      ['md', 'settings.font.md'],
                      ['lg', 'settings.font.lg'],
                    ] as const
                  ).map(([value, labelKey]) => (
                    <label
                      key={value}
                      className="hover:bg-muted/50 flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2"
                    >
                      <RadioGroupItem value={value} id={`font-${value}`} />
                      <span className="text-sm whitespace-nowrap">{t(labelKey)}</span>
                    </label>
                  ))}
                </RadioGroup>
              </section>

              {needsBind && platformMode && (
                <>
                  <Separator />
                  <Alert>
                    <AlertDescription>
                      {t('settings.bindKey.goTab')}{' '}
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => setTab('models')}
                      >
                        {t('settings.tab.models')}
                      </button>
                    </AlertDescription>
                  </Alert>
                </>
              )}

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

              {!me && !loading && (
                <p className="text-muted-foreground text-sm">{t('settings.not_signed_in')}</p>
              )}
            </TabsContent>

            {platformMode && (
              <TabsContent value="account" className="mt-0 space-y-6 pb-4">
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">{t('settings.account.title')}</h3>
                  {loading ? (
                    <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
                  ) : me ? (
                    <div className="flex items-start gap-4">
                      {/* 账号预览头像 64×64；右下角编辑：更换 / 恢复默认 */}
                      <div className="relative size-16 shrink-0">
                        {avatarUrl ? (
                          <img
                            src={avatarUrl}
                            alt=""
                            className="size-16 rounded-full border border-border object-cover"
                          />
                        ) : (
                          <div className="bg-muted text-muted-foreground flex size-16 items-center justify-center rounded-full text-lg font-medium">
                            {(nickname || me.nickname || me.email || '?')
                              .slice(0, 1)
                              .toUpperCase()}
                          </div>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="secondary"
                              className="absolute -right-0.5 -bottom-0.5 size-6 rounded-full border border-border shadow-sm"
                              title={t('settings.account.avatar.edit')}
                              aria-label={t('settings.account.avatar.edit')}
                            >
                              <Pencil className="size-3" aria-hidden />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" className="min-w-[10rem]">
                            <DropdownMenuItem
                              onSelect={(e) => {
                                e.preventDefault()
                                avatarFileRef.current?.click()
                              }}
                            >
                              {t('settings.account.avatar.pick')}
                            </DropdownMenuItem>
                            {avatarUrl && (
                              <DropdownMenuItem
                                onSelect={() => setAvatarUrl(null)}
                              >
                                {t('settings.account.avatar.reset')}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <input
                          ref={avatarFileRef}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => {
                            onAvatarFile(e.target.files?.[0] ?? null)
                            e.target.value = ''
                          }}
                        />
                      </div>
                      <dl className="grid flex-1 gap-2 text-sm">
                        {me.nickname && (
                          <div className="flex justify-between gap-4">
                            <dt className="text-muted-foreground">
                              {t('settings.account.nickname')}
                            </dt>
                            <dd className="font-medium">{me.nickname}</dd>
                          </div>
                        )}
                        {me.email && (
                          <div className="flex justify-between gap-4">
                            <dt className="text-muted-foreground">
                              {t('settings.account.email')}
                            </dt>
                            <dd className="text-right font-medium">{me.email}</dd>
                          </div>
                        )}
                        <div className="flex justify-between gap-4">
                          <dt className="text-muted-foreground">
                            {t('settings.account.user_id')}
                          </dt>
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
                      </dl>
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-sm">{t('settings.not_signed_in')}</p>
                  )}
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">{t('settings.account.edit')}</h3>
                  <div className="space-y-2">
                    <Label htmlFor="settings-nickname">{t('settings.account.nickname')}</Label>
                    <Input
                      id="settings-nickname"
                      value={nickname}
                      onChange={(e) => setNickname(e.target.value)}
                      maxLength={64}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="settings-email">{t('settings.account.email')}</Label>
                    <Input
                      id="settings-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={profileBusy}
                    onClick={() => void saveProfile()}
                  >
                    {profileBusy ? t('common.loading') : t('settings.account.save')}
                  </Button>
                  {profileMsg && (
                    <Alert>
                      <AlertDescription>{profileMsg}</AlertDescription>
                    </Alert>
                  )}
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">{t('settings.password.title')}</h3>
                  <div className="space-y-2">
                    <Label htmlFor="settings-pw-current">
                      {t('settings.password.current')}
                    </Label>
                    <Input
                      id="settings-pw-current"
                      type="password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="settings-pw-new">{t('settings.password.new')}</Label>
                    <Input
                      id="settings-pw-new"
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={
                      passwordBusy ||
                      currentPassword.length < 1 ||
                      newPassword.length < 8
                    }
                    onClick={() => void savePassword()}
                  >
                    {passwordBusy ? t('common.loading') : t('settings.password.submit')}
                  </Button>
                  {passwordMsg && (
                    <Alert>
                      <AlertDescription>{passwordMsg}</AlertDescription>
                    </Alert>
                  )}
                </section>
              </TabsContent>
            )}

            {platformMode && (
              <TabsContent value="models" className="mt-0 space-y-6 pb-4">
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">{t('settings.bindKey.title')}</h3>
                  <p className="text-muted-foreground text-sm">
                    {needsBind
                      ? t('settings.bindKey.hint')
                      : t('settings.bindKey.updateHint')}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {t('settings.bindKey.validateNote')}
                  </p>
                  <Input
                    type="password"
                    value={bindKey}
                    onChange={(e) => setBindKey(e.target.value)}
                    placeholder={t('settings.bindKey.placeholder')}
                    disabled={bindBusy}
                    autoComplete="off"
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={bindBusy || !bindKey.trim()}
                    onClick={() => void submitBindKey()}
                  >
                    {bindBusy
                      ? t('settings.bindKey.busy')
                      : needsBind
                        ? t('settings.bindKey.submit')
                        : t('settings.bindKey.update')}
                  </Button>
                  {bindMsg && (
                    <Alert>
                      <AlertDescription>{bindMsg}</AlertDescription>
                    </Alert>
                  )}
                </section>

                <Separator />

                <section className="space-y-4">
                  <h3 className="text-sm font-semibold">{t('settings.tab.models')}</h3>
                  <p className="text-muted-foreground text-sm">{t('settings.models.hint')}</p>
                  <Input
                    placeholder={t('settings.models.search')}
                    value={modelFilter}
                    onChange={(e) => setModelFilter(e.target.value)}
                  />
                  <div className="space-y-2">
                    <Label>{t('settings.models.preferred')}</Label>
                    <select
                      className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                      value={preferred}
                      onChange={(e) => setPreferred(e.target.value)}
                    >
                      <option value="">{t('settings.models.preferred.none')}</option>
                      {(favorites.length
                        ? allModels.filter((m) => favorites.includes(m.id))
                        : allModels
                      ).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                    {modelsBusy && (
                      <p className="text-muted-foreground p-2 text-sm">
                        {t('common.loading')}
                      </p>
                    )}
                    {!modelsBusy && filteredCatalog.length === 0 && (
                      <p className="text-muted-foreground p-2 text-sm">
                        {t('settings.models.empty')}
                      </p>
                    )}
                    {filteredCatalog.map((m) => (
                      <label
                        key={m.id}
                        className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5"
                      >
                        <Checkbox
                          checked={favorites.includes(m.id)}
                          onCheckedChange={() => toggleFavorite(m.id)}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm">{m.id}</span>
                        {m.owned_by && (
                          <span className="text-muted-foreground text-xs">{m.owned_by}</span>
                        )}
                      </label>
                    ))}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={modelsBusy}
                    onClick={() => void saveFavorites()}
                  >
                    {modelsBusy ? t('common.loading') : t('settings.models.save')}
                  </Button>
                  {modelsMsg && (
                    <Alert>
                      <AlertDescription>{modelsMsg}</AlertDescription>
                    </Alert>
                  )}
                </section>
              </TabsContent>
            )}

            {platformMode && (
              <TabsContent value="usage" className="mt-0 space-y-4 pb-4">
                <p className="text-muted-foreground text-sm py-8 text-center">
                  {t('settings.usage.comingSoon')}
                </p>
              </TabsContent>
            )}

            {error && (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </ScrollArea>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
