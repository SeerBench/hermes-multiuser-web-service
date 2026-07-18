// Platform control-plane client (`/api/v1/*` on platform-api or nginx).

export type PlatformUser = {
  user_id: string
  email?: string
  nickname?: string | null
  avatar_url?: string | null
  role?: string
  status?: string
  upstream_status?: string
  created_at?: number
  last_seen_at?: number
}

export type AdminUsersPage = {
  users: PlatformUser[]
  total: number
  limit: number
  offset: number
}

export type AdminAuditEntry = {
  id: string
  actor_id?: string | null
  action: string
  target_type?: string | null
  target_id?: string | null
  metadata?: Record<string, unknown>
  created_at: number
}

export type AdminAuditPage = {
  items: AdminAuditEntry[]
  total: number
  limit: number
  offset: number
}

export type Workspace = {
  id: string
  tenant_id: string
  name: string
}

export type MemoryItem = {
  id: string
  user_id: string
  workspace_id: string
  category: string
  content: string
  source: string
  confidence: number
  status: string
  importance: number
  source_ref?: string | null
  raw_excerpt?: string | null
  ai_summary?: string | null
  metadata?: Record<string, unknown>
  created_at?: string | null
  updated_at?: string | null
}

export type MemoryStats = {
  total: number
  pending: number
  last_updated_at?: string | null
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
  storage_key?: string
  origin?: string
  category_id?: string | null
  folder_id?: string | null
  tag_ids?: string[]
  status: string
  error_message?: string | null
  created_at: number
}

export type FileCategory = {
  id: string
  name: string
  sort_order: number
  created_at: number
}

export type FileFolder = {
  id: string
  name: string
  parent_id?: string | null
  created_at: number
  /** Direct files in this folder (not recursive). */
  file_count?: number
}

export type FileTag = {
  id: string
  name: string
  created_at: number
}

export type WorkspaceModels = {
  models: { id: string; owned_by?: string }[]
  preferred_model?: string | null
  favorite_models?: string[]
  default_model?: string
}

export type WorkspacePreferences = {
  preferred_model?: string | null
  favorite_models?: string[]
  default_model?: string
}

export type BillingUsage = {
  name?: string | null
  total_granted?: number | null
  total_used?: number | null
  total_available?: number | null
  unlimited_quota?: boolean
  expires_at?: number
  model_limits_enabled?: boolean
}

export type BillingLogItem = {
  id?: number
  type?: number
  content?: string
  model_name?: string
  quota?: number
  prompt_tokens?: number
  completion_tokens?: number
  created_at?: number
}

export type SkillRow = {
  name: string
  source: string
  description?: string
  category?: string
  enabled?: boolean
  status?: string
  version?: string | null
  type?: string
  updated_at?: string | null
  config?: Record<string, unknown>
}

export type SkillDetail = {
  name: string
  source: string
  category?: string
  description?: string
  path?: string
  content: string
  version?: string | null
  type?: string
  updated_at?: string | null
  enabled?: boolean
  status?: string
  config?: Record<string, unknown>
}

const BASE = '/api/v1'

/** Same-origin content URL (cookie auth) for img / iframe / fetch. */
export function fileContentUrl(workspaceId: string, fileId: string): string {
  return `${BASE}/workspaces/${workspaceId}/files/${fileId}/content`
}

