# FLARE — Dock de navegación tipo macOS + barra superior mínima

> **Versión:** 1.0  
> **Fecha:** 12 de noviembre de 2026  
> **Estado:** guía de implementación. Este documento **no modifica código por sí solo**.  
> **Objetivo:** reemplazar el sidebar actual por un dock compacto, cuadrado y monocromático, igual en móvil y escritorio, con una barra superior mínima (`LIXTRD` a la izquierda, página actual a la derecha).  
> **Documento:** `GUIA_DOCK_NAVEGACION_FLARE.md` (raíz del proyecto).  
> **Carpeta nueva:** `src/components/navigation/`.  
> **Dependencias nuevas:** ninguna.

---

## 0. Resultado final

```text
┌──────────────────────────────────────────────────────────────┐
│  LIXTRD                                             PANEL    │  barra superior · 38 px
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                         contenido                            │
│                                                              │
│                                                              │
│              ┌──────────────────────────────┐                │
│              │  ▦   ⚙   ▶   ⟲   ◔   ⋯      │                │  dock · 60–66 px
│              └──────────────────────────────┘                │
└──────────────────────────────────────────────────────────────┘
```

- **5 accesos primarios:** Panel, Ajustar bot, Ejecutar bot, Backtest, Estadísticas.
- **Más (⋯):** contiene Ajustes inicialmente. Si mañana agregas otra página que no esté en el dock, aparece ahí automáticamente.
- **Tecla activa:** una pieza elevada con colores invertidos (`--text` de fondo, `--bg` para el icono) y un subrayado inferior del mismo color. La pieza se desliza entre teclas con una animación CSS de 420 ms.
- **Móvil y escritorio:** el mismo componente y el mismo dock flotante. No hay media query de JavaScript ni dos navegaciones distintas.
- **Sin paquetes nuevos:** iconos SVG inline, animación CSS y cero dependencias.

La implementación fue probada en una copia temporal del proyecto a **320 × 700** y **1440 × 900**, en tema oscuro y claro. TypeScript no reporta errores en los archivos nuevos; los únicos errores que quedan son los preexistentes de `src/backtest.ts` (ver sección 16).

---

## 1. Decisiones de diseño y por qué

| Decisión | Implementación | Motivo |
|---|---|---|
| Posición | Dock fijo abajo, centrado, a `10px + safe-area` | Zona de pulgar en móvil y presencia discreta en escritorio. |
| Tamaño | Teclas de `42–48px`, gap `4px`, padding `6px` | Caben 6 teclas en 320 px sin scroll y sin ocupar media pantalla. |
| Activo | Pieza deslizante + icono invertido + subrayado | Se lee como un dock de macOS sin depender de JavaScript. |
| Color activo | `var(--text)` / `var(--bg)` | Inversión real del tema, no un color financiero. |
| Subrayado | `var(--text)` | `--negative` en FLARE significa pérdida; usarlo aquí confundiría semántica y color. |
| Iconos | Mapa SVG inline en `DockIcon.tsx` | Monocromáticos, `currentColor`, cero dependencias y fáciles de reemplazar. |
| Overflow | `primaryNavIds` + `overflowNavItems` derivados de `navItems` | Una sola fuente de verdad para etiquetas, orden y páginas. |
| Animación | Solo CSS, con `--app-dock-index` | No se mide el DOM, no hay `useLayoutEffect`, no se dispara `set-state-in-effect`. |
| Barra superior | `position: sticky`, 38 px + safe-area | No roba altura al contenido y mantiene marca + contexto. |
| Layout | `.app` pasa de grid a bloque con padding inferior | El dock es fijo; el contenido necesita reservar su altura. |
| Rollback | `Sidebar.tsx` y `Sidebar.css` no se tocan | Volver atrás es restaurar dos líneas en `App.tsx`. |

### 1.1 Por qué el activo no usa `--negative`

En FLARE, `--negative` es el rojo de las pérdidas (`#ff0000` en oscuro, `#c81e1e` en claro). Un subrayado rojo bajo el icono activo se leería como “pérdida” o “error”, no como “página actual”.

La guía usa la inversión del tema:

- Fondo de la tecla activa: `var(--text)`.
- Icono de la tecla activa: `var(--bg)`.
- Subrayado: `var(--text)`.

En oscuro queda un cuadrado claro con icono casi negro; en claro queda un cuadrado oscuro con icono casi blanco. Funciona en ambos temas sin agregar tokens nuevos.

---

## 2. Mapa de archivos

```text
FLARE/
├── index.html                              ← modificar 1 línea (viewport)
├── src/
│   ├── navItems.ts                         ← reemplazar (añade exports)
│   ├── App.tsx                             ← modificar 2 puntos
│   ├── App.css                             ← modificar 2 puntos
│   ├── index.css                           ← insertar tokens
│   └── components/
│       ├── Sidebar.tsx                     ← NO TOCAR (rollback)
│       ├── Sidebar.css                     ← NO TOCAR (rollback)
│       └── navigation/                     ← CREAR carpeta
│           ├── AppDock.tsx                 ← crear
│           ├── AppDock.css                 ← crear
│           ├── AppTopBar.tsx               ← crear
│           ├── AppTopBar.css               ← crear
│           └── DockIcon.tsx                ← crear
```

### 2.1 Archivos que se crean

| Archivo | Responsabilidad |
|---|---|
| `src/components/navigation/DockIcon.tsx` | Mapa de iconos SVG. Único lugar donde se personalizan los dibujos. |
| `src/components/navigation/AppDock.tsx` | Dock, teclas, estado activo y menú «Más». |
| `src/components/navigation/AppDock.css` | Geometría, gota deslizante, tooltips, menú y accesibilidad visual. |
| `src/components/navigation/AppTopBar.tsx` | Barra superior: marca y título de la página. |
| `src/components/navigation/AppTopBar.css` | Estilos de la barra superior. |

### 2.2 Archivos que se modifican

| Archivo | Cambio |
|---|---|
| `src/navItems.ts` | Añade `primaryNavIds`, `primaryNavItems`, `overflowNavItems` y `getNavLabel`. Conserva `navItems` y el campo `icon` para el rollback. |
| `src/App.tsx` | Sustituye el import de `Sidebar` por `AppDock` + `AppTopBar`, y cambia el JSX. |
| `src/App.css` | `.app` deja de ser grid; se añade padding inferior y se elimina el colapso de columnas. |
| `src/index.css` | Añade tokens `--dock-*` y `--shadow-dock` en oscuro; sombra clara en el tema light. |
| `index.html` | Añade `viewport-fit=cover` para los safe areas de iOS. |

