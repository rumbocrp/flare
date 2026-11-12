# FLARE — Manual de shadcn/ui

> **Estado:** documento de instrucciones. **No modifica código.**
> **Objetivo:** instalar shadcn/ui en FLARE y aplicar sus componentes sin romper el tema terminal, el modo claro/oscuro, la tipografía VT323 ni la lógica existente.
> **Versiones verificadas:** shadcn CLI `4.23.0`, Tailwind CSS `4.3.5`, Vite `8.3.7`, React `19.3.1`, TypeScript `7.0.2`.
> **Fecha:** 11 de noviembre de 2026.

---

## 0. Qué es shadcn/ui y qué no es

shadcn/ui **no es una librería de componentes instalable**. Es una colección de componentes cuyo código fuente se copia dentro de tu proyecto mediante un CLI. Una vez copiado, el componente es tuyo: puedes editarlo, borrarlo o adaptarlo.

Consecuencias prácticas:

| Característica | Implicación para FLARE |
|---|---|
| El código vive en `src/components/ui/` | Forma parte del repositorio y del control de versiones. |
| Está construido sobre Tailwind CSS | Tailwind es obligatorio; no hay versión “sin Tailwind”. |
| Usa primitives de Radix UI o Base UI | Aportan accesibilidad, teclado, foco y portales. |
| Los estilos usan tokens semánticos | Se pueden mapear a los tokens que FLARE ya tiene. |
| No es un paquete que se actualiza solo | Actualizar un componente implica volver a copiarlo o comparar cambios. |

**Para FLARE la estrategia correcta no es reemplazar el diseño existente**, sino instalar Tailwind en modo convivencia, mapear los tokens de shadcn a los tokens de FLARE y migrar componentes poco a poco.

---

## 1. Estrategia recomendada para FLARE

### 1.1. Qué se conserva

- La paleta terminal verde, los tokens `--bg`, `--text`, `--primary`, `--positive`, `--negative`, etc.
- La tipografía `VT323`.
- El tema oscuro por defecto y el tema claro mediante `data-theme`.
- Las páginas, la lógica de backtest, las señales y los gráficos SVG actuales.
- El CSS propio de FLARE (`App.css`, `Sidebar.css`, `Backtest.css`, etc.).

### 1.2. Qué se añade

- Tailwind CSS v4 como capa de utilidades.
- `src/components/ui/` con los componentes de shadcn.
- `src/lib/utils.ts` con el helper `cn`.
- Un puente de tokens shadcn → tokens FLARE.
- Componentes nuevos solo donde aporten valor: botones, cards, inputs, diálogos, tabs, badges y tablas.

### 1.3. Qué no se debe tocar al principio

| Zona | Motivo |
|---|---|
| `Sidebar.tsx` y `Sidebar.css` | Tiene comportamiento móvil y una estética muy específica. |
| `CandleChart`, `EquityChart`, `RsiPanel` | Son SVG propios; sustituirlos por una librería cambia el rendimiento y la estética. |
| `backtest.ts`, `signals.ts`, `metrics.ts` | Es lógica de negocio, no UI. |
| `Stats.tsx` y `Backtest.tsx` completos | Son las páginas con más texto y hoy tienen errores de compilación preexistentes. |

### 1.4. Orden de adopción

1. Tailwind + alias + puente de tema.
2. `Button` y `Card` en Ajustes.
3. `AlertDialog` para la confirmación de borrado.
4. `Input`, `Label`, `Select` y `Switch` en formularios.
5. `Table` y `Badge` en la tabla de operaciones.
6. `Tabs` en los filtros de Estadísticas.
7. `Tooltip` y, opcionalmente, `Sonner`.
8. Bloques o charts de shadcn solo si de verdad aportan algo.

---

## 2. Requisitos y advertencias

### 2.1. Requisitos

- Node.js moderno (el proyecto ya usa Vite 8).
- `pnpm` como gestor de paquetes.
- React 19.3 o superior.
- TypeScript 7.0 o superior.
- El proyecto ya tiene `@types/node`, necesario para el alias de Vite.

### 2.2. Advertencia específica de TypeScript 7

La documentación oficial de shadcn para Vite recomienda añadir `baseUrl` y `paths` al `tsconfig`. **En TypeScript 7, `baseUrl` fue eliminado** y el build falla con:

```text
error TS5102: Option 'baseUrl' has been removed.
```

En FLARE hay que usar **solo `paths`**:

```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

El CLI de shadcn valida el alias correctamente sin `baseUrl`; se probó con TypeScript 7.0.2.

### 2.3. Advertencia sobre el build actual

`pnpm build` hoy no pasa por errores que **no tienen relación con shadcn**:

- `src/App.tsx`: `lastBacktest` sin usar y `<Stats />` sin props.
- `src/backtest.ts:413`: `position` estrechado a `never`.
- `src/metrics.ts`: `initialBalance` sin usar.
- `src/market/synthetic.ts`: falta la clave `'5m'`.
- `src/pages/Stats.tsx`: imports faltantes y filtrado incorrecto.

Antes de culpar a shadcn, corrige esos puntos o compara la lista de errores antes y después. El manual `GUIA_IDIOMAS_INGLES_ESPANOL.md` documenta varios de ellos.

### 2.4. Advertencia sobre `src/index.css`

`shadcn init` **reescribe `src/index.css`**. En un proyecto vacío no importa; en FLARE sí, porque ese archivo contiene todos los tokens del tema. Hay que hacer copia de seguridad antes de ejecutar el CLI.

---

## 3. Fase 0 — Red de seguridad

### 3.1. Revisar el estado del repositorio

```powershell
git status --short
git diff --stat
```

FLARE tiene cambios en curso. No los descartes.

### 3.2. Crear una rama o una copia

Si puedes commitear los cambios actuales:

```powershell
git switch -c feat/shadcn-ui
```

Si no quieres commitear todavía, al menos copia los archivos que el CLI puede tocar:

```powershell
Copy-Item src/index.css src/index.css.pre-shadcn.bak
Copy-Item vite.config.ts vite.config.ts.pre-shadcn.bak
Copy-Item tsconfig.json tsconfig.json.pre-shadcn.bak
Copy-Item tsconfig.app.json tsconfig.app.json.pre-shadcn.bak
Copy-Item package.json package.json.pre-shadcn.bak
```

Añade `*.pre-shadcn.bak` a `.gitignore` o bórralos al terminar.

### 3.3. Criterio de éxito de esta fase

- Puedes volver al estado anterior con `git` o con las copias.
- Sabes qué archivos va a tocar el CLI: `src/index.css`, `package.json`, `pnpm-lock.yaml`, `components.json`, `src/lib/utils.ts` y `src/components/ui/`.

---

## 4. Fase 1 — Instalar Tailwind CSS v4

### 4.1. Instalar dependencias

```powershell
pnpm add -D tailwindcss @tailwindcss/vite
```

Tailwind v4 no necesita `tailwind.config.js` ni `postcss.config.js`. El plugin de Vite hace todo.

### 4.2. Actualizar `vite.config.ts`

Situación actual:

```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
})
```

Configuración nueva:

```ts
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src'),
    },
  },
})
```

Se usa `fileURLToPath(import.meta.url)` en lugar de `__dirname` porque el proyecto es ESM (`"type": "module"`).

### 4.3. Añadir el alias a TypeScript

En `tsconfig.json` (el archivo raíz con `references`):

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ],
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

En `tsconfig.app.json`, dentro de `compilerOptions`:

```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

