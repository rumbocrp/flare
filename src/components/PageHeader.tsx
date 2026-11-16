import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'

type PageHeaderProps = {
  title: string
  subtitle?: string
  badge?: string
  actions?: ReactNode
}

function PageHeader({ title, badge, actions }: PageHeaderProps) {
  return (
    <header className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
        <h1 className="font-display text-lg font-bold tracking-[-0.02em] text-foreground sm:text-xl">
          {title}
        </h1>
        {badge && <Badge variant="default">{badge}</Badge>}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-1.5">{actions}</div>
      )}
    </header>
  )
}

export default PageHeader
