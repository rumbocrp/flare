# FLARE — Guía de la barra superior móvil

> **Versión 2 — compacta y minimalista.**  
> **Estado:** documento de diseño e implementación. No modifica código.  
> **Archivo que se documenta:** `src/components/Sidebar.css`.  
> **Archivos que NO se tocan:** `Sidebar.tsx`, `App.tsx`, `App.css`, `index.css`, `Backtest.tsx`.  
> **Objetivo:** reemplazar los botones grandes de la barra superior móvil por opciones compactas, discretas y densas, sin scroll horizontal.  
> **Inspiración:** la navegación y los controles de `https://github.com/rumbocrp/apexjournal` (commit `f8b7191`).

---

## 0. Resumen ejecutivo

La versión anterior de esta guía resolvía el scroll horizontal con filas de botones a todo el ancho, fondo verde brillante y texto negro. Funcionaba, pero visualmente pesaba demasiado: parecía una lista de botones gigantes, no una barra de navegación.

Esta versión mantiene la misma estructura —marca arriba, menú debajo, sin scroll— pero cambia la escala y el tratamiento:

1. Botones de **34 px de alto** en lugar de ~43 px.
2. Texto de **12–13 px** en lugar de heredar los 19 px del `body`.
3. Fondo **sutil**: una fila usa `--surface`, la siguiente es transparente.
4. Sin bloques verdes completos; el verde queda para el estado activo y el foco.
5. Radio de **4 px**, borde de **1 px**, separación de **3 px**.
6. Estado activo con **barra lateral de 2 px**, superficie elevada y peso semibold.
7. Sin punto decorativo obligatorio ni sombras brillantes.

El resultado se acerca a la navegación de ApexJournal: densa, neutra y con el acento reservado para lo importante.

### 0.1. Definición de “hecho”

- [ ] En ≤720 px no hay scroll horizontal en el sidebar.
- [ ] La marca queda arriba y el menú debajo, separado por una línea sólida.
- [ ] Cada opción mide entre 32 y 36 px de alto.
- [ ] El texto del menú mide entre 12 y 13 px.
- [ ] Las filas alternan superficie y texto de forma sutil.
- [ ] La página activa se distingue por barra lateral, superficie y peso.
- [ ] El hover y el foco no rompen la alternancia.
- [ ] En escritorio el sidebar sigue igual.
- [ ] El tema claro y el oscuro siguen siendo legibles.
- [ ] `pnpm build` y `pnpm lint` pasan.

---

## 1. Diagnóstico: qué había y por qué se cambia

### 1.1. El problema original

En móvil, el sidebar se convertía en una fila horizontal con `overflow-x: auto`:

```css
@media (max-width: 720px) {
  .sidebar {
    flex-direction: row;
    overflow-x: auto;
  }

  .sidebar__nav {
    flex-direction: row;
  }

  .sidebar__link {
    width: auto;
    white-space: nowrap;
  }
}
```

Eso producía el scroll horizontal que ya conocemos. La primera solución cambió el eje a columna y puso botones a todo el ancho con alternancia verde/negro. Resolvía el scroll, pero introducía otro problema: **demasiada superficie y demasiado contraste para un elemento de navegación secundario**.

### 1.2. Qué se conserva de la versión 1

- La estructura de `Sidebar.tsx` no cambia.
- La marca sigue arriba.
- El menú sigue debajo, en su propio bloque.
- No hay scroll horizontal.
- No se usa JavaScript ni `useMediaQuery`.
- La alternancia de filas se mantiene, pero en versión sutil.

### 1.3. Qué se descarta

| Elemento de la v1 | Por qué se descarta | Reemplazo v2 |
|---|---|---|
| Filas de ~43 px | Pesan demasiado en una cabecera | 34 px |
| Fondo `--primary` en filas impares | Convierte la navegación en un bloque de neón | `--surface` |
| Texto negro sobre verde | Contraste agresivo para algo secundario | Texto normal/atenuado |
| Punto `●` grande | Ruido visual | Barra lateral de 2 px |
| `box-shadow` de 4 px | Marcador demasiado ancho | 2 px |
| `border-top` punteado | Look de borrador | Línea sólida |
| `border-radius: 8px` | Demasiado blando para una barra densa | 4 px |
| `gap: 8px` | Demasiado aire entre opciones | 3 px |

