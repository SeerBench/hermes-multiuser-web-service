import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { PlatformApiError, platform, type PlatformUser } from '../platformClient'

export function AdminPage() {
  const t = useT()
  const [users, setUsers] = useState<PlatformUser[]>([])
  const [stats, setStats] = useState<Record<string, number> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([platform.adminUsers(), platform.adminStats()])
      .then(([u, s]) => {
        setUsers(u)
        setStats(s)
      })
      .catch((err) => {
        setError(err instanceof PlatformApiError ? err.message : String(err))
      })
  }, [])

  const setStatus = async (userId: string, status: 'active' | 'disabled') => {
    try {
      await fetch(`/api/v1/admin/users/${userId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      setUsers(await platform.adminUsers())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (error) {
    return <p className="auth-error">{error}</p>
  }

  return (
    <div className="panel-page">
      <h2>{t('nav.admin')}</h2>
      {stats && (
        <p className="admin-stats">
          {t('admin.stats', {
            users: stats.users,
            files: stats.files,
            chunks: stats.chunks,
          })}
        </p>
      )}
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
                    setStatus(u.user_id, u.status === 'disabled' ? 'active' : 'disabled')
                  }
                >
                  {u.status === 'disabled' ? t('admin.enable') : t('admin.disable')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
