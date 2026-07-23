import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useT } from '../i18n'
import {
  PlatformApiError,
  platform,
  type PlatformUser,
} from '../platformClient'
import type { Route } from '../routing'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Props = {
  user: PlatformUser
  onUserUpdated: (user: PlatformUser) => void
  onNavigate: (route: Route) => void
  onComplete: () => void
}

const STEPS = ['bind', 'files', 'chat'] as const
type StepId = (typeof STEPS)[number]

function needsBind(user: PlatformUser): boolean {
  return user.upstream_status === 'pending_bind'
}

export function OnboardingModal({
  user,
  onUserUpdated,
  onNavigate,
  onComplete,
}: Props) {
  const t = useT()
  const [step, setStep] = useState<StepId>(() =>
    needsBind(user) ? 'bind' : 'files',
  )
  const [bindKey, setBindKey] = useState('')
  const [bindBusy, setBindBusy] = useState(false)
  const [bindError, setBindError] = useState<string | null>(null)

  useEffect(() => {
    if (step === 'bind' && !needsBind(user)) {
      setStep('files')
    }
  }, [user, step])

  const stepIndex = STEPS.indexOf(step)

  const submitBind = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = bindKey.trim()
    if (!trimmed) return
    setBindBusy(true)
    setBindError(null)
    try {
      const res = await platform.bindKey(trimmed)
      setBindKey('')
      onUserUpdated(res.user)
      setStep('files')
    } catch (err) {
      setBindError(
        err instanceof PlatformApiError ? err.message : t('settings.bindKey.fail'),
      )
    } finally {
      setBindBusy(false)
    }
  }

  const goFiles = () => {
    onNavigate('files')
    setStep('chat')
  }

  const finish = () => {
    onNavigate('chat')
    onComplete()
  }

  const stepTitle =
    step === 'bind'
      ? t('onboarding.step.bind')
      : step === 'files'
        ? t('onboarding.step.files')
        : t('onboarding.step.chat')

  const stepHint =
    step === 'bind'
      ? t('onboarding.bind.hint')
      : step === 'files'
        ? t('onboarding.files.hint')
        : t('onboarding.chat.hint')

  return (
    <Dialog open>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <p className="text-muted-foreground text-xs tracking-wide uppercase">
            {t('onboarding.progress', {
              current: stepIndex + 1,
              total: STEPS.length,
            })}
          </p>
          <DialogTitle>{t('onboarding.title')}</DialogTitle>
          <DialogDescription className="space-y-1 text-left">
            <span className="text-foreground block text-base font-medium">
              {stepTitle}
            </span>
            <span className="block">{stepHint}</span>
          </DialogDescription>
        </DialogHeader>

        {step === 'bind' && (
          <form onSubmit={submitBind} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="onboarding-bind-key">{t('settings.bindKey.title')}</Label>
              <Input
                id="onboarding-bind-key"
                type="password"
                autoComplete="off"
                value={bindKey}
                onChange={(e) => setBindKey(e.target.value)}
                placeholder={t('settings.bindKey.placeholder')}
                disabled={bindBusy}
              />
            </div>
            {bindError && (
              <Alert variant="destructive">
                <AlertDescription>{bindError}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="submit" disabled={bindBusy}>
                {bindBusy ? t('settings.bindKey.busy') : t('settings.bindKey.submit')}
              </Button>
            </DialogFooter>
          </form>
        )}

        {step === 'files' && (
          <DialogFooter className="gap-2 sm:justify-start">
            <Button type="button" onClick={goFiles}>
              {t('onboarding.files.go')}
            </Button>
            <Button type="button" variant="outline" onClick={() => setStep('chat')}>
              {t('onboarding.files.skip')}
            </Button>
          </DialogFooter>
        )}

        {step === 'chat' && (
          <DialogFooter>
            <Button type="button" onClick={finish}>
              {t('onboarding.chat.go')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
