import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import {
  PlatformApiError,
  platform,
  type AdminAuditEntry,
} from '../platformClient'
import { routeHref } from '../routing'

const PAGE_SIZE = 50

function formatTs(epoch: number): string {
  try {
    return new Date(epoch * 1000).toLocaleString()
  } catch {
    return String(epoch)
  }
}

export function AdminAuditPage() {
  const t = useT()
  const [items, setItems] = useState<AdminAuditEntry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    platform
      .adminAuditLogs({
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      })
      .then((data) => {
        if (cancelled) return
        setItems(data.items)
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
  }, [page])

  if (error) {
    return <p className="auth-error">{error}</p>
  }

  return (
    <div className="panel-page">
      <div className="admin-header">
        <h2>{t('admin.auditTitle')}</h2>
        <a className="link-btn" href={routeHref('admin')}>
          {t('admin.backToUsers')}
        </a>
      </div>
      <p className="page-hint">{t('admin.auditHint')}</p>
      <table className="admin-table">
        <thead>
          <tr>
            <th>{t('admin.auditTime')}</th>
            <th>{t('admin.auditAction')}</th>
            <th>{t('admin.auditActor')}</th>
            <th>{t('admin.auditTarget')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((row) => (
            <tr key={row.id}>
              <td>{formatTs(row.created_at)}</td>
              <td>
                <code>{row.action}</code>
              </td>
              <td>{row.actor_id ?? '—'}</td>
              <td>
                {row.target_type
                  ? `${row.target_type}:${row.target_id ?? ''}`
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length === 0 && !busy && (
        <p className="page-hint">{t('admin.auditEmpty')}</p>
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
          <span>{t('admin.page', { page, totalPages, total })}</span>
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
