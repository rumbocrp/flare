# FLARE — Guía de dirección visual inspirada en ApexJournal

> **Estado:** documento de análisis, dirección visual y planificación.  
> **No modifica código.** No se ha tocado ningún archivo de `src/`.  
> **Fuente de inspiración:** `https://github.com/rumbocrp/apexjournal`  
> **Commit analizado:** `f8b7191` (2026-09-11).  
> **Objetivo:** extraer los principios visuales de ApexJournal y traducirlos a FLARE sin perder la identidad Matrix.

---

## 0. Resumen ejecutivo

ApexJournal y FLARE son dos productos financieros con estrategias visuales opuestas:

| | ApexJournal | FLARE actual |
|---|---|---|
| Base | Grafito casi negro | Negro puro |
| Acento | Naranja de señal, usado poco | Verde neón, usado en casi todo |
| Texto | Blanco roto y grises | Verde neón |
| Tipografía | Cabin 12–14 px + Jost mono | VT323 19 px |
| Densidad | Alta | Baja |
| Botones | 26–32 px, borde fino | 40 px, relleno grande |
| Radios | 4–8 px | 8–12 px |
| Profundidad | Escalones de superficie | Brillos y bordes verdes |
| Sensación | Herramienta de escritorio | Terminal arcade |

La propuesta no es convertir FLARE en ApexJournal. Es adoptar su **disciplina**:

> **Superficies neutras, tipografía pequeña, bordes finos, densidad alta y un solo acento reservado para lo importante.**

FLARE conserva su ADN Matrix —negro, verde, VT323, datos financieros— pero deja de usar el verde como fondo de todo. El resultado se puede llamar **“Matrix sobrio”**: la misma identidad, con mejor jerarquía y menos fatiga visual.

### 0.1. Resultado esperado

- La interfaz se siente más profesional y menos “arcade”.
- El verde sigue siendo la firma, pero aparece en acciones, estados y datos clave.
- Los botones dejan de dominar la pantalla.
- Las tablas y los formularios ganan legibilidad.
- La versión móvil se vuelve compacta.
- El tema claro sigue siendo coherente.

---

## 1. Fuente y alcance del análisis

### 1.1. Qué se analizó

Se clonó el repositorio en una carpeta temporal y se revisaron, entre otros:

| Archivo de ApexJournal | Qué aporta |
|---|---|
| `tailwind.config.js` | Paleta, tipografías, sombras y tokens. |
| `src/index.css` | Variables CSS, tarjetas, foco, scrollbars y transiciones. |
| `src/components/layout/Sidebar.tsx` | Navegación lateral, tamaños y estado activo. |
| `src/components/layout/Titlebar.tsx` | Barra superior compacta y acciones. |
| `src/views/DashboardView.tsx` | Densidad, KPI cards, selector temporal. |
| `src/views/BlotterView.tsx` | Tabla financiera de alta densidad, filtros y formularios. |
| `src/components/common/Dropdown.tsx` | Trigger compacto, menú y estados. |
| `src/views/JournalView.tsx` | Chips, etiquetas y feed denso. |
| `PROJECT.md` | Contexto, aunque su prosa está desactualizada. |

### 1.2. Una advertencia sobre la documentación de ApexJournal

`PROJECT.md` describe un acento violeta eléctrico `#8B5CF6`. El código actual, sin embargo, usa:

- `signal: #ED775C` (naranja),
- `financial.positive: #10b981` (verde),
- `financial.negative: #ef4444` (rojo),
- `financial.warning: #f59e0b` (ámbar).

Esta guía se basa en **el código real**, no en la prosa del `PROJECT.md`. Es una buena práctica: cuando documentes FLARE, haz que la guía y los tokens digan lo mismo.

### 1.3. Qué NO se debe copiar

ApexJournal es una app de escritorio Tauri, con `body { overflow: hidden }`, altura fija de viewport y una densidad pensada para pantallas grandes. FLARE es una web responsive. Copiar literalmente esas decisiones rompería el scroll y el móvil.

