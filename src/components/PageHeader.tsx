type PageHeaderProps = {
  title: string
  subtitle: string
  badge?: string
}

function PageHeader({ title, subtitle, badge }: PageHeaderProps) {
  return (
    <header className="page__header">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {badge && <span className="badge">{badge}</span>}
    </header>
  )
}

export default PageHeader
