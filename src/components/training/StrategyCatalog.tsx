import { memo, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Search, Sparkles } from 'lucide-react'
import type { StrategyAuditRecord } from '@/api/botClient'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useI18n, type TranslationKey } from '@/i18n'
import { cn } from '@/lib/utils'
import { STRATEGY_FAMILIES } from '@/training/strategyRegistry'
import type {
  StrategyFamily,
  TrainingCatalogItem,
  TrainingRunRecord,
  TrainingVerdict,
} from '@/training/types'

type StrategyCatalogProps = {
  catalog: readonly TrainingCatalogItem[]
  selectedId: string
  onSelect: (id: string) => void
  runs: readonly TrainingRunRecord[]
  audits: readonly StrategyAuditRecord[]
  collapsed: boolean
  onToggleCollapse: () => void
}

const FAMILY_LABEL_KEYS: Record<StrategyFamily, TranslationKey> = {
  'trend-momentum': 'training.familyTrend',
  'mean-reversion': 'training.familyMeanReversion',
  'support-resistance': 'training.familySupportResistance',
  'break-of-structure': 'training.familyBreakOfStructure',
  'donchian-breakout': 'training.familyDonchian',
  'prediction-market': 'training.familyPrediction',
}

function verdictVariant(
  verdict: TrainingVerdict,
): 'positive' | 'warning' | 'negative' | 'violet' {
  if (verdict === 'eligible') return 'positive'
  if (verdict === 'override') return 'violet'
  if (verdict === 'insufficient') return 'warning'
  return 'negative'
}

function verdictLabelKey(verdict: TrainingVerdict): TranslationKey {
  if (verdict === 'eligible') return 'training.verdictEligible'
  if (verdict === 'override') return 'training.verdictOverride'
  if (verdict === 'insufficient') return 'training.verdictInsufficient'
  return 'training.verdictBelow'
}