Tampoco conviene copiar:

- su paleta naranja/violeta;
- sus fuentes Cabin/Jost sin evaluar el costo de carga;
- textos de 10 px en cuerpos de texto;
- zonas táctiles de 24 px;
- la estética de “todo gris” que diluye la identidad Matrix.

---

## 2. Lectura visual de ApexJournal

### 2.1. Paleta

ApexJournal construye profundidad con escalones de grafito, no con sombras:

| Rol | Token / valor | Uso |
|---|---|---|
| Fondo | `#09090b` | Lienzo de la app |
| Superficie 1 | `#111113` | Tarjetas, paneles |
| Superficie 2 | `#161619` | Filas activas, inputs |
| Superficie 3 | `#1c1c20` | Elevación secundaria |
| Hover | `#1e1e24` | Interacción |
| Borde | `#242429` | Separadores y contornos |
| Borde sutil | `#1a1a1e` | Divisiones internas |
| Texto principal | `#ededef` | Títulos y datos |
| Texto secundario | `#9e9ea7` | Etiquetas y ayudas |
| Texto atenuado | `#63636c` | Metadatos |
| Acento | `#ED775C` | Acción principal / señal |
| Positivo | `#10b981` / `#34d399` | Dinero a favor |
| Negativo | `#ef4444` / `#f87171` | Dinero en contra |
| Advertencia | `#f59e0b` / `#fbbf24` | Riesgo / atención |

La lección: **el color semántico no es decoración**. El verde y el rojo aparecen cuando significan ganancia o pérdida; el acento aparece cuando hay una acción principal.

### 2.2. Tipografía

ApexJournal usa dos familias:

- **Cabin** para la interfaz: 12–14 px, pesos 400–700.
- **Jost** para números, fechas y datos tabulares: 10–20 px, con `font-variant-numeric: tabular-nums`.

Patrones concretos:

| Elemento | Tamaño | Tratamiento |
|---|---:|---|
| Título de página | 14 px | Mayúsculas, `tracking-[0.2em]`, mono |
| Subtítulo | 12 px | Gris atenuado |
| Etiqueta de campo | 10 px | Mayúsculas, mono, `tracking` |
| Botón | 12 px | Medium/semibold |
| Tabla | 12 px | Filas densas |
| Cabecera de tabla | 10 px | Mayúsculas, mono, `tracking-wider` |
| Métrica grande | 20–24 px | Mono, bold, tabular |
| Badge | 9–10 px | Mayúsculas, mono |

La jerarquía no se construye con tamaños enormes, sino con **peso, mayúsculas, tracking y color**.

### 2.3. Densidad y espaciado

| Zona | Valor |
|---|---|
| Padding de página | 24 px (`p-6`) |
| Separación entre secciones | 24 px (`space-y-6`) |
| Gap entre tarjetas | 12 px (`gap-3`) |
| Padding de tarjeta | 16 px (`p-4`) |
| Gap interno de tarjeta | 8 px (`space-y-2`) |
| Padding de sidebar | 12 px (`p-3`) |
| Fila de navegación | 32 px (`py-2` + texto 12 px) |
| Botón estándar | 26–30 px (`py-1.5` + texto 12 px) |
| Celda de tabla | 8 px vertical / 12 px horizontal |
| Input | 30–32 px |

La densidad es alta, pero hay aire entre bloques. No es “todo pegado”: es **compacto dentro del componente, separado entre secciones**.

### 2.4. Bordes, radios y sombras

- Bordes de **1 px**; casi nunca más.
- Radios de **4 px** para controles, **6 px** para inputs, **8 px** para tarjetas.
- Sombras muy discretas:
  - `subtle`: `0 1px 2px rgba(0,0,0,.4)`
  - `card`: `0 1px 3px rgba(0,0,0,.5)`
  - `modal`: sombra profunda solo para modales.
- Sin `box-shadow` de neón en botones o tarjetas.

### 2.5. Jerarquía de botones

