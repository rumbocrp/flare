# FLARE — Guía completa de la Parte 11: Motor de backtest

> **Estado:** documento de planificación e implementación.  
> **No se ha modificado ningún archivo de código existente.**  
> **Objetivo:** que puedas implementar la Parte 11 de principio a fin siguiendo esta guía, sin tener que improvisar decisiones delicadas.

---

## 0. Resumen ejecutivo

La Parte 11 consiste en construir un **motor de backtest determinista**, separado de React, que simule una estrategia de cruce de medias **vela por vela**, con:

- comisiones por lado,
- deslizamiento (slippage) opcional,
- stop loss y take profit,
- tamaño de posición,
- límite de riesgo diario,
- cierre de posición al final de los datos,
- curva de capital,
- métricas de rendimiento,
- pantalla de configuración,
- pantalla de resultados,
- conexión con la pantalla de Estadísticas,
- pruebas automáticas del motor.

La pieza central es `src/backtest.ts`: una función pura que recibe velas y configuración, y devuelve operaciones, curva de capital y métricas. La UI solo configura y muestra; **no debe contener lógica de simulación**.

### Definición de “hecho” (Definition of Done)

La Parte 11 está terminada cuando:

- [ ] `src/backtest.ts` existe y no importa React ni toca el DOM.
- [ ] La entrada se ejecuta en la **apertura de la vela siguiente** a la señal, nunca en el cierre de la vela que generó la señal.
- [ ] Stop loss y take profit se evalúan con el máximo/mínimo de cada vela.
- [ ] Si en una misma vela se tocan stop y objetivo, se aplica primero el stop (criterio conservador).
- [ ] Las comisiones se cobran en entrada y en salida.
- [ ] El slippage siempre es adverso: compras pagan más, ventas reciben menos.
- [ ] El riesgo diario bloquea nuevas entradas cuando se alcanza el límite.
- [ ] La posición abierta al final se cierra con el último cierre.
- [ ] Hay pantalla de configuración con datos, señal, riesgo y ejecución.
- [ ] Hay pantalla de resultados con métricas, curva, operaciones y motivos de salida.
- [ ] El último backtest se guarda y Estadísticas puede mostrar sus operaciones.
- [ ] `npm test`, `npm run build` y `npm run lint` pasan.
- [ ] Los casos manuales de la sección 10 dan resultados coherentes.

---

## 1. Revisión del estado actual del proyecto

### 1.1 Qué existe ya

| Área | Archivo | Estado |
|---|---|---|
| Navegación por estado | `src/App.tsx`, `src/navItems.ts` | Funciona, sin router |
| Tipos base | `src/types.ts` | `Trade`, `Candle`, `Signal`, `Strategy`, etc. |
| Estrategia | `src/strategy.ts` | Par, tamaño, SL, TP, riesgo diario |
| Señales | `src/signals.ts` | Cruce de medias SMA/EMA, confirmado al cierre |
| Indicadores | `src/indicators.ts` | SMA, EMA, RSI |
| Datos de mercado | `src/market/binance.ts` | API pública de Binance |
| Datos sintéticos | `src/market/synthetic.ts` | Generador determinista, no usado por la UI |
| Métricas | `src/metrics.ts` | Win rate, profit factor, drawdown, etc. |
| Operaciones de ejemplo | `src/trades.ts` | 12 trades estáticos |
| Estadísticas | `src/pages/Stats.tsx` | Usa los trades de ejemplo |
| Gráficos | `src/components/EquityChart.tsx`, `CandleChart.tsx` | SVG propios |
| Persistencia | `src/hooks/useLocalStorageState.ts` | localStorage con validador |

### 1.2 Qué falta para la Parte 11

- No existe `src/backtest.ts`.
- No existen pruebas del motor.
- `vitest` no está instalado, aunque `package.json` ya tiene `"test": "vitest run"`.
- `Trade` no tiene comisión, PnL neto ni motivo de salida.
- `tradePnl()` calcula solo con `entryPrice`, `exitPrice` y `size`; no contempla comisiones.
- `computeMetrics()` y `computeEquityPoints()` asumen un balance inicial fijo de 10 000.
- Estadísticas siempre usa `trades` de ejemplo.
- No hay pantalla de backtest.
- No hay forma de guardar el resultado de un backtest.

### 1.3 Hallazgos y deudas que conviene conocer

Estos puntos no bloquean la Parte 11, pero afectan a la calidad:

1. **`src/strategy.ts` tiene un typo** en `isStrategy`:
   ```ts
   if (typeof value !== 'object' || 'value' === null) return false
   ```
   Debería ser `value === null`. Con `null` guardado, el validador puede lanzar un `TypeError` en lugar de devolver `false`.
2. **`Interval` incluye `'5m'`**, pero `src/market/intervals.ts` y `synthetic.ts` no tienen `'5m'`. Si se usa, los tiempos salen `NaN`. La UI de backtest no debe ofrecer `5m` hasta corregirlo.
3. **`src/market/index.ts` solo exporta Binance.** Si la API falla por CORS, región o red, el backtest no puede ejecutarse. Los tests del motor no dependen de red, pero la QA manual sí.
4. **No hay router.** Al recargar, la app vuelve al Panel. El backtest guardado en localStorage seguirá disponible para Estadísticas, pero la página no se restaura.
5. **Marca inconsistente:** el proyecto se llama `lixtrd`, la UI muestra `LIXTRD` y el Panel muestra `FLARE`.
6. **`README.md` es genérico** de la plantilla de Vite.
7. **No hay repositorio git** en `/public/flare`; haz una copia o inicializa git antes de tocar código.

### 1.4 Archivos que se van a tocar

**Nuevos:**

- `src/backtest.ts`
- `src/backtest.test.ts`
- `src/pages/Backtest.tsx`
- `src/pages/Backtest.css`

**Modificados mínimamente:**

- `src/types.ts` → `PageId`, campos opcionales en `Trade`, `ExitReason`.
- `src/trades.ts` → `tradePnl()` respeta `trade.pnl`.
- `src/metrics.ts` → balance inicial configurable.
- `src/navItems.ts` → nueva entrada.
- `src/App.tsx` → página y persistencia del último backtest.
- `src/pages/Stats.tsx` → fuente de datos backtest/ejemplo.
- `src/components/TradesTable.tsx` → PnL neto, fecha y motivo de salida.
- `package.json` → dependencia `vitest` (instalada con el gestor de paquetes).

---

## 2. Decisiones de diseño del motor

Estas decisiones son las que evitan los “errores sutiles” típicos de un backtest.

### 2.1 Señal al cierre, entrada en la apertura siguiente

`crossoverSignals()` confirma el cruce con el cierre de la vela `i`. Si entras al precio de cierre de `i`, estás usando información que solo conoces al final de esa vela. En la práctica no puedes comprar “al cierre” después de verlo.

**Regla:** la señal de la vela `i` se ejecuta en el `open` de la vela `i + 1`.

Consecuencias:

- La última vela no puede abrir operación; su señal se descarta y se cuenta como `skippedSignals`.
- La posición se abre en `i + 1` y **esa misma vela** ya puede tocar SL o TP.
- No se usa ningún dato futuro.

### 2.2 Una sola posición a la vez

- `allowShort = false` (modo spot): una señal BUY abre largo; una señal SELL cierra el largo y deja el bot plano.
- `allowShort = true` (modo futuros/demo): una señal SELL abre corto; una señal opuesta cierra y abre en la dirección contraria.

No hay pirámide, no hay varias posiciones simultáneas, no hay órdenes pendientes.

### 2.3 Stop loss y take profit con máximo/mínimo

Para un largo:

- Stop: `entry * (1 - stopLossPct / 100)`.
- Objetivo: `entry * (1 + takeProfitPct / 100)`.

Para un corto:

- Stop: `entry * (1 + stopLossPct / 100)`.
- Objetivo: `entry * (1 - takeProfitPct / 100)`.

Evaluación dentro de la vela:

1. Si la **apertura** ya supera el stop o el objetivo (hueco), se ejecuta a la apertura, que es peor.
2. Si no, se mira el mínimo (largo) o máximo (corto) para el stop.
3. Si en la misma vela se tocan ambos, **se aplica el stop primero**. Es conservador y evita backtests optimistas.

### 2.4 Comisiones por lado

`commissionPct` se cobra sobre el nocional de entrada y sobre el nocional de salida.

Ejemplo: comisión `0.1` significa 0,1 % por lado.

- Entrada: `feeEntrada = notionalEntrada * commissionPct / 100`.
- Salida: `feeSalida = (exitPrice * quantity) * commissionPct / 100`.
- PnL neto: `grossPnl - feeEntrada - feeSalida`.

Si tu exchange cobra 0,1 % por operación completa (ida y vuelta), entonces el valor por lado sería 0,05 %. La UI debe explicar que el campo es **por lado**.

### 2.5 Slippage adverso

`slip` siempre juega en contra:

- Compra: `precio * (1 + slip/100)`.
- Venta: `precio * (1 - slip/100)`.

Se aplica tanto en entrada como en salida. No modela mejora de precio.

### 2.6 Tamaño de posición sin apalancamiento

`notional = min(balance, balance * positionSizePct / 100)`.

- `positionSize = 100` usa todo el balance como nocional.
- No se permite nocional mayor que el balance; si más adelante quieres apalancamiento, se añade explícitamente.
- `quantity = notional / entryPrice`.

### 2.7 Riesgo diario

- Se calcula por día UTC: `Math.floor(time / 86_400_000)`.
- Al empezar un nuevo día: `dayStartBalance = balance` y `dayHalted = false`.
- Después de cerrar una operación:
  ```text
  perdidaDiariaPct = (dayStartBalance - balance) / dayStartBalance * 100
  ```
- Si `perdidaDiariaPct >= maxDailyRiskPct`, se activa `dayHalted` y **no se abren nuevas entradas** hasta el día siguiente.
- Una posición ya abierta no se cierra por el límite diario; su stop loss sigue protegiendo.
- El límite usa balance realizado, no PnL flotante. Documentarlo así.

### 2.8 Curva de capital

- Punto inicial: primer timestamp de las velas, con `initialBalance`.
- Un punto por cada operación cerrada, con el balance realizado después de comisiones.
- No hay mark-to-market intravela.
- Si queda una posición abierta al final, se cierra al último cierre y se añade su punto.

### 2.9 Métricas

Se reutiliza `computeMetrics()` y `computeEquityPoints()` con un **balance inicial configurable**. Así Estadísticas y Backtest comparten la misma lógica.

