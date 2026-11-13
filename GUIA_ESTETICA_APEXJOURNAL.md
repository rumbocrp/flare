# FLARE — Guía de dirección visual inspirada en ApexJournal

> **Estado:** Parte I: análisis y dirección visual. Parte II: implementación completa de la Opción C (“Graphite & Signal”) con Cabin + Jost, probada en una copia temporal.  
> **Alcance de la Parte II:** 9 archivos CSS + 1 línea de `index.html`. No requiere tocar `.tsx` ni lógica; el repositorio no se modifica hasta que apliques los archivos.  
> **Fuente de inspiración:** `https://github.com/rumbocrp/apexjournal`  
> **Commit analizado:** `f8b7191` (2026-09-11).  
> **Objetivo:** extraer los principios visuales de ApexJournal y traducirlos a FLARE con una identidad propia, densa y legible.

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

# Parte II — Implementación completa (Opción C)

> **Identidad:** “Graphite & Signal”.  
> **Tipografías:** Cabin para la interfaz, Jost para datos, etiquetas y display.  
> **Estado:** código completo, probado en una copia temporal del proyecto a 1440, 768, 390 y 320 px en tema oscuro, y en escritorio/móvil en tema claro.  
> **Alcance:** 9 archivos CSS y 1 línea de `index.html`. Cero cambios en `.tsx`, lógica, datos o tests.

La Parte I describía la dirección y comparaba alternativas. Esta parte es el “cómo”: los archivos completos, el orden de aplicación, la verificación y el rollback. No es un diff incremental; cada archivo se reemplaza entero para eliminar reglas duplicadas, selectores inválidos y deuda del CSS anterior.

---

## 10. Qué cambia exactamente

### 10.1. Archivos que se reemplazan

| # | Archivo | Qué controla |
|---:|---|---|
| 1 | `index.html` | Una sola línea: el `<link>` de Google Fonts. |
| 2 | `src/index.css` | Tokens de ambos temas, reset, foco, selección y scrollbar. |
| 3 | `src/App.css` | Layout, página, cabecera, tarjetas, botones, formularios y segmentados. |
| 4 | `src/components/Sidebar.css` | Navegación lateral de escritorio y barra superior de móvil. |
| 5 | `src/components/TradesTable.css` | Tabla de operaciones, señales, badges BUY/SELL y fila de total. |
| 6 | `src/components/EquityChart.css` | Tarjeta de gráfico compartida, equity, baseline, cursor y etiquetas. |
| 7 | `src/components/CandleChart.css` | Velas, medias, señales, leyenda, RSI y controles de mercado. |
| 8 | `src/pages/BotRun.css` | Panel de estado, dot de ejecución y resumen de estrategia. |
| 9 | `src/pages/Settings.css` | Filas de ajustes, títulos, descripciones y confirmación. |
| 10 | `src/pages/Backtest.css` | Grid de backtest, checkbox de cortos y chips de motivos. |

### 10.2. Lo que NO se toca

- Ningún `.tsx` ni `.ts`.
- Ningún hook, test, `package.json`, `vite.config.ts` o `eslint.config.js`.
- Ninguna cadena de texto, formato de número, cálculo o estructura de datos.
- `src/navItems.ts` no forma parte de esta guía. Si tienes una edición en curso para el dock, queda fuera de alcance y se conserva tal cual.
- No se añaden dependencias. Las fuentes vienen de Google Fonts o, si prefieres, de archivos locales.

### 10.3. La identidad en cinco decisiones

1. **Grafito cálido, no negro puro.** El fondo sube a `#0a0b0c` y las superficies a `#14171a`. El resultado es menos “terminal” y más herramienta de escritorio.
2. **Cabin para leer, Jost para medir.** Cabin tiene formas humanistas y aguanta bien 11–12 px. Jost es geométrica, tiene trazos limpios y cifras tabulares; se usa en títulos, etiquetas y números.
3. **Una lima de señal, usada con avaricia.** `#c6f24e` aparece en la acción primaria, el riel del nav activo, el punto de marca, la línea de equity, el foco y la selección. No se usa como texto de párrafo ni como relleno de tarjetas.
4. **Verde y rojo vuelven a significar dinero.** `--positive` y `--negative` quedan reservados para ganancia/pérdida, velas y lados de operación. Las series de medias usan ámbar y azul para no confundirse con P&L.
5. **Densidad de escritorio.** Filas de nav de 32 px, botones de 30 px, inputs de 32 px, celdas de 7/10 px. En móvil se mantiene la legibilidad: 34 px de fila y 11,5 px de texto como mínimo.

### 10.4. Antes y después

| Elemento | Antes (Matrix) | Después (Graphite & Signal) |
|---|---|---|
| Fondo | Negro puro `#050506` | Grafito `#0a0b0c` |
| Acento | Verde neón `#00ff41` en casi todo | Lima `#c6f24e` en pocos lugares |
| Texto | Verde neón / gris frío | Hueso `#eceae4` / gris cálido |
| Tipografía | VT323 19 px + system UI | Cabin 11–14 px + Jost para datos |
| Sidebar | 240 px, filas de 40 px, activo con relleno verde | 224 px, filas de 32 px, activo con riel lima interior |
| Página | 960 px, padding 32 px | 1080 px, padding 24 px |
| Tarjetas | Radio 8 px, valor VT323 | Radio 6 px, valor Jost 1,35 rem |
| Botones | 40 px, relleno verde | 30 px, neutro + una sola acción lima |
| Inputs | 40 px, borde tenue | 32 px, borde de 3:1 y foco lima |
| Tablas | Padding 8/12 px | Padding 7/10 px, cabecera uppercase y cifras Jost |
| Gráficos | Glow, líneas gruesas | Línea de 1,5 px, área al 16 %, baseline punteada |
| Segmentados | Activo con relleno verde | Activo con superficie neutra elevada |
| Tema claro | Acento naranja `#FA7E42` | Verde oliva `#4f7a00`, papel cálido |

### 10.5. Por qué reemplazar archivos completos

El CSS actual tiene tres problemas que un parche parcial dejaría vivos:

- reglas duplicadas de `.segmented__option` al final de `App.css`;
- un `--radius` usado pero no definido;
- selectores inválidos en `EquityChart.css` (`.chart__change positive` y `.color__change negative`), que nunca colorearon el cambio;
- un tema claro con `--accent: #FA7E42`, incoherente con el verde del tema oscuro.

