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
import FontFreeIcon from "./ui/FontFreeIcon";

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
  { href: "/about", label: "학원/멤버소개" },
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
  address,
  operatingHours,
  footerDescription,
  footerCopyright,
  instagramUrl,
  youtubeUrl,
  naverPlaceUrl,
  kakaoChannelUrl,
}: PublicFooterProps) {
  const displayOperatingHours = operatingHours?.trim() || DEFAULT_OPERATING_HOURS;
  const displayFooterDescription = footerDescription?.trim() || DEFAULT_FOOTER_DESCRIPTION;
  const displayFooterCopyright = footerCopyright?.trim() || DEFAULT_FOOTER_COPYRIGHT;
  const footerDescriptionLines = displayFooterDescription.split("\n");
  const socialLinks = [
    { label: "Instagram", href: normalizeInstagramUrl(instagramUrl) },
    { label: "YouTube", href: normalizeExternalUrl(youtubeUrl) },
    { label: "네이버 플레이스", href: normalizeExternalUrl(naverPlaceUrl) },
    { label: "카카오 채널", href: normalizeExternalUrl(kakaoChannelUrl) },
  ].filter((link) => link.href);

  return (
    <footer className="bg-gray-50 dark:bg-black text-gray-600 dark:text-gray-300 pt-12 pb-8 border-t-4 border-brand-orange-500 dark:border-brand-neon-lime">
      <div className="max-w-6xl mx-auto px-4">
        <div className="grid md:grid-cols-3 gap-8 mb-8">
          {/* 학원 로고 + 소개 */}
          <div>
            <div className="bg-white dark:bg-gray-900 px-4 py-2.5 rounded-lg inline-flex items-center justify-center mb-4">
              <Image
                src="/stiz-logo.png"
                alt="STIZ"
                width={140}
                height={35}
                className="h-9 w-auto object-contain dark:brightness-0 dark:invert"
              />
            </div>
            <p className="text-sm text-gray-400 leading-relaxed">
              {footerDescriptionLines.map((line, idx) => (
                <span key={`${line}-${idx}`}>
                  {line}
                  {idx < footerDescriptionLines.length - 1 && <br />}
                </span>
              ))}
            </p>
          </div>

          {/* 학원 정보 — 주소, 전화번호, 운영시간 */}
          <div>
            <h4 className="text-gray-900 dark:text-white font-bold mb-4">학원 정보</h4>
            <ul className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
              {address && (
                <li className="flex items-start gap-2">
                  <FontFreeIcon name="location_on" size={16} className="mt-0.5 shrink-0 text-gray-500 dark:text-gray-400" />
                  <span>{address}</span>
                </li>
              )}
              <li className="flex items-center gap-2">
                <FontFreeIcon name="call" size={16} className="shrink-0 text-gray-500 dark:text-gray-400" />
                <span>{phone}</span>
              </li>
              <li className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {displayOperatingHours}
              </li>
            </ul>

            {/* 소셜미디어 아이콘 영역 — 향후 인스타그램 등 추가 예정 */}
            {socialLinks.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {socialLinks.map((link) => (
                  <a
                    key={link.label}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-full border border-gray-200 dark:border-gray-700 px-3 py-1 text-xs font-bold text-gray-600 dark:text-gray-300 hover:border-brand-orange-500 hover:text-brand-orange-500 dark:hover:border-brand-neon-lime dark:hover:text-brand-neon-lime transition"
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* 퀵 링크 */}
          <div>
            <h4 className="text-gray-900 dark:text-white font-bold mb-4">바로가기</h4>
            <ul className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
              {QUICK_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="hover:text-brand-orange-500 dark:text-brand-neon-lime dark:hover:text-white transition-colors"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* 저작권 표시 + 이용약관 링크 */}
        <div className="border-t border-gray-200 dark:border-gray-800 pt-6 text-center text-xs text-gray-500 dark:text-gray-400">
          {/* 사업자 정보 — 전자상거래법 표시 의무 + 토스페이먼츠 가맹 심사 필수 항목.
              사업자등록증(650-96-02048) 그대로 적는다. 관리자 설정값이 아니라 고정값인 이유:
              설정에서 지워지면 결제 심사·법적 표시가 조용히 깨진다. */}
          <p className="mb-2 leading-relaxed break-keep">
            상호 {BUSINESS_INFO.name} · 대표자 {BUSINESS_INFO.owner} · 사업자등록번호 {BUSINESS_INFO.registrationNumber}
            <br />
            주소 {BUSINESS_INFO.address} · 전화 {phone || BUSINESS_INFO.phone}
          </p>
          <p>{displayFooterCopyright}</p>
          {/* 독립 이용약관 페이지로 이동 */}
          {/* 이용약관 + 개인정보 처리방침 링크를 나란히 배치 */}
          <div className="flex items-center justify-center gap-3 mt-2">
            <Link
              href="/terms"
              className="text-gray-500 hover:text-gray-900 dark:text-white dark:hover:text-white transition-colors underline underline-offset-2"
            >
              이용약관
            </Link>
            <span className="text-gray-300 dark:text-gray-600">|</span>
            <Link
              href="/privacy"
              className="text-gray-500 hover:text-gray-900 dark:text-white dark:hover:text-white transition-colors underline underline-offset-2"
            >
              개인정보 처리방침
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