---

## 2. La referencia: qué toma de ApexJournal

ApexJournal es una app de escritorio con una interfaz densa y sobria. Su sidebar usa:

- ancho de 224 px;
- filas de navegación de unos 32 px;
- texto de 11–12 px;
- iconos de 16 px;
- texto atenuado;
- estado activo con `bg-surface-secondary`, `font-semibold` y borde izquierdo de 2 px;
- bordes de 1 px y radios de 4–8 px;
- transiciones de 120 ms que solo animan color, borde y fondo.

No usa botones gigantes ni rellenos de color en cada fila. Esa es la lección que se aplica aquí:

> **El acento no se reparte entre todas las opciones. Se reserva para la opción activa y para la acción principal.**

La guía completa de dirección visual está en `GUIA_ESTETICA_APEXJOURNAL.md`.

---

## 3. Antes y después

### 3.1. Esquema

**Versión 1 (grande):**

```text
┌──────────────────────────────────┐
│ LIXTRD                           │
│ ──────────────────────────────── │
│ ██████████  Panel          ●     │  ← verde brillante
│ ██████████  Ajustar bot          │  ← negro
│ ██████████  Ejecutar bot         │  ← verde brillante
│ ██████████  Estadísticas         │  ← negro
│ ██████████  Ajustes              │  ← verde brillante
└──────────────────────────────────┘
```

**Versión 2 (compacta):**

```text
┌──────────────────────────────────┐
│ LIXTRD                           │
│ ──────────────────────────────── │
│ ▏ Panel                          │  ← activo, superficie elevada
│   Ajustar bot                    │  ← transparente
│   Ejecutar bot                   │  ← superficie
│   Estadísticas                   │  ← transparente
│   Ajustes                        │  ← superficie
└──────────────────────────────────┘
```

### 3.2. Medidas de referencia

| Propiedad | v1 | v2 |
|---|---:|---:|
| Altura de fila | ~43 px | 34 px |
| Fuente del menú | 19 px heredados | 12.8 px |
| Separación entre filas | 8 px | 3 px |
| Padding del sidebar | 14 px | 10–12 px |
| Padding del botón | 11px 14px | 5px 8px |
| Radio | 8 px | 4 px |
| Borde | 1 px verde/strong | 1 px neutro |
| Fondo impar | `--primary` | `--surface` |
| Fondo par | `--bg` | `transparent` |
| Activo | fondo de fila + punto | superficie + barra 2 px |
| Altura total del bloque | ~309 px | ~220 px |

La reducción de altura no es solo estética: deja más espacio para el contenido de la página en pantallas pequeñas.

---

## 4. Implementación paso a paso

> **Importante:** este bloque es una propuesta documentada. El `Sidebar.css` actual todavía contiene la versión 1. No se aplica nada desde este documento.

### Paso 1. Reduce el contenedor

```css
@media (max-width: 720px) {
  .sidebar {
    position: static;        /* deja de ser sticky en móvil */
    height: auto;            /* anula el 100vh de escritorio */
    flex-direction: column;  /* marca arriba, menú abajo */
    align-items: stretch;
    gap: 8px;                /* antes: 10px */
    padding: 10px 12px 12px; /* antes: 14px */
    border-right: none;
    border-bottom: 1px solid var(--border);
    overflow: visible;
  }
}
```

**Por qué:** el sidebar ya no necesita tanto aire. El padding de 10–12 px mantiene la separación del borde sin desperdiciar altura.

### Paso 2. Haz la marca más discreta

```css
.sidebar__brand {
  padding: 0 2px;
  font-size: 0.95rem;       /* antes: 1.05rem */
  letter-spacing: 0.12em;
  color: var(--text-muted); /* compite menos con el contenido */
}
```

**Por qué:** en ApexJournal la marca es pequeña, en mayúsculas y con tracking. Sigue presente, pero no domina.

Si prefieres que `LIXTRD` mantenga el verde principal, cambia `color` a `var(--text)`. No uses un tamaño mayor a `1rem` en móvil.

### Paso 3. Compacta el bloque de navegación