**No añadas `baseUrl`.** Con TypeScript 7 el build falla.

### 4.4. Importar Tailwind sin destruir el tema

Abre `src/index.css` y añade **como primera línea**:

```css
@import "tailwindcss";
```

No reemplaces el resto del archivo. Los `@import` de CSS deben ir antes que cualquier otra regla.

### 4.5. Verificar la línea base

```powershell
pnpm dev
```

Recorre Dashboard, Bot setup, Run bot, Backtest, Statistics y Settings. La apariencia debe ser prácticamente idéntica. Tailwind añade un preflight (reset) en la capa `base`, pero el CSS de FLARE no está en capas, así que sus reglas ganan.

Si algo cambia visualmente, anota qué elemento y en qué página antes de seguir. No añadas componentes todavía.

### 4.6. Cómo conviven Tailwind y el CSS de FLARE

Esta es la regla más importante del manual:

```text
CSS sin capa (FLARE)  >  @layer utilities (Tailwind)  >  @layer base (preflight)
```

- El CSS actual de FLARE es **unlayered** (sin `@layer`). Por eso sigue ganando.
- Los componentes de shadcn usan utilidades de Tailwind, que están en `@layer utilities`.
- Si un selector de FLARE coincide con un elemento de shadcn (por ejemplo `.field__control input`), el estilo de FLARE gana aunque shadcn tenga clases más específicas.

Eso es bueno para la convivencia, pero significa que **para que un componente de shadcn se vea como shadcn hay que retirar o estrechar el selector antiguo de FLARE**.

Ejemplo:

```css
/* Antes: afecta a cualquier input dentro de .field__control */
.field__control input {
  height: 2.5rem;
  border: 1px solid var(--border);
  background: var(--surface);
}

/* Después de migrar a <Input>, borra esa regla o limita su alcance */
```

Si prefieres que las utilidades de Tailwind puedan sobrescribir todo el CSS antiguo, puedes envolver el CSS de FLARE en una capa:

```css
@layer theme, base, legacy, components, utilities;

@layer legacy {
  /* ...reglas antiguas de FLARE... */
}
```

No es obligatorio. Para una migración incremental, dejar el CSS antiguo sin capa y borrar selectores a medida que migras es menos arriesgado.

---

## 5. Fase 2 — Inicializar shadcn/ui

### 5.1. Comando recomendado

```powershell
pnpm dlx shadcn@latest init --base radix --preset nova --yes --css-variables
```

Qué significa cada opción:

| Opción | Valor | Motivo |
|---|---|---|
| `--base radix` | Radix UI | Es la base clásica, con `asChild`, la más documentada. |
| `--preset nova` | Estilo `radix-nova` | Evita el prompt interactivo y da un punto de partida estable. |
| `--yes` | Sin confirmación | Agiliza la instalación. |
| `--css-variables` | Tokens CSS | Necesario para mapear el tema de FLARE. |

No uses `--template vite` en un proyecto existente: ese flag es para crear un proyecto nuevo.

### 5.2. Qué hace el CLI

1. Crea `components.json`.
2. Crea `src/lib/utils.ts`.
3. Instala dependencias:
   - `shadcn`
   - `cn`
   - `radix-ui`
   - `class-variance-authority`
   - `lucide-react`
   - `tw-animate-css`
   - `@fontsource-variable/geist`
4. Reescribe `src/index.css` para añadir los imports y los tokens de shadcn.

La salida esperada termina así:

```text
Project initialization completed.
You may now add components.
```

### 5.3. `components.json` esperado

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "radix-nova",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/index.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "rtl": false,
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "menuColor": "default",
  "menuAccent": "subtle",
  "registries": {}
}
```

Notas:

- `"style": "radix-nova"` no se debe cambiar después de inicializar.
- `"tailwind.config": ""` es correcto en Tailwind v4.
- Los alias deben coincidir con los `paths` de TypeScript y con el alias de Vite.

### 5.4. Si `src/index.css` quedó sobrescrito

Compara:

```powershell
git diff -- src/index.css
```

Si el CLI reemplazó tus tokens, restaura tu copia:

```powershell
Copy-Item src/index.css.pre-shadcn.bak src/index.css
```

Conserva del archivo generado solo los imports que necesites:

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";
```

Después aplica el puente de la sección 6.

### 5.5. Si el CLI no valida el alias

Crea `components.json` manualmente con el JSON de la sección 5.3 y comprueba que existen:

- `paths` en `tsconfig.json` y `tsconfig.app.json`.
- Alias `@` en `vite.config.ts`.
- Dependencias `shadcn`, `cn`, `radix-ui`, `class-variance-authority`, `lucide-react` y `tw-animate-css`.

### 5.6. Alternativa Base UI

Si en el futuro eliges `--base base` (Base UI), los componentes usan la prop `render` en lugar de `asChild`:

```tsx
<Button render={<a href="/backtest" />}>Backtest</Button>
```

No mezcles componentes generados con `--base radix` y `--base base` en el mismo proyecto sin revisar sus APIs. Este manual asume **Radix**.

---

## 6. Fase 3 — Puente de tema FLARE → shadcn

### 6.1. Por qué hace falta un puente

shadcn espera tokens como `--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--accent`, `--border`, `--ring` y `--radius`. FLARE ya tiene sus propios nombres:

```text
FLARE:  --bg, --text, --surface, --surface-hover, --border, --primary, --accent...
shadcn: --background, --foreground, --card, --muted, --border, --primary, --ring...
```

Si dejas los tokens de shadcn que genera el CLI, se sobrescriben `--primary`, `--border` y `--accent` de FLARE y la interfaz cambia de color. Hay que evitarlo.

