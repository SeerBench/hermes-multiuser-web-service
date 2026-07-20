import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ApiError, auth } from '../api'
import { useT } from '../i18n'
import type { Translator } from '../i18n'
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
  // Why the modal opened.  Drives the heading copy so the user knows
  // whether this is the first-time login or a forced re-auth.
  reason: 'first-message' | 'session-expired'
  onSuccess: (userId: string) => void
  onCancel: () => void
  /** When set, show a link back to email/account login. */
  onSwitchToAccount?: () => void
}

/**
 * Modal that asks the user to paste their new-api key.
 * Shown on first message (no cookie) or when the server returns 401.
 */
export function KeyPromptModal({
  reason,
  onSuccess,
  onCancel,
  onSwitchToAccount,
}: Props) {
  const t = useT()
  const [apiKey, setApiKey] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    // Dialog mount focus — small delay for portal paint.
    const id = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [])

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = apiKey.trim()
    if (!trimmed) return
    setSubmitting(true)
    setError(null)
    try {
      const { user_id } = await auth.login(trimmed)
      onSuccess(user_id)
    } catch (err) {
      if (err instanceof ApiError) {
        setError(messageForCode(err.code, err.status, t))
      } else if (err instanceof Error) {
        setError(err.message)
      } else {
        setError(t('keymodal.error.generic', { status: 0 }))
      }
    } finally {
      setSubmitting(false)
    }
  }

  const heading =
    reason === 'session-expired'
      ? t('keymodal.heading.expired')
      : t('keymodal.heading.first')
  const subline =
    reason === 'session-expired'
      ? t('keymodal.sub.expired')
      : t('keymodal.sub.first')

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onCancel()
      }}
    >
      <DialogContent showCloseButton={!submitting} className="sm:max-w-md">
        <form onSubmit={onSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{heading}</DialogTitle>
            <DialogDescription>{subline}</DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="keymodal-apikey">{t('keymodal.label.apikey')}</Label>
            <Input
              id="keymodal-apikey"
              ref={inputRef}
              type="password"
              autoComplete="off"
              spellCheck={false}
              required
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={submitting}
              placeholder="sk-…"
            />
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={submitting}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={submitting || !apiKey.trim()}>
              {submitting ? t('keymodal.submitting') : t('keymodal.submit')}
            </Button>
          </DialogFooter>

          <p className="text-muted-foreground text-xs leading-relaxed">
            {t('keymodal.help')}
          </p>

          {onSwitchToAccount && (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="link"
                className="h-auto p-0"
                disabled={submitting}
                onClick={onSwitchToAccount}
              >
                {t('keymodal.switchAccount')}
              </Button>
            </div>
          )}
        </form>
      </DialogContent>
    </Dialog>
  )
}

function messageForCode(
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
