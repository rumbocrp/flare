# FLARE — Guía de idioma: inglés por defecto y español opcional

> **Estado:** documento de instrucciones. **No modifica código.**
> **Objetivo:** que toda la interfaz se muestre en inglés por defecto y que el usuario pueda cambiar entre inglés y español desde Ajustes.
> **Alcance:** textos visibles, etiquetas accesibles, mensajes de error, estados vacíos, avisos y formatos de fecha.
> **Fecha de revisión:** 11 de noviembre de 2026.

---

## 0. Resumen ejecutivo

La aplicación tiene hoy textos en español repartidos por casi todas las páginas y componentes. No existe ninguna capa de internacionalización. La solución recomendada es pequeña y no necesita librerías externas:

1. Añadir `language: 'en' | 'es'` a `AppSettings`.
2. Crear `src/i18n.tsx` con un diccionario inglés/español, un `I18nProvider` y un hook `useI18n()`.
3. Envolver la aplicación con el proveedor usando el idioma guardado.
4. Poner **English** como valor por defecto.
5. Añadir un selector **English / Español** en Ajustes.
6. Sustituir cada texto fijo por `t('clave')`.
7. Traducir también `aria-label`, mensajes de error, estados vacíos y textos generados por la lógica.
8. Guardar la preferencia en `localStorage` mediante el sistema de settings que ya existe.
9. Migrar sin perder el tema de usuarios que ya tengan `{ theme: 'dark' }` guardado.
10. Verificar con `pnpm build`, `pnpm lint`, `pnpm test` y una revisión manual de todas las páginas.

**Resultado esperado:** una instalación nueva abre en inglés; el botón de Ajustes cambia toda la interfaz a español sin recargar; la elección persiste al recargar.

---

## 1. Decisiones que hay que tomar antes de empezar

| Decisión | Recomendación | Motivo |
|---|---|---|
| Idioma por defecto | `en` | Es el requisito actual. |
| Persistencia | `lixtrd:settings` | Ya existe y guarda el tema. |
| Librería i18n | Ninguna; contexto propio | La app es pequeña y no hay dependencias de i18n. |
| Claves | Planas, con prefijo por área (`nav.*`, `stats.*`) | Fáciles de buscar y ordenar. |
| Interpolación | `{count}`, `{pair}`, etc. | Evita concatenar frases. |
| Formatos de fecha | Locale `en-US` / `es-ES` | Cambian con el idioma. |
| Formatos de dinero | Mantener `en-US` y USD | Evita romper tablas y gráficos; el símbolo `$` es universal. |
| Términos de trading | Mantener `BUY`, `SELL`, `SMA`, `EMA`, `Stop loss`, `Take profit` | Son términos estándar y ya se usan así. |
| Señales y warnings guardados | Guardar códigos, no frases traducidas | Un backtest guardado en inglés debe poder verse en español. |
| Reset de datos | Conservar el idioma elegido | El idioma es una preferencia de interfaz, no un dato de estrategia. |

---

## 2. Arquitectura propuesta

```text
src/
├── types.ts                 → Language = 'en' | 'es'; AppSettings.language
├── settings.ts              → defaultSettings.language = 'en'; validación
├── i18n.tsx                 → diccionario, provider, useI18n()
├── App.tsx                  → <I18nProvider>; pasa language a Settings
├── pages/
│   ├── Settings.tsx         → selector English / Español
│   ├── Dashboard.tsx        → textos con t()
│   ├── BotConfig.tsx        → textos y errores con t()
│   ├── BotRun.tsx           → textos con t()
│   ├── Backtest.tsx         → textos con t()
│   └── Stats.tsx            → textos con t()
└── components/
    ├── Sidebar.tsx          → navegación con t()
    ├── EquityChart.tsx      → estado vacío y aria-label
    ├── TradesTable.tsx      → cabeceras, total y estado vacío
    ├── CandleChart.tsx      → leyenda, estado vacío y aria-label
    ├── RsiPanel.tsx         → zonas, estado vacío y aria-label
    ├── SignalsTable.tsx     → cabeceras, estado vacío y motivo
    ├── MarketSection.tsx    → controles, carga, error y fuente
    └── MarketAnalysis.tsx   → subtítulo y disclaimer
```

Flujo de datos:

```text
localStorage ('lixtrd:settings')
        ↓
useLocalStorageState<AppSettings>
        ↓
App calcula language ('en' por defecto)
        ↓
<I18nProvider language={language}>
        ↓
useI18n() → { language, locale, t }
        ↓
Todos los componentes muestran textos traducidos
```

---

## 3. Paso 1 — Tipos y settings

### 3.1. `src/types.ts`

Añadir el tipo de idioma y el campo en `AppSettings`:

```ts
export type Language = 'en' | 'es'

export type AppSettings = {
  theme: ThemeSetting
  language: Language
}
```

No cambiar `PageId`, `ThemeSetting` ni el resto de tipos.

### 3.2. `src/settings.ts`

```ts
import type { AppSettings, Language, ThemeSetting } from './types'

export const defaultSettings: AppSettings = {
  theme: 'dark',
  language: 'en',
}

const themes: ThemeSetting[] = ['dark', 'light', 'system']
const languages: Language[] = ['en', 'es']

export function isAppSettings(value: unknown): value is AppSettings {
  if (typeof value !== 'object' || value === null) return false

  const theme = (value as { theme?: unknown }).theme
  const language = (value as { language?: unknown }).language

  return (
    typeof theme === 'string' &&
    themes.includes(theme as ThemeSetting) &&
    (language === undefined || languages.includes(language as Language))
  )
}
```

**Por qué aceptar `language === undefined`:** los usuarios actuales tienen guardado `{ theme: 'dark' }`. Si se exige `language`, `isAppSettings` devuelve `false`, el hook usa `defaultSettings` y se pierde el tema elegido. Aceptar la ausencia permite migrar.

En `App.tsx`, normalizar siempre:

```ts
const language: Language = settings.language === 'es' ? 'es' : 'en'
```

Así cualquier valor ausente o inválido cae en inglés, que es el valor por defecto.

### 3.3. Migración opcional pero recomendada

Para que la migración se guarde en el primer arranque, añadir en `App.tsx`:

```ts
useEffect(() => {
  if (settings.language !== language) {
    setSettings({ ...settings, language })
  }
}, [language, settings, setSettings])
```

Sin este efecto, el objeto antiguo sigue en `localStorage` hasta que el usuario cambie algo. La interfaz funciona igual porque `language` se calcula al vuelo, pero es más limpieza persistir la migración.

### 3.4. `handleResetAll`

Hoy `handleResetAll` hace:

```ts
setStrategy(defaultStrategy)
setSettings(defaultSettings)
```

Si se restaura todo, el idioma volvería a inglés. Recomendación: conservar el idioma actual:

```ts
function handleResetAll() {
  setStrategy(defaultStrategy)
  setSettings({ ...defaultSettings, language })
}
```

