import { ArrowLeft, Flame } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useI18n } from '@/i18n'
import { getNavLabelKey } from '@/navItems'
import type { PageId } from '@/types'

type AppTopBarProps = {
  activePage: PageId
  previousPage: PageId | null
  onBack: () => void
}

/** Sticky minimal application command header styled like a desktop trading workstation. */
function AppTopBar({ activePage, previousPage, onBack }: AppTopBarProps) {
  const { t } = useI18n()

  return (
    <header className="sticky top-0 z-40 h-11 w-full border-b border-border/80 bg-[var(--surface-glass)] backdrop-blur-xl">
      <div className="mx-auto flex h-full max-w-[1360px] items-center justify-between gap-3 px-3.5 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          {previousPage && (
            <>
              <Button
                type="button"
                variant="outline"
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
              <Separator orientation="vertical" className="h-4" />
            </>
          )}

          <div className="flex items-center gap-2 select-none">
            <span
              className="flex size-5 items-center justify-center rounded-[5px] bg-primary text-primary-foreground shadow-[0_0_12px_rgba(240,185,11,0.28)]"
              aria-hidden="true"
            >
              <Flame className="size-3.5 fill-current stroke-[2.2]" />
            </span>
            <span className="font-display text-sm font-bold tracking-[0.12em] text-foreground">
              FLARE
            </span>
          </div>

          <span className="text-[var(--border-strong)]" aria-hidden="true">
            /
          </span>

          <span className="truncate font-mono text-xs font-medium text-muted-foreground">
            {t(getNavLabelKey(activePage))}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="outline" className="hidden gap-1.5 border-border bg-secondary/65 sm:inline-flex">
            <span className="size-1.5 rounded-full bg-[var(--positive)] shadow-[0_0_6px_var(--positive)]" />
            <span className="text-[10px] tracking-[0.06em] text-muted-foreground">
              SIM TERMINAL
            </span>
          </Badge>
        </div>
      </div>
    </header>
  )
}

export default AppTopBar
