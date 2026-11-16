import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Language } from './types'

type LanguageOption = {
  id: Language
  label: string
}

export const languageOptions: LanguageOption[] = [
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Español' },
]

const en = {
  // Navigation & Dock
  'nav.dashboard': 'Dashboard',
  'nav.terminal': 'Chart Studio',
  'nav.botConfig': 'Bot setup',
  'nav.botRun': 'Run bot',
  'nav.backtest': 'Backtest',
  'nav.predictions': 'Predictions',
  'nav.stats': 'Statistics',
  'nav.settings': 'Settings',
  'nav.mainAria': 'Main navigation',
  'nav.moreOptions': 'More options',
  'nav.more': 'More',
  'nav.moreActive': 'More · current',
  'nav.backTo': 'Back to {page}',
  'nav.backAria': 'Return to {page}',

  // Bot status
  'status.stopped': 'STOP',
  'status.running': 'RUNNING (SIM)',

  // Validation
  'validation.number': 'Enter a number.',
  'validation.range': 'Must be between {min} and {max}.',

  // BotConfig
  'botConfig.title': 'Bot setup',
  'botConfig.subtitle': 'Configure the strategy and risk limits.',
  'botConfig.pair': 'Pair',
  'botConfig.pairHint': 'Market the bot trades.',
  'botConfig.positionSize': 'Position size',
  'botConfig.positionSizeHint': 'Percentage of the balance used per trade.',
  'botConfig.stopLoss': 'Stop loss',
  'botConfig.stopLossHint': 'Maximum accepted loss per trade.',
  'botConfig.takeProfit': 'Take profit',
  'botConfig.takeProfitHint': 'Target gain per trade.',
  'botConfig.maxDailyRisk': 'Max daily risk',
  'botConfig.maxDailyRiskHint': 'Maximum accumulated loss allowed in a day.',
  'botConfig.riskReward': 'Risk : reward — 1 : {ratio}',
  'botConfig.save': 'Save',
  'botConfig.reset': 'Reset',
  'botConfig.unsaved': 'You have unsaved changes',
  'botConfig.saved': 'All saved',
  'botConfig.tryBacktest': 'Test in Backtest',
  'botConfig.runBot': 'Run bot',

  // BotRun
  'botRun.title': 'Run bot',
  'botRun.subtitle': 'Start or stop the bot. Simulation only for now.',
  'botRun.currentStatus': 'Current status',
  'botRun.start': 'Start',
  'botRun.stop': 'Stop',
  'botRun.pair': 'Pair',
  'botRun.positionSize': 'Position size',
  'botRun.stopLoss': 'Stop loss',
  'botRun.takeProfit': 'Take profit',
  'botRun.maxDailyRisk': 'Max daily risk',
  'botRun.editParams': 'Bot setup',
  'botRun.runBacktest': 'Backtest',
  'botRun.viewStats': 'Statistics',
  'botRun.disclaimer':
    'The bot does not trade yet: these buttons only change the on-screen status. Everything is simulated.',

  // Backtest
  'backtest.title': 'Backtest',
  'backtest.subtitle':
    'Simulate the strategy candle by candle with commissions, stop loss and take profit.',
  'backtest.data': 'Data',
  'backtest.pair': 'Pair',
  'backtest.pairHint': 'Market to simulate.',
  'backtest.timeframe': 'Timeframe',
  'backtest.timeframeHint': 'Candle size used by the simulation.',
  'backtest.candles': 'Candles',
  'backtest.candlesHint': 'More candles = more history and more calculation time.',
  'backtest.loadingCandles': 'Loading candles…',
  'backtest.loadError': 'Could not load data: {message}',
  'backtest.retry': 'Retry',
  'backtest.candleRange': '{count} candles from {from} to {to} UTC.',
  'backtest.signal': 'Signal',
  'backtest.fastAverage': 'Fast average',
  'backtest.slowAverage': 'Slow average',
  'backtest.averageType': 'Average type',
  'backtest.candleCount': '{count} candles',
  'backtest.riskAndExecution': 'Risk and execution',
  'backtest.initialBalance': 'Initial balance',
  'backtest.initialBalanceHint': 'Capital the simulation starts with.',
  'backtest.positionSize': 'Position size',
  'backtest.positionSizeHint': 'Percentage of the balance used as notional.',
  'backtest.stopLoss': 'Stop loss',
  'backtest.stopLossHint': 'Distance from entry to stop.',
  'backtest.takeProfit': 'Take profit',
  'backtest.takeProfitHint': 'Distance from entry to target.',
  'backtest.maxDailyRisk': 'Max daily risk',
  'backtest.maxDailyRiskHint':
    'Realized loss that blocks new entries for the day.',
  'backtest.commission': 'Commission per side',
  'backtest.commissionHint': 'Charged on entry and exit. 0.1 = 0.1%.',
  'backtest.slippage': 'Slippage',
  'backtest.slippageHint': 'Adverse slippage on entry and exit.',
  'backtest.allowShorts': 'Allow shorts: a SELL signal opens a short position.',
  'backtest.run': 'Run backtest',
  'backtest.fixFields': 'Fix the highlighted fields.',
  'backtest.configApplied': 'The configuration is applied when running.',
  'backtest.waitForCandles': 'Wait for the candles to finish loading.',
  'backtest.result': 'Result',
  'backtest.editStrategy': 'Adjust strategy',
  'backtest.runBot': 'Go to Run bot',
  'backtest.viewStats': 'View in Statistics',
  'backtest.resultReadout':
    '{pair} · {average} {fast}/{slow} · {candles} candles · commission {commission}% per side · {trades} trades',
  'backtest.accountDepleted': 'account depleted',
  'backtest.netPnl': 'Net PnL',
  'backtest.netPnlHint': 'After commissions and slippage',
  'backtest.return': 'Return',
  'backtest.returnHint': 'Over the initial balance',
  'backtest.finalBalance': 'Final balance',
  'backtest.finalBalanceHint': 'Initial {amount}',
  'backtest.trades': 'Trades',
  'backtest.tradesHint': '{wins} winners · {losses} losers',
  'backtest.winRate': 'Win rate',
  'backtest.winRateHint': 'Winners over total',
  'backtest.profitFactor': 'Profit factor',
  'backtest.profitFactorHint': 'Gains ÷ losses',
  'backtest.maxDrawdown': 'Max drawdown',
  'backtest.maxDrawdownHint': '{pct} of peak',
  'backtest.feesPaid': 'Fees paid',
  'backtest.feesPaidHint': 'Entry + exit',
  'backtest.exitReasons': 'Exit reasons',
  'backtest.balanceEvolution': 'Balance evolution',
  'backtest.operations': 'Operations ({count})',
  'backtest.noTrades':
    'This configuration generated no trades with these candles. Try another pair, timeframe or moving average periods.',
  'backtest.disclaimer':
    'Result based on historical data. It does not include liquidity, funding, latency or spread changes. A backtest does not guarantee future results. Commission configured per side.',

  // Exit reasons
  'exit.stop': 'Stop loss',
  'exit.target': 'Take profit',
  'exit.signal': 'Opposite signal',
  'exit.end': 'End of data',
  'exit.bankrupt': 'Balance depleted',

  // Terminal & Predictions nav
  'terminal.backToStats': 'Back to Statistics',
  'predictions.runBot': 'Run in Bot',

  // Stats
  'stats.title': 'Statistics',
  'stats.subtitle': 'Strategy performance, edge margin, and execution risk.',
  'stats.openTerminal': 'Chart Studio',
  'stats.sourceAria': 'Data source',
  'stats.sourceBacktest': 'Backtest',
  'stats.sourceBot': 'Bot',
  'stats.sourceSample': 'Sample',
  'stats.emptyBacktest':
    'No saved backtest yet. Run a historical simulation to inspect exits, fees, and real edge.',
  'stats.emptyBot':
    'The bot has not closed any Spot positions in this session yet.',
  'stats.openBacktest': 'Open backtest',
  'stats.openBot': 'Go to Run Bot',
  'stats.viewSample': 'View sample',
  'stats.netReturn': 'Net return',
  'stats.netReturnHint': '{pct} · Final {balance}',
  'stats.winRate': 'Win rate',
  'stats.winRateEdgeHint': '{wins}/{total} · Break-even {be} ({edge})',
  'stats.winRateHint': '{wins} winners out of {total}',
  'stats.profitFactor': 'Profit factor',
  'stats.pfExpectancyHint': 'Expectancy {exp}/op',
  'stats.pfExpectancyRHint': 'Expectancy {exp} ({r}R/op)',
  'stats.maxDrawdown': 'Max drawdown',
  'stats.noDrawdown': 'No drawdown',
  'stats.drawdownRecoveryHint': '{dd} peak · Recov. {rec}×',
  'stats.drawdownLossStreakHint': '{dd} peak · Max {streak}L streak',
  'stats.balanceEvolution': 'Balance evolution',
  'stats.equityMeta': 'Start {initial} · {count} ops',
  'stats.bestTrade': 'Best trade',
  'stats.worstTrade': 'Worst trade',
  'stats.currentStreak': 'Current streak',
  'stats.streakWin': '{count}W',
  'stats.streakLoss': '{count}L',
  'stats.streakFlat': 'Flat',
  'stats.diagnosticsTitle': 'Strategy diagnostics',
  'stats.diagTabAria': 'Diagnostic view',
  'stats.diagEdge': 'Edge',
  'stats.diagPairs': 'Pairs',
  'stats.diagExits': 'Exits',
  'stats.breakEvenMeter': 'Win rate vs break-even',
  'stats.breakEvenLabel': 'Break-even {pct}',
  'stats.averageWin': 'Average win',
  'stats.averageLoss': 'Average loss',
  'stats.payoffRealized': 'Realized payoff',
  'stats.targetRiskReward': 'Configured R:R',
  'stats.worstLossStreak': 'Worst loss streak',
  'stats.recoveryFactor': 'Recovery factor',
  'stats.longBias': 'Long (BUY)',
  'stats.shortBias': 'Short (SELL)',
  'stats.streakEstRisk': '{count}L (~{pct}% est. risk)',
  'stats.insightPositive':
    'Realized win rate holds a +{pp} pp buffer above break-even vs {pair} settings.',
  'stats.insightNegative':
    'Win rate trails break-even by {pp} pp — review SL/TP levels visually in Chart Studio.',
  'stats.insightNeutral':
    'Short or balanced sample — inspect SL (-{sl}%) and TP (+{tp}%) visually on live candles.',
  'stats.calibrateTerminal': 'Calibrate in Terminal',
  'stats.pairsHint': 'Select a pair to filter the operations table below.',
  'stats.clearPairFilter': 'All pairs',
  'stats.pairMeta': '{wins}/{total} wins · {wr}',
  'stats.exitsBreakdown': 'Exit drivers',
  'stats.totalFees': 'Total commissions',
  'stats.feeDrag': '{pct}% of gross profit',
  'stats.noExitData':
    'Exit reasons and commission drag are recorded from Backtest or live Bot executions.',
  'stats.operations': 'Operations ({count})',
  'stats.filterAll': 'All',
  'stats.filterWins': 'Winners',
  'stats.filterLosses': 'Losers',
  'stats.filterAria': 'Filter trades',
  'stats.lastBacktest': 'Last backtest:',
  'stats.lastBacktestReadout':
    '{pair} · {candles} candles · {date} UTC · {trades} trades',
  'stats.sampleDisclaimer':
    'Calculated with sample trades. Use Backtest or Bot executions to evaluate real strategies.',
  'stats.backtestDisclaimer':
    'Results from the last saved backtest. They do not include liquidity, funding or variable spread.',
  'stats.botDisclaimer':
    'Closed Spot operations recorded by the simulation bot in this session.',

  // Settings
  'settings.title': 'Settings',
  'settings.subtitle': 'Set it up your way.',
  'settings.language': 'Language',
  'settings.languageDesc': 'Choose the interface language.',
  'settings.theme': 'Theme',
  'settings.themeDesc': 'Choose how Flare looks.',
  'settings.themeDark': 'Dark',
  'settings.themeLight': 'Light',
  'settings.themeAuto': 'Auto',
  'settings.tradingSetup': 'Trading setup',
  'settings.tradingSetupDesc':
    'FLARE is simulation-only. Production version in development.',
  'settings.simulation': 'Simulation',
  'settings.storedData': 'Stored data',
  'settings.storedDataDesc':
    'Your strategies, settings and last backtest are saved. The bot status resets to STOP when unsupervised.',
  'settings.resetConfirm':
    'Are you sure? Your strategies, settings and last backtest will be restored.',
  'settings.resetYes': 'Yes, restore data',
  'settings.cancel': 'Cancel',
  'settings.reset': 'Restore data',

  // Market & Analysis
  'market.title': 'Market price',
  'market.pairAria': 'Pair',
  'market.timeframeAria': 'Timeframe',
  'market.interval5m': '5 min',
  'market.interval15m': '15 min',
  'market.interval1h': '1 h',
  'market.interval4h': '4 h',
  'market.interval1d': '1 day',

  // Chart Studio
  'studio.expand': 'Expand',
  'studio.collapse': 'Exit Studio',
  'studio.candleStyle': 'Candle style',
  'studio.styleCandles': 'Candles',
  'studio.styleHollow': 'Hollow',
  'studio.styleHeikin': 'Heikin Ashi',
  'studio.indicators': 'Indicators',
  'studio.overlaysGroup': 'Price Overlays',
  'studio.panesGroup': 'Oscillator Panes',
  'studio.magnet': 'OHLC Magnet',
  'studio.measure': 'Measure',
  'studio.undo': 'Undo',
  'studio.clear': 'Clear',
  'studio.resetView': 'Reset View',
  'studio.togglePanel': 'Workspace Panel',
  'studio.tabStrategies': 'Strategies',
  'studio.tabIndicators': 'Indicators',
  'studio.tabTrade': 'Trade',
  'studio.maTuner': 'Signal Averages',
  'studio.consensus': 'Technical Consensus',
  'studio.signalsJumpHint': 'Click any crossover signal to inspect that bar',
  'studio.analyzePresets': 'Backtest All 8 on Feed',
  'studio.analyzingPresets': 'Evaluating ({done}/{total})…',
  'studio.applyPreset': 'Apply to Studio',
  'studio.appliedPreset': 'Active',
  'studio.predictionRules': 'Quantitative Rules ({tf})',
  'studio.noPredictionRules': 'No dedicated rule set for {tf}. Switch to 5m, 15m, 1h, 4h, or 1d.',
  'studio.riskCalibration': 'TP / SL & Position Calibration',
  'studio.saveLevels': 'Save Levels',
  'market.fastAverage': 'Fast average',
  'market.fastAverageHint': 'Reacts quickly to changes.',
  'market.slowAverage': 'Slow average',
  'market.slowAverageHint': 'Marks the underlying trend.',
  'market.averageType': 'Average type',
  'market.averageHint':
    'SMA: simple average. EMA: gives more weight to recent data.',
  'market.candleCount': '{count} candles',
  'market.loading': 'Loading candles…',
  'market.loadError': 'Could not load data: {message}',
  'market.retry': 'Retry',
  'market.source': 'Source: {name}. {description} Hours are in UTC.',
  'market.sourceName': 'Binance public API',
  'market.sourceDescription': 'Real market prices, no keys required.',
  'market.signals': 'Signals ({count})',
  'market.signalsDisclaimer':
    'Signals are an educational example (moving average crossover) and are confirmed at each candle close. They are not a buy or sell recommendation.',

  // Charts & Tables
  'chart.noCandles': 'No candles to show.',
  'chart.candlesAria':
    'Candlestick chart with {count} candles, from {from} to {to} UTC',
  'chart.candlesAriaSignals':
    'Candlestick chart with {count} candles, from {from} to {to} UTC, with {signals} signals',
  'chart.buy': 'Buy',
  'chart.sell': 'Sell',
  'chart.noRsiData': 'Not enough data for RSI.',
  'chart.rsiHigh': 'High zone (≥ {level})',
  'chart.rsiLow': 'Low zone (≤ {level})',
  'chart.rsiAria': 'RSI panel with {period} periods',
  'chart.needPoints': 'At least 2 points are needed to draw the chart.',
  'chart.equityAria': 'Balance curve: from {from} to {to} in {count} trades',
  'chart.start': 'Start',

  'signals.candle': 'Candle (UTC)',
  'signals.side': 'Side',
  'signals.price': 'Reference price',
  'signals.reason': 'Reason',
  'signals.empty': 'This strategy generated no signals with this data.',
  'signals.crossAbove': '{average} {fast} crosses above {average} {slow}',
  'signals.crossBelow': '{average} {fast} crosses below {average} {slow}',

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

export type TranslationKey = keyof typeof en

const es: Record<TranslationKey, string> = {
  // Navigation & Dock
  'nav.dashboard': 'Panel',
  'nav.terminal': 'Terminal Gráfica',
  'nav.botConfig': 'Ajustar bot',
  'nav.botRun': 'Ejecutar bot',
  'nav.backtest': 'Backtest',
  'nav.predictions': 'Predicciones',
  'nav.stats': 'Estadísticas',
  'nav.settings': 'Ajustes',
  'nav.mainAria': 'Navegación principal',
  'nav.moreOptions': 'Más opciones',
  'nav.more': 'Más',
  'nav.moreActive': 'Más · actual',
  'nav.backTo': 'Volver a {page}',
  'nav.backAria': 'Volver a {page}',

  // Bot status
  'status.stopped': 'STOP',
  'status.running': 'EN MARCHA (SIM)',

  // Validation
  'validation.number': 'Escribe un número.',
  'validation.range': 'Debe estar entre {min} y {max}.',

  // BotConfig
  'botConfig.title': 'Ajustar bot',
  'botConfig.subtitle': 'Configura la estrategia y los límites de riesgo.',
  'botConfig.pair': 'Par',
  'botConfig.pairHint': 'Mercado en el que opera el bot.',
  'botConfig.positionSize': 'Tamaño de posición',
  'botConfig.positionSizeHint':
    'Porcentaje del balance que usa en cada operación.',
  'botConfig.stopLoss': 'Stop loss',
  'botConfig.stopLossHint': 'Pérdida máxima aceptada por operación.',
  'botConfig.takeProfit': 'Take profit',
  'botConfig.takeProfitHint': 'Ganancia objetivo por operación.',
  'botConfig.maxDailyRisk': 'Riesgo máximo diario',
  'botConfig.maxDailyRiskHint':
    'Pérdida acumulada máxima permitida en un día.',
  'botConfig.riskReward': 'Relación riesgo : beneficio — 1 : {ratio}',
  'botConfig.save': 'Guardar',
  'botConfig.reset': 'Restablecer',
  'botConfig.unsaved': 'Tienes cambios sin guardar',
  'botConfig.saved': 'Todo guardado',
  'botConfig.tryBacktest': 'Probar en Backtest',
  'botConfig.runBot': 'Ejecutar bot',

  // BotRun
  'botRun.title': 'Ejecutar bot',
  'botRun.subtitle': 'Inicia o detén el bot. Por ahora, solo en simulación.',
  'botRun.currentStatus': 'Estado actual',
  'botRun.start': 'Iniciar',
  'botRun.stop': 'Detener',
  'botRun.pair': 'Par',
  'botRun.positionSize': 'Tamaño de posición',
  'botRun.stopLoss': 'Stop loss',
  'botRun.takeProfit': 'Take profit',
  'botRun.maxDailyRisk': 'Riesgo máximo diario',
  'botRun.editParams': 'Ajustar bot',
  'botRun.runBacktest': 'Backtest',
  'botRun.viewStats': 'Estadísticas',
  'botRun.disclaimer':
    'El bot todavía no opera: estos botones solo cambian el estado en pantalla. Todo es simulación.',

  // Backtest
  'backtest.title': 'Backtest',
  'backtest.subtitle':
    'Simula la estrategia vela por vela con comisiones, stop loss y take profit.',
  'backtest.data': 'Datos',
  'backtest.pair': 'Par',
  'backtest.pairHint': 'Mercado que se va a simular.',
  'backtest.timeframe': 'Temporalidad',
  'backtest.timeframeHint': 'Tamaño de vela usado por la simulación.',
  'backtest.candles': 'Velas',
  'backtest.candlesHint': 'Más velas = más historia y más tiempo de cálculo.',
  'backtest.loadingCandles': 'Cargando velas…',
  'backtest.loadError': 'No se pudieron cargar los datos: {message}',
  'backtest.retry': 'Reintentar',
  'backtest.candleRange': '{count} velas desde {from} hasta {to} UTC.',
  'backtest.signal': 'Señal',
  'backtest.fastAverage': 'Media rápida',
  'backtest.slowAverage': 'Media lenta',
  'backtest.averageType': 'Tipo de media',
  'backtest.candleCount': '{count} velas',
  'backtest.riskAndExecution': 'Riesgo y ejecución',
  'backtest.initialBalance': 'Balance inicial',
  'backtest.initialBalanceHint': 'Capital con el que empieza la simulación.',
  'backtest.positionSize': 'Tamaño de posición',
  'backtest.positionSizeHint': 'Porcentaje del balance usado como nocional.',
  'backtest.stopLoss': 'Stop loss',
  'backtest.stopLossHint': 'Distancia desde la entrada hasta el stop.',
  'backtest.takeProfit': 'Take profit',
  'backtest.takeProfitHint': 'Distancia desde la entrada hasta el objetivo.',
  'backtest.maxDailyRisk': 'Riesgo máximo diario',
  'backtest.maxDailyRiskHint':
    'Pérdida realizada que bloquea nuevas entradas ese día.',
  'backtest.commission': 'Comisión por lado',
  'backtest.commissionHint': 'Se cobra al entrar y al salir. 0.1 = 0.1 %.',
  'backtest.slippage': 'Slippage',
  'backtest.slippageHint': 'Deslizamiento adverso en entrada y salida.',
  'backtest.allowShorts':
    'Permitir cortos: una señal SELL abre una posición short.',
  'backtest.run': 'Ejecutar backtest',
  'backtest.fixFields': 'Corrige los campos marcados.',
  'backtest.configApplied': 'La configuración se aplica al ejecutar.',
  'backtest.waitForCandles': 'Espera a que las velas terminen de cargar.',
  'backtest.result': 'Resultado',
  'backtest.editStrategy': 'Ajustar estrategia',
  'backtest.runBot': 'Ir a Ejecutar bot',
  'backtest.viewStats': 'Ver en Estadísticas',
  'backtest.resultReadout':
    '{pair} · {average} {fast}/{slow} · {candles} velas · comisión {commission}% por lado · {trades} operaciones',
  'backtest.accountDepleted': 'cuenta agotada',
  'backtest.netPnl': 'PnL neto',
  'backtest.netPnlHint': 'Después de comisiones y slippage',
  'backtest.return': 'Retorno',
  'backtest.returnHint': 'Sobre el balance inicial',
  'backtest.finalBalance': 'Balance final',
  'backtest.finalBalanceHint': 'Inicial {amount}',
  'backtest.trades': 'Operaciones',
  'backtest.tradesHint': '{wins} ganadoras · {losses} perdedoras',
  'backtest.winRate': 'Tasa de acierto',
  'backtest.winRateHint': 'Ganadoras sobre el total',
  'backtest.profitFactor': 'Factor de beneficio',
  'backtest.profitFactorHint': 'Ganancias ÷ pérdidas',
  'backtest.maxDrawdown': 'Mayor caída',
  'backtest.maxDrawdownHint': '{pct} del máximo',
  'backtest.feesPaid': 'Comisiones pagadas',
  'backtest.feesPaidHint': 'Entrada + salida',
  'backtest.exitReasons': 'Motivos de salida',
  'backtest.balanceEvolution': 'Evolución del balance',
  'backtest.operations': 'Operaciones ({count})',
  'backtest.noTrades':
    'Esta configuración no generó operaciones con estas velas. Prueba otro par, temporalidad o períodos de media.',
  'backtest.disclaimer':
    'Resultado sobre datos históricos. No incluye liquidez, funding, latencia ni cambios de spread. Un backtest no garantiza resultados futuros. Comisión configurada: por lado.',

  // Exit reasons
  'exit.stop': 'Stop loss',
  'exit.target': 'Take profit',
  'exit.signal': 'Señal contraria',
  'exit.end': 'Fin de datos',
  'exit.bankrupt': 'Balance agotado',

  // Terminal & Predicciones nav
  'terminal.backToStats': 'Volver a Estadísticas',
  'predictions.runBot': 'Ejecutar en Bot',

  // Stats
  'stats.title': 'Estadísticas',
  'stats.subtitle': 'Rendimiento estratégico, margen de ventaja y riesgo operativo.',
  'stats.openTerminal': 'Terminal Gráfica',
  'stats.sourceAria': 'Fuente de datos',
  'stats.sourceBacktest': 'Backtest',
  'stats.sourceBot': 'Bot',
  'stats.sourceSample': 'Ejemplo',
  'stats.emptyBacktest':
    'Aún no hay ningún backtest guardado. Ejecuta una simulación histórica para analizar salidas, comisiones y ventaja real.',
  'stats.emptyBot':
    'El bot aún no ha cerrado operaciones Spot en esta sesión.',
  'stats.openBacktest': 'Abrir backtest',
  'stats.openBot': 'Ir a Ejecutar Bot',
  'stats.viewSample': 'Ver ejemplo',
  'stats.netReturn': 'Retorno neto',
  'stats.netReturnHint': '{pct} · Capital {balance}',
  'stats.winRate': 'Tasa de acierto',
  'stats.winRateEdgeHint': '{wins}/{total} · Equilibrio {be} ({edge})',
  'stats.winRateHint': '{wins} ganadoras de {total}',
  'stats.profitFactor': 'Factor de beneficio',
  'stats.pfExpectancyHint': 'Expectativa {exp}/op',
  'stats.pfExpectancyRHint': 'Expectativa {exp} ({r}R/op)',
  'stats.maxDrawdown': 'Mayor caída',
  'stats.noDrawdown': 'Sin caídas',
  'stats.drawdownRecoveryHint': '{dd} pico · Recup. {rec}×',
  'stats.drawdownLossStreakHint': '{dd} pico · Racha máx {streak}P',
  'stats.balanceEvolution': 'Evolución del capital',
  'stats.equityMeta': 'Inicial {initial} · {count} ops',
  'stats.bestTrade': 'Mejor operación',
  'stats.worstTrade': 'Peor operación',
  'stats.currentStreak': 'Racha actual',
  'stats.streakWin': '{count}G',
  'stats.streakLoss': '{count}P',
  'stats.streakFlat': 'Neutra',
  'stats.diagnosticsTitle': 'Diagnóstico de estrategia',
  'stats.diagTabAria': 'Vista de diagnóstico',
  'stats.diagEdge': 'Ventaja',
  'stats.diagPairs': 'Pares',
  'stats.diagExits': 'Salidas',
  'stats.breakEvenMeter': 'Acierto vs equilibrio',
  'stats.breakEvenLabel': 'Equilibrio {pct}',
  'stats.averageWin': 'Ganancia media',
  'stats.averageLoss': 'Pérdida media',
  'stats.payoffRealized': 'Ratio R:R real',
  'stats.targetRiskReward': 'R:R configurado',
  'stats.worstLossStreak': 'Peor racha negativa',
  'stats.recoveryFactor': 'Factor recuperación',
  'stats.longBias': 'Largos (BUY)',
  'stats.shortBias': 'Cortos (SELL)',
  'stats.streakEstRisk': '{count}P (~{pct}% riesgo est.)',
  'stats.insightPositive':
    'Tu acierto real supera el equilibrio por +{pp} pp frente a la configuración de {pair}.',
  'stats.insightNegative':
    'El acierto está {pp} pp bajo el equilibrio — revisa SL/TP visualmente en Terminal Gráfica.',
  'stats.insightNeutral':
    'Serie corta o equilibrada — contrasta SL (-{sl}%) y TP (+{tp}%) sobre velas en vivo.',
  'stats.calibrateTerminal': 'Calibrar en Terminal',
  'stats.pairsHint': 'Haz clic en un par para filtrar el registro de operaciones.',
  'stats.clearPairFilter': 'Todos los pares',
  'stats.pairMeta': '{wins}/{total} ganadoras · {wr}',
  'stats.exitsBreakdown': 'Motivos de salida',
  'stats.totalFees': 'Comisiones totales',
  'stats.feeDrag': '{pct}% del beneficio bruto',
  'stats.noExitData':
    'Los motivos de salida y el peso de comisiones se registran en ejecuciones de Backtest o del Bot.',
  'stats.operations': 'Operaciones ({count})',
  'stats.filterAll': 'Todas',
  'stats.filterWins': 'Ganadoras',
  'stats.filterLosses': 'Perdedoras',
  'stats.filterAria': 'Filtrar operaciones',
  'stats.lastBacktest': 'Último backtest:',
  'stats.lastBacktestReadout':
    '{pair} · {candles} velas · {date} UTC · {trades} operaciones',
  'stats.sampleDisclaimer':
    'Calculados con operaciones de ejemplo. Usa Backtest o el Bot para evaluar estrategias reales.',
  'stats.backtestDisclaimer':
    'Resultados del último backtest guardado. No incluyen liquidez, funding ni spread variable.',
  'stats.botDisclaimer':
    'Operaciones Spot cerradas registradas por el motor del bot en esta sesión.',

  // Settings
  'settings.title': 'Ajustes',
  'settings.subtitle': 'Configúralo a tu manera.',
  'settings.language': 'Idioma',
  'settings.languageDesc': 'Elige el idioma de la interfaz.',
  'settings.theme': 'Tema',
  'settings.themeDesc': 'Elige cómo se ve Flare.',
  'settings.themeDark': 'Oscuro',
  'settings.themeLight': 'Claro',
  'settings.themeAuto': 'Auto',
  'settings.tradingSetup': 'Configuración de trading',
  'settings.tradingSetupDesc':
    'FLARE es solo simulación. La versión de producción está en desarrollo.',
  'settings.simulation': 'Simulación',
  'settings.storedData': 'Datos guardados',
  'settings.storedDataDesc':
    'Se guardan tus estrategias, ajustes y el último backtest. El estado del bot vuelve a STOP cuando no está supervisado.',
  'settings.resetConfirm':
    '¿Seguro? Tus estrategias, ajustes y último backtest se restablecerán.',
  'settings.resetYes': 'Sí, restablecer datos',
  'settings.cancel': 'Cancelar',
  'settings.reset': 'Restablecer datos',

  // Market & Analysis
  'market.title': 'Precio del mercado',
  'market.pairAria': 'Par',
  'market.timeframeAria': 'Temporalidad',
  'market.interval5m': '5 min',
  'market.interval15m': '15 min',
  'market.interval1h': '1 h',
  'market.interval4h': '4 h',
  'market.interval1d': '1 día',

  // Chart Studio
  'studio.expand': 'Expandir',
  'studio.collapse': 'Salir Studio',
  'studio.candleStyle': 'Tipo de vela',
  'studio.styleCandles': 'Velas',
  'studio.styleHollow': 'Huecas',
  'studio.styleHeikin': 'Heikin Ashi',
  'studio.indicators': 'Indicadores',
  'studio.overlaysGroup': 'Capas en Precio',
  'studio.panesGroup': 'Osciladores',
  'studio.magnet': 'Imán OHLC',
  'studio.measure': 'Medir',
  'studio.undo': 'Deshacer',
  'studio.clear': 'Limpiar',
  'studio.resetView': 'Restablecer vista',
  'studio.togglePanel': 'Panel lateral',
  'studio.tabStrategies': 'Estrategias',
  'studio.tabIndicators': 'Indicadores',
  'studio.tabTrade': 'Operar',
  'studio.maTuner': 'Medias de Señal',
  'studio.consensus': 'Consenso Técnico',
  'studio.signalsJumpHint': 'Haz clic en cualquier cruce para centrarlo en el gráfico',
  'studio.analyzePresets': 'Simular los 8 en Feed',
  'studio.analyzingPresets': 'Evaluando ({done}/{total})…',
  'studio.applyPreset': 'Aplicar a Studio',
  'studio.appliedPreset': 'Activo',
  'studio.predictionRules': 'Reglas Cuantitativas ({tf})',
  'studio.noPredictionRules': 'Sin reglas específicas en {tf}. Cambia a 5m, 15m, 1h, 4h o 1d.',
  'studio.riskCalibration': 'Calibración TP / SL y Posición',
  'studio.saveLevels': 'Guardar niveles',
  'market.fastAverage': 'Media rápida',
  'market.fastAverageHint': 'Reacciona rápido a los cambios.',
  'market.slowAverage': 'Media lenta',
  'market.slowAverageHint': 'Marca la tendencia de fondo.',
  'market.averageType': 'Tipo de media',
  'market.averageHint':
    'SMA: promedio simple. EMA: da más peso a lo reciente.',
  'market.candleCount': '{count} velas',
  'market.loading': 'Cargando velas…',
  'market.loadError': 'No se pudieron cargar los datos: {message}',
  'market.retry': 'Reintentar',
  'market.source': 'Fuente: {name}. {description} Horas en UTC.',
  'market.sourceName': 'API pública de Binance',
  'market.sourceDescription': 'Precios reales de mercado, sin claves.',
  'market.signals': 'Señales ({count})',
  'market.signalsDisclaimer':
    'Las señales son un ejemplo educativo (cruce de medias) y se confirman al cierre de cada vela. No son una recomendación de compra ni de venta.',

  // Charts & Tables
  'chart.noCandles': 'No hay velas para mostrar.',
  'chart.candlesAria':
    'Gráfico de velas de {count} velas, de {from} a {to} UTC',
  'chart.candlesAriaSignals':
    'Gráfico de velas de {count} velas, de {from} a {to} UTC, con {signals} señales',
  'chart.buy': 'Compra',
  'chart.sell': 'Venta',
  'chart.noRsiData': 'No hay datos suficientes para el RSI.',
  'chart.rsiHigh': 'Zona alta (≥ {level})',
  'chart.rsiLow': 'Zona baja (≤ {level})',
  'chart.rsiAria': 'Panel de RSI de {period} periodos',
  'chart.needPoints':
    'Se necesitan al menos 2 puntos para dibujar el gráfico.',
  'chart.equityAria':
    'Curva del balance: de {from} a {to} en {count} operaciones',
  'chart.start': 'Inicio',

  'signals.candle': 'Vela (UTC)',
  'signals.side': 'Lado',
  'signals.price': 'Precio de referencia',
  'signals.reason': 'Motivo',
  'signals.empty': 'Esta estrategia no generó señales con estos datos.',
  'signals.crossAbove': '{average} {fast} cruza por encima de {average} {slow}',
  'signals.crossBelow': '{average} {fast} cruza por debajo de {average} {slow}',

  'table.time': 'Hora',
  'table.pair': 'Par',
  'table.side': 'Lado',
  'table.entry': 'Entrada',
  'table.exit': 'Salida',
  'table.size': 'Tamaño',
  'table.result': 'Resultado',
  'table.total': 'Total',
  'table.empty': 'No hay operaciones para mostrar.',
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

  return (
    <I18nContext.Provider value={value}>
      <TooltipProvider delayDuration={160}>{children}</TooltipProvider>
    </I18nContext.Provider>
  )
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (!value) {
    throw new Error('useI18n must be used inside I18nProvider')
  }
  return value
}
