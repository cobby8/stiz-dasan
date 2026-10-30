import Link from "next/link";
import "./public-home.css";
// variant: "outline" = 게슈탈트 점검 모양(두 번째 버튼 테두리·제목 22px). 기본 "classic" 은 옛 모양 — /programs 가 그대로 쓴다.
interface CTABannerProps { title?: string; subtitle?: string; phone?: string; primaryLabel?: string; primaryHref?: string; secondaryLabel?: string; showSecondary?: boolean; variant?: "classic" | "outline" }
export default function CTABanner({
  title = "우리 아이, 농구로 성장시켜 보세요", subtitle = "아이에게 딱 맞는 클래스를 찾아드립니다. 지금 바로 문의해 주세요.",
  phone = "010-0000-0000", primaryLabel = "체험 수업 신청", primaryHref = "/apply", secondaryLabel = "전화 상담", showSecondary = true, variant = "classic",
}: CTABannerProps) {
  return <section className={variant === "outline" ? "public-cta public-cta--outline" : "public-cta"}><div className="public-cta__inner">
    <div className="public-cta__content"><h2>{title}</h2><p>{subtitle}</p></div>
    <div className="public-cta__actions"><Link href={primaryHref}>{primaryLabel} <span aria-hidden="true">↗</span></Link>
      {showSecondary && <a href={`tel:${phone.replace(/-/g, "")}`}>{secondaryLabel} {phone}</a>}
    </div>
  </div></section>;
}