Reemplazar el archivo completo elimina esa deuda de una vez y hace que el resultado sea reproducible. Si prefieres un diff mínimo, la guía sigue funcionando, pero arrastrarás reglas muertas y será más difícil diagnosticar.

---

## 11. Preparación y red de seguridad

### 11.1. Estado del repositorio

> **Nota de estado (12 nov 2026):** al preparar esta guía, `src/navItems.ts` tenía una edición en curso para el dock: el array `primaryNavIds` no estaba cerrado y `pnpm exec tsc -b` fallaba con `TS1137` en la línea 26. Eso no lo introduce el CSS y no forma parte de esta guía. Ciérralo antes de medir `pnpm build`. Los dos errores preexistentes de `src/backtest.ts` son independientes.

No ejecutes `git reset --hard` ni `git checkout .`. El árbol puede tener trabajo tuyo sin commitear. La guía solo reemplaza los diez archivos de la tabla 10.1.

### 11.2. Backup fuera del repositorio

Ejecuta esto desde la raíz del proyecto. Guarda la ruta que imprima el script.

```powershell
$stamp  = Get-Date -Format 'yyyyMMdd-HHmm'
$backup = "..\flare-css-backup-$stamp"
New-Item -ItemType Directory -Path $backup -Force | Out-Null

$files = @(
  'index.html',
  'src\index.css',
  'src\App.css',
  'src\components\Sidebar.css',
  'src\components\TradesTable.css',
  'src\components\EquityChart.css',
  'src\components\CandleChart.css',
  'src\pages\BotRun.css',
  'src\pages\Settings.css',
  'src\pages\Backtest.css'
)

foreach ($file in $files) {
  $dest = Join-Path $backup $file
  New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
  Copy-Item -LiteralPath $file -Destination $dest
}

Write-Host "Backup en $backup"
```

### 11.3. Rama opcional

Si el repositorio está limpio además de tus cambios actuales, una rama te da un punto de comparación cómodo:

```powershell
git switch -c identidad-graphite-signal
```

Si no quieres una rama, trabaja en la actual y usa el backup del paso 11.2.

### 11.4. Servidor de desarrollo

```powershell
pnpm install
pnpm dev
```

Abre la URL que imprime Vite (normalmente `http://localhost:5173`). Antes de tocar nada, comprueba el estado actual en tema oscuro y claro para tener una referencia.

### 11.5. Punto de control visual

Antes de aplicar los archivos, mira estas cuatro pantallas y anota lo que veas raro. Así distinguirás un problema nuevo de uno preexistente:

- Panel (Dashboard);
- Estadísticas con el gráfico de equity y la tabla;
- Backtest con el formulario y, si puedes, con un resultado;
- Ajustes, para el tema y los botones.

---

## 12. Paso 1 — `index.html`: Cabin + Jost

**Archivo:** `index.html`  
**Acción:** reemplaza solo la línea del `<link>` de fuentes. Deja los `preconnect` y el script de tema como están.

**Antes:**

```html
<link href="https://fonts.googleapis.com/css2?family=VT323&display=swap" rel="stylesheet" />
```

**Después:**

```html
<link href="https://fonts.googleapis.com/css2?family=Cabin:wght@400;500;600;700&family=Jost:wght@400;500;600;700&display=swap" rel="stylesheet" />
```

### 12.1. Por qué estos pesos

- Cabin 400/500/600 se usa en cuerpo, botones y títulos de ajustes.
- Jost 400/500/600 se usa en etiquetas, cifras, títulos y badges.
- El 700 queda disponible para cualquier `<strong>` que no tenga una regla propia. No es imprescindible, pero evita el faux-bold del navegador.

`display=swap` muestra la fuente de respaldo mientras descarga y luego cambia. En una herramienta local no supone un problema perceptible.

### 12.2. Verificación rápida de fuentes

Abre la consola del navegador y ejecuta:

```js
await document.fonts.ready
await document.fonts.load('400 12px Jost')
await document.fonts.load('600 20px Jost')

console.table({
  cabin:  document.fonts.check('400 12px Cabin'),
  jost400: document.fonts.check('400 12px Jost'),
  jost600: document.fonts.check('600 20px Jost'),
})
```

Las tres deben dar `true`.

> **Trampa conocida:** `document.fonts.check('12px Jost')` usa el peso 400 por defecto. Si la página que estás mirando solo usa Jost 500/600 (por ejemplo, el Dashboard), puede devolver `false` aunque la fuente esté perfectamente cargada. No es un fallo de la fuente: fuerza la carga con `document.fonts.load` antes de comprobar.

### 12.3. Opción sin Google Fonts (autoalojado)

Si trabajas sin conexión o no quieres una petición externa, descarga los WOFF2 de Cabin y Jost, guárdalos en `public/fonts/` y sustituye el `<link>` por un bloque `@font-face` en `src/index.css`:

```css
@font-face {
  font-family: 'Cabin';
  src: url('/fonts/cabin-400.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: 'Jost';
  src: url('/fonts/jost-400.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
```

Repite un `@font-face` por peso (400, 500, 600 y, si lo usas, 700). No cambies los nombres de familia: el resto del CSS depende de `'Cabin'` y `'Jost'`.

---

## 13. Paso 2 — `src/index.css`: tokens y base

**Archivo:** `src/index.css`  
**Acción:** reemplaza todo el contenido.