### 6.2. Tabla de equivalencias

| Token shadcn | Token FLARE | Nota |
|---|---|---|
| `background` | `--bg` | Fondo de página. |
| `foreground` | `--text` | Texto principal. |
| `card` | `--surface` | Superficie de tarjetas. |
| `card-foreground` | `--text` | Texto de tarjetas. |
| `popover` | `--surface-raised` | Diálogos, menús, tooltips. |
| `popover-foreground` | `--text` | Texto de diálogos. |
| `primary` | `--primary` | Ya existe en FLARE; no lo redefinas. |
| `primary-foreground` | `--on-primary` | Texto sobre el verde primario. |
| `secondary` | `--surface-raised` | Botones secundarios. |
| `secondary-foreground` | `--text` | Texto secundario. |
| `muted` | `--surface-hover` | Superficie atenuada. |
| `muted-foreground` | `--text-muted` | Texto secundario. |
| `accent` | `--surface-hover` | **Ojo:** no uses `--accent` de FLARE aquí. |
| `accent-foreground` | `--text` | Texto sobre hover. |
| `destructive` | `--negative` | Errores y acciones destructivas. |
| `destructive-foreground` | `--on-destructive` | Texto sobre rojo. |
| `border` | `--border` | Ya existe en FLARE. |
| `input` | `--border-strong` | Borde de inputs. |
| `ring` | `--accent` | Foco visible. |
| `radius` | `0.75rem` | Equivale a los 12 px actuales de Ajustes. |
| `chart-1..5` | `--positive`, `--negative`, `--sell-text`, `--overlay-slow`, `--signal-sell` | Coherencia con los gráficos. |

### 6.3. Conflicto de `--accent`

FLARE usa `--accent` como **color de texto verde brillante** en varios CSS:

- `Sidebar.css`
- `TradesTable.css`
- `CandleChart.css`
- `EquityChart.css`

shadcn usa `accent` como **superficie de hover**. Si redefines `--accent` al valor de shadcn, rompes esos estilos.

Solución: deja `--accent` como está y mapea la utilidad `bg-accent` de Tailwind a `--surface-hover`:

```css
@theme inline {
  --color-accent: var(--surface-hover);
}
```

Así `bg-accent` y `hover:bg-accent` funcionan sin tocar el `--accent` de FLARE.

### 6.4. `src/index.css` completo recomendado

Sustituye el contenido de `src/index.css` por este. Incluye los imports, los tokens originales de FLARE, los alias de shadcn, el `@theme inline` y las reglas base.

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";

@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));

:root {
  color-scheme: dark;

  /* Tokens originales de FLARE */
  --bg: #000000;
  --bg-subtle: #050505;
  --surface: #050505;
  --surface-hover: #0a0a0a;
  --surface-raised: #001a00;
  --surface-raised-hover: #0a1a0a;
  --border: #003b00;
  --border-strong: #005518;
  --chart-baseline: #003300;
  --dot-off: #003300;
  --text: #00ff41;
  --text-muted: #00b51b;
  --text-subtle: #009a14;
  --accent: #00ff41;
  --primary: #00ff41;
  --primary-hover: #00cc33;
  --on-primary: #000000;
  --positive: #00cc33;
  --negative: #ff0000;
  --buy-bg: #001a0a;
  --sell-bg: #1a0000;
  --sell-text: #ffb454;
  --positive-halo: rgba(0, 255, 65, 0.2);
  --overlay-fast: #ffb454;
  --overlay-slow: #5ec8ff;
  --signal-buy: #ffffff;
  --signal-sell: #ff4fa3;

  /* Tokens de shadcn que no chocan con FLARE */
  --radius: 0.75rem;
  --background: var(--bg);
  --foreground: var(--text);
  --card: var(--surface);
  --card-foreground: var(--text);
  --popover: var(--surface-raised);
  --popover-foreground: var(--text);
  --primary-foreground: var(--on-primary);
  --secondary: var(--surface-raised);
  --secondary-foreground: var(--text);
  --muted: var(--surface-hover);
  --muted-foreground: var(--text-muted);
  --accent-foreground: var(--text);
  --destructive: var(--negative);
  --on-destructive: #ffffff;
  --destructive-foreground: var(--on-destructive);
  --input: var(--border-strong);
  --ring: var(--accent);
}

:root[data-theme="light"] {
  color-scheme: light;

  --bg: #f0fff4;
  --bg-subtle: #d4f7de;
  --surface: #e8fff0;
  --surface-hover: #d4f7de;
  --surface-raised: #c2f3ca;
  --surface-raised-hover: #b4efbc;
  --border: #69e38a;
  --border-strong: #4cc06a;
  --chart-baseline: #9ef0ad;
  --dot-off: #9ef0ad;
  --text: #004d00;
  --text-muted: #1f7a35;
  --text-subtle: #2a7d3f;
  --accent: #006b1b;
  --primary: #008a2a;
  --primary-hover: #006b20;
  --on-primary: #ffffff;
  --positive: #006b1b;
  --negative: #cc0000;
  --buy-bg: #dff7e8;
  --sell-bg: #ffe6e6;
  --sell-text: #aa3300;
  --positive-halo: rgba(0, 170, 51, 0.2);
  --overlay-fast: #b25e00;
  --overlay-slow: #0b6fa8;
  --signal-buy: #003d00;
  --signal-sell: #b3126b;
}

