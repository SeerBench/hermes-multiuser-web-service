import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { PageShell } from '../components/PageShell'
import { MarkdownEditor } from '../components/MarkdownEditor'
import { useLocale, useT } from '../i18n'
import { skillDisplayDescription } from '../skillDescriptions.zh'
import {
  PlatformApiError,
  getStoredWorkspaceId,
  platform,
  type SkillDetail,
  type SkillRow,
} from '../platformClient'
import { Badge } from '@/components/ui/badge'
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
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

const SKILL_TEMPLATE = `---
name: my-skill
description: Short one-line description.
version: "1.0"
---

# My Skill

## When to Use

## Procedure
`

type SkillsTab = 'mine' | 'catalog'

export function SkillsPage() {
  const t = useT()
  const { locale } = useLocale()
  const workspaceId = getStoredWorkspaceId()
  const [skills, setSkills] = useState<SkillRow[]>([])
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<SkillDetail | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createContent, setCreateContent] = useState(SKILL_TEMPLATE)
  const [tab, setTab] = useState<SkillsTab>('mine')

  const reload = useCallback(async () => {
    if (!workspaceId) return
    try {
      setSkills(await platform.listSkills(workspaceId))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    }
  }, [workspaceId])

  useEffect(() => {
    void reload()
  }, [reload])

  const describe = (skill: { name: string; description?: string | null }) =>
    skillDisplayDescription(locale, skill.name, skill.description)

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
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    }
  }

  const openDetail = async (name: string) => {
    if (!workspaceId) return
    setDetailBusy(true)
    setDetailOpen(true)
    setEditing(false)
    try {
      const detail = await platform.getSkill(workspaceId, name)
      setSelected(detail)
      setEditContent(detail.content)
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
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
      toast.success(t('skills.toast.saved'))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
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
      toast.success(t('skills.toast.deleted'))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
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
      setTab('mine')
      toast.success(t('skills.toast.created'))
      await openDetail(created)
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const installFromCatalog = async (name: string) => {
    if (!workspaceId) return
    setBusy(true)
    try {
      await platform.installSkillFromCatalog(workspaceId, name)
      await reload()
      setSelected(await platform.getSkill(workspaceId, name))
      setDetailOpen(true)
      setTab('mine')
      toast.success(t('skills.toast.installed'))
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!workspaceId) {
    return (
      <p className="text-muted-foreground p-4 text-sm">{t('skills.noWorkspace')}</p>
    )
  }

  const globalSkills = skills.filter((s) => s.source === 'global')
  const userSkills = skills.filter((s) => s.source === 'user')
  const otherSkills = skills.filter(
    (s) => s.source !== 'global' && s.source !== 'user',
  )
  const mySkills = [...userSkills, ...otherSkills]

  return (
    <PageShell
      title={t('nav.skills')}
      hint={t('skills.hint')}
      density="reading"
      constrainWidth={false}
    >
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as SkillsTab)}
        className="skills-tabs gap-4"
      >
        <div className="skills-tabs-bar">
          <TabsList className="bg-muted/80">
            <TabsTrigger value="mine">{t('skills.tab.mine')}</TabsTrigger>
            <TabsTrigger value="catalog">{t('skills.tab.catalog')}</TabsTrigger>
          </TabsList>
          <Button
            type="button"
            size="sm"
            className="skills-tabs-create"
            onClick={() => setCreateOpen(true)}
          >
            {t('skills.create')}
          </Button>
        </div>

        <TabsContent value="mine" className="space-y-2 outline-none">
          {mySkills.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('skills.mine.empty')}</p>
          ) : (
            mySkills.map((s) => (
              <SkillListItem
                key={`${s.source}-${s.name}`}
                skill={s}
                description={describe(s)}
                busy={busy || detailBusy}
                onSelect={() => void openDetail(s.name)}
                onToggle={() => void toggle(s.name, s.enabled !== false)}
                enabledLabel={t('skills.enabled')}
                onDelete={
                  s.source === 'user'
                    ? () => void removeSkill(s.name)
                    : undefined
                }
                deleteLabel={t('skills.delete')}
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="catalog" className="space-y-2 outline-none">
          <p className="text-muted-foreground mb-2 text-sm">
            {t('skills.catalog.hint')}
          </p>
          {globalSkills.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t('skills.catalog.empty')}
            </p>
          ) : (
            globalSkills.map((s) => (
              <SkillListItem
                key={s.name}
                skill={s}
                description={describe(s)}
                busy={busy || detailBusy}
                onSelect={() => void openDetail(s.name)}
                onToggle={() => void toggle(s.name, s.enabled !== false)}
                enabledLabel={t('skills.enabled')}
                onInstall={() => void installFromCatalog(s.name)}
                installLabel={t('skills.install')}
              />
            ))
          )}
        </TabsContent>
      </Tabs>

      <Dialog
        open={detailOpen}
        onOpenChange={(open) => {
          setDetailOpen(open)
          if (!open) setSelected(null)
        }}
      >
        <DialogContent className="flex h-[min(90vh,900px)] w-full max-w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[800px]">
          <DialogHeader className="shrink-0 border-b border-border px-6 py-4 text-left">
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
              <div className="overlay-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-4">
                {!editing && describe(selected) && (
                  <p className="text-muted-foreground mb-3 text-sm">
                    {describe(selected)}
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
                    minHeight={360}
                  />
                ) : (
                  <pre className="skills-detail-content skills-detail-content--dialog">
                    {selected.content}
                  </pre>
                )}
              </div>
              <DialogFooter className="shrink-0 gap-2 border-t border-border px-6 py-3">
                {selected.source === 'user' && (
                  <>
                    {editing ? (
                      <Button
                        type="button"
                        disabled={busy}
                        onClick={() => void saveEdit()}
                      >
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
          <MarkdownEditor
            value={createContent}
            onChange={setCreateContent}
            minHeight={280}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={busy || !createName.trim()}
              onClick={() => void createSkill()}
            >
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
  description: string
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
  description,
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
        {description && (
          <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
            {description}
          </p>
        )}
      </button>
      <div className="flex shrink-0 items-center gap-3">
        {onDelete && deleteLabel && (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={onDelete}
          >
            {deleteLabel}
          </Button>
        )}
        {onInstall && installLabel && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onInstall}
          >
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