```css
.sidebar__nav {
  display: flex;
  flex-direction: column;
  gap: 3px;                  /* antes: 8px */
  width: 100%;
  padding-top: 8px;          /* antes: 12px */
  border-top: 1px solid var(--border); /* antes: dashed */
}
```

**Por qué:** la línea sólida y el poco espacio crean un bloque denso, no una sección separada con demasiado aire.

### Paso 4. Reduce el tamaño de cada opción

```css
.sidebar__link {
  width: 100%;
  min-height: 34px;          /* antes: ~43px */
  justify-content: flex-start;
  gap: 8px;                  /* icono-texto */
  padding: 5px 8px;          /* antes: 11px 14px */
  border: 1px solid transparent;
  border-radius: 4px;        /* antes: 8px */
  background: transparent;
  color: var(--text-muted);
  font-size: 0.8rem;         /* ~12.8px */
  line-height: 1.2;
  white-space: normal;
}
```

**Por qué:**

- `min-height: 34px` reduce la altura sin volverla intocable.
- `font-size: 0.8rem` es clave: el `body` mide `1.2rem` (19.2 px), demasiado para una barra densa.
- `padding: 5px 8px` mantiene una zona de pulsación razonable.
- `border-radius: 4px` es más técnico y menos “burbuja”.
- `white-space: normal` permite que un texto largo baje de línea si hace falta.

**Accesibilidad:** 34 px es aceptable para una barra secundaria, pero está por debajo de los 44 px recomendados. Si quieres más margen táctil sin agrandar el diseño, usa `min-height: 36px` y `gap: 4px`. No bajes de 32 px.

### Paso 5. Ajusta el icono

```css
.sidebar__icon {
  width: 16px;        /* antes: 20px */
  font-size: 0.85rem;
  text-align: center;
}
```

**Por qué:** un icono de 16 px acompaña mejor a un texto de 12.8 px. Si el icono queda más grande que el texto, la fila vuelve a sentirse pesada.

### Paso 6. Alterna superficie y texto de forma sutil

```css
/* Filas impares: superficie leve y texto principal */
.sidebar__link:nth-child(odd) {
  background: var(--surface);
  color: var(--text);
  border-color: var(--border);
}

/* Filas pares: transparente y texto atenuado */
.sidebar__link:nth-child(even) {
  background: transparent;
  color: var(--text-muted);
  border-color: transparent;
}
```

**Por qué:**

- Ya no se invierte el fondo con `--primary`; eso era lo que hacía que la barra pareciera un semáforo.
- La alternancia sigue existiendo, pero se apoya en superficies y textos, no en bloques de neón.
- `--surface` en tema oscuro es `#050505`; la diferencia con el fondo `#000000` es sutil.
- En tema claro, `--surface` es `#e8fff0`; la alternancia también funciona.

**Si quieres una alternancia aún más discreta:** deja el mismo `color` en ambas filas y cambia solo el fondo. Si la quieres más marcada, usa `--surface-raised` en las impares.

### Paso 7. Unifica el hover

```css
.sidebar__link:nth-child(odd):hover,
.sidebar__link:nth-child(even):hover {
  background: var(--surface-hover);
  color: var(--text);
  border-color: var(--border-strong);
}
```

**Por qué:** con dos reglas separadas es fácil que una fila quede ilegible. Una sola regla mantiene el hover consistente y evita que el color de texto cambie de forma extraña.

### Paso 8. Marca la opción activa con precisión

```css
.sidebar__link.sidebar__link--active,
.sidebar__link.sidebar__link--active:hover {
  background: var(--surface-raised);
  color: var(--text);
  border-color: var(--border-strong);
  box-shadow: inset 2px 0 0 var(--accent); /* barra izquierda */
  font-weight: 600;
}
```

**Por qué:**

- Se usa `.sidebar__link.sidebar__link--active` para tener más especificidad que `:nth-child(odd/even)` y que el hover.
- Ya no hay punto `●`: la barra de 2 px, la superficie elevada y el peso semibold son suficientes.
- `box-shadow: inset` no cambia el layout; no desplaza el texto.
- El verde aparece solo aquí y en el foco. Ese es el cambio de jerarquía más importante.

**Si quieres conservar el punto:** añade un `::after` pequeño, pero no lo hagas obligatorio. La barra lateral ya comunica el estado.