function StrategyCatalogInner({
  catalog,
  selectedId,
  onSelect,
  runs,
  audits,
  collapsed,
  onToggleCollapse,
}: StrategyCatalogProps) {
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const [familyFilter, setFamilyFilter] = useState<StrategyFamily | 'all'>('all')

  const latestRunByPreset = useMemo(() => {
    const map = new Map<string, TrainingRunRecord>()
    for (const run of runs) {
      if (!map.has(run.presetId)) {
        map.set(run.presetId, run)
      }
    }
    return map
  }, [runs])

  const latestAuditByPreset = useMemo(() => {
    const map = new Map<string, StrategyAuditRecord>()
    for (const audit of audits) {
      if (!map.has(audit.presetId)) {
        map.set(audit.presetId, audit)
      }
    }
    return map
  }, [audits])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return catalog.filter((item) => {
      if (familyFilter !== 'all' && item.family !== familyFilter) return false
      if (!q) return true
      return (
        item.preset.name.toLowerCase().includes(q) ||
        item.preset.id.toLowerCase().includes(q) ||
        item.preset.strategy.pair.toLowerCase().includes(q) ||
        item.preset.timeframe.toLowerCase().includes(q)
      )
    })
  }, [catalog, familyFilter, search])

  const grouped = useMemo(() => {
    return STRATEGY_FAMILIES.map((fam) => ({
      family: fam.id,
      items: filtered.filter((item) => item.family === fam.id),
    })).filter((g) => g.items.length > 0)
  }, [filtered])

  const renderBadge = (item: TrainingCatalogItem) => {
    const latestRun = latestRunByPreset.get(item.presetId)
    if (latestRun?.metrics?.verdict) {
      return (
        <Badge variant={verdictVariant(latestRun.metrics.verdict)}>
          {t(verdictLabelKey(latestRun.metrics.verdict))}
        </Badge>
      )
    }
    if (latestRun) {
      const statusVariant =
        latestRun.status === 'running'
          ? 'default'
          : latestRun.status === 'failed'
            ? 'negative'
            : 'secondary'
      return <Badge variant={statusVariant}>{latestRun.status}</Badge>
    }
    const audit = latestAuditByPreset.get(item.presetId)
    if (audit) {
      return (
        <Badge variant="outline">
          {t('training.auditBadge', {
            wr: audit.metrics.winRatePct.toFixed(0),
          })}
        </Badge>
      )
    }
    return <Badge variant="secondary">{t('training.noRunShort')}</Badge>
  }

  return (
    <aside
      aria-label={t('training.catalogTitle')}
      className="flex flex-col gap-2.5"
    >
      {/* Mobile / narrow (< xl) Select picker */}
      <div className="rounded-md bg-card p-3 xl:hidden">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold text-foreground">
            {t('training.catalogTitle')}
          </h2>
          <span className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
            {catalog.length}
          </span>
        </div>
        <Select value={selectedId} onValueChange={onSelect}>
          <SelectTrigger
            className="w-full"
            aria-label={t('training.selectStrategyAria')}
          >
            <SelectValue placeholder={t('training.selectStrategyAria')} />
          </SelectTrigger>
          <SelectContent>
            {STRATEGY_FAMILIES.map((fam) => {
              const items = catalog.filter((i) => i.family === fam.id)
              if (items.length === 0) return null
              return (
                <SelectGroup key={fam.id}>
                  <SelectLabel>{t(FAMILY_LABEL_KEYS[fam.id])}</SelectLabel>
                  {items.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.preset.name} · {item.preset.strategy.pair}{' '}
                      {item.preset.timeframe}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )
            })}
          </SelectContent>
        </Select>
      </div>

      {/* Desktop (xl+) collapsible sidebar catalog */}
      <div className="hidden rounded-md bg-card xl:flex xl:flex-col">
        <div className="flex items-center justify-between gap-2 px-3.5 py-3">
          <h2 className="text-xs font-semibold text-foreground">
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-expanded={!collapsed}
              className="flex items-center gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm cursor-pointer"
            >
              {collapsed ? (
                <ChevronRight className="size-3.5 text-muted-foreground" />
              ) : (
                <ChevronDown className="size-3.5 text-muted-foreground" />
              )}
              <span>{t('training.catalogTitle')}</span>
            </button>
          </h2>
          <span className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
            {filtered.length}/{catalog.length}
          </span>
        </div>

        {!collapsed && (
          <div className="flex flex-col gap-2.5 px-3 pb-3">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--text-subtle)]"
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('training.catalogSearchPlaceholder')}
                aria-label={t('training.catalogSearchPlaceholder')}
                className="h-8 pl-8 text-xs"
              />
            </div>

            <div
              className="flex flex-wrap gap-1"
              role="group"
              aria-label={t('training.familyFilterAria')}
            >
              <Button
                type="button"
                size="sm"
                variant={familyFilter === 'all' ? 'default' : 'ghost'}
                className="h-6 px-2 text-[11px]"
                onClick={() => setFamilyFilter('all')}
              >
                {t('training.familyAll')}
              </Button>
              {STRATEGY_FAMILIES.map((fam) => (
                <Button
                  key={fam.id}
                  type="button"
                  size="sm"
                  variant={familyFilter === fam.id ? 'default' : 'ghost'}
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setFamilyFilter(fam.id)}
                >
                  {t(FAMILY_LABEL_KEYS[fam.id])}
                </Button>
              ))}
            </div>

            {grouped.length === 0 ? (
              <p className="py-6 text-center text-xs text-[var(--text-subtle)]">
                {t('training.catalogEmptySearch')}
              </p>
            ) : (
              <div className="flex max-h-[620px] flex-col gap-3 overflow-y-auto pr-0.5">
                {grouped.map((group) => (
                  <div key={group.family} className="flex flex-col gap-1">
                    <h3 className="px-1 text-[11px] font-semibold text-[var(--text-subtle)]">
                      {t(FAMILY_LABEL_KEYS[group.family])}
                    </h3>
                    <div className="flex flex-col gap-1">
                      {group.items.map((item) => {
                        const isSelected = item.id === selectedId
                        return (
                          <button
                            key={item.id}
                            type="button"
                            aria-current={isSelected ? 'true' : undefined}
                            onClick={() => onSelect(item.id)}
                            className={cn(
                              'flex w-full flex-col gap-1 rounded-sm px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer',
                              isSelected
                                ? 'bg-primary/14 text-foreground'
                                : 'bg-muted/20 text-foreground hover:bg-muted/45',
                            )}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="line-clamp-1 text-xs font-semibold leading-snug">
                                {item.preset.name}
                              </span>
                              {renderBadge(item)}
                            </div>
                            <div className="flex flex-wrap items-center justify-between gap-1.5 font-mono text-[10.5px] text-[var(--text-subtle)] tabular-nums">
                              <span>
                                {item.preset.strategy.pair} ·{' '}
                                {item.preset.timeframe}
                              </span>
                              {item.kind === 'engine-template' && (
                                <span className="inline-flex items-center gap-0.5 text-primary">
                                  <Sparkles className="size-2.5" />
                                  {t('training.kindTemplate')}
                                </span>
                              )}
                              {item.kind === 'custom-profile' && (
                                <span className="text-[var(--brand-violet)]">
                                  {t('training.kindCustom')}
                                </span>
                              )}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}

const StrategyCatalog = memo(StrategyCatalogInner)
export default StrategyCatalog
