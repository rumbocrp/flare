import './Sidebar.css'
import type { PageId } from '../types'
import { navItems } from '../navItems'

const BRAND = 'LIXTRD'

type SidebarProps = {
  activePage: PageId
  onNavigate: (page: PageId) => void
}

function Sidebar({ activePage, onNavigate }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">{BRAND}</div>

      <nav className="sidebar__nav">
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`sidebar__link ${
              activePage === item.id ? 'sidebar__link--active' : ''
            }`}
            aria-current={activePage === item.id ? 'page' : undefined}
            onClick={() => onNavigate(item.id)}
          >
            <span className="sidebar__icon" aria-hidden="true">
              {item.icon}
            </span>
            {item.label}
          </button>
        ))}
      </nav>

      <div className="sidebar__footer">Modo simulación</div>
    </aside>
  )
}

export default Sidebar
