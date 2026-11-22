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
import {
  formatMoney,
  formatPrice,
  formatSignedMoney,
} from '@/format'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { tradePnl } from '@/trades'
import type { Trade } from '@/types'

type TradesTableProps = {
  trades: Trade[]
}

function TradesTable({ trades }: TradesTableProps) {
  const { t } = useI18n()

  if (trades.length === 0) {
    return (
      <Card className="px-4 py-6 text-center text-xs text-muted-foreground">
        {t('table.empty')}
      </Card>
    )
  }

  const totalPnl = trades.reduce((sum, trade) => sum + tradePnl(trade), 0)

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('table.time')}</TableHead>
          <TableHead>{t('table.pair')}</TableHead>
          <TableHead>{t('table.side')}</TableHead>
          <TableHead className="text-right">{t('table.entry')}</TableHead>
          <TableHead className="text-right">{t('table.exit')}</TableHead>
          <TableHead className="text-right">{t('table.size')}</TableHead>
          <TableHead className="text-right">{t('table.result')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {trades.map((trade) => {
          const pnl = tradePnl(trade)
          return (
            <TableRow key={trade.id}>
              <TableCell className="text-muted-foreground">{trade.time}</TableCell>
              <TableCell className="font-semibold text-foreground">{trade.pair}</TableCell>
              <TableCell>
                <Badge variant={trade.side === 'buy' ? 'positive' : 'negative'}>
                  {trade.side === 'buy' ? 'BUY' : 'SELL'}
                </Badge>
              </TableCell>
              <TableCell className="text-right">{formatPrice(trade.entryPrice)}</TableCell>
              <TableCell className="text-right">{formatPrice(trade.exitPrice)}</TableCell>
              <TableCell className="text-right text-muted-foreground">
                {formatMoney(trade.size)}
              </TableCell>
              <TableCell
                className={cn(
                  'text-right font-semibold',
                  pnl > 0
                    ? 'text-[var(--positive)]'
                    : pnl < 0
                      ? 'text-[var(--negative)]'
                      : 'text-foreground',
                )}
              >
                {formatSignedMoney(pnl)}
              </TableCell>
            </TableRow>
          )
        })}
        <TableRow className="bg-muted/35 font-semibold hover:bg-muted/45">
          <TableCell colSpan={6} className="text-right font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
            {t('table.total')}
          </TableCell>
          <TableCell
            className={cn(
              'text-right',
              totalPnl > 0
                ? 'text-[var(--positive)]'
                : totalPnl < 0
                  ? 'text-[var(--negative)]'
                  : 'text-foreground',
            )}
          >
            {formatSignedMoney(totalPnl)}
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  )
}

export default TradesTable
