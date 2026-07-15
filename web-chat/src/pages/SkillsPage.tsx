import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { PageShell } from '../components/PageShell'
import { MarkdownEditor } from '../components/MarkdownEditor'
import { useT } from '../i18n'
import {
  PlatformApiError,
  getStoredWorkspaceId,
  platform,
  type SkillDetail,
  type SkillRow,
} from '../platformClient'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

import { Input } from '@/components/ui/input'

const SKILL_TEMPLATE = `---
name: my-skill
description: Short one-line description.
version: "1.0"
---

# My Skill

## When to Use

## Procedure
`

export function SkillsPage() {
  const t = useT()
  const workspaceId = getStoredWorkspaceId()
  const [skills, setSkills] = useState<SkillRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<SkillDetail | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createContent, setCreateContent] = useState(SKILL_TEMPLATE)

  const reload = useCallback(async () => {
    if (!workspaceId) return
    try {
      setSkills(await platform.listSkills(workspaceId))
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    }
  }, [workspaceId])

  useEffect(() => {
    void reload()
  }, [reload])

  const toggle = async (name: string, enabled: boolean) => {
    if (!workspaceId) return
    try {
      const next = !enabled
      await platform.patchSkill(workspaceId, name, { enabled: next })
      await reload()
      toast.success(
        next ? t('skills.toast.enabled') : t('skills.toast.disabled'),
      )
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    }
  }

  const openDetail = async (name: string) => {
    if (!workspaceId) return
    setDetailBusy(true)
    setError(null)
    setDetailOpen(true)
    setEditing(false)
    try {
      const detail = await platform.getSkill(workspaceId, name)
      setSelected(detail)
      setEditContent(detail.content)
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
      setDetailOpen(false)
    } finally {
      setDetailBusy(false)
    }
  }

  const saveEdit = async () => {
    if (!workspaceId || !selected) return
    setBusy(true)
    try {
      await platform.replaceSkill(workspaceId, selected.name, editContent)
      await reload()
      const detail = await platform.getSkill(workspaceId, selected.name)
      setSelected(detail)
      setEditing(false)
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const removeSkill = async (name: string) => {
    if (!workspaceId) return
    if (!window.confirm(t('skills.deleteConfirm', { name }))) return
    setBusy(true)
    try {
      await platform.deleteSkill(workspaceId, name)
      setDetailOpen(false)
      setSelected(null)
      await reload()
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const createSkill = async () => {
    if (!workspaceId || !createName.trim()) return
    setBusy(true)
    try {
      await platform.createSkill(workspaceId, {
        name: createName.trim(),
        skill_md: createContent,
      })
      await reload()
      const created = createName.trim()
      setCreateOpen(false)
      setCreateName('')
      setCreateContent(SKILL_TEMPLATE)
      await openDetail(created)
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const installFromCatalog = async (name: string) => {
    if (!workspaceId) return
    setBusy(true)
    setError(null)
    try {
      await platform.installSkillFromCatalog(workspaceId, name)
      await reload()
      setSelected(await platform.getSkill(workspaceId, name))
      setDetailOpen(true)
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!workspaceId) {
    return <p className="text-muted-foreground p-4 text-sm">{t('skills.noWorkspace')}</p>
  }

  const globalSkills = skills.filter((s) => s.source === 'global')
  const userSkills = skills.filter((s) => s.source === 'user')
  const otherSkills = skills.filter(
    (s) => s.source !== 'global' && s.source !== 'user',
  )

  return (
    <PageShell
      title={t('nav.skills')}
      hint={t('skills.hint')}
      density="wide"
      actions={
        <Button type="button" onClick={() => setCreateOpen(true)}>
          {t('skills.create')}
        </Button>
      }
    >

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {userSkills.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('skills.section.mine')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {userSkills.map((s) => (
              <SkillListItem
                key={s.name}
                skill={s}
                busy={busy || detailBusy}
                onSelect={() => void openDetail(s.name)}
                onToggle={() => void toggle(s.name, s.enabled !== false)}
                enabledLabel={t('skills.enabled')}
                onDelete={() => void removeSkill(s.name)}
                deleteLabel={t('skills.delete')}
              />
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('skills.section.catalog')}</CardTitle>
          <CardDescription>{t('skills.catalog.hint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {globalSkills.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('skills.catalog.empty')}</p>
          ) : (
            globalSkills.map((s) => (
              <SkillListItem
                key={s.name}
                skill={s}
                busy={busy || detailBusy}
                onSelect={() => void openDetail(s.name)}
                onToggle={() => void toggle(s.name, s.enabled !== false)}
                enabledLabel={t('skills.enabled')}
                onInstall={() => void installFromCatalog(s.name)}
                installLabel={t('skills.install')}
              />
            ))
          )}
        </CardContent>
      </Card>

      {otherSkills.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('skills.section.other')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {otherSkills.map((s) => (
              <SkillListItem
                key={s.name}
                skill={s}
                busy={busy || detailBusy}
                onSelect={() => void openDetail(s.name)}
                onToggle={() => void toggle(s.name, s.enabled !== false)}
                enabledLabel={t('skills.enabled')}
              />
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog
        open={detailOpen}
        onOpenChange={(open) => {
          setDetailOpen(open)
          if (!open) setSelected(null)
        }}
      >
        <DialogContent className="flex max-h-[min(90vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
          <DialogHeader className="border-b border-border px-6 py-4 text-left">
            <DialogTitle>{selected?.name ?? t('nav.skills')}</DialogTitle>
            <DialogDescription>
              {detailBusy
                ? t('common.loading')
                : selected
                  ? `${t('skills.detail.source')}: ${selected.source}${
                      selected.category ? ` · ${selected.category}` : ''
                    }`
                  : t('skills.detail.empty')}
            </DialogDescription>
          </DialogHeader>
          {selected && !detailBusy && (
            <>
              <ScrollArea className="overlay-scrollbar max-h-[min(55vh,480px)] flex-1 px-6 py-4">
                {selected.description && !editing && (
                  <p className="text-muted-foreground mb-3 text-sm">
                    {selected.description}
                  </p>
                )}
                {selected.source === 'user' && !editing && (
                  <p className="text-muted-foreground mb-3 text-xs">
                    {t('skills.detail.userHint')}
                  </p>
                )}
                {editing && selected.source === 'user' ? (
                  <MarkdownEditor
                    value={editContent}
                    onChange={setEditContent}
                    minHeight={320}
                  />
                ) : (
                  <MarkdownEditor
                    value={selected.content}
                    readOnly
                    minHeight={280}
                  />
                )}
              </ScrollArea>
              <DialogFooter className="border-t border-border px-6 py-3 gap-2">
                {selected.source === 'user' && (
                  <>
                    {editing ? (
                      <Button type="button" disabled={busy} onClick={() => void saveEdit()}>
                        {t('skills.save')}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setEditing(true)}
                      >
                        {t('skills.edit')}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void removeSkill(selected.name)}
                    >
                      {t('skills.delete')}
                    </Button>
                  </>
                )}
                {selected.source === 'global' && (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => void installFromCatalog(selected.name)}
                  >
                    {busy ? t('skills.installing') : t('skills.install')}
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('skills.create')}</DialogTitle>
            <DialogDescription>{t('skills.createHint')}</DialogDescription>
          </DialogHeader>
          <Input
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder={t('skills.createName')}
          />
          <MarkdownEditor value={createContent} onChange={setCreateContent} minHeight={280} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" disabled={busy || !createName.trim()} onClick={() => void createSkill()}>
              {t('skills.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}

type ItemProps = {
  skill: SkillRow
  busy: boolean
  onSelect: () => void
  onToggle: () => void
  enabledLabel: string
  onInstall?: () => void
  installLabel?: string
  onDelete?: () => void
  deleteLabel?: string
}

function SkillListItem({
  skill,
  busy,
  onSelect,
  onToggle,
  enabledLabel,
  onInstall,
  installLabel,
  onDelete,
  deleteLabel,
}: ItemProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between',
      )}
    >
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={onSelect}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{skill.name}</span>
          <Badge variant="outline" className="text-[10px] uppercase">
            {skill.source}
          </Badge>
        </div>
        {skill.description && (
          <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
            {skill.description}
          </p>
        )}
      </button>
      <div className="flex shrink-0 items-center gap-3">
        {onDelete && deleteLabel && (
          <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={onDelete}>
            {deleteLabel}
          </Button>
        )}
        {onInstall && installLabel && (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onInstall}>
            {installLabel}
          </Button>
        )}
        <label className="flex items-center gap-2 text-xs">
          <Switch
            checked={skill.enabled !== false}
            disabled={busy}
            onCheckedChange={onToggle}
            aria-label={enabledLabel}
          />
          <span className="text-muted-foreground">{enabledLabel}</span>
        </label>
      </div>
    </div>
  )
}
