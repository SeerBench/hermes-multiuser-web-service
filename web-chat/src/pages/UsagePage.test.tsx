import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LocaleProvider } from '../i18n'
import { UsagePage } from './UsagePage'

vi.mock('../platformClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platformClient')>()
  return {
    ...actual,
    platform: {
      ...actual.platform,
      getUsageSummary: vi.fn(),
      getUsageTrend: vi.fn(),
      getUsageByModel: vi.fn(),
      getUsageBySkill: vi.fn(),
      getUsageLogs: vi.fn(),
    },
  }
})

import { platform } from '../platformClient'

describe('Usage Center', () => {
  beforeEach(() => {
    localStorage.setItem('hermes-locale', 'en')
    vi.mocked(platform.getUsageSummary).mockResolvedValue({
      today: { requests: 2, tokens: 100, cost: 0 },
      month: { requests: 10, tokens: 500, cost: 0 },
    })
    vi.mocked(platform.getUsageTrend).mockResolvedValue({
      days: 7,
      points: [
        { date: '2026-07-17', requests: 1, tokens: 40 },
        { date: '2026-07-18', requests: 1, tokens: 60 },
      ],
    })
    vi.mocked(platform.getUsageByModel).mockResolvedValue({
      days: 30,
      items: [{ model: 'gpt-test', requests: 3, tokens: 90, cost: 0 }],
    })
    vi.mocked(platform.getUsageBySkill).mockResolvedValue({
      days: 30,
      items: [],
    })
    vi.mocked(platform.getUsageLogs).mockResolvedValue({
      total: 2,
      limit: 50,
      offset: 0,
      items: [
        {
          id: 'u1',
          type: 'chat',
          model: 'gpt-test',
          input_tokens: 10,
          output_tokens: 20,
          total_tokens: 30,
          cost: 0,
          created_at: '2026-07-18T00:00:00Z',
        },
        {
          id: 'u2',
          type: 'tool',
          tool_name: 'web_search',
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          cost: 0,
          created_at: '2026-07-18T01:00:00Z',
          metadata: {
            backend: 'brave-free',
            query: 'openai news',
            url_count: 3,
          },
        },
      ],
    })
  })

  it('shows summary cards and trend, then models tab', async () => {
    const user = userEvent.setup()
    render(
      <LocaleProvider>
        <UsagePage />
      </LocaleProvider>,
    )

    expect(
      await screen.findByRole('heading', { name: /usage center/i }),
    ).toBeInTheDocument()

    expect(
      screen.getByRole('button', { name: /back to chat/i }),
    ).toBeInTheDocument()

    await waitFor(() => {
      expect(platform.getUsageSummary).toHaveBeenCalled()
      expect(platform.getUsageTrend).toHaveBeenCalled()
    })
    expect(await screen.findByText(/Tokens:\s*100/i)).toBeInTheDocument()
    expect(screen.getByText(/Tokens:\s*500/i)).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /models/i }))
    expect(await screen.findByText('gpt-test')).toBeInTheDocument()
    expect(platform.getUsageByModel).toHaveBeenCalled()

    await user.click(screen.getByRole('tab', { name: /logs/i }))
    await waitFor(() => {
      expect(platform.getUsageLogs).toHaveBeenCalled()
    })
    expect(await screen.findByText(/Σ30/)).toBeInTheDocument()
    expect(await screen.findByText(/Engine Brave/i)).toBeInTheDocument()
    expect(screen.getByText(/openai news/i)).toBeInTheDocument()
  })
})