### 2.10 Redondeo

- Se redondea a 2 decimales el dinero: PnL, fees, balance, balance final.
- Los precios y cantidades se mantienen con precisión completa hasta el cálculo.
- No redondear el balance en cada vela intermedia más de lo necesario; un punto por trade es suficiente.

---

## 3. Fórmulas de referencia

```text
direction      = +1 si side = buy, -1 si side = sell
entryPrice     = openSiguiente * (1 + direction * slippage/100)
notional       = min(balance, balance * positionSize/100)
quantity       = notional / entryPrice
stopPrice      = entryPrice * (1 - direction * stopLoss/100)
targetPrice    = entryPrice * (1 + direction * takeProfit/100)
grossPnl       = (exitPrice - entryPrice) * quantity * direction
fees           = entryNotional * commission/100 + exitNotional * commission/100
netPnl         = grossPnl - fees
balance        = balance + netPnl
returnPct      = (finalBalance - initialBalance) / initialBalance * 100
dailyLossPct   = (dayStartBalance - balance) / dayStartBalance * 100
```

Ejemplo numérico para validar comisiones:

```text
Balance inicial: 1000
positionSize:    100 %
entryPrice:      100
exitPrice:       110
quantity:        10
commission:      0.1 % por lado
grossPnl:        100
feeEntrada:      1.0
feeSalida:       1.1
netPnl:          97.9
balance final:   1097.9
```

Si tu resultado no da `1097.9`, hay un error en comisiones o en el tamaño de posición.

---

## 4. Tipos y cambios mínimos en archivos existentes

### 4.1 `src/types.ts`

Añade `'backtest'` a `PageId`, define `ExitReason` y amplía `Trade` con campos opcionales. Los campos opcionales mantienen compatibles los trades de ejemplo.

```ts
export type PageId =
  | 'dashboard'
  | 'bot-config'
  | 'bot-run'
  | 'backtest'
  | 'stats'
  | 'settings'

export type ExitReason = 'stop' | 'target' | 'signal' | 'end' | 'bankrupt'

export type Trade = {
  id: number
  time: string
  pair: string
  side: TradeSide
  entryPrice: number
  exitPrice: number
  size: number

  /** PnL neto ya calculado por el motor (incluye comisiones). */
  pnl?: number
  /** Timestamp de entrada (backtest). */
  entryTime?: number
  /** Timestamp de salida (backtest). */
  exitTime?: number
  /** Motivo de salida (backtest). */
  exitReason?: ExitReason
}
```

### 4.2 `src/trades.ts`

Haz que `tradePnl()` respete el PnL neto del backtest. Los trades de ejemplo siguen usando la fórmula antigua.

```ts
export function tradePnl(trade: Trade): number {
  if (typeof trade.pnl === 'number' && Number.isFinite(trade.pnl)) {
    return trade.pnl
  }

  const move = (trade.exitPrice - trade.entryPrice) / trade.entryPrice
  const direction = trade.side === 'buy' ? 1 : -1
  return Math.round(move * direction * trade.size * 100) / 100
}
```

### 4.3 `src/metrics.ts`

Añade un segundo parámetro opcional. Las llamadas actuales no cambian.

```ts
export function computeMetrics(
  trades: Trade[],
  initialBalance = startingBalance,
): Metrics {
  const ordered = [...trades].sort((a, b) => a.time.localeCompare(b.time))
  const results = ordered.map((trade) => tradePnl(trade))

  // ...

  let balance = initialBalance
  let peak = initialBalance
  let maxDrawdown = 0
  let maxDrawdownPct = 0

  // ... resto igual
}

export function computeEquityPoints(
  trades: Trade[],
  initialBalance = startingBalance,
): ChartPoint[] {
  const ordered = [...trades].sort((a, b) => a.time.localeCompare(b.time))
  const points: ChartPoint[] = [{ label: 'Start', value: initialBalance }]
  let balance = initialBalance

  for (const trade of ordered) {
    balance = Math.round((balance + tradePnl(trade)) * 100) / 100
    points.push({ label: trade.time, value: balance })
  }

  return points
}
```

> **Importante:** dentro de `computeMetrics` no uses el nombre `startingBalance` para el parámetro; chocaría con la constante exportada. Usa `initialBalance`.

---

## 5. Motor de backtest: `src/backtest.ts`

Este es el archivo central. Cópialo como referencia y ajústalo si cambias alguna decisión de las secciones 2 y 3.

```ts
import { crossoverSignals } from './signals'
import type {
  Candle,
  ExitReason,
  SignalParams,
  Strategy,
  Trade,
  TradeSide,
} from './types'

export type BacktestSettings = {
  initialBalance: number
  /** Comisión por lado, en porcentaje. 0.1 = 0.1 %. */
  commissionPct: number
  /** Deslizamiento adverso, en porcentaje. */
  slippagePct: number
  /** Si es false, una señal SELL solo cierra largos. */
  allowShort: boolean
}

export type BacktestConfig = {
  pair: string
  params: SignalParams
  strategy: Pick<
    Strategy,
    'positionSize' | 'stopLoss' | 'takeProfit' | 'maxDailyRisk'
  >
  settings: BacktestSettings
}

export type BacktestTrade = Trade & {
  pnl: number
  grossPnl: number
  fees: number
  entryTime: number
  exitTime: number
  exitReason: ExitReason
  balanceAfter: number
}

export type EquityPoint = {
  time: number
  value: number
}

export type BacktestResult = {
  config: BacktestConfig
  candles: { from: number; to: number; count: number }
  trades: BacktestTrade[]
  equity: EquityPoint[]
  initialBalance: number
  finalBalance: number
  netPnl: number
  returnPct: number
  feesPaid: number
  signals: number
  skippedSignals: number
  bankrupt: boolean
  warnings: string[]
}

export type BacktestSnapshot = {
  version: 1
  createdAt: number
  config: BacktestConfig
  candles: { from: number; to: number; count: number }
  trades: BacktestTrade[]
  summary: {
    initialBalance: number
    finalBalance: number
    netPnl: number
    returnPct: number
    feesPaid: number
    bankrupt: boolean
  }
}

/** Datos mínimos para evaluar una salida. Exportado para tests. */
export type ExitCandidate = {
  side: TradeSide
  stopPrice: number
  targetPrice: number
}

type OpenPosition = ExitCandidate & {
  entryPrice: number
  entryTime: number
  quantity: number
  notional: number
  entryFee: number
}

type PendingAction = {
  side: TradeSide
  closeFirst: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function dayKey(time: number): number {
  return Math.floor(time / DAY_MS)
}

function toIso(time: number): string {
  return new Date(time).toISOString()
}

function directionOf(side: TradeSide): number {
  return side === 'buy' ? 1 : -1
}

/**
 * Aplica slippage adverso:
 * - buy paga más,
 * - sell recibe menos.
 */
function fillPrice(
  price: number,
  side: TradeSide,
  slippagePct: number,
): number {
  return price * (1 + directionOf(side) * (slippagePct / 100))
}

/**
 * Decide si la vela toca stop o objetivo.
 * Criterio conservador: si ambos se tocan, gana el stop.
 * Si la apertura ya está fuera, se ejecuta a la apertura (hueco).
 */
export function resolveExit(
  position: ExitCandidate,
  candle: Candle,
): { price: number; reason: ExitReason } | null {
  if (position.side === 'buy') {
    if (candle.open <= position.stopPrice) {
      return { price: candle.open, reason: 'stop' }
    }
    if (candle.open >= position.targetPrice) {
      return { price: candle.open, reason: 'target' }
    }
    if (candle.low <= position.stopPrice) {
      return { price: position.stopPrice, reason: 'stop' }
    }
    if (candle.high >= position.targetPrice) {
      return { price: position.targetPrice, reason: 'target' }
    }
    return null
  }

  if (candle.open >= position.stopPrice) {
    return { price: candle.open, reason: 'stop' }
  }
  if (candle.open <= position.targetPrice) {
    return { price: candle.open, reason: 'target' }
  }
  if (candle.high >= position.stopPrice) {
    return { price: position.stopPrice, reason: 'stop' }
  }
  if (candle.low <= position.targetPrice) {
    return { price: position.targetPrice, reason: 'target' }
  }
  return null
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} debe ser un número mayor que 0.`)
  }
}

function validateConfig(config: BacktestConfig): void {
  const { params, strategy, settings } = config

  assertPositive('El balance inicial', settings.initialBalance)
  assertPositive('El tamaño de posición', strategy.positionSize)
  assertPositive('El stop loss', strategy.stopLoss)
  assertPositive('El take profit', strategy.takeProfit)
  assertPositive('El riesgo máximo diario', strategy.maxDailyRisk)

  if (strategy.positionSize > 100) {
    throw new Error('El tamaño de posición no puede superar 100 %.')
  }
  if (!Number.isFinite(settings.commissionPct) || settings.commissionPct < 0) {
    throw new Error('La comisión no puede ser negativa.')
  }
  if (settings.commissionPct >= 100) {
    throw new Error('La comisión debe ser menor que 100 %.')
  }
  if (!Number.isFinite(settings.slippagePct) || settings.slippagePct < 0) {
    throw new Error('El deslizamiento no puede ser negativo.')
  }
  if (settings.slippagePct >= 100) {
    throw new Error('El deslizamiento debe ser menor que 100 %.')
  }
  if (!Number.isInteger(params.fastPeriod) || params.fastPeriod < 1) {
    throw new Error('El período rápido debe ser un entero positivo.')
  }
  if (!Number.isInteger(params.slowPeriod) || params.slowPeriod < 1) {
    throw new Error('El período lento debe ser un entero positivo.')
  }
  if (params.average !== 'sma' && params.average !== 'ema') {
    throw new Error('El tipo de media debe ser sma o ema.')
  }
}

/**
 * Ejecuta un backtest determinista, vela por vela.
 *
 * Reglas:
 * - La señal de la vela i se ejecuta en el open de i + 1.
 * - Una sola posición a la vez.
 * - SL/TP con high/low; stop primero si ambos se tocan.
 * - El balance se actualiza solo al cerrar operaciones (realizado).
 * - La posición abierta al final se cierra al último close.
 */
