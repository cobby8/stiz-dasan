/**
 * 메인 랜딩 페이지 — Server Component (Phase 1 개편)
 *
 * Phase 1 변경사항:
 * - 기존에 LandingPageClient가 자체 헤더/푸터를 가지고 있었으나,
 *   이제 PublicHeader + PublicFooter로 감싸는 구조로 통합
 * - settings 데이터를 서버에서 한 번만 가져와서 헤더/푸터/콘텐츠에 모두 전달
 * - revalidate: 60 유지 (캐싱 정책 변경 없음)
 */

import { getAcademySettings, getGalleryPosts, getNotices, getPublicTestimonials } from "@/lib/queries";
import PublicHeader from "@/components/PublicHeader";
import PublicFooter from "@/components/PublicFooter";
import LandingPageClient from "./LandingPageClient";
import ChatBotButton from "@/components/chat/ChatBotButton";
// 가이드 투어: 메인 페이지에서도 플로팅 버튼 표시
import GuideTourLazyTrigger from "@/components/guide-tour/GuideTourLazyTrigger";
import { buildPublicMetadata } from "@/lib/publicMetadata";

export const revalidate = 60;

export const metadata = buildPublicMetadata({
  title: "남양주 다산 농구교실 | 유아·초등·중등 체험수업 | STIZ 다산2호점",
  description:
    "다산신도시 스티즈 농구교실입니다. 유아·초등·중등 수준별 맞춤 클래스, 전문 코치진, 셔틀 운행. 체험 수업 신청 및 수강 문의.",
  path: "/",
});

export default async function Home() {
  let settings: any = null;
  let testimonials: any[] = [];
  let galleryPosts: any[] = [];
  let notices: any[] = [];
  try {
    // 학원 설정 + 공개 후기 + 갤러리 + 공지를 병렬로 조회 (성능 최적화)
    [settings, testimonials, galleryPosts, notices] = await Promise.all([
      getAcademySettings(),
      getPublicTestimonials(),
      getGalleryPosts({ limit: 24, publicOnly: true }),
      getNotices({ limit: 4, publicOnly: true }),
    ]);
  } catch (e) {
    console.error("Failed to load data for landing page:", e);
  }

  // 헤더/푸터에 전달할 데이터 추출
  const phone = settings?.contactPhone || "010-0000-0000";
  const address = settings?.address || "";
  const operatingHours = settings?.operatingHours || "";
  const footerDescription = settings?.footerDescription || "";
  const footerCopyright = settings?.footerCopyright || "";
  const instagramUrl = settings?.instagramUrl || "";
  const youtubeUrl = settings?.youtubeUrl || "";
  const naverPlaceUrl = settings?.naverPlaceUrl || "";
  const kakaoChannelUrl = settings?.kakaoChannelUrl || "";
  const localBusiness = {
    "@context": "https://schema.org",
    "@type": ["LocalBusiness", "SportsActivityLocation"],
    "@id": "https://www.stiz-dasan.kr/#academy",
    name: "스티즈농구교실 다산2호점",
    url: "https://www.stiz-dasan.kr/",
    telephone: phone === "010-0000-0000" ? undefined : phone,
    address: {
      "@type": "PostalAddress",
      streetAddress: address || "다산중앙로20번길 10-32, 1층",
      addressLocality: "남양주시",
      addressRegion: "경기도",
      addressCountry: "KR",
    },
    sameAs: [instagramUrl, youtubeUrl, naverPlaceUrl].filter((url) => /^https?:\/\//.test(url)),
  };

  return (
    <div className="min-h-screen bg-white dark:bg-black text-gray-900 dark:text-white flex flex-col">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(localBusiness).replace(/</g, "\\u003c") }}
      />
      {/* 통합 헤더 */}
      <PublicHeader
        phone={phone}
        address={address}
        operatingHours={operatingHours}
      />

      {/* 메인 콘텐츠 — LandingPageClient는 히어로~CTA까지만 담당 */}
      <main className="flex-1">
        <LandingPageClient
          initialSettings={settings}
          testimonials={testimonials}
          galleryPosts={galleryPosts}
          notices={notices}
          naverPlaceUrl={naverPlaceUrl}
        />
      </main>

      {/* 통합 푸터 */}
      <PublicFooter
        phone={phone}
        address={address}
        operatingHours={operatingHours}
        footerDescription={footerDescription}
        footerCopyright={footerCopyright}
        instagramUrl={instagramUrl}
        youtubeUrl={youtubeUrl}
        naverPlaceUrl={naverPlaceUrl}
        kakaoChannelUrl={kakaoChannelUrl}
      />

      {/* 챗봇 버튼 — 다른 페이지는 PublicPageLayout에서 렌더링하지만, 메인 페이지는 직접 추가 */}
      <ChatBotButton />

      {/* 가이드 투어: 플로팅 트리거 버튼 (driver.js가 오버레이/말풍선 직접 처리) */}
      <GuideTourLazyTrigger />
    </div>
  );
}
