type BgColor = "white" | "section" | "warm";
interface SectionLayoutProps { id?: string; label?: string; title?: string; description?: string; bgColor?: BgColor; children: React.ReactNode; className?: string }

/** 제목과 본문 간격을 통일하고 짧은 내용에도 큰 여백이 생기지 않게 합니다. */
export default function SectionLayout({ id, title, description, bgColor = "white", children, className = "" }: SectionLayoutProps) {
  return <section id={id} className={`public-section ${bgColor !== "white" ? "public-section--soft" : ""} ${className}`}>
    <div className="public-container">
      {(title || description) && <div className="public-section-heading">{title && <h2>{title}</h2>}{description && <p>{description}</p>}</div>}
      {children}
    </div>
  </section>;
}