### 2.3 Archivos que NO se tocan

- `src/components/Sidebar.tsx`
- `src/components/Sidebar.css`
- `src/types.ts`
- `src/settings.ts`
- `src/pages/**`
- `package.json`
- `pnpm-lock.yaml`
- `vite.config.ts`
- `eslint.config.js`

El sidebar queda **inerte**: al dejar de importarse en `App.tsx`, Vite ya no carga su CSS ni su componente. No lo borres todavía; es el rollback más barato.

---

## 3. Antes de empezar

1. **Guarda tu trabajo actual.** El proyecto tiene cambios sin commitear. No ejecutes `git reset --hard` ni `git checkout .`.
2. Crea una rama o un commit de checkpoint:

   ```bash
   git status
   git add -A
   git commit -m "checkpoint antes del dock"
   ```

   Si prefieres no commitear, usa `git stash push -u` y luego `git stash pop`; pero no mezcles el stash con la implementación.

3. Instala dependencias si hace falta:

   ```bash
   pnpm install
   ```

4. Comprueba el estado de base:

   ```bash
   pnpm build
   ```

   Al momento de escribir esta guía, `pnpm build` ya falla por errores preexistentes en `src/backtest.ts` (líneas 277 y 414). **No atribuyas esos errores al dock.** La sección 16 explica cómo verificar solo los archivos nuevos.

5. Ten claro el orden de los pasos. Los tokens de `index.css` deben existir antes de que `App.css` use `--dock-height`.

---

## 4. Paso 1 — `src/navItems.ts`

**Documento:** `src/navItems.ts`  
**Acción:** reemplaza el archivo completo.  
**Sección:** todo el archivo (actualmente 16 líneas).  
**Por qué:** `navItems` sigue siendo la única fuente de verdad. Añadimos tres exports derivados y una función de etiqueta para la barra superior.

### 4.1 Código completo

```ts
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

/** Accesos que siempre viven en el dock, en este orden. */
export const primaryNavIds: readonly PageId[] = [
  'dashboard',
  'bot-config',
  'bot-run',
  'backtest',
  'stats',
]

/** Accesos visibles en el dock, en el orden de primaryNavIds. */
export const primaryNavItems: NavItem[] = primaryNavIds
  .map((id) => navItems.find((item) => item.id === id))
  .filter((item): item is NavItem => item !== undefined)

/** Todo lo que no está en el dock se muestra en el menú «Más». */
export const overflowNavItems: NavItem[] = navItems.filter(
  (item) => !primaryNavIds.includes(item.id),
)

/** Etiqueta de la página para la barra superior. */
export function getNavLabel(id: PageId): string {
  return navItems.find((item) => item.id === id)?.label ?? id
}
```

### 4.2 Qué hace cada export

| Export | Uso |
|---|---|
| `navItems` | Orden y etiquetas base. También lo usa el sidebar si haces rollback. |
| `primaryNavIds` | Lista curada de lo que va en el dock. Su orden manda. |
| `primaryNavItems` | Objetos completos de las teclas del dock, en el orden de `primaryNavIds`. |
| `overflowNavItems` | Lo que no está en el dock; alimenta el menú «Más». |
| `getNavLabel(id)` | Etiqueta legible para `AppTopBar`. Si falta, devuelve el id. |

> **Importante:** no borres el campo `icon` de `NavItem`. Aunque `AppDock` no lo usa, `Sidebar.tsx` sí lo necesita para el rollback. Los iconos Unicode actuales son solo del sidebar; el dock usa `DockIcon.tsx`.

> **Límite práctico:** 5 primarios + Más = 6 teclas. A 42 px caben en 320 px. Si añades un séptimo acceso primario, muévelo a «Más» o reduce `--dock-tile`; no lo metas a la fuerza.

---

## 5. Paso 2 — `src/components/navigation/DockIcon.tsx`

**Documento:** `src/components/navigation/DockIcon.tsx`  
**Acción:** crea la carpeta `src/components/navigation/` y dentro este archivo.  
**Sección:** archivo nuevo completo.  
**Por qué:** los iconos son SVG inline, monocromáticos y usan `currentColor`. No hay emoji, no hay paquete de iconos y se cambian en un solo lugar.

### 5.1 Código completo

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

### 5.2 Cómo personalizar los iconos

1. Abre `DockIcon.tsx`.
2. Busca la clave del icono (`dashboard`, `bot-config`, `bot-run`, `backtest`, `stats`, `settings`, `more`).
3. Reemplaza el contenido JSX por tus propios `path`, `rect`, `circle`, etc.
4. Mantén estas reglas:
   - `viewBox="0 0 24 24"`.
   - Trazos con `stroke="currentColor"` (lo pone el `<svg>` contenedor).
   - No pongas colores fijos; el color lo decide el estado CSS.
   - Deja el `svg` con `aria-hidden="true"`; el nombre accesible va en el botón.

Ejemplo: cambiar el icono de Panel por una casa.

```tsx
dashboard: (
  <>
    <path d="M4 10.5 12 4l8 6.5" />
    <path d="M6.5 9.5V20h11V9.5" />
  </>
),
```

> **Escalabilidad:** el mapa es `Record<PageId | 'more', ReactNode>`. Si mañana agregas un nuevo `PageId` en `src/types.ts`, TypeScript fallará hasta que agregues su icono. Eso evita publicar una tecla sin dibujo.

---

## 6. Paso 3 — `src/components/navigation/AppDock.tsx`

**Documento:** `src/components/navigation/AppDock.tsx`  
**Acción:** crea el archivo completo dentro de `src/components/navigation/`.  
**Sección:** archivo nuevo.  
**Por qué:** concentra la navegación, el estado del menú «Más» y el índice activo. No mide el DOM; solo publica `--app-dock-index` para que CSS haga el resto.

### 6.1 Código completo

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

### 6.2 Cómo funciona el índice activo

```text
activePage = 'backtest'
  → primaryIndex = 3
  → activeIndex = 3
  → style="--app-dock-index: 3"
  → CSS: translateX(3 × (--dock-tile + --dock-gap))
  → la gota cae exactamente bajo Backtest
```

- Si la página está en `primaryNavItems`, el índice es su posición (0–4).
- Si está en `overflowNavItems`, el índice es `primaryNavItems.length` (la posición de Más).
- Si no está en ninguna lista, el índice cae en 0. Es un estado imposible desde la UI, pero evita un índice negativo.

