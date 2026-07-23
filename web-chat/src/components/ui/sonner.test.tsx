import { render, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { toast } from 'sonner'

import { Toaster } from './sonner'

describe('Toaster (shadcn sonner)', () => {
  it('uses top-center position by default', async () => {
    render(<Toaster />)
    toast.success('ok')
    await waitFor(() => {
      const region = document.querySelector('[data-sonner-toaster]')
      expect(region).toBeTruthy()
      expect(region?.getAttribute('data-y-position')).toBe('top')
      expect(region?.getAttribute('data-x-position')).toBe('center')
    })
  })
})