```css
.sidebar__link.sidebar__link--active::after {
  content: '';
  width: 4px;
  height: 4px;
  margin-left: auto;
  border-radius: 50%;
  background: var(--accent);
}
```

### Paso 9. Foco discreto

```css
.sidebar__link:focus-visible {
  outline: 1px solid var(--text-subtle);
  outline-offset: 1px;
}
```

**Por qué:** ApexJournal usa un anillo gris de 2 px (`#52525b`), no un resplandor neón. En FLARE, `--text-subtle` cumple ese papel sin romper la paleta. Si necesitas más visibilidad, usa `2px solid var(--accent)`.

### Paso 10. Conserva el footer oculto

```css
.sidebar__footer {
  display: none;
}
```

El footer “Modo simulación” no aporta navegación en móvil y ocupa espacio.

---

## 5. Bloque completo final

```css
@media (max-width: 720px) {
  /* 1. Contenedor compacto, sin scroll. */
  .sidebar {
    position: static;
    height: auto;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: 10px 12px 12px;
    border-right: none;
    border-bottom: 1px solid var(--border);
    overflow: visible;
  }

  /* 2. Marca discreta. */
  .sidebar__brand {
    padding: 0 2px;
    font-size: 0.95rem;
    letter-spacing: 0.12em;
    color: var(--text-muted);
  }

  /* 3. Bloque de navegación denso. */
  .sidebar__nav {
    display: flex;
    flex-direction: column;
    gap: 3px;
    width: 100%;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }

  /* 4. Opción compacta. */
  .sidebar__link {
    width: 100%;
    min-height: 34px;
    justify-content: flex-start;
    gap: 8px;
    padding: 5px 8px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--text-muted);
    font-size: 0.8rem;
    line-height: 1.2;
    white-space: normal;
  }

  /* 5. Icono a escala del texto. */
  .sidebar__icon {
    width: 16px;
    font-size: 0.85rem;
    text-align: center;
  }

  /* 6. Alternancia sutil. */
  .sidebar__link:nth-child(odd) {
    background: var(--surface);
    color: var(--text);
    border-color: var(--border);
  }

  .sidebar__link:nth-child(even) {
    background: transparent;
    color: var(--text-muted);
    border-color: transparent;
  }

  /* 7. Hover único. */
  .sidebar__link:nth-child(odd):hover,
  .sidebar__link:nth-child(even):hover {
    background: var(--surface-hover);
    color: var(--text);
    border-color: var(--border-strong);
  }

  /* 8. Activo: superficie + barra + peso. */
  .sidebar__link.sidebar__link--active,
  .sidebar__link.sidebar__link--active:hover {
    background: var(--surface-raised);
    color: var(--text);
    border-color: var(--border-strong);
    box-shadow: inset 2px 0 0 var(--accent);
    font-weight: 600;
  }

  /* 9. Foco discreto. */
  .sidebar__link:focus-visible {
    outline: 1px solid var(--text-subtle);
    outline-offset: 1px;
  }

  /* 10. Footer fuera en móvil. */
  .sidebar__footer {
    display: none;
  }
}
```

### 5.1. Diff conceptual contra la v1

```diff
   .sidebar {
-    gap: 10px;
-    padding: 14px;
+    gap: 8px;
+    padding: 10px 12px 12px;
   }
 
   .sidebar__brand {
-    font-size: 1.05rem;
+    font-size: 0.95rem;
+    color: var(--text-muted);
   }
 
   .sidebar__nav {
-    gap: 8px;
-    padding-top: 12px;
-    border-top: 1px dashed var(--border);
+    gap: 3px;
+    padding-top: 8px;
+    border-top: 1px solid var(--border);
   }
 
   .sidebar__link {
-    padding: 11px 14px;
-    border-radius: 8px;
+    min-height: 34px;
+    padding: 5px 8px;
+    border-radius: 4px;
+    font-size: 0.8rem;
   }
 
-  .sidebar__link:nth-child(odd) {
-    background: var(--primary);
-    color: var(--on-primary);
-  }
+  .sidebar__link:nth-child(odd) {
+    background: var(--surface);
+    color: var(--text);
+    border-color: var(--border);
+  }
 
   .sidebar__link:nth-child(even) {
-    background: var(--bg);
-    color: var(--text);
-    border-color: var(--border-strong);
+    background: transparent;
+    color: var(--text-muted);
+    border-color: transparent;
   }
 
   .sidebar__link--active {
-    box-shadow: inset 4px 0 0 currentColor;
-    font-weight: 700;
-  }
-
-  .sidebar__link--active::after {
-    content: '●';
-    margin-left: auto;
-    font-size: 0.7rem;
+    background: var(--surface-raised);
+    color: var(--text);
+    border-color: var(--border-strong);
+    box-shadow: inset 2px 0 0 var(--accent);
+    font-weight: 600;
   }
```

