import './TradesTable.css'
import { sideLabels, tradePnl } from '../trades'
import { formatMoney, formatPrice, formatSignedMoney } from '../format'
import type { Trade } from '../types'

type TradesTableProps = {
  trades: Trade[]
}

function pnlClass(pnl: number): string {
  if (pnl > 0) return 'trades__pnl--positive'
  if (pnl < 0) return 'trades__pnl--negative'
  return ''
}

function TradesTable({ trades }: TradesTableProps) {
  const total = trades.reduce((sum, trade) => sum + tradePnl(trade), 0)

  return (
    <div className='table-wrap'>
      <table className='trades'>
        <thead>
          <tr>
            <th scope='col'>Hour</th>
            <th scope='col'>Pair</th>
            <th scope='col'>Side</th>
            <th scope='col' className='trades__num'>Entry</th>
            <th scope='col' className='trades__num'>Exit</th>
            <th scope='col' className='trades__num'>Size</th>
            <th scope='col' className='trades__num'>Result</th>
          </tr>
        </thead>

        <tbody>
          {trades.length === 0 && (
            <tr>
              <td colSpan={7} className='trades__empty'>
                No operations to show.
              </td>
            </tr>
          )}

          {trades.map((trade) => {
            const pnl = tradePnl(trade)

            return (
              <tr key={trade.id}>
                <td>{trade.time}</td>
                <td>{trade.pair}</td>
                <td>
                  <span className={`side side--${trade.side}`}>
                    {sideLabels[trade.side]}
                  </span>
                </td>
                <td className='trades__num'>{formatPrice(trade.entryPrice)}</td>
                <td className='trades__num'>{formatPrice(trade.exitPrice)}</td>
                <td className='trades__num'>{formatMoney(trade.size)}</td>
                <td className={`trades__num ${pnlClass(pnl)}`}>
                  {formatSignedMoney(pnl)}
                </td>
              </tr>
            )
          })}
        </tbody>

        <tfoot>
          <tr>
            <th scope='row' colSpan={6}>Total</th>
            <td className={`trades__num ${pnlClass(total)}`}>
              {formatSignedMoney(total)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

export default TradesTable