export function runBacktest(
  candles: Candle[],
  config: BacktestConfig,
): BacktestResult {
  validateConfig(config)

  const data = [...candles].sort((a, b) => a.time - b.time)
  const { strategy, settings, params } = config
  const initialBalance = roundMoney(settings.initialBalance)

  if (data.length < 2) {
    return {
      config,
      candles: {
        from: data[0]?.time ?? 0,
        to: data[data.length - 1]?.time ?? 0,
        count: data.length,
      },
      trades: [],
      equity: [{ time: data[0]?.time ?? 0, value: initialBalance }],
      initialBalance,
      finalBalance: initialBalance,
      netPnl: 0,
      returnPct: 0,
      feesPaid: 0,
      signals: 0,
      skippedSignals: 0,
      bankrupt: false,
      warnings: ['Se necesitan al menos 2 velas para ejecutar el backtest.'],
    }
  }

  const signals = crossoverSignals(data, params)
  const signalByIndex = new Map(
    signals.map((signal) => [signal.index, signal]),
  )
  const lastIndex = data.length - 1

  let balance = initialBalance
  let position: OpenPosition | null = null
  let pending: PendingAction | null = null
  let currentDay = dayKey(data[0].time)
  let dayStartBalance = balance
  let dayHalted = false
  let bankrupt = false
  let skippedSignals = 0
  let feesPaid = 0

  const trades: BacktestTrade[] = []
  const equity: EquityPoint[] = [{ time: data[0].time, value: balance }]
  const warnings: string[] = []

  function closePosition(
    rawPrice: number,
    time: number,
    reason: ExitReason,
  ): void {
    if (!position) return

    const closeSide: TradeSide = position.side === 'buy' ? 'sell' : 'buy'
    const exitPrice = fillPrice(rawPrice, closeSide, settings.slippagePct)
    const exitNotional = exitPrice * position.quantity
    const exitFee = exitNotional * (settings.commissionPct / 100)

    const rawGross =
      (exitPrice - position.entryPrice) *
      position.quantity *
      directionOf(position.side)

    const fees = roundMoney(position.entryFee + exitFee)
    const pnl = roundMoney(rawGross - fees)

    balance = roundMoney(balance + pnl)
    if (balance <= 0) {
      balance = 0
      bankrupt = true
      warnings.push('El balance llegó a cero. No se abrirán más operaciones.')
    }

    feesPaid = roundMoney(feesPaid + fees)

    trades.push({
      id: trades.length + 1,
      time: toIso(time),
      pair: config.pair,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice,
      size: roundMoney(position.notional),
      pnl,
      grossPnl: roundMoney(rawGross),
      fees,
      entryTime: position.entryTime,
      exitTime: time,
      exitReason: reason,
      balanceAfter: balance,
    })

    equity.push({ time, value: balance })

    if (dayStartBalance > 0) {
      const lossPct =
        ((dayStartBalance - balance) / dayStartBalance) * 100
      if (lossPct >= strategy.maxDailyRisk) {
        dayHalted = true
      }
    }

    position = null
  }

  function openPosition(
    side: TradeSide,
    rawPrice: number,
    time: number,
  ): void {
    if (balance <= 0 || bankrupt) return

    const entryPrice = fillPrice(rawPrice, side, settings.slippagePct)
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return

    const notional = Math.min(
      balance,
      balance * (strategy.positionSize / 100),
    )
    if (notional <= 0) return

    const quantity = notional / entryPrice
    const direction = directionOf(side)

    position = {
      side,
      entryPrice,
      entryTime: time,
      quantity,
      notional,
      entryFee: notional * (settings.commissionPct / 100),
      stopPrice: entryPrice * (1 - direction * (strategy.stopLoss / 100)),
      targetPrice:
        entryPrice * (1 + direction * (strategy.takeProfit / 100)),
    }
  }

  for (let index = 0; index < data.length; index++) {
    const candle = data[index]
    const day = dayKey(candle.time)

    // Nuevo día UTC: se resetea el límite diario.
    if (day !== currentDay) {
      currentDay = day
      dayStartBalance = balance
      dayHalted = false
    }

    // 1) Ejecutar la señal confirmada en el cierre anterior.
    if (pending) {
      if (position && pending.closeFirst) {
        closePosition(candle.open, candle.time, 'signal')
      }

      if (pending.side && !position) {
        if (dayHalted || bankrupt) {
          skippedSignals++
        } else if (pending.side === 'sell' && !settings.allowShort) {
          skippedSignals++
        } else {
          openPosition(pending.side, candle.open, candle.time)
        }
      }

      pending = null
    }

    // 2) Stop loss / take profit dentro de la vela.
    if (position) {
      const exit = resolveExit(position, candle)
      if (exit) {
        closePosition(exit.price, candle.time, exit.reason)
      }
    }

    // 3) Leer la señal de esta vela para ejecutarla en la apertura siguiente.
    const signal = signalByIndex.get(index)

    if (signal) {
      if (index === lastIndex) {
        skippedSignals++
      } else if (!position) {
        if (signal.side === 'sell' && !settings.allowShort) {
          skippedSignals++
        } else {
          pending = { side: signal.side, closeFirst: false }
        }
      } else if (position.side !== signal.side) {
        pending = { side: signal.side, closeFirst: true }
      } else {
        skippedSignals++
      }
    }
  }

  // 4) Cerrar la posición que quede abierta al final.
  if (position) {
    closePosition(data[lastIndex].close, data[lastIndex].time, 'end')
  }

  const finalBalance = roundMoney(balance)
  const netPnl = roundMoney(finalBalance - initialBalance)

  return {
    config,
    candles: {
      from: data[0].time,
      to: data[lastIndex].time,
      count: data.length,
    },
    trades,
    equity,
    initialBalance,
    finalBalance,
    netPnl,
    returnPct:
      initialBalance > 0 ? (netPnl / initialBalance) * 100 : 0,
    feesPaid,
    signals: signals.length,
    skippedSignals,
    bankrupt,
    warnings,
  }
}

export const exitReasonLabels: Record<ExitReason, string> = {
  stop: 'Stop loss',
  target: 'Take profit',
  signal: 'Señal contraria',
  end: 'Fin de datos',
  bankrupt: 'Balance agotado',
}

export function createBacktestSnapshot(
  result: BacktestResult,
): BacktestSnapshot {
  return {
    version: 1,
    createdAt: Date.now(),
    config: result.config,
    candles: result.candles,
    trades: result.trades,
    summary: {
      initialBalance: result.initialBalance,
      finalBalance: result.finalBalance,
      netPnl: result.netPnl,
      returnPct: result.returnPct,
      feesPaid: result.feesPaid,
      bankrupt: result.bankrupt,
    },
  }
}

function isBacktestTrade(value: unknown): value is BacktestTrade {
  if (typeof value !== 'object' || value === null) return false
  const trade = value as Record<string, unknown>
  return (
    typeof trade.id === 'number' &&
    typeof trade.time === 'string' &&
    typeof trade.pair === 'string' &&
    (trade.side === 'buy' || trade.side === 'sell') &&
    typeof trade.entryPrice === 'number' &&
    typeof trade.exitPrice === 'number' &&
    typeof trade.size === 'number' &&
    typeof trade.pnl === 'number' &&
    typeof trade.balanceAfter === 'number' &&
    typeof trade.entryTime === 'number' &&
    typeof trade.exitTime === 'number' &&
    (trade.exitReason === 'stop' ||
      trade.exitReason === 'target' ||
      trade.exitReason === 'signal' ||
      trade.exitReason === 'end' ||
      trade.exitReason === 'bankrupt')
  )
}