---

## 6. Verificación

### 6.1. Comandos

```bash
pnpm dev
pnpm build
pnpm lint
```

### 6.2. Anchos de prueba

| Ancho | Qué revisar |
|---|---|
| 320 px | El texto cabe; no hay scroll; las filas no se aplastan. |
| 360 px | La alternancia se distingue; el activo se ve claro. |
| 390 px | Altura total cercana a 220 px; no hay botones gigantes. |
| 430 px | Hay aire suficiente sin perder densidad. |
| 720 px | Sigue en columna; el último ancho móvil. |
| 721 px | Vuelve el sidebar lateral de escritorio. |
| 1024 px | Escritorio intacto. |

### 6.3. Checklist visual

- [ ] No hay scroll horizontal.
- [ ] La marca es discreta.
- [ ] Las filas miden 34 px.
- [ ] El texto se lee a 12–13 px.
- [ ] Las filas impares tienen superficie; las pares son transparentes.
- [ ] El hover ilumina la fila sin romper la alternancia.
- [ ] El activo tiene barra izquierda de 2 px.
- [ ] El foco de teclado se ve.
- [ ] El tema claro no pierde contraste.
- [ ] El sidebar de escritorio no cambió.

### 6.4. Comprobación técnica

```js
const nav = document.querySelector('.sidebar__nav')

console.log({
  anchoVisible: nav.clientWidth,
  anchoContenido: nav.scrollWidth,
  desborda: nav.scrollWidth > nav.clientWidth,
})
```

Si `desborda` es `true`, revisa que `.sidebar__link` tenga `width: 100%`, `white-space: normal` y que no haya un `min-width` mayor que el viewport.

---

## 7. Variantes de personalización

### 7.1. Aún más compacta: dos columnas

Si quieres reducir la altura del bloque, usa una cuadrícula de dos columnas:

```css
@media (max-width: 720px) {
  .sidebar__nav {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px;
  }

  .sidebar__link {
    min-height: 32px;
  }

  /* La quinta opción ocupa las dos columnas. */
  .sidebar__link:last-child:nth-child(odd) {
    grid-column: 1 / -1;
  }
}
```

Ventaja: el bloque baja a ~110 px. Desventaja: los textos largos tienen menos ancho; pruébalo en 320 px.

### 7.2. Chips en fila con `flex-wrap`

Si prefieres un look de etiquetas en lugar de lista:

```css
@media (max-width: 720px) {
  .sidebar__nav {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 4px;
  }

  .sidebar__link {
    width: auto;
    min-height: 28px;
    padding: 4px 8px;
  }
}
```

No hay scroll horizontal porque las filas se envuelven. El ancho irregular puede verse menos ordenado que la lista.

### 7.3. Más altura táctil

Si la prioridad es la accesibilidad táctil por encima de la densidad:

```css
@media (max-width: 720px) {
  .sidebar__link {
    min-height: 38px;
    padding: 7px 10px;
  }

  .sidebar__nav {
    gap: 4px;
  }
}
```

Sigue siendo más compacto que la v1.

### 7.4. Activo más visible

Si el marcador de 2 px te parece demasiado sutil:

```css
.sidebar__link.sidebar__link--active {
  box-shadow: inset 3px 0 0 var(--accent);
  border-color: var(--accent);
}

.sidebar__link.sidebar__link--active .sidebar__icon {
  color: var(--accent);
}
```

No vuelvas al fondo `--primary` completo: perderías la razón principal del rediseño.

### 7.5. Marca más Matrix

