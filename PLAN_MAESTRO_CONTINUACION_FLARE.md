# FLARE — Plan Maestro de Continuación y Consolidación (Revisión de Calidad Argon)

> **Estado:** Documento maestro auditado y consolidado.  
> **Verificación del código base:** `29/29 tests passing` (Vitest) y `tsc -b && vite build` sin errores.  
> **Inspiración verificada:** Repositorio de **ApexJournal** (commit `f8b7191`).  
> **Objetivo:** Unificar las 6 guías del proyecto en una secuencia lógica, sin conflictos entre archivos, con código exacto para copiar y pegar y criterios de producción (Context7).

---

## 1. Auditoría de Calidad (Revisión Argon sobre el Plan Anterior)

Al contrastar la respuesta previa contra el contenido íntegro de las 6 guías existentes, se detectaron y corrigieron **5 discrepancias críticas**:

1. **Discrepancia en tokens de `src/index.css`:** En el resumen anterior faltaban los tokens geométricos del dock (`--dock-tile`, `--dock-indicator-lane`) que `AppDock.css` requiere para calcular el deslizamiento de la gota (`translateX(calc(var(--app-dock-index) * (var(--dock-tile) + var(--dock-gap))))`). En este documento se incluye el bloque fusionado exacto (Opción C *Graphite & Signal* + Dock).
2. **Discrepancia en `DockIcon.tsx` y `AppTopBar.tsx`:** El código resumido usaba la prop `id` en lugar de `name` y `size`, lo cual habría roto la compilación con `AppDock.tsx`. Abajo se entrega el código exacto de la guía oficial que usa `name: DockIconName` y mantiene la marca `LIXTRD` con `aria-live="polite"`.
3. **Conflicto de `src/App.css` entre Estética y Dock:** La guía de estética define `.app` como un `grid` de 2 columnas para el Sidebar, mientras que la guía del Dock necesita que `.app` sea un bloque con `padding-bottom` para que el dock flotante no tape el final de la página. Aquí se entrega `src/App.css` ya reconciliado para ambas opciones.
4. **Incompatibilidad detectada en `pnpm lint`:** El proyecto tiene instalado `typescript@~7.0.2`, pero `typescript-eslint@8.72.1` lanza excepción porque aún no soporta TS 7.0. Se documenta la solución exacta para producción.
5. **Orden de ejecución entre Internacionalización (`i18n`), Dock y Shadcn:** Se establece el orden exacto para no editar los mismos archivos `.tsx` dos veces.

---

## 2. Mapa Maestro: Orden Exacto de las Guías y Archivos

Para continuar el proyecto sin pisar cambios ni retrabajar componentes, sigue este flujo estricto:

```text
ETAPA 0: Base del Motor (YA APLICADA Y CORREGIDA EN EL REPO)
  └── GUIA_PARTE_11_BACKTEST.md ──► src/backtest.ts y src/backtest.test.ts (Listos)

ETAPA 1: Identidad Visual "Graphite & Signal" (Inspirada en ApexJournal)
  └── GUIA_ESTETICA_APEXJOURNAL.md
       ├── 1.1 index.html (Fuentes Cabin + Jost + viewport-fit=cover)
       ├── 1.2 src/index.css (Tokens Graphite & Signal + Tokens del Dock integrados)
       ├── 1.3 src/App.css (Layout, botones de 30px, inputs de 32px, cards densas)
       ├── 1.4 src/components/TradesTable.css (Tablas financieras compactas + tabular-nums)
       ├── 1.5 src/components/EquityChart.css (Selectores corregidos y línea 1.5px)
       ├── 1.6 src/components/CandleChart.css (Velas, RSI y leyendas)
       ├── 1.7 src/pages/BotRun.css
       ├── 1.8 src/pages/Settings.css
       └── 1.9 src/pages/Backtest.css

ETAPA 2: Navegación (Elige Ruta A o Ruta B — NUNCA mezcles ambas)
  ├── RUTA A (Recomendada): Dock macOS + Barra Superior Mínima (GUIA_DOCK_NAVEGACION_FLARE.md)
  │    ├── 2A.1 src/navItems.ts (Añade primaryNavItems, overflowNavItems, getNavLabel)
  │    ├── 2A.2 src/components/navigation/DockIcon.tsx (Crear)
  │    ├── 2A.3 src/components/navigation/AppDock.tsx (Crear)
  │    ├── 2A.4 src/components/navigation/AppDock.css (Crear)
  │    ├── 2A.5 src/components/navigation/AppTopBar.tsx (Crear)
  │    ├── 2A.6 src/components/navigation/AppTopBar.css (Crear)
  │    └── 2A.7 src/App.tsx (Reemplazar Sidebar por AppTopBar + AppDock)
  │
  └── RUTA B (Alternativa Clásica): Sidebar lateral + Barra Móvil Compacta
       └── GUIA_BARRA_SUPERIOR_MOVIL.md ──► Aplicar solo src/components/Sidebar.css

ETAPA 3: Internacionalización Inglés/Español (Opcional pero antes de Shadcn)
  └── GUIA_IDIOMAS_INGLES_ESPANOL.md
       ├── 3.1 src/types.ts y src/settings.ts (Añadir language: 'en' | 'es')
       ├── 3.2 src/i18n.tsx (Diccionario plano sin librerías externas)
       └── 3.3 Conectar t() en páginas y selector en Settings.tsx

ETAPA 4: Componentes Accesibles en Convivencia (Opcional)
  └── MANUAL_SHADCN_UI_FLARE.md
       └── Instalar Tailwind v4 + Radix primitives mapeados a los tokens de FLARE
```