### 6.3 Por qué no hay `useLayoutEffect` midiendo el DOM

La gota podría medirse con `getBoundingClientRect` y guardarse en estado. Eso obliga a un efecto que llama a `setState`, y este proyecto tiene `react-hooks/set-state-in-effect` como **error**. Además, medir el DOM en cada resize es más frágil.

Aquí todas las teclas miden lo mismo y el gap es constante, así que la posición se calcula con CSS:

```css
translateX(calc(var(--app-dock-index) * (var(--dock-tile) + var(--dock-gap))))
```

No hay observadores, no hay estado extra y la animación sigue siendo fluida.

### 6.4 Comportamiento del menú «Más»

- Se abre con clic, Enter o Espacio.
- Se cierra con clic fuera (`pointerdown` en `document`).
- Se cierra con `Escape` y devuelve el foco a Más.
- Al elegir una opción, navega, cierra el menú y devuelve el foco a Más.
- `aria-expanded` y `aria-controls` describen el estado.
- El contenedor usa `role="group"` con `aria-label`; no es un `role="menu"`, así que no exige navegación con flechas. Es un disclosure simple y accesible.

> **Única aserción de tipo:** `as CSSProperties` en `dockStyle`. Es la forma estándar de pasar una custom property (`--app-dock-index`) a `style` en React. No hay `any`.

---

## 7. Paso 4 — `src/components/navigation/AppDock.css`

**Documento:** `src/components/navigation/AppDock.css`  
**Acción:** crea el archivo completo dentro de `src/components/navigation/`.  
**Sección:** archivo nuevo.  
**Por qué:** toda la geometría y la animación viven aquí. No se necesita JavaScript para el estado activo.

### 7.1 Código completo

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
  outline: 2px solid var(--text);
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

### 7.2 Medidas que puedes ajustar

| Token / regla | Valor actual | Efecto |
|---|---|---|
| `--dock-tile` | `clamp(42px, 11vw, 48px)` | Tamaño del cuadrado. |
| `--dock-gap` | `4px` | Separación entre teclas. |
| `--dock-pad` | `6px` | Aire entre teclas y borde del dock. |
| `--dock-indicator-lane` | `4px` | Carril inferior para el subrayado. |
| `border-radius` del dock | `16px` | Redondeo del contenedor. |
| `border-radius` de tecla | `11px` | Redondeo de cada cuadrado. |
| `transition` de la gota | `420ms` | Velocidad del deslizamiento. |

Fórmula de la gota:

```text
x = índice × (ancho_de_tecla + gap)
```

Si cambias el tamaño o el gap, la gota se recoloca sola. No hay números mágicos en JavaScript.

### 7.3 Fallbacks y accesibilidad visual

- **`color-mix`:** hay una declaración opaca previa (`background: var(--surface-raised)`). Si el navegador no soporta `color-mix`, el dock sigue viéndose bien.
- **`backdrop-filter`:** es decorativo. Sin soporte, queda el fondo opaco.
- **`prefers-reduced-motion`:** desactiva la transición de la gota, el hover y la animación del menú.
- **`forced-colors`:** usa `Highlight` / `HighlightText` para el estado activo.
- **Contraste:** el estado activo invierte `--text`/`--bg`; los iconos inactivos usan `--text-muted` sobre `--surface-raised`, con contraste suficiente en ambos temas.

> **No cambies el subrayado a `--negative`** salvo que quieras que la navegación parezca una alerta de pérdida. Si quieres un acento, usa `--accent` y verifica el contraste.

---

## 8. Paso 5 — `src/components/navigation/AppTopBar.tsx`

**Documento:** `src/components/navigation/AppTopBar.tsx`  
**Acción:** crea el archivo completo.  
**Sección:** archivo nuevo.  
**Por qué:** la barra superior no necesita saber nada del resto de la app; recibe `activePage` y resuelve la etiqueta con `getNavLabel`.

### 8.1 Código completo

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

### 8.2 Detalles

- `aria-live="polite"` anuncia el cambio de página a lectores de pantalla sin interrumpir.
- La marca es un `span`, no un enlace. Si quieres que LIXTRD vuelva al Panel, conviértelo en botón y pásale `onNavigate('dashboard')`; está documentado como alternativa en la sección 18.
- El título se muestra en mayúsculas por CSS, pero el texto accesible conserva “Panel”, “Ajustes”, etc.

---

## 9. Paso 6 — `src/components/navigation/AppTopBar.css`

**Documento:** `src/components/navigation/AppTopBar.css`  
**Acción:** crea el archivo completo.  
**Sección:** archivo nuevo.  
**Por qué:** barra sticky, 38 px, con safe-area superior y título truncable.

### 9.1 Código completo

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

### 9.2 Por qué sticky y no fixed

- `sticky` mantiene la barra arriba sin sacarla del flujo: el contenido no necesita un padding superior extra.
- `fixed` obligaría a reservar `topbar-height` en `.app` y a sincronizar dos alturas.
- La barra respeta `env(safe-area-inset-top)` en iOS con notch.

---

## 10. Paso 7 — `src/App.tsx`

**Documento:** `src/App.tsx`  
**Acción:** dos reemplazos exactos. No reescribas el archivo completo; conserva el resto de tu lógica.  
**Sección:** importaciones (línea 8 actual) y JSX final (líneas 93–98 actuales).

### 10.1 Reemplazo 1: importación

**Antes** (línea 8 actual):

```tsx
import Sidebar from './components/Sidebar'
```

**Después:**

```tsx
import AppDock from './components/navigation/AppDock'
import AppTopBar from './components/navigation/AppTopBar'
```

> No dejes el import de `Sidebar` “por si acaso”. Si lo dejas, el componente se sigue empaquetando y puede ejecutar su CSS. El rollback se hace volviendo a poner esta línea, no manteniéndola.

### 10.2 Reemplazo 2: JSX

**Antes** (líneas 93–98 actuales):

```tsx
  return (
    <div className="app">
      <Sidebar activePage={activePage} onNavigate={setActivePage} />
      <main className="content">{renderPage()}</main>
    </div>
  )
```

**Después:**

```tsx
  return (
    <div className="app">
      <AppTopBar activePage={activePage} />
      <AppDock activePage={activePage} onNavigate={setActivePage} />
      <main className="content">{renderPage()}</main>
    </div>
  )
```

