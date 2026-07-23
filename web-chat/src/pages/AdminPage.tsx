import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import {
  PlatformApiError,
  platform,
  type PlatformUser,
} from '../platformClient'
import { routeHref } from '../routing'

const PAGE_SIZE = 20

export function AdminPage() {
  const t = useT()
  const [users, setUsers] = useState<PlatformUser[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [emailQuery, setEmailQuery] = useState('')
  const [emailFilter, setEmailFilter] = useState('')
  const [stats, setStats] = useState<Record<string, number> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  useEffect(() => {
    platform
      .adminStats()
      .then(setStats)
      .catch((err) => {
        setError(err instanceof PlatformApiError ? err.message : String(err))
      })
  }, [])

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    platform
      .adminUsers({
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        email: emailFilter || undefined,
      })
      .then((data) => {
        if (cancelled) return
        setUsers(data.users)
        setTotal(data.total)
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof PlatformApiError ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [page, emailFilter])

  const applyEmailFilter = () => {
    setPage(1)
    setEmailFilter(emailQuery.trim())
  }

  const setStatus = async (userId: string, status: 'active' | 'disabled') => {
    try {
      await platform.adminPatchUser(userId, status)
      const data = await platform.adminUsers({
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        email: emailFilter || undefined,
      })
      setUsers(data.users)
      setTotal(data.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (error) {
    return <p className="auth-error">{error}</p>
  }

  return (
    <div className="panel-page">
      <div className="admin-header">
        <h2>{t('nav.admin')}</h2>
        <a className="link-btn" href={routeHref('admin-audit')}>
          {t('admin.auditLink')}
        </a>
      </div>
      {stats && (
        <p className="admin-stats">
          {t('admin.stats', {
            users: stats.users,
            files: stats.files,
            chunks: stats.chunks,
          })}
        </p>
      )}
      <div className="admin-toolbar">
        <input
          type="search"
          className="admin-search"
          value={emailQuery}
          placeholder={t('admin.searchPlaceholder')}
          onChange={(e) => setEmailQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyEmailFilter()
          }}
        />
        <button type="button" onClick={applyEmailFilter} disabled={busy}>
          {t('admin.search')}
        </button>
      </div>
      <table className="admin-table">
        <thead>
          <tr>
            <th>{t('admin.email')}</th>
            <th>{t('admin.role')}</th>
            <th>{t('admin.status')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.user_id}>
              <td>{u.email ?? u.user_id}</td>
              <td>{u.role ?? 'user'}</td>
              <td>{u.upstream_status ?? '—'}</td>
              <td>
                <button
                  type="button"
                  onClick={() =>
                    setStatus(
                      u.user_id,
                      u.status === 'disabled' ? 'active' : 'disabled',
                    )
                  }
                >
                  {u.status === 'disabled'
                    ? t('admin.enable')
                    : t('admin.disable')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {users.length === 0 && !busy && (
        <p className="page-hint">{t('admin.empty')}</p>
      )}
      {totalPages > 1 && (
        <div className="admin-pagination">
          <button
            type="button"
            disabled={page <= 1 || busy}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            {t('admin.prev')}
          </button>
          <span>
            {t('admin.page', { page, totalPages, total })}
          </span>
          <button
            type="button"
            disabled={page >= totalPages || busy}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            {t('admin.next')}
          </button>
        </div>
      )}
    </div>
  )
}