Si se decide que “Restore data” también restablezca el idioma, documentarlo en la interfaz. Lo importante es que sea una decisión explícita.

---

## 4. Paso 2 — Crear `src/i18n.tsx`

### 4.1. Esqueleto

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react'
import type { Language } from './types'

export type LanguageOption = {
  id: Language
  label: string
}

export const languageOptions: LanguageOption[] = [
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Español' },
]

const en = {
  'nav.dashboard': 'Dashboard',
  'nav.botConfig': 'Bot setup',
  'nav.botRun': 'Run bot',
  'nav.backtest': 'Backtest',
  'nav.stats': 'Statistics',
  'nav.settings': 'Settings',
  'nav.simulationMode': 'Simulation mode',
  // ...
} as const

export type TranslationKey = keyof typeof en

const es: Record<TranslationKey, string> = {
  'nav.dashboard': 'Panel',
  'nav.botConfig': 'Ajustar bot',
  'nav.botRun': 'Ejecutar bot',
  'nav.backtest': 'Backtest',
  'nav.stats': 'Estadísticas',
  'nav.settings': 'Ajustes',
  'nav.simulationMode': 'Modo simulación',
  // ...
}

export type Translate = (
  key: TranslationKey,
  vars?: Record<string, string | number>,
) => string

type I18nValue = {
  language: Language
  locale: string
  t: Translate
}

const I18nContext = createContext<I18nValue | null>(null)

function interpolate(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return template

  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name]
    return value === undefined ? match : String(value)
  })
}

