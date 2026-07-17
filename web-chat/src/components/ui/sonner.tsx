import { useEffect, useState } from 'react'
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

import { getStoredTheme } from '../../themeStorage'

/** Sync Sonner theme with our `themeStorage` (no next-themes). */
function useToasterTheme(): NonNullable<ToasterProps['theme']> {
  const [theme, setTheme] = useState<ToasterProps['theme']>(() =>
    getStoredTheme(),
  )

  useEffect(() => {
    const sync = () => {
      const pref = getStoredTheme()
      if (pref === 'light' || pref === 'dark') {
        setTheme(pref)
        return
      }
      const root = document.documentElement
      if (root.classList.contains('dark')) setTheme('dark')
      else if (root.classList.contains('light')) setTheme('light')
      else setTheme('system')
    }
    sync()
    const obs = new MutationObserver(sync)
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    window.addEventListener('storage', sync)
    return () => {
      obs.disconnect()
      window.removeEventListener('storage', sync)
    }
  }, [])

  return theme ?? 'system'
}

/**
 * Global toast host (shadcn/ui sonner).
 * Default position: top-center — pass `position` to override.
 */
function Toaster({ ...props }: ToasterProps) {
  const theme = useToasterTheme()

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      position="top-center"
      richColors
      closeButton
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton:
            'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton:
            'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