```css
/* ============================================================
   FLARE · Identidad "Graphite & Signal"
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

  /* Sombra del dock (si se aplica la guía de navegación) */
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

### 13.1. Qué hace cada grupo

- **Superficies:** `--bg` es el fondo de la app; `--bg-subtle` el sidebar, la cabecera de tablas y los inputs; `--surface` las tarjetas, formularios y tablas; `--surface-raised` el estado activo de un segmentado o del nav.
- **Bordes:** `--border` para separadores discretos; `--border-strong` para hover y énfasis; `--border-input` para los campos, con 3:1 sobre su relleno.
- **Texto:** `--text` para contenido; `--text-muted` para secundario; `--text-subtle` para etiquetas y ayudas. Los tres pasan AA en ambos temas.
- **Acento:** `--accent` y `--primary` comparten la lima. `--primary-hover` baja un paso. `--on-primary` es casi negro para 15:1 sobre la lima.
- **Semántica:** `--positive` y `--negative` son los únicos verdes/rojos financieros. `--buy-bg` y `--sell-bg` son fondos de badge, no de tarjetas.
- **Series:** `--overlay-fast` (ámbar) y `--overlay-slow` (azul) pertenecen a las medias; `--signal-buy` (hueso) y `--signal-sell` (rojo) a los marcadores de señal.
- **Tipografía:** `--font-ui` es Cabin; `--font-display` y `--font-mono` son Jost. El nombre `mono` se conserva por compatibilidad, pero no es una monoespaciada: es la fuente de datos. Las cifras se alinean con `font-variant-numeric: tabular-nums`.
- **Geometría:** radios de 3/4/6 px, botón de 30 px, input de 32 px. No hay `--radius` sin definir.
- **Dock:** `--shadow-dock` queda listo por si aplicas después `GUIA_DOCK_NAVEGACION_FLARE.md`. No añade lógica ni cambia el layout actual.

### 13.2. Tabla de tokens principales

| Token | Oscuro | Claro | Uso |
|---|---|---|---|
| `--bg` | `#0a0b0c` | `#f2f1ec` | Fondo de la app |
| `--bg-subtle` | `#0f1113` | `#e9e8e2` | Sidebar, thead, inputs |
| `--surface` | `#14171a` | `#ffffff` | Tarjetas, formularios, tablas |
| `--surface-hover` | `#1a1e22` | `#f0efe9` | Hover de filas y botones |
| `--surface-raised` | `#20252a` | `#e5e4dd` | Nav activo, segmentado activo |
| `--border` | `#262c31` | `#d6d4cc` | Separadores |
| `--border-strong` | `#3b444c` | `#b3b1a7` | Hover, badge, énfasis |
| `--border-input` | `#5a646d` | `#827f74` | Borde de inputs (3:1) |
| `--text` | `#eceae4` | `#171a16` | Texto principal |
| `--text-muted` | `#a8a69f` | `#5b5e56` | Texto secundario |
| `--text-subtle` | `#8d8b84` | `#64675e` | Etiquetas y ayudas |
| `--accent` / `--primary` | `#c6f24e` | `#4f7a00` | Acción e identidad |
| `--on-primary` | `#0b0d08` | `#ffffff` | Texto sobre la acción |
| `--positive` | `#4ade80` | `#157a45` | Ganancia |
| `--negative` | `#f87171` | `#c02626` | Pérdida |
| `--overlay-fast` | `#fbbf24` | `#a16207` | Media rápida |
| `--overlay-slow` | `#7dd3fc` | `#0369a1` | Media lenta |
| `--font-ui` | Cabin | Cabin | Interfaz |
| `--font-display` | Jost | Jost | Títulos |
| `--font-mono` | Jost | Jost | Datos y etiquetas |
| `--radius` / `--radius-md` | 4 / 6 px | 4 / 6 px | Controles / tarjetas |
| `--btn-height` / `--input-height` | 30 / 32 px | 30 / 32 px | Botones / campos |

### 13.3. Por qué Jost no es “mono” pero sí alinea

Jost es una sans geométrica. A 10–12 px con tracking pequeño se lee como una etiqueta técnica, no como una monoespaciada. Para que las columnas de números no bailen, todos los lugares con cifras usan:

```css
font-variant-numeric: tabular-nums;
```

Se verificó en el navegador que Jost tiene cifras tabulares: a 40 px, `1111111111` mide 180 px en proporcional y 232 px en tabular; `8888888888` mide 218,4 px en proporcional y 232 px en tabular. Con `tabular-nums`, todos los dígitos ocupan lo mismo y las columnas quedan alineadas.

### 13.4. Tema claro

El tema claro no es una inversión mecánica: usa papel cálido (`#f2f1ec`), superficies blancas, texto casi negro y un verde oliva (`#4f7a00`) para la acción. El naranja anterior (`#FA7E42`) desaparece porque competía con el ámbar de las medias y con el rojo de pérdida.

---

## 14. Paso 3 — `src/App.css`: layout y controles compartidos

**Archivo:** `src/App.css`  
**Acción:** reemplaza todo el contenido.

```css
/* Layout general: sidebar + contenido */
.app {
  display: grid;
  grid-template-columns: 224px minmax(0, 1fr);
  min-height: 100vh;
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
  .app {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
    align-content: start;
  }

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

### 14.1. Layout

- `.app` usa `grid-template-columns: 224px minmax(0, 1fr)`. El `minmax(0, 1fr)` evita que una tabla o un SVG ancho empuje la columna y provoque scroll horizontal.
- `.page` sube a 1080 px y baja el padding a 24 px. La cabecera deja de ser solo un título: tiene una regla inferior de 1 px que separa la página del contenido.
- `.content` mantiene `min-width: 0` por el mismo motivo que el `minmax`.

### 14.2. Tarjetas de métricas

- `.stats` usa `repeat(auto-fit, minmax(200px, 1fr))`. En 1440 px caben cuatro columnas; las ocho métricas de Estadísticas quedan 4×2, no 5+3.
- En `≤720 px` se fuerza `repeat(2, minmax(0, 1fr))`; en `≤380 px`, una columna. El `auto-fit` solo habría dado una columna en móvil y habría alargado demasiado la página.
- `.card__value` usa Jost 600 con `tabular-nums`. No hay altura fija: si una etiqueta larga ocupa dos líneas, la tarjeta crece y la fila se iguala sola.

### 14.3. Botones

- Todos los `.btn` miden 30 px de alto, con borde de 1 px y radio de 4 px.
- `.btn--primary` es la única acción con relleno lima y texto casi negro.
- `.btn--danger` es un contorno rojo; el hover invierte a relleno rojo con texto blanco.
- `:disabled` baja a 0,35 de opacidad. Es el motivo por el que “Guardar” se ve oliva apagado cuando no hay cambios: está deshabilitado, no es un error de color.

### 14.4. Formularios

- Los inputs y selects miden 32 px, usan `--bg-subtle` como relleno y `--border-input` como borde.
- El foco usa borde lima y un anillo de 1 px; el estado inválido usa rojo.
- `.field__label` y `.field__help` son Jost/Cabin de 9,5–11 px. No se baja de 9,5 px en etiquetas uppercase con tracking.

### 14.5. Segmentados

El estado activo usa `--surface-raised` y borde `--border-strong`, no relleno verde. Así el acento lima queda libre para la acción primaria y el riel del nav. El hover usa `--surface-hover`; el deshabilitado baja a 0,35.

### 14.6. El arreglo de móvil que no debes borrar

```css
@media (max-width: 720px) {
  .app {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
    align-content: start;
  }
}
```

Sin `grid-template-rows: auto minmax(0, 1fr)` y `align-content: start`, las filas automáticas del grid se estiran para llenar el `min-height: 100vh` y el sidebar ocupa unos 350 px en un móvil de 844 px, dejando un bloque vacío debajo del nav. Es el único bug de layout que apareció en la QA y se corrigió aquí.

---

## 15. Paso 4 — `src/components/Sidebar.css`: navegación

**Archivo:** `src/components/Sidebar.css`  
**Acción:** reemplaza todo el contenido. No cambies `Sidebar.tsx`.

```css
.sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 18px 12px;
  border-right: 1px solid var(--border);
  background: var(--bg-subtle);
  overflow-y: auto;
}