class PlatformApiError extends Error {
  status: number
  detail: unknown
  constructor(message: string, status: number, detail: unknown = message) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

function formatApiDetail(detail: unknown, fallback: string): string {
  if (detail == null) return fallback
  if (typeof detail === 'string') return detail
  if (typeof detail === 'object' && detail !== null && 'message' in detail) {
    const msg = (detail as { message?: unknown }).message
    if (typeof msg === 'string' && msg.trim()) return msg
  }
  try {
    return JSON.stringify(detail)
  } catch {
    return fallback
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
    let rawDetail: unknown = res.statusText
    try {
      const body = await res.json()
      rawDetail = body.detail ?? body.error ?? res.statusText
    } catch {
      // ignore
    }
    throw new PlatformApiError(
      formatApiDetail(rawDetail, res.statusText),
      res.status,
      rawDetail,
    )
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

  patchMe: (patch: {
    nickname?: string
    email?: string
    avatar_url?: string
    clear_avatar?: boolean
  }) =>
    platformRequest<PlatformUser>('/auth/me', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  changePassword: (current_password: string, new_password: string) =>
    platformRequest<{ status: string }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password, new_password }),
    }),

  forgotPassword: (email: string) =>
    platformRequest<{ status: string }>('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  resetPassword: (token: string, new_password: string) =>
    platformRequest<{ status: string }>('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, new_password }),
    }),

  bindKey: (api_key: string) =>
    platformRequest<AuthResponse>('/auth/bind-key', {
      method: 'POST',
      body: JSON.stringify({ api_key }),
    }),

  getBillingUsage: () => platformRequest<BillingUsage>('/billing/usage'),

  getBillingLogs: (limit = 50) =>
    platformRequest<{ items: BillingLogItem[] }>(
      `/billing/logs?limit=${limit}`,
    ),

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

  listMemoryItems: (
    workspaceId: string,
    params?: {
      q?: string
      category?: string
      status?: string
      sort?: 'updated_at' | 'created_at' | 'importance'
    },
  ) => {
    const qs = new URLSearchParams()
    if (params?.q) qs.set('q', params.q)
    if (params?.category) qs.set('category', params.category)
    if (params?.status) qs.set('status', params.status)
    if (params?.sort) qs.set('sort', params.sort)
    const suffix = qs.toString() ? `?${qs}` : ''
    return platformRequest<{ items: MemoryItem[] }>(
      `/workspaces/${workspaceId}/memory/items${suffix}`,
    )
  },

  getMemoryStats: (workspaceId: string) =>
    platformRequest<MemoryStats>(`/workspaces/${workspaceId}/memory/stats`),

  createMemoryItem: (
    workspaceId: string,
    body: {
      category: string
      content: string
      source?: string
      status?: string
      confidence?: number
      importance?: number
      source_ref?: string
      metadata?: Record<string, unknown>
    },
  ) =>
    platformRequest<MemoryItem>(`/workspaces/${workspaceId}/memory/items`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateMemoryItem: (
    workspaceId: string,
    itemId: string,
    body: Partial<{
      content: string
      category: string
      confidence: number
      importance: number
      source_ref: string
      status: string
      metadata: Record<string, unknown>
    }>,
  ) =>
    platformRequest<MemoryItem>(
      `/workspaces/${workspaceId}/memory/items/${itemId}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),

  deleteMemoryItem: (workspaceId: string, itemId: string) =>
    platformRequest<{ status: string }>(
      `/workspaces/${workspaceId}/memory/items/${itemId}`,
      { method: 'DELETE' },
    ),

  approveMemoryItem: (workspaceId: string, itemId: string) =>
    platformRequest<MemoryItem>(
      `/workspaces/${workspaceId}/memory/items/${itemId}/approve`,
      { method: 'POST' },
    ),

  rejectMemoryItem: (workspaceId: string, itemId: string) =>
    platformRequest<MemoryItem>(
      `/workspaces/${workspaceId}/memory/items/${itemId}/reject`,
      { method: 'POST' },
    ),

  migrateMemoryFromFiles: (workspaceId: string) =>
    platformRequest<{ imported: number }>(
      `/workspaces/${workspaceId}/memory/migrate-from-files`,
      { method: 'POST' },
    ),

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

  listFiles: (
    workspaceId: string,
    opts?: {
      sort?: 'created_at' | 'size' | 'name'
      order?: 'asc' | 'desc'
      category_id?: string
      folder_id?: string | null
      kind?: 'image' | 'document'
      tag?: string
    },
  ) => {
    const q = new URLSearchParams()
    if (opts?.sort) q.set('sort', opts.sort)
    if (opts?.order) q.set('order', opts.order)
    if (opts?.category_id) q.set('category_id', opts.category_id)
    if (opts?.folder_id !== undefined) {
      q.set('folder_id', opts.folder_id ?? '')
    }
    if (opts?.kind) q.set('kind', opts.kind)
    if (opts?.tag) q.set('tag', opts.tag)
    const qs = q.toString()
    return platformRequest<PlatformFile[]>(
      `/workspaces/${workspaceId}/files${qs ? `?${qs}` : ''}`,
    )
  },

  uploadFiles: (
    workspaceId: string,
    files: File[],
    ingest = true,
    folderId?: string | null,
  ) => {
    const fd = new FormData()
    for (const f of files) fd.append('files', f, f.name)
    const q = new URLSearchParams()
    if (!ingest) q.set('ingest', 'false')
    if (folderId) q.set('folder_id', folderId)
    const qs = q.toString()
    return platformRequest<PlatformFile[]>(
      `/workspaces/${workspaceId}/files${qs ? `?${qs}` : ''}`,
      { method: 'POST', body: fd },
    )
  },

  patchFile: (
    workspaceId: string,
    fileId: string,
    patch: {
      category_id?: string | null
      folder_id?: string | null
      tag_ids?: string[]
      filename?: string
    },
  ) =>
    platformRequest<PlatformFile>(
      `/workspaces/${workspaceId}/files/${fileId}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),

  ingestFile: (workspaceId: string, fileId: string) =>
    platformRequest<PlatformFile>(
      `/workspaces/${workspaceId}/files/${fileId}/ingest`,
      { method: 'POST' },
    ),

  listFileFolders: (workspaceId: string, parentId?: string | null) => {
    const q = new URLSearchParams()
    if (parentId !== undefined) q.set('parent_id', parentId ?? '')
    const qs = q.toString()
    return platformRequest<FileFolder[]>(
      `/workspaces/${workspaceId}/file-folders${qs ? `?${qs}` : ''}`,
    )
  },

  createFileFolder: (
    workspaceId: string,
    name: string,
    parentId?: string | null,
  ) =>
    platformRequest<FileFolder>(`/workspaces/${workspaceId}/file-folders`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        parent_id: parentId ?? null,
      }),
    }),

  renameFileFolder: (workspaceId: string, folderId: string, name: string) =>
    platformRequest<FileFolder>(
      `/workspaces/${workspaceId}/file-folders/${folderId}`,
      { method: 'PATCH', body: JSON.stringify({ name }) },
    ),

  deleteFileFolder: (
    workspaceId: string,
    folderId: string,
    force = false,
  ) => {
    const q = force ? '?force=true' : ''
    return platformRequest<{
      status: string
      file_count?: number
      folder_count?: number
    }>(`/workspaces/${workspaceId}/file-folders/${folderId}${q}`, {
      method: 'DELETE',
    })
  },

  listFileCategories: (workspaceId: string) =>
    platformRequest<FileCategory[]>(`/workspaces/${workspaceId}/file-categories`),

  createFileCategory: (workspaceId: string, name: string) =>
    platformRequest<FileCategory>(`/workspaces/${workspaceId}/file-categories`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  deleteFileCategory: (workspaceId: string, categoryId: string) =>
    platformRequest<{ status: string }>(
      `/workspaces/${workspaceId}/file-categories/${categoryId}`,
      { method: 'DELETE' },
    ),

  listFileTags: (workspaceId: string) =>
    platformRequest<FileTag[]>(`/workspaces/${workspaceId}/file-tags`),

  createFileTag: (workspaceId: string, name: string) =>
    platformRequest<FileTag>(`/workspaces/${workspaceId}/file-tags`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  deleteFileTag: (workspaceId: string, tagId: string) =>
    platformRequest<{ status: string }>(
      `/workspaces/${workspaceId}/file-tags/${tagId}`,
      { method: 'DELETE' },
    ),

  listModels: (workspaceId: string) =>
    platformRequest<WorkspaceModels>(`/workspaces/${workspaceId}/models`),

  getPreferences: (workspaceId: string) =>
    platformRequest<WorkspacePreferences>(`/workspaces/${workspaceId}/preferences`),

  patchPreferences: (
    workspaceId: string,
    patch: { preferred_model?: string; favorite_models?: string[] },
  ) =>
    platformRequest<WorkspacePreferences>(`/workspaces/${workspaceId}/preferences`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  createSkill: (
    workspaceId: string,
    body: {
      name: string
      skill_md?: string
      category?: string
      description?: string
      workflow?: string
      inputs?: string
      outputs?: string
      type?: string
      version?: string
      config?: Record<string, unknown>
    },
  ) =>
    platformRequest<Record<string, unknown>>(`/workspaces/${workspaceId}/skills`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  enableSkill: (workspaceId: string, skillName: string) =>
    platformRequest<{ name: string; enabled: boolean; status: string }>(
      `/workspaces/${workspaceId}/skills/${encodeURIComponent(skillName)}/enable`,
      { method: 'POST' },
    ),

  disableSkill: (workspaceId: string, skillName: string) =>
    platformRequest<{ name: string; enabled: boolean; status: string }>(
      `/workspaces/${workspaceId}/skills/${encodeURIComponent(skillName)}/disable`,
      { method: 'POST' },
    ),

  replaceSkill: (workspaceId: string, skillName: string, skill_md: string) =>
    platformRequest<Record<string, unknown>>(
      `/workspaces/${workspaceId}/skills/${encodeURIComponent(skillName)}`,
      { method: 'PUT', body: JSON.stringify({ skill_md }) },
    ),

  deleteSkill: (workspaceId: string, skillName: string) =>
    platformRequest<Record<string, unknown>>(
      `/workspaces/${workspaceId}/skills/${encodeURIComponent(skillName)}`,
      { method: 'DELETE' },
    ),

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

  /** Fetch raw file bytes (markdown text, etc.). */
  getFileContent: async (workspaceId: string, fileId: string) => {
    const res = await fetch(fileContentUrl(workspaceId, fileId), {
      credentials: 'include',
    })
    if (!res.ok) {
      throw new PlatformApiError(res.statusText, res.status)
    }
    return res
  },

  adminUsers: (opts: { limit?: number; offset?: number; email?: string } = {}) => {
    const params = new URLSearchParams()
    if (opts.limit != null) params.set('limit', String(opts.limit))
    if (opts.offset != null) params.set('offset', String(opts.offset))
    if (opts.email) params.set('email', opts.email)
    const q = params.toString()
    return platformRequest<AdminUsersPage>(
      `/admin/users${q ? `?${q}` : ''}`,
    )
  },

  adminPatchUser: (userId: string, status: 'active' | 'disabled') =>
    platformRequest<PlatformUser>(`/admin/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  adminAuditLogs: (opts: { limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams()
    if (opts.limit != null) params.set('limit', String(opts.limit))
    if (opts.offset != null) params.set('offset', String(opts.offset))
    const q = params.toString()
    return platformRequest<AdminAuditPage>(
      `/admin/audit${q ? `?${q}` : ''}`,
    )
  },

  adminStats: () =>
    platformRequest<{ users: number; files: number; chunks: number }>(
      '/admin/stats',
    ),

  adminSkills: () =>
    platformRequest<{ name: string; path: string }[]>('/admin/skills'),

  /** Probe whether platform-api is available (does not require auth). */
  healthz: () => platformRequest<{ status: string }>('/healthz'),

  searchKnowledge: (
    workspaceId: string,
    query: string,
    topK = 5,
  ) =>
    platformRequest<{
      results: {
        chunk_id: string
        file_id: string
        filename: string
        score: number
        content?: string
      }[]
    }>(`/workspaces/${workspaceId}/knowledge/search`, {
      method: 'POST',
      body: JSON.stringify({ query, top_k: topK }),
    }),
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
