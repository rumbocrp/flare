import { useState } from 'react'
import MarketSection from '@/components/MarketSection'
import type { DensitySetting, PageId, Strategy } from '@/types'

type ChartTerminalProps = {
  strategy: Strategy
  onSaveStrategy: (next: Strategy) => void
  onNavigate: (page: PageId) => void
  initialPair?: string | null
  previousPage?: PageId | null
  onBack?: () => void
  soundAlerts?: boolean
  density?: DensitySetting
  reducedMotion?: boolean
}

function ChartTerminal({
  strategy,
  onSaveStrategy,
  onNavigate,
  initialPair,
  soundAlerts = false,
  density = 'comfortable',
  reducedMotion = false,
}: ChartTerminalProps) {
  const basePair = initialPair ?? strategy.pair
  const [pairOverride, setPairOverride] = useState<{
    base: string
    value: string
  } | null>(null)
  const selectedPair =
    pairOverride && pairOverride.base === basePair
      ? pairOverride.value
      : basePair
  const setSelectedPair = (next: string) =>
    setPairOverride({ base: basePair, value: next })

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <MarketSection
        strategy={strategy}
        onSaveStrategy={onSaveStrategy}
        onNavigate={onNavigate}
        isFullTerminal={true}
        selectedPair={selectedPair}
        onSelectPair={(nextPair) => {
          setSelectedPair(nextPair)
          onSaveStrategy({ ...strategy, pair: nextPair })
        }}
        soundAlerts={soundAlerts}
        density={density}
        reducedMotion={reducedMotion}
      />
    </div>
  )
}

export default ChartTerminal
