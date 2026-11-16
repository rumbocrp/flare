import { useState, type ChangeEvent, type FormEvent } from 'react'
import { ArrowRight, FlaskConical, RotateCcw, Save } from 'lucide-react'
import NumberField from '@/components/NumberField'
import PageHeader from '@/components/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useI18n, type Translate } from '@/i18n'
import { availablePairs } from '@/strategy'
import type { PageId, Strategy } from '@/types'

type BotConfigProps = {
  strategy: Strategy
  onSave: (strategy: Strategy) => void
  onNavigate: (page: PageId) => void
}

type FormValues = {
  pair: string
  positionSize: string
  stopLoss: string
  takeProfit: string
  maxDailyRisk: string
}

type FormErrors = Partial<Record<keyof FormValues, string>>

function toFormValues(strategy: Strategy): FormValues {
  return {
    pair: strategy.pair,
    positionSize: String(strategy.positionSize),
    stopLoss: String(strategy.stopLoss),
    takeProfit: String(strategy.takeProfit),
    maxDailyRisk: String(strategy.maxDailyRisk),
  }
}

function toStrategy(values: FormValues): Strategy {
  return {
    pair: values.pair,
    positionSize: Number(values.positionSize),
    stopLoss: Number(values.stopLoss),
    takeProfit: Number(values.takeProfit),
    maxDailyRisk: Number(values.maxDailyRisk),
  }
}

function numberError(
  text: string,
  min: number,
  max: number,
  t: Translate,
): string | undefined {
  const value = Number(text)

  if (text.trim() === '' || Number.isNaN(value)) {
    return t('validation.number')
  }
  if (value < min || value > max) {
    return t('validation.range', { min, max })
  }
  return undefined
}

function validate(values: FormValues, t: Translate): FormErrors {
  return {
    positionSize: numberError(values.positionSize, 0.1, 100, t),
    stopLoss: numberError(values.stopLoss, 0.1, 50, t),
    takeProfit: numberError(values.takeProfit, 0.1, 100, t),
    maxDailyRisk: numberError(values.maxDailyRisk, 0.1, 100, t),
  }
}

function sameValues(a: FormValues, b: FormValues): boolean {
  return (
    a.pair === b.pair &&
    a.positionSize === b.positionSize &&
    a.stopLoss === b.stopLoss &&
    a.takeProfit === b.takeProfit &&
    a.maxDailyRisk === b.maxDailyRisk
  )
}

function BotConfig({ strategy, onSave, onNavigate }: BotConfigProps) {
  const { t } = useI18n()
  const [values, setValues] = useState<FormValues>(toFormValues(strategy))

  const savedValues = toFormValues(strategy)
  const errors = validate(values, t)
  const hasErrors = Object.values(errors).some(
    (message) => message !== undefined,
  )
  const hasChanges = !sameValues(values, savedValues)

  const ratio =
    errors.stopLoss === undefined && errors.takeProfit === undefined
      ? Number(values.takeProfit) / Number(values.stopLoss)
      : null

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const { name, value } = event.target
    setValues((current) => ({ ...current, [name]: value }))
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (hasErrors) return

    const next = toStrategy(values)
    onSave(next)
    setValues(toFormValues(next))
  }

  function handleReset() {
    setValues(savedValues)
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('botConfig.title')}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onNavigate('backtest')}
            >
              <FlaskConical className="size-3.5" />
              <span>{t('botConfig.tryBacktest')}</span>
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => onNavigate('bot-run')}
            >
              <span>{t('botConfig.runBot')}</span>
              <ArrowRight className="size-3.5" />
            </Button>
          </>
        }
      />

      <form onSubmit={handleSubmit} noValidate>
        <Card>
          <CardHeader>
            <CardTitle>{t('botConfig.title')}</CardTitle>
            {ratio !== null && (
              <Badge variant={ratio >= 1.5 ? 'positive' : 'default'}>
                {t('botConfig.riskReward', { ratio: ratio.toFixed(1) })}
              </Badge>
            )}
          </CardHeader>

          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="field-pair">{t('botConfig.pair')}</Label>
              <Select
                value={values.pair}
                onValueChange={(pair) =>
                  setValues((current) => ({ ...current, pair }))
                }
              >
                <SelectTrigger id="field-pair">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availablePairs.map((pair) => (
                    <SelectItem key={pair} value={pair}>
                      {pair}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-[11px] text-[var(--text-subtle)]">
                {t('botConfig.pairHint')}
              </span>
            </div>

            <NumberField
              name="positionSize"
              label={t('botConfig.positionSize')}
              unit="%"
              hint={t('botConfig.positionSizeHint')}
              value={values.positionSize}
              error={errors.positionSize}
              onChange={handleChange}
            />

            <NumberField
              name="stopLoss"
              label={t('botConfig.stopLoss')}
              unit="%"
              hint={t('botConfig.stopLossHint')}
              value={values.stopLoss}
              error={errors.stopLoss}
              onChange={handleChange}
            />

            <NumberField
              name="takeProfit"
              label={t('botConfig.takeProfit')}
              unit="%"
              hint={t('botConfig.takeProfitHint')}
              value={values.takeProfit}
              error={errors.takeProfit}
              onChange={handleChange}
            />

            <NumberField
              name="maxDailyRisk"
              label={t('botConfig.maxDailyRisk')}
              unit="%"
              hint={t('botConfig.maxDailyRiskHint')}
              value={values.maxDailyRisk}
              error={errors.maxDailyRisk}
              onChange={handleChange}
            />
          </CardContent>

          <CardFooter className="justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                variant="default"
                size="sm"
                disabled={hasErrors || !hasChanges}
              >
                <Save className="size-3.5" />
                <span>{t('botConfig.save')}</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleReset}
                disabled={!hasChanges}
              >
                <RotateCcw className="size-3.5" />
                <span>{t('botConfig.reset')}</span>
              </Button>
            </div>

            <Badge variant={hasChanges ? 'warning' : 'positive'}>
              {hasChanges ? t('botConfig.unsaved') : t('botConfig.saved')}
            </Badge>
          </CardFooter>
        </Card>
      </form>
    </div>
  )
}

export default BotConfig