.sidebar__brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  color: var(--text);
  font: 600 14px/1 var(--font-display);
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.sidebar__brand::before {
  content: '';
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  background: var(--accent);
}

.sidebar__nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sidebar__link {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-muted);
  font: 500 12px/1 var(--font-ui);
  text-align: left;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}

.sidebar__link:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.sidebar__link--active {
  border-color: var(--border);
  background: var(--surface-raised);
  color: var(--text);
  font-weight: 600;
  box-shadow: inset 2px 0 0 var(--accent);
}

.sidebar__icon {
  width: 16px;
  flex: 0 0 auto;
  color: var(--text-subtle);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1;
  text-align: center;
}

.sidebar__link--active .sidebar__icon {
  color: var(--accent);
}

.sidebar__footer {
  margin-top: auto;
  padding: 0 10px;
  color: var(--text-subtle);
  font: 500 9px/1.4 var(--font-mono);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

@media (max-width: 720px) {
  .sidebar {
    position: static;
    height: auto;
    gap: 12px;
    padding: 12px;
    border-right: 0;
    border-bottom: 1px solid var(--border);
    overflow: visible;
  }

  .sidebar__brand {
    padding: 0 4px;
    font-size: 13px;
    letter-spacing: 0.2em;
  }

  .sidebar__nav {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px;
  }

  .sidebar__link {
    min-height: 34px;
    padding: 0 8px;
    font-size: 11.5px;
  }

  .sidebar__icon {
    width: 14px;
    font-size: 12px;
  }

  .sidebar__footer {
    display: none;
  }
}
```

### 15.1. Anatomía

- 224 px de ancho, `position: sticky`, `height: 100vh`, padding de 18/12 px.
- Marca `LIXTRD` en Jost 600 con tracking de 0,18 em y un cuadrado lima de 6 px como punto de identidad.
- Filas de 32 px, icono de 16 px, texto Cabin 12 px.
- El activo no se rellena de verde: usa `--surface-raised`, borde y `box-shadow: inset 2px 0 0 var(--accent)`. El riel lima es la única señal de acento.
- El icono del activo también pasa a lima; los demás quedan en `--text-subtle`.

### 15.2. Móvil

- `≤720 px`: el sidebar deja de ser columna y pasa a ser una barra superior con grid de dos columnas.
- Filas de 34 px, texto de 11,5 px, icono de 14 px.
- El footer “Modo simulación” se oculta para no comer altura.
- No hay fondo alternado tipo zebra ni scroll horizontal. La barra ocupa unos 160 px: marca + tres filas de dos botones.

### 15.3. Sin cambios de TSX

`Sidebar.tsx` ya renderiza `.sidebar__brand`, `.sidebar__nav`, `.sidebar__link`, `.sidebar__icon` y `.sidebar__footer`. El rediseño es solo CSS. Los iconos son glifos de texto; si más adelante pasas a `lucide-react`, el contenedor de 16 px y el color activo siguen sirviendo.

---

## 16. Paso 5 — `src/components/TradesTable.css`: tablas

**Archivo:** `src/components/TradesTable.css`  
**Acción:** reemplaza todo el contenido.

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

### 16.1. Qué mirar

- `.table-wrap` es el único que hace scroll horizontal. La tabla nunca debe empujar el ancho de la página.
- Padding de 7/10 px y texto de 12 px: más denso que antes, pero sin apretar.
- La cabecera es Jost 600 de 9,5 px, uppercase y tracking 0,09 em, con fondo `--bg-subtle`.
- `.trades__num` alinea a la derecha, usa Jost y `tabular-nums`.
- `.trades__pnl--positive` y `--negative` son los únicos colores de resultado.
- `.side--buy` y `.side--sell` son badges de 18 px; el fondo viene de `--buy-bg` / `--sell-bg`, no del acento.
- La fila de total (`tfoot`) tiene borde superior fuerte y fondo sutil.

> **Nota sobre `position: sticky`:** la cabecera tiene `position: sticky; top: 0`. En `.table-wrap` no hay altura fija, así que el sticky no se pega al viewport; queda preparado por si más adelante das a la tabla un alto máximo con scroll vertical. No estorba y no cambia el layout actual.

### 16.2. `SignalsTable` reutiliza estas clases

`SignalsTable.tsx` importa `TradesTable.css` y usa `.table-wrap`, `.trades`, `.trades__num`, `.side` y `.trades__empty`. No necesita un archivo nuevo ni cambios de TSX.

---

## 17. Paso 6 — `src/components/EquityChart.css`: gráfico compartido

**Archivo:** `src/components/EquityChart.css`  
**Acción:** reemplaza todo el contenido.

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

### 17.1. Lo que cambia

- La tarjeta `.chart` baja a padding 14/16 px, radio 6 px y borde de 1 px.
- `.chart__readout` es Jost 10,5 px; el valor fuerte sube a 18 px con `tabular-nums`.
- La línea de equity baja a 1,5 px y usa `--accent`. El área va del 16 % al 0 % de opacidad.
- `.chart__baseline` existe por primera vez. Antes el TSX la usaba pero no tenía CSS; ahora es una línea punteada de 2/4 px en `--chart-baseline`.
- `.chart__label` es Jost 9,5 px y `.chart__dot` tiene borde de 2 px del color de la superficie para separarse de la línea.

### 17.2. Selectores corregidos

El archivo anterior tenía:

```css
.chart__change positive  { color: var(--positive); }
.color__change negative { color: var(--negative); }
```

Ninguno de los dos coincide con el TSX, que genera `.chart__change--positive` y `.chart__change--negative`. Ahora los selectores son válidos y el cambio de equity se colorea de verdad.

### 17.3. Es una tarjeta compartida

`.chart` también la usan `CandleChart`, `RsiPanel` y `MarketSection`. No la renombres a `.equity-chart` sin actualizar esos componentes: el padding, el borde y el fondo se comparten a propósito.

---

## 18. Paso 7 — `src/components/CandleChart.css`: velas y RSI

**Archivo:** `src/components/CandleChart.css`  
**Acción:** reemplaza todo el contenido.

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

### 18.1. Semántica de color

- Velas alcistas: `--positive`; bajistas: `--negative`. Es la única pareja verde/rojo del gráfico de velas.
- Medias: `--overlay-fast` (ámbar) y `--overlay-slow` (azul). No son P&L.
- Marcador de compra: `--signal-buy` (hueso), para que se vea sobre una vela verde. Marcador de venta: `--signal-sell` (rojo).
- RSI: línea lima, banda de 30–70 con `--surface-raised` al 25 %. La banda es contexto, no una señal de ganancia.

### 18.2. Layout del mercado

- `.market__params` usa `repeat(auto-fit, minmax(160px, 1fr))`; en 390 px cae a una columna.
- `.market__controls` es un flex con wrap para los botones de par y temporalidad.
- `.market__subtitle` es Jost 600 de 10,5 px, uppercase y tracking 0,1 em, igual que los títulos de sección.
- `.chart__legend` tiene swatches de 12×2 px; no se usan emojis ni iconos externos.

### 18.3. Estados

`.chart.chart__status` cubre “cargando”, “sin datos” y error. El error usa `--negative`; el resto, `--text-muted`. No hay spinner ni animación que ignorar.

---

## 19. Paso 8 — `src/pages/BotRun.css`: panel de ejecución

**Archivo:** `src/pages/BotRun.css`  
**Acción:** reemplaza todo el contenido.

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

### 19.1. Qué mirar

- `.run-panel` es una fila con wrap: estado a la izquierda, acciones a la derecha. En móvil se apila sin romper.
- El dot mide 8 px. Apagado usa `--dot-off`; encendido usa `--positive` y un halo de 3 px con `--positive-halo`.
- El valor de estado es Jost 600 de 18 px; la etiqueta es Jost 9,5 px uppercase.
- `.run-summary__list` es un grid de 140 px mínimos; los `dt` son etiquetas y los `dd` valores Jost con `tabular-nums`.
- El botón “Iniciar” es la acción primaria lima; “Detener” queda deshabilitado hasta que el estado sea running.

---

## 20. Paso 9 — `src/pages/Settings.css`: ajustes

**Archivo:** `src/pages/Settings.css`  
**Acción:** reemplaza todo el contenido.

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

### 20.1. Qué mirar

- Cada `.setting` es una fila con wrap, padding 14/16 px y radio 6 px.
- El título es Cabin 600 de 13 px; la descripción, Cabin 11,5 px en `--text-muted`.
- `.setting__text` tiene `flex: 1 1 260px` y `max-width: 520px`; en móvil el control baja debajo sin pegarse al borde.
- El bloque de confirmación de “Restore data” usa `.setting__confirm` con gap de 8 px; no cambia el comportamiento del botón.

---

## 21. Paso 10 — `src/pages/Backtest.css`: página de backtest

**Archivo:** `src/pages/Backtest.css`  
**Acción:** reemplaza todo el contenido.

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

### 21.1. Qué mirar

- `.backtest__grid` es un grid de 200 px mínimos con gap 14/16 px. En 390 px cae a una columna.
- El checkbox de cortos usa `accent-color: var(--accent)`; en oscuro se ve lima, en claro oliva.
- `.backtest__reason` es un chip de 24 px, borde de 1 px y Jost 10 px. No usa el acento: los motivos son datos, no acciones.
- El resto del formulario (`.form`, `.field`, `.btn`, `.segmented`) viene de `App.css`; este archivo solo añade lo específico de Backtest.

---

## 22. Orden de aplicación

### 22.1. Orden recomendado

| Paso | Archivo | Por qué en este orden |
|---:|---|---|
| 1 | `index.html` | Sin las fuentes, los tokens caen a system UI y parece que el CSS falló. |
| 2 | `src/index.css` | Define todos los tokens que usan los demás archivos. |
| 3 | `src/App.css` | Layout y controles compartidos. |
| 4 | `src/components/Sidebar.css` | Navegación. |
| 5 | `src/components/TradesTable.css` | Tablas. |
| 6 | `src/components/EquityChart.css` | Tarjeta de gráfico compartida. |
| 7 | `src/components/CandleChart.css` | Velas, RSI y mercado. |
| 8 | `src/pages/BotRun.css` | Panel de ejecución. |
| 9 | `src/pages/Settings.css` | Ajustes. |
| 10 | `src/pages/Backtest.css` | Backtest. |

Puedes reemplazar los diez archivos seguidos y recargar una sola vez. Si prefieres revisar por etapas, hazlo en este orden y recarga después de cada grupo; a mitad de camino la app puede verse incompleta, pero no se rompe.

### 22.2. Commits sugeridos

Un solo commit es aceptable:

```text
style: apply Graphite & Signal identity (Cabin + Jost)
```

Si prefieres separar:

```text
style: add Graphite & Signal tokens and fonts
style: rebuild layout, sidebar and financial tables
style: restyle charts, bot panels and settings
```

### 22.3. Mapa de dependencias

```text
index.css ── tokens ──► App.css ── layout/controles ──► Sidebar.css
                                   ├─► TradesTable.css
                                   ├─► EquityChart.css ──► CandleChart.css
                                   ├─► BotRun.css
                                   ├─► Settings.css
                                   └─► Backtest.css
```

`EquityChart.css` define `.chart`, que también usan `CandleChart` y `RsiPanel`. `TradesTable.css` define `.trades`, que también usa `SignalsTable`. No dupliques esas reglas en los archivos de página.

---

## 23. Verificación

### 23.1. Comandos

```powershell
pnpm dev
pnpm test
pnpm exec tsc -b --pretty false
pnpm build
pnpm lint
```

Guarda la salida de `pnpm exec tsc -b` antes y después de aplicar el CSS. Debe ser idéntica: el CSS no puede añadir errores de TypeScript. Si aparece un error nuevo, no viene de esta guía.

> **Estado conocido (12 nov 2026):** `pnpm build` y `tsc` pueden fallar por la edición en curso de `src/navItems.ts` y por dos errores preexistentes en `src/backtest.ts`. `pnpm lint` falla antes de analizar el código por la incompatibilidad entre `typescript-eslint@8.72` y TypeScript 7.0. Nada de eso lo introduce el CSS.

Para validar solo el CSS y el bundle, cuando el árbol no tenga errores de sintaxis:

```powershell
pnpm exec vite build
```

Vite avisa de un error de CSS en la terminal y en el overlay del navegador. Si el CSS está bien, el build de Vite no debería quejarse por los tipos.

### 23.2. Fuentes y estilos computados

En la consola del navegador:

```js
const css = (el) => getComputedStyle(el)

console.log({
  body:      css(document.body).fontFamily,
  title:     css(document.querySelector('.page__header h1')).fontFamily,
  cardValue: css(document.querySelector('.card__value')).fontFamily,
  sidebar:   document.querySelector('.sidebar')?.getBoundingClientRect().width,
  overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
})
```

Esperado en escritorio:

- `body`: `Cabin, ui-sans-serif, ...`
- `title`: `Jost, Cabin, ...`
- `cardValue`: `Jost, Cabin, ...`
- `sidebar`: `224`
- `overflowX`: `0`

Si `overflowX` no es 0, busca el elemento que se sale con:

```js
[...document.querySelectorAll('body *')]
  .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
  .slice(0, 10)
  .forEach((el) => console.log(el.tagName, el.className))
```

Las tablas deben aparecer dentro de `.table-wrap`; si ves un `table.trades` en la lista, el wrap no está haciendo su trabajo.

### 23.3. Checklist de escritorio (1440 × 900)

- [ ] El sidebar mide 224 px y queda sticky; no hay scroll horizontal.
- [ ] La página mide como máximo 1080 px y la cabecera tiene regla inferior.
- [ ] El Panel muestra cuatro tarjetas en una fila.
- [ ] Estadísticas muestra las ocho métricas en 4×2.
- [ ] Los títulos y etiquetas son Jost; el cuerpo y los botones son Cabin.
- [ ] Solo hay una acción lima por vista (Guardar, Ejecutar backtest o Iniciar).
- [ ] Los inputs miden 32 px y el foco es lima.
- [ ] La tabla tiene cabecera uppercase, cifras alineadas y P&L verde/rojo.
- [ ] El gráfico de equity dibuja línea, área, baseline punteada y etiquetas.
- [ ] El gráfico de velas dibuja velas, medias ámbar/azul, señales y RSI.
- [ ] El tema claro no tiene naranja y el sidebar sigue legible.

### 23.4. Checklist de tablet (768 × 1024)

- [ ] El sidebar sigue a 224 px; el contenido cabe sin scroll horizontal.
- [ ] Las métricas quedan en dos columnas.
- [ ] Las tablas hacen scroll solo dentro de `.table-wrap`.
- [ ] El subtítulo de la cabecera puede ocupar dos líneas sin empujar el badge.
- [ ] Los botones de acciones no se salen de la tarjeta.

### 23.5. Checklist de móvil (390 × 844 y 320 × 700)

- [ ] El sidebar se convierte en barra superior de dos columnas y mide unos 160 px.
- [ ] No queda un bloque vacío debajo del nav (regla `grid-template-rows`).
- [ ] El contenido empieza inmediatamente después del nav.
- [ ] Las tarjetas van en dos columnas y pasan a una por debajo de 380 px.
- [ ] El gráfico ocupa el ancho disponible y las etiquetas no se cortan.
- [ ] La tabla tiene scroll horizontal dentro de `.table-wrap`; la página no.
- [ ] Los botones de formulario y los segmentados hacen wrap sin desbordar.
- [ ] En 320 px no hay scroll horizontal de página.

### 23.6. Tema claro

- [ ] `data-theme="light"` se aplica al elegir Light en Ajustes.
- [ ] El fondo es papel cálido, no blanco puro.
- [ ] El acento es oliva `#4f7a00`; el botón primario tiene texto blanco.
- [ ] `--positive` y `--negative` siguen siendo legibles sobre blanco.
- [ ] El sidebar activo usa superficie elevada + riel oliva.
- [ ] El gráfico de equity usa oliva y el área no tapa la línea.

### 23.7. Teclado y accesibilidad

- [ ] Tab recorre nav, botones, inputs y segmentados en orden.
- [ ] `:focus-visible` dibuja un anillo lima de 2 px con offset de 2 px.
- [ ] Los botones deshabilitados no reciben foco.
- [ ] Los inputs inválidos muestran borde rojo y `aria-invalid="true"`.
- [ ] `prefers-reduced-motion` desactiva transiciones.
- [ ] El texto no baja de 9,5 px en etiquetas ni de 11 px en ayudas.

### 23.8. Problemas y soluciones

| Síntoma | Causa probable | Solución |
|---|---|---|
| Todo se ve con la fuente del sistema | El `<link>` sigue siendo VT323 o la fuente no cargó | Revisa 12.1 y la pestaña Network |
| El sidebar mide 350 px en móvil | Falta `grid-template-rows` en el media query | Copia 14.6 completo |
| Hay scroll horizontal en la página | Una tabla o SVG fuera de su contenedor | Revisa `.table-wrap` y `minmax(0, 1fr)` |
| Los inputs casi no se ven | Falta `--border-input` o no reemplazaste `index.css` | Añade el token y el borde de 3:1 |
| El activo del nav es verde | Quedó el CSS viejo o el `.segmented` viejo | Reemplaza `Sidebar.css` y `App.css` completos |
| El tema claro sigue naranja | `index.css` no se reemplazó | Cambia `--accent` a `#4f7a00` |
| La gráfica de equity no colorea el cambio | Los selectores inválidos siguen ahí | Usa `.chart__change--positive/negative` |
| La cabecera de la tabla no se pega | `.table-wrap` no tiene altura máxima | Es el comportamiento esperado; ver 16.1 |
| El botón Guardar se ve oliva apagado | Está deshabilitado | Es correcto; cambia un campo para activarlo |
| Las fechas ocupan mucho en la tabla | El contenido es ISO, no el CSS | Fuera de alcance; formatea en `format.ts` |

---

## 24. Contraste medido

Los ratios se calcularon con la fórmula WCAG 2.1 sobre los valores finales de los tokens. Para texto normal el mínimo es 4,5:1; para texto grande y componentes de UI, 3:1.

### 24.1. Tema oscuro

| Combinación | Ratio | Uso | ¿AA? |
|---|---:|---|---|
| `--text` / `--bg` | 16,37 | Texto principal | Sí |
| `--text` / `--surface` | 14,96 | Texto en tarjetas | Sí |
| `--text-muted` / `--surface` | 7,39 | Texto secundario | Sí |
| `--text-subtle` / `--surface` | 5,28 | Etiquetas y ayudas | Sí |
| `--text-subtle` / `--bg-subtle` | 5,55 | Cabecera de tabla, sidebar | Sí |
| `--text-subtle` / `--surface-raised` | 4,53 | Etiquetas sobre activo | Sí |
| `--on-primary` / `--primary` | 15,08 | Botón primario | Sí |
| `--positive` / `--surface` | 10,32 | Ganancia | Sí |
| `--negative` / `--surface` | 6,50 | Pérdida | Sí |
| `--bg` / `--negative` | 7,12 | Hover de botón danger | Sí |
| `--positive` / `--buy-bg` | 9,14 | Badge BUY | Sí |
| `--sell-text` / `--sell-bg` | 9,08 | Badge SELL | Sí |
| `--border-input` / `--bg-subtle` | 3,13 | Borde de input (UI) | Sí (3:1) |

### 24.2. Tema claro

| Combinación | Ratio | Uso | ¿AA? |
|---|---:|---|---|
| `--text` / `--bg` | 15,53 | Texto principal | Sí |
| `--text` / `--surface` | 17,56 | Texto en tarjetas | Sí |
| `--text-muted` / `--surface` | 6,60 | Texto secundario | Sí |
| `--text-subtle` / `--surface` | 5,76 | Etiquetas y ayudas | Sí |
| `--text-subtle` / `--bg-subtle` | 4,69 | Cabecera de tabla, sidebar | Sí |
| `--text-subtle` / `--surface-raised` | 4,52 | Etiquetas sobre activo | Sí |
| `--on-primary` / `--primary` | 5,10 | Botón primario | Sí |
| `--positive` / `--surface` | 5,38 | Ganancia | Sí |
| `--negative` / `--surface` | 5,92 | Pérdida | Sí |
| `--bg` / `--negative` | 5,24 | Hover de botón danger | Sí |
| `--positive` / `--buy-bg` | 4,78 | Badge BUY | Sí |
| `--sell-text` / `--sell-bg` | 5,65 | Badge SELL | Sí |
| `--border-input` / `--bg-subtle` | 3,27 | Borde de input (UI) | Sí (3:1) |

### 24.3. Qué queda fuera del 3:1

Los bordes decorativos (`--border`, `--border-strong` en el tema claro) no llegan a 3:1 sobre el fondo. No son el único medio para identificar tarjetas o secciones: el contenido, las etiquetas y los cambios de superficie también las delimitan. Los inputs sí usan `--border-input` porque su relleno es casi el mismo que el fondo y el borde es la única affordance.

Si necesitas 1.4.11 estricto también en las tarjetas, sube `--border` a `#5a646d` en oscuro y `#827f74` en claro. El resultado es más pesado, pero cumple. Está documentado como variante en 26.5.

### 24.4. Semántica

- La lima no es “ganancia”. Es identidad, foco y acción.
- El verde `--positive` y el rojo `--negative` son P&L, velas y lados.
- El ámbar y el azul son series de medias; no los leas como warning o pérdida.
- El marcador de compra es hueso, no verde, para no desaparecer sobre una vela verde.

---

## 25. Rollback

### 25.1. Rollback total desde el backup

Usa la ruta que imprimió el script de 11.2:

```powershell
$backup = "..\flare-css-backup-AAAAMMDD-HHMM"

$files = @(
  'index.html',
  'src\index.css',
  'src\App.css',
  'src\components\Sidebar.css',
  'src\components\TradesTable.css',
  'src\components\EquityChart.css',
  'src\components\CandleChart.css',
  'src\pages\BotRun.css',
  'src\pages\Settings.css',
  'src\pages\Backtest.css'
)

foreach ($file in $files) {
  Copy-Item -LiteralPath (Join-Path $backup $file) -Destination $file -Force
}
```

Recarga con `Ctrl+F5`. El backup conserva la estructura de carpetas, así que no tienes que reconstruir rutas a mano.

### 25.2. Rollback con git

Solo si los diez archivos estaban limpios antes de empezar:

```powershell
git restore -- index.html src/index.css src/App.css `
  src/components/Sidebar.css src/components/TradesTable.css `
  src/components/EquityChart.css src/components/CandleChart.css `
  src/pages/BotRun.css src/pages/Settings.css src/pages/Backtest.css
```

No uses `git checkout .` ni `git reset --hard`: borrarías el trabajo que no es de esta guía.

### 25.3. Rollback solo de fuentes

Si quieres volver a VT323 pero conservar el resto del CSS, no basta con restaurar el `<link>`: los tokens `--font-*` seguirían apuntando a Cabin/Jost. Restaura también estas tres líneas en `src/index.css`:

```css
--font-display: 'VT323', ui-monospace, monospace;
--font-ui: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
--font-mono: ui-monospace, 'Cascadia Code', 'SFMono-Regular', Menlo, monospace;
```

No es recomendable: VT323 a 11–12 px no aguanta la densidad de una tabla financiera.

### 25.4. Rollback de un solo archivo

Cada archivo es independiente. Si solo te falla una página, restaura su CSS y deja el resto:

```powershell
Copy-Item -LiteralPath "..\flare-css-backup-AAAAMMDD-HHMM\src\pages\Backtest.css" `
  -Destination "src\pages\Backtest.css" -Force
```

---

## 26. Alternativas y variantes

### 26.1. Autoalojar las fuentes

Ya está descrito en 12.3. Es la opción recomendada si el producto va a funcionar sin red o si no quieres depender de Google Fonts. No cambia ningún token.

### 26.2. Cambiar el acento

La lima es la identidad de esta opción. Si prefieres algo más frío o más sobrio, cambia solo `--accent`, `--primary`, `--primary-hover` y `--on-primary` en ambos temas:

| Variante | Oscuro | Claro | `--on-primary` oscuro |
|---|---|---|---|
| Lima (actual) | `#c6f24e` | `#4f7a00` | `#0b0d08` |
| Ámbar | `#fbbf24` | `#a16207` | `#1a1200` |
| Azul hielo | `#7dd3fc` | `#0369a1` | `#06121a` |
| Verde menta | `#86efac` | `#15803d` | `#06140b` |

Si cambias el acento, revisa el contraste de `--on-primary` sobre `--primary` y el de `--accent` sobre `--surface`.

### 26.3. Subir o bajar la densidad

Para una versión más cómoda:

```css
:root {
  --btn-height: 32px;
  --input-height: 34px;
}

.trades th,
.trades td {
  padding: 9px 12px;
}

.sidebar__link {
  min-height: 36px;
}
```

Para una versión más compacta, baja el botón a 28 px y el padding de celda a 6/8 px. No bajes el texto de 11 px ni la fila del nav de 30 px: la legibilidad se pierde antes que el espacio.

### 26.4. Solo Cabin o solo Jost

- **Solo Cabin:** pon `--font-display` y `--font-mono` en Cabin. Ganas uniformidad, pierdes el contraste geométrico de los números.
- **Solo Jost:** pon `--font-ui` en Jost. Es más coherente, pero a 12 px el cuerpo pierde la humanista de Cabin y cansa en párrafos largos.
- **Híbrido actual:** Cabin para leer, Jost para medir. Es la mezcla recomendada.

### 26.5. Bordes estrictos 1.4.11

Si la accesibilidad de componentes es un requisito formal, sube los bordes decorativos:

```css
:root {
  --border: #5a646d;
}

:root[data-theme='light'] {
  --border: #827f74;
}
```

Esto afecta tarjetas, tablas y botones. Es más pesado visualmente, pero todos los límites llegan a 3:1. Si solo te importan los inputs, ya está resuelto con `--border-input`.

### 26.6. Solo tema oscuro

Si no vas a usar el tema claro, puedes borrar el bloque `:root[data-theme='light']`. No lo hagas si el selector de Ajustes sigue ofreciendo Light/Auto: el tema claro quedaría con los tokens oscuros y los textos oscuros sobre fondo oscuro.

---

## 27. Compatibilidad con el dock de navegación

Esta identidad y `GUIA_DOCK_NAVEGACION_FLARE.md` comparten tokens. Se pueden aplicar juntas, pero el orden importa.

### 27.1. Qué comparten

- `--bg`, `--bg-subtle`, `--surface`, `--surface-hover`, `--surface-raised`.
- `--border`, `--border-strong`, `--text`, `--text-muted`, `--text-subtle`.
- `--shadow-dock` ya está definido en ambos temas.
- `--font-ui` sigue siendo Cabin, también en el dock.

El dock no necesita cambiar ningún color: su tecla activa invierte `--text` y `--bg`, y con los tokens nuevos queda hueso sobre grafito.

### 27.2. Si aplicas primero esta guía y después el dock

Es el orden recomendado.

1. Aplica la Parte II completa.
2. Verifica la identidad con el sidebar.
3. Aplica el dock.
4. En el paso del dock que reemplaza `.app`, conserva el padding inferior del dock:

```css
.app {
  min-height: 100vh;
  padding-bottom: calc(
    var(--dock-height) + 24px + env(safe-area-inset-bottom, 0px)
  );
}
```

5. En el media query de 720 px, **no borres el bloque completo**. El nuestro contiene `.page`, `.page__header`, `.stats`, `.card`, `.form` y `.form__status`, además de `.app`. Si el dock elimina el grid, las dos propiedades `grid-template-*` de `.app` quedan inertes; puedes dejarlas o borrar solo esas dos líneas. Si borras el bloque entero, pierdes todos los ajustes móviles de la identidad.

### 27.3. Si el dock ya está aplicado

No reemplaces `src/App.css` por el de la Parte II tal cual: volvería a poner el grid de sidebar y quitaría el padding del dock. Tampoco reemplaces `src/index.css` completo: el archivo del dock contiene `--dock-*` y `--shadow-dock`, y perderías esos tokens. Haz esto:

- en `index.css`, conserva los tokens `--dock-*` y mezcla los de la Parte II; o reemplaza y vuelve a añadir el bloque del dock;
- conserva la regla `.app` del dock;
- copia el resto de `App.css` (página, cabecera, tarjetas, botones, formularios, segmentados, media query);
- en el media query, deja las propiedades de `.app` o elimínalas, pero no borres las demás reglas;
- aplica `Sidebar.css` (aunque el dock no lo use), tablas, gráficos y páginas.

### 27.4. Tokens del dock

La Parte II no incluye `--dock-tile`, `--dock-gap`, `--dock-pad`, `--dock-indicator-lane` ni `--dock-height`. Añádelos si aplicas el dock después. No dupliques `--shadow-dock`: elige la sombra del dock o la de la identidad; ambas funcionan.

### 27.5. Nota sobre `navItems.ts`

Si vienes de la guía del dock, revisa que `primaryNavIds` cierre el array y que el export sea `overflowNavItems`. En el momento de preparar esta guía, el archivo tenía `overflowMavItems` y un array sin cerrar; esa corrección pertenece al dock, no a la identidad. No la apliques desde aquí.

### 27.6. Checklist de convivencia

- [ ] El dock flota sobre el contenido sin tapar la última fila.
- [ ] La tecla activa se ve hueso sobre grafito en ambos temas.
- [ ] El foco del dock usa el anillo lima.
- [ ] El sidebar ya no se renderiza si el dock lo reemplazó.
- [ ] `--shadow-dock` existe una sola vez por tema.
- [ ] En 320 px el dock cabe y no hay scroll horizontal.
- [ ] El media query de 720 px conserva los ajustes de página y tarjetas.

---

## 28. Definition of done

La Opción C está terminada cuando puedes marcar todo esto:

- [ ] `index.html` carga Cabin + Jost; no queda VT323.
- [ ] Los diez archivos de 10.1 están reemplazados completos.
- [ ] El sidebar mide 224 px en escritorio y 160 px de alto en móvil.
- [ ] Las páginas usan 1080 px de máximo y la cabecera tiene regla inferior.
- [ ] Las métricas quedan 4×2 en escritorio, 2 columnas en tablet/móvil y 1 columna en 320 px.
- [ ] Solo hay una acción lima por vista.
- [ ] Los inputs miden 32 px, tienen borde visible y foco lima.
- [ ] Las tablas hacen scroll solo dentro de `.table-wrap`.
- [ ] P&L, velas y badges usan verde/rojo; las medias usan ámbar/azul.
- [ ] El gráfico de equity tiene línea, área, baseline y etiquetas.
- [ ] El tema claro es papel cálido + oliva, sin naranja.
- [ ] 1440, 768, 390 y 320 no tienen scroll horizontal de página.
- [ ] El foco de teclado se ve en todos los controles.
- [ ] La tabla de contraste de la sección 24 se cumple.
- [ ] No se tocó ningún `.tsx`, hook, test o lógica.
- [ ] El backup de 11.2 existe y el rollback de 25.1 está probado.
- [ ] Los errores conocidos de build/lint son los mismos de antes, no nuevos.

Si algo falla, vuelve a 23.8 y revisa primero que los archivos estén completos. El 90 % de los problemas de una migración CSS son un archivo a medio pegar o la caché del navegador; el 10 % restante suele ser una tabla fuera de `.table-wrap`.

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
