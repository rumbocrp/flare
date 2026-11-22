import { useEffect, useRef, useState } from 'react'
import {
  BarChart3,
  Bot,
  BrainCircuit,
  ChevronRight,
  History,
  LayoutDashboard,
  MoreHorizontal,
  Settings,
  SlidersHorizontal,
  Target,
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
  predictions: Target,
  stats: BarChart3,
  'bot-config': SlidersHorizontal,
  training: BrainCircuit,
  settings: Settings,
}

function AppDock({ activePage, onNavigate }: AppDockProps) {
  const { t } = useI18n()
  const [moreOpen, setMoreOpen] = useState(false)
  const dockWrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = dockWrapRef.current
    if (!el || typeof window === 'undefined') return undefined

    const updateClearance = () => {
      const rect = el.getBoundingClientRect()
      if (rect.height <= 0) return
      const bottomOffset = Math.max(0, window.innerHeight - rect.bottom)
      const clearance = Math.ceil(rect.height + bottomOffset + 4)
      document.documentElement.style.setProperty(
        '--flare-dock-clearance',
        `${clearance}px`,
      )
    }

    updateClearance()
    const observer = new ResizeObserver(updateClearance)
    observer.observe(el)
    window.addEventListener('resize', updateClearance)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateClearance)
    }
  }, [])

  const isOverflowActive = overflowNavItems.some(
    (item) => item.id === activePage,
  )

  function handleSelect(page: PageId) {
    setMoreOpen(false)
    onNavigate(page)
  }

  return (
    <div
      ref={dockWrapRef}
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
              icon={<Icon className="size-[18px] stroke-[1.85]" />}
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
                    'group relative flex size-10 shrink-0 items-center justify-center rounded-xl transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer select-none',
                    isOverflowActive || moreOpen
                      ? 'bg-primary/15 text-primary'
                      : 'bg-transparent text-muted-foreground hover:bg-muted/55 hover:text-foreground',
                  )}
                >
                  <MoreHorizontal
                    className={cn(
                      'size-[18px] stroke-[1.85] transition-transform duration-150 group-hover:-translate-y-0.5',
                      isOverflowActive || moreOpen
                        ? 'text-primary'
                        : 'text-muted-foreground group-hover:text-foreground',
                    )}
                  />
                  <span className="sr-only">{t('nav.more')}</span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      'pointer-events-none absolute bottom-1 h-1 rounded-full transition-all duration-150',
                      isOverflowActive || moreOpen
                        ? 'w-1.5 bg-primary opacity-100'
                        : 'w-1 bg-foreground/45 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
                    )}
                  />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={10}>
              {t('nav.moreOptions')}
            </TooltipContent>
          </Tooltip>

          <PopoverContent
            side="top"
            align="end"
            sideOffset={10}
            className="w-48 p-1.5"
            role="menu"
            aria-label={t('nav.moreOptions')}
          >
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
                      'flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-2 text-left text-xs transition-all duration-150 cursor-pointer',
                      isActive
                        ? 'bg-primary/15 font-semibold text-foreground'
                        : 'text-muted-foreground hover:bg-muted/55 hover:text-foreground',
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
                    <ChevronRight className="size-3 text-muted-foreground/50" />
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