ApexJournal no tiene un solo estilo de botón. Tiene una escala:

| Variante | Ejemplo | Altura aproximada | Uso |
|---|---|---:|---|
| Primario | `bg-obsidian-100 text-obsidian-950` | 30 px | Crear registro, guardar |
| Secundario | `bg-surface-secondary border border-surface-border` | 28–30 px | Exportar, acciones de toolbar |
| Ghost | `text-obsidian-400 hover:bg-surface-secondary` | 26–28 px | Acciones terciarias |
| Icono | `p-1 rounded border` | 24–28 px | Cerrar, colapsar |
| Peligro | `text-financial-negativeText hover:bg-financial-negativeMuted` | 28–30 px | Bloquear, borrar |

El botón primario es claro (casi blanco), no un bloque de color saturado. El acento naranja se usa en badges o acciones muy puntuales.

### 2.6. Navegación

La sidebar de ApexJournal:

- mide 224 px (`w-56`);
- se colapsa a 56 px (`w-14`);
- tiene filas de ~32 px;
- usa iconos de 16 px;
- etiquetas de 11 px;
- texto atenuado;
- estado activo:
  - `bg-surface-secondary`
  - `text-obsidian-100`
  - `font-semibold`
  - `border-l-2 border-obsidian-100`
  - `pl-2`

No hay relleno verde en cada opción. El estado activo se comunica con **superficie + borde izquierdo + peso**.

### 2.7. Tablas

La tabla de movimientos es el componente más denso:

- cabecera `text-[10px] uppercase tracking-wider`;
- celdas `text-xs` (12 px);
- padding `py-2 px-3` (8/12);
- cabecera sticky;
- números con `tabular-nums`;
- estados con badges de 10 px;
- filas con hover sutil;
- contenedor con borde y radio de 8 px.

La tabla se lee como una herramienta financiera, no como una landing page.

### 2.8. Formularios

- Etiquetas de 10 px, mayúsculas, mono.
- Inputs de 12 px, 30–32 px de alto.
- Padding `px-3 py-1.5` (12/6).
- Radio de 4 px.
- Fondo `surface-secondary`.
- Borde `surface-border`.
- Foco: borde más claro, sin `outline` brillante.
- Texto de ayuda de 10–11 px.

### 2.9. Movimiento y foco

- Transición de **120 ms** con `cubic-bezier(0.16, 1, 0.3, 1)`.
- Solo se animan `background-color`, `border-color` y `opacity`.
- Foco global: `outline: 2px solid #52525b; outline-offset: 1px`.
- Scrollbars de 5 px, discretas.

Nada de animaciones de layout ni resplandores.

---

## 3. Qué copiar, qué adaptar y qué evitar

| Categoría | Copiar | Adaptar | Evitar |
|---|---|---|---|
| Paleta | Escalones de superficie y bordes finos | Grafito + verde Matrix | Naranja/violeta de Apex |
| Tipografía | Escala pequeña y jerarquía por peso | VT323 solo para display; UI legible | VT323 de 19 px en todo |
| Densidad | Filas de 32 px, cards de 16 px | Más aire en móvil | Desktop fijo sin scroll |
| Botones | Variantes y tamaños | Primario verde, no blanco | Botones de 44 px en toolbars |
| Navegación | Activo con borde izquierdo | Compactar la barra móvil | Relleno de color en cada fila |
| Tablas | Cabecera 10 px, celdas 12 px | Mantener tabular nums | Texto de 10 px en móvil |
| Formularios | Labels 10 px y inputs 32 px | Mantener foco visible | Inputs de 19 px |
| Color | Semántica estricta | Verde = activo/positivo | Verde decorativo en todo |
| Sombras | Sutiles | Casi ninguna | Glow neón |
| Movimiento | 120 ms | Respetar reduced motion | Animaciones largas |

---

## 4. Propuesta FLARE: “Matrix sobrio”

### 4.1. Principios