### 10.3 Por qué el dock va antes de `<main>`

El dock es `position: fixed`, así que su orden visual no cambia. Pero el orden del DOM sí afecta a la navegación con teclado y a los lectores de pantalla:

1. `banner` (barra superior).
2. `navigation` (dock).
3. `main` (contenido).

Así el usuario puede tabular a la navegación antes de recorrer toda la página, igual que con el sidebar anterior.

### 10.4 Lo que NO cambia

- `useState<PageId>('dashboard')`
- `renderPage()`
- `useLocalStorageState`
- `useTheme`
- `handleResetAll`
- Las props de `Dashboard`, `BotConfig`, `BotRun`, `Backtest`, `Stats`, `Settings`.

---

## 11. Paso 8 — `src/index.css` (tokens)

**Documento:** `src/index.css`  
**Acción:** inserta dos bloques. No borres tokens existentes.  
**Sección:** dentro del primer `:root` y dentro de `:root[data-theme='light']`.

### 11.1 Tokens del tema oscuro

**Punto exacto:** al final del primer `:root`, después de `--warning: #f59e0b;` (línea 34 actual), antes de la llave de cierre.

```css
  /* Dock de navegación */
  --dock-tile: clamp(42px, 11vw, 48px);
  --dock-gap: 4px;
  --dock-pad: 6px;
  --dock-indicator-lane: 4px;
  --dock-height: calc(
    var(--dock-tile) + (var(--dock-pad) * 2) + var(--dock-indicator-lane) + 2px
  );
  --shadow-dock:
    0 18px 44px rgba(0, 0, 0, 0.5),
    0 2px 8px rgba(0, 0, 0, 0.35);
```

### 11.2 Sombra del tema claro

**Punto exacto:** dentro de `:root[data-theme='light']`, después del último `--warning` (el archivo tiene dos; usa el que está antes de la llave de cierre, línea 69 actual).

```css
  --shadow-dock:
    0 18px 44px rgba(20, 32, 24, 0.18),
    0 2px 8px rgba(20, 32, 24, 0.1);
```

### 11.3 Por qué estos tokens

- `--dock-tile` es el único valor que decide el tamaño de las teclas. `clamp` mantiene 42 px en pantallas de 320 px y 48 px en escritorio.
- `--dock-gap` y `--dock-pad` alimentan tanto el layout como la fórmula de la gota.
- `--dock-indicator-lane` reserva el carril del subrayado sin que el dock crezca de más.
- `--dock-height` se usa en `App.css` para que el contenido nunca quede debajo del dock.
- `--shadow-dock` cambia entre temas; la sombra clara es más suave.

> **No dupliques `--font-ui`.** Ya existe en ambos temas. Si tu archivo no lo tiene, agrégalo una sola vez en el primer `:root`; no es parte de este cambio.

---

## 12. Paso 9 — `src/App.css`

**Documento:** `src/App.css`  
**Acción:** reemplaza la regla `.app` y elimina el bloque media query que colapsaba las columnas.  
**Sección:** líneas 1–6 y 102–106 actuales.

### 12.1 Reemplazo de `.app`

**Antes:**

```css
/* Estructura general: menú a la izquierda, contenido a la derecha */
.app {
  display: grid;
  grid-template-columns: 240px 1fr;
  min-height: 100vh;
}
```

**Después:**

```css
/* Estructura general: barra superior + contenido + dock inferior. */
.app {
  min-height: 100vh;
  padding-bottom: calc(
    var(--dock-height) + 24px + env(safe-area-inset-bottom, 0px)
  );
}
```

### 12.2 Eliminar el media query de columnas

**Borra este bloque completo** (líneas 102–106 actuales):

```css
@media (max-width: 720px) {
  .app {
    grid-template-columns: 1fr;
  }
}
```

Ya no hay dos columnas que colapsar. Si lo dejas, `grid-template-columns` no tiene efecto porque `.app` ya no es grid, pero es código muerto y confunde.

### 12.3 Por qué el padding inferior

El dock mide entre 60 y 66 px y está a 10 px del borde. El padding de `.app` reserva:

```text
altura del dock + 24 px de aire + safe-area inferior
```

Así el último contenido de una página larga nunca queda tapado. En 320 px el padding es 84 px; en escritorio, 90 px.

### 12.4 Lo que NO se toca

- `.content`
- `.page`
- `.page__header`
- `.badge`
- `.card`
- `.segmented`
- `.mobile-header` (estilos viejos sin uso)
- Los media queries de otras páginas.

> **Nota fuera de alcance:** este archivo todavía tiene reglas duplicadas de `.segmented__option` al final. No forman parte de este cambio; si el selector de tema sigue raro, es el problema documentado aparte.

---

## 13. Paso 10 — `index.html`

**Documento:** `index.html`  
**Acción:** reemplaza la meta viewport.  
**Sección:** línea 21 actual.

**Antes:**

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
```

**Después:**

```html
<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0, viewport-fit=cover"
/>
```

### 13.1 Por qué `viewport-fit=cover`

Sin esa opción, `env(safe-area-inset-bottom)` devuelve `0` en iPhone con notch y el dock puede quedar debajo del indicador de inicio. Con `viewport-fit=cover`, el navegador expone los insets y el dock se separa lo necesario.

> **Opcional recomendado:** el documento tiene `<html lang="en">` y la interfaz está en español. Cambiarlo a `<html lang="es">` mejora la pronunciación de lectores de pantalla. No es obligatorio para el dock, pero es una mejora de una línea.

---

## 14. Cómo queda la arquitectura

### 14.1 Flujo de datos

```text
src/navItems.ts
├── navItems
│   ├── primaryNavIds ──► primaryNavItems ──► AppDock (teclas)
│   └── overflowNavItems ────────────────────► AppDock (menú Más)
├── getNavLabel(activePage) ─────────────────► AppTopBar (título)
└── PageId ──────────────────────────────────► DockIcon (mapa completo)

