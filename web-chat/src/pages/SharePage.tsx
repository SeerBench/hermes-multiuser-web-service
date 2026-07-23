import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '../i18n'
import { absoluteShareUrl } from '../conversationShare'
import { PlatformApiError, platform } from '../platformClient'
import { parseShareToken, routeHref } from '../routing'
import { Button } from '@/components/ui/button'
import { MarkdownContent } from '../components/MarkdownContent'
import { PageShell } from '../components/PageShell'
import { cn } from '@/lib/utils'

type ShareTurn = { role: string; text: string }

type SharePayload = {
  kind: string
  title?: string | null
  turns: ShareTurn[]
  created_at?: string | null
}

/**
 * Public read-only share page (`#/share/<token>`). No composer / edit.
 */
export function SharePage() {
  const t = useT()
  const [token, setToken] = useState(
    () => parseShareToken(window.location.hash) ?? '',
  )
  const [payload, setPayload] = useState<SharePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const onHash = () => {
      setToken(parseShareToken(window.location.hash) ?? '')
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    if (!token) {
      setLoading(false)
      setError(t('share.page.missing'))
      setPayload(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void platform
      .getShare(token)
      .then((data) => {
        if (cancelled) return
        setPayload(data)
      })
      .catch((err) => {
        if (cancelled) return
        const msg =
          err instanceof PlatformApiError
            ? err.status === 404
              ? t('share.page.notFound')
              : err.message
            : t('share.page.notFound')
        setError(msg)
        setPayload(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [token, t])

  const copyLink = async () => {
    if (!token) return
    const url = absoluteShareUrl(`#/share/${token}`)
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
        toast.success(t('share.toast.copied'))
      }
    } catch {
      toast.error(t('share.toast.failed'))
    }
  }

  return (
    <PageShell
      title={payload?.title?.trim() || t('share.page.title')}
      hint={t('share.page.readonly')}
      density="reading"
      actions={
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void copyLink()}>
            {t('share.page.copyLink')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              window.location.hash = routeHref('chat')
            }}
          >
            {t('share.page.openApp')}
          </Button>
        </div>
      }
    >
      {loading ? (
        <p className="page-hint">{t('common.loading')}</p>
      ) : error ? (
        <p className="page-hint text-destructive" role="alert">
          {error}
        </p>
      ) : (
        <ul className="share-readonly-list space-y-4">
          {(payload?.turns ?? []).map((turn, i) => (
            <li
              key={`${turn.role}-${i}`}
              className={cn(
                'rounded-lg border p-4',
                turn.role === 'user' ? 'bg-muted/40' : 'bg-card/40',
              )}
            >
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                {turn.role === 'user'
                  ? t('chat.role.user')
                  : t('chat.role.assistant')}
              </p>
              <div className="text-sm">
                <MarkdownContent text={turn.text} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  )
}
