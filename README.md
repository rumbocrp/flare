# FLARE

Interactive quantitative spot and binary-prediction trading platform built with React, TypeScript, Vite, and a Node HTTP / Vite middleware runtime, alongside native MetaTrader 5 Expert Advisors.

## Key Features & Navigation UX

- **5-Point Dock + Overflow Menu (`src/navItems.ts`, `src/components/navigation/AppDock.tsx`)**:
  - **Primary Dock**: `Dashboard`, `Run bot`, `Backtest`, `Predictions`, and `Statistics`.
  - **More Popover**: `Bot setup` and `Settings`.
  - **Contextual Drill-Down (`src/components/navigation/AppTopBar.tsx`)**: `ChartTerminal` (`terminal`) opens contextually (for example, directly from `Statistics`), keeps `Statistics` highlighted in the dock, and provides a one-click Back control in the top bar backed by `pushNavHistory` / `popNavHistory`.
- **Interactive Chart Studio (`src/components/CandleChart.tsx`, `src/components/MarketAnalysis.tsx`, `src/components/RsiPanel.tsx`)**: Live OHLC candlestick chart, synced RSI-14 panel, moving-average overlays, trendline / S&R / Fibonacci drawing tools, and zero-reflow spectrum zoom/pan controls.
- **Strategy & Execution Engine (`src/botEngine.ts`, `src/backtest.ts`, `src/predictionMarket.ts`)**: Spot momentum/structure presets with anti-repainting closed-bar checks, Profit-Lock breakeven management, Wilson 95% / Kelly prediction-market sizing, and hard risk limits + kill-switch guards in the backend demo broker adapter (`src/server/exchangeAdapter.ts`).
- **MetaTrader 5 Integration (`mql5/`)**:
  - `FlareBridgeEA.mq5` (polls `/api/mt5/signal`)
  - `FlareAutonomousEA.mq5` (standalone MQL5 execution)
- **Language & Theme Support (`src/settings.ts`, `src/i18n.tsx`)**: English is the default codebase and UI language (`language: 'en'`, `theme: 'dark'`), with full runtime switching between `EN`/`ES` and `dark`/`light`/`system` persisted under `lixtrd:*` keys in `localStorage`.

## Project Structure

- `src/` — React 19 frontend, chart engine, quantitative calculators, i18n dictionary, and Vitest specs.
- `src/server/` — Node HTTP runtime (`botRuntime.ts`, `exchangeAdapter.ts`, `candleCache.ts`, `polymarketAdapter.ts`, `mt5Bridge.ts`). During development, `vite.config.ts` mounts `/api/*` directly through `flareBackendPlugin()`.
- `mql5/` — MetaTrader 5 Expert Advisors.
- `.agent/` — Workspace skills and tooling rules (`.agent/rules/flare-tooling.md`).

## Commands

```bash
npm install
npm run dev      # Start Vite dev server with embedded /api/* middleware
npm run server   # Run standalone Node backend (node --experimental-strip-types src/server/index.ts)
npm test         # Run Vitest unit & backend suite (vitest run)
npm run build    # Type-check with tsc -b and create production bundle with vite build
npm run lint     # Run ESLint across the repository
npm run preview  # Preview built production bundle
```

## AI Tooling (Context7 & Playwright MCP)

Workspace rules in [.agent/rules/flare-tooling.md](.agent/rules/flare-tooling.md) standardize:

1. **Context7**: Check current official docs for React 19, Vite 8, Vitest 5, and TypeScript ~7.0 before modifying build, middleware, or React APIs.
2. **Playwright MCP**: Configured globally in `~/.gemini/config/mcp_config.json` (`@playwright/mcp@latest`) for headless/headed E2E UI verification against the running Vite dev server.
