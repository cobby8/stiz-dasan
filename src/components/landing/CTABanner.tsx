import Link from "next/link";
interface CTABannerProps { title?: string; subtitle?: string; phone?: string; primaryLabel?: string; primaryHref?: string; secondaryLabel?: string; showSecondary?: boolean }

/** 페이지마다 반복되는 문의 영역은 짧은 안내와 실제 동작만 표시합니다. */
export default function CTABanner({ title = "우리 아이에게 맞는 수업을 만나보세요", subtitle = "수업과 시간대를 확인하고 체험을 신청하세요.", phone = "", primaryLabel = "체험 수업 신청", primaryHref = "/apply/trial", secondaryLabel = "전화 상담", showSecondary = true }: CTABannerProps) {
  return <section className="public-contact-banner"><div className="public-container public-contact-banner-inner">
    <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
    <div className="public-contact-banner-actions"><Link href={primaryHref} className="public-button">{primaryLabel}</Link>{showSecondary && /^0[\d-]{8,13}$/.test(phone) && phone !== "010-0000-0000" && <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className="public-button-secondary">{secondaryLabel} {phone}</a>}</div>
  </div></section>;
}