@theme inline {
  --font-sans: "VT323", ui-monospace, monospace;
  --font-mono: "VT323", ui-monospace, monospace;
  --font-heading: "VT323", ui-monospace, monospace;

  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--surface-hover);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-chart-1: var(--positive);
  --color-chart-2: var(--negative);
  --color-chart-3: var(--sell-text);
  --color-chart-4: var(--overlay-slow);
  --color-chart-5: var(--signal-sell);
  --color-sidebar: var(--surface);
  --color-sidebar-foreground: var(--text);
  --color-sidebar-primary: var(--primary);
  --color-sidebar-primary-foreground: var(--on-primary);
  --color-sidebar-accent: var(--surface-hover);
  --color-sidebar-accent-foreground: var(--text);
  --color-sidebar-border: var(--border);
  --color-sidebar-ring: var(--accent);

  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
  --radius-2xl: calc(var(--radius) * 1.8);
  --radius-3xl: calc(var(--radius) * 2.2);
  --radius-4xl: calc(var(--radius) * 2.6);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }

  html {
    @apply font-sans;
  }

  button:not(:disabled),
  [role="button"]:not(:disabled) {
    cursor: pointer;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: "VT323", ui-monospace, monospace;
  font-size: 1.2rem;
}
```

### 6.5. Por qué `@custom-variant dark` usa `data-theme`

FLARE no usa la clase `.dark`. Su hook `useTheme` escribe:

```ts
document.documentElement.dataset.theme = 'dark' | 'light'
```

Por eso el variant de Tailwind se define así:

```css
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));
```

No uses el `.dark` que genera shadcn por defecto; no se activaría nunca en FLARE.

### 6.6. Tipografía y radio

- `--font-sans`, `--font-mono` y `--font-heading` apuntan a `VT323`.
- `--radius: 0.75rem` mantiene los 12 px de las tarjetas actuales.
- Si quieres un look más cuadrado, usa `0.5rem`; si quieres más redondeado, `1rem`.

### 6.7. Limpieza opcional de Geist

El CLI añade `@fontsource-variable/geist`. Como el puente usa VT323, puedes quitar el import y la dependencia:

```powershell
pnpm remove @fontsource-variable/geist
```

Comprueba que no queda ningún `@import "@fontsource-variable/geist";` en `src/index.css`.

### 6.8. Contraste y accesibilidad

- No uses colores crudos de Tailwind (`text-green-400`, `bg-red-500`). Usa tokens: `text-foreground`, `bg-card`, `text-[var(--positive)]`, `text-[var(--negative)]`.
- Para ganancias y pérdidas, mantén la semántica de FLARE: `--positive` para ganancia, `--negative` para pérdida.
- Acompaña el color con un signo (`+`/`−`) o un glifo (`▲`/`▼`); el color no debe ser el único canal.
- Verifica el foco con teclado en ambos temas. `--ring` apunta a `--accent`, que es visible sobre fondo oscuro y claro.
- `color-scheme: dark` se mantiene en `:root`; el tema claro lo cambia a `light`.

---

## 7. Fase 4 — Añadir componentes

### 7.1. Lista recomendada para FLARE

```powershell
pnpm dlx shadcn@latest add button card input label alert-dialog tabs badge table switch tooltip select separator dialog toggle-group
```

Opcional:

```powershell
pnpm dlx shadcn@latest add sonner
```

### 7.2. Qué aporta cada uno

| Componente | Uso previsto en FLARE |
|---|---|
| `button` | Sustituir `.btn` y `.btn--primary` de Ajustes, Backtest y BotRun. |
| `card` | Sustituir `.setting` y agrupar métricas. |
| `input` | Campos numéricos de Backtest y BotConfig. |
| `label` | Etiquetas accesibles de los campos. |
| `alert-dialog` | Confirmación de “Restore data”. |
| `tabs` | Filtros All / Winners / Losers de Statistics. |
| `badge` | Estados del bot y lados BUY/SELL. |
| `table` | Tabla de operaciones. |
| `switch` | Opciones booleanas, como “Allow shorts”. |
| `tooltip` | Explicar comisiones, slippage y riesgo. |
| `select` | Par, temporalidad y tipo de media. |
| `separator` | Separadores visuales. |
| `dialog` | Formularios o detalles que no sean destructivos. |
| `toggle-group` | Selector de tema o filtros segmentados. |
| `sonner` | Avisos de “guardado” o error; requiere adaptación. |

### 7.3. Inspeccionar antes de instalar

```powershell
pnpm dlx shadcn@latest view button card dialog
pnpm dlx shadcn@latest search @shadcn -q "table"
```

Para previsualizar sin escribir archivos:

```powershell
pnpm dlx shadcn@latest add dashboard-01 --dry-run
```

### 7.4. Qué archivos crea

```text
src/
├── components/
│   └── ui/
│       ├── alert-dialog.tsx
│       ├── badge.tsx
│       ├── button.tsx
│       ├── card.tsx
│       ├── dialog.tsx
│       ├── input.tsx
│       ├── label.tsx
│       ├── select.tsx
│       ├── separator.tsx
│       ├── sonner.tsx
│       ├── switch.tsx
│       ├── table.tsx
│       ├── tabs.tsx
│       ├── toggle-group.tsx
│       └── tooltip.tsx
└── lib/
    └── utils.ts
```

### 7.5. El helper `cn`

En shadcn 4.23, `src/lib/utils.ts` es:

```ts
export { cn } from "cn"
```

Los componentes generados importan directamente:

```ts
import { cn } from "cn"
```

Los ejemplos antiguos importan:

```ts
import { cn } from "@/lib/utils"
```

Ambos funcionan. Para tus propios componentes, usa `@/lib/utils` si prefieres una ruta estable del proyecto.

### 7.6. Verificar después de añadir

```powershell
pnpm build
```

Los componentes generados son compatibles con TypeScript 7, `verbatimModuleSyntax` y `erasableSyntaxOnly`. Se verificó con una app Vite temporal.

---

## 8. Fase 5 — Aplicar componentes a FLARE

### 8.1. Mapa de sustitución

| FLARE actual | shadcn | Observación |
|---|---|---|
| `.btn` | `Button` | Añade `className="h-10 px-4 text-base"` para conservar el tamaño. |
| `.btn--primary` | `Button` (default) | Ya usa `--primary`. |
| `.btn--danger` | `Button variant="destructive"` | Usa `--negative`. |
| `.segmented` | `ToggleGroup` o `Tabs` | ToggleGroup para opciones; Tabs para paneles. |
| `.setting` | `Card` | CardHeader + CardContent. |
| `input` / `select` | `Input` / `Select` | Revisa la especificidad del CSS antiguo. |
| `.table-wrap` / `.trades` | `Table` | Conserva los formatos de `format.ts`. |
| `.side--buy` / `.side--sell` | `Badge` | Usa tokens `--buy-bg`, `--sell-bg`, `--positive`, `--sell-text`. |
| Confirmación inline | `AlertDialog` | Mejor foco y teclado. |
| Filtros de Stats | `Tabs` | Mantén el estado `TradeFilter`. |
| Textos de ayuda | `Tooltip` | No sustituyas todos los hints; solo los que se repiten. |

### 8.2. Ajustes: Card + Button

Antes:

```tsx
<section className='setting'>
  <div className='setting__text'>
    <h2 className='setting__title'>Theme</h2>
    <p className='setting__desc'>Choose how Flare talks to you</p>
  </div>

  <div className='segmented' role='group' aria-label='Theme'>
    {themeOptions.map((option) => (
      <button
        key={option.id}
        type='button'
        className={`segmented__option ${
          settings.theme === option.id ? 'segmented__option--active' : ''
        }`}
        aria-pressed={settings.theme === option.id}
        onClick={() => handleThemeChange(option.id)}
      >
        {option.label}
      </button>
    ))}
  </div>
