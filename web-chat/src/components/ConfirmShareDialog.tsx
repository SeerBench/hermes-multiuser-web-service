import { useState } from 'react'
import { toast } from 'sonner'
import { useT } from '../i18n'
import {
  absoluteShareUrl,
  type ShareTurnPayload,
} from '../conversationShare'
import { PlatformApiError, platform } from '../platformClient'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  kind: 'reply' | 'conversation'
  title?: string | null
  turns: ShareTurnPayload[]
  sourceSessionId?: string | null
}

/**
 * Confirm → POST immutable snapshot → copy public `#/share/<token>` link.
 */
export function ConfirmShareDialog({
  open,
  onOpenChange,
  kind,
  title,
  turns,
  sourceSessionId,
}: Props) {
  const t = useT()
  const [busy, setBusy] = useState(false)

  const confirm = async () => {
    if (!turns.length || busy) return
    setBusy(true)
    try {
      const created = await platform.createShare({
        kind,
        title: title ?? undefined,
        turns,
        source_session_id: sourceSessionId ?? undefined,
      })
      const url = absoluteShareUrl(created.url_path)
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(url)
        }
      } catch {
        // still show success with URL in toast path below
      }
      toast.success(t('share.toast.created'))
      onOpenChange(false)
    } catch (err) {
      const msg =
        err instanceof PlatformApiError
          ? err.message
          : t('share.toast.failed')
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {kind === 'reply'
              ? t('share.confirm.replyTitle')
              : t('share.confirm.conversationTitle')}
          </DialogTitle>
          <DialogDescription>{t('share.confirm.body')}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t('common.cancel')}
          </Button>
          <Button type="button" disabled={busy || !turns.length} onClick={() => void confirm()}>
            {busy ? t('common.loading') : t('share.confirm.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