export function isBacktestSnapshot(
  value: unknown,
): value is BacktestSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>

  if (candidate.version !== 1) return false
  if (typeof candidate.createdAt !== 'number') return false
  if (!Array.isArray(candidate.trades)) return false
  if (!candidate.trades.every(isBacktestTrade)) return false
  if (typeof candidate.config !== 'object' || candidate.config === null) {
    return false
  }
  if (typeof candidate.candles !== 'object' || candidate.candles === null) {
    return false
  }
  if (typeof candidate.summary !== 'object' || candidate.summary === null) {
    return false
  }

  const config = candidate.config as Record<string, unknown>
  if (typeof config.pair !== 'string') return false

  const candles = candidate.candles as Record<string, unknown>
  if (typeof candles.count !== 'number') return false

  const summary = candidate.summary as Record<string, unknown>
  return (
    typeof summary.initialBalance === 'number' &&
    typeof summary.finalBalance === 'number' &&
    typeof summary.netPnl === 'number' &&
    typeof summary.returnPct === 'number' &&
    typeof summary.feesPaid === 'number' &&
    typeof summary.bankrupt === 'boolean'
  )
}
```

### 5.1 Por qué el motor está escrito así

- `data` se ordena en una copia: no muta las velas de entrada.
- `signalByIndex` evita recorrer señales en cada vela.
- `pending` representa la señal del cierre anterior; se ejecuta al abrir la vela actual.
- `closePosition` y `openPosition` son funciones internas para no repetir fórmulas.
- `equity` solo cambia al cerrar: es una curva de capital **realizada**.
- `bankrupt` evita seguir abriendo cuando el balance llega a cero.
- `warnings` y `skippedSignals` permiten explicar resultados raros en la UI.
- `createBacktestSnapshot` guarda solo lo necesario para Estadísticas, no las 1000 velas.

### 5.2 Casos límite que el motor ya cubre

| Caso | Comportamiento |
|---|---|
| Menos de 2 velas | Resultado vacío con warning |
| Señal en la última vela | Se descarta y se cuenta |
| SELL sin `allowShort` estando plano | Se descarta |
| SELL sin `allowShort` estando largo | Cierra el largo |
| SL y TP en la misma vela | Gana el stop |
| Hueco por debajo del stop | Se sale a la apertura |
| Balance llega a 0 | `bankrupt = true`, no más entradas |
| Posición abierta al final | Se cierra al último cierre, motivo `end` |
| Comisión muy alta | El PnL neto puede ser negativo aunque el precio suba |
| Datos desordenados | Se ordenan antes de calcular |

---

## 6. Pruebas automáticas: `src/backtest.test.ts`

### 6.1 Instalar Vitest

El `package.json` ya tiene `"test": "vitest run"`, pero `vitest` no está en `devDependencies` ni en `node_modules`. Instálalo con el gestor que uses:

```bash
cd /public/flare
npm install -D vitest
# o, si usas pnpm:
# pnpm add -D vitest
```

Si quieres modo interactivo, añade a `package.json`:

```json
"scripts": {
  "dev": "vite",
  "build": "tsc -b && vite build",
  "lint": "eslint .",
  "preview": "vite preview",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

No hace falta configuración adicional: Vitest usa `vite.config.ts` y los tests del motor son puros Node, sin DOM.

### 6.2 Archivo de pruebas completo

Los fixtures usan `fastPeriod: 1` y `slowPeriod: 2` para que las señales sean fáciles de construir. La UI seguirá ofreciendo 5/9/12 y 20/26/50; el motor acepta cualquier período positivo.

```ts
import { describe, expect, it } from 'vitest'
import {
  resolveExit,
  runBacktest,
  type BacktestConfig,
} from './backtest'
import { computeMetrics } from './metrics'
import type { Candle } from './types'

const HOUR = 3_600_000

function candle(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
): Candle {
  return { time, open, high, low, close, volume: 0 }
}

const params = {
  fastPeriod: 1,
  slowPeriod: 2,
  average: 'sma' as const,
}

function makeConfig(overrides: {
  strategy?: Partial<BacktestConfig['strategy']>
  settings?: Partial<BacktestConfig['settings']>
} = {}): BacktestConfig {
  return {
    pair: 'BTC/USDT',
    params,
    strategy: {
      positionSize: 100,
      stopLoss: 5,
      takeProfit: 10,
      maxDailyRisk: 50,
      ...overrides.strategy,
    },
    settings: {
      initialBalance: 1000,
      commissionPct: 0,
      slippagePct: 0,
      allowShort: false,
      ...overrides.settings,
    },
  }
}

/**
 * Datos base para una señal BUY en el índice 3.
 * closes: 100, 100, 90, 110, ...
 * La entrada se ejecuta en el open del índice 4.
 */
function buySignalCandles(): Candle[] {
  return [
    candle(0 * HOUR, 100, 101, 99, 100),
    candle(1 * HOUR, 100, 101, 99, 100),
    candle(2 * HOUR, 90, 91, 89, 90),
    candle(3 * HOUR, 110, 111, 109, 110),
    candle(4 * HOUR, 100, 101, 99, 110),
    candle(5 * HOUR, 105, 111, 104, 108),
    candle(6 * HOUR, 108, 109, 107, 108),
  ]
}

describe('resolveExit', () => {
  it('en un largo, si se tocan stop y objetivo en la misma vela, gana el stop', () => {
    const exit = resolveExit(
      { side: 'buy', stopPrice: 95, targetPrice: 110 },
      candle(0, 100, 111, 94, 100),
    )
    expect(exit).toEqual({ price: 95, reason: 'stop' })
  })

  it('en un largo, un hueco por debajo del stop sale a la apertura', () => {
    const exit = resolveExit(
      { side: 'buy', stopPrice: 95, targetPrice: 110 },
      candle(0, 90, 91, 89, 90),
    )
    expect(exit).toEqual({ price: 90, reason: 'stop' })
  })

  it('en un corto, el objetivo se toca con el mínimo', () => {
    const exit = resolveExit(
      { side: 'sell', stopPrice: 105, targetPrice: 90 },
      candle(0, 100, 101, 89, 95),
    )
    expect(exit).toEqual({ price: 90, reason: 'target' })
  })

  it('sin tocar niveles no hay salida', () => {
    const exit = resolveExit(
      { side: 'buy', stopPrice: 95, targetPrice: 110 },
      candle(0, 100, 105, 99, 102),
    )
    expect(exit).toBeNull()
  })
})

describe('runBacktest', () => {
  it('entra en la apertura de la vela siguiente, no en el cierre de la señal', () => {
    const candles = [
      candle(0 * HOUR, 100, 101, 99, 100),
      candle(1 * HOUR, 100, 101, 99, 100),
      candle(2 * HOUR, 90, 91, 89, 90),
      candle(3 * HOUR, 110, 111, 109, 110), // señal BUY al cierre
      candle(4 * HOUR, 20, 116, 19.5, 115), // apertura con hueco
      candle(5 * HOUR, 115, 116, 114, 120),
      candle(6 * HOUR, 120, 126, 119, 125),
    ]

    const result = runBacktest(candles, makeConfig())

    expect(result.trades).toHaveLength(1)
    expect(result.trades[0].entryPrice).toBe(20)
    expect(result.trades[0].entryTime).toBe(4 * HOUR)
  })

  it('toma ganancia en el objetivo y aplica comisiones por lado', () => {
    const result = runBacktest(
      buySignalCandles(),
      makeConfig({ settings: { commissionPct: 0.1 } }),
    )

    expect(result.trades).toHaveLength(1)

    const trade = result.trades[0]
    expect(trade.exitReason).toBe('target')
    expect(trade.entryPrice).toBe(100)
    expect(trade.exitPrice).toBe(110)
    expect(trade.grossPnl).toBe(100)
    expect(trade.fees).toBe(2.1)
    expect(trade.pnl).toBe(97.9)
    expect(result.finalBalance).toBe(1097.9)
    expect(result.feesPaid).toBe(2.1)
  })

  it('aplica el stop antes que el objetivo si ambos se tocan', () => {
    const candles = buySignalCandles()
    candles[5] = candle(5 * HOUR, 105, 111, 94, 100)

    const result = runBacktest(
      candles,
      makeConfig({ settings: { commissionPct: 0 } }),
    )

    expect(result.trades[0].exitReason).toBe('stop')
    expect(result.trades[0].exitPrice).toBe(95)
    expect(result.trades[0].pnl).toBe(-50)
    expect(result.finalBalance).toBe(950)
  })

  it('abre cortos cuando allowShort es true', () => {
    const candles = [
      candle(0 * HOUR, 90, 91, 89, 90),
      candle(1 * HOUR, 100, 101, 99, 100),
      candle(2 * HOUR, 110, 111, 109, 110),
      candle(3 * HOUR, 90, 91, 89, 90), // señal SELL
      candle(4 * HOUR, 100, 101, 89, 90), // entrada 100 y objetivo 90
      candle(5 * HOUR, 90, 91, 89, 90),
      candle(6 * HOUR, 90, 91, 89, 90),
    ]

    const result = runBacktest(
      candles,
      makeConfig({ settings: { allowShort: true } }),
    )

    expect(result.trades).toHaveLength(1)
    expect(result.trades[0].side).toBe('sell')
    expect(result.trades[0].exitReason).toBe('target')
    expect(result.trades[0].exitPrice).toBe(90)
    expect(result.trades[0].pnl).toBe(100)
  })

  it('sin allowShort, una señal SELL estando plano no abre nada', () => {
    const candles = [
      candle(0 * HOUR, 90, 91, 89, 90),
      candle(1 * HOUR, 100, 101, 99, 100),
      candle(2 * HOUR, 110, 111, 109, 110),
      candle(3 * HOUR, 90, 91, 89, 90),
      candle(4 * HOUR, 100, 101, 99, 100),
    ]

    const result = runBacktest(candles, makeConfig())
    expect(result.trades).toHaveLength(0)
    expect(result.skippedSignals).toBeGreaterThan(0)
  })

  it('el límite de riesgo diario bloquea nuevas entradas el resto del día', () => {
    const candles = [
      candle(0 * HOUR, 100, 101, 99, 100),
      candle(1 * HOUR, 100, 101, 99, 100),
      candle(2 * HOUR, 90, 91, 89, 90),
      candle(3 * HOUR, 110, 111, 109, 110), // BUY
      candle(4 * HOUR, 100, 101, 99, 110), // entrada 100
      candle(5 * HOUR, 100, 101, 97, 100), // stop 98
      candle(6 * HOUR, 100, 101, 99, 100),
      candle(7 * HOUR, 100, 101, 99, 100),
      candle(8 * HOUR, 100, 101, 89, 90), // SELL, se descarta
      candle(9 * HOUR, 90, 111, 89, 110), // BUY
      candle(10 * HOUR, 110, 111, 109, 110), // ya bloqueado
    ]

    const result = runBacktest(
      candles,
      makeConfig({
        strategy: { stopLoss: 2, maxDailyRisk: 2 },
        settings: { allowShort: false },
      }),
    )

    expect(result.trades).toHaveLength(1)
    expect(result.trades[0].exitReason).toBe('stop')
    expect(result.trades[0].pnl).toBe(-20)
    expect(result.finalBalance).toBe(980)
    expect(result.skippedSignals).toBeGreaterThan(0)
  })

  it('cierra la posición abierta al final de los datos', () => {
    const candles = [
      candle(0 * HOUR, 100, 101, 99, 100),
      candle(1 * HOUR, 100, 101, 99, 100),
      candle(2 * HOUR, 90, 91, 89, 90),
      candle(3 * HOUR, 110, 111, 109, 110), // BUY
      candle(4 * HOUR, 100, 101, 99, 115), // entrada 100
      candle(5 * HOUR, 115, 116, 114, 120),
      candle(6 * HOUR, 120, 126, 119, 125),
    ]

    const result = runBacktest(
      candles,
      makeConfig({
        strategy: { stopLoss: 50, takeProfit: 50 },
      }),
    )

    expect(result.trades).toHaveLength(1)
    expect(result.trades[0].exitReason).toBe('end')
    expect(result.trades[0].exitPrice).toBe(125)
    expect(result.trades[0].pnl).toBe(250)
  })

  it('el slippage encarece la entrada de un largo', () => {
    const candles = [
      candle(0 * HOUR, 100, 101, 99, 100),
      candle(1 * HOUR, 100, 101, 99, 100),
      candle(2 * HOUR, 90, 91, 89, 90),
      candle(3 * HOUR, 110, 111, 109, 110),
      candle(4 * HOUR, 100, 101, 99, 115),
      candle(5 * HOUR, 115, 116, 114, 120),
      candle(6 * HOUR, 120, 126, 119, 125),
    ]

    const result = runBacktest(
      candles,
      makeConfig({
        strategy: { stopLoss: 50, takeProfit: 50 },
        settings: { slippagePct: 1 },
      }),
    )

    expect(result.trades[0].entryPrice).toBeCloseTo(101, 6)
  })

  it('no muta las velas de entrada', () => {
    const candles = buySignalCandles()
    const before = JSON.stringify(candles)

    runBacktest(candles, makeConfig())

    expect(JSON.stringify(candles)).toBe(before)
  })

  it('devuelve un resultado vacío con warning si hay menos de 2 velas', () => {
    const result = runBacktest(
      [candle(0, 100, 101, 99, 100)],
      makeConfig(),
    )

    expect(result.trades).toHaveLength(0)
    expect(result.finalBalance).toBe(1000)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('las métricas usan el balance inicial del backtest', () => {
    const candles = buySignalCandles()
    const result = runBacktest(candles, makeConfig())

    const metrics = computeMetrics(result.trades, result.initialBalance)

    expect(metrics.totalTrades).toBe(1)
    expect(metrics.wins).toBe(1)
    expect(metrics.winRate).toBe(100)
    expect(metrics.maxDrawdown).toBe(0)
  })
})
```

### 6.3 Qué cubre y qué no

Cubre:

- prioridad stop/objetivo,
- huecos,
- cortos,
- comisiones,
- riesgo diario,
- cierre final,
- slippage,
- ausencia de mutación,
- métricas con balance inicial.

No cubre:

- la UI (se prueba a mano),
- la red de Binance,
- la persistencia en localStorage,
- la precisión de la fuente de datos.

Eso es intencionado: el motor es la pieza donde un error sutil cuesta más caro.

### 6.4 Ejecutar

```bash
cd /public/flare
npm test
```

Salida esperada: todos los tests en verde. Si algo falla, revisa primero:

1. que la señal se ejecute en `i + 1`,
2. que la comisión se cobre en entrada y salida,
3. que el stop gane cuando ambos niveles se tocan,
4. que el redondeo sea a 2 decimales.

---

## 7. Pantalla de configuración y resultados: `src/pages/Backtest.tsx`

La página hace tres cosas:

1. Configura datos, señal, riesgo y ejecución.
2. Ejecuta el motor con las velas cargadas.
3. Muestra resultados y guarda un snapshot para Estadísticas.

No contiene fórmulas de simulación: solo traduce formularios a `BacktestConfig`.

```tsx
import { useMemo, useState, type ChangeEvent, type FormEvent } from 'react'
import './Backtest.css'
import PageHeader from '../components/PageHeader'
import NumberField from '../components/NumberField'
import EquityChart from '../components/EquityChart'
import MetricCard from '../components/MetricCard'
import TradesTable from '../components/TradesTable'
import { useCandles } from '../hooks/useCandles'
import { marketDataSource } from '../market'
import { availablePairs } from '../strategy'
import {
  averageOptions,
  defaultSignalParams,
  fastOptions,
  slowOptions,
} from '../signals'
import {
  createBacktestSnapshot,
  exitReasonLabels,
  runBacktest,
  type BacktestConfig,
  type BacktestResult,
  type BacktestSnapshot,
} from '../backtest'
import { computeMetrics } from '../metrics'
import {
  formatDateTime,
  formatMoney,
  formatOrDash,
  formatPercent,
  formatSignedMoney,
} from '../format'
import type {
  AverageKind,
  ChartPoint,
  ExitReason,
  Interval,
  PageId,
  SignalParams,
  Strategy,
  Tone,
} from '../types'

const CANDLE_LIMITS = [200, 500, 1000]

const intervalOptions: { id: Interval; label: string }[] = [
  { id: '15m', label: '15 min' },
  { id: '1h', label: '1 h' },
  { id: '4h', label: '4 h' },
  { id: '1d', label: '1 día' },
]

type FormValues = {
  initialBalance: string
  commissionPct: string
  slippagePct: string
  positionSize: string
  stopLoss: string
  takeProfit: string
  maxDailyRisk: string
}

type FormErrors = Partial<Record<keyof FormValues, string>>

function toFormValues(strategy: Strategy): FormValues {
  return {
    initialBalance: '10000',
    commissionPct: '0.1',
    slippagePct: '0',
    positionSize: String(strategy.positionSize),
    stopLoss: String(strategy.stopLoss),
    takeProfit: String(strategy.takeProfit),
    maxDailyRisk: String(strategy.maxDailyRisk),
  }
}

function numberError(
  text: string,
  min: number,
  max: number,
): string | undefined {
  const value = Number(text)

  if (text.trim() === '' || Number.isNaN(value)) {
    return 'Escribe un número.'
  }
  if (value < min || value > max) {
    return `Debe estar entre ${min} y ${max}.`
  }
  return undefined
}

function validate(values: FormValues): FormErrors {
  return {
    initialBalance: numberError(values.initialBalance, 1, 1_000_000),
    commissionPct: numberError(values.commissionPct, 0, 5),
    slippagePct: numberError(values.slippagePct, 0, 5),
    positionSize: numberError(values.positionSize, 0.1, 100),
    stopLoss: numberError(values.stopLoss, 0.1, 50),
    takeProfit: numberError(values.takeProfit, 0.1, 100),
    maxDailyRisk: numberError(values.maxDailyRisk, 0.1, 100),
  }
}

function toneOf(value: number | null, threshold = 0): Tone {
  if (value === null) return 'neutral'
  if (value > threshold) return 'positive'
  if (value < threshold) return 'negative'
  return 'neutral'
}

type BacktestProps = {
  strategy: Strategy
  onNavigate: (page: PageId) => void
  onSaveResult: (snapshot: BacktestSnapshot) => void
}

function Backtest({ strategy, onNavigate, onSaveResult }: BacktestProps) {
  const [pair, setPair] = useState(strategy.pair)
  const [interval, setInterval] = useState<Interval>('1h')
  const [limit, setLimit] = useState(500)
  const [params, setParams] = useState<SignalParams>(defaultSignalParams)
  const [values, setValues] = useState<FormValues>(() =>
    toFormValues(strategy),
  )
  const [allowShort, setAllowShort] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [runError, setRunError] = useState<string | null>(null)

  const state = useCandles(
    marketDataSource,
    pair,
    interval,
    limit,
    reloadKey,
  )

  const errors = validate(values)
  const hasErrors = Object.values(errors).some(
    (message) => message !== undefined,
  )

  const metrics = useMemo(
    () =>
      result
        ? computeMetrics(result.trades, result.initialBalance)
        : null,
    [result],
  )

  const equityPoints: ChartPoint[] = useMemo(
    () =>
      result
        ? result.equity.map((point) => ({
            label: formatDateTime(point.time),
            value: point.value,
          }))
        : [],
    [result],
  )

  const exitCounts = useMemo(() => {
    if (!result) return {} as Partial<Record<ExitReason, number>>

    return result.trades.reduce<Partial<Record<ExitReason, number>>>(
      (counts, trade) => {
        counts[trade.exitReason] = (counts[trade.exitReason] ?? 0) + 1
        return counts
      },
      {},
    )
  }, [result])

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const { name, value } = event.target
    setValues((current) => ({ ...current, [name]: value }))
  }

  function handleRun(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()

    if (state.status !== 'success') {
      setRunError('Espera a que las velas terminen de cargar.')
      return
    }

    if (hasErrors) {
      setRunError('Revisa los campos marcados en rojo.')
      return
    }

    const config: BacktestConfig = {
      pair,
      params,
      strategy: {
        positionSize: Number(values.positionSize),
        stopLoss: Number(values.stopLoss),
        takeProfit: Number(values.takeProfit),
        maxDailyRisk: Number(values.maxDailyRisk),
      },
      settings: {
        initialBalance: Number(values.initialBalance),
        commissionPct: Number(values.commissionPct),
        slippagePct: Number(values.slippagePct),
        allowShort,
      },
    }

    try {
      const next = runBacktest(state.data, config)
      setResult(next)
      setRunError(null)
      onSaveResult(createBacktestSnapshot(next))
    } catch (error) {
      setRunError(
        error instanceof Error
          ? error.message
          : 'No se pudo ejecutar el backtest.',
      )
    }
  }

  const lastConfig = result?.config

  return (
    <div className="page">
      <PageHeader
        title="Backtest"
        subtitle="Simula la estrategia vela por vela con comisiones, stop loss y take profit."
      />

      <form className="form" onSubmit={handleRun} noValidate>
        <section className="section">
          <div className="section__header">
            <h2>Datos</h2>
          </div>

          <div className="backtest__grid">
            <div className="field">
              <label className="field__label" htmlFor="bt-pair">
                Par
              </label>
              <div className="field__control">
                <select
                  id="bt-pair"
                  value={pair}
                  onChange={(event) => setPair(event.target.value)}
                >
                  {availablePairs.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
              <p className="field__help">Mercado que se va a simular.</p>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="bt-interval">
                Temporalidad
              </label>
              <div className="field__control">
                <select
                  id="bt-interval"
                  value={interval}
                  onChange={(event) =>
                    setInterval(event.target.value as Interval)
                  }
                >
                  {intervalOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <p className="field__help">
                No se ofrece 5m hasta corregir `market/intervals.ts`.
              </p>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="bt-limit">
                Velas
              </label>
              <div className="field__control">
                <select
                  id="bt-limit"
                  value={limit}
                  onChange={(event) => setLimit(Number(event.target.value))}
                >
                  {CANDLE_LIMITS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
              <p className="field__help">
                Más velas = más historia y más tiempo de cálculo.
              </p>
            </div>
          </div>

          {state.status === 'loading' && (
            <p className="readout" role="status">
              Cargando velas…
            </p>
          )}

          {state.status === 'error' && (
            <div className="readout" role="alert">
              <p>No se pudieron cargar los datos: {state.message}</p>
              <button
                type="button"
                className="btn"
                onClick={() => setReloadKey((key) => key + 1)}
              >
                Reintentar
              </button>
            </div>
          )}

          {state.status === 'success' && (
            <p className="field__help">
              {state.data.length} velas desde{' '}
              {formatDateTime(state.data[0].time)} hasta{' '}
              {formatDateTime(state.data[state.data.length - 1].time)} UTC.
            </p>
          )}
        </section>

        <section className="section">
          <div className="section__header">
            <h2>Señal</h2>
          </div>

          <div className="backtest__grid">
            <div className="field">
              <label className="field__label" htmlFor="bt-fast">
                Media rápida
              </label>
              <div className="field__control">
                <select
                  id="bt-fast"
                  value={params.fastPeriod}
                  onChange={(event) =>
                    setParams({
                      ...params,
                      fastPeriod: Number(event.target.value),
                    })
                  }
                >
                  {fastOptions.map((option) => (
                    <option key={option} value={option}>
                      {option} velas
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="bt-slow">
                Media lenta
              </label>
              <div className="field__control">
                <select
                  id="bt-slow"
                  value={params.slowPeriod}
                  onChange={(event) =>
                    setParams({
                      ...params,
                      slowPeriod: Number(event.target.value),
                    })
                  }
                >
                  {slowOptions.map((option) => (
                    <option key={option} value={option}>
                      {option} velas
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="field">
              <span className="field__label" id="bt-average-label">
                Tipo de media
              </span>
              <div className="field__control">
                <div
                  className="segmented"
                  role="group"
                  aria-labelledby="bt-average-label"
                >
                  {averageOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`segmented__option ${
                        params.average === option.id
                          ? 'segmented__option--active'
                          : ''
                      }`}
                      aria-pressed={params.average === option.id}
                      onClick={() =>
                        setParams({
                          ...params,
                          average: option.id as AverageKind,
                        })
                      }
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section">
          <div className="section__header">
            <h2>Riesgo y ejecución</h2>
          </div>

          <div className="backtest__grid">
            <NumberField
              name="initialBalance"
              label="Balance inicial"
              unit="USD"
              hint="Capital con el que empieza la simulación."
              value={values.initialBalance}
              error={errors.initialBalance}
              onChange={handleChange}
            />

            <NumberField
              name="positionSize"
              label="Tamaño de posición"
              unit="%"
              hint="Porcentaje del balance usado como nocional."
              value={values.positionSize}
              error={errors.positionSize}
              onChange={handleChange}
            />

            <NumberField
              name="stopLoss"
              label="Stop loss"
              unit="%"
              hint="Distancia desde la entrada hasta el stop."
              value={values.stopLoss}
              error={errors.stopLoss}
              onChange={handleChange}
            />

            <NumberField
              name="takeProfit"
              label="Take profit"
              unit="%"
              hint="Distancia desde la entrada hasta el objetivo."
              value={values.takeProfit}
              error={errors.takeProfit}
              onChange={handleChange}
            />

            <NumberField
              name="maxDailyRisk"
              label="Riesgo máximo diario"
              unit="%"
              hint="Pérdida realizada que bloquea nuevas entradas ese día."
              value={values.maxDailyRisk}
              error={errors.maxDailyRisk}
              onChange={handleChange}
            />

            <NumberField
              name="commissionPct"
              label="Comisión por lado"
              unit="%"
              hint="Se cobra al entrar y al salir. 0.1 = 0.1 %."
              value={values.commissionPct}
              error={errors.commissionPct}
              onChange={handleChange}
            />

            <NumberField
              name="slippagePct"
              label="Slippage"
              unit="%"
              hint="Deslizamiento adverso en entrada y salida."
              value={values.slippagePct}
              error={errors.slippagePct}
              onChange={handleChange}
            />
          </div>

          <label className="backtest__check">
            <input
              type="checkbox"
              checked={allowShort}
              onChange={(event) => setAllowShort(event.target.checked)}
            />
            Permitir cortos: una señal SELL abre una posición short.
          </label>
        </section>

        <div className="form__actions">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={state.status !== 'success' || hasErrors}
          >
            Ejecutar backtest
          </button>
          <span className="form__status">
            {runError
              ? runError
              : hasErrors
                ? 'Corrige los campos marcados.'
                : 'La configuración se aplica al ejecutar.'}
          </span>
        </div>
      </form>

      {result && metrics && (
        <>
          <section className="section">
            <div className="section__header">
              <h2>Resultado</h2>
              <button
                type="button"
                className="btn"
                onClick={() => onNavigate('stats')}
              >
                Ver en Estadísticas
              </button>
            </div>

            <p className="readout">
              <strong>{result.config.pair}</strong> ·{' '}
              {result.config.params.average.toUpperCase()}{' '}
              {result.config.params.fastPeriod}/{result.config.params.slowPeriod} ·{' '}
              {result.candles.count} velas · comisión{' '}
              {result.config.settings.commissionPct}% por lado ·{' '}
              {result.trades.length} operaciones
              {result.bankrupt ? ' · cuenta agotada' : ''}
            </p>

            <div className="stats">
              <MetricCard
                label="PnL neto"
                value={formatSignedMoney(result.netPnl)}
                hint="Después de comisiones y slippage"
                tone={toneOf(result.netPnl)}
              />
              <MetricCard
                label="Retorno"
                value={formatPercent(result.returnPct, 2)}
                hint="Sobre el balance inicial"
                tone={toneOf(result.returnPct)}
              />
              <MetricCard
                label="Balance final"
                value={formatMoney(result.finalBalance)}
                hint={`Inicial ${formatMoney(result.initialBalance)}`}
              />
              <MetricCard
                label="Operaciones"
                value={String(metrics.totalTrades)}
                hint={`${metrics.wins} ganadoras · ${metrics.losses} perdedoras`}
              />
              <MetricCard
                label="Tasa de acierto"
                value={formatOrDash(metrics.winRate, (value) =>
                  formatPercent(value, 1),
                )}
                hint="Ganadoras sobre el total"
              />
              <MetricCard
                label="Factor de beneficio"
                value={formatOrDash(metrics.profitFactor, (value) =>
                  value.toFixed(2),
                )}
                hint="Ganancias ÷ pérdidas"
                tone={toneOf(metrics.profitFactor, 1)}
              />
              <MetricCard
                label="Mayor caída"
                value={formatMoney(-metrics.maxDrawdown)}
                hint={`${formatPercent(metrics.maxDrawdownPct, 2)} del máximo`}
                tone={metrics.maxDrawdown > 0 ? 'negative' : 'neutral'}
              />
              <MetricCard
                label="Comisiones pagadas"
                value={formatMoney(result.feesPaid)}
                hint="Entrada + salida"
                tone={result.feesPaid > 0 ? 'negative' : 'neutral'}
              />
            </div>
          </section>

          <section className="section">
            <div className="section__header">
              <h2>Motivos de salida</h2>
            </div>

            <div className="backtest__reasons">
              {(Object.keys(exitCounts) as ExitReason[]).map((reason) => (
                <span key={reason} className="backtest__reason">
                  {exitReasonLabels[reason]}: {exitCounts[reason]}
                </span>
              ))}
            </div>
          </section>

          <section className="section">
            <div className="section__header">
              <h2>Evolución del balance</h2>
            </div>
            <EquityChart points={equityPoints} />
          </section>

          <section className="section">
            <div className="section__header">
              <h2>Operaciones ({result.trades.length})</h2>
            </div>

            {result.trades.length === 0 ? (
              <p className="placeholder">
                Esta configuración no generó operaciones con estas velas.
                Prueba otro par, temporalidad o períodos de media.
              </p>
            ) : (
              <TradesTable trades={result.trades} />
            )}
          </section>

          {lastConfig && (
            <p className="disclaimer">
              Resultado sobre datos históricos. No incluye liquidez, funding,
              latencia ni cambios de spread. Un backtest no garantiza
              resultados futuros. Comisión configurada: por lado.
            </p>
          )}
        </>
      )}
    </div>
  )
}

export default Backtest
```

### 7.1 `src/pages/Backtest.css`

```css
.backtest__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 20px;
}

.backtest__check {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 20px;
  color: var(--text-muted);
  font-size: 0.9rem;
  cursor: pointer;
}

.backtest__check input {
  margin-top: 3px;
  accent-color: var(--primary);
}

.backtest__reasons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.backtest__reason {
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-muted);
  font-size: 0.85rem;
}

@media (max-width: 720px) {
  .backtest__grid {
    grid-template-columns: 1fr;
  }
}
```

### 7.2 Detalles de UX que no conviene saltarse

- El botón se desactiva mientras las velas cargan o hay errores de formulario.
- El mensaje de error del motor se muestra en `form__status`, no en un `alert()`.
- `result` guarda la configuración exacta usada; si cambias el formulario después, el resultado sigue mostrando la configuración anterior.
- El botón “Ver en Estadísticas” solo navega; el snapshot ya se guardó al ejecutar.
- La tabla y el gráfico se reutilizan; no dupliques componentes.
- El disclaimer debe decir claramente que la comisión es por lado.

---

## 8. Conexión con Estadísticas y navegación

### 8.1 `src/navItems.ts`

```ts
export const navItems: NavItem[] = [
  { id: 'dashboard', label: 'Panel', icon: '▦' },
  { id: 'bot-config', label: 'Ajustar bot', icon: '⚙' },
  { id: 'bot-run', label: 'Ejecutar bot', icon: '▶' },
  { id: 'backtest', label: 'Backtest', icon: '⟲' },
  { id: 'stats', label: 'Estadísticas', icon: '◔' },
  { id: 'settings', label: 'Ajustes', icon: '☰' },
]
```

### 8.2 `src/App.tsx`

Añade la página y el snapshot persistido. El snapshot vive en `App` para que Backtest lo escriba y Stats lo lea sin acoplar ambas páginas.

```tsx
import Backtest from './pages/Backtest'
import {
  isBacktestSnapshot,
  type BacktestSnapshot,
} from './backtest'

const BACKTEST_KEY = 'lixtrd:last-backtest'

function App() {
  // ... estado existente

  const [lastBacktest, setLastBacktest] = useLocalStorageState<
    BacktestSnapshot | null
  >(
    BACKTEST_KEY,
    null,
    (value): value is BacktestSnapshot | null =>
      value === null || isBacktestSnapshot(value),
  )

  function renderPage() {
    switch (activePage) {
      case 'dashboard':
        return <Dashboard botStatus={botStatus} />
      case 'bot-config':
        return <BotConfig strategy={strategy} onSave={setStrategy} />
      case 'bot-run':
        return (
          <BotRun
            status={botStatus}
            onChangeStatus={setBotStatus}
            strategy={strategy}
          />
        )
      case 'backtest':
        return (
          <Backtest
            strategy={strategy}
            onNavigate={setActivePage}
            onSaveResult={setLastBacktest}
          />
        )
      case 'stats':
        return (
          <Stats
            backtest={lastBacktest}
            onNavigate={setActivePage}
          />
        )
      case 'settings':
        return (
          <Settings
            settings={settings}
            onChangeSettings={setSettings}
            onResetAll={handleResetAll}
          />
        )
    }
  }

  // ... resto igual
}
```

> `useLocalStorageState` escribe el valor inicial en el primer efecto. Guardar `null` es válido con este validador. Si prefieres no escribir hasta el primer backtest, cambia el hook o usa `undefined` como valor inicial; no es necesario para la Parte 11.

### 8.3 `src/pages/Stats.tsx`

Stats debe poder mostrar dos fuentes:

- `sample`: los 12 trades de ejemplo actuales.
- `backtest`: el snapshot guardado.

Añade un selector y usa el balance inicial correcto.

```tsx
import type { BacktestSnapshot } from '../backtest'
import type { PageId, Tone } from '../types'

type TradeSource = 'sample' | 'backtest'

type StatsProps = {
  backtest: BacktestSnapshot | null
  onNavigate: (page: PageId) => void
}

function Stats({ backtest, onNavigate }: StatsProps) {
  const [filter, setFilter] = useState<TradeFilter>('all')
  const [source, setSource] = useState<TradeSource>(
    backtest ? 'backtest' : 'sample',
  )

  const activeSource: TradeSource = backtest ? source : 'sample'
  const activeTrades =
    activeSource === 'backtest' && backtest ? backtest.trades : trades
  const initialBalance =
    activeSource === 'backtest' && backtest
      ? backtest.summary.initialBalance
      : startingBalance

  const metrics = computeMetrics(activeTrades, initialBalance)
  const equityPoints = computeEquityPoints(activeTrades, initialBalance)

  // ... resto de cálculos igual, usando activeTrades en el filtro

  const visibleTrades = activeTrades.filter((trade) => {
    if (filter === 'wins') return tradePnl(trade) > 0
    if (filter === 'losses') return tradePnl(trade) < 0
    return true
  })

  return (
    <div className="page">
      <PageHeader
        title="Estadísticas"
        subtitle="Rendimiento y riesgo de tus operaciones."
      />

      {backtest && (
        <section className="readout">
          <p>
            <strong>Último backtest:</strong> {backtest.config.pair} ·{' '}
            {backtest.candles.count} velas ·{' '}
            {formatDateTime(backtest.createdAt)} UTC ·{' '}
            {backtest.trades.length} operaciones
          </p>
          <div className="segmented" role="group" aria-label="Fuente de datos">
            <button
              type="button"
              className={`segmented__option ${
                activeSource === 'backtest'
                  ? 'segmented__option--active'
                  : ''
              }`}
              aria-pressed={activeSource === 'backtest'}
              onClick={() => setSource('backtest')}
            >
              Backtest
            </button>
            <button
              type="button"
              className={`segmented__option ${
                activeSource === 'sample' ? 'segmented__option--active' : ''
              }`}
              aria-pressed={activeSource === 'sample'}
              onClick={() => setSource('sample')}
            >
              Ejemplo
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => onNavigate('backtest')}
            >
              Abrir backtest
            </button>
          </div>
        </section>
      )}

      {/* ... resto igual, pero con activeTrades y el disclaimer condicional */}

      <p className="disclaimer">
        {activeSource === 'backtest'
          ? 'Resultados del último backtest guardado. No incluyen liquidez, funding ni spread variable.'
          : 'Calculados con las operaciones de ejemplo. Con tan pocas operaciones, estos números no son confiables.'}
      </p>

      {/* MarketSection se mantiene al final */}
      <MarketSection />
    </div>
  )
}
```

Necesitas importar `startingBalance` desde `../metrics` y `formatDateTime` desde `../format` si no estaban.

> **Por qué el estado `source` funciona:** al cambiar de página, `Stats` se desmonta y vuelve a montar. En el montaje lee `backtest` y arranca en `'backtest'` si existe. Si no quieres depender de eso, usa un `useEffect` que ajuste la fuente cuando cambie `backtest`.

### 8.4 `src/components/TradesTable.tsx`

La tabla actual muestra `trade.time` y calcula el PnL con `tradePnl()`. Con los cambios de la sección 4.2 ya respeta el PnL neto. Añade fecha legible y motivo de salida cuando existan.

```tsx
import { exitReasonLabels } from '../backtest'
import { formatDateTime, formatMoney, formatPrice, formatSignedMoney } from '../format'
import type { Trade } from '../types'

function TradesTable({ trades }: { trades: Trade[] }) {
  const total = trades.reduce((sum, trade) => sum + tradePnl(trade), 0)
  const showExitReason = trades.some((trade) => trade.exitReason)
  const columnCount = showExitReason ? 8 : 7

  return (
    <div className="table-wrap">
      <table className="trades">
        <thead>
          <tr>
            <th scope="col">Salida (UTC)</th>
            <th scope="col">Par</th>
            <th scope="col">Lado</th>
            <th scope="col" className="trades__num">Entrada</th>
            <th scope="col" className="trades__num">Salida</th>
            <th scope="col" className="trades__num">Tamaño</th>
            <th scope="col" className="trades__num">Resultado</th>
            {showExitReason && <th scope="col">Motivo</th>}
          </tr>
        </thead>

        <tbody>
          {trades.length === 0 && (
            <tr>
              <td colSpan={columnCount} className="trades__empty">
                No hay operaciones para mostrar.
              </td>
            </tr>
          )}

          {trades.map((trade) => {
            const pnl = tradePnl(trade)
            const pnlClass =
              pnl > 0
                ? 'trades__pnl--positive'
                : pnl < 0
                  ? 'trades__pnl--negative'
                  : ''

            return (
              <tr key={trade.id}>
                <td>
                  {trade.exitTime !== undefined
                    ? `${formatDateTime(trade.exitTime)} UTC`
                    : trade.time}
                </td>
                <td>{trade.pair}</td>
                <td>
                  <span className={`side side--${trade.side}`}>
                    {sideLabels[trade.side]}
                  </span>
                </td>
                <td className="trades__num">{formatPrice(trade.entryPrice)}</td>
                <td className="trades__num">{formatPrice(trade.exitPrice)}</td>
                <td className="trades__num">{formatMoney(trade.size)}</td>
                <td className={`trades__num ${pnlClass}`}>
                  {formatSignedMoney(pnl)}
                </td>
                {showExitReason && (
                  <td>{trade.exitReason ? exitReasonLabels[trade.exitReason] : '—'}</td>
                )}
              </tr>
            )
          })}
        </tbody>

        <tfoot>
          <tr>
            <th scope="row" colSpan={columnCount - 1}>Total</th>
            <td className={`trades__num ${total > 0 ? 'trades__pnl--positive' : total < 0 ? 'trades__pnl--negative' : ''}`}>
              {formatSignedMoney(total)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
```

> El `tfoot` con `colSpan={columnCount - 1}` deja la última celda para el total. Si añades más columnas, ajusta el colspan.

### 8.5 Qué se guarda exactamente

`BacktestSnapshot` guarda:

- versión del formato,
- fecha de creación,
- configuración completa (par, señal, estrategia, ejecución),
- metadatos de velas (desde, hasta, cantidad),
- trades con PnL neto, fees, timestamps y motivo,
- resumen (balance inicial/final, PnL, retorno, fees, bankrupt).

No guarda:

- las 1000 velas (pesarían demasiado),
- la curva de capital (se puede reconstruir desde los trades),
- señales intermedias.

Si más adelante quieres comparar varios backtests, pasa a IndexedDB y guarda una lista con un `id`. Para la Parte 11, un solo snapshot es suficiente.

---

## 9. Orden de implementación recomendado

No implementes todo de golpe. Sigue este orden; cada fase deja el proyecto compilando.

### Fase 0 — Línea base

```bash
cd /public/flare
npm install
npm run build
npm run lint
npm test
```

Esperado:

- `build` y `lint` pasan.
- `test` falla porque falta `vitest`. Es normal; lo instalas en la fase 2.

### Fase 1 — Tipos y métricas

1. Edita `src/types.ts` (sección 4.1).
2. Edita `src/trades.ts` (sección 4.2).
3. Edita `src/metrics.ts` (sección 4.3).
4. Ejecuta `npm run build` y `npm run lint`.

Criterio de fase: la app sigue funcionando y Estadísticas muestra los mismos números que antes.

### Fase 2 — Motor y pruebas

1. Instala Vitest (sección 6.1).
2. Crea `src/backtest.ts` (sección 5).
3. Crea `src/backtest.test.ts` (sección 6.2).
4. Ejecuta `npm test`.

Criterio de fase: todos los tests del motor pasan. Si falla alguno, **no toques la UI todavía**. El motor es la base.

### Fase 3 — Página de backtest

1. Añade `'backtest'` a `PageId` (ya hecho en fase 1).
2. Crea `src/pages/Backtest.tsx` y `Backtest.css` (sección 7).
3. Añade la entrada a `src/navItems.ts` (sección 8.1).
4. Añade el caso en `src/App.tsx` (sección 8.2).
5. Ejecuta `npm run build`, `npm run lint`, `npm run dev`.

Criterio de fase: puedes navegar a Backtest, cargar velas y ejecutar; ves métricas, curva y tabla.

### Fase 4 — Persistencia y Estadísticas

1. Añade el snapshot persistido en `App` (sección 8.2).
2. Pasa `backtest` y `onNavigate` a `Stats` (sección 8.3).
3. Ajusta `TradesTable` (sección 8.4).
4. Ejecuta un backtest y navega a Estadísticas.
5. Recarga la página y comprueba que el snapshot sigue ahí.

Criterio de fase: Estadísticas muestra el backtest y permite volver al ejemplo.

### Fase 5 — QA y pulido

1. Sigue la sección 10.
2. Ejecuta `npm test`, `npm run build`, `npm run lint`.
3. Revisa textos, disclaimers y estados vacíos.
4. Opcional: actualiza `README.md` con la Parte 11.

---

## 10. Criterios de aceptación y pruebas manuales

### 10.1 Comisiones

Configura:

```text
Balance inicial: 1000
Tamaño:          100 %
Stop loss:       50 %
Take profit:     10 %
Comisión:        0.1 % por lado
Slippage:        0 %
Cortos:          desactivado
```

Con una entrada a 100 y una salida a 110, el resultado debe ser:

```text
PnL bruto:  100
Fees:       2.1
PnL neto:   97.9
Balance:    1097.9
```

Si no coincide, revisa la sección 3.

### 10.2 Stop y take profit

- Con `stopLoss` muy bajo (0.2 %) y `takeProfit` alto (10 %), deben abundar los `Stop loss`.
- Con `stopLoss` alto (10 %) y `takeProfit` bajo (0.5 %), deben abundar los `Take profit`.
- Los motivos de salida deben sumar el total de operaciones.

### 10.3 Riesgo diario

Configura:

```text
Stop loss:       2 %
Riesgo diario:   2 %
Tamaño:          100 %
```

Tras la primera pérdida del día, el número de operaciones debe caer de forma visible. Si no, revisa:

- que el día se calcula en UTC,
- que `dayStartBalance` se actualiza al cambiar de día,
- que `dayHalted` se comprueba antes de abrir.

### 10.4 Cortos

Activa “Permitir cortos” y ejecuta el mismo backtest. Deben aparecer operaciones `SELL` con `exitReason` distinto de `signal`. Desactívalo y comprueba que las señales `SELL` ya no abren posiciones.

### 10.5 Sin lookahead

No se puede ver a simple vista, pero puedes comprobarlo así:

1. Ejecuta un backtest.
2. Mira la primera operación.
3. Su `entryTime` debe ser el timestamp de la vela **siguiente** a la señal.
4. Si coincides con el cierre de la vela de la señal, hay lookahead.

El test `entra en la apertura de la vela siguiente` cubre esto automáticamente.

### 10.6 Datos insuficientes

- Con menos de 2 velas, debe aparecer un warning y cero operaciones.
- Con 200 velas y media lenta de 50, debe haber suficiente historia.
- Si Binance falla, debe aparecer el error y el botón “Reintentar”; no debe romper la página.

### 10.7 Persistencia

1. Ejecuta un backtest.
2. Ve a Estadísticas.
3. Debe mostrar el backtest por defecto.
4. Cambia a “Ejemplo”.
5. Recarga la página.
6. Vuelve a Estadísticas: el backtest debe seguir disponible.

### 10.8 Estados vacíos

- Backtest sin operaciones: mensaje claro, sin gráfico roto.
- Estadísticas sin backtest: solo ejemplo, sin selector.
- Snapshot corrupto en localStorage: el validador debe descartarlo y no romper la app.

---

## 11. Errores comunes y cómo evitarlos

### 11.1 Entrar al cierre de la señal

**Síntoma:** resultados demasiado buenos, especialmente en velas grandes.  
**Causa:** usar `signal.price` o `candle.close` como entrada.  
**Solución:** entrar en `data[i + 1].open`.

### 11.2 Cobrar comisión solo al salir

**Síntoma:** el PnL neto es mayor que el esperado.  
**Causa:** olvidar `entryNotional * commissionPct / 100`.  
**Solución:** sumar fee de entrada y de salida; test de la sección 10.1.

### 11.3 Aplicar el take profit antes que el stop

**Síntoma:** backtest optimista cuando una vela tiene mucho rango.  
**Causa:** comprobar `high >= target` antes de `low <= stop`.  
**Solución:** stop primero, siempre.

### 11.4 Ignorar huecos

**Síntoma:** el stop se ejecuta a un precio que nunca se negoció.  
**Causa:** usar `stopPrice` aunque la apertura ya esté por debajo.  
**Solución:** si `open <= stop` en un largo, salir a `open`.

### 11.5 Actualizar el balance con PnL flotante

**Síntoma:** la curva de capital se mueve dentro de velas y el riesgo diario se dispara antes de cerrar.  
**Causa:** mezclar realizado y no realizado.  
**Solución:** en la Parte 11, balance solo al cerrar. Documentarlo.

### 11.6 Redondear demasiado pronto

**Síntoma:** pequeñas diferencias de céntimos que se acumulan.  
**Causa:** redondear el balance en cada cálculo intermedio.  
**Solución:** precisión completa en precios/cantidades; redondear dinero al cerrar operación.

### 11.7 Confundir comisión “por lado” con “por operación”

**Síntoma:** fees al doble o a la mitad.  
**Causa:** el campo no está documentado.  
**Solución:** etiqueta “Comisión por lado” y hint “0.1 = 0.1 % por entrada y por salida”.

### 11.8 Usar `tradePnl()` antiguo con trades de backtest

**Síntoma:** la tabla muestra un PnL distinto al del motor.  
**Causa:** `tradePnl()` ignora `trade.pnl`.  
**Solución:** aplicar la sección 4.2.

### 11.9 Pasar el balance inicial equivocado a las métricas

**Síntoma:** drawdown y retorno no cuadran.  
**Causa:** `computeMetrics()` usa 10 000 por defecto.  
**Solución:** pasar `result.initialBalance` o `snapshot.summary.initialBalance`.

### 11.10 Validar el snapshot demasiado poco

**Síntoma:** un localStorage viejo o corrupto rompe Estadísticas.  
**Causa:** confiar en `JSON.parse` sin comprobar la forma.  
**Solución:** `isBacktestSnapshot` con `version` y validación de trades/resumen.

### 11.11 Ofrecer 5m antes de corregir intervalos

**Síntoma:** `NaN` en timestamps y gráficos vacíos.  
**Causa:** `Interval` incluye `'5m'` pero `intervalMs` no.  
**Solución:** no ofrecer 5m en la Parte 11; corregirlo en una tarea aparte.

### 11.12 Depender de Binance para los tests

**Síntoma:** tests lentos, intermitentes o fallando sin red.  
**Causa:** llamar a la API en pruebas del motor.  
**Solución:** el motor recibe velas; los tests usan fixtures. La red se prueba a mano.

---

## 12. Limitaciones de la Parte 11

Estas limitaciones son aceptables y deben quedar escritas en la UI o en el README:

- Una sola posición a la vez.
- Sin apalancamiento (nocional máximo = balance).
- Sin funding, spread variable, latencia ni liquidez real.
- Slippage y comisión son constantes configurables.
- Stop/objetivo se evalúan con high/low de la vela; no hay datos intradía.
- Si stop y objetivo se tocan en la misma vela, se asume stop.
- La curva es realizada, no mark-to-market.
- El riesgo diario usa balance realizado, no PnL flotante.
- Solo se guarda el último backtest.
- No hay optimización de parámetros ni walk-forward.
- No hay comparación automática contra buy & hold.

Lo que **sí** queda resuelto:

- motor determinista y testeable,
- sin lookahead,
- comisiones y slippage,
- SL/TP realistas dentro de la vela,
- riesgo diario,
- pantalla de configuración y resultados,
- conexión con Estadísticas,
- persistencia del último resultado.

---

## 13. Puente a las partes 12–15

Cuando la Parte 11 esté cerrada, estas son las dependencias naturales:

### Parte 12 — Shadow en el navegador

Reutiliza:

- `BacktestConfig` y `BacktestSettings`,
- `crossoverSignals`,
- la lógica de `resolveExit` y tamaño de posición,
- el formato de trades y métricas.

Cambia:

- velas históricas por velas en vivo,
- `runBacktest` por un motor incremental que procese la última vela cerrada,
- el snapshot por un registro de señales y operaciones en tiempo real.

No dupliques fórmulas: extrae un módulo de ejecución compartido (`src/execution.ts`) si el motor incremental empieza a repetir `resolveExit`, fees y sizing.

### Parte 13 — Backend

El motor de la Parte 11 es puro y no depende del navegador. Eso permite:

- moverlo a un worker,
- ejecutarlo en Node,
- reutilizarlo en tareas programadas,
- persistir resultados en una base de datos.

La configuración y el snapshot ya están serializados en JSON, lo que facilita el traslado.

### Parte 14 — Broker/exchange demo

El adaptador debe recibir órdenes con:

- par,
- lado,
- cantidad,
- stop,
- objetivo,
- límites duros de tamaño y pérdida.

La Parte 11 ya define el sizing y los límites; la Parte 14 añade idempotencia, estados de orden, reconciliación y botón de emergencia.

### Parte 15 — EA de MetaTrader 5

Si eliges el EA autónomo, reimplementa en MQL5:

- cruce de medias,
- sizing,
- SL/TP,
- riesgo diario.

Si eliges el EA ejecutor, el backend de la Parte 13 envía señales y el EA solo ejecuta. En ambos casos, conserva las mismas convenciones de comisión, slippage y prioridad de stop para que los resultados sean comparables.

---

## 14. Anexo: estructura final esperada

```text
flare/
├─ src/
│  ├─ backtest.ts              ← motor puro
│  ├─ backtest.test.ts         ← pruebas del motor
│  ├─ types.ts                 ← PageId, ExitReason, Trade ampliado
│  ├─ trades.ts                ← tradePnl respeta pnl
│  ├─ metrics.ts               ← balance inicial configurable
│  ├─ navItems.ts              ← entrada Backtest
│  ├─ App.tsx                  ← página + snapshot persistido
│  ├─ components/
│  │  ├─ TradesTable.tsx       ← fecha, motivo, PnL neto
│  │  ├─ EquityChart.tsx       ← sin cambios
│  │  └─ ...
│  └─ pages/
│     ├─ Backtest.tsx          ← configuración + resultados
│     ├─ Backtest.css
│     ├─ Stats.tsx             ← fuente sample/backtest
│     └─ ...
├─ package.json                ← vitest en devDependencies
└─ GUIA_PARTE_11_BACKTEST.md   ← este documento
```

### 14.1 Comandos finales

```bash
cd /public/flare
npm install -D vitest
npm test
npm run build
npm run lint
npm run dev
```

### 14.2 Checklist final imprimible

```text
[ ] Tipos: PageId incluye 'backtest'; Trade tiene pnl/entryTime/exitTime/exitReason.
[ ] tradePnl() devuelve trade.pnl si existe.
[ ] computeMetrics/computeEquityPoints aceptan balance inicial.
[ ] backtest.ts no importa React.
[ ] Señal en i, entrada en open de i+1.
[ ] Una posición a la vez.
[ ] Stop primero si ambos niveles se tocan.
[ ] Huecos se ejecutan a la apertura.
[ ] Comisión por lado en entrada y salida.
[ ] Slippage adverso.
[ ] Sizing sin apalancamiento.
[ ] Riesgo diario UTC con reset.
[ ] Posición final cerrada al último close.
[ ] Curva de capital realizada.
[ ] Tests: resolveExit, comisiones, no lookahead, stop priority, short, daily risk, end, slippage, no mutación.
[ ] Backtest.tsx: datos, señal, riesgo, ejecución.
[ ] Resultados: métricas, motivos, curva, tabla.
[ ] Snapshot guardado en localStorage con validador.
[ ] Stats: selector Backtest/Ejemplo.
[ ] TradesTable: PnL neto, fecha, motivo.
[ ] npm test / build / lint pasan.
[ ] QA manual de la sección 10 completada.
```

---

## 15. Nota final

La Parte 11 parece “solo un motor”, pero es la pieza que define la credibilidad de todo lo que venga después. Si el motor tiene lookahead, comisiones mal cobradas o un stop optimista, las partes 12–15 heredarán esos errores y será mucho más caro detectarlos con dinero real o en un entorno demo.

Por eso el orden recomendado es:

1. motor puro,
2. pruebas del motor,
3. UI de configuración,
4. UI de resultados,
5. conexión con Estadísticas,
6. QA manual.

No empieces por la UI. Empieza por los tests y por una única operación que puedas calcular a mano.