</section>
```

Después:

```tsx
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

<Card>
  <CardHeader>
    <CardTitle>Theme</CardTitle>
    <CardDescription>Choose how Flare talks to you.</CardDescription>
  </CardHeader>

  <CardContent className='flex flex-wrap gap-2'>
    {themeOptions.map((option) => (
      <Button
        key={option.id}
        type='button'
        variant={settings.theme === option.id ? 'default' : 'outline'}
        aria-pressed={settings.theme === option.id}
        onClick={() => handleThemeChange(option.id)}
        className='h-10 px-4 text-base'
      >
        {option.label}
      </Button>
    ))}
  </CardContent>
</Card>
```

Qué eliminar de `Settings.css` cuando migres esta sección:

- `.setting`
- `.setting__text`
- `.setting__title` (si existe)
- `.setting__desc`
- `.segmented`
- `.segmented__option`
- `.segmented__option--active`

No borres `.setting__confirm` hasta migrar también la confirmación.

### 8.3. Ajustes: ToggleGroup

Si prefieres un control segmentado en lugar de botones sueltos:

```tsx
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

<ToggleGroup
  type='single'
  value={settings.theme}
  onValueChange={(value) => {
    if (value) handleThemeChange(value as ThemeSetting)
  }}
  variant='outline'
  className='flex-wrap'
>
  {themeOptions.map((option) => (
    <ToggleGroupItem
      key={option.id}
      value={option.id}
      className='h-10 px-4 text-base'
    >
      {option.label}
    </ToggleGroupItem>
  ))}
</ToggleGroup>
```

`ToggleGroup` es Radix: `type='single'` exige `value` y `onValueChange`. Si el valor es vacío, no cambies nada.

### 8.4. Ajustes: AlertDialog para “Restore data”

Antes:

```tsx
{confirmingReset ? (
  <div className='setting__confirm'>
    <span>Are you sure? Your strategies and settings will be restabled.</span>
    <button className='btn btn--danger' onClick={handleConfirmReset}>
      Yes, restore data
    </button>
    <button className='btn' onClick={() => setConfirmingReset(false)}>
      Cancel
    </button>
  </div>
) : (
  <button className='btn' onClick={() => setConfirmingReset(true)}>
    Restore data
  </button>
)}
```

Después:

```tsx
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

<AlertDialog>
  <AlertDialogTrigger asChild>
    <Button variant='outline' className='h-10 px-4 text-base'>
      Restore data
    </Button>
  </AlertDialogTrigger>

  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Restore data?</AlertDialogTitle>
      <AlertDialogDescription>
        Your strategies and settings will be restored.
      </AlertDialogDescription>
    </AlertDialogHeader>

    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction onClick={handleConfirmReset}>
        Yes, restore data
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

Si usas el diálogo, puedes borrar el estado `confirmingReset` y el bloque `.setting__confirm`. `handleConfirmReset` puede quedar así:

```tsx
function handleConfirmReset() {
  onResetAll()
}
```

Ventajas: foco atrapado, cierre con Escape, `aria-modal`, botón de cancelar accesible.

### 8.5. NumberField: Label + Input

Antes:

```tsx
<div className='field'>
  <label className='field__label' htmlFor={name}>
    {label}
  </label>

  <div className='field__control'>
    <input
      id={name}
      name={name}
      type='number'
      inputMode='decimal'
      step='any'
      value={value}
      onChange={onChange}
      aria-invalid={error ? true : undefined}
      aria-describedby={`${name}-help`}
    />
    <span className='field__unit'>{unit}</span>
  </div>

  <p
    id={`${name}-help`}
    className={`field__help ${error ? 'field__help--error' : ''}`}
  >
    {error ?? hint}
  </p>
</div>
```

Después:

```tsx
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

<div className='field'>
  <Label htmlFor={name} className='field__label'>
    {label}
  </Label>

  <div className='field__control'>
    <Input
      id={name}
      name={name}
      type='number'
      inputMode='decimal'
      step='any'
      value={value}
      onChange={onChange}
      aria-invalid={error ? true : undefined}
      aria-describedby={`${name}-help`}
    />
    <span className='field__unit'>{unit}</span>
  </div>

  <p
    id={`${name}-help`}
    className={`field__help ${error ? 'field__help--error' : ''}`}
  >
    {error ?? hint}
  </p>
</div>
```

**Importante:** `App.css` tiene una regla `.field__control input` que ganará sobre las utilidades de `Input` porque no está en capas. Tienes dos opciones:

1. **Conservar el look de FLARE:** deja la regla y usa `Input` solo por semántica/accesibilidad. El resultado visual será el actual.
2. **Adoptar el look de shadcn:** elimina o reduce la regla `.field__control input` y deja que `Input` controle borde, altura y foco.

No hagas las dos cosas a medias: elige una y verifica en ambos temas.

### 8.6. TradesTable: Table + Badge

Antes:

```tsx
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
    {/* ... */}
  </table>
</div>
```

Después:

```tsx
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Hour</TableHead>
      <TableHead>Pair</TableHead>
      <TableHead>Side</TableHead>
      <TableHead className='text-right'>Entry</TableHead>
      <TableHead className='text-right'>Exit</TableHead>
      <TableHead className='text-right'>Size</TableHead>
      <TableHead className='text-right'>Result</TableHead>
    </TableRow>
  </TableHeader>

  <TableBody>
    {trades.length === 0 ? (
      <TableRow>
        <TableCell colSpan={7} className='text-center text-muted-foreground'>
          No operations to show.
        </TableCell>
      </TableRow>
    ) : (
      trades.map((trade) => {
        const pnl = tradePnl(trade)

        return (
          <TableRow key={trade.id}>
            <TableCell>{trade.time}</TableCell>
            <TableCell>{trade.pair}</TableCell>
            <TableCell>
              <Badge
                variant='outline'
                className={
                  trade.side === 'buy'
                    ? 'border-[var(--border)] bg-[var(--buy-bg)] text-[var(--positive)]'
                    : 'border-[var(--border)] bg-[var(--sell-bg)] text-[var(--sell-text)]'
                }
              >
                {sideLabels[trade.side]}
              </Badge>
            </TableCell>
            <TableCell className='text-right'>
              {formatPrice(trade.entryPrice)}
            </TableCell>
            <TableCell className='text-right'>
              {formatPrice(trade.exitPrice)}
            </TableCell>
            <TableCell className='text-right'>
              {formatMoney(trade.size)}
            </TableCell>
            <TableCell
              className={`text-right ${
                pnl > 0
                  ? 'text-[var(--positive)]'
                  : pnl < 0
                    ? 'text-[var(--negative)]'
                    : 'text-muted-foreground'
              }`}
            >
              {formatSignedMoney(pnl)}
            </TableCell>
          </TableRow>
        )
      })
    )}
  </TableBody>

  <TableFooter>
    <TableRow>
      <TableCell colSpan={6}>Total</TableCell>
      <TableCell className='text-right'>
        {formatSignedMoney(total)}
      </TableCell>
    </TableRow>
  </TableFooter>
</Table>
```

