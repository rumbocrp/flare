import { useState } from 'react'
import {
  BarChart3,
  Bot,
  ChevronRight,
  History,
  LayoutDashboard,
  MoreHorizontal,
  Settings,
  SlidersHorizontal,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { Dock, DockItem, DockSeparator } from '@/components/ui/dock'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { overflowNavItems, primaryNavItems } from '@/navItems'
import type { PageId } from '@/types'

type AppDockProps = {
  activePage: PageId
  onNavigate: (page: PageId) => void
}

const PAGE_ICONS: Partial<Record<PageId, LucideIcon>> = {
  dashboard: LayoutDashboard,
  'bot-run': Bot,
  backtest: History,
  predictions: Sparkles,
  stats: BarChart3,
  'bot-config': SlidersHorizontal,
  settings: Settings,
}

/**
 * Floating shadcn command dock with 5 primary destinations and a "More" popover
 * housing secondary configuration routes.
 */
function AppDock({ activePage, onNavigate }: AppDockProps) {
  const { t } = useI18n()
  const [moreOpen, setMoreOpen] = useState(false)

  const isOverflowActive = overflowNavItems.some(
    (item) => item.id === activePage,
  )

  function handleSelect(page: PageId) {
    setMoreOpen(false)
    onNavigate(page)
  }

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-3 z-40 flex justify-center px-2"
      role="region"
      aria-label={t('nav.mainAria')}
    >
      <Dock className="pointer-events-auto" aria-label={t('nav.mainAria')}>
        {primaryNavItems.map((item) => {
          const Icon = PAGE_ICONS[item.id] ?? LayoutDashboard
          const isActive =
            activePage === item.id ||
            (item.id === 'stats' && activePage === 'terminal')
          const label = t(item.labelKey)

          return (
            <DockItem
              key={item.id}
              icon={<Icon className="size-4 stroke-[1.8]" />}
              label={label}
              tooltip={label}
              active={isActive}
              onClick={() => handleSelect(item.id)}
            />
          )
        })}

        <DockSeparator />

        <Popover open={moreOpen} onOpenChange={setMoreOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-slot="dock-more"
                  data-active={isOverflowActive ? 'true' : 'false'}
                  aria-expanded={moreOpen}
                  aria-haspopup="menu"
                  aria-label={t('nav.more')}
                  className={cn(
                    'group relative flex h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md border px-1 transition-all duration-150 outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer select-none sm:flex-none sm:min-w-[62px] sm:px-2.5',
                    isOverflowActive || moreOpen
                      ? 'border-border bg-secondary/90 text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                      : 'border-transparent bg-transparent text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                  )}
                >
                  <MoreHorizontal
                    className={cn(
                      'size-4 stroke-[1.8]',
                      isOverflowActive || moreOpen
                        ? 'text-primary'
                        : 'text-muted-foreground group-hover:text-foreground',
                    )}
                  />
                  <span className="max-w-full truncate font-mono text-[9px] font-medium tracking-[0.02em] sm:text-[9.5px]">
                    {t('nav.more')}
                  </span>
                  {isOverflowActive && (
                    <span
                      aria-hidden="true"
                      className="absolute right-2.5 bottom-0.5 left-2.5 h-[2px] rounded-full bg-primary shadow-[0_0_8px_rgba(240,185,11,0.55)]"
                    />
                  )}
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
              {t('nav.moreOptions')}
            </TooltipContent>
          </Tooltip>

          <PopoverContent
            side="top"
            align="end"
            sideOffset={10}
            className="w-52 p-1"
            role="menu"
            aria-label={t('nav.moreOptions')}
          >
            <div className="px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {t('nav.more')}
            </div>
            <div className="flex flex-col gap-0.5">
              {overflowNavItems.map((item) => {
                const Icon = PAGE_ICONS[item.id] ?? Settings
                const isActive = activePage === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    aria-current={isActive ? 'page' : undefined}
                    onClick={() => handleSelect(item.id)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-sm border px-2.5 py-1.5 text-left text-xs transition-all duration-150 cursor-pointer',
                      isActive
                        ? 'border-border bg-secondary/90 font-semibold text-foreground'
                        : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Icon
                        className={cn(
                          'size-3.5',
                          isActive ? 'text-primary' : 'text-muted-foreground',
                        )}
                      />
                      <span>{t(item.labelKey)}</span>
                    </span>
                    <ChevronRight className="size-3 text-muted-foreground/60" />
                  </button>
                )
              })}
            </div>
          </PopoverContent>
        </Popover>
      </Dock>
    </div>
  )
}

export default AppDock
