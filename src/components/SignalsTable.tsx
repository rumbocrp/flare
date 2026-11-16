import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatDateTime, formatPrice } from '@/format'
import { useI18n, type Translate } from '@/i18n'
import type { Signal, SignalParams } from '@/types'

type SignalsTableProps = {
  signals: Signal[]
  params?: SignalParams
}

function formatReason(
  signal: Signal,
  params: SignalParams | undefined,
  t: Translate,
): string {
  if (!params) return signal.reason

  const key =
    signal.side === 'buy' ? 'signals.crossAbove' : 'signals.crossBelow'
  return t(key, {
    average: params.average.toUpperCase(),
    fast: params.fastPeriod,
    slow: params.slowPeriod,
  })
}

function SignalsTable({ signals, params }: SignalsTableProps) {
  const { locale, t } = useI18n()

  if (signals.length === 0) {
    return (
      <Card className="px-4 py-5 text-center text-xs text-muted-foreground">
        {t('signals.empty')}
      </Card>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('signals.candle')}</TableHead>
          <TableHead>{t('signals.side')}</TableHead>
          <TableHead className="text-right">{t('signals.price')}</TableHead>
          <TableHead>{t('signals.reason')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {signals.map((signal) => (
          <TableRow key={`${signal.time}-${signal.side}`}>
            <TableCell className="text-muted-foreground">
              {formatDateTime(signal.time, locale)}
            </TableCell>
            <TableCell>
              <Badge variant={signal.side === 'buy' ? 'positive' : 'negative'}>
                {signal.side === 'buy' ? t('chart.buy') : t('chart.sell')}
              </Badge>
            </TableCell>
            <TableCell className="text-right">{formatPrice(signal.price)}</TableCell>
            <TableCell className="text-muted-foreground">
              {formatReason(signal, params, t)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export default SignalsTable
