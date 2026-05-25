import { useCallback, useEffect, useState } from 'react'
import { ApiError, keys, usage as usageApi } from '../api'
import type { ApiKey, Quota } from '../api'

export function SettingsPage() {
  const [keyList, setKeyList] = useState<ApiKey[] | null>(null)
  const [quota, setQuota] = useState<Quota | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newKey, setNewKey] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const reload = useCallback(async () => {
    setError(null)
    try {
      const [k, q] = await Promise.all([keys.list(), usageApi.get()])
      setKeyList(k)
      setQuota(q)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to load settings')
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const createKey = async () => {
    setCreating(true)
    setError(null)
    try {
      const result = await keys.create()
      setNewKey(result.api_key)
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to create key')
    } finally {
      setCreating(false)
    }
  }

  const revoke = async (keyId: string) => {
    if (!confirm('Revoke this key? Existing clients using it will start failing.')) return
    setError(null)
    try {
      await keys.revoke(keyId)
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to revoke key')
    }
  }

  const copyKey = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // ignore — user can select manually
    }
  }

  return (
    <div className="settings-page">
      <section className="settings-block">
        <h2>Usage</h2>
        {quota ? (
          <table className="settings-quota">
            <tbody>
              <tr>
                <th>Limit</th>
                <td>{quota.limit.toLocaleString()} tokens</td>
              </tr>
              <tr>
                <th>Used</th>
                <td>
                  {quota.used.toLocaleString()} (
                  {((quota.used / Math.max(1, quota.limit)) * 100).toFixed(1)}%)
                </td>
              </tr>
              <tr>
                <th>Remaining</th>
                <td>{quota.remaining.toLocaleString()}</td>
              </tr>
              <tr>
                <th>Window started</th>
                <td>{new Date(quota.period_start * 1000).toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p>Loading…</p>
        )}
      </section>

      <section className="settings-block">
        <h2>API Keys</h2>
        <p className="settings-help">
          Keys here authenticate non-browser clients (curl, scripts, OpenAI-compat
          libraries) via the <code>Authorization: Bearer …</code> header. The browser
          itself uses a cookie session and doesn't need a key.
        </p>

        {newKey && (
          <div className="settings-new-key">
            <p>
              <strong>New key — copy it now, we won't show it again.</strong>
            </p>
            <code>{newKey}</code>
            <div className="settings-new-key-actions">
              <button type="button" onClick={() => copyKey(newKey)}>
                Copy
              </button>
              <button type="button" onClick={() => setNewKey(null)}>
                Dismiss
              </button>
            </div>
          </div>
        )}

        <button
          type="button"
          className="settings-primary"
          onClick={createKey}
          disabled={creating}
        >
          {creating ? '…' : 'Create new key'}
        </button>

        {keyList === null ? (
          <p>Loading…</p>
        ) : keyList.length === 0 ? (
          <p>No keys yet.</p>
        ) : (
          <table className="settings-keys">
            <thead>
              <tr>
                <th>Prefix</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keyList.map((k) => (
                <tr key={k.key_id}>
                  <td>
                    <code>{k.key_prefix}…</code>
                  </td>
                  <td>{new Date(k.created_at * 1000).toLocaleDateString()}</td>
                  <td>
                    {k.last_used_at
                      ? new Date(k.last_used_at * 1000).toLocaleDateString()
                      : 'never'}
                  </td>
                  <td>
                    {k.revoked_at ? (
                      <span className="settings-revoked">revoked</span>
                    ) : (
                      'active'
                    )}
                  </td>
                  <td>
                    {!k.revoked_at && (
                      <button
                        type="button"
                        className="settings-danger"
                        onClick={() => revoke(k.key_id)}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {error && <p className="settings-error">{error}</p>}
    </div>
  )
}