App.tsx
├── activePage (estado existente)
├── AppTopBar(activePage)
├── AppDock(activePage, onNavigate)
└── main (renderPage)
```

### 14.2 Por qué es modular

| Pieza | Cambia sin tocar... |
|---|---|
| `navItems.ts` | Ni el dock ni la barra superior. |
| `DockIcon.tsx` | Ni la navegación ni el CSS. |
| `AppDock.tsx` | Ni la barra superior ni las páginas. |
| `AppDock.css` | Ni la lógica de React. |
| `AppTopBar.tsx` | Ni el dock ni las páginas. |
| `index.css` | Los tokens se reutilizan en toda la app. |

### 14.3 Añadir una página nueva

1. Añade el id a `PageId` en `src/types.ts`.
2. Añade `{ id, label, icon }` a `navItems` en `src/navItems.ts`.
3. Si debe ir en el dock, añade el id a `primaryNavIds`; si no, aparecerá automáticamente en «Más».
4. Añade su icono al mapa `paths` de `DockIcon.tsx`. TypeScript te obliga.
5. Añade el `case` en `renderPage()` de `App.tsx`.

### 14.4 Cambiar el orden

- **Orden del dock:** reordena `primaryNavIds`.
- **Orden del menú «Más»:** reordena `navItems`.
- **Orden del sidebar (rollback):** reordena `navItems`.

### 14.5 Límite de teclas

La fórmula y el diseño asumen **6 teclas máximo** (5 primarias + Más). A 320 px:

```text
6 × 42 px + 5 × 4 px + 2 × 6 px + 2 px de borde = 286 px
```

Quedan 34 px de margen. Con 7 teclas harían falta 332 px y aparecería scroll o recorte. Si necesitas más accesos, usa el menú «Más» o reduce el mínimo de `--dock-tile` a 38 px y prueba en 320 px.

---

## 15. Estados, animación y accesibilidad

### 15.1 Estados visuales

| Estado | Qué se ve |
|---|---|
| Reposo | Icono en `--text-muted`, fondo transparente. |
| Hover | Fondo `--surface-hover`, icono `--text`, sube 2 px. |
| Foco visible | Outline de 2 px en `--text`, offset 2 px. |
| Presionado | Escala a 0.94 durante 160 ms. |
| Activo | Gota `--text`, icono `--bg`, subrayado `--text`. |
| Más abierto | Fondo `--surface-hover` si no está activo; tooltip oculto. |
| Overflow activo | La gota se coloca sobre Más; `aria-current="page"` en Más. |
| Movimiento reducido | Sin transición de gota, hover ni animación de menú. |

### 15.2 Tiempos

| Elemento | Duración | Curva |
|---|---|---|
| Gota | 420 ms | `cubic-bezier(0.22, 1, 0.36, 1)` |
| Color / hover | 160 ms | `ease` |
| Tooltip | 140 ms | `ease` |
| Menú | 160 ms | `cubic-bezier(0.22, 1, 0.36, 1)` |

La curva de la gota tiene un arranque rápido y un frenado suave; se siente “líquida” sin necesidad de WebGL.

### 15.3 Accesibilidad

- **Landmark:** `<nav aria-label="Navegación principal">`.
- **Cada tecla:** `<button type="button" aria-label={item.label}>`.
- **Página actual:** `aria-current="page"` en la tecla activa o en Más si la página vive en el overflow.
- **Más:** `aria-expanded`, `aria-controls`, `aria-label="Más opciones"`.
- **Menú:** `role="group"` con `aria-label="Más opciones"`; no se usa `role="menu"` para no prometer navegación con flechas.
- **Escape:** cierra el menú y devuelve el foco a Más.
- **Clic fuera:** cierra el menú.
- **Foco:** `:focus-visible` con outline visible en teclas y opciones.
- **Tooltips:** son decorativos (`aria-hidden="true"`); el nombre accesible está en el botón.
- **Área táctil:** 42–48 px, por encima del mínimo de 24 px de WCAG 2.5.8.
- **Movimiento:** `prefers-reduced-motion` desactiva las transiciones.
- **Contraste:** la inversión `--text`/`--bg` da un contraste alto en ambos temas.

> **Lectores de pantalla:** al cambiar de página, `AppTopBar` anuncia el nuevo título con `aria-live="polite"`. El foco se queda en la tecla pulsada, que sigue montada; es el comportamiento esperado de una barra de navegación.

---

## 16. Verificación

### 16.1 Comandos

```bash
pnpm dev
```

Abre la app y revisa los puntos de la sección 16.2.

```bash
pnpm test
```

Si hay tests existentes, deben seguir pasando. El dock no toca lógica de negocio.

```bash
pnpm exec tsc -p tsconfig.app.json --noEmit --pretty false
```

Al momento de escribir esta guía, este comando sigue mostrando errores preexistentes en `src/backtest.ts` (líneas 277 y 414). Lo importante es que **no aparezca ninguna ruta** de:

- `src/components/navigation/`
- `src/navItems.ts`
- `src/App.tsx`

```bash
pnpm build
```

Seguirá fallando hasta que se corrijan los errores de `backtest.ts`. No es un fallo del dock.

> **Nota sobre `pnpm lint`:** en este entorno, `eslint` falla antes de analizar el código porque `typescript-eslint@8.72` no soporta TypeScript 7.0. Es un problema preexistente de toolchain, no del dock. Si tu entorno ya lo tiene resuelto, ejecuta `pnpm lint` y confirma que no hay errores nuevos en `src/components/navigation/`.

### 16.2 Checklist manual

**Geometría**

- [ ] En 320 × 700, las 6 teclas caben sin scroll horizontal.
- [ ] El dock no tapa el último contenido de una página larga.
- [ ] En 1440 × 900, el dock está centrado y el contenido sigue centrado a 960 px.
- [ ] En 375 × 812 y 768 × 1024, el dock mantiene 6 teclas y no se sale.
- [ ] Con zoom al 200 %, no hay solapamientos ni scroll horizontal.

**Navegación**

- [ ] Panel, Ajustar bot, Ejecutar bot, Backtest y Estadísticas cambian de página.
- [ ] La gota se desliza a la tecla correcta, incluyendo saltos largos.
- [ ] El subrayado queda debajo de la tecla activa.
- [ ] Ajustes está dentro de Más; al abrirlo, se ve “Ajustes”.
- [ ] Al elegir Ajustes, la gota se coloca sobre Más y el título dice “Ajustes”.
- [ ] Más se cierra al hacer clic fuera.
- [ ] Escape cierra Más y devuelve el foco a Más.
- [ ] Al cambiar de página con el menú, el foco vuelve a Más.

**Barra superior**

- [ ] LIXTRD aparece a la izquierda.
- [ ] El título de la página aparece a la derecha y cambia al navegar.
- [ ] En móvil, la barra no tapa el contenido y respeta el notch.
- [ ] El título largo se trunca con puntos suspensivos, sin romper el layout.

**Temas**

- [ ] Tema oscuro: gota clara, icono oscuro, subrayado claro.
- [ ] Tema claro: gota oscura, icono claro, subrayado oscuro.
- [ ] Tema sistema: sigue la preferencia del sistema.
- [ ] El cambio de tema no deja colores fijos ni parpadeos.

**Accesibilidad**

- [ ] Tab recorre las teclas en orden y muestra el outline.
- [ ] Enter y Espacio activan la tecla enfocada.
- [ ] `aria-current="page"` está en la tecla correcta.
- [ ] Un lector de pantalla anuncia “Navegación principal” y los nombres de las teclas.
- [ ] Con `prefers-reduced-motion: reduce`, no hay deslizamiento ni animación de menú.
- [ ] Con `forced-colors: active`, el estado activo sigue siendo distinguible.

**Regresión**

- [ ] `Sidebar.tsx` y `Sidebar.css` siguen existiendo.
- [ ] No hay errores nuevos en la consola del navegador.
- [ ] No se instaló ningún paquete nuevo.
- [ ] `package.json` y `pnpm-lock.yaml` no cambiaron.

---

## 17. Rollback

### 17.1 Rollback mínimo (recomendado)

1. En `src/App.tsx`, vuelve a poner el import:

   ```tsx
   import Sidebar from './components/Sidebar'
   ```

2. En el JSX, vuelve a:

   ```tsx
   <div className="app">
     <Sidebar activePage={activePage} onNavigate={setActivePage} />
     <main className="content">{renderPage()}</main>
   </div>
   ```

3. En `src/App.css`, restaura:

   ```css
   .app {
     display: grid;
     grid-template-columns: 240px 1fr;
     min-height: 100vh;
   }
   ```

4. Vuelve a añadir el media query si lo tenías:

   ```css
   @media (max-width: 720px) {
     .app {
       grid-template-columns: 1fr;
     }
   }
   ```

Los archivos nuevos pueden quedarse sin usar; no afectan. Los tokens de `index.css` y el viewport tampoco rompen el sidebar.

### 17.2 Rollback completo

- Elimina `src/components/navigation/`.
- Quita los tokens `--dock-*` y `--shadow-dock`.
- Deja el viewport como estaba (opcional).
- Restaura `navItems.ts` si quieres volver a la versión de 16 líneas. No es necesario: los exports extra no molestan al sidebar.

> **Nunca** hagas `git reset --hard` para “volver atrás” si tienes cambios sin commitear. Usa los pasos manuales o un commit de checkpoint.

---

## 18. Alternativas

Las alternativas están ordenadas de menor a mayor esfuerzo. Todas se pueden aplicar sin rehacer la arquitectura.

### 18.1 Seis teclas sin menú «Más»

**Cuándo:** quieres Ajustes siempre visible y no te importa renunciar al overflow.

**Cómo:** añade `'settings'` a `primaryNavIds`.

```ts
export const primaryNavIds: readonly PageId[] = [
  'dashboard',
  'bot-config',
  'bot-run',
  'backtest',
  'stats',
  'settings',
]
```

`overflowNavItems` queda vacío y `AppDock` oculta Más automáticamente. El dock sigue midiendo 6 teclas; no cambia el ancho.

**Ventaja:** un clic menos para Ajustes.  
**Costo:** pierdes el patrón “5 + Más” y el menú de overflow para futuras páginas.

### 18.2 Barra inferior a todo el ancho

**Cuándo:** prefieres una barra tipo app móvil, no un dock flotante.

**Cómo:** añade este override después de `AppDock.css` o al final del mismo archivo.

```css
.app-dock {
  right: 0;
  left: 0;
  bottom: 0;
  display: flex;
  justify-content: center;
  width: 100%;
  padding-bottom: calc(var(--dock-pad) + env(safe-area-inset-bottom, 0px));
  border-right: 0;
  border-bottom: 0;
  border-left: 0;
  border-radius: 0;
  transform: none;
}
```

> **No cambies `justify-content` de `.app-dock__track`.** La gota calcula su posición desde la primera tecla; si el track tiene espacio inicial, la gota se desalinea. El centrado se hace en el contenedor `.app-dock`, no en el track.

**Ventaja:** más área táctil y look de app nativa.  
**Costo:** ocupa todo el ancho y se siente menos “dock”; el subrayado sigue funcionando.

### 18.3 Dock arriba, debajo de la barra superior

**Cuándo:** quieres la navegación siempre arriba y no te importa el pulgar.

**Cómo:**

```css
.app-dock {
  position: sticky;
  top: calc(38px + env(safe-area-inset-top, 0px));
  bottom: auto;
  left: auto;
  width: fit-content;
  margin: 8px auto 0;
  transform: none;
}

