# Ticket 01: Complete Personalizable Bot Setup & Settings Console (Wave 0 Prerequisite)

- **Status:** `ready-for-agent`
- **Blocked by:** `none`
- **Wave:** `0` (Must complete and pass `build` / `lint` / `test` on `master` before Wave 1 starts)
- **Owned / Active Files:**
  - Fix & finish: `src/pages/BotConfig.tsx`, `src/pages/Settings.tsx`, `src/i18n.tsx`
  - New tests: `src/settings.test.ts`, `src/botConfig.test.ts`
  - Already updated in working tree (preserve & verify): `src/types.ts`, `src/settings.ts`, `src/hooks/useTheme.ts`, `src/index.css`, `src/botEngine.ts` (`mergePresetPatch`, exported filter types), `src/botProfiles.ts`, `src/server/store/types.ts`, `src/server/botRuntime.ts`, `src/api/botClient.ts`, `src/App.tsx`

---

## Context & Current Blocker

The working tree currently contains backend, state, and `App.tsx` support for full strategy customization and an expanded Settings console, **but `npx tsc -b` currently fails** at `src/App.tsx(199,13)` because `Settings.tsx` still accepts the old `{ settings, onChangeSettings, onResetAll }` prop signature without `strategy` and `onChangeStrategy`. Meanwhile, `BotConfig.tsx` only exposes 5 basic fields instead of the full preset/signal/filter/execution parameters now supported by `mergePresetPatch` and `POST /api/bot/preset`.

---

## Requirements

### 1. Finish `src/pages/Settings.tsx`
Accept `SettingsProps`:
```ts
type SettingsProps = {
  settings: AppSettings
  strategy: Strategy
  onChangeSettings: (settings: AppSettings) => void
  onChangeStrategy: (strategy: Strategy) => void
  onResetAll: () => void
}
```
Design a clean Operate-mode 4-section workspace matching FLARE's obsidian/slate terminal design system (`src/index.css`, shadcn/ui primitives — no nested cards, no kickers above headings, `AlertDialog` only on destructive actions respecting `settings.confirmDestructive` where appropriate):

1. **Appearance & Workspace (`settings`):**
   - Language switcher (`en` / `es`)
   - Theme switcher (`dark` / `light` / `system`)
   - Accent color preset selector (`amber` / `emerald` / `violet` / `cyan`) — wired live via `useTheme` + CSS variables
   - Density (`comfortable` / `compact`) + Reduced motion toggle (`Switch`)
   - Default trading pair (`availablePairs`), default interval (`5m | 15m | 1h | 4h | 1d`), timezone (`UTC | local`), confirm-destructive toggle (`Switch`), sound alerts toggle + "Test chime" button (`playAlertChime()` from `src/botProfiles.ts`)
2. **Backend Connection, Tenant & Auth (`botClient`):**
   - Custom API base URL input (`apiBaseUrl`, synced with `setApiBaseUrl` & `settings`) + `X-Tenant-Id` input (`getApiTenantId` / `setApiTenantId`) + Bearer Token masked input (`getApiAuthToken` / `setApiAuthToken`)
   - "Test Health Connection" action (`checkBackendHealth()`) displaying status (`200 OK` / error), latency ms, store driver (`sqlite`/`postgres`), and shared-state adapter
3. **Venues & Hard Risk Guardrails (`botClient` live controls):**
   - **Polymarket CLOB Status Card-Row:** shows `configured`, `liveArmed` (`live-clob` vs `read-only` badge), chain ID (`137`/`80002`), signer & funder address, L2 creds status, order count, last reconciliation summary (`collateralUsd`, `allowanceUsd`), plus **Reconcile Account** (`reconcilePolymarketAccountOnServer()`) and **Cancel All Open Orders** (`cancelPolymarketOrderOnServer({ cancelAll: true })`) actions.
   - **Exchange Vault / Testnet HardRiskLimits Form:** edit `maxOrderNotionalUsd`, `maxDailyLossUsd`, `maxDailyOrders`, `autoMirrorBotOrders` (`Switch`), allowed pairs multi-select checkboxes (`availablePairs`), save button (`updateHardLimitsOnServer`), plus **Emergency Kill-Switch** engage/reset (`toggleExchangeKillSwitchOnServer`) and **Reset Demo Vault** (`resetExchangeVaultOnServer` behind `AlertDialog`).
   - **MT5 EA Bridge Readout:** shows magic number, poll count, connected terminals list (`Mt5TerminalTelemetry`), and "Simulate MT5 Ping" (`simulateMt5PingOnServer`).