export function I18nProvider({
  language,
  children,
}: {
  language: Language
  children: ReactNode
}) {
  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  const t = useCallback<Translate>(
    (key, vars) => {
      const template = language === 'es' ? es[key] : en[key]
      return interpolate(template ?? en[key] ?? key, vars)
    },
    [language],
  )

  const value = useMemo<I18nValue>(
    () => ({
      language,
      locale: language === 'es' ? 'es-ES' : 'en-US',
      t,
    }),
    [language, t],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (!value) {
    throw new Error('useI18n must be used inside I18nProvider')
  }
  return value
}
```

### 4.2. Reglas del diccionario

- El objeto `en` es la fuente de verdad: define todas las claves y el inglés por defecto.
- `es` usa `Record<TranslationKey, string>` para que TypeScript avise si falta una traducción.
- Si una clave falta en español, el provider cae en inglés.
- No se guardan frases interpoladas en `localStorage`; se guardan códigos y se traducen al renderizar.
- Las claves usan `camelCase` después del punto: `backtest.initialBalance`, `stats.winRate`.

---

## 5. Paso 3 — Envolver la aplicación en `App.tsx`

```tsx
import { I18nProvider } from './i18n'
import type { Language } from './types'

// ...
const language: Language = settings.language === 'es' ? 'es' : 'en'

return (
  <I18nProvider language={language}>
    <div className="app">
      <Sidebar activePage={activePage} onNavigate={setActivePage} />
      <main className="content">{renderPage()}</main>
    </div>
  </I18nProvider>
)
```

Además, en el `case 'stats'`:

```tsx
case 'stats':
  return (
    <Stats
      backtest={lastBacktest}
      onNavigate={setActivePage}
    />
  )
```

Y en `Settings`:

```tsx
<Settings
  settings={{ ...settings, language }}
  onChangeSettings={setSettings}
  onResetAll={handleResetAll}
/>
```

Pasar `language` normalizado evita que `Settings` tenga que hacer fallbacks.

---

## 6. Paso 4 — Selector de idioma en Ajustes

Añadir la sección **antes** de Theme, para que sea lo primero que se ve:

```tsx
import { languageOptions, useI18n } from '../i18n'

function Settings({ settings, onChangeSettings, onResetAll }: SettingsProps) {
  const { t } = useI18n()

  // ...

  return (
    <div className="page">
      <PageHeader
        title={t('settings.title')}
        subtitle={t('settings.subtitle')}
      />

      <section className="setting">
        <div className="setting__text">
          <h2 className="setting__title">{t('settings.language')}</h2>
          <p className="setting__desc">{t('settings.languageDesc')}</p>
        </div>

        <div
          className="segmented"
          role="group"
          aria-label={t('settings.language')}
        >
          {languageOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`segmented__option ${
                settings.language === option.id
                  ? 'segmented__option--active'
                  : ''
              }`}
              aria-pressed={settings.language === option.id}
              onClick={() =>
                onChangeSettings({ ...settings, language: option.id })
              }
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      {/* Theme, Trading setup, Stored data... */}
    </div>
  )
}
```

Notas:

- `English` y `Español` se muestran en su propio idioma; no hace falta traducirlos.
- El cambio es inmediato: el estado de `App` cambia, el provider recibe el nuevo `language` y todos los `t()` se recalculan.
- No hace falta recargar la página.
- `aria-pressed` mantiene el estado accesible.

---

## 7. Paso 5 — Inventario de textos por archivo

Esta es la lista de todo lo que hay que externalizar. Los nombres de clave son una propuesta; lo importante es que cada texto fijo desaparezca del JSX.

### 7.1. `src/components/Sidebar.tsx` y `src/navItems.ts`

Hoy `navItems.ts` guarda etiquetas en español. Recomendación: cambiar `label` por `labelKey`:

```ts
import type { TranslationKey } from './i18n'

export type NavItem = {
  id: PageId
  labelKey: TranslationKey
  icon: string
}

export const navItems: NavItem[] = [
  { id: 'dashboard', labelKey: 'nav.dashboard', icon: '▦' },
  { id: 'bot-config', labelKey: 'nav.botConfig', icon: '⚙' },
  { id: 'bot-run', labelKey: 'nav.botRun', icon: '▶' },
  { id: 'backtest', labelKey: 'nav.backtest', icon: '⟲' },
  { id: 'stats', labelKey: 'nav.stats', icon: '◔' },
  { id: 'settings', labelKey: 'nav.settings', icon: '☰' },
]
```

En `Sidebar.tsx`:

```tsx
const { t } = useI18n()

// ...
{t(item.labelKey)}

// footer
<div className="sidebar__footer">{t('nav.simulationMode')}</div>
```

Textos:

| Clave | Inglés | Español |
|---|---|---|
| `nav.dashboard` | Dashboard | Panel |
| `nav.botConfig` | Bot setup | Ajustar bot |
| `nav.botRun` | Run bot | Ejecutar bot |
| `nav.backtest` | Backtest | Backtest |
| `nav.stats` | Statistics | Estadísticas |
| `nav.settings` | Settings | Ajustes |
| `nav.simulationMode` | Simulation mode | Modo simulación |

### 7.2. `src/pages/Dashboard.tsx`

| Clave | Inglés | Español |
|---|---|---|
| `dashboard.balance` | Balance (SIM) | Balance (SIM) |
| `dashboard.dailyPnl` | Daily P/L | P/L diario |
| `dashboard.botStatus` | Bot status | Estado del bot |
| `dashboard.trades` | Trades | Operaciones |
| `status.stopped` | STOP | STOP |
| `status.running` | RUNNING (SIM) | EN MARCHA (SIM) |

Sustituir `botStatusLabels[botStatus]` por:

```tsx
t(botStatus === 'running' ? 'status.running' : 'status.stopped')
```

`botStatus.ts` puede quedarse como utilidad interna, pero la UI no debe depender de sus etiquetas.

### 7.3. `src/pages/BotConfig.tsx`

| Clave | Inglés | Español |
|---|---|---|
| `botConfig.title` | Bot setup | Ajustar bot |
| `botConfig.subtitle` | Configure the strategy and risk limits. | Configura la estrategia y los límites de riesgo. |
| `botConfig.pair` | Pair | Par |
| `botConfig.pairHint` | Market the bot trades. | Mercado en el que opera el bot. |
| `botConfig.positionSize` | Position size | Tamaño de posición |
| `botConfig.positionSizeHint` | Percentage of the balance used per trade. | Porcentaje del balance que usa en cada operación. |
| `botConfig.stopLoss` | Stop loss | Stop loss |
| `botConfig.stopLossHint` | Maximum accepted loss per trade. | Pérdida máxima aceptada por operación. |
| `botConfig.takeProfit` | Take profit | Take profit |
| `botConfig.takeProfitHint` | Target gain per trade. | Ganancia objetivo por operación. |
| `botConfig.maxDailyRisk` | Max daily risk | Riesgo máximo diario |
| `botConfig.maxDailyRiskHint` | Maximum accumulated loss allowed in a day. | Pérdida acumulada máxima permitida en un día. |
| `botConfig.riskReward` | Risk : reward — 1 : {ratio} | Relación riesgo : beneficio — 1 : {ratio} |
| `botConfig.save` | Save | Guardar |
| `botConfig.reset` | Reset | Restablecer |
| `botConfig.unsaved` | You have unsaved changes | Tienes cambios sin guardar |
| `botConfig.saved` | All saved | Todo guardado |

Errores de validación:

| Clave | Inglés | Español |
|---|---|---|
| `validation.number` | Enter a number. | Escribe un número. |
| `validation.range` | Must be between {min} and {max}. | Debe estar entre {min} y {max}. |

`numberError` y `validate` están fuera del componente; pasarles `t` o mover la validación dentro del componente usando `useI18n()`.

### 7.4. `src/pages/BotRun.tsx`

| Clave | Inglés | Español |
|---|---|---|
| `botRun.title` | Run bot | Ejecutar bot |
| `botRun.subtitle` | Start or stop the bot. Simulation only for now. | Inicia o detén el bot. Por ahora, solo en simulación. |
| `botRun.currentStatus` | Current status | Estado actual |
| `botRun.start` | Start | Iniciar |
| `botRun.stop` | Stop | Detener |
| `botRun.activeStrategy` | Active strategy | Estrategia activa |
| `botRun.pair` | Pair | Par |
| `botRun.positionSize` | Position size | Tamaño de posición |
| `botRun.stopLoss` | Stop loss | Stop loss |
| `botRun.takeProfit` | Take profit | Take profit |
| `botRun.maxDailyRisk` | Max daily risk | Riesgo máximo diario |
| `botRun.disclaimer` | The bot does not trade yet: these buttons only change the on-screen status. Everything is simulated. | El bot todavía no opera: estos botones solo cambian el estado en pantalla. Todo es simulación. |

### 7.5. `src/pages/Backtest.tsx`

Es la página con más texto. Claves propuestas:

| Clave | Inglés | Español |
|---|---|---|
| `backtest.title` | Backtest | Backtest |
| `backtest.subtitle` | Simulate the strategy candle by candle with commissions, stop loss and take profit. | Simula la estrategia vela por vela con comisiones, stop loss y take profit. |
| `backtest.data` | Data | Datos |
| `backtest.pair` | Pair | Par |
| `backtest.pairHint` | Market to simulate. | Mercado que se va a simular. |
| `backtest.timeframe` | Timeframe | Temporalidad |
| `backtest.timeframeHint` | Candle size used by the simulation. | Tamaño de vela usado por la simulación. |
| `backtest.candles` | Candles | Velas |
| `backtest.candlesHint` | More candles = more history and more calculation time. | Más velas = más historia y más tiempo de cálculo. |
| `backtest.loadingCandles` | Loading candles… | Cargando velas… |
| `backtest.loadError` | Could not load data: {message} | No se pudieron cargar los datos: {message} |
| `backtest.retry` | Retry | Reintentar |
| `backtest.candleRange` | {count} candles from {from} to {to} UTC. | {count} velas desde {from} hasta {to} UTC. |
| `backtest.signal` | Signal | Señal |
| `backtest.fastAverage` | Fast average | Media rápida |
| `backtest.slowAverage` | Slow average | Media lenta |
| `backtest.averageType` | Average type | Tipo de media |
| `backtest.candleCount` | {count} candles | {count} velas |
| `backtest.riskAndExecution` | Risk and execution | Riesgo y ejecución |
| `backtest.initialBalance` | Initial balance | Balance inicial |
| `backtest.initialBalanceHint` | Capital the simulation starts with. | Capital con el que empieza la simulación. |
| `backtest.positionSize` | Position size | Tamaño de posición |
| `backtest.positionSizeHint` | Percentage of the balance used as notional. | Porcentaje del balance usado como nocional. |
| `backtest.stopLoss` | Stop loss | Stop loss |
| `backtest.stopLossHint` | Distance from entry to stop. | Distancia desde la entrada hasta el stop. |
| `backtest.takeProfit` | Take profit | Take profit |
| `backtest.takeProfitHint` | Distance from entry to target. | Distancia desde la entrada hasta el objetivo. |
| `backtest.maxDailyRisk` | Max daily risk | Riesgo máximo diario |
| `backtest.maxDailyRiskHint` | Realized loss that blocks new entries for the day. | Pérdida realizada que bloquea nuevas entradas ese día. |
| `backtest.commission` | Commission per side | Comisión por lado |
| `backtest.commissionHint` | Charged on entry and exit. 0.1 = 0.1%. | Se cobra al entrar y al salir. 0.1 = 0.1 %. |
| `backtest.slippage` | Slippage | Slippage |
| `backtest.slippageHint` | Adverse slippage on entry and exit. | Deslizamiento adverso en entrada y salida. |
| `backtest.allowShorts` | Allow shorts: a SELL signal opens a short position. | Permitir cortos: una señal SELL abre una posición short. |
| `backtest.run` | Run backtest | Ejecutar backtest |
| `backtest.fixFields` | Fix the highlighted fields. | Corrige los campos marcados. |
| `backtest.configApplied` | The configuration is applied when running. | La configuración se aplica al ejecutar. |
| `backtest.waitForCandles` | Wait for the candles to finish loading. | Espera a que las velas terminen de cargar. |
| `backtest.result` | Result | Resultado |
| `backtest.viewStats` | View in Statistics | Ver en Estadísticas |
| `backtest.resultReadout` | {pair} · {average} {fast}/{slow} · {candles} candles · commission {commission}% per side · {trades} trades | {pair} · {average} {fast}/{slow} · {candles} velas · comisión {commission}% por lado · {trades} operaciones |
| `backtest.accountDepleted` | account depleted | cuenta agotada |
| `backtest.netPnl` | Net PnL | PnL neto |
| `backtest.netPnlHint` | After commissions and slippage | Después de comisiones y slippage |
| `backtest.return` | Return | Retorno |
| `backtest.returnHint` | Over the initial balance | Sobre el balance inicial |
| `backtest.finalBalance` | Final balance | Balance final |
| `backtest.finalBalanceHint` | Initial {amount} | Inicial {amount} |
| `backtest.trades` | Trades | Operaciones |
| `backtest.tradesHint` | {wins} winners · {losses} losers | {wins} ganadoras · {losses} perdedoras |
| `backtest.winRate` | Win rate | Tasa de acierto |
| `backtest.winRateHint` | Winners over total | Ganadoras sobre el total |
| `backtest.profitFactor` | Profit factor | Factor de beneficio |
| `backtest.profitFactorHint` | Gains ÷ losses | Ganancias ÷ pérdidas |
| `backtest.maxDrawdown` | Max drawdown | Mayor caída |
| `backtest.maxDrawdownHint` | {pct} of peak | {pct} del máximo |
| `backtest.feesPaid` | Fees paid | Comisiones pagadas |
| `backtest.feesPaidHint` | Entry + exit | Entrada + salida |
| `backtest.exitReasons` | Exit reasons | Motivos de salida |
| `backtest.balanceEvolution` | Balance evolution | Evolución del balance |
| `backtest.operations` | Operations ({count}) | Operaciones ({count}) |
| `backtest.noTrades` | This configuration generated no trades with these candles. Try another pair, timeframe or moving average periods. | Esta configuración no generó operaciones con estas velas. Prueba otro par, temporalidad o períodos de media. |
| `backtest.disclaimer` | Result based on historical data. It does not include liquidity, funding, latency or spread changes. A backtest does not guarantee future results. Commission configured per side. | Resultado sobre datos históricos. No incluye liquidez, funding, latencia ni cambios de spread. Un backtest no garantiza resultados futuros. Comisión configurada: por lado. |

Además:

- `intervalOptions` debe usar claves: `15 min`, `1 h`, `4 h`, `1 day` / `1 día`.
- `exitReasonLabels` de `backtest.ts` no debe mostrarse directamente. Usar claves `exit.stop`, `exit.target`, `exit.signal`, `exit.end`, `exit.bankrupt`.
- `runError` debe pasar por el traductor (ver sección 8).
- `formatDateTime(point.time, locale)` para las etiquetas del gráfico.

### 7.6. `src/pages/Stats.tsx`

| Clave | Inglés | Español |
|---|---|---|
| `stats.title` | Statistics | Estadísticas |
| `stats.subtitle` | Performance and risk of your trades. | Rendimiento y riesgo de tus operaciones. |
| `stats.balanceEvolution` | Balance evolution | Evolución del balance |
| `stats.riskIndicators` | Risk indicators | Indicadores de riesgo |
| `stats.winRate` | Win rate | Tasa de acierto |
| `stats.winRateHint` | {wins} winners out of {total} | {wins} ganadoras de {total} |
| `stats.profitFactor` | Profit factor | Factor de beneficio |
| `stats.profitFactorHint` | Total gains ÷ total losses | Ganancias totales ÷ pérdidas totales |
| `stats.expectancy` | Expectancy per trade | Expectativa por operación |
| `stats.expectancyHint` | Average result per trade | Resultado promedio de cada operación |
| `stats.maxDrawdown` | Max drawdown | Mayor caída |
| `stats.maxDrawdownHint` | {pct} of peak | {pct} del máximo alcanzado |
| `stats.noDrawdown` | No drawdown | Sin caídas |
| `stats.averageWin` | Average win | Ganancia promedio |
| `stats.averageWinHint` | Average of winning trades | Promedio de las operaciones ganadoras |
| `stats.averageLoss` | Average loss | Pérdida promedio |
| `stats.averageLossHint` | Average of losing trades | Promedio de las operaciones perdedoras |
| `stats.bestTrade` | Best trade | Mejor operación |
| `stats.bestTradeHint` | Largest individual gain | La mayor ganancia individual |
| `stats.worstTrade` | Worst trade | Peor operación |
| `stats.worstTradeHint` | Largest individual loss | La mayor pérdida individual |
| `stats.sampleDisclaimer` | Calculated with sample trades. With so few trades, these numbers are not reliable. | Calculados con las operaciones de ejemplo. Con tan pocas operaciones, estos números no son confiables. |
| `stats.backtestDisclaimer` | Results from the last saved backtest. They do not include liquidity, funding or variable spread. | Resultados del último backtest guardado. No incluyen liquidez, funding ni spread variable. |
| `stats.operations` | Operations ({count}) | Operaciones ({count}) |
| `stats.filterAll` | All | Todas |
| `stats.filterWins` | Winners | Ganadoras |
| `stats.filterLosses` | Losers | Perdedoras |
| `stats.filterAria` | Filter trades | Filtrar operaciones |
| `stats.lastBacktest` | Last backtest: | Último backtest: |
| `stats.lastBacktestReadout` | {pair} · {candles} candles · {date} UTC · {trades} trades | {pair} · {candles} velas · {date} UTC · {trades} operaciones |
| `stats.sourceAria` | Data source | Fuente de datos |
| `stats.sourceBacktest` | Backtest | Backtest |
| `stats.sourceSample` | Sample | Ejemplo |
| `stats.openBacktest` | Open backtest | Abrir backtest |

**Importante:** `Stats.tsx` hoy no compila. Antes de traducirla hay que corregir sus imports y el wiring (ver sección 10).

### 7.7. `src/pages/Settings.tsx`

| Clave | Inglés | Español |
|---|---|---|
| `settings.title` | Settings | Ajustes |
| `settings.subtitle` | Set it up your way. | Configúralo a tu manera. |
| `settings.language` | Language | Idioma |
| `settings.languageDesc` | Choose the interface language. | Elige el idioma de la interfaz. |
| `settings.theme` | Theme | Tema |
| `settings.themeDesc` | Choose how Flare looks. | Elige cómo se ve Flare. |
| `settings.themeDark` | Dark | Oscuro |
| `settings.themeLight` | Light | Claro |
| `settings.themeAuto` | Auto | Auto |
| `settings.tradingSetup` | Trading setup | Configuración de trading |
| `settings.tradingSetupDesc` | FLARE is simulation-only. Production version in development. | FLARE es solo simulación. La versión de producción está en desarrollo. |
| `settings.simulation` | Simulation | Simulación |
| `settings.storedData` | Stored data | Datos guardados |
| `settings.storedDataDesc` | Your strategies, settings and last backtest are saved. The bot status resets to STOP when unsupervised. | Se guardan tus estrategias, ajustes y el último backtest. El estado del bot vuelve a STOP cuando no está supervisado. |
| `settings.resetConfirm` | Are you sure? Your strategies, settings and last backtest will be restored. | ¿Seguro? Tus estrategias, ajustes y último backtest se restablecerán. |
| `settings.resetYes` | Yes, restore data | Sí, restablecer datos |
| `settings.cancel` | Cancel | Cancelar |
| `settings.reset` | Restore data | Restablecer datos |

Cambiar también los textos actuales en inglés que tienen erratas (`restablished`) por inglés correcto.

### 7.8. `src/components/MarketSection.tsx`

| Clave | Inglés | Español |
|---|---|---|
| `market.title` | Market price | Precio del mercado |
| `market.pairAria` | Pair | Par |
| `market.timeframeAria` | Timeframe | Temporalidad |
| `market.interval15m` | 15 min | 15 min |
| `market.interval1h` | 1 h | 1 h |
| `market.interval4h` | 4 h | 4 h |
| `market.interval1d` | 1 day | 1 día |
| `market.fastAverage` | Fast average | Media rápida |
| `market.fastAverageHint` | Reacts quickly to changes. | Reacciona rápido a los cambios. |
| `market.slowAverage` | Slow average | Media lenta |
| `market.slowAverageHint` | Marks the underlying trend. | Marca la tendencia de fondo. |
| `market.averageType` | Average type | Tipo de media |
| `market.averageHint` | SMA: simple average. EMA: gives more weight to recent data. | SMA: promedio simple. EMA: da más peso a lo reciente. |
| `market.candleCount` | {count} candles | {count} velas |
| `market.loading` | Loading candles… | Cargando velas… |
| `market.loadError` | Could not load data: {message} | No se pudieron cargar los datos: {message} |
| `market.retry` | Retry | Reintentar |
| `market.source` | Source: {name}. {description} Hours are in UTC. | Fuente: {name}. {description} Horas en UTC. |
| `market.sourceName` | Binance public API | API pública de Binance |
| `market.sourceDescription` | Real market prices, no keys required. | Precios reales de mercado, sin claves. |

Recomendación: usar `t('market.sourceName')` y `t('market.sourceDescription')` en lugar de `marketDataSource.name/description`, porque esos metadatos están en español. Si se quieren mantener los metadatos del source, añadir `nameKey`/`descriptionKey` al tipo `MarketDataSource`.

### 7.9. `src/components/MarketAnalysis.tsx`

| Clave | Inglés | Español |
|---|---|---|
| `market.signals` | Signals ({count}) | Señales ({count}) |
| `market.signalsDisclaimer` | Signals are an educational example (moving average crossover) and are confirmed at each candle close. They are not a buy or sell recommendation. | Las señales son un ejemplo educativo (cruce de medias) y se confirman al cierre de cada vela. No son una recomendación de compra ni de venta. |

### 7.10. `src/components/CandleChart.tsx`

| Clave | Inglés | Español |
|---|---|---|
| `chart.noCandles` | No candles to show. | No hay velas para mostrar. |
| `chart.candlesAria` | Candlestick chart with {count} candles, from {from} to {to} UTC | Gráfico de velas de {count} velas, de {from} a {to} UTC |
| `chart.candlesAriaSignals` | Candlestick chart with {count} candles, from {from} to {to} UTC, with {signals} signals | Gráfico de velas de {count} velas, de {from} a {to} UTC, con {signals} señales |
| `chart.buy` | Buy | Compra |
| `chart.sell` | Sell | Venta |

Usar `locale` del hook para `formatDateTime(..., locale)`.

### 7.11. `src/components/RsiPanel.tsx`

| Clave | Inglés | Español |
|---|---|---|
| `chart.noRsiData` | Not enough data for RSI. | No hay datos suficientes para el RSI. |
| `chart.rsiHigh` | High zone (≥ {level}) | Zona alta (≥ {level}) |
| `chart.rsiLow` | Low zone (≤ {level}) | Zona baja (≤ {level}) |
| `chart.rsiAria` | RSI panel with {period} periods | Panel de RSI de {period} periodos |

`zoneLabel` está fuera del componente; pasarle `t` o moverla dentro para usar `useI18n()`.

### 7.12. `src/components/SignalsTable.tsx`

| Clave | Inglés | Español |
|---|---|---|
| `signals.candle` | Candle (UTC) | Vela (UTC) |
| `signals.side` | Side | Lado |
| `signals.price` | Reference price | Precio de referencia |
| `signals.reason` | Reason | Motivo |
| `signals.empty` | This strategy generated no signals with this data. | Esta estrategia no generó señales con estos datos. |
| `signals.crossAbove` | {average} {fast} crosses above {average} {slow} | {average} {fast} cruza por encima de {average} {slow} |
| `signals.crossBelow` | {average} {fast} crosses below {average} {slow} | {average} {fast} cruza por debajo de {average} {slow} |

Hoy `signal.reason` se genera en español dentro de `signals.ts`. Para que cambie con el idioma, no mostrar `signal.reason` directamente. Pasar `params` a `SignalsTable` y construir el texto:

```tsx
<SignalsTable signals={signals} params={params} />
```

```tsx
const key = signal.side === 'buy'
  ? 'signals.crossAbove'
  : 'signals.crossBelow'

t(key, {
  average: params.average.toUpperCase(),
  fast: params.fastPeriod,
  slow: params.slowPeriod,
})
```

Alternativa más robusta: cambiar `Signal.reason` por un objeto estructurado (`kind`, `average`, `fastPeriod`, `slowPeriod`) y traducir en el render. Si se opta por esto, actualizar también los tests.

### 7.13. `src/components/EquityChart.tsx`

| Clave | Inglés | Español |
|---|---|---|
| `chart.needPoints` | At least 2 points are needed to draw the chart. | Se necesitan al menos 2 puntos para dibujar el gráfico. |
| `chart.equityAria` | Balance curve: from {from} to {to} in {count} trades | Curva del balance: de {from} a {to} en {count} operaciones |
| `chart.start` | Start | Inicio |

### 7.14. `src/components/TradesTable.tsx`

| Clave | Inglés | Español |
|---|---|---|
| `table.time` | Time | Hora |
| `table.pair` | Pair | Par |
| `table.side` | Side | Lado |
| `table.entry` | Entry | Entrada |
| `table.exit` | Exit | Salida |
| `table.size` | Size | Tamaño |
| `table.result` | Result | Resultado |
| `table.total` | Total | Total |
| `table.empty` | No trades to show. | No hay operaciones para mostrar. |

Cambiar “Hour” por “Time” porque los backtests muestran fecha y hora completas.

### 7.15. `src/components/NumberField.tsx`, `MetricCard.tsx`, `PageHeader.tsx`

No contienen textos propios. Reciben `label`, `hint`, `error`, `title` y `subtitle` como props, así que se traducen en el componente padre. No hay que modificarlos.

### 7.16. `src/botStatus.ts`

Si se mantiene, actualizar las etiquetas a inglés:

```ts
export const botStatusLabels: Record<BotStatus, string> = {
  stopped: 'STOP',
  running: 'RUNNING (SIM)',
}
```

Pero la UI debe usar `t('status.*')` para que español funcione.

---

## 8. Paso 6 — Textos dinámicos, fechas y errores

### 8.1. Fechas

`src/format.ts`:

```ts
export function formatDateTime(
  timestamp: number,
  locale = 'en-US',
): string {
  return new Date(timestamp).toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  })
}
```

Usar `locale` del hook en:

- `CandleChart.tsx`
- `RsiPanel.tsx`
- `SignalsTable.tsx`
- `Backtest.tsx`
- `Stats.tsx`

No cambiar `formatMoney`, `formatPercent` ni `formatPrice` salvo que se quiera una localización numérica completa. Para una app de trading, mantener `en-US` evita inconsistencias entre precios y gráficos.

### 8.2. `computeEquityPoints` y la etiqueta “Start”

`src/metrics.ts` crea el primer punto con `label: 'Start'`. Añadir un parámetro opcional:

```ts
export function computeEquityPoints(
  trades: Trade[],
  initialBalance = startingBalance,
  startLabel = 'Start',
): ChartPoint[] {
  // ...
  const points: ChartPoint[] = [
    { label: startLabel, value: initialBalance },
  ]
  // ...
}
```

En Stats:

```ts
computeEquityPoints(activeTrades, initialBalance, t('chart.start'))
```

### 8.3. Errores de validación del backtest

`src/backtest.ts` lanza mensajes en español:

- “El balance inicial debe ser un número mayor que 0.”
- “El tamaño de posición no puede superar 100 %.”
- “La comisión no puede ser negativa.”
- “La comisión debe ser menor que 100 %.”
- “El deslizamiento no puede ser negativo.”
- “El deslizamiento debe ser menor que 100 %.”
- “El período rápido debe ser un entero positivo.”
- “El período lento debe ser un entero positivo.”
- “El tipo de media debe ser sma o ema.”

Dos opciones:

1. **Rápida:** cambiar los mensajes a inglés. La UI ya valida todos los campos antes de ejecutar, así que en la práctica no se muestran.
2. **Correcta:** definir un error con código y traducirlo en `Backtest.tsx`:

```ts
export type BacktestErrorCode =
  | 'initialBalance'
  | 'positionSize'
  | 'stopLoss'
  | 'takeProfit'
  | 'maxDailyRisk'
  | 'positionSizeMax'
  | 'commissionNegative'
  | 'commissionMax'
  | 'slippageNegative'
  | 'slippageMax'
  | 'fastPeriod'
  | 'slowPeriod'
  | 'averageType'