1. **El verde es una señal, no un fondo.** Se usa en acción primaria, estado activo, foco y datos positivos.
2. **El texto principal es neutro.** El verde sobre negro en todo el cuerpo cansa y reduce la jerarquía.
3. **La densidad es una feature.** Menos padding y tipos más pequeños permiten ver más datos.
4. **Los bordes hacen el trabajo.** 1 px y escalones de superficie en lugar de sombras.
5. **Una acción primaria por vista.** El resto son secundarias o ghost.
6. **La tipografía display se reserva para la marca y los títulos.** El cuerpo necesita legibilidad.
7. **El movimiento es corto y silencioso.** 120 ms, solo color/borde/fondo.

### 4.2. Tres niveles de cambio

No hace falta adoptar todo de golpe. Hay tres niveles:

| Nivel | Alcance | Riesgo | Resultado |
|---|---|---|---|
| **A. Conservador** | Tamaños, padding, radios, densidad | Bajo | Sigue siendo Matrix, pero más ordenado |
| **B. Recomendado** | Tokens neutros + verde como acento | Medio | “Matrix sobrio” |
| **C. Profundo** | Tipografía UI nueva + rediseño de componentes | Alto | Producto visualmente distinto |

La guía recomienda avanzar A → B → C, midiendo el resultado en cada fase.

### 4.3. Tokens propuestos (nivel B)

Estos valores son un objetivo, no un reemplazo inmediato. Están pensados para el tema oscuro:

```css
:root {
  /* Superficies: grafito, no negro puro */
  --bg: #050506;
  --bg-subtle: #0a0a0c;
  --surface: #101012;
  --surface-hover: #16161a;
  --surface-raised: #1b1b20;

  /* Bordes: neutros, con un leve sesgo verde si quieres conservar Matrix */
  --border: #26262c;
  --border-strong: #3a3a43;
  --chart-baseline: #2a2a30;
  --dot-off: #33333a;

  /* Texto: blanco roto + grises */
  --text: #e8e8ea;
  --text-muted: #a1a1aa;
  --text-subtle: #71717a;

  /* Acento Matrix: ahora sí, protagonista */
  --accent: #00ff41;
  --primary: #00ff41;
  --primary-hover: #00cc33;
  --on-primary: #050506;

  /* Semántica financiera */
  --positive: #22c55e;
  --negative: #ef4444;
  --warning: #f59e0b;

  /* Señales de chart */
  --signal-buy: #e8e8ea;
  --signal-sell: #f87171;
}
```

**Variante “más Matrix”:** si el grafito neutro te parece demasiado ApexJournal, usa superficies con un tinte verde muy leve:

```css
--bg: #030503;
--bg-subtle: #071008;
--surface: #0b140c;
--surface-hover: #101c12;
--surface-raised: #152417;
--border: #1f3322;
--border-strong: #2f4a34;
--text: #d8f5dd;
--text-muted: #8fbf98;
--text-subtle: #628a6a;
```

No combines esta variante con texto verde neón en todas partes: perderías el contraste.

**Tema claro propuesto:**

```css
:root[data-theme='light'] {
  --bg: #f7faf8;
  --bg-subtle: #eef5f0;
  --surface: #ffffff;
  --surface-hover: #e8f1ea;
  --surface-raised: #dcefe0;
  --border: #c9ddcf;
  --border-strong: #9fc7aa;
  --text: #142018;
  --text-muted: #4f6357;
  --text-subtle: #6b7f72;
  --accent: #008a2a;
  --primary: #008a2a;
  --primary-hover: #006b20;
  --on-primary: #ffffff;
  --positive: #067a3a;
  --negative: #c81e1e;
  --warning: #a16207;
}
```

### 4.4. Tipografía propuesta

**Nivel A:** mantener VT323 y reducir tamaños.

**Nivel B:** VT323 solo para marca, títulos de página y cifras grandes; una fuente de UI legible para el resto.

