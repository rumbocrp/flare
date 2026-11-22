import { ArrowLeft, Flame } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { getNavLabelKey } from '@/navItems'
import type { PageId } from '@/types'

type AppTopBarProps = {
  activePage: PageId
  previousPage: PageId | null
  onBack: () => void
}

function AppTopBar({ activePage, previousPage, onBack }: AppTopBarProps) {
  const { t } = useI18n()
  const isTerminal = activePage === 'terminal'

  return (
    <header
      className={cn(
        'sticky top-0 z-40 h-11 w-full shrink-0',
        isTerminal
          ? 'bg-background'
          : 'bg-[var(--surface-glass)] backdrop-blur-xl',
      )}
    >
      <div
        className={cn(
          'mx-auto flex h-full items-center justify-between gap-3',
          isTerminal ? 'max-w-none px-3' : 'max-w-[1360px] px-3.5 sm:px-5',
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          {previousPage && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onBack}
              aria-label={t('nav.backTo', {
                page: t(getNavLabelKey(previousPage)),
              })}
              className="gap-1 px-2 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
              <span className="max-w-[140px] truncate">
                {t(getNavLabelKey(previousPage))}
              </span>
            </Button>
          )}

          <div className="flex items-center gap-2 select-none">
            <span
              className="flex size-5 items-center justify-center rounded-[5px] bg-primary text-primary-foreground"
              aria-hidden="true"
            >
              <Flame className="size-3.5 fill-current stroke-[2.2]" />
            </span>
            <span className="font-display text-sm font-bold tracking-[0.1em] text-foreground">
              FLARE
            </span>
          </div>

          <span className="text-muted-foreground/45" aria-hidden="true">
            /
          </span>

          <span className="truncate text-xs font-medium text-muted-foreground">
            {t(getNavLabelKey(activePage))}
          </span>
        </div>
      </div>
    </header>
  )
}

export default AppTopBar
