import { useCallback, useEffect, useState } from 'react'
import { formatBytes } from '../format'
import { useT } from '../i18n'
import {
  PlatformApiError,
  platform,
  type PlatformFile,
} from '../platformClient'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'

export function FilePickerSheet({
  open,
  onOpenChange,
  workspaceId,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  onConfirm: (files: {
    name: string
    path: string
    size: number
    fileId: string
  }[]) => void
}) {
  const t = useT()
  const [files, setFiles] = useState<PlatformFile[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setFiles(await platform.listFiles(workspaceId))
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    }
  }, [workspaceId])

  useEffect(() => {
    if (open) {
      setSelected(new Set())
      void reload()
    }
  }, [open, reload])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const confirm = () => {
    const picked = files
      .filter((f) => selected.has(f.id))
      .map((f) => ({
        name: f.filename,
        path: f.storage_key ?? `uploads/${f.filename}`,
        size: f.size_bytes ?? 0,
        fileId: f.id,
      }))
    onConfirm(picked)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="file-picker-dialog">
        <DialogHeader>
          <DialogTitle>{t('composer.filePicker.title')}</DialogTitle>
        </DialogHeader>
        {error && <p className="auth-error">{error}</p>}
        <ScrollArea className="file-picker-list">
          {files.length === 0 && (
            <p className="page-hint">{t('composer.filePicker.empty')}</p>
          )}
          {files.map((f) => (
            <label key={f.id} className="file-picker-row">
              <Checkbox
                checked={selected.has(f.id)}
                onCheckedChange={() => toggle(f.id)}
              />
              <span className="file-picker-name">{f.filename}</span>
              <small>{formatBytes(f.size_bytes ?? 0)}</small>
            </label>
          ))}
        </ScrollArea>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="button" disabled={selected.size === 0} onClick={confirm}>
            {t('composer.filePicker.attach', { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
