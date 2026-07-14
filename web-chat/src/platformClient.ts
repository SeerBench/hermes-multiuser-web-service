// Platform control-plane client (`/api/v1/*` on platform-api or nginx).

export type PlatformUser = {
  user_id: string
  email?: string
  role?: string
  status?: string
  upstream_status?: string
  created_at?: number
  last_seen_at?: number
}

export type Workspace = {
  id: string
  tenant_id: string
  name: string
}

export type AuthResponse = {
  user: PlatformUser
  workspace?: Workspace
  upstream_status?: string
  provision_mode?: string
}

export type PlatformFile = {
  id: string
  filename: string
  mime_type?: string
  size_bytes?: number
  status: string
  error_message?: string | null
  created_at: number
}

export type SkillRow = {
  name: string
  source: string
  description?: string
  category?: string
  enabled?: boolean
  config?: Record<string, unknown>
}

export type SkillDetail = {
  name: string
  source: string
  category?: string
  description?: string
  path?: string
  content: string
}

const BASE = '/api/v1'

class PlatformApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function platformRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: isForm
      ? { ...(init.headers ?? {}) }
      : { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = body.detail ?? body.error ?? detail
    } catch {
      // ignore
    }
    throw new PlatformApiError(String(detail), res.status)
  }
  if (res.status === 204) return undefined as T
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('json')) return undefined as T
  return res.json() as Promise<T>
}

const WORKSPACE_KEY = 'hermes_workspace_id'

export function getStoredWorkspaceId(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_KEY)
  } catch {
    return null
  }
}

export function storeWorkspaceId(id: string) {
  try {
    localStorage.setItem(WORKSPACE_KEY, id)
  } catch {
    // ignore
  }
}

export function clearWorkspaceId() {
  try {
    localStorage.removeItem(WORKSPACE_KEY)
  } catch {
    // ignore
  }
}

export const platform = {
  register: (email: string, password: string) =>
    platformRequest<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  login: (email: string, password: string) =>
    platformRequest<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  logout: () =>
    platformRequest<{ status: string }>('/auth/logout', { method: 'POST' }),

  me: () => platformRequest<PlatformUser>('/auth/me'),

  bindKey: (api_key: string) =>
    platformRequest<AuthResponse>('/auth/bind-key', {
      method: 'POST',
      body: JSON.stringify({ api_key }),
    }),

  listWorkspaces: () =>
    platformRequest<Workspace[]>('/workspaces'),

  getMemory: (workspaceId: string) =>
    platformRequest<{ long_term: string; profile: string }>(
      `/workspaces/${workspaceId}/memory`,
    ),

  patchMemory: (
    workspaceId: string,
    patch: { long_term?: string; profile?: string },
  ) =>
    platformRequest<{ status: string }>(`/workspaces/${workspaceId}/memory`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  listSkills: (workspaceId: string) =>
    platformRequest<SkillRow[]>(`/workspaces/${workspaceId}/skills`),

  getSkill: (workspaceId: string, skillName: string) =>
    platformRequest<SkillDetail>(
      `/workspaces/${workspaceId}/skills/${encodeURIComponent(skillName)}`,
    ),

  installSkillFromCatalog: (
    workspaceId: string,
    name: string,
    opts?: { overwrite?: boolean },
  ) =>
    platformRequest<{
      success: boolean
      name: string
      category?: string
      source: string
    }>(`/workspaces/${workspaceId}/skills/install-from-catalog`, {
      method: 'POST',
      body: JSON.stringify({ name, overwrite: opts?.overwrite ?? false }),
    }),

  patchSkill: (
    workspaceId: string,
    skillName: string,
    patch: { enabled?: boolean; config?: Record<string, unknown> },
  ) =>
    platformRequest<Record<string, unknown>>(
      `/workspaces/${workspaceId}/skills/${encodeURIComponent(skillName)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),

  listFiles: (workspaceId: string) =>
    platformRequest<PlatformFile[]>(`/workspaces/${workspaceId}/files`),

  uploadFiles: (workspaceId: string, files: File[]) => {
    const fd = new FormData()
    for (const f of files) fd.append('files', f, f.name)
    return platformRequest<PlatformFile[]>(
      `/workspaces/${workspaceId}/files`,
      { method: 'POST', body: fd },
    )
  },

  deleteFile: (workspaceId: string, fileId: string) =>
    platformRequest<{ status: string }>(
      `/workspaces/${workspaceId}/files/${fileId}`,
      { method: 'DELETE' },
    ),

  /** 单文件 ingestion 状态（用于轮询 pending / processing）。 */
  getFileStatus: (workspaceId: string, fileId: string) =>
    platformRequest<PlatformFile>(
      `/workspaces/${workspaceId}/files/${fileId}/status`,
    ),

  adminUsers: () => platformRequest<PlatformUser[]>('/admin/users'),

  adminStats: () =>
    platformRequest<{ users: number; files: number; chunks: number }>(
      '/admin/stats',
    ),

  adminSkills: () =>
    platformRequest<{ name: string; path: string }[]>('/admin/skills'),

  /** Probe whether platform-api is available (does not require auth). */
  healthz: () => platformRequest<{ status: string }>('/healthz'),
}

export { PlatformApiError }

/** Try platform session; returns null when platform-api is down or no cookie. */
export async function tryPlatformSession(): Promise<{
  user: PlatformUser
  workspaceId: string | null
} | null> {
  try {
    await platform.healthz()
  } catch {
    return null
  }
  try {
    const user = await platform.me()
    let workspaceId = getStoredWorkspaceId()
    if (!workspaceId) {
      const workspaces = await platform.listWorkspaces()
      if (workspaces[0]?.id) {
        workspaceId = workspaces[0].id
        storeWorkspaceId(workspaceId)
      }
    }
    return { user, workspaceId }
  } catch {
    return null
  }
}
