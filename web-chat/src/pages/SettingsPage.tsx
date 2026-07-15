import { useCallback, useEffect, useMemo, useState } from 'react'
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

type SettingsTab = 'general' | 'account' | 'models'

/** Settings dialog: General / Account / Models. Wide on PC, fullscreen on mobile. */
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

  // Account edit form
  const [nickname, setNickname] = useState('')
  const [email, setEmail] = useState('')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
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
          // Mobile: fullscreen
          'max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:w-full max-sm:max-w-none',
          'max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none',
          // PC: wider panel
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
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <div className="border-b border-border px-4 pt-2 sm:px-6">
            <TabsList className="w-full justify-start overflow-x-auto">
              <TabsTrigger value="general">{t('settings.tab.general')}</TabsTrigger>
              {platformMode && (
                <TabsTrigger value="account">{t('settings.tab.account')}</TabsTrigger>
              )}
              {platformMode && (
                <TabsTrigger value="models">{t('settings.tab.models')}</TabsTrigger>
              )}
            </TabsList>
          </div>

          <ScrollArea className="min-h-0 flex-1 px-6 py-4">
            <TabsContent value="general" className="mt-0 space-y-6 pb-4">
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">{t('settings.account.title')}</h3>
                {loading ? (
                  <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
                ) : me ? (
                  <>
                    <div className="flex items-start gap-3">
                      {me.avatar_url ? (
                        <img
                          src={me.avatar_url}
                          alt=""
                          className="size-12 rounded-full border border-border object-cover"
                        />
                      ) : (
                        <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full text-sm font-medium">
                          {(me.nickname || me.email || '?').slice(0, 1).toUpperCase()}
                        </div>
                      )}
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
                    <Input
                      type="password"
                      value={bindKey}
                      onChange={(e) => setBindKey(e.target.value)}
                      placeholder={t('settings.bindKey.placeholder')}
                      disabled={bindBusy}
                    />
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
                {/* Language + appearance options on one row (wrap on narrow screens). */}
                <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                  <div className="flex flex-wrap items-center gap-3">
                    <Label className="shrink-0">
                      {t('settings.preferences.language')}
                    </Label>
                    <LanguageToggle />
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Label className="shrink-0">
                      {t('settings.preferences.theme')}
                    </Label>
                    <RadioGroup
                      value={theme}
                      onValueChange={onThemeChange}
                      className="flex flex-row flex-wrap gap-2"
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
                          className="hover:bg-muted/50 flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2"
                        >
                          <RadioGroupItem value={value} id={`theme-${value}`} />
                          <span className="text-sm whitespace-nowrap">
                            {t(labelKey)}
                          </span>
                        </label>
                      ))}
                    </RadioGroup>
                  </div>
                </div>
                <p className="text-muted-foreground text-xs">
                  {t('settings.preferences.theme.hint')}
                </p>
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
            </TabsContent>

            {platformMode && (
              <TabsContent value="account" className="mt-0 space-y-6 pb-4">
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">{t('settings.account.edit')}</h3>
                  <div className="flex items-center gap-4">
                    {avatarUrl ? (
                      <img
                        src={avatarUrl}
                        alt=""
                        className="size-16 rounded-full border border-border object-cover"
                      />
                    ) : (
                      <div className="bg-muted flex size-16 items-center justify-center rounded-full text-lg">
                        {(nickname || email || '?').slice(0, 1).toUpperCase()}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Label className="cursor-pointer">
                        <span className="bg-secondary inline-flex h-8 items-center rounded-md px-3 text-sm">
                          {t('settings.account.avatar.pick')}
                        </span>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => {
                            onAvatarFile(e.target.files?.[0] ?? null)
                            e.target.value = ''
                          }}
                        />
                      </Label>
                      {avatarUrl && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setAvatarUrl(null)}
                        >
                          {t('settings.account.avatar.clear')}
                        </Button>
                      )}
                    </div>
                  </div>
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
              <TabsContent value="models" className="mt-0 space-y-4 pb-4">
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
                    <p className="text-muted-foreground p-2 text-sm">{t('common.loading')}</p>
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