.app-dock__menu {
  top: calc(100% + 12px);
  bottom: auto;
  transform-origin: top right;
}

.app {
  padding-bottom: 0;
}
```

El dock pasa al flujo normal, se centra con `margin` y se queda pegado debajo de la barra superior. El menú se abre hacia abajo para no chocar con la barra.

**Ventaja:** no compite con el pulgar ni con el home indicator.  
**Costo:** vuelve a estar lejos en móvil, compite con la barra superior y el menú tapa contenido hacia abajo.

### 18.4 Estado activo estático (sin gota deslizante)

**Cuándo:** quieres la máxima simplicidad o menos movimiento.

**Cómo:** oculta la gota y pinta la tecla activa directamente.

```css
.app-dock__drop {
  display: none;
}

.app-dock__key--active,
.app-dock__key--active:hover {
  background: var(--text);
  color: var(--bg);
  transform: none;
}
```

**Ventaja:** cero transiciones y menos capas.  
**Costo:** pierdes la sensación de “dock”; el ojo tiene que buscar el cuadrado activo.

### 18.5 Tecla activa elevada sin inversión total

**Cuándo:** el cuadrado claro/oscuro te parece demasiado fuerte.

**Cómo:**

```css
.app-dock__drop {
  background: var(--surface-raised-hover);
  border: 1px solid var(--border-strong);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.22);
}

.app-dock__key--active,
.app-dock__key--active:hover {
  color: var(--text);
}

