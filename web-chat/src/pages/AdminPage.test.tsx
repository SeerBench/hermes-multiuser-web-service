import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

import { AdminPage } from './AdminPage'

const adminUsers = vi.fn()
const adminStats = vi.fn()
const adminPatchUser = vi.fn()

vi.mock('../platformClient', () => ({
  PlatformApiError: class PlatformApiError extends Error {
    status: number
    constructor(message: string, status = 500) {
      super(message)
      this.status = status
    }
  },
  platform: {
    adminUsers: (...args: unknown[]) => adminUsers(...args),
    adminStats: (...args: unknown[]) => adminStats(...args),
    adminPatchUser: (...args: unknown[]) => adminPatchUser(...args),
  },
}))

vi.mock('../i18n', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => {
    if (!vars) return key
    return `${key}:${JSON.stringify(vars)}`
  },
}))

describe('AdminPage', () => {
  beforeEach(() => {
    adminUsers.mockReset()
    adminStats.mockReset()
    adminPatchUser.mockReset()
    adminStats.mockResolvedValue({ users: 2, files: 0, chunks: 0 })
    adminUsers.mockResolvedValue({
      users: [
        {
          user_id: 'u1',
          email: 'alice@example.com',
          role: 'user',
          status: 'active',
          upstream_status: 'ready',
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    })
  })

  it('loads paginated users and searches by email', async () => {
    render(<AdminPage />)
    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeInTheDocument()
    })
    expect(adminUsers).toHaveBeenCalledWith({
      limit: 20,
      offset: 0,
      email: undefined,
    })

    fireEvent.change(screen.getByPlaceholderText('admin.searchPlaceholder'), {
      target: { value: 'alice@' },
    })
    fireEvent.click(screen.getByText('admin.search'))

    await waitFor(() => {
      expect(adminUsers).toHaveBeenLastCalledWith({
        limit: 20,
        offset: 0,
        email: 'alice@',
      })
    })
    expect(screen.getByText('admin.auditLink')).toBeInTheDocument()
  })
})
