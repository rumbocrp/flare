import './TradesTable.css'
import { sideLabels } from '../trades'
import { formatDateTime, formatPrice } from '../format'
import type { Signal } from '../types'

type SignalsTableProps = {
  signals: Signal[]
}

function SignalsTable({ signals }: SignalsTableProps) {
  return (
    <div className="table-wrap">
      <table className="trades">
        <thead>
          <tr>
            <th scope="col">Vela (UTC)</th>
            <th scope="col">Lado</th>
            <th scope="col" className="trades__num">
              Precio de referencia
            </th>
            <th scope="col">Motivo</th>
          </tr>
        </thead>

        <tbody>
          {signals.length === 0 && (
            <tr>
              <td colSpan={4} className="trades__empty">
                Esta estrategia no generó señales con estos datos.
              </td>
            </tr>
          )}

          {signals.map((signal) => (
            <tr key={`${signal.index}-${signal.side}`}>
              <td>{formatDateTime(signal.time)}</td>
              <td>
                <span className={`side side--${signal.side}`}>
                  {sideLabels[signal.side]}
                </span>
              </td>
              <td className="trades__num">{formatPrice(signal.price)}</td>
              <td>{signal.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default SignalsTable