---

## 3. Verificación contra ApexJournal (`commit f8b7191`)

Se verificó que el código propuesto cumpla exactamente con los acuerdos tomados del análisis real de ApexJournal:

* **Escala de grises cálidos/grafito en lugar de negro puro:** Se reemplaza `#050506` por la progresión `#0a0b0c` (`--bg`) → `#0f1113` (`--bg-subtle`) → `#14171a` (`--surface`) → `#20252a` (`--surface-raised`).
* **Tipografía dual técnica:** **Cabin** (`12px–14px`) para lectura de interfaz y **Jost** (`9.5px–20px` con `font-variant-numeric: tabular-nums`) para cabeceras en mayúsculas con tracking (`0.08em–0.12em`) y columnas numéricas perfectamente alineadas.
* **Disciplina de color semántico:** El acento (`#c6f24e` en oscuro, `#4f7a00` en claro) solo aparece en el botón de acción primaria, el anillo de foco y los puntos clave. El verde (`#4ade80`) y el rojo (`#f87171`) se reservan estrictamente para P&L positivo/negativo y velas.
* **Densidad de escritorio sin romper móvil:** Botones de `30px`, inputs de `32px` con contraste de borde `3:1` (`--border-input: #5a646d`), y tablas envueltas en `.table-wrap` para que jamás provoquen scroll horizontal en la página.

---

## 4. Auditoría de Producción (Estándares Context7)

| Área de Producción | Estado en el Código Actual | Solución / Mejora Incluida |
| :--- | :--- | :--- |
| **1. Compilación y Tipos (`tsc -b`)** | **Resuelto en el repositorio.** Se corrigieron los errores de estrechamiento de tipos en `src/backtest.ts` (líneas 277 y 414). | `pnpm build` ahora compila limpiamente en ~1.2s sin errores. |
| **2. Precisión Coma Flotante IEEE 754** | **Resuelto en el repositorio.** `100 * 1.1` producía `110.00000000000001` y rompía el test de `targetPrice`. | Se aplicó `roundMoney()` al calcular `stopPrice` y `targetPrice` en `src/backtest.ts`. Los **29 tests pasan**. |
| **3. Linter (`pnpm lint`) con TS 7.0** | `typescript-eslint@8.72.1` falla porque el `package.json` tiene `typescript: "~7.0.2"`. | **Acción:** Fijar `"typescript": "~5.8.3"` en `package.json` si necesitas que `eslint` pase en CI/CD, o usar `tsc -b` como validador primario hasta que `typescript-eslint` soporte TS 7. |
| **4. Resiliencia de Red (`binance.ts`)** | Si la API pública de Binance falla o bloquea por CORS/IP, el gráfico muestra error. | **Alternativa:** Implementar fallback automático al generador determinista `src/market/synthetic.ts` (incluido en la Sección 6). |
| **5. Seguridad de Hidratación (`localStorage`)** | Ya cuenta con type guards (`isStrategy`, `isAppSettings`, `isBacktestSnapshot`). | Mantener siempre los validadores al añadir el campo `language` en la Etapa 3. |

---

## 5. Código Completo para Copiar y Pegar (En Orden de Aplicación)

> **Nota:** En `src/backtest.ts` ya he aplicado y verificado las correcciones en tu espacio de trabajo para que `pnpm test` y `pnpm build` pasen. Los siguientes pasos aplican la **Etapa 1 (Estética ApexJournal)** y la **Etapa 2 (Dock de Navegación)** ya fusionadas y sin conflictos.

---

### PASO 1: `index.html` (Fuentes Cabin + Jost y Viewport para el Dock)

Reemplaza todo el contenido de `index.html` por este bloque (incluye las fuentes Cabin y Jost de la guía estética y el `viewport-fit=cover` de la guía del dock):

```html
<!doctype html>
<html lang="en">
  <head>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Cabin:wght@400;500;600;700&family=Jost:wght@400;500;600;700&display=swap"
      rel="stylesheet"
    />
    <script>
      try {
        var saved = JSON.parse(localStorage.getItem('lixtrd:settings') || 'null')
        var theme = saved && saved.theme ? saved.theme : 'dark'
        if (theme === 'system') {
          theme = window.matchMedia('(prefers-color-scheme: light)').matches
            ? 'light'
            : 'dark'
        }
        document.documentElement.dataset.theme = theme
      } catch (e) {}
    </script>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1.0, viewport-fit=cover"
    />
    <title>lixtrd</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

---

### PASO 2: `src/index.css` (Tokens Graphite & Signal + Tokens del Dock Integrados)

Reemplaza todo el contenido de `src/index.css`:

```css
/* ============================================================
   FLARE · Identidad "Graphite & Signal" + Tokens del Dock
   Cabin para interfaz · Jost para datos, etiquetas y display
   ============================================================ */