Notas:

- `Table` ya envuelve la tabla en un contenedor con scroll horizontal.
- `Table` usa `text-sm`; si quieres el tamaño de FLARE, añade `className='text-base'`.
- Conserva `formatMoney`, `formatPrice` y `formatSignedMoney`; shadcn no formatea números.
- Para el estado vacío, `colSpan={7}` debe coincidir con el número de columnas.

### 8.7. Statistics: Tabs para filtros

Antes:

```tsx
<div className='segmented' role='group' aria-label='Filter trades'>
  {filterOptions.map((option) => (
    <button
      key={option.id}
      type='button'
      className={`segmented__option ${
        filter === option.id ? 'segmented__option--active' : ''
      }`}
      aria-pressed={filter === option.id}
      onClick={() => setFilter(option.id)}
    >
      {option.label}
    </button>
  ))}
</div>
```

Después:

```tsx
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

<Tabs
  value={filter}
  onValueChange={(value) => setFilter(value as TradeFilter)}
>
  <TabsList>
    {filterOptions.map((option) => (
      <TabsTrigger key={option.id} value={option.id}>
        {option.label}
      </TabsTrigger>
    ))}
  </TabsList>
</Tabs>
```

La tabla sigue fuera del `Tabs`; el estado `filter` es el que actualiza `visibleTrades`. Si quieres paneles separados, añade `TabsContent` para cada filtro.

### 8.8. App: TooltipProvider

Los tooltips necesitan un proveedor en la raíz. En `App.tsx`:

```tsx
import { TooltipProvider } from '@/components/ui/tooltip'

return (
  <TooltipProvider>
    <div className='app'>
      <Sidebar activePage={activePage} onNavigate={setActivePage} />
      <main className='content'>{renderPage()}</main>
    </div>
  </TooltipProvider>
)
```

Úsalo solo si vas a añadir tooltips. Si no, no lo montes.

### 8.9. Sonner: avisos opcionales

El `sonner.tsx` generado importa `next-themes`:

```tsx
import { useTheme } from "next-themes"
```

FLARE no usa `next-themes`. Tienes tres opciones:

1. **No añadir Sonner.** Usa mensajes inline o el estado actual.
2. **Añadir `next-themes`** y envolver la app con su provider. Es una dependencia extra solo para toasts.
3. **Adaptar el componente** para leer `data-theme` de FLARE:

```tsx
import { useEffect, useState } from 'react'

function useFlareTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')

  useEffect(() => {
    const root = document.documentElement
    const read = () => {
      setTheme(root.dataset.theme === 'light' ? 'light' : 'dark')
    }

    read()
    const observer = new MutationObserver(read)
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })

    return () => observer.disconnect()
  }, [])

  return theme
}
```

Después:

```tsx
const theme = useFlareTheme()

return (
  <Sonner
    theme={theme}
    // ...resto de props
  />
)
```

Si eliges la opción 3, puedes quitar `next-themes`:

```powershell
pnpm remove next-themes
```

### 8.10. Lo que no conviene migrar todavía

- **Sidebar:** tiene su propio CSS, comportamiento móvil y estados activos. El `Sidebar` de shadcn es otro sistema de layout; reemplazarlo es un proyecto aparte.
- **Candlestick chart y equity chart:** son SVG propios y están integrados con los datos y los tokens. Cambiarlos por Recharts o por el chart de shadcn altera el rendimiento y la estética.
- **Toda la página Backtest de golpe:** primero corrige sus errores de compilación y luego migra campos uno a uno.
- **Tabla de operaciones con Data Table:** la receta de shadcn usa TanStack Table; para FLARE, `Table` es suficiente.

---

## 9. Fase 6 — Variantes propias: BUY, SELL, warning

### 9.1. Badge con variantes buy/sell

Opción rápida, sin editar el componente:

```tsx
<Badge
  variant='outline'
  className={
    side === 'buy'
      ? 'border-[var(--border)] bg-[var(--buy-bg)] text-[var(--positive)]'
      : 'border-[var(--border)] bg-[var(--sell-bg)] text-[var(--sell-text)]'
  }
>
  {side === 'buy' ? 'BUY' : 'SELL'}
</Badge>
```

Opción mantenible: extender `badgeVariants` en `src/components/ui/badge.tsx`:

```tsx
const badgeVariants = cva(
  // ...clases base existentes...
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground',
        secondary: 'bg-secondary text-secondary-foreground',
        destructive: 'bg-destructive/10 text-destructive',
        outline: 'border-border text-foreground',
        buy: 'border-[var(--border)] bg-[var(--buy-bg)] text-[var(--positive)]',
        sell: 'border-[var(--border)] bg-[var(--sell-bg)] text-[var(--sell-text)]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)
```

Uso:

```tsx
<Badge variant={trade.side}>BUY</Badge>
```

`trade.side` es `'buy' | 'sell'`, que coincide con las nuevas variantes.

### 9.2. Reglas de color

- Usa `--positive` para ganancia, compra o long.
- Usa `--negative` para pérdida, venta o short.
- Usa `--sell-text` para el texto de SELL si el fondo es `--sell-bg`.
- No uses `text-green-400`, `text-red-500`, `bg-emerald-500`, etc. La paleta de Tailwind no es la de FLARE y cambia entre versiones.
- Acompaña el color con un signo o un texto: `+12.40`, `−8.10`, `BUY`, `SELL`.

---

## 10. Fase 7 — Personalizar y mantener componentes

### 10.1. `className` y `cn`

Todos los componentes aceptan `className`. `cn` combina clases y resuelve conflictos con Tailwind Merge:

```tsx
<Button className='h-10 px-4 text-base'>
  Run backtest
</Button>
```

Para tus propios componentes:

```tsx
import { cn } from '@/lib/utils'

export function FlareButton({ className, ...props }: React.ComponentProps<typeof Button>) {
  return <Button className={cn('h-10 px-4 text-base', className)} {...props} />
}
```