4. **Account Ledger, Audit Log, Retention & JSON Import/Export:**
   - Fetch & inspect `getTenantLedger()` (balanced invariant check badge + derived wallet balances) and `getTenantAudit(40)` (compact `Table` with timestamp, actor, role, action, outcome).
   - Database retention pruner (`pruneRetentionOnServer(retentionDays)`) showing deleted rows report.
   - Export/Import full FLARE bundle JSON (settings + strategy + custom bot profiles) and **Restore All Data** (`onResetAll`, guarded by `AlertDialog`).

### 2. Finish `src/pages/BotConfig.tsx`
Keep existing props (`strategy`, `onSave`, `onNavigate`) while syncing with live backend snapshot (`getBotStatus()` / `selectBotPresetOnServer({ presetId, timeframe, customPreset })`) and `src/botProfiles.ts`:

- **4-Tab Strategy Studio:**
  1. **Base Preset & Mode:** select any of the 8 `STRATEGY_PRESETS` (or a saved custom profile from `src/botProfiles.ts`), toggle `domain` (`crypto-spot` / `prediction-market`), `pair`, `timeframe` (`5m | 15m | 1h | 4h | 1d`), editable preset name/notes, save as named Custom Profile (`upsertCustomBotProfile`), duplicate/delete custom profile (`deleteCustomBotProfile`).
  2. **Signals & Filters (Domain-Adaptive):**
     - When `domain === 'crypto-spot'`: `signalEngine` (`momentum-structure` / `crossover` / `rsi-reversion`), `fastPeriod`, `slowPeriod`, `average` (`ema` / `sma`), `avoidRsiExtremes`, `maxBuyRsi`, `minSellRsi`, `oversoldRsi`, `overboughtRsi`, `requireEma50Alignment`, `breakevenAtOneR`, `flipOnOppositeSignal`.
     - When `domain === 'prediction-market'`: selector over `BITCOIN_20_PREDICTIONS` rules (`predictionRuleId`), `minEdgePct`, `minTriggers`, `useQuarterKelly` (`Switch`), plus clear research note explaining FLARE rule vs Up/Down contracts.
  3. **Risk & Sizing:** `positionSize (%)`, `stopLoss (%)`, `takeProfit (%)`, `maxDailyRisk (%)`, computed R:R ratio badge, plus quick conservative/balanced/aggressive preset chips.
  4. **Execution & Paper Vault:** `initialBalance ($)`, `commissionPct (%)`, `slippagePct (%)`, `allowShort` (`Switch`).
- **Live Strategy Blueprint Panel:** sticky/side summary panel showing active domain, pair, timeframe, entry/exit parameters, fee drag preview, validation status, **Save & Sync to Server** (`onSave` + `selectBotPresetOnServer`), **Reset to Base Preset**, JSON Copy/Import of preset config, and quick links to **Backtest** and **Run Bot**.

### 3. Complete `src/i18n.tsx` & Unit Tests
- Add every new EN and ES translation key cleanly so neither language shows raw keys.
- Write `src/settings.test.ts` testing `normalizeAppSettings`, `isAppSettings` defaults/clamping, and `src/botProfiles.ts` CRUD (`upsertCustomBotProfile`, `deleteCustomBotProfile`).
- Write `src/botConfig.test.ts` testing `mergePresetPatch` (clamping `fastPeriod < slowPeriod`, `minSellRsi < maxBuyRsi`, invalid pairs/domains ignored safely) and verifying `selectBotPresetOnServer` round-trip persistence.

---

## Acceptance Criteria

1. `npm run build` (`tsc -b && vite build`) exits `0` with zero TypeScript or bundler errors.
2. `npm run lint` exits `0` with zero warnings/errors.
3. `npm test` exits `0` with all existing + new tests passing.
4. `\.agent\skills\impeccable\scripts\impeccable.cmd detect --json src/pages/BotConfig.tsx src/pages/Settings.tsx` reports zero high/critical craft-floor violations.
5. Zero simulated fallback prices/balances injected; all actions talk to real `botClient` / local preference stores cleanly.

## Comments