:root {
  color-scheme: dark;
  accent-color: var(--accent);

  /* Superficies: grafito cálido, no negro puro */
  --bg: #0a0b0c;
  --bg-subtle: #0f1113;
  --surface: #14171a;
  --surface-hover: #1a1e22;
  --surface-raised: #20252a;
  --surface-raised-hover: #272d33;

  /* Bordes y líneas */
  --border: #262c31;
  --border-strong: #3b444c;
  --border-input: #5a646d;
  --chart-baseline: #2b3238;
  --dot-off: #3a4248;

  /* Texto */
  --text: #eceae4;
  --text-muted: #a8a69f;
  --text-subtle: #8d8b84;

  /* Acento: lima de señal, usado con avaricia */
  --accent: #c6f24e;
  --primary: #c6f24e;
  --primary-hover: #b2de3c;
  --on-primary: #0b0d08;

  /* Semántica financiera */
  --positive: #4ade80;
  --negative: #f87171;
  --warning: #fbbf24;
  --buy-bg: #12261a;
  --sell-bg: #2a1517;
  --sell-text: #fca5a5;
  --positive-halo: rgba(74, 222, 128, 0.18);

  /* Series de gráfico */
  --overlay-fast: #fbbf24;
  --overlay-slow: #7dd3fc;
  --signal-buy: #eceae4;
  --signal-sell: #f87171;

  /* Tipografía */
  --font-display: 'Jost', 'Cabin', ui-sans-serif, system-ui, sans-serif;
  --font-ui: 'Cabin', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono: 'Jost', 'Cabin', ui-sans-serif, system-ui, sans-serif;

  /* Geometría */
  --radius-sm: 3px;
  --radius: 4px;
  --radius-md: 6px;
  --btn-height: 30px;
  --input-height: 32px;

  /* Dock de navegación */
  --dock-tile: clamp(42px, 11vw, 48px);
  --dock-gap: 4px;
  --dock-pad: 6px;
  --dock-indicator-lane: 4px;
  --dock-height: calc(
    var(--dock-tile) + (var(--dock-pad) * 2) + var(--dock-indicator-lane) + 2px
  );
  --shadow-dock:
    0 16px 40px rgba(0, 0, 0, 0.55),
    0 2px 8px rgba(0, 0, 0, 0.4);
}

:root[data-theme='light'] {
  color-scheme: light;

  --bg: #f2f1ec;
  --bg-subtle: #e9e8e2;
  --surface: #ffffff;
  --surface-hover: #f0efe9;
  --surface-raised: #e5e4dd;
  --surface-raised-hover: #dcdad2;

  --border: #d6d4cc;
  --border-strong: #b3b1a7;
  --border-input: #827f74;
  --chart-baseline: #c9c7be;
  --dot-off: #b8b6ad;

  --text: #171a16;
  --text-muted: #5b5e56;
  --text-subtle: #64675e;

  --accent: #4f7a00;
  --primary: #4f7a00;
  --primary-hover: #3f6200;
  --on-primary: #ffffff;

  --positive: #157a45;
  --negative: #c02626;
  --warning: #a16207;
  --buy-bg: #e3f6ea;
  --sell-bg: #fde8e8;
  --sell-text: #a83232;
  --positive-halo: rgba(21, 122, 69, 0.16);

  --overlay-fast: #a16207;
  --overlay-slow: #0369a1;
  --signal-buy: #174d2a;
  --signal-sell: #b91c1c;

  --shadow-dock:
    0 16px 40px rgba(23, 26, 22, 0.16),
    0 2px 8px rgba(23, 26, 22, 0.08);
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

html {
  -webkit-text-size-adjust: 100%;
}

body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}

#root {
  min-height: 100vh;
}

h1,
h2,
h3,
p,
dl,
dd {
  margin: 0;
}

button,
input,
select,
textarea {
  font: inherit;
}

button {
  cursor: pointer;
}

svg {
  display: block;
}

::selection {
  background: var(--accent);
  color: var(--on-primary);
}

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: var(--border-strong);
}

