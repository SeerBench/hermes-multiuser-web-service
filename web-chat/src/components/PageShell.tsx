import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useT } from '../i18n'
import {
  getPanelWidth,
  setPanelWidth,
  toggleExpanded,
  widthClass,
  type LayoutDensity,
  type LayoutWidth,
} from '../layoutWidthStorage'

/** Panel wrapper: density-based column + optional full-bleed. */
export function PageShell({
  title,
  hint,
  actions,
  children,
  className,
  constrainWidth = true,
  density = 'wide',
}: {
  title?: ReactNode
  hint?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  constrainWidth?: boolean
  /** reading / wide share the 960px column; full bleeds. */
  density?: LayoutDensity
}) {
  const t = useT()
  const [width, setWidth] = useState<LayoutWidth>(() => getPanelWidth(density))

  useEffect(() => {
    setWidth(getPanelWidth(density))
  }, [density])

  useEffect(() => {
    setPanelWidth(width)
  }, [width])

  const toggle = () => setWidth((w) => toggleExpanded(density, w))

  return (
    <div
      className={cn(
        'panel-page page-shell',
        constrainWidth && widthClass(width),
        className,
      )}
    >
      {(title || actions || constrainWidth) && (
        <header className="page-shell-header page-shell-header--start">
          <div className="page-shell-heading">
            {title && <h2 className="page-shell-title">{title}</h2>}
            {hint && <p className="page-hint">{hint}</p>}
          </div>
          <div className="page-shell-actions flex flex-wrap items-center gap-2">
            {actions}
            {constrainWidth && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={toggle}
              >
                {width === 'full'
                  ? t('layout.width.standard')
                  : t('layout.width.expand')}
              </Button>
            )}
          </div>
        </header>
      )}
      {children}
    </div>
  )
}
