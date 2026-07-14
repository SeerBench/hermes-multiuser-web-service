import type { ReactNode } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useT } from '../i18n'
import {
  getPanelWidth,
  setPanelWidth,
  widthClass,
  type LayoutWidth,
} from '../layoutWidthStorage'
import { useEffect, useState } from 'react'

/** Panel wrapper: default max-w-screen-lg, optional full-bleed. */
export function PageShell({
  title,
  hint,
  actions,
  children,
  className,
  constrainWidth = true,
}: {
  title?: ReactNode
  hint?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  /** When true (default), apply lg/full width preference. */
  constrainWidth?: boolean
}) {
  const t = useT()
  const [width, setWidth] = useState<LayoutWidth>(() => getPanelWidth())

  useEffect(() => {
    setPanelWidth(width)
  }, [width])

  const toggle = () => setWidth((w) => (w === 'lg' ? 'full' : 'lg'))

  return (
    <div
      className={cn(
        'panel-page page-shell',
        constrainWidth && widthClass(width),
        className,
      )}
    >
      {(title || actions || constrainWidth) && (
        <header className="page-shell-header">
          <div className="page-shell-heading">
            {title && <h2 className="page-shell-title">{title}</h2>}
            {hint && <p className="page-hint">{hint}</p>}
          </div>
          <div className="page-shell-actions flex items-center gap-2">
            {actions}
            {constrainWidth && (
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                title={
                  width === 'lg'
                    ? t('layout.width.full')
                    : t('layout.width.lg')
                }
                aria-label={
                  width === 'lg'
                    ? t('layout.width.full')
                    : t('layout.width.lg')
                }
                onClick={toggle}
              >
                {width === 'lg' ? (
                  <Maximize2 className="size-4" />
                ) : (
                  <Minimize2 className="size-4" />
                )}
              </Button>
            )}
          </div>
        </header>
      )}
      {children}
    </div>
  )
}
