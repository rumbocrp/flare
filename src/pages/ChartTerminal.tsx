import { useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  Sparkles,
  Target,
} from 'lucide-react'
import MarketSection from '@/components/MarketSection'
import PageHeader from '@/components/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { getNavLabelKey } from '@/navItems'
import type { PageId, Strategy } from '@/types'

type ChartTerminalProps = {
  strategy: Strategy
  onSaveStrategy: (next: Strategy) => void
  onNavigate: (page: PageId) => void
  previousPage?: PageId | null
  onBack?: () => void
}

type SpecializedCoinCard = {
  pair: 'BTC/USDT' | 'ETH/USDT' | 'SOL/USDT'
  nameEs: string
  nameEn: string
  spotPreset: string
  winRate: string
  profitFactor: string
  polyRule: string
  polyWr: string
  recommendedSl: number
  recommendedTp: number
}

const SPECIALIZED_COINS: SpecializedCoinCard[] = [
  {
    pair: 'BTC/USDT',
    nameEs: 'Bitcoin · Liquidez Institucional',
    nameEn: 'Bitcoin · Institutional Liquidity',
    spotPreset: 'Preset #2 · EMA 12/26 (15m)',
    winRate: '61.9%',
    profitFactor: '2.09',
    polyRule: 'PM-BTC-15M-UP',
    polyWr: '75.8% (Wilson 65.4%)',
    recommendedSl: 1.8,
    recommendedTp: 3.6,
  },
  {
    pair: 'ETH/USDT',
    nameEs: 'Ethereum · Momentum Estructural',
    nameEn: 'Ethereum · Structural Momentum',
    spotPreset: 'Preset #6 · EMA 12/26 (15m)',
    winRate: '61.9%',
    profitFactor: '2.86',
    polyRule: 'PM-ETH-15M-UP',
    polyWr: '68.8% (Wilson 60.5%)',
    recommendedSl: 2.0,
    recommendedTp: 4.2,
  },
  {
    pair: 'SOL/USDT',
    nameEs: 'Solana · Alta Beta & Expansión ATR',
    nameEn: 'Solana · High Beta & ATR Expansion',
    spotPreset: 'Preset #8 · EMA 5/20 (15m)',
    winRate: '75.0%',
    profitFactor: '4.91',
    polyRule: 'PM-SOL-15M-UP',
    polyWr: '81.0% (Wilson 67.4%)',
    recommendedSl: 2.4,
    recommendedTp: 5.2,
  },
]