```css
:root {
  --font-display: 'VT323', ui-monospace, monospace;
  --font-ui: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono: ui-monospace, 'Cascadia Code', 'SFMono-Regular', Menlo, monospace;
}
```

**Nivel C:** self-host de Cabin + Jost, como ApexJournal, para una UI más editorial. Solo si aceptas el costo de fuentes y el cambio de identidad.

Escala recomendada:

| Rol | Tamaño | Peso | Fuente |
|---|---:|---:|---|
| Marca | 18–20 px | 600 | Display |
| Título de página | 20–22 px | 600 | Display |
| Título de sección | 14 px | 600 | UI |
| Cuerpo | 13–14 px | 400 | UI |
| Etiqueta | 10–11 px | 600 | UI/mono |
| Botón | 11–12 px | 500–600 | UI |
| Tabla | 12 px | 400 | UI/mono |
| Cabecera de tabla | 10 px | 600 | Mono |
| Métrica grande | 20–24 px | 700 | Mono |
| Ayuda | 11 px | 400 | UI |

Regla práctica: **si un texto se lee en una tabla o en un formulario, no uses VT323 a 19 px**.

### 4.5. Espaciado y radios

Escala de espaciado: `2, 4, 6, 8, 12, 16, 20, 24, 32`.

| Elemento | Actual | Propuesto |
|---|---:|---:|
| Padding de página | 32/20 px | 24/16 px |
| Gap entre secciones | 28 px | 20–24 px |
| Padding de tarjeta | 20 px | 16 px |
| Gap entre tarjetas | 16 px | 12 px |
| Padding de botón | 10/20 px | 6/10 px |
| Padding de input | 10/12 px | 6/8 px |
| Radio de botón | 8 px | 4 px |
| Radio de tarjeta | 12 px | 8 px |
| Radio de modal | 12 px | 10–12 px |

### 4.6. Botones

```css
.btn {
  min-height: 30px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
  color: var(--text-muted);
  font: 500 0.75rem/1 var(--font-ui);
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}

.btn:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text);
  border-color: var(--border-strong);
}

.btn--primary {
  background: var(--primary);
  color: var(--on-primary);
  border-color: var(--primary);
}

.btn--ghost {
  background: transparent;
  border-color: transparent;
}

.btn--danger {
  background: transparent;
  color: var(--negative);
  border-color: var(--negative);
}
```

Tamaños:

| Tamaño | Altura | Padding | Fuente | Uso |
|---|---:|---|---:|---|
| `xs` | 24–26 px | 4/6 px | 10–11 px | Chips, toolbar |
| `sm` | 28–30 px | 6/8 px | 11–12 px | Acciones secundarias |
| `md` | 34–36 px | 8/12 px | 12–13 px | Acción principal |
| `lg` | 40–44 px | 10/16 px | 13–14 px | Solo CTA móvil |

No uses `lg` para navegación. La barra móvil debe usar `xs` o `sm`.

### 4.7. Selectores segmentados

El patrón de ApexJournal para el selector temporal es pequeño:

- contenedor con `padding: 2px`;
- opción con `padding: 4px 8px`;
- texto de 11–12 px;
- activo con fondo claro y texto oscuro, o superficie elevada.

Para FLARE:

```css
.segmented {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
}

.segmented__option {
  min-height: 26px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  font-size: 0.72rem;
}

.segmented__option--active {
  background: var(--surface-raised);
  color: var(--text);
  border-color: var(--border-strong);
}
```

Esto es directamente aplicable a la barra de opciones de Backtest, pero **no cambies `.segmented` global** sin revisar `MarketSection`, `Settings` y `Stats`. Crea una clase modificadora o un contenedor propio.

### 4.8. Navegación

**Escritorio:**

- ancho de 224 px, no 240;
- padding de 12–16 px;
- marca de 12–14 px, mayúsculas, tracking;
- filas de 32–34 px;
- iconos de 16 px;
- texto de 11–12 px;
- activo con superficie + borde izquierdo de 2 px + semibold;
- hover con superficie, no con verde.

