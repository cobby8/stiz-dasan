/**
 * PublicFooter — 통합 공개 페이지 푸터 (Phase 1)
 *
 * 메인 랜딩과 서브페이지 양쪽에서 사용하던 푸터를 하나로 통합.
 * Server Component 가능 — 상태/이벤트가 없으므로 'use client' 불필요.
 *
 * props로 settings 데이터(phone, address, footer 문구, 소셜 링크)를 부모에서 받아온다.
 */

import Link from "next/link";
import Image from "next/image";


// 부모에서 전달받을 props 타입
interface PublicFooterProps {
  phone: string;
  address: string;
  operatingHours?: string;
  footerDescription?: string;
  footerCopyright?: string;
  instagramUrl?: string;
  youtubeUrl?: string;
  naverPlaceUrl?: string;
  kakaoChannelUrl?: string;
}

// 퀵 링크 목록 — 헤더 메뉴와 동일하게 7개 전부 포함
const QUICK_LINKS = [
  { href: "/about", label: "학원 소개" },
  { href: "/programs", label: "프로그램안내" },
  { href: "/schedule", label: "수업시간표" },
  { href: "/annual", label: "연간일정표" },
  { href: "/gallery", label: "포토갤러리" },
  { href: "/notices", label: "공지사항" },
  { href: "/shop", label: "SHOP" },
  { href: "/apply", label: "체험/수강신청" },
];

const DEFAULT_OPERATING_HOURS = "평일 13:00~21:00 / 토 09:00~18:00 (일요일·공휴일 휴무)";
const DEFAULT_FOOTER_DESCRIPTION = "아이들이 농구를 통해 협동심과\n건강한 체력을 기를 수 있도록 지도합니다.";
const DEFAULT_FOOTER_COPYRIGHT = "© 2026 STIZ Basketball Academy. All rights reserved.";

/** 사업자등록증(2024-12-20 구리세무서 발급) 기재 사항. 바뀌면 등록증을 보고 함께 고친다. */
const BUSINESS_INFO = {
  name: "스티즈농구교실 다산2호점",
  owner: "권혜미",
  registrationNumber: "650-96-02048",
  address: "경기도 남양주시 다산중앙로20번길 10-32, 1층 1호(다산동)",
  phone: "070-8824-5712",
} as const;

function normalizeExternalUrl(url?: string) {
  const raw = url?.trim();
  const iframeSrc = raw?.match(/src=["']([^"']+)["']/i)?.[1];
  const firstUrl = raw?.match(/https?:\/\/[^\s"'>]+/i)?.[0];
  const trimmed = iframeSrc || firstUrl || raw;
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("<")) return "";
  return `https://${trimmed}`;
}

function normalizeInstagramUrl(url?: string) {
  const trimmed = url?.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("@")) {
    return `https://www.instagram.com/${trimmed.slice(1)}`;
  }
  return normalizeExternalUrl(trimmed);
}

export default function PublicFooter({
  phone,
  operatingHours,
  footerDescription,
  footerCopyright,
  instagramUrl,
  youtubeUrl,
  naverPlaceUrl,
  kakaoChannelUrl,
}: PublicFooterProps) {
  const displayOperatingHours = operatingHours?.trim() || DEFAULT_OPERATING_HOURS;
  const displayPhone = phone && phone !== "010-0000-0000" && /^0[\d-]+$/.test(phone) ? phone : BUSINESS_INFO.phone;
  const displayFooterDescription = footerDescription?.trim() || DEFAULT_FOOTER_DESCRIPTION;
  const displayFooterCopyright = footerCopyright?.trim() || DEFAULT_FOOTER_COPYRIGHT;
  const footerDescriptionLines = displayFooterDescription.split("\n");
  const socialLinks = [
    { label: "Instagram", href: normalizeInstagramUrl(instagramUrl) },
    { label: "YouTube", href: normalizeExternalUrl(youtubeUrl) },
    { label: "네이버 플레이스", href: normalizeExternalUrl(naverPlaceUrl) },
    { label: "카카오 채널", href: normalizeExternalUrl(kakaoChannelUrl) },
  ].filter((link) => link.href);

  return <footer className="public-footer">
    <div className="public-container">
      <div className="public-footer-top">
        <div><Image src="/stiz-logo.png" alt="STIZ 농구교실" width={140} height={35} className="public-footer-logo" /><p className="text-sm leading-relaxed">{footerDescriptionLines.map((line,idx)=><span key={idx}>{line}{idx<footerDescriptionLines.length-1&&<br/>}</span>)}</p></div>
        <div><nav className="public-footer-links" aria-label="홈페이지 바로가기">{QUICK_LINKS.map(link=><Link key={link.href} href={link.href}>{link.label}</Link>)}</nav>{socialLinks.length>0&&<div className="public-footer-socials">{socialLinks.map(link=><a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer" className="public-link text-sm">{link.label}</a>)}</div>}</div>
      </div>
      <div className="public-footer-bottom">
        <p>상호 {BUSINESS_INFO.name} · 대표자 {BUSINESS_INFO.owner} · 사업자등록번호 {BUSINESS_INFO.registrationNumber}</p>
        <p>주소 {BUSINESS_INFO.address} · 전화 <a href={`tel:${displayPhone.replace(/[^\d+]/g, "")}`}>{displayPhone}</a></p>
        <p>{displayOperatingHours}</p>
        <div className="flex flex-wrap items-center justify-between gap-3 mt-3"><p>{displayFooterCopyright}</p><div className="flex flex-wrap gap-4"><Link href="/terms" className="public-link">이용약관</Link><Link href="/privacy" className="public-link">개인정보 처리방침</Link></div></div>
      </div>
    </div>
  </footer>;
}
