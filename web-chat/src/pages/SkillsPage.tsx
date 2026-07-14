import { useCallback, useEffect, useState } from 'react'
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

export function SkillsPage() {
  const t = useT()
  const workspaceId = getStoredWorkspaceId()
  const [skills, setSkills] = useState<SkillRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<SkillDetail | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)

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
      await platform.patchSkill(workspaceId, name, { enabled: !enabled })
      await reload()
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
    }
  }

  const openDetail = async (name: string) => {
    if (!workspaceId) return
    setDetailBusy(true)
    setError(null)
    setDetailOpen(true)
    try {
      setSelected(await platform.getSkill(workspaceId, name))
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : String(err))
      setDetailOpen(false)
    } finally {
      setDetailBusy(false)
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
    <div className="panel-page mx-auto max-w-3xl space-y-6 p-4">
      <div>
        <h2 className="text-xl font-semibold">{t('nav.skills')}</h2>
        <p className="text-muted-foreground mt-1 text-sm">{t('skills.hint')}</p>
      </div>

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
              <ScrollArea className="max-h-[min(55vh,480px)] flex-1 px-6 py-4">
                {selected.description && (
                  <p className="text-muted-foreground mb-3 text-sm">
                    {selected.description}
                  </p>
                )}
                {selected.source === 'user' && (
                  <p className="text-muted-foreground mb-3 text-xs">
                    {t('skills.detail.userHint')}
                  </p>
                )}
                <pre className="bg-muted overflow-auto rounded-md p-3 text-xs leading-relaxed whitespace-pre-wrap">
                  {selected.content}
                </pre>
              </ScrollArea>
              {selected.source === 'global' && (
                <DialogFooter className="border-t border-border px-6 py-3">
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => void installFromCatalog(selected.name)}
                  >
                    {busy ? t('skills.installing') : t('skills.install')}
                  </Button>
                </DialogFooter>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
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
}

function SkillListItem({
  skill,
  busy,
  onSelect,
  onToggle,
  enabledLabel,
  onInstall,
  installLabel,
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
