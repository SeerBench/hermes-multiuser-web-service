import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { PageShell } from '../components/PageShell'
import { useT } from '../i18n'
import {
  PlatformApiError,
  platform,
  type UsageLogItem,
  type UsageModelRow,
  type UsageSkillRow,
  type UsageSummary,
  type UsageTrendPoint,
} from '../platformClient'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

type CenterTab = 'overview' | 'models' | 'skills' | 'logs'

function formatWhen(iso?: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function StatCard({
  label,
  requests,
  tokens,
  cost,
}: {
  label: string
  requests: number
  tokens: number
  cost: number
}) {
  const t = useT()
  return (
    <div className="usage-stat-card rounded-lg border bg-card/40 p-4 space-y-1">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-lg font-medium">
        {t('usage.stat.requests')}: {requests}
      </p>
      <p className="text-sm">
        {t('usage.stat.tokens')}: {tokens.toLocaleString()}
      </p>
      <p className="text-sm text-muted-foreground">
        {t('usage.stat.cost')}: {cost.toFixed(4)}
      </p>
    </div>
  )
}

function TrendBars({ points }: { points: UsageTrendPoint[] }) {
  const max = Math.max(1, ...points.map((p) => p.tokens))
  return (
    <ul className="usage-trend-list space-y-2">
      {points.map((p) => (
        <li key={p.date} className="flex items-center gap-3 text-sm">
          <span className="w-24 shrink-0 text-muted-foreground">{p.date.slice(5)}</span>
          <div className="flex-1 h-2 rounded bg-muted overflow-hidden">
            <div
              className="h-full bg-primary/70"
              style={{ width: `${Math.round((p.tokens / max) * 100)}%` }}
            />
          </div>
          <span className="w-28 shrink-0 text-right tabular-nums">
            {p.requests} / {p.tokens}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function UsagePage() {
  const t = useT()
  const [tab, setTab] = useState<CenterTab>('overview')
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [trendDays, setTrendDays] = useState<7 | 30>(7)
  const [points, setPoints] = useState<UsageTrendPoint[]>([])
  const [models, setModels] = useState<UsageModelRow[]>([])
  const [skills, setSkills] = useState<UsageSkillRow[]>([])
  const [logs, setLogs] = useState<UsageLogItem[]>([])
  const [logType, setLogType] = useState('')
  const [busy, setBusy] = useState(false)

  const reloadOverview = useCallback(async () => {
    try {
      const [s, tr] = await Promise.all([
        platform.getUsageSummary(),
        platform.getUsageTrend(trendDays),
      ])
      setSummary(s)
      setPoints(tr.points)
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    }
  }, [trendDays])

  const reloadModels = useCallback(async () => {
    try {
      setModels((await platform.getUsageByModel()).items)
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    }
  }, [])

  const reloadSkills = useCallback(async () => {
    try {
      setSkills((await platform.getUsageBySkill()).items)
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    }
  }, [])

  const reloadLogs = useCallback(async () => {
    try {
      const res = await platform.getUsageLogs({
        limit: 50,
        type: logType || undefined,
      })
      setLogs(res.items)
    } catch (err) {
      toast.error(err instanceof PlatformApiError ? err.message : String(err))
    }
  }, [logType])

  useEffect(() => {
    void reloadOverview()
  }, [reloadOverview])

  useEffect(() => {
    if (tab === 'models') void reloadModels()
    if (tab === 'skills') void reloadSkills()
    if (tab === 'logs') void reloadLogs()
  }, [tab, reloadModels, reloadSkills, reloadLogs])

  const refresh = async () => {
    setBusy(true)
    try {
      await reloadOverview()
      if (tab === 'models') await reloadModels()
      if (tab === 'skills') await reloadSkills()
      if (tab === 'logs') await reloadLogs()
    } finally {
      setBusy(false)
    }
  }

  const hint = useMemo(() => t('usage.intro'), [t])

  return (
    <PageShell
      title={t('nav.usage')}
      hint={hint}
      density="reading"
      constrainWidth={false}
      actions={
        <Button type="button" variant="outline" disabled={busy} onClick={() => void refresh()}>
          {t('usage.refresh')}
        </Button>
      }
    >
      {summary ? (
        <div className="grid gap-3 sm:grid-cols-2 mb-4">
          <StatCard
            label={t('usage.period.today')}
            requests={summary.today.requests}
            tokens={summary.today.tokens}
            cost={summary.today.cost}
          />
          <StatCard
            label={t('usage.period.month')}
            requests={summary.month.requests}
            tokens={summary.month.tokens}
            cost={summary.month.cost}
          />
        </div>
      ) : null}

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as CenterTab)}
        className="memory-center-tabs"
      >
        <TabsList variant="line" className="flex flex-wrap h-auto">
          <TabsTrigger value="overview">{t('usage.tab.overview')}</TabsTrigger>
          <TabsTrigger value="models">{t('usage.tab.models')}</TabsTrigger>
          <TabsTrigger value="skills">{t('usage.tab.skills')}</TabsTrigger>
          <TabsTrigger value="logs">{t('usage.tab.logs')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-3">
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant={trendDays === 7 ? 'default' : 'outline'}
              onClick={() => setTrendDays(7)}
            >
              {t('usage.trend.7d')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={trendDays === 30 ? 'default' : 'outline'}
              onClick={() => setTrendDays(30)}
            >
              {t('usage.trend.30d')}
            </Button>
          </div>
          <p className="page-hint">{t('usage.trend.hint')}</p>
          {points.length === 0 ? (
            <p className="page-hint">{t('usage.empty')}</p>
          ) : (
            <TrendBars points={points} />
          )}
        </TabsContent>

        <TabsContent value="models">
          {models.length === 0 ? (
            <p className="page-hint">{t('usage.empty')}</p>
          ) : (
            <ul className="memory-item-list">
              {models.map((m) => (
                <li key={m.model} className={cn('memory-item')}>
                  <div className="memory-item-main">
                    <strong>{m.model}</strong>
                    <p className="page-hint">
                      {t('usage.stat.requests')}: {m.requests} ·{' '}
                      {t('usage.stat.tokens')}: {m.tokens.toLocaleString()} ·{' '}
                      {t('usage.stat.cost')}: {m.cost.toFixed(4)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="skills">
          {skills.length === 0 ? (
            <p className="page-hint">{t('usage.empty')}</p>
          ) : (
            <ul className="memory-item-list">
              {skills.map((s) => (
                <li key={s.skill_name} className="memory-item">
                  <div className="memory-item-main">
                    <strong>{s.skill_name}</strong>
                    <p className="page-hint">
                      {t('usage.stat.requests')}: {s.requests} ·{' '}
                      {formatWhen(s.last_used_at)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="logs" className="space-y-3">
          <select
            className="memory-select"
            value={logType}
            onChange={(e) => setLogType(e.target.value)}
            aria-label={t('usage.logs.filter')}
          >
            <option value="">{t('usage.logs.allTypes')}</option>
            <option value="chat">chat</option>
            <option value="model">model</option>
            <option value="skill">skill</option>
            <option value="knowledge">knowledge</option>
            <option value="tool">tool</option>
          </select>
          {logs.length === 0 ? (
            <p className="page-hint">{t('usage.empty')}</p>
          ) : (
            <ul className="memory-item-list">
              {logs.map((row) => (
                <li key={row.id} className="memory-item">
                  <div className="memory-item-main">
                    <div className="memory-item-title-row flex flex-wrap gap-2 items-center">
                      <Badge variant="outline">{row.type}</Badge>
                      {row.model ? <span>{row.model}</span> : null}
                      {row.skill_name ? <span>{row.skill_name}</span> : null}
                      {row.tool_name ? <span>{row.tool_name}</span> : null}
                    </div>
                    <p className="page-hint">
                      ↑{row.input_tokens} ↓{row.output_tokens} Σ{row.total_tokens} ·{' '}
                      {formatWhen(row.created_at)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>
    </PageShell>
  )
}
