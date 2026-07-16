import { useEffect, useState } from 'react'
import { XIcon } from 'lucide-react'
import { useT } from '../i18n'
import { fileContentUrl } from '../platformClient'
import { MarkdownContent } from './MarkdownContent'
import { Button } from '@/components/ui/button'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer'
import { ScrollArea } from '@/components/ui/scroll-area'
import { isDrawerPreviewableName } from './AttachmentChips'

export type PreviewableFile = {
  fileId: string
  name: string
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string | null | undefined
  file: PreviewableFile | null
}

/** 右侧 Drawer：预览工作区中的 Markdown / PDF。 */
export function FilePreviewDrawer({
  open,
  onOpenChange,
  workspaceId,
  file,
}: Props) {
  const t = useT()
  const [mdText, setMdText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const kind =
    file && isDrawerPreviewableName(file.name)
      ? file.name.toLowerCase().endsWith('.pdf')
        ? 'pdf'
        : 'md'
      : null

  const contentSrc =
    workspaceId && file?.fileId
      ? fileContentUrl(workspaceId, file.fileId)
      : null

  useEffect(() => {
    if (!open || !file || !contentSrc || kind !== 'md') {
      setMdText(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setMdText(null)
    void fetch(contentSrc, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.statusText || String(res.status))
        return res.text()
      })
      .then((text) => {
        if (!cancelled) setMdText(text)
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, file, contentSrc, kind])

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      direction="right"
      shouldScaleBackground={false}
    >
      <DrawerContent className="file-preview-drawer">
        <DrawerHeader className="border-b">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <DrawerTitle className="truncate">
                {file?.name ?? t('attach.preview.title')}
              </DrawerTitle>
              <DrawerDescription>
                {kind === 'pdf'
                  ? t('attach.preview.pdf')
                  : t('attach.preview.md')}
              </DrawerDescription>
            </div>
            <DrawerClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('common.close')}
              >
                <XIcon className="size-4" />
              </Button>
            </DrawerClose>
          </div>
        </DrawerHeader>

        <div className="file-preview-drawer-body flex min-h-0 flex-1 flex-col">
          {!workspaceId || !file || !contentSrc || !kind ? (
            <p className="page-hint p-4">{t('attach.preview.unavailable')}</p>
          ) : kind === 'pdf' ? (
            <iframe
              title={file.name}
              src={contentSrc}
              className="file-preview-pdf h-full min-h-0 w-full flex-1 border-0"
            />
          ) : loading ? (
            <p className="page-hint p-4">{t('common.loading')}</p>
          ) : error ? (
            <p className="auth-error p-4">{error}</p>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="file-preview-md p-4">
                <MarkdownContent text={mdText ?? ''} />
              </div>
            </ScrollArea>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