### 10.2. `asChild`

En Radix, `asChild` permite que el componente renderice su hijo en lugar de un `<button>`:

```tsx
<Button asChild>
  <a href='/backtest'>Open backtest</a>
</Button>
```

No uses `asChild` con un hijo que ya renderiza otro botón; el DOM quedaría con dos roles interactivos.

### 10.3. Editar archivos de `ui/`

El código es tuyo. Puedes editar `button.tsx`, `badge.tsx`, etc. Pero:

- Documenta los cambios en un comentario o en este manual.
- Si vuelves a ejecutar `shadcn add button --overwrite`, perderás los cambios.
- Para actualizar, usa `--dry-run` o `--diff` y aplica solo lo que necesites.

### 10.4. No mezclar lógica de negocio con `ui/`

`src/components/ui/` debe contener componentes genéricos. La lógica de FLARE (backtest, señales, settings) va en `src/components/` o `src/pages/`.

### 10.5. Idioma

shadcn no trae i18n. Los textos siguen siendo responsabilidad de FLARE. Si aplicas la guía `GUIA_IDIOMAS_INGLES_ESPANOL.md`, los labels de shadcn deben recibir `t('...')` igual que el resto. No traduzcas `BUY`/`SELL` ni los nombres de pares.

---

## 11. Bloques, charts y Data Table

### 11.1. Blocks

Los blocks son composiciones grandes (dashboards, formularios, tablas). Se instalan con:

```powershell
pnpm dlx shadcn@latest add dashboard-01 --dry-run
pnpm dlx shadcn@latest add dashboard-01
```

Advertencias:

- Muchos blocks asumen Next.js (`next/link`, `next/image`, `usePathname`). En Vite hay que sustituir esos imports.
- Un block puede crear varios archivos y sobrescribir rutas existentes. Usa `--dry-run` primero.
- No instales un block completo para copiar un botón; añade el componente suelto.

### 11.2. Charts

```powershell
pnpm dlx shadcn@latest add chart
```

Esto añade `chart.tsx` y la dependencia `recharts`. FLARE ya tiene gráficos SVG propios; para mantener consistencia y bundle, no los reemplaces en la primera fase. Si algún día usas los charts de shadcn, mapea `--chart-1..5` a los tokens de FLARE (ya está hecho en el puente).

### 11.3. Data Table

La “Data Table” de shadcn es una receta con TanStack Table, no un componente único. Para FLARE:

- Si solo necesitas mostrar operaciones, usa `Table`.
- Si necesitas ordenar, filtrar y paginar cientos de filas, sigue la receta e instala `@tanstack/react-table`.
- No mezcles la tabla custom actual con TanStack en la misma vista sin necesidad.

### 11.4. Sidebar

El `Sidebar` de shadcn es un componente de layout con su propio estado y provider. FLARE ya tiene un sidebar funcional y adaptado a móvil. No lo sustituyas hasta que el resto de la migración esté estable.

---

## 12. Fase 8 — Verificación

### 12.1. Comandos

```powershell
pnpm build
pnpm lint
pnpm test
```

`pnpm build` ejecuta `tsc -b && vite build`. Si falla, separa los errores:

```powershell
pnpm exec tsc -b --pretty false
```

Compara la lista con los errores preexistentes de la sección 2.3. No atribuyas a shadcn errores que ya existían.

### 12.2. Checklist visual

- [ ] La app abre en oscuro y se ve igual que antes de Tailwind.
- [ ] El tema claro sigue funcionando desde Ajustes.
- [ ] `Button`, `Card` y `Input` usan los tokens de FLARE, no la paleta de shadcn.
- [ ] El foco con teclado es visible en ambos temas.
- [ ] `AlertDialog` atrapa el foco, cierra con Escape y devuelve el foco al botón.
- [ ] `Select` y `Tooltip` se renderizan por encima del contenido y con los colores correctos.
- [ ] La tabla no desborda en 320 px y tiene scroll horizontal si hace falta.
- [ ] Los textos no se mezclan entre inglés y español.
- [ ] `BUY`/`SELL` conservan sus colores y su signo/semántica.
- [ ] No hay `text-green-400`, `bg-red-500` ni hex crudos en componentes.
- [ ] `pnpm build`, `pnpm lint` y `pnpm test` pasan (una vez corregidos los errores previos).

### 12.3. Pruebas manuales

1. Abrir Ajustes y cambiar el tema tres veces (oscuro, claro, automático).
2. Abrir y cerrar el diálogo de “Restore data” con ratón y teclado.
3. Escribir un valor inválido en un `Input` y comprobar `aria-invalid`.
4. Navegar con Tab por todos los controles de la página.
5. Probar 320, 390, 720 y 1280 px.
6. Ejecutar un backtest y revisar que la tabla y los badges mantienen el formato.
7. Cambiar el idioma (cuando se implemente i18n) y comprobar que los labels de shadcn cambian.

### 12.4. Bundle

Cada componente de Radix añade peso. Revisa la salida de `vite build` antes y después. Si el bundle crece demasiado:

- Añade solo los componentes que uses.
- Evita blocks completos.
- No importes `lucide-react` entero; importa iconos concretos.
- No sustituyas los gráficos SVG por Recharts sin medir.

---

## 13. Problemas típicos y soluciones