**Móvil:**

- barra compacta de 34 px por fila;
- sin scroll horizontal;
- marca arriba, menú debajo;
- alternancia sutil de superficies;
- activo con barra de 2 px.

La implementación detallada está en `GUIA_BARRA_SUPERIOR_MOVIL.md`.

### 4.9. Tarjetas y métricas

```css
.card {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}

.card__label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-subtle);
}

.card__value {
  font: 700 1.25rem/1.1 var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.card__hint {
  font-size: 11px;
  color: var(--text-subtle);
}
```

Cambios clave:

- bajar el padding de 20 a 16 px;
- bajar el radio de 12 a 8 px;
- etiqueta pequeña en mayúsculas;
- valor con mono y tabular nums;
- hint de 11 px.

### 4.10. Tablas

```css
.trades {
  font-size: 12px;
}

.trades th,
.trades td {
  padding: 8px 12px;
}

.trades thead th {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-subtle);
  background: var(--bg-subtle);
}
```

Mantén:

- `tabular-nums` en columnas numéricas;
- hover de fila;
- scroll horizontal solo dentro de `.table-wrap`;
- badges de estado pequeños.

No conviertas la tabla en tarjetas en móvil sin una razón fuerte: una tabla financiera con scroll horizontal controlado suele ser mejor que 20 tarjetas apiladas.

### 4.11. Formularios

```css
.field__label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-subtle);
}

.field__control input,
.field__control select {
  min-height: 32px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
  color: var(--text);
  font-size: 12px;
}

.field__control input:focus,
.field__control select:focus {
  outline: none;
  border-color: var(--accent);
}
```

El foco por borde es más sobrio que el `outline` grueso actual. Si quieres accesibilidad extra, combina borde y `box-shadow: 0 0 0 1px var(--accent)`.

### 4.12. Gráficos

- Líneas de 1.5 px, no 2 px.
- Grid punteado muy tenue.
- Etiquetas de 10 px en mono.
- Tooltip compacto.
- Verde/rojo solo para dirección o P&L.
- Sin glow en la línea principal.
- Mantener el área degradada, pero bajar la opacidad.

### 4.13. Badges y estados

- Altura 18–20 px.
- Texto 9–10 px, mayúsculas, mono.
- Fondo semántico tenue + borde del mismo tono.
- No usar badges gigantes de 14 px.

Ejemplo:

```css
.badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font: 600 10px/1 var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
```

---

## 5. Antes y después conceptual

| Elemento | FLARE actual | FLARE propuesto |
|---|---|---|
| Fondo | `#000000` | `#050506` grafito |
| Texto | `#00ff41` en todo | `#e8e8ea` + verde de acento |
| Tamaño base | 19.2 px VT323 | 14 px UI + VT323 display |
| Título de página | 24 px | 20–22 px |
| Etiqueta | 14–15 px | 10–11 px mayúsculas |
| Botón estándar | 40 px, padding 10/20 | 30 px, padding 6/10 |
| Botón primario | verde lleno grande | verde lleno compacto |
| Navegación móvil | 43 px, filas verdes | 34 px, superficie sutil |
| Tarjeta | 20 px padding, radio 12 | 16 px padding, radio 8 |
| Tabla | 12/16 px padding | 8/12 px padding |
| Input | 10/12 px padding | 6/8 px padding |
| Segmentado | 8/16 px padding | 4/8 px padding |
| Sombras | glow verde | borde 1 px |
| Transición | variable | 120 ms color/borde |

---

## 6. Roadmap de aplicación

No aplicar todo en un solo commit. Cada fase debe poder revertirse.

