import { useEffect, useState, type ReactNode } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { subscribeViewport } from '@/lib/breakpoints'
import { cn } from '@/lib/utils'

/** PC: side-by-side columns; mobile: tabbed edit/preview. */
export function SplitPane({
  left,
  right,
  leftLabel,
  rightLabel,
  className,
}: {
  left: ReactNode
  right: ReactNode
  leftLabel: string
  rightLabel: string
  className?: string
}) {
  const [mobile, setMobile] = useState(false)

  useEffect(() => subscribeViewport(setMobile), [])

  if (mobile) {
    return (
      <Tabs defaultValue="left" className={cn('split-pane split-pane--tabs', className)}>
        <TabsList className="w-full">
          <TabsTrigger value="left" className="flex-1">
            {leftLabel}
          </TabsTrigger>
          <TabsTrigger value="right" className="flex-1">
            {rightLabel}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="left">{left}</TabsContent>
        <TabsContent value="right">{right}</TabsContent>
      </Tabs>
    )
  }

  return (
    <div className={cn('split-pane split-pane--columns', className)}>
      <div className="split-pane-col">{left}</div>
      <div className="split-pane-col">{right}</div>
    </div>
  )
}