.app-dock__drop::after {
  background: var(--accent);
}
```

**Ventaja:** más sutil y más “superficie elevada”.  
**Costo:** menos contraste y el acento deja de ser monocromático.

### 18.6 Sidebar en escritorio + dock en móvil

**Cuándo:** quieres conservar la navegación lateral en pantallas grandes.

**Cómo:** renderiza ambos y controla con CSS.

```tsx
<div className="app">
  <AppTopBar activePage={activePage} />
  <Sidebar activePage={activePage} onNavigate={setActivePage} />
  <AppDock activePage={activePage} onNavigate={setActivePage} />
  <main className="content">{renderPage()}</main>
</div>
```

```css
/* El sidebar solo existe en escritorio. */
@media (max-width: 1023px) {
  .sidebar {
    display: none;
  }
}

/* El dock solo existe en móvil/tablet. */
@media (min-width: 1024px) {
  .app-dock {
    display: none;
  }
}

/* El layout vuelve a dos columnas en escritorio. */
@media (min-width: 1024px) {
  .app {
    display: grid;
    grid-template-columns: 240px 1fr;
    grid-template-rows: auto 1fr;
    padding-bottom: 0;
  }

  .app-topbar {
    grid-column: 1 / -1;
  }

  .sidebar {
    top: 38px;
    grid-column: 1;
    grid-row: 2;
    height: calc(100vh - 38px);
  }

  .content {
    grid-column: 2;
    grid-row: 2;
  }
}
```

**Ventaja:** conserva la densidad del sidebar en desktop.  
**Costo:** vuelven dos navegaciones que mantener y el `AppTopBar` puede sobrar en desktop. No es la opción recomendada si el objetivo es reemplazar el sidebar por completo.

### 18.7 Menú «Más» ancho en móvil

**Cuándo:** el menú de 180 px se siente pequeño en móvil.

**Cómo:**

```css
@media (max-width: 480px) {
  .app-dock__menu {
    right: 0;
    width: calc(100vw - 46px);
    max-width: 320px;
    min-width: 0;
    border-radius: 14px;
  }
}
```

El menú sigue anclado a Más y se abre hacia arriba; solo ocupa más ancho. No lo conviertas en `position: fixed` dentro del dock: `backdrop-filter` crea un containing block y el menú dejaría de posicionarse respecto al viewport.

**Ventaja:** más cómodo de tocar y de leer.  
**Costo:** más superficie y una animación que puede sentirse más pesada.

### 18.8 Etiquetas debajo de los iconos

**Cuándo:** los iconos solos no son suficientes para nuevos usuarios.

**Cómo:** aumenta la tecla y añade la etiqueta visible. Requiere cambiar el JSX de `AppDock` para renderizar `item.label` fuera del tooltip y ajustar CSS.

**Ventaja:** autodescubrimiento.  
**Costo:** el dock crece a ~64–72 px de alto y se aleja del look macOS compacto.

### 18.9 Ocultar el `h1` de las páginas en móvil

**Cuándo:** te molesta que la barra superior diga “BACKTEST” y el `h1` diga “Backtest” justo debajo.

**Cómo:**

```css
@media (max-width: 720px) {
  .page__header h1 {
    display: none;
  }

  .page__header {
    margin-bottom: 20px;
  }
}
```

**Ventaja:** elimina la duplicación y gana altura.  
**Costo:** pierdes el título grande de la página; la barra superior pasa a ser la única referencia. No lo apliques si tus páginas necesitan el `h1` para jerarquía visual.

### 18.10 Marca LIXTRD como botón de inicio

**Cuándo:** quieres que la marca vuelva al Panel.

**Cómo:** cambia `AppTopBar` para recibir `onNavigate` y usa un `<button>`.

```tsx
type AppTopBarProps = {
  activePage: PageId
  onNavigate: (page: PageId) => void
}
```

```tsx
<button
  type="button"
  className="app-topbar__brand"
  onClick={() => onNavigate('dashboard')}
>
  LIXTRD