| Fase | Alcance | Archivos probables | Riesgo | Criterio de aceptación |
|---|---|---|---|---|
| **0. Baseline** | Capturas de todas las páginas en 390, 768 y 1280 px | — | Bajo | Tener “antes” para comparar |
| **1. Tokens** | Colores, tipografía, radios, sombras | `src/index.css` | Medio | La app sigue funcionando; temas coherentes |
| **2. Botones y segmentados** | Tamaños, variantes, hover/focus | `src/App.css` | Bajo | Ningún botón gigante |
| **3. Navegación** | Sidebar desktop y barra móvil | `Sidebar.css` | Bajo | Barra compacta sin scroll |
| **4. Tarjetas y métricas** | Padding, tipografía, jerarquía | `App.css`, `MetricCard.tsx` | Bajo | KPIs más densos |
| **5. Tablas y formularios** | Densidad y legibilidad | `TradesTable.css`, `App.css`, páginas | Medio | Tablas legibles en móvil |
| **6. Gráficos** | Líneas, labels, tooltips | `CandleChart.css`, `EquityChart.css` | Medio | Charts sobrios y legibles |
| **7. Backtest** | Aplicar el sistema a la página nueva | `Backtest.tsx`, `Backtest.css` | Medio | Coherencia con el resto |
| **8. QA visual** | Contrastes, foco, responsive, temas | — | Bajo | Checklist completo |

Orden recomendado: **tokens → botones → navegación → tarjetas → tablas → formularios → gráficos → Backtest**.

No empieces por Backtest: si cambias tokens después, tendrás que rehacer la página.

---

## 7. Validación y checklist

### 7.1. Checklist visual

- [ ] El verde ya no es el color del texto de párrafos.
- [ ] Hay una sola acción primaria visible por vista.
- [ ] Los botones miden 30–36 px, no 40–48 px.
- [ ] Las etiquetas de formulario son pequeñas y en mayúsculas.
- [ ] Las tarjetas tienen radio de 8 px, no 12 px.
- [ ] Las tablas usan 8/12 px de padding.
- [ ] La navegación móvil mide 34 px por fila.
- [ ] No hay glow en botones ni tarjetas.
- [ ] El foco de teclado se ve en todos los controles.
- [ ] El tema claro no parece otro producto.

### 7.2. Checklist técnico

- [ ] `pnpm build` pasa.
- [ ] `pnpm lint` pasa.
- [ ] No hay cambios de lógica.
- [ ] No se rompieron los tests.
- [ ] Los charts siguen renderizando.
- [ ] Las tablas siguen haciendo scroll solo dentro de su contenedor.
- [ ] El sidebar no genera scroll horizontal en 320 px.
- [ ] `prefers-reduced-motion` está respetado si hay animaciones.

### 7.3. Prueba de contraste

Revisa al menos:

- `--text` sobre `--surface`;
- `--text-muted` sobre `--surface`;
- `--on-primary` sobre `--primary`;
- `--negative` sobre `--surface`;
- `--positive` sobre `--surface`.

En tema claro, el verde oscuro sobre blanco suele funcionar; el verde neón sobre blanco no.

---

## 8. Riesgos y decisiones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Perder la identidad Matrix | Alto | Mantener VT323 en display y verde en acentos |
| VT323 a 12 px es ilegible | Medio | Usar UI sans para cuerpo; VT323 solo display |
| El tema claro queda inconsistente | Medio | Revisar tokens y contraste antes de cambiar componentes |
| Cambiar demasiados componentes a la vez | Alto | Roadmap por fases y capturas |
| Copiar la densidad de escritorio en móvil | Alto | No bajar de 12 px en móvil; 34 px de fila mínima |
| Los gráficos pierden personalidad | Bajo | Mantener paleta y formas; solo bajar glow/grosor |
| ApexJournal es otra app | Medio | Copiar principios, no valores literales |

### 8.1. Decisiones que conviene tomar antes de empezar

1. ¿FLARE conserva texto verde o pasa a texto neutro con acento verde?
2. ¿VT323 se queda solo en display o también en cifras?
3. ¿Se acepta una fuente UI nueva o se usa `system-ui`?
4. ¿El tema claro se mantiene o se simplifica?
5. ¿Se rediseña Backtest a medida o se espera al sistema global?

