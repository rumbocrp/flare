# FLARE App Design System

FLARE uses a shadcn/ui (`new-york`, Tailwind CSS v4) terminal architecture blending **TradingView** structural precision, **Phantom** low-contrast obsidian surfaces, and **Binance** operational color semantics.

## 1. Visual Identity & Surfaces

- **Application-first geometry:** Softened modern `8px` base radius (`--radius: 0.5rem`), `6px` interactive controls/inputs (`--radius-sm`), `4px` nested badges/pills (`--radius-xs`), `12px` frosted-glass floating dock tray (`--radius-dock`), and subtle tonal elevation (`--shadow-card` with a `1px` top hairline highlight) over blended borders.
- **Dark obsidian default (`:root` in `src/index.css`):**
  - `--background: #0b0e11` (terminal canvas)
  - `--card: #11151b` (panels/cards)
  - `--secondary: #161b23` (inputs & segmented shells)
  - `--border: #171c25` / `--border-subtle: #12171f` / `--border-strong: #232a36` (blended mid-tone separation between canvas and surface)
  - `--foreground: #eaecef` / `--muted-foreground: #848e9c`
- **Light mode (`:root[data-theme='light']`):** Clean precision slate (`#f3f5f8` canvas, `#ffffff` cards, blended `#e6ebf2` borders, `#131722` foreground).
- **Operational Accents:**
  - `--primary` / `--brand`: `#f0b90b` (Binance amber-gold primary CTA & Fast MA overlay)
  - `--brand-violet`: `#ab9ff2` (Phantom violet accent & Slow MA overlay)
  - `--positive` / `--signal-buy`: `#0ecb81` (bullish / YES / profit)
  - `--negative` / `--signal-sell`: `#f6465d` (bearish / NO / loss / kill-switch)

## 2. Typography & Numeric Precision

- **Display headings:** `Jost`, fallback `Cabin`, sans-serif (`--font-display`)
- **UI body:** `Cabin`, sans-serif (`--font-ui`), compact `13px` base scale
- **Telemetry & prices:** System monospace (`--font-mono`) with enforced `font-variant-numeric: tabular-nums` across tables, KPI cards, and chart readouts.

## 3. Navigation & App Shell

- **Floating Bottom Dock (`src/components/navigation/AppDock.tsx` + `src/components/ui/dock.tsx`):** Strictly 5 primary destinations (`dashboard`, `bot-run`, `backtest`, `predictions`, `stats`) plus a `More` (`Popover`) trigger holding secondary utility views (`bot-config`, `settings`).
- **Sub-route Top Bar (`src/components/navigation/AppTopBar.tsx`):** Minimal single-line drill-down bar for contextual destinations (`Chart Studio` / `terminal` and overflow pages) with one-click back navigation.

## 4. shadcn/ui Component Inventory (`src/components/ui/`)

- **Actions & Layout:** `button.tsx`, `card.tsx`, `badge.tsx`, `separator.tsx`, `skeleton.tsx`, `scroll-area.tsx`
- **Inputs & Controls:** `input.tsx`, `label.tsx`, `select.tsx`, `switch.tsx`, `checkbox.tsx`, `slider.tsx`
- **Navigation & Overlays:** `tabs.tsx`, `popover.tsx`, `tooltip.tsx`, `alert-dialog.tsx`, `dock.tsx`
- **Data Grids:** `table.tsx` (`Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell`)

## 5. UX Copy & Interaction Standards

- Avoid promotional marketing subtitles or decorative filler text; keep headers to title + live telemetry badge + action controls.
- Use `AlertDialog` confirmation guards on destructive actions (e.g., Settings reset, Demo broker account reset, Bot Kill-Switch).
- Keep all interactive toolbars, switches, and tables keyboard-accessible with `focus-visible` focus rings and concise `Tooltip` hints where domain expressions benefit from inspection.