Si quieres que `LIXTRD` conserve protagonismo:

```css
.sidebar__brand {
  color: var(--text);
  font-size: 1rem;
  text-shadow: 0 0 8px var(--positive-halo);
}
```

Úsalo con moderación: el resplandor vuelve a competir con el contenido.

---

## 8. Problemas comunes

| Síntoma | Causa | Solución |
|---|---|---|
| Sigue el scroll horizontal | Queda `overflow-x: auto` o `white-space: nowrap` | Revisa `.sidebar`, `.sidebar__nav` y `.sidebar__link`. |
| Las filas siguen grandes | `font-size` heredado del `body` (1.2rem) | Añade `font-size: 0.8rem` al enlace. |
| El activo no se ve | La regla `:nth-child` tiene más especificidad | Usa `.sidebar__link.sidebar__link--active`. |
| El hover rompe el color | Reglas de hover separadas o mal ordenadas | Usa una regla única después de la alternancia. |
| El texto se corta | `white-space: nowrap` o ancho insuficiente | Usa `white-space: normal` y prueba en 320 px. |
| El sidebar mide 100vh | Falta `height: auto` | Añade `height: auto`. |
| El tema claro pierde contraste | Se usaron colores fijos | Usa tokens `--surface`, `--text`, `--text-muted`. |
| El bloque sigue pesando | Demasiado padding o gap | Reduce a `padding: 5px 8px` y `gap: 3px`. |

---

## 9. Accesibilidad

- **Semántica:** se mantienen `<nav>` y `<button>`; no cambies a `<div>`.
- **Estado actual:** `aria-current="page"` sigue en `Sidebar.tsx`.
- **Foco:** `:focus-visible` con `outline` de 1–2 px; no lo elimines.
- **Zona táctil:** 34 px es el mínimo visual; si puedes, usa 36–38 px. WCAG 2.2 pide 24 px como mínimo y 44 px como recomendación.
- **Color:** el activo no depende solo del verde; también tiene barra, superficie y peso.
- **Contraste:** revisa el tema claro; `--text-muted` sobre `--surface` debe superar 4.5:1 para texto normal.
- **Movimiento:** si añades transiciones, limita a color/borde/fondo y respeta `prefers-reduced-motion`.

---

## 10. Relación con la guía de estética

Esta guía resuelve solo la barra móvil. La dirección visual completa —paleta, tipografía, botones, tarjetas, tablas, formularios y roadmap— está en:

`GUIA_ESTETICA_APEXJOURNAL.md`

Orden recomendado:

1. Aplicar esta barra compacta cuando decidas tocar `Sidebar.css`.
2. Revisar la guía de estética y decidir cuánto del “Matrix sobrio” quieres adoptar.
3. Cambiar primero tokens y tipografía; después componentes.
4. No mezclar el rediseño global con la lógica de Backtest.

---

## 11. Checklist final

- [ ] La media query está en `src/components/Sidebar.css`.
- [ ] `.sidebar` usa `flex-direction: column` y `overflow: visible`.
- [ ] `.sidebar__nav` tiene `gap: 3px` y línea sólida.
- [ ] `.sidebar__link` tiene `min-height: 34px`, `font-size: 0.8rem`, `padding: 5px 8px`.
- [ ] Las filas impares usan `--surface`; las pares son transparentes.
- [ ] El hover es único y consistente.
- [ ] El activo usa `.sidebar__link.sidebar__link--active`.
- [ ] La barra activa mide 2 px.
- [ ] El foco es visible.
- [ ] En 320–720 px no hay scroll horizontal.
- [ ] En 721 px vuelve el sidebar lateral.
- [ ] `pnpm build` y `pnpm lint` pasan.

---

## Apéndice A. Versión 1 (descartada)

La v1 de esta guía proponía:

- filas de ~43 px;
- fondo `--primary` en filas impares y texto `--on-primary`;
- fondo `--bg` en filas pares y texto `--text`;
- punto `●` al extremo derecho;
- barra activa de 4 px;
- `border-top` punteado.

Se conserva como referencia histórica, pero no se recomienda: demasiada superficie de neón para un elemento de navegación. La v2 reduce altura, saturación y contraste, y reserva el verde para el estado activo.