function ChartTerminal({
  strategy,
  onSaveStrategy,
  onNavigate,
  previousPage,
  onBack,
}: ChartTerminalProps) {
  const { language, t } = useI18n()
  const isEs = language === 'es'
  const [selectedPair, setSelectedPair] = useState<string>(strategy.pair)

  function handleSelectSpecializedCoin(card: SpecializedCoinCard) {
    setSelectedPair(card.pair)
    onSaveStrategy({
      ...strategy,
      pair: card.pair,
      stopLoss: card.recommendedSl,
      takeProfit: card.recommendedTp,
    })
  }

  const rrRatio = strategy.takeProfit / Math.max(0.1, strategy.stopLoss)

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={isEs ? 'Estudio Gráfico' : 'Chart Studio'}
        badge={selectedPair}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                previousPage && onBack ? onBack() : onNavigate('stats')
              }
            >
              <ArrowLeft className="size-3.5" />
              <span>
                {previousPage
                  ? t('nav.backTo', { page: t(getNavLabelKey(previousPage)) })
                  : t('terminal.backToStats')}
              </span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onNavigate('predictions')}
            >
              <Sparkles className="size-3.5 text-[var(--brand-violet)]" />
              <span>
                {isEs ? '20 Reglas Polymarket' : '20 Polymarket Rules'}
              </span>
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => onNavigate('bot-run')}
            >
              <Bot className="size-3.5" />
              <span>{isEs ? 'Ejecutar Bot' : 'Run Bot'}</span>
              <ArrowRight className="size-3.5" />
            </Button>
          </>
        }
      />

      {/* Primary Interactive Chart Studio above the fold */}
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
      />

      {/* Live Visual Order-Line Calibrator (TP / Profit-Lock / SL) */}
      <Card>
        <CardHeader className="px-3.5 py-2.5">
          <CardTitle>
            {isEs
              ? `Líneas de Orden (${selectedPair})`
              : `Order Lines (${selectedPair})`}
          </CardTitle>
          <Badge variant={rrRatio >= 1.5 ? 'positive' : 'default'}>
            {rrRatio.toFixed(2)}R · Profit-Lock +
            {(strategy.takeProfit * 0.5).toFixed(2)}%
          </Badge>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 p-3.5 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="terminal-tp">
              {isEs
                ? `Take Profit Objetivo (+${strategy.takeProfit.toFixed(1)}%)`
                : `Target Take Profit (+${strategy.takeProfit.toFixed(1)}%)`}
            </Label>
            <Input
              id="terminal-tp"
              type="number"
              step="0.2"
              min="0.4"
              max="25"
              value={strategy.takeProfit}
              onChange={(e) => {
                const val = Number(e.target.value)
                if (Number.isFinite(val) && val > 0) {
                  onSaveStrategy({
                    ...strategy,
                    pair: selectedPair,
                    takeProfit: val,
                  })
                }
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="terminal-sl">
              {isEs
                ? `Stop Loss Protector (-${strategy.stopLoss.toFixed(1)}%)`
                : `Protective Stop Loss (-${strategy.stopLoss.toFixed(1)}%)`}
            </Label>
            <Input
              id="terminal-sl"
              type="number"
              step="0.2"
              min="0.2"
              max="15"
              value={strategy.stopLoss}
              onChange={(e) => {
                const val = Number(e.target.value)
                if (Number.isFinite(val) && val > 0) {
                  onSaveStrategy({
                    ...strategy,
                    pair: selectedPair,
                    stopLoss: val,
                  })
                }
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="terminal-size">
              {isEs
                ? `Tamaño Demo (${strategy.positionSize}% = $${Math.round(10_000 * (strategy.positionSize / 100))})`
                : `Demo Order Size (${strategy.positionSize}% = $${Math.round(10_000 * (strategy.positionSize / 100))})`}
            </Label>
            <Input
              id="terminal-size"
              type="number"
              step="1"
              min="1"
              max="20"
              value={strategy.positionSize}
              onChange={(e) => {
                const val = Number(e.target.value)
                if (Number.isFinite(val) && val >= 1 && val <= 100) {
                  onSaveStrategy({
                    ...strategy,
                    pair: selectedPair,
                    positionSize: val,
                  })
                }
              }}
            />
          </div>
        </CardContent>
      </Card>

      {/* Preset Pair Cards */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-xs font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            {isEs ? 'Pares Preconfigurados' : 'Preset Pairs'}
          </h2>
        </div>

        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-3">
          {SPECIALIZED_COINS.map((coin) => {
            const isSelected = selectedPair === coin.pair
            return (
              <Card
                key={coin.pair}
                className={cn(
                  'cursor-pointer gap-0 transition-all duration-150 hover:border-[var(--border-strong)]',
                  isSelected && 'border-primary/80 bg-secondary/50',
                )}
                onClick={() => handleSelectSpecializedCoin(coin)}
              >
                <CardHeader className="px-3.5 py-2.5">
                  <div className="flex items-center gap-2">
                    <Badge variant={isSelected ? 'default' : 'secondary'}>
                      {coin.pair.replace('/USDT', '')}
                    </Badge>
                    <CardTitle className="text-xs normal-case tracking-normal">
                      {isEs ? coin.nameEs : coin.nameEn}
                    </CardTitle>
                  </div>
                  <Badge variant="positive">{coin.winRate} WR</Badge>
                </CardHeader>

                <CardContent className="flex flex-col gap-2 p-3.5 text-xs">
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums">
                    <div>
                      <span className="text-muted-foreground">Spot: </span>
                      <span className="font-medium text-foreground">
                        {coin.spotPreset}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">PF: </span>
                      <span className="font-semibold text-[var(--positive)]">
                        {coin.profitFactor}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">PM: </span>
                      <span className="font-medium text-[var(--brand-violet)]">
                        {coin.polyRule}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">TP/SL: </span>
                      <span className="font-semibold text-primary">
                        +{coin.recommendedTp}% / -{coin.recommendedSl}%
                      </span>
                    </div>
                  </div>

                  <div className="pt-1">
                    <Button
                      type="button"
                      variant={isSelected ? 'default' : 'outline'}
                      size="xs"
                      className="w-full"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleSelectSpecializedCoin(coin)
                      }}
                    >
                      {isSelected ? (
                        <>
                          <Check className="size-3.5" />
                          <span>
                            {isEs
                              ? `Activo (${coin.pair})`
                              : `Active (${coin.pair})`}
                          </span>
                        </>
                      ) : (
                        <>
                          <Target className="size-3.5" />
                          <span>
                            {isEs
                              ? `Aplicar ${coin.pair}`
                              : `Apply ${coin.pair}`}
                          </span>
                        </>
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </section>
    </div>
  )
}

export default ChartTerminal