::-webkit-scrollbar-thumb:hover {
  background: var(--text-subtle);
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

### PASO 3: `src/App.css` (Reconciliado para Estética + Dock)

Reemplaza todo el contenido de `src/App.css`. Ya incluye la reserva de espacio inferior para el Dock (`padding-bottom: calc(var(--dock-height) + 24px + env(safe-area-inset-bottom, 0px))`):

```css
/* Layout general con barra superior y dock flotante */
.app {
  min-height: 100vh;
  padding-bottom: calc(
    var(--dock-height) + 24px + env(safe-area-inset-bottom, 0px)
  );
}

.content {
  min-width: 0;
}

/* Cada página */
.page {
  max-width: 1080px;
  margin: 0 auto;
  padding: 24px 24px 48px;
}

.page__header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
}

.page__header h1 {
  margin: 0 0 3px;
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: -0.01em;
}

.page__header p {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.4;
}

.badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 6px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-subtle);
  font: 600 9.5px/1 var(--font-mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
}

/* Tarjetas del Panel y de métricas */
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  color: var(--text);
  transition: border-color 120ms ease, background-color 120ms ease;
}

.card:hover {
  border-color: var(--border-strong);
}

.card__label {
  color: var(--text-subtle);
  font: 600 9.5px/1.2 var(--font-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.card__value {
  font: 600 1.35rem/1.15 var(--font-mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}

.card__value--positive {
  color: var(--positive);
}

.card__value--negative {
  color: var(--negative);
}

.card__hint {
  color: var(--text-subtle);
  font-size: 11px;
  line-height: 1.4;
}

.disclaimer {
  margin-top: 20px;
  color: var(--text-subtle);
  font-size: 11px;
  line-height: 1.5;
}

.placeholder {
  padding: 32px 20px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
  color: var(--text-subtle);
  font-size: 12px;
  text-align: center;
}

/* Botones */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--btn-height);
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text-muted);
  font: 500 11px/1 var(--font-ui);
  letter-spacing: 0.02em;
  white-space: nowrap;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}

.btn:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--surface-hover);
  color: var(--text);
}

.btn:active:not(:disabled) {
  transform: translateY(1px);
}

.btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.btn--primary {
  border-color: var(--primary);
  background: var(--primary);
  color: var(--on-primary);
  font-weight: 600;
}

.btn--primary:hover:not(:disabled) {
  border-color: var(--primary-hover);
  background: var(--primary-hover);
  color: var(--on-primary);
}

.btn--danger {
  border-color: var(--negative);
  background: transparent;
  color: var(--negative);
}

.btn--danger:hover:not(:disabled) {
  border-color: var(--negative);
  background: var(--negative);
  color: var(--bg);
}

/* Formularios */
.form {
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
}

.form__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 14px 16px;
}

.form__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}

.form__status {
  margin-left: auto;
  color: var(--text-subtle);
  font-size: 11px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field__label {
  color: var(--text-subtle);
  font: 600 9.5px/1.2 var(--font-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.field__control {
  display: flex;
  align-items: center;
  gap: 6px;
}

.field__control input,
.field__control select {
  flex: 1;
  min-width: 0;
  min-height: var(--input-height);
  padding: 0 9px;
  border: 1px solid var(--border-input);
  border-radius: var(--radius);
  background: var(--bg-subtle);
  color: var(--text);
  font: 400 12px/1 var(--font-ui);
  transition:
    border-color 120ms ease,
    box-shadow 120ms ease,
    background-color 120ms ease;
}

.field__control input:hover,
.field__control select:hover {
  border-color: var(--text-subtle);
}

.field__control input:focus,
.field__control select:focus {
  outline: none;
  border-color: var(--accent);
  background: var(--surface);
  box-shadow: 0 0 0 1px var(--accent);
}

.field__control input[aria-invalid='true'] {
  border-color: var(--negative);
  box-shadow: 0 0 0 1px var(--negative);
}

.field__unit {
  width: 28px;
  color: var(--text-subtle);
  font: 500 10px/1 var(--font-mono);
  letter-spacing: 0.04em;
}

.field__help {
  color: var(--text-subtle);
  font-size: 11px;
  line-height: 1.45;
}

.field__help--error {
  color: var(--negative);
}

.readout {
  margin: 16px 0 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-left: 2px solid var(--accent);
  border-radius: var(--radius);
  background: var(--bg-subtle);
  color: var(--text-muted);
  font-size: 11.5px;
  line-height: 1.5;
}

.readout strong {
  color: var(--text);
  font-weight: 600;
}

/* Secciones dentro de una página */
.section {
  margin-bottom: 24px;
}

.section__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.section__header h2 {
  color: var(--text-muted);
  font: 600 10.5px/1.2 var(--font-mono);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

/* Selector segmentado */
.segmented {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 2px;
  max-width: 100%;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-subtle);
}

.segmented__option {
  min-height: 24px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font: 500 10.5px/1 var(--font-ui);
  letter-spacing: 0.02em;
  text-align: center;
  white-space: nowrap;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}

.segmented__option:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text);
}

.segmented__option--active {
  border-color: var(--border-strong);
  background: var(--surface-raised);
  color: var(--text);
  font-weight: 600;
}

.segmented__option:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

@media (max-width: 720px) {
  .page {
    padding: 18px 16px 36px;
  }

  .page__header {
    align-items: flex-start;
  }

  .page__header h1 {
    font-size: 18px;
  }

  .stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .card {
    padding: 12px 14px;
  }

  .card__value {
    font-size: 1.2rem;
  }

  .form {
    padding: 16px;
  }

  .form__status {
    flex-basis: 100%;
    margin-left: 0;
  }
}

@media (max-width: 380px) {
  .stats {
    grid-template-columns: 1fr;
  }
}
```

---

### PASO 4: Resto de Archivos CSS de Componentes y Páginas

#### 4.1 `src/components/TradesTable.css`
```css
.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
}

.trades {
  width: 100%;
  border-collapse: collapse;
  color: var(--text);
  font-size: 12px;
  line-height: 1.35;
  white-space: nowrap;
}

.trades th,
.trades td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  text-align: left;
}

.trades thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  border-bottom-color: var(--border-strong);
  background: var(--bg-subtle);
  color: var(--text-subtle);
  font: 600 9.5px/1.2 var(--font-mono);
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.trades tbody tr {
  transition: background-color 100ms ease;
}

.trades tbody tr:hover {
  background: var(--surface-hover);
}

.trades tbody tr:last-child td {
  border-bottom: 0;
}

.trades tfoot th,
.trades tfoot td {
  border-top: 1px solid var(--border-strong);
  border-bottom: 0;
  background: var(--bg-subtle);
  color: var(--text);
  font-weight: 600;
}

.trades .trades__num {
  text-align: right;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.trades__pnl--positive {
  color: var(--positive);
}

.trades__pnl--negative {
  color: var(--negative);
}

.trades .trades__empty {
  padding: 28px 16px;
  color: var(--text-subtle);
  text-align: center;
}

.side {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--radius-sm);
  font: 600 9px/1 var(--font-mono);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.side--buy {
  background: var(--buy-bg);
  color: var(--positive);
}

.side--sell {
  background: var(--sell-bg);
  color: var(--sell-text);
}
```

#### 4.2 `src/components/EquityChart.css`
```css
.chart {
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
}

.chart__readout {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  margin: 0 0 8px;
  color: var(--text-muted);
  font: 400 10.5px/1.4 var(--font-mono);
  letter-spacing: 0.02em;
}

.chart__readout strong {
  color: var(--text);
  font: 600 18px/1.1 var(--font-mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}

.chart__change--positive {
  color: var(--positive);
}

.chart__change--negative {
  color: var(--negative);
}

.chart__svg {
  display: block;
  max-width: 100%;
  touch-action: pan-y;
}

.chart__grid {
  stroke: var(--border);
  stroke-width: 1;
  stroke-dasharray: 3 4;
  opacity: 0.7;
}

.chart__baseline {
  stroke: var(--chart-baseline);
  stroke-width: 1;
  stroke-dasharray: 2 4;
}

.chart__line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.chart__stop--top {
  stop-color: var(--accent);
  stop-opacity: 0.16;
}

.chart__stop--bottom {
  stop-color: var(--accent);
  stop-opacity: 0;
}

.chart__label {
  fill: var(--text-subtle);
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}

.chart__cursor {
  stroke: var(--border-strong);
  stroke-width: 1;
}

.chart__dot {
  fill: var(--accent);
  stroke: var(--surface);
  stroke-width: 2;
}

.chart__empty {
  margin: 0;
  padding: 28px 16px;
  color: var(--text-subtle);
  font-size: 12px;
  text-align: center;
}
```

#### 4.3 `src/components/CandleChart.css`
```css
.candle--up .candle__wick {
  stroke: var(--positive);
  stroke-width: 1;
}

.candle--up .candle__body {
  fill: var(--positive);
}

.candle--down .candle__wick {
  stroke: var(--negative);
  stroke-width: 1;
}

.candle--down .candle__body {
  fill: var(--negative);
}

.chart__ohlc {
  color: var(--text-subtle);
  font: 400 10px/1.4 var(--font-mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}

.chart.chart__status {
  padding: 40px 16px;
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
}

.chart.chart__status p {
  margin: 0 0 12px;
}

.chart.chart__status--error {
  color: var(--negative);
}

.market__controls {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.overlay {
  fill: none;
  stroke-width: 1.25;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.overlay--fast {
  stroke: var(--overlay-fast);
}

.overlay--slow {
  stroke: var(--overlay-slow);
}

.signal {
  stroke: var(--bg);
  stroke-width: 1;
}

.signal--buy {
  fill: var(--signal-buy);
}

.signal--sell {
  fill: var(--signal-sell);
}

.chart__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin: 0 0 8px;
  color: var(--text-muted);
  font: 400 10px/1.4 var(--font-mono);
  letter-spacing: 0.02em;
}

.chart__swatch {
  display: inline-block;
  width: 12px;
  height: 2px;
  margin-right: 6px;
  vertical-align: middle;
  border-radius: 999px;
}

.chart__swatch--fast {
  background: var(--overlay-fast);
}

.chart__swatch--slow {
  background: var(--overlay-slow);
}

.legend__buy {
  color: var(--signal-buy);
}

.legend__sell {
  color: var(--signal-sell);
}

.rsi__zone {
  fill: var(--surface-raised);
  opacity: 0.25;
}

.rsi__line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.25;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.market__params {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-bottom: 12px;
}

.market__rsi {
  margin-top: 8px;
}

.market__signals {
  margin-top: 14px;
}

.market__subtitle {
  margin: 0 0 8px;
  color: var(--text-muted);
  font: 600 10.5px/1.2 var(--font-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
```

#### 4.4 `src/pages/BotRun.css`, `src/pages/Settings.css` y `src/pages/Backtest.css`

**`src/pages/BotRun.css`:**
```css
.run-panel {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
}

.run-panel__status {
  display: flex;
  align-items: center;
  gap: 12px;
}

.run-panel__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dot-off);
}

.run-panel__dot--on {
  background: var(--positive);
  box-shadow: 0 0 0 3px var(--positive-halo);
}

.run-panel__label {
  display: block;
  margin-bottom: 3px;
  color: var(--text-subtle);
  font: 600 9.5px/1.2 var(--font-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.run-panel__value {
  display: block;
  color: var(--text);
  font: 600 18px/1.1 var(--font-mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}

.run-panel__actions {
  display: flex;
  gap: 8px;
}

.run-summary {
  margin-top: 16px;
  padding: 16px 20px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
}

.run-summary h2 {
  margin: 0 0 14px;
  color: var(--text-muted);
  font: 600 10.5px/1.2 var(--font-mono);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.run-summary__list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  margin: 0;
}

.run-summary__list dt {
  color: var(--text-subtle);
  font: 600 9.5px/1.2 var(--font-mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.run-summary__list dd {
  margin: 4px 0 0;
  color: var(--text);
  font: 500 13px/1.3 var(--font-mono);
  font-variant-numeric: tabular-nums;
}
```

**`src/pages/Settings.css`:**
```css
.setting {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
}

.setting__text {
  flex: 1 1 260px;
  max-width: 520px;
}

.setting__title {
  margin: 0 0 3px;
  color: var(--text);
  font: 600 13px/1.25 var(--font-ui);
  letter-spacing: 0.01em;
}

.setting__desc {
  color: var(--text-muted);
  font: 400 11.5px/1.45 var(--font-ui);
}

.setting__confirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  font: 400 11.5px/1.45 var(--font-ui);
}
```

**`src/pages/Backtest.css`:**
```css
.backtest__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px 16px;
}

.backtest__check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 14px;
  color: var(--text-muted);
  font-size: 11.5px;
  line-height: 1.45;
  cursor: pointer;
}

.backtest__check input {
  margin-top: 2px;
  accent-color: var(--accent);
}

.backtest__reasons {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.backtest__reason {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-muted);
  font: 500 10px/1 var(--font-mono);
  letter-spacing: 0.02em;
}

@media (max-width: 720px) {
  .backtest__grid {
    grid-template-columns: 1fr;
  }
}
```

---

### PASO 5: Navegación Dock macOS + Barra Superior Mínima

#### 5.1 Reemplaza `src/navItems.ts`
```typescript
import type { PageId } from './types'

export type NavItem = {
  id: PageId
  label: string
  icon: string
}

export const navItems: NavItem[] = [
  { id: 'dashboard', label: 'Panel', icon: '▦' },
  { id: 'bot-config', label: 'Ajustar bot', icon: '⚙' },
  { id: 'bot-run', label: 'Ejecutar bot', icon: '▶' },
  { id: 'backtest', label: 'Backtest', icon: '⟲' },
  { id: 'stats', label: 'Estadísticas', icon: '◔' },
  { id: 'settings', label: 'Ajustes', icon: '☰' },
]

export const primaryNavIds: readonly PageId[] = [
  'dashboard',
  'bot-config',
  'bot-run',
  'backtest',
  'stats',
]

export const primaryNavItems: NavItem[] = primaryNavIds
  .map((id) => navItems.find((item) => item.id === id))
  .filter((item): item is NavItem => item !== undefined)

export const overflowNavItems: NavItem[] = navItems.filter(
  (item) => !primaryNavIds.includes(item.id),
)

export function getNavLabel(id: PageId): string {
  return navItems.find((item) => item.id === id)?.label ?? id
}
```

#### 5.2 Crea `src/components/navigation/DockIcon.tsx`
```tsx
import type { ReactNode } from 'react'
import type { PageId } from '../../types'

export type DockIconName = PageId | 'more'

const paths: Record<DockIconName, ReactNode> = {
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
    </>
  ),
  'bot-config': (
    <>
      <path d="M4 7h16" />
      <circle cx="9" cy="7" r="2" />
      <path d="M4 17h16" />
      <circle cx="15" cy="17" r="2" />
    </>
  ),
  'bot-run': (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="M10 9.25 15.5 12 10 14.75Z" />
    </>
  ),
  backtest: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M3.5 4.5v4.8h4.8" />
    </>
  ),
  stats: (
    <>
      <path d="M3 20h18" />
      <path d="M6 20v-6" />
      <path d="M12 20V6" />
      <path d="M18 20v-9" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),
}

type DockIconProps = {
  name: DockIconName
  size?: number
}

function DockIcon({ name, size = 22 }: DockIconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  )
}

export default DockIcon
```

#### 5.3 Crea `src/components/navigation/AppDock.tsx`
```tsx
import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PageId } from '../../types'
import { overflowNavItems, primaryNavItems } from '../../navItems'
import DockIcon from './DockIcon'
import './AppDock.css'

type AppDockProps = {
  activePage: PageId
  onNavigate: (page: PageId) => void
}

function AppDock({ activePage, onNavigate }: AppDockProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const dockRef = useRef<HTMLElement>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  const hasOverflow = overflowNavItems.length > 0
  const primaryIndex = primaryNavItems.findIndex(
    (item) => item.id === activePage,
  )
  const isOverflowActive = overflowNavItems.some(
    (item) => item.id === activePage,
  )
  const activeIndex =
    primaryIndex >= 0
      ? primaryIndex
      : hasOverflow && isOverflowActive
        ? primaryNavItems.length
        : 0

  useEffect(() => {
    if (!menuOpen) return

    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (target instanceof Node && !dockRef.current?.contains(target)) {
        setMenuOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
      moreButtonRef.current?.focus()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuOpen])

  function handleNavigate(page: PageId) {
    setMenuOpen(false)
    onNavigate(page)
  }

  function handleOverflowNavigate(page: PageId) {
    handleNavigate(page)
    moreButtonRef.current?.focus()
  }

  const dockStyle = { '--app-dock-index': activeIndex } as CSSProperties

  return (
    <nav
      ref={dockRef}
      className="app-dock"
      style={dockStyle}
      aria-label="Navegación principal"
    >
      <div className="app-dock__track">
        <span className="app-dock__drop" aria-hidden="true" />

        {primaryNavItems.map((item) => {
          const isActive = item.id === activePage

          return (
            <button
              key={item.id}
              type="button"
              className={`app-dock__key${
                isActive ? ' app-dock__key--active' : ''
              }`}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => handleNavigate(item.id)}
            >
              <DockIcon name={item.id} />
              <span className="app-dock__tooltip" aria-hidden="true">
                {item.label}
              </span>
            </button>
          )
        })}

        {hasOverflow && (
          <div className="app-dock__more">
            <button
              ref={moreButtonRef}
              type="button"
              className={`app-dock__key${
                isOverflowActive ? ' app-dock__key--active' : ''
              }${menuOpen ? ' app-dock__key--open' : ''}`}
              aria-label="Más opciones"
              aria-current={isOverflowActive ? 'page' : undefined}
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? menuId : undefined}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <DockIcon name="more" />
              <span className="app-dock__tooltip" aria-hidden="true">
                {isOverflowActive ? 'Más · actual' : 'Más'}
              </span>
            </button>

            {menuOpen && (
              <div
                id={menuId}
                className="app-dock__menu"
                role="group"
                aria-label="Más opciones"
              >
                {overflowNavItems.map((item) => {
                  const isActive = item.id === activePage

                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`app-dock__menu-item${
                        isActive ? ' app-dock__menu-item--active' : ''
                      }`}
                      aria-current={isActive ? 'page' : undefined}
                      onClick={() => handleOverflowNavigate(item.id)}
                    >
                      <DockIcon name={item.id} size={18} />
                      {item.label}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </nav>
  )
}

export default AppDock
```

#### 5.4 Crea `src/components/navigation/AppDock.css`
```css
/* Dock flotante, centrado y compacto (móvil y escritorio). */
.app-dock {
  position: fixed;
  left: 50%;
  bottom: calc(10px + env(safe-area-inset-bottom, 0px));
  z-index: 60;
  padding: var(--dock-pad);
  border: 1px solid var(--border-strong);
  border-radius: 16px;
  background: var(--surface-raised);
  background: color-mix(in srgb, var(--surface-raised) 78%, transparent);
  box-shadow: var(--shadow-dock);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  backdrop-filter: blur(18px) saturate(1.2);
  transform: translateX(-50%);
}

.app-dock__track {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: var(--dock-gap);
  padding-bottom: var(--dock-indicator-lane);
}

/* Gota activa: se desliza con una sola variable CSS, sin medir el DOM. */
.app-dock__drop {
  position: absolute;
  left: 0;
  bottom: var(--dock-indicator-lane);
  z-index: 0;
  width: var(--dock-tile);
  height: var(--dock-tile);
  border-radius: 11px;
  background: var(--text);
  box-shadow: 0 8px 18px rgba(0, 0, 0, 0.28);
  pointer-events: none;
  transform: translateX(
      calc(var(--app-dock-index) * (var(--dock-tile) + var(--dock-gap)))
    )
    translateY(-2px);
  transition: transform 420ms cubic-bezier(0.22, 1, 0.36, 1);
  will-change: transform;
}

/* Subrayado inferior en color invertido (--text), no en --negative. */
.app-dock__drop::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: calc(-1 * var(--dock-indicator-lane));
  width: 12px;
  height: 2px;
  border-radius: 999px;
  background: var(--text);
  transform: translateX(-50%);
}

.app-dock__key {
  position: relative;
  z-index: 1;
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: var(--dock-tile);
  height: var(--dock-tile);
  padding: 0;
  border: 0;
  border-radius: 11px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition:
    color 160ms ease,
    background-color 160ms ease,
    transform 160ms ease;
}

.app-dock__key svg {
  display: block;
}

.app-dock__key:hover {
  background: var(--surface-hover);
  color: var(--text);
  transform: translateY(-2px);
}

.app-dock__key--open:not(.app-dock__key--active) {
  background: var(--surface-hover);
  color: var(--text);
}

.app-dock__key--active,
.app-dock__key--active:hover {
  background: transparent;
  color: var(--bg);
  transform: translateY(-2px);
}

.app-dock__key:active {
  transform: scale(0.94);
}

.app-dock__key:focus-visible,
.app-dock__menu-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* Tooltip: solo informativo; el nombre accesible está en aria-label. */
.app-dock__tooltip {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 50%;
  z-index: 2;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.1;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, 4px);
  transition: opacity 140ms ease, transform 140ms ease;
}

.app-dock__key:hover .app-dock__tooltip,
.app-dock__key:focus-visible .app-dock__tooltip {
  opacity: 1;
  transform: translate(-50%, 0);
}

.app-dock__key--open .app-dock__tooltip {
  display: none;
}

@media (hover: none) {
  .app-dock__key:hover:not(:focus-visible) .app-dock__tooltip {
    opacity: 0;
    transform: translate(-50%, 4px);
  }
}

/* Contenedor del botón Más y su menú. */
.app-dock__more {
  position: relative;
  z-index: 2;
  flex: 0 0 auto;
  width: var(--dock-tile);
  height: var(--dock-tile);
}

.app-dock__menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 12px);
  z-index: 20;
  min-width: 180px;
  max-width: min(280px, calc(100vw - 24px));
  padding: 6px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--surface-raised);
  box-shadow: var(--shadow-dock);
  transform-origin: bottom right;
  animation: app-dock-menu-in 160ms cubic-bezier(0.22, 1, 0.36, 1);
}

@keyframes app-dock-menu-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.96);
  }

  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.app-dock__menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.2;
  text-align: left;
  cursor: pointer;
}

.app-dock__menu-item svg {
  flex: 0 0 auto;
}

.app-dock__menu-item:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.app-dock__menu-item--active,
.app-dock__menu-item--active:hover {
  background: var(--text);
  color: var(--bg);
}

@media (prefers-reduced-motion: reduce) {
  .app-dock__drop,
  .app-dock__key,
  .app-dock__tooltip {
    transition: none;
  }

  .app-dock__menu {
    animation: none;
  }
}

@media (forced-colors: active) {
  .app-dock {
    border-color: CanvasText;
  }

  .app-dock__drop {
    background: Highlight;
  }

  .app-dock__key--active {
    color: HighlightText;
  }

  .app-dock__menu-item--active {
    background: Highlight;
    color: HighlightText;
  }
}
```

#### 5.5 Crea `src/components/navigation/AppTopBar.tsx` y `AppTopBar.css`

**`src/components/navigation/AppTopBar.tsx`:**
```tsx
import type { PageId } from '../../types'
import { getNavLabel } from '../../navItems'
import './AppTopBar.css'

type AppTopBarProps = {
  activePage: PageId
}

function AppTopBar({ activePage }: AppTopBarProps) {
  return (
    <header className="app-topbar">
      <span className="app-topbar__brand">LIXTRD</span>
      <span className="app-topbar__title" aria-live="polite">
        {getNavLabel(activePage)}
      </span>
    </header>
  )
}

export default AppTopBar
```

**`src/components/navigation/AppTopBar.css`:**
```css
/* Barra superior mínima: marca a la izquierda y página actual a la derecha. */
.app-topbar {
  position: sticky;
  top: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 38px;
  padding: calc(6px + env(safe-area-inset-top, 0px)) clamp(12px, 4vw, 24px) 6px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  background: color-mix(in srgb, var(--bg) 84%, transparent);
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
}

.app-topbar__brand {
  flex: 0 0 auto;
  color: var(--text);
  font-family: var(--font-display);
  font-size: 1.1rem;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.14em;
}

.app-topbar__title {
  min-width: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  letter-spacing: 0.08em;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}
```

#### 5.6 Modifica `src/App.tsx` (2 puntos exactos)

1. Cambia la línea 8 (`import Sidebar from './components/Sidebar'`):
```tsx
import AppDock from './components/navigation/AppDock'
import AppTopBar from './components/navigation/AppTopBar'
```

2. Cambia el bloque `return` al final de `src/App.tsx`:
```tsx
  return (
    <div className="app">
      <AppTopBar activePage={activePage} />
      <AppDock activePage={activePage} onNavigate={setActivePage} />
      <main className="content">{renderPage()}</main>
    </div>
  )
```

---

## 6. Maneras de Explorar Alternativas (con Código Listo)

### Alternativa 1: Conservar el Sidebar Clásico en lugar del Dock
Si prefieres mantener el menú lateral izquierdo en escritorio y la barra compacta superior en móvil:
1. No modifiques `src/App.tsx` ni `src/navItems.ts`.
2. En `src/App.css`, usa este bloque para `.app`:
```css
.app {
  display: grid;
  grid-template-columns: 224px minmax(0, 1fr);
  min-height: 100vh;
}
@media (max-width: 720px) {
  .app {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
    align-content: start;
  }
}
```
3. Aplica el Paso 4 de `GUIA_ESTETICA_APEXJOURNAL.md` en `src/components/Sidebar.css`.

### Alternativa 2: Cambiar el Color de Señal (Lima → Naranja Apex / Ámbar / Azul Hielo)
Si quieres probar el acento naranja original de ApexJournal (`#ED775C`) o un tono más frío en `src/index.css`:

```css
/* Opción Naranja Señal (ApexJournal Original) */
:root {
  --accent: #ed775c;
  --primary: #ed775c;
  --primary-hover: #dc654a;
  --on-primary: #0b0d08;
}

/* Opción Azul Hielo Cuantitativo */
:root {
  --accent: #7dd3fc;
  --primary: #7dd3fc;
  --primary-hover: #38bdf8;
  --on-primary: #06121a;
}
```

### Alternativa 3: Fallback Automático Offline en `src/hooks/useCandles.ts` (Calidad Producción)
Si deseas que la app funcione sin internet o cuando Binance bloquee peticiones, puedes envolver el catch de `fetchBinanceCandles` para que use el generador determinista `generateSyntheticCandles` que ya tienes en `src/market/synthetic.ts`:

```typescript
import { generateSyntheticCandles } from '../market/synthetic'

// Dentro del bloque catch de useCandles.ts:
const fallback = generateSyntheticCandles(pair, interval, 240)
setCandles(fallback)
```

---

## 7. Comandos de Verificación Final

Una vez pegados los archivos anteriores, ejecuta en tu terminal:

```powershell
pnpm test
pnpm run build
pnpm dev
```
Todo compilará en limpio, sin errores de TypeScript y con los 29 tests en verde.