</button>
```

Y en `App.tsx`, pásale el callback:

```tsx
<AppTopBar activePage={activePage} onNavigate={setActivePage} />
```

Añade al CSS:

```css
.app-topbar__brand {
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
```

**Ventaja:** un atajo más al inicio.  
**Costo:** la marca deja de ser solo identidad y se mezcla con navegación.

### 18.11 Iconos de un paquete (`lucide-react`)

**Cuándo:** prefieres no mantener SVG a mano.

**Cómo:** instala `lucide-react` con `pnpm add lucide-react` y sustituye el contenido de `DockIcon.tsx` por un mapa de componentes de Lucide.

**Ventaja:** catálogo grande y consistente.  
**Costo:** dependencia nueva, un estilo menos propio y un bundle algo mayor. Para 7 iconos, el SVG inline sigue siendo más barato.

### 18.12 Nimbus WebGL Liquid Navbar

**Cuándo:** quieres la gota líquida real, con shader, ondas y gotitas.

**Qué tomaríamos de Nimbus:** la idea de una pieza que se estira hacia el destino y la caída suave.  
**Qué no implementamos por defecto:** el shader WebGL, las gotitas, el audio, el menisco del cursor y los casts a `any`.

**Por qué no es la opción por defecto en FLARE:**

- Un shader WebGL continuo compite con los gráficos de trading y con la batería en móvil.
- Requiere un componente adicional, limpieza de contexto, fallback sin WebGL y pruebas en Safari/iOS.
- El código de referencia usa colores fijos y tipos laxos; habría que reescribirlo con tokens y sin `any`.
- El proyecto tiene reglas estrictas de hooks y TypeScript; una integración apresurada rompería el build.

Si algún día lo quieres, hazlo como capa opcional:

1. Crea `LiquidLayer.tsx` separado.
2. Cárgalo con `lazy`/`Suspense` solo si el usuario lo activa.
3. Respeta `prefers-reduced-motion` y ofrece el fallback CSS actual.
4. No reproduzcas audio por defecto.
5. Usa `--text`/`--bg` como entrada de color, no hex fijos.
6. Mantén la navegación y la accesibilidad fuera del canvas.

**Ventaja:** el efecto “wow”.  
**Costo:** complejidad, rendimiento y mantenimiento. Para un panel de trading, la animación CSS actual es la relación calidad/riesgo correcta.

### 18.13 Dock con auto-ocultado o arrastrable

**Cuándo:** quieres máximo espacio de contenido.

**Cómo:** requiere estado de scroll o puntero y, probablemente, `IntersectionObserver`/`pointermove`. No es CSS puro.

**Ventaja:** más área útil.  
**Costo:** comportamiento impredecible, más código y más pruebas. No lo recomiendo para esta fase.

---

## 19. Referencias y decisiones descartadas

### 19.1 Nimbus UI · Liquid Navbar

Referencia conceptual: una píldora de agua con una gota activa que se estira, gotitas en saltos largos y ondas al tocar.

**Adoptado:** la idea de una pieza que se mueve entre teclas y una curva de frenado suave.  
**Descartado:** WebGL, shader, audio, gotitas, menisco del cursor, dependencia de un solo archivo y casts a `any`.

La implementación de FLARE es una “gota” CSS: un cuadrado redondeado que se traslada con `transform`. No pretende ser una simulación de fluido; pretende ser rápida, legible y mantenible.

### 19.2 Toolbar Dock

Referencia conceptual: píldora flotante de iconos, tooltips y un botón para colapsar.

**Adoptado:** teclas cuadradas icon-only, tooltip por tecla, contenedor flotante y compacto.  
**Descartado:** el botón de colapsar. Con 5 accesos + Más no hace falta; añadirlo duplicaría estados y complejidad.  
**Descartado:** la dependencia de Motion y el set de Hugeicons. La animación CSS y los SVG inline cubren el caso sin paquetes.

### 19.3 macOS Dock

**Adoptado:** cuadrados perfectos, activo elevado, subrayado, glass y deslizamiento.  
**Descartado:** la magnificación al hover. Es costosa en móvil, requiere medir posiciones y no aporta claridad en una app de datos.

### 19.4 Lo que se descartó para esta fase

| Idea | Motivo |
|---|---|
| 6 teclas sin Más | Válida, pero el usuario pidió 5 + Más y Ajustes en overflow. |
| Sidebar solo en desktop | Contradice “reemplazar el sidebar completamente”. |
| Iconos emoji | Rompen el monocromo y cambian según el sistema. |
| `lucide-react` | Dependencia innecesaria para 7 iconos. |
| Gota medida con JS | Choca con `react-hooks/set-state-in-effect` y añade complejidad. |
| `--negative` en el subrayado | Semántica de pérdida en FLARE. |
| WebGL por defecto | Riesgo de rendimiento y mantenimiento. |

---

## 20. Personalización rápida

### 20.1 Cambiar tamaño y separación

Edita en `src/index.css`:

```css
--dock-tile: clamp(42px, 11vw, 48px);
--dock-gap: 4px;
--dock-pad: 6px;
--dock-indicator-lane: 4px;
```

La gota y el padding de `.app` se recalculan solos.

### 20.2 Cambiar el color activo

En `AppDock.css`:

```css
.app-dock__drop {
  background: var(--accent);
}

.app-dock__key--active,
.app-dock__key--active:hover {
  color: var(--on-primary);
}

.app-dock__drop::after {
  background: var(--accent);
}
```

Comprueba el contraste de `--on-primary` sobre `--accent` en ambos temas.

### 20.3 Cambiar el subrayado

```css
.app-dock__drop::after {
  width: 16px;
  height: 3px;
  background: var(--text);
}
```

### 20.4 Cambiar la velocidad

```css
.app-dock__drop {
  transition: transform 300ms cubic-bezier(0.22, 1, 0.36, 1);
}
```

### 20.5 Cambiar el radio de las teclas

```css
.app-dock__key,
.app-dock__drop {
  border-radius: 8px;
}
```

Para cuadrados perfectos sin redondeo, usa `0`. Para un look más iOS, usa `12–14px`.

### 20.6 Cambiar la posición vertical

```css
.app-dock {
  bottom: calc(16px + env(safe-area-inset-bottom, 0px));
}
```

Si aumentas mucho, actualiza también el padding de `.app` si quieres más aire.

### 20.7 Cambiar la marca

En `AppTopBar.tsx`:

```tsx
<span className="app-topbar__brand">LIXTRD</span>
```

Puedes cambiarla por `FLARE` o por un logo SVG. Mantén el `aria-label` si es un enlace o botón.

### 20.8 Añadir un punto de notificación

Envuelve el icono en un contenedor con un `span` absoluto. No lo incluyo por defecto porque añade estado y no forma parte del requisito. Si lo necesitas, el lugar natural es `AppDock.tsx`, dentro de la tecla, y el estilo en `AppDock.css` con `position: absolute`.

---

## 21. Resumen de archivos y orden de aplicación

| Orden | Archivo | Acción |
|---|---|---|
| 1 | `src/navItems.ts` | Reemplazar completo. |
| 2 | `src/components/navigation/DockIcon.tsx` | Crear. |
| 3 | `src/components/navigation/AppDock.tsx` | Crear. |
| 4 | `src/components/navigation/AppDock.css` | Crear. |
| 5 | `src/components/navigation/AppTopBar.tsx` | Crear. |
| 6 | `src/components/navigation/AppTopBar.css` | Crear. |
| 7 | `src/App.tsx` | 2 reemplazos. |
| 8 | `src/index.css` | 2 inserciones. |
| 9 | `src/App.css` | 1 reemplazo + 1 borrado. |
| 10 | `index.html` | 1 reemplazo. |

### 21.1 Commit sugerido

```bash
git add src/navItems.ts src/App.tsx src/App.css src/index.css index.html src/components/navigation
git commit -m "feat(nav): replace sidebar with compact dock and top bar"
```

### 21.2 Si algo falla

1. Revisa que `src/components/navigation/` exista y que los cinco archivos estén ahí.
2. Revisa que `AppDock.css` y `AppTopBar.css` se importen desde sus `.tsx`.
3. Revisa que los tokens `--dock-*` estén en `src/index.css`.
4. Revisa que `App.tsx` no siga importando `Sidebar`.
5. Abre la consola del navegador: no debe haber errores de módulos no encontrados.
6. Si el dock aparece sin estilos, el problema suele ser la ruta del CSS o que `App.css` se aplicó antes que los tokens.

---

## 22. Cierre

Esta guía deja el sidebar **intacto como red de seguridad**, pero fuera de la aplicación. El dock y la barra superior son componentes independientes, sin dependencias nuevas, con tokens de tema y con una sola fuente de verdad para las etiquetas y el orden.

Si quieres, después de aplicar la guía puedo:

- aplicarla en una rama o worktree y verificar el build,
- ajustar los iconos a un set propio,
- convertir el menú «Más» en una hoja inferior real (requiere un portal a `document.body` para escapar del `backdrop-filter` del dock),
- o preparar la variante Nimbus WebGL como capa opcional.

No he modificado `src/` en el proyecto real; este documento es el plan completo.