| Síntoma | Causa | Solución |
|---|---|---|
| `Invalid package.json in package.json` | El archivo tiene BOM (frecuente con PowerShell 5.1) | Guarda `package.json` como UTF-8 sin BOM. |
| `TS5102: Option 'baseUrl' has been removed` | TypeScript 7 eliminó `baseUrl` | Usa solo `paths`; no añadas `baseUrl`. |
| `Cannot find module '@/components/ui/button'` | Falta alias en Vite o en TypeScript | Revisa `resolve.alias` y `paths` en ambos tsconfig. |
| Los colores de FLARE cambiaron tras `init` | El CLI añadió `--primary`, `--border` y `--accent` de shadcn | Restaura `index.css` y aplica el puente de la sección 6. |
| Las clases de shadcn no se aplican | El CSS de FLARE es unlayered y gana | Borra o estrecha el selector antiguo; no añadas `!important` sin analizar. |
| `bg-accent` se ve verde brillante | `--accent` de FLARE es texto, no superficie | Mapea `--color-accent` a `--surface-hover`, como en el puente. |
| `dark:` no hace nada | shadcn espera `.dark`, FLARE usa `data-theme` | Usa `@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));`. |
| `asChild` no funciona | Elegiste `--base base` (Base UI) | Usa `render` o reinstala con `--base radix`. |
| `next-themes` no encontrado | `sonner` lo importa | Instálalo o adapta `sonner.tsx` a `data-theme`. |
| `@import "shadcn/tailwind.css"` no encontrado | Falta el paquete `shadcn` | `pnpm add shadcn` o ejecuta `shadcn eject`. |
| `cn` no encontrado | Falta `cn` o `src/lib/utils.ts` | `pnpm add cn` y comprueba `export { cn } from "cn"`. |
| Avisos de peer dependencies con React 19 | Mezcla de paquetes Radix antiguos | Usa `radix-ui` unificado y la versión más reciente. |
| `pnpm build` falla en Stats/App/backtest | Errores preexistentes | Corrige primero los puntos de la sección 2.3. |
| El diálogo aparece sin estilos | Los tokens no están en `:root` o el portal queda fuera del tema | Mantén los tokens en `:root`, no en un contenedor local. |
| El input de shadcn no cambia de altura | `.field__control input` de FLARE gana | Borra o reduce esa regla. |
| Los iconos no aparecen | Falta `lucide-react` | `pnpm add lucide-react` o vuelve a añadir el componente. |
| `pnpm` bloquea scripts de build | Política de build scripts de pnpm | `pnpm approve-builds` y permite `@tailwindcss/oxide`, `esbuild`, etc. |

### 13.1. Arreglar el BOM de `package.json`

Si el CLI dice `Invalid package.json`:

```powershell
$p = "package.json"
$text = [System.IO.File]::ReadAllText($p)
[System.IO.File]::WriteAllText(
  $p,
  $text,
  (New-Object System.Text.UTF8Encoding($false))
)
```

Esto elimina el BOM sin cambiar el contenido. Ocurre sobre todo con `Set-Content -Encoding utf8` en Windows PowerShell 5.1.

---

## 14. Rollback

Si algo sale mal y quieres volver al estado anterior:

```powershell
# 1. Restaurar archivos de configuración
Copy-Item src/index.css.pre-shadcn.bak src/index.css
Copy-Item vite.config.ts.pre-shadcn.bak vite.config.ts
Copy-Item tsconfig.json.pre-shadcn.bak tsconfig.json
Copy-Item tsconfig.app.json.pre-shadcn.bak tsconfig.app.json
Copy-Item package.json.pre-shadcn.bak package.json

# 2. Borrar archivos generados
Remove-Item components.json
Remove-Item -Recurse -Force src/components/ui
Remove-Item src/lib/utils.ts

# 3. Reinstalar dependencias sin shadcn
pnpm install
```

Si usaste git:

```powershell
git status --short
git restore -- src/index.css vite.config.ts tsconfig.json tsconfig.app.json package.json pnpm-lock.yaml
```

**Cuidado:** `git restore` descarta también los cambios del usuario en esos archivos. Úsalo solo si estás seguro.

Dependencias que añade shadcn y puedes quitar si haces rollback:

```powershell
pnpm remove shadcn cn radix-ui class-variance-authority lucide-react tw-animate-css @fontsource-variable/geist
pnpm remove -D tailwindcss @tailwindcss/vite
```

Comprueba antes con `pnpm why <paquete>` que no las usa otra parte del proyecto.

---

## 15. Checklist final

- [ ] Copia de seguridad de `src/index.css` y de los tsconfig.
- [ ] Tailwind instalado y app visualmente igual antes de añadir shadcn.
- [ ] `paths` configurado sin `baseUrl`.
- [ ] Alias `@` funcionando en Vite y TypeScript.
- [ ] `shadcn init` ejecutado con `--base radix`.
- [ ] `src/index.css` restaurado y puente de tokens aplicado.
- [ ] Tema oscuro y claro correctos.
- [ ] `Button`, `Card` y `Input` renderizan con tokens de FLARE.
- [ ] `AlertDialog` funciona con teclado.
- [ ] `Table` y `Badge` conservan formatos y colores.
- [ ] No hay colores crudos de Tailwind en componentes.
- [ ] `pnpm build`, `pnpm lint` y `pnpm test` pasan.
- [ ] El rollback está documentado y probado.

---

## Apéndice A — Comandos rápidos

```powershell
# 1. Tailwind
pnpm add -D tailwindcss @tailwindcss/vite

# 2. shadcn
pnpm dlx shadcn@latest init --base radix --preset nova --yes --css-variables

# 3. Componentes base
pnpm dlx shadcn@latest add button card input label alert-dialog tabs badge table switch tooltip select separator dialog toggle-group

# 4. Opcional
pnpm dlx shadcn@latest add sonner

# 5. Verificar
pnpm build
pnpm lint
pnpm test
```

## Apéndice B — Enlaces oficiales

- Instalación en Vite: <https://ui.shadcn.com/docs/installation/vite>
- Temas y tokens: <https://ui.shadcn.com/docs/theming>
- `components.json`: <https://ui.shadcn.com/docs/components-json>
- CLI: <https://ui.shadcn.com/docs/cli>
- Button: <https://ui.shadcn.com/docs/components/radix/button>
- Card: <https://ui.shadcn.com/docs/components/radix/card>
- Dialog: <https://ui.shadcn.com/docs/components/radix/dialog>
- Alert Dialog: <https://ui.shadcn.com/docs/components/radix/alert-dialog>
- Table: <https://ui.shadcn.com/docs/components/radix/table>
- Tabs: <https://ui.shadcn.com/docs/components/radix/tabs>
- Select: <https://ui.shadcn.com/docs/components/radix/select>
- Toggle Group: <https://ui.shadcn.com/docs/components/radix/toggle-group>
- Sonner: <https://ui.shadcn.com/docs/components/radix/sonner>

## Apéndice C — Notas de versión

Este manual se verificó con:

| Herramienta | Versión |
|---|---|
| shadcn CLI | 4.23.0 |
| Tailwind CSS | 4.3.5 |
| `@tailwindcss/vite` | 4.3.5 |
| Vite | 8.3.7 |
| React | 19.3.1 |
| TypeScript | 7.0.2 |

Si `shadcn@latest` cambia de versión:

```powershell
pnpm dlx shadcn@latest --version
pnpm dlx shadcn@latest docs button
```

Los nombres de componentes y las props principales suelen mantenerse, pero revisa la documentación antes de copiar ejemplos antiguos.

---

> **Recordatorio:** este documento es solo un plan. No se ha modificado ningún archivo de `src/`. La implementación debe hacerse en una tanda separada, empezando por Tailwind, el alias, el puente de tokens y un solo componente de prueba.
