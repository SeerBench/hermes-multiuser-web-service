import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ActivityLog } from './ActivityLog'
import { LocaleProvider } from '../i18n'

describe('ActivityLog', () => {
  it('prefers Brave status in collapsed summary when done', () => {
    render(
      <LocaleProvider>
        <ActivityLog
          streaming={false}
          items={[
            { kind: 'step', step: 1, tools: ['web_search'], ts: 1 },
            {
              kind: 'status',
              text: '使用 Brave 搜索，Brave 用量还剩 1 次',
              ts: 2,
            },
            { kind: 'step', step: 2, tools: [], ts: 3 },
          ]}
        />
      </LocaleProvider>,
    )
    expect(
      screen.getByRole('button', {
        name: /使用 Brave 搜索，Brave 用量还剩 1 次/,
      }),
    ).toBeTruthy()
  })
})