export class BacktestValidationError extends Error {
  code: BacktestErrorCode

  constructor(code: BacktestErrorCode) {
    super(code)
    this.code = code
  }
}
```

En el `catch` de Backtest:

```ts
if (error instanceof BacktestValidationError) {
  setRunError(t(`backtest.error.${error.code}` as TranslationKey))
} else {
  setRunError(t('backtest.error.generic'))
}
```

La opción 2 evita guardar ni mostrar frases en un idioma fijo.

### 8.4. Warnings del backtest

`backtest.ts` genera:

- “Se necesitan al menos 2 velas para ejecutar el backtest.”
- “El balance llegó a cero. No se abrirán más operaciones.”

Hoy no se muestran en la UI, pero se guardan en `BacktestSnapshot.warnings`. Si se van a mostrar en el futuro, guardar códigos (`'not-enough-candles'`, `'balance-zero'`) y traducir al renderizar. No guardar frases traducidas en `localStorage`.

### 8.5. Motivos de salida

`exitReasonLabels` en `backtest.ts` está en español. En `Backtest.tsx`, sustituir:

```tsx
{exitReasonLabels[reason]}: {exitCounts[reason]}
```

por:

```tsx
{t(`exit.${reason}` as TranslationKey)}: {exitCounts[reason]}
```

Claves:

| Clave | Inglés | Español |
|---|---|---|
| `exit.stop` | Stop loss | Stop loss |
| `exit.target` | Take profit | Take profit |
| `exit.signal` | Opposite signal | Señal contraria |
| `exit.end` | End of data | Fin de datos |
| `exit.bankrupt` | Balance depleted | Balance agotado |

### 8.6. Errores de mercado

`src/market/binance.ts` lanza mensajes en español y `src/hooks/useCandles.ts` usa `'Unknown error'`. La UI muestra `state.message` directamente.

Recomendación:

- Cambiar los `throw` por códigos estables:
  - `'invalid-number'`
  - `'invalid-candle'`
  - `'http:{status}'`
  - `'invalid-response'`
  - `'unknown'`
- Crear un helper `translateMarketError(message, t)` en `i18n.tsx` o `src/market/errors.ts`:

```ts
export function translateMarketError(
  message: string,
  t: Translate,
): string {
  if (message.startsWith('http:')) {
    return t('market.error.http', { status: message.slice(5) })
  }

  switch (message) {
    case 'invalid-number':
      return t('market.error.invalidNumber')
    case 'invalid-candle':
      return t('market.error.invalidCandle')
    case 'invalid-response':
      return t('market.error.invalidResponse')
    default:
      return t('market.error.generic')
  }
}
```

Usarlo en `MarketSection.tsx` y `Backtest.tsx`:

```tsx
{t('market.loadError', { message: translateMarketError(state.message, t) })}
```

### 8.7. Nombres y descripciones de las fuentes de mercado

`binanceSource` y `syntheticSource` tienen `name` y `description` en español. Opciones:

- **Simple:** mostrar `t('market.sourceName')` y `t('market.sourceDescription')` en `MarketSection`.
- **Escalable:** añadir `nameKey` y `descriptionKey` a `MarketDataSource` y traducir con `t(source.nameKey)`.

Para una sola fuente, la opción simple es suficiente.

### 8.8. Plurales

Para evitar “1 trades”, usar frases que no dependan del plural o añadir un helper:

```ts
function plural(
  count: number,
  one: TranslationKey,
  other: TranslationKey,
  t: Translate,
): string {
  return t(count === 1 ? one : other, { count })
}
```

Ejemplo:

```ts
plural(count, 'market.candleOne', 'market.candles', t)
```

No es imprescindible si se usan etiquetas como `Candles: {count}`.

---

## 9. Paso 7 — Migración y persistencia

### 9.1. Casos que hay que cubrir

| Caso | Resultado esperado |
|---|---|
| Sin `lixtrd:settings` | Inglés y tema oscuro. |
| `{ theme: 'light' }` | Inglés, tema claro conservado. |
| `{ theme: 'dark', language: 'es' }` | Español. |
| `{ theme: 'dark', language: 'fr' }` | Inglés y se corrige al guardar. |
| Reset de datos | Inglés si se decidió resetear el idioma; español si se conserva. |

### 9.2. Dónde se guarda

No crear una clave nueva. Usar `lixtrd:settings`, que ya administra `useLocalStorageState`. El objeto nuevo será:

```json
{
  "theme": "dark",
  "language": "en"
}
```

`lixtrd:last-backtest`, `lixtrd:strategy` y `lixtrd:signal-params` no cambian de formato.

### 9.3. Escritura inicial

`useLocalStorageState` guarda en un `useEffect` cuando cambia el valor. Con la migración de `App.tsx` (sección 3.3), el objeto antiguo se actualiza en el primer render. Sin ella, se actualiza cuando el usuario cambia el tema o el idioma.

---

## 10. Bloqueos preexistentes que hay que resolver antes de verificar

La traducción toca `Stats.tsx`, `Backtest.tsx` y `App.tsx`, que hoy tienen errores. `pnpm build` no pasará solo con i18n. Antes o durante la misma tanda hay que corregir:

### 10.1. `Stats.tsx`

- Falta importar `startingBalance` desde `../metrics` (línea 53).
- Falta importar `formatDateTime` desde `../format` (línea 184).
- `visibleTrades` filtra `trades` en lugar de `activeTrades` (línea 66).
- El disclaimer de la sección de riesgo está duplicado y siempre habla de operaciones de ejemplo (líneas 146-149).
- `App.tsx` renderiza `<Stats />` sin `backtest` ni `onNavigate` (línea 78), y `lastBacktest` queda sin usar.

### 10.2. `metrics.ts`

- `computeMetrics` y `computeEquityPoints` reciben `initialBalance` pero usan `startingBalance` (líneas 43-44 y 84-85). El gráfico y el drawdown porcentual quedan mal cuando el backtest usa un balance distinto de 10 000.

### 10.3. `backtest.ts` y `synthetic.ts`

- `backtest.ts:413`: TypeScript estrecha `position` a `never` en `position.side`. Hay que reestructurar la rama de señales o guardar el estado de la posición en una variable separada.
- `synthetic.ts:10`: falta la clave `'5m'` en `volatility: Record<Interval, number>`.

Sin estos arreglos, la guía de idioma se puede implementar, pero no se puede verificar con `pnpm build`.

---

## 11. Paso 8 — Accesibilidad

- Traducir también `aria-label`, `aria-labelledby`, `title` y textos de estado (`role="status"`, `role="alert"`).
- Mantener `aria-pressed` en los botones de idioma, tema y filtros.
- Actualizar `document.documentElement.lang` en el provider (`en` / `es`).
- No confiar solo en el color para el idioma activo: usar `aria-pressed` y la clase activa.
- Comprobar el contraste en ambos temas después de cambiar textos.
- Los textos en inglés suelen ser más cortos; comprobar que no se rompan las tablas ni los botones en móvil.
- Mantener los `alt` y las etiquetas de gráficos traducidos.

---

## 12. Paso 9 — Verificación

### 12.1. Comandos

```powershell
pnpm exec tsc -b --pretty false
pnpm build
pnpm lint
pnpm test
```

### 12.2. Buscar textos en español

```powershell
Select-String -Path "src\**\*.tsx","src\**\*.ts" -Pattern "[áéíóúñ¿¡]"
```

Esa búsqueda no detecta palabras sin acento (`Panel`, `Guardar`, `Detener`). Complementar con:

```powershell
Select-String -Path "src\**\*.tsx","src\**\*.ts" -Pattern "Guardar|Restablecer|Ejecutar|Detener|Iniciar|Ajustes|Estadísticas|Panel|Señal|Media|Balance|Riesgo|Precio|Mercado|Velas|Comisión|Operaciones|Sin caídas|Todas|Ganadoras|Perdedoras|Par|Tamaño|Pérdida|Ganancia|Capital|Fuente|Motivo|Lado|Hora"
```

Revisar los resultados uno por uno: algunos serán comentarios o nombres de tests, no texto visible.

### 12.3. Prueba manual

1. Borrar `lixtrd:settings` o abrir una ventana privada.
2. Comprobar que la app abre en inglés.
3. Ir a Settings → cambiar a Español.
4. Recorrer Dashboard, Bot config, Run bot, Backtest, Statistics y Settings sin recargar.
5. Recargar y comprobar que sigue en español.
6. Cambiar a English y comprobar que todo vuelve al inglés.
7. Guardar `{ theme: 'light' }` en `localStorage`, recargar y verificar que el tema se conserva y el idioma es inglés.
8. Ejecutar un backtest en inglés, cambiar a español y comprobar que las etiquetas cambian pero las cifras no.
9. Revisar fechas, tablas, gráficos, estados vacíos, errores de validación y `aria-label`.
10. Probar 320, 390, 720 y 1280 px.

### 12.4. Checklist de aceptación

- [ ] Una instalación nueva abre en inglés.
- [ ] Settings muestra English / Español.
- [ ] El cambio de idioma es inmediato y sin recarga.
- [ ] La preferencia persiste en `localStorage`.
- [ ] El tema se conserva al migrar settings antiguos.
- [ ] No queda texto visible en español cuando el idioma es English.
- [ ] No queda texto visible en inglés cuando el idioma es Español, salvo términos de trading y nombres propios.
- [ ] Fechas y horas usan el locale correcto.
- [ ] `aria-label` y estados vacíos están traducidos.
- [ ] Los backtests guardados no contienen frases traducidas.
- [ ] `pnpm build`, `pnpm lint` y `pnpm test` pasan.
- [ ] La barra móvil y las tablas no se rompen con los textos nuevos.

---

## 13. Orden de implementación recomendado

1. **Base:** `types.ts`, `settings.ts`, `i18n.tsx`, `App.tsx`.
2. **Selector:** `Settings.tsx`.
3. **Navegación:** `navItems.ts`, `Sidebar.tsx`.
4. **Componentes compartidos:** `EquityChart.tsx`, `TradesTable.tsx`.
5. **Páginas simples:** `Dashboard.tsx`, `BotConfig.tsx`, `BotRun.tsx`.
6. **Mercado:** `MarketSection.tsx`, `MarketAnalysis.tsx`, `CandleChart.tsx`, `RsiPanel.tsx`, `SignalsTable.tsx`.
7. **Backtest y Stats:** primero corregir los bloqueos de la sección 10, después traducir.
8. **Lógica:** `signals.ts`, `backtest.ts`, `binance.ts`, `format.ts`, `metrics.ts`.
9. **QA:** búsqueda de textos, pruebas manuales y build.

No empezar por Backtest o Stats: son las páginas con más texto y las que hoy no compilan. Primero la base y las páginas simples permiten validar el sistema con poco riesgo.

---

## 14. Riesgos y errores comunes

| Riesgo | Síntoma | Mitigación |
|---|---|---|
| Guardar frases traducidas en `localStorage` | Un backtest guardado en inglés se ve en inglés aunque el idioma sea español | Guardar códigos y traducir al renderizar. |
| Validar `language` como obligatorio | Usuarios con settings antiguos pierden el tema | Aceptar `undefined` y normalizar a `en`. |
| Traducir nombres de pares | `BTC/USDT` se convierte en otra cosa | No traducir datos de mercado. |
| Traducir `BUY`/`SELL` | Se rompen los estilos `side--buy`/`side--sell` | Traducir solo la etiqueta visible, no el valor interno. |
| Duplicar claves | Una pantalla queda en español | `Record<TranslationKey, string>` obliga a completar todas. |
| Import circular | Error de inicialización | `i18n.tsx` solo importa el tipo `Language`; usar `import type`. |
| Textos largos en móvil | Botones o tablas desbordan | Probar 320 px y usar `white-space`/`min-width` con cuidado. |
| Fechas en inglés dentro de español | Inconsistencia visible | Pasar `locale` a `formatDateTime`. |
| Errores de red en español | Mensaje en el idioma equivocado | Códigos de error + helper de traducción. |
| Reset borra el idioma | El usuario vuelve a inglés sin querer | Conservar `language` en `handleResetAll`. |

---

## 15. Checklist final por archivo

| Archivo | Acción |
|---|---|
| `src/types.ts` | Añadir `Language` y `AppSettings.language`. |
| `src/settings.ts` | Default `en`, validación y migración. |
| `src/i18n.tsx` | Nuevo: diccionario, provider, hook, `languageOptions`. |
| `src/App.tsx` | Provider, normalización, props de Stats, Settings normalizado. |
| `src/navItems.ts` | `label` → `labelKey`. |
| `src/components/Sidebar.tsx` | `t()` en navegación y footer. |
| `src/pages/Dashboard.tsx` | `t()` en KPIs y estado. |
| `src/pages/BotConfig.tsx` | `t()` en labels, hints, botones, validación y ratio. |
| `src/pages/BotRun.tsx` | `t()` en estado, botones, resumen y disclaimer. |
| `src/pages/Settings.tsx` | `t()` + selector de idioma. |
| `src/pages/Backtest.tsx` | `t()` en todo; errores y fechas. |
| `src/pages/Stats.tsx` | `t()` en todo; corregir imports y datos. |
| `src/components/EquityChart.tsx` | `t()` en vacío y aria. |
| `src/components/TradesTable.tsx` | `t()` en cabeceras, total y vacío. |
| `src/components/MarketSection.tsx` | `t()` en controles, carga, error y fuente. |
| `src/components/MarketAnalysis.tsx` | `t()` en subtítulo y disclaimer. |
| `src/components/CandleChart.tsx` | `t()` en leyenda, vacío y aria; locale. |
| `src/components/RsiPanel.tsx` | `t()` en zonas, vacío y aria; locale. |
| `src/components/SignalsTable.tsx` | `t()` en cabeceras, vacío y motivo. |
| `src/components/NumberField.tsx` | Sin cambios: recibe props. |
| `src/components/MetricCard.tsx` | Sin cambios: recibe props. |
| `src/components/PageHeader.tsx` | Sin cambios: recibe props. |
| `src/format.ts` | `formatDateTime(timestamp, locale)`. |
| `src/metrics.ts` | Usar `initialBalance`; `startLabel` opcional. |
| `src/signals.ts` | Evitar frases en español en `reason`. |
| `src/backtest.ts` | Errores/warnings por código o inglés. |
| `src/market/binance.ts` | Errores por código o inglés. |
| `src/market/synthetic.ts` | Metadatos en inglés; añadir `'5m'` a `volatility`. |
| `src/hooks/useCandles.ts` | `'unknown'` en vez de `'Unknown error'`. |
| `index.html` | `lang="en"` ya está; el provider lo actualiza. |

---

## Apéndice A — Ejemplo de diccionario inicial

```ts
const en = {
  'nav.dashboard': 'Dashboard',
  'nav.botConfig': 'Bot setup',
  'nav.botRun': 'Run bot',
  'nav.backtest': 'Backtest',
  'nav.stats': 'Statistics',
  'nav.settings': 'Settings',
  'nav.simulationMode': 'Simulation mode',

  'status.stopped': 'STOP',
  'status.running': 'RUNNING (SIM)',

  'common.save': 'Save',
  'common.reset': 'Reset',
  'common.retry': 'Retry',
  'common.cancel': 'Cancel',

  'validation.number': 'Enter a number.',
  'validation.range': 'Must be between {min} and {max}.',

  'settings.title': 'Settings',
  'settings.subtitle': 'Set it up your way.',
  'settings.language': 'Language',
  'settings.languageDesc': 'Choose the interface language.',

  'market.title': 'Market price',
  'market.loading': 'Loading candles…',
  'market.loadError': 'Could not load data: {message}',
  'market.retry': 'Retry',

  'chart.noCandles': 'No candles to show.',
  'chart.needPoints': 'At least 2 points are needed to draw the chart.',
  'chart.start': 'Start',
  'chart.buy': 'Buy',
  'chart.sell': 'Sell',

  'table.time': 'Time',
  'table.pair': 'Pair',
  'table.side': 'Side',
  'table.entry': 'Entry',
  'table.exit': 'Exit',
  'table.size': 'Size',
  'table.result': 'Result',
  'table.total': 'Total',
  'table.empty': 'No trades to show.',
} as const
```

El diccionario final debe incluir todas las claves de la sección 7.

---

## Apéndice B — Criterio para considerar terminada la tarea

La tarea está terminada cuando:

1. `defaultSettings.language === 'en'`.
2. `Settings` permite cambiar a `es` y volver a `en`.
3. Todos los textos visibles de `src/components` y `src/pages` pasan por `t()`.
4. Los textos generados por lógica (señales, errores, warnings, motivos de salida) no están fijos en español.
5. Las fechas cambian de locale.
6. La preferencia persiste y migra sin perder el tema.
7. `pnpm build`, `pnpm lint` y `pnpm test` pasan.
8. La revisión manual en inglés y español no encuentra textos mezclados.

---

> **Recordatorio:** este documento es solo un plan. No se ha modificado ningún archivo de `src/`. La implementación debe hacerse en una tanda separada, empezando por `types.ts`, `settings.ts`, `i18n.tsx` y `App.tsx`.
