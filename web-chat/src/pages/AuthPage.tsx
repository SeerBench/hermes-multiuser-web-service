import { useState } from 'react'
import type { FormEvent } from 'react'
import { ApiError, auth } from '../api'
import {
  PlatformApiError,
  platform,
  storeWorkspaceId,
  type PlatformUser,
} from '../platformClient'
import { useT } from '../i18n'
import type { Translator } from '../i18n'
import { BrandLogo } from '../components/BrandLogo'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

type Props = {
  onSuccess: (user: PlatformUser, opts?: { registered?: boolean }) => void
  /** Legacy API-key path (web_chat cookie; no platform account). */
  onLegacySuccess: (userId: string) => void
  /** Open forgot / reset views (e.g. from `#/reset-password?token=`). */
  initialMode?: AccountMode
  resetToken?: string | null
}

type Method = 'account' | 'apikey'
type AccountMode = 'login' | 'register' | 'forgot' | 'reset'

export function AuthPage({
  onSuccess,
  onLegacySuccess,
  initialMode = 'login',
  resetToken = null,
}: Props) {
  const t = useT()
  const [method, setMethod] = useState<Method>('account')
  const [mode, setMode] = useState<AccountMode>(
    initialMode === 'reset' && !resetToken ? 'forgot' : initialMode,
  )
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const switchMethod = (next: Method) => {
    setMethod(next)
    setError(null)
    setInfo(null)
  }

  const goLogin = () => {
    setMode('login')
    setError(null)
    setInfo(null)
    setPassword('')
    if (window.location.hash.includes('reset-password')) {
      window.location.hash = '#/chat'
    }
  }

  const submitAccount = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const fn = mode === 'login' ? platform.login : platform.register
      const res = await fn(email.trim(), password)
      if (res.workspace?.id) storeWorkspaceId(res.workspace.id)
      onSuccess(res.user, { registered: mode === 'register' })
    } catch (err) {
      if (err instanceof PlatformApiError) {
        setError(err.message)
      } else if (err instanceof Error) {
        setError(err.message)
      } else {
        setError(t('auth.error.generic'))
      }
    } finally {
      setBusy(false)
    }
  }

  const submitForgot = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      await platform.forgotPassword(email.trim())
      setInfo(t('auth.forgot.sent'))
    } catch (err) {
      if (err instanceof PlatformApiError) {
        setError(err.message)
      } else if (err instanceof Error) {
        setError(err.message)
      } else {
        setError(t('auth.error.generic'))
      }
    } finally {
      setBusy(false)
    }
  }

  const submitReset = async (e: FormEvent) => {
    e.preventDefault()
    if (!resetToken) {
      setError(t('auth.reset.missingToken'))
      return
    }
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      await platform.resetPassword(resetToken, password)
      setInfo(t('auth.reset.ok'))
      setMode('login')
      setPassword('')
      window.location.hash = '#/chat'
    } catch (err) {
      if (err instanceof PlatformApiError) {
        setError(err.message)
      } else if (err instanceof Error) {
        setError(err.message)
      } else {
        setError(t('auth.error.generic'))
      }
    } finally {
      setBusy(false)
    }
  }

  const submitApiKey = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = apiKey.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const { user_id } = await auth.login(trimmed)
      onLegacySuccess(user_id)
    } catch (err) {
      if (err instanceof ApiError) {
        setError(messageForKeyCode(err.code, err.status, t))
      } else if (err instanceof Error) {
        setError(err.message)
      } else {
        setError(t('keymodal.error.generic', { status: 0 }))
      }
    } finally {
      setBusy(false)
    }
  }

  const title =
    mode === 'forgot'
      ? t('auth.forgot.title')
      : mode === 'reset'
        ? t('auth.reset.title')
        : t('auth.title')
  const subtitle =
    mode === 'forgot'
      ? t('auth.forgot.hint')
      : mode === 'reset'
        ? t('auth.reset.hint')
        : t('auth.subtitle')

  return (
    <div className="auth-page">
      <Card className="auth-card-shell w-full max-w-md border-border/80 shadow-lg">
        <CardHeader className="space-y-1">
          <div className="flex items-center gap-3">
            <BrandLogo size={40} className="rounded-[10px] shadow-sm" />
            <div className="min-w-0 space-y-1">
              <CardTitle className="text-2xl">{title}</CardTitle>
              <CardDescription>{subtitle}</CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {method === 'account' && mode === 'forgot' ? (
            <form onSubmit={submitForgot} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="auth-email">{t('auth.email')}</Label>
                <Input
                  id="auth-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {info && (
                <Alert>
                  <AlertDescription>{info}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? t('auth.submitting') : t('auth.forgot.submit')}
              </Button>
              <Button
                type="button"
                variant="link"
                className="h-auto w-full p-0 text-sm"
                onClick={goLogin}
              >
                {t('auth.forgot.back')}
              </Button>
            </form>
          ) : method === 'account' && mode === 'reset' ? (
            <form onSubmit={submitReset} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="auth-password">{t('auth.reset.password')}</Label>
                <Input
                  id="auth-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={8}
                  required
                />
              </div>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {info && (
                <Alert>
                  <AlertDescription>{info}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? t('auth.submitting') : t('auth.reset.submit')}
              </Button>
              <Button
                type="button"
                variant="link"
                className="h-auto w-full p-0 text-sm"
                onClick={goLogin}
              >
                {t('auth.forgot.back')}
              </Button>
            </form>
          ) : method === 'account' ? (
            <>
              <Tabs
                value={mode === 'register' ? 'register' : 'login'}
                onValueChange={(v) => {
                  setMode(v as 'login' | 'register')
                  setError(null)
                  setInfo(null)
                }}
                className="w-full"
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="login">{t('auth.login')}</TabsTrigger>
                  <TabsTrigger value="register">{t('auth.register')}</TabsTrigger>
                </TabsList>
              </Tabs>

              <form onSubmit={submitAccount} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="auth-email">{t('auth.email')}</Label>
                  <Input
                    id="auth-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="auth-password">{t('auth.password')}</Label>
                    {mode === 'login' && (
                      <Button
                        type="button"
                        variant="link"
                        className="text-muted-foreground h-auto p-0 text-xs"
                        onClick={() => {
                          setMode('forgot')
                          setError(null)
                          setInfo(null)
                        }}
                      >
                        {t('auth.forgotLink')}
                      </Button>
                    )}
                  </div>
                  <Input
                    id="auth-password"
                    type="password"
                    autoComplete={
                      mode === 'login' ? 'current-password' : 'new-password'
                    }
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={8}
                    required
                  />
                </div>
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                {info && (
                  <Alert>
                    <AlertDescription>{info}</AlertDescription>
                  </Alert>
                )}
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? t('auth.submitting') : t('auth.submit')}
                </Button>
              </form>
            </>
          ) : (
            <form onSubmit={submitApiKey} className="space-y-4">
              <p className="text-muted-foreground text-sm leading-relaxed">
                {t('keymodal.sub.first')}
              </p>
              <div className="space-y-2">
                <Label htmlFor="auth-apikey">{t('keymodal.label.apikey')}</Label>
                <Input
                  id="auth-apikey"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  disabled={busy}
                  placeholder="sk-…"
                  required
                />
              </div>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button
                type="submit"
                className="w-full"
                disabled={busy || !apiKey.trim()}
              >
                {busy ? t('keymodal.submitting') : t('keymodal.submit')}
              </Button>
              <p className="text-muted-foreground text-xs leading-relaxed">
                {t('keymodal.help')}
              </p>
            </form>
          )}
        </CardContent>

        {mode !== 'forgot' && mode !== 'reset' && (
          <CardFooter className="justify-center border-t border-border/60 pt-4">
            {method === 'account' ? (
              <Button
                type="button"
                variant="link"
                className="text-muted-foreground h-auto p-0 text-sm"
                disabled={busy}
                onClick={() => switchMethod('apikey')}
              >
                {t('auth.switchToApiKey')}
              </Button>
            ) : (
              <Button
                type="button"
                variant="link"
                className="text-muted-foreground h-auto p-0 text-sm"
                disabled={busy}
                onClick={() => switchMethod('account')}
              >
                {t('auth.switchToAccount')}
              </Button>
            )}
          </CardFooter>
        )}
      </Card>
    </div>
  )
}

function messageForKeyCode(
  code: string | undefined,
  status: number,
  t: Translator,
): string {
  switch (code) {
    case 'invalid_key':
      return t('keymodal.error.invalid_key')
    case 'upstream_unreachable':
      return t('keymodal.error.upstream_unreachable')
    case 'misconfigured':
      return t('keymodal.error.misconfigured')
    case 'missing_api_key':
      return t('keymodal.error.missing_api_key')
    default:
      return t('keymodal.error.generic', { status })
  }
}

/** Legacy API-key login wrapper (web_chat /api/auth/login). */
export async function legacyKeyLogin(apiKey: string): Promise<string> {
  const { user_id } = await auth.login(apiKey)
  return user_id
}