La recomendación es: **texto neutro + verde de acento + VT323 en display + system-ui en UI**. Es el mejor equilibrio entre identidad y legibilidad.

---

## 9. Relación con Backtest

Backtest es la página que estás escribiendo. No conviene convertirla en un laboratorio de estilos antes de que el sistema global esté definido.

Orden sugerido:

1. Termina la lógica y la estructura de `Backtest.tsx`.
2. Usa los componentes existentes (`PageHeader`, `NumberField`, `MetricCard`, `TradesTable`, `EquityChart`).
3. Aplica solo la barra compacta de `GUIA_BARRA_SUPERIOR_MOVIL.md`.
4. Cuando el resto de la app adopte los tokens, ajusta Backtest en una sola pasada.
5. No dupliques estilos: si un patrón se repite, conviértelo en clase compartida.

Para la barra de opciones de Backtest:

- no cambies `.segmented` global;
- usa un contenedor `.backtest__options`;
- aplica tamaños compactos solo dentro de esa página;
- en móvil, apila los grupos y evita el scroll horizontal.

---

## Apéndice A. Mapa de evidencia

Referencias concretas del repo de ApexJournal (commit `f8b7191`):

| Tema | Archivo | Qué mirar |
|---|---|---|
| Paleta | `tailwind.config.js` | `obsidian`, `surface`, `financial`, `signal` |
| Tipografía | `tailwind.config.js` | `fontFamily.sans/mono/serif` |
| Tokens CSS | `src/index.css` | `:root`, `craft-card`, `metric-badge`, `transition-fast` |
| Foco | `src/index.css` | `:focus-visible` |
| Scrollbar | `src/index.css` | `::-webkit-scrollbar` |
| Sidebar | `src/components/layout/Sidebar.tsx` | `w-56`, `py-2`, `text-xs`, activo con borde izquierdo |
| Titlebar | `src/components/layout/Titlebar.tsx` | `h-10`, botones `px-2.5 py-1` |
| Dashboard | `src/views/DashboardView.tsx` | `p-6`, `gap-3`, KPI cards, selector temporal |
| Tabla | `src/views/BlotterView.tsx` | cabecera 10 px, celdas 8/12 px |
| Dropdown | `src/components/common/Dropdown.tsx` | trigger 12 px, radio 4 px |
| Chips | `src/views/JournalView.tsx` | filtros `px-2 py-0.5`, badges |

## Apéndice B. Archivos de FLARE que se tocarían más adelante

| Archivo | Rol |
|---|---|
| `src/index.css` | Tokens de tema, tipografía base |
| `src/App.css` | Botones, tarjetas, formularios, segmentados, layout |
| `src/components/Sidebar.css` | Navegación desktop y móvil |
| `src/components/TradesTable.css` | Tabla financiera |
| `src/components/CandleChart.css` | Chart de velas |
| `src/components/EquityChart.css` | Curva de capital |
| `src/pages/Settings.css` | Tarjetas de ajustes |
| `src/pages/BotRun.css` | Panel de ejecución |
| `src/pages/Backtest.css` | Estilos propios de Backtest (cuando exista) |

## Apéndice C. Glosario

| Término | Significado |
|---|---|
| **Token** | Variable CSS que representa una decisión de diseño. |
| **Superficie** | Color de fondo de un contenedor; crea profundidad sin sombras. |
| **Acento** | Color reservado para acción/estado importante. |
| **Densidad** | Cantidad de información visible por área. |
| **Jerarquía** | Orden visual de importancia. |
| **Ghost button** | Botón sin fondo ni borde hasta el hover. |
| **Tabular nums** | Números de ancho fijo para alinear columnas. |
| **Focus ring** | Indicador visible de foco de teclado. |
| **Reduced motion** | Preferencia del usuario por menos animación. |

---

> **Nota final:** esta guía no aplica cambios. Es un mapa para que decidas qué adoptar y en qué orden. La primera pieza concreta es la barra móvil compacta de `GUIA_BARRA_SUPERIOR_MOVIL.md`.
