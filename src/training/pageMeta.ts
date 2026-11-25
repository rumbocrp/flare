import type { Language, PageId } from '../types'

export type RouteMetadata = {
  page: PageId
  path: string
  robots: 'noindex, nofollow'
  title: string
  description: string
}

const ROUTE_PATHS: Record<PageId, string> = {
  dashboard: '/dashboard',
  terminal: '/terminal',
  'bot-config': '/bot-config',
  training: '/training',
  'bot-run': '/bot-run',
  backtest: '/backtest',
  predictions: '/predictions',
  stats: '/stats',
  settings: '/settings',
}

const ROUTE_COPY: Record<
  Language,
  Record<PageId, { title: string; description: string }>
> = {
  en: {
    dashboard: {
      title: 'Dashboard — FLARE',
      description:
        'Live paper and testnet trading desk overview, active strategy status, market snapshots, and risk alerts in FLARE.',
    },
    terminal: {
      title: 'Chart Studio — FLARE',
      description:
        'Interactive multi-pane candlestick chart terminal with technical indicators, alerts, and drawing tools in FLARE.',
    },
    'bot-config': {
      title: 'Bot Setup — FLARE',
      description:
        'Configure strategy presets, risk limits, execution fees, and custom profiles for the FLARE automated bot.',
    },
    training: {
      title: 'Training — FLARE',
      description:
        'Purged walk-forward training, ML meta-filter validation, held-out testing, and paper/testnet shadow verification in FLARE.',
    },
    'bot-run': {
      title: 'Run Bot — FLARE',
      description:
        'Operate the FLARE paper and testnet bot runtime, monitor open positions, audit fills, and control execution risk.',
    },
    backtest: {
      title: 'Backtest — FLARE',
      description:
        'Deterministic historical strategy replay with fees, slippage, equity curves, and trade-level audit export in FLARE.',
    },
    predictions: {
      title: 'Predictions — FLARE',
      description:
        'Binary prediction-market calibration, CLOB quote verification, and Monte Carlo strategy evaluation in FLARE.',
    },
    stats: {
      title: 'Stats — FLARE',
      description:
        'Performance telemetry, drawdown analytics, and trade distribution metrics for evaluated strategies in FLARE.',
    },
    settings: {
      title: 'Settings — FLARE',
      description:
        'Manage FLARE workspace appearance, language, accessibility motion preferences, API endpoint, and configuration backups.',
    },
  },
  es: {
    dashboard: {
      title: 'Panel — FLARE',
      description:
        'Resumen operativo en tiempo real de estrategias en papel y testnet, mercados y alertas de riesgo en FLARE.',
    },
    terminal: {
      title: 'Gráficos — FLARE',
      description:
        'Terminal interactivo de velas multipanel con indicadores técnicos, alertas y herramientas de dibujo en FLARE.',
    },
    'bot-config': {
      title: 'Ajustar bot — FLARE',
      description:
        'Configura presets de estrategia, límites de riesgo, comisiones de ejecución y perfiles personalizados en FLARE.',
    },
    training: {
      title: 'Entrenamiento — FLARE',
      description:
        'Entrenamiento walk-forward purgado, validación con meta-filtro ML, pruebas fuera de muestra y verificación shadow en FLARE.',
    },
    'bot-run': {
      title: 'Ejecutar bot — FLARE',
      description:
        'Opera el motor del bot en papel y testnet, supervisa posiciones abiertas, órdenes y control de riesgo en FLARE.',
    },
    backtest: {
      title: 'Backtest — FLARE',
      description:
        'Simulación histórica determinista con comisiones, deslizamiento, curvas de capital y exportación de operaciones en FLARE.',
    },
    predictions: {
      title: 'Predicciones — FLARE',
      description:
        'Calibración de mercados de predicción, verificación de cotizaciones CLOB y evaluación Monte Carlo en FLARE.',
    },
    stats: {
      title: 'Estadísticas — FLARE',
      description:
        'Telemetría de rendimiento, análisis de drawdown y distribución de operaciones evaluadas en FLARE.',
    },
    settings: {
      title: 'Ajustes — FLARE',
      description:
        'Administra apariencia, idioma, reducción de movimiento, servidor API y respaldos de configuración en FLARE.',
    },
  },
}

export function getRouteMetadata(
  page: PageId,
  language: Language,
): RouteMetadata {
  const copy = ROUTE_COPY[language]?.[page] ?? ROUTE_COPY.en[page]
  return {
    page,
    path: ROUTE_PATHS[page],
    robots: 'noindex, nofollow',
    title: copy.title,
    description: copy.description,
  }
}

export function resolvePageFromPathname(pathname: string): PageId {
  const cleaned = pathname.replace(/\/+$/, '').toLowerCase()
  if (!cleaned || cleaned === '/') return 'dashboard'
  for (const [page, routePath] of Object.entries(ROUTE_PATHS) as [
    PageId,
    string,
  ][]) {
    if (cleaned === routePath) return page
  }
  return 'dashboard'
}

export function applyDocumentMetadata(
  page: PageId,
  language: Language,
  doc: Document = document,
  origin?: string,
): RouteMetadata {
  const meta = getRouteMetadata(page, language)
  doc.title = meta.title
  doc.documentElement.lang = language

  const upsertMeta = (name: string, content: string) => {
    let el = doc.head.querySelector(`meta[name="${name}"]`)
    if (!el) {
      el = doc.createElement('meta')
      el.setAttribute('name', name)
      doc.head.appendChild(el)
    }
    el.setAttribute('content', content)
  }

  upsertMeta('description', meta.description)
  upsertMeta('robots', meta.robots)

  const resolvedOrigin =
    origin ??
    (typeof window !== 'undefined' &&
    window.location.origin &&
    window.location.origin !== 'null'
      ? window.location.origin
      : 'https://flare.local')

  let canonical = doc.head.querySelector('link[rel="canonical"]')
  if (!canonical) {
    canonical = doc.createElement('link')
    canonical.setAttribute('rel', 'canonical')
    doc.head.appendChild(canonical)
  }
  canonical.setAttribute('href', `${resolvedOrigin}${meta.path}`)

  return meta
}